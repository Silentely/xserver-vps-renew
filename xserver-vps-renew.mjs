#!/usr/bin/env node

/**
 * Xserver VPS 自动续期脚本 - Puppeteer Stealth 版本
 *
 * 通过 rebrowser-puppeteer-core + puppeteer-extra Stealth 启动 Chrome，修复 CDP 泄露检测：
 * 登录 → 检查到期 → 续期申请 → 验证码识别 → Turnstile 通过 → 提交
 *
 * 环境变量：
 *   XSERVER_MEMBER_ID  - 会员ID（必填）
 *   XSERVER_PASSWORD   - 密码（必填）
 *   CAPSOLVER_API_KEY     - CapSolver API 密钥（推荐：Turnstile 人机验证）
 *   ANTICAPTCHA_API_KEY   - Anti-Captcha API 密钥（Turnstile 异构备份，推荐作第二家）
 *   YESCAPTCHA_API_KEY    - YesCaptcha API 密钥（Turnstile 备选）
 *   TWOCAPTCHA_API_KEY    - 2Captcha API 密钥（Turnstile 备选）
 *   TURNSTILE_PROVIDER_ORDER - 多 key 时的 failover 顺序（可选）
 *   TURNSTILE_PROVIDER_MAX_FAILURES - 单平台连续失败后切换阈值（默认 3）
 *   CAPTCHA_API           - 验证码识别API地址（可选，有默认公共端点）
 *   CHROME_PATH           - Chrome 可执行文件路径（默认自动检测）
 *   CHROME_USER_DATA      - Chrome 用户数据目录（默认 /data/chrome-profile）
 *   TG_BOT_TOKEN          - Telegram Bot Token（可选，启用通知）
 *   TG_CHAT_ID            - Telegram Chat ID（可选，启用通知）
 *   TG_NOTIFY_DETAIL      - 通知详细程度：full（完整摘要，默认）/ compact（简洁摘要）
 *   TG_NOTIFY_SKIP        - 是否推送「无需续期/跳过」通知（默认 true；false 仅成功/失败推送）
 *   LOG_LEVEL             - 日志级别：debug / info（默认）/ warn / error
 */

import { addExtra } from 'puppeteer-extra';
import rebrowserPuppeteer from 'rebrowser-puppeteer-core';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectBrowserFingerprint } from './browser-fingerprint-patch.js';
import {
  safeClosePage,
  extractNewExpireDate,
  safeEvaluate,
  waitForPageReady,
} from './src/page-utils.mjs';

// 页面流程（登录/同意页/到期检查/续期确认/验证码提交）
import {
  handleLogin,
  ensureAgreementAccepted,
  checkRenewalNeeded,
  handleRenewalConfirm,
  handleCaptchaPage,
} from './src/panel-flow.mjs';
// Turnstile 求解（纯函数 + API）
import {
  listTurnstileProviders,
  listUnknownTurnstileProviderNames,
  resolveAntiCaptchaProxyMode,
  DEFAULT_TURNSTILE_PROVIDER_MAX_FAILURES,
  DEFAULT_TURNSTILE_PROVIDER_ORDER,
} from './src/turnstile.mjs';
// 续期记录持久化
import {
  writeRenewalStatus,
  buildRenewalRecord,
  getRenewalStatus,
  DEFAULT_STATUS_FILE,
  DEFAULT_ALERT_AFTER_FAILURES,
} from './src/renewal-status.mjs';
// 通用工具
import {
  maskProxyAddress,
  fetchWithTimeout,
  validateRequiredConfig,
  parsePositiveInt,
  parseLogLevel,
  parseEnvBool,
  shouldLog,
  formatLogLine,
  formatLogTimestamp,
  clampLogMessage,
  analyzeFingerprintHealth,
  findChromePath,
  cleanChromeLocks,
  cleanChromeCaches,
  formatTokyoDateTime,
  isBenignRequestFailure,
  PROJECT_SOURCE_LINE,
  PROJECT_REPO_URL,
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_DEBUG,
  LOG_LEVEL_INFO,
  LOG_LEVEL_WARN,
  LOG_LEVEL_ERROR,
} from './src/utils.mjs';
// 通知构建
import {
  buildSuccessNotifyMessage,
  buildSkipNotifyMessage,
  buildFailureNotifyMessage,
  buildManualConfirmNotifyMessage,
  buildProxyHint,
  formatDurationMs,
  parseNotifyDetail,
  clampTelegramMessage,
  parseTelegramSendResult,
  resolveTurnstileProviderLabel,
  listFailedTurnstileProviders,
  classifyRenewalFailure,
  resolveNextRunAt,
  FAILURE_CATEGORY,
  DEFAULT_NEXT_RUN_INTERVAL_HOURS,
  DEFAULT_TG_NOTIFY_DETAIL,
} from './src/notify.mjs';
// 续期业务纯逻辑
import {
  FREE_VPS_MAX_HOURS,
  RENEWAL_WINDOW_HOURS,
} from './src/renewal-logic.mjs';

/** 默认 Keras 验证码识别 API（Cloud Run，可被 CAPTCHA_API 覆盖） */
const DEFAULT_CAPTCHA_API = 'https://captcha-api-216250547992.us-central1.run.app';

// 运行时版本号（单一来源：package.json；启动横幅展示，便于核对运行的是哪个版本）
const PROJECT_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version;

// 使用 rebrowser-puppeteer-core 替代原生 puppeteer-core
// rebrowser-patches 修复了 Runtime.Enable 泄露检测，避免被 Cloudflare Turnstile 识别为自动化浏览器
const puppeteer = addExtra(rebrowserPuppeteer);
puppeteer.use(StealthPlugin());

// ============================================================
// 配置
// ============================================================

// 真实浏览器调试收集的 UA (Chrome 149 Edge on macOS)
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0';

/** 浏览器窗口/视口尺寸（与真实调试分辨率一致；启动参数与 defaultViewport 共用） */
const VIEWPORT = { width: 1440, height: 900 };

/** 状态文件路径（从环境变量读取） */
const RENEWAL_STATUS_FILE = process.env.RENEWAL_STATUS_FILE || DEFAULT_STATUS_FILE;
/** 连续失败告警阈值 */
const ALERT_AFTER_CONSECUTIVE_FAILURES = parsePositiveInt(
  process.env.ALERT_AFTER_FAILURES,
  DEFAULT_ALERT_AFTER_FAILURES,
  { min: 1, max: 100 },
);

const CONFIG = {
  MEMBER_ID: process.env.XSERVER_MEMBER_ID || '',
  PASSWORD: process.env.XSERVER_PASSWORD || '',

  // 验证码识别服务（OCR）；未配置时使用公共默认端点
  CAPTCHA_API: process.env.CAPTCHA_API || DEFAULT_CAPTCHA_API,

  BASE_URL: 'https://secure.xserver.ne.jp',
  LOGIN_PATH: '/xapanel/login/xvps/',

  // 超时/重试可通过环境变量覆盖
  NAVIGATION_TIMEOUT: parsePositiveInt(process.env.NAVIGATION_TIMEOUT_MS, 30_000, { min: 5_000, max: 180_000 }),
  LOGIN_NAVIGATION_RETRIES: parsePositiveInt(process.env.LOGIN_NAVIGATION_RETRIES, 2, { min: 1, max: 5 }),
  LOGIN_NAVIGATION_RETRY_DELAY_MS: parsePositiveInt(
    process.env.LOGIN_NAVIGATION_RETRY_DELAY_MS,
    2_000,
    { min: 0, max: 30_000 },
  ),
  TURNSTILE_TIMEOUT: parsePositiveInt(process.env.TURNSTILE_TIMEOUT_MS, 60_000, { min: 10_000, max: 300_000 }),
  TURNSTILE_API_TIMEOUT: parsePositiveInt(process.env.TURNSTILE_API_TIMEOUT_MS, 120_000, { min: 15_000, max: 300_000 }),
  // Turnstile iframe 渲染软等待时间（ms），容器环境建议 8000-15000
  TURNSTILE_RENDER_WAIT_MS: parsePositiveInt(process.env.TURNSTILE_RENDER_WAIT_MS, 8_000, { min: 1_000, max: 30_000 }),
  CAPTCHA_MAX_RETRY: parsePositiveInt(process.env.CAPTCHA_MAX_RETRY, 3, { min: 1, max: 10 }),
  // 提交后等待服务端处理结果的轮询上限（官方 /extend/do 处理实测 60-90s；
  // 过早判定失败会中止在途 POST，需覆盖服务端处理时间）
  SUBMISSION_RESULT_TIMEOUT_MS: parsePositiveInt(process.env.SUBMISSION_RESULT_TIMEOUT_MS, 120_000, { min: 15_000, max: 300_000 }),

  CHROME_PATH: process.env.CHROME_PATH || findChromePath(),
  CHROME_USER_DATA: process.env.CHROME_USER_DATA || '/data/chrome-profile',

  // Turnstile API 求解（多 key 时按顺序 failover，默认 CapSolver → AntiCaptcha → YesCaptcha → 2Captcha）
  CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY || '',
  ANTICAPTCHA_API_KEY: process.env.ANTICAPTCHA_API_KEY || '', // 异构备份（真人/混合）
  // Anti-Captcha 开发者 softId（可选，未注册可不填）
  ANTICAPTCHA_SOFT_ID: process.env.ANTICAPTCHA_SOFT_ID || '',
  YESCAPTCHA_API_KEY: process.env.YESCAPTCHA_API_KEY || '',  // Turnstile 备选（国内友好）
  // 国际: https://api.yescaptcha.com ；国内: https://cn.yescaptcha.com
  YESCAPTCHA_API_BASE: process.env.YESCAPTCHA_API_BASE || '',
  // TurnstileTaskProxyless（默认）或 TurnstileTaskProxylessM1
  YESCAPTCHA_TASK_TYPE: process.env.YESCAPTCHA_TASK_TYPE || '',
  TWOCAPTCHA_API_KEY: process.env.TWOCAPTCHA_API_KEY || '',  // 仅用于 Turnstile 求解
  // 逗号分隔自定义顺序，例如: CapSolver,AntiCaptcha,YesCaptcha,2Captcha
  TURNSTILE_PROVIDER_ORDER: process.env.TURNSTILE_PROVIDER_ORDER || '',
  // 单平台连续失败达到此次数后切换下一平台
  TURNSTILE_PROVIDER_MAX_FAILURES: parsePositiveInt(
    process.env.TURNSTILE_PROVIDER_MAX_FAILURES,
    DEFAULT_TURNSTILE_PROVIDER_MAX_FAILURES,
    { min: 1, max: 10 },
  ),

  // 住宅代理（可选，用于 2Captcha / Anti-Captcha 带代理求解）
  PROXY_TYPE: process.env.PROXY_TYPE || '',           // http | socks4 | socks5
  PROXY_ADDRESS: process.env.PROXY_ADDRESS || '',     // IP 或域名
  PROXY_PORT: process.env.PROXY_PORT || '',            // 端口
  PROXY_LOGIN: process.env.PROXY_LOGIN || '',          // 用户名（可选）
  PROXY_PASSWORD: process.env.PROXY_PASSWORD || '',    // 密码（可选）

  // Telegram 通知（可选）
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || '',
  TG_CHAT_ID: process.env.TG_CHAT_ID || '',
  // 通知详细程度：full=完整摘要（含执行过程）/ compact=简洁摘要
  TG_NOTIFY_DETAIL: parseNotifyDetail(
    process.env.TG_NOTIFY_DETAIL,
    DEFAULT_TG_NOTIFY_DETAIL,
  ),
  // 是否推送「无需续期 / 跳过」类通知（默认 true）
  TG_NOTIFY_SKIP: parseEnvBool(process.env.TG_NOTIFY_SKIP, true),

  // 日志级别：debug / info（默认）/ warn / error
  LOG_LEVEL: parseLogLevel(process.env.LOG_LEVEL, DEFAULT_LOG_LEVEL),
  // 强制保存 Turnstile 求解前后截图（默认仅 LOG_LEVEL=debug 时写盘；排查问题时可在 info 级别开启）
  SAVE_TURNSTILE_SCREENSHOTS: parseEnvBool(process.env.SAVE_TURNSTILE_SCREENSHOTS, false),
  // 验证码数据集自动收集（用于重训模型，方案二）
  SAVE_CAPTCHA_DATASET: parseEnvBool(process.env.SAVE_CAPTCHA_DATASET, false),
  CAPTCHA_DATASET_DIR: process.env.CAPTCHA_DATASET_DIR || "/data/captcha-dataset",

  // 容器内 cron（可选）；外部平台调度时也可只设 NOTIFY_NEXT_RUN_HOURS
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '',
  // 仅通知展示：cron-run 按 #7 清空 CRON_SCHEDULE 后经此变量透传真实调度，不作模式开关
  CRON_SCHEDULE_DISPLAY: process.env.CRON_SCHEDULE_DISPLAY || '',
  // 成功通知中「下次执行」估算间隔（小时）；默认 6，适配剩余≤12h 窗口
  NOTIFY_NEXT_RUN_HOURS: parsePositiveInt(
    process.env.NOTIFY_NEXT_RUN_HOURS,
    DEFAULT_NEXT_RUN_INTERVAL_HOURS,
    { min: 1, max: 168 },
  ),

  // 传给 Turnstile 求解模块，保证 token 与浏览器 UA 一致
  userAgent: DEFAULT_UA,
  DEFAULT_UA,

  // 状态持久化
  RENEWAL_STATUS_FILE,
  ALERT_AFTER_FAILURES: ALERT_AFTER_CONSECUTIVE_FAILURES,
};

/** 运行时计算代理配置状态 */
const HAS_PROXY = !!(CONFIG.PROXY_TYPE && CONFIG.PROXY_ADDRESS && CONFIG.PROXY_PORT);

// ============================================================
// 日志
// 🔧 优化：使用环境变量时区（默认东京时区），统一日志时间格式
// ============================================================

/**
 * 格式化时间戳（按环境变量时区，YYYY-MM-DD HH:mm:ss）
 * 委托 utils.formatLogTimestamp 单一实现，避免与通知时间戳逻辑双份维护
 */
const ts = () => formatLogTimestamp();

/** 按 LOG_LEVEL 输出；error 统一带 ❌ 前缀写 stderr（消息自身已带则不重复） */
function emitLog(level, msg) {
  if (!shouldLog(CONFIG.LOG_LEVEL, level)) return;
  // 单次取时间戳：避免跨秒时同条日志出现两个不一致的时间（原实现最多调用 3 次 ts()）
  // 超长消息（错误堆栈/诊断片段）截断，防 docker logs 刷屏
  const line = formatLogLine(ts(), level, clampLogMessage(msg));
  if (level === LOG_LEVEL_ERROR) {
    console.error(line);
    return;
  }
  if (level === LOG_LEVEL_WARN) {
    console.warn(line);
    return;
  }
  console.log(line);
}

const logDebug = (msg) => emitLog(LOG_LEVEL_DEBUG, msg);
const log = (msg) => emitLog(LOG_LEVEL_INFO, msg);
const logWarn = (msg) => emitLog(LOG_LEVEL_WARN, msg);
const err = (msg) => emitLog(LOG_LEVEL_ERROR, msg);

/** 分级日志对象（供 src 模块 logger 参数使用；级别决策归属模块自身） */
const LOGGER = { info: log, debug: logDebug, warn: logWarn, error: err };

// ============================================================
// Telegram 通知
// ============================================================

/**
 * 发送 Telegram 通知
 * @param {string} message
 * @param {{ kind?: 'success'|'skip'|'failure'|'manual_confirm'|'other' }} [opts]
 *   kind 仅用于 skip 类开关判定（skip 且 TG_NOTIFY_SKIP=false 时不推送），其余归类为 'other'
 */
async function notify(message, opts = {}) {
  const kind = opts.kind || 'other';
  if (kind === 'skip' && !CONFIG.TG_NOTIFY_SKIP) {
    log('Telegram：跳过类通知已关闭（TG_NOTIFY_SKIP=false）');
    return;
  }

  if (!CONFIG.TG_BOT_TOKEN || !CONFIG.TG_CHAT_ID) {
    log('Telegram 未配置（TG_BOT_TOKEN / TG_CHAT_ID），跳过通知');
    return;
  }

  const text = clampTelegramMessage(message);
  if (text.length < String(message ?? '').length) {
    log(`Telegram 消息超长已截断: ${String(message).length} → ${text.length} 字`);
  }

  const url = `https://api.telegram.org/bot${CONFIG.TG_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.TG_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    }, 10_000);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const bodyBrief = body.length > 200 ? `${body.slice(0, 200)}…` : body;
      err(`Telegram 通知发送失败: HTTP ${res.status}${bodyBrief ? ` ${bodyBrief}` : ''}`);
      return;
    }

    // Telegram 对逻辑错误（chat 不存在/被屏蔽等）返回 200 + { ok:false }，需校验响应体
    const sendResult = parseTelegramSendResult(await res.text().catch(() => ''));
    if (!sendResult.ok) {
      err(`Telegram 通知发送失败: ${sendResult.description}`);
      return;
    }

    log(`Telegram 通知已发送（${text.length} 字，模式 ${CONFIG.TG_NOTIFY_DETAIL}）`);
  } catch (e) {
    const reason = e.name === 'AbortError' ? '请求超时' : e.message;
    err(`Telegram 通知异常: ${reason}`);
  }
}

/**
 * 安全写入续期状态（写入失败不中断主流程，仅记日志）
 * @param {object} record - 续期记录
 */
function persistRenewalRecord(record) {
  try {
    // 第 3 参 maxRecords 走默认值；第 4 参注入 LOGGER，让状态读写日志带时间戳/级别标签
    writeRenewalStatus(record, RENEWAL_STATUS_FILE, undefined, LOGGER);
    log(`📝 续期记录已保存: ${RENEWAL_STATUS_FILE}`);
  } catch (e) {
    err(`续期记录保存失败: ${e.message}`);
  }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const startedAtMs = Date.now();
  log(`========== Xserver VPS 自动续期 v${PROJECT_VERSION} ==========`);
  log(`🔗 ${PROJECT_SOURCE_LINE}`);
  // 文档入口：排障 / 配置疑问的第一站（README 与 RUNBOOK 随仓库分发）
  log(`📖 文档: README.md（配置与入门） / RUNBOOK.md（排障手册）`);
  log(
    `日志级别: ${CONFIG.LOG_LEVEL}`
    + ` | 时区: ${process.env.TZ || 'Asia/Tokyo'}`
    + ` | 通知: ${CONFIG.TG_NOTIFY_DETAIL}`
    + `${CONFIG.TG_NOTIFY_SKIP ? '' : '（跳过类不推送）'}`
    + `${CONFIG.TG_BOT_TOKEN && CONFIG.TG_CHAT_ID ? ' | Telegram 已配置' : ' | Telegram 未配置'}`,
  );
  // 运行环境：排障第一手信息（Node 版本差异曾造成 Intl/语法行为偏差，平台决定 Chrome 探测路径）
  log(`运行环境: Node ${process.version} | ${process.platform}/${process.arch}`);

  const configErrors = validateRequiredConfig(CONFIG);
  if (configErrors.length > 0) {
    throw new Error(`配置校验失败: ${configErrors.join('；')}`);
  }

  let prevLastRecord = null;
  // 上次运行结果摘要：每次 cron 触发第一眼看到上次结局与连续统计
  // （读取失败由 getRenewalStatus 内部 warn 记录，不阻断启动）
  {
    const status = getRenewalStatus(
      RENEWAL_STATUS_FILE,
      ALERT_AFTER_CONSECUTIVE_FAILURES,
      LOGGER,
    );
    prevLastRecord = status.lastRecord || null;
    const last = status.lastRecord;
    if (last) {
      const outcome = last.skipped ? '跳过' : (last.success ? '成功' : '失败');
      const when = last.timestamp ? formatTokyoDateTime(new Date(last.timestamp)) : '时间未知';
      const errBrief = last.errorMessage ? `，${last.errorMessage.slice(0, 100)}${last.errorMessage.length > 100 ? '…' : ''}` : '';
      const newDate = last.newExpireDate ? `，新到期 ${last.newExpireDate}` : '';
      log(
        `上次运行: ${outcome}（${when}）${newDate}${errBrief}`
        + ` | 连续失败 ${status.consecutiveFailures} / 连续成功 ${status.consecutiveSuccesses}`,
      );
    } else {
      logDebug('上次运行: 无历史记录（首次运行）');
    }
  }

  {
    const tsProviders = listTurnstileProviders(CONFIG);
    // 平台名拼写错误在解析时被静默忽略（failover 链路悄悄变短），启动即告警暴露
    const unknownProviders = listUnknownTurnstileProviderNames(CONFIG.TURNSTILE_PROVIDER_ORDER);
    if (unknownProviders.length > 0) {
      logWarn(
        `⚠️ TURNSTILE_PROVIDER_ORDER 含无法识别的平台名（已忽略）: ${unknownProviders.join(' / ')}`
        + `（可用: ${DEFAULT_TURNSTILE_PROVIDER_ORDER.join(', ')}）`,
      );
    }
    if (tsProviders.length === 0) {
      logWarn('⚠️ 未配置任何 Turnstile 打码平台密钥：将依赖自然通过，成功率极低（Docker 几乎不可用）。推荐至少配置 CAPSOLVER_API_KEY，并另配 ANTICAPTCHA_API_KEY 作异构备份');
    } else {
      const chain = tsProviders.map((p) => p.name).join(' → ');
      log(`Turnstile 多平台链路: ${chain}（每平台连续失败 ${CONFIG.TURNSTILE_PROVIDER_MAX_FAILURES} 次后切换）`);
      if (!CONFIG.CAPSOLVER_API_KEY) {
        log('ℹ️ 未配置 CAPSOLVER_API_KEY，将按已配置链路求解。仍推荐配置 CapSolver 作为主平台');
      }
      if (tsProviders.length === 1) {
        log('💡 仅配置 1 家打码平台：CF 大更新时无 failover。建议再配 ANTICAPTCHA_API_KEY 或另一家 key 提升容错');
      }
      // 启动时说明 AntiCaptcha + 域名代理策略，避免误读日志
      const anti = tsProviders.find((p) => p.name === 'AntiCaptcha');
      if (anti?.proxyMode === 'hostname_skipped') {
        log(
          `ℹ️ AntiCaptcha：PROXY_ADDRESS 为域名，官方 TurnstileTask 仅支持 IP；`
          + '打码任务将自动使用 TurnstileTaskProxyless（浏览器代理仍生效）',
        );
      } else if (anti?.proxyMode === 'ip') {
        log('ℹ️ AntiCaptcha：已配置 IP 代理，将使用 TurnstileTask 带代理求解');
      }
    }
  }

  let browser = null;
  // 执行过程摘要（try 内外共享，失败通知也能附带已完成步骤）
  const processSteps = [];
  // 步骤序号：日志行带 [步骤N] 前缀，与通知过程步骤（1. 2. 3.）一一对应，便于 docker logs 对账
  let stepCount = 0;
  // 分阶段计时：日志里每步附带「距上一步/启动」耗时，便于 docker logs 定位慢环节；
  // 通知中的步骤文本保持纯净，不受耗时影响
  let lastStepAtMs = startedAtMs;
  const pushStep = (step) => {
    const now = Date.now();
    const stepMs = now - lastStepAtMs;
    lastStepAtMs = now;
    stepCount += 1;
    processSteps.push(step);
    log(`[步骤${stepCount}] ${step}（耗时 ${formatDurationMs(stepMs)}）`);
  };
  /** 本轮已知的 VPS 上下文（失败通知复用） */
  let knownVps = {
    serverName: null,
    plan: null,
    expireDate: null,
    remainingHours: null,
  };
  /** 结束摘要：success | skip | failure | aborted */
  let runOutcome = 'aborted';
  let runOutcomeLabel = '未完成';
  const elapsedMs = () => Date.now() - startedAtMs;
  const durationText = () => formatDurationMs(elapsedMs());

  // 下次执行：优先展示用调度（cron-run 透传的真实 cron，如 27 */4 * * *），
  // 退回 CRON_SCHEDULE（本地/单次模式），最后退化到 NOTIFY_NEXT_RUN_HOURS（默认 6h）
  const resolveNextRun = () => resolveNextRunAt(Date.now(), {
    cronSchedule: CONFIG.CRON_SCHEDULE_DISPLAY || CONFIG.CRON_SCHEDULE,
    intervalHours: CONFIG.NOTIFY_NEXT_RUN_HOURS,
  });

  /**
   * 本轮判定为「跳过」的统一出口：
   * 记录结局 → 持久化跳过记录 → 推送 skip 通知 → 关闭页面
   * （not_due / no_free_vps / window_blocked 三个分支共用，避免重复实现）
   * @param {object} opts
   * @param {import('puppeteer').Page} opts.page - 当前页面（try 块内声明，必须显式传入）
   */
  const finishWithSkip = async ({
    page,
    reasonCode,
    skipLabel,
    reasonDetail,
    logText,
    runLabel = null,
  }) => {
    runOutcome = 'skip';
    runOutcomeLabel = runLabel || skipLabel;
    pushStep(`判定结果: ${skipLabel}`);
    // logText 与 skipLabel 相同时不再重复输出（pushStep 已记录进度），
    // 仅在调用方提供了补充说明时追加；总耗时由流程结束行统一输出
    if (logText && logText !== skipLabel) {
      log(logText);
    }
    // 记录跳过，避免「长期无写入」被误判为监控静默
    persistRenewalRecord(buildRenewalRecord({
      success: true,
      skipped: true,
      serverName: knownVps.serverName,
      plan: knownVps.plan,
      oldExpireDate: knownVps.expireDate,
      errorMessage: skipLabel,
    }));
    await notify(buildSkipNotifyMessage({
      reasonCode,
      serverName: knownVps.serverName,
      plan: knownVps.plan,
      expireDate: knownVps.expireDate,
      remainingHours: knownVps.remainingHours,
      reasonDetail,
      executedAt: formatTokyoDateTime(),
      nextRunAt: resolveNextRun(),
      maxHours: FREE_VPS_MAX_HOURS,
      windowHours: RENEWAL_WINDOW_HOURS,
      processSteps,
      detail: CONFIG.TG_NOTIFY_DETAIL,
      durationMs: elapsedMs(),
    }), { kind: 'skip' });
    // 安全关闭：close 抛错不误入 catch（否则会造成「已跳过 + 失败」双通知），
    // 页面由 finally 中 browser.close() 兜底回收
    await safeClosePage(page, LOGGER);
  };

  try {
    // 清理锁文件与临时缓存（防止磁盘及 Page Cache 累积膨胀）
    cleanChromeLocks(CONFIG.CHROME_USER_DATA);
    cleanChromeCaches(CONFIG.CHROME_USER_DATA);
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch { /* 忽略 */ }
    }

    // 构建 Chrome 启动参数（针对 512MB 低内存容器深度压缩优化）
    const chromeArgs = [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,  // 🔧 优化：使用真实浏览器调试的分辨率
      '--window-position=0,0',
      '--tz=Asia/Tokyo',         // 🔧 修正：Xserver 位于日本，使用东京时区
      // ====== 512MB 低内存容器优化参数 ======
      '--js-flags=--max-old-space-size=128',
      '--renderer-process-limit=2',
      '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process,Translate,BackForwardCache,MediaRouter,OptimizationHints',
      '--disk-cache-size=10485760',
      '--media-cache-size=10485760',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-breakpad',
      '--no-zygote',
      '--mute-audio',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--password-store=basic',
      '--use-mock-keychain',
    ];

    // 加载 turnstile-patch 扩展
    // 修复 CDP Input.dispatchMouseEvent 产生的 MouseEvent.screenX/screenY 异常
    // Cloudflare Turnstile 通过检测 screenX === clientX 判定自动化（Chromium bug #40280325）
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const extensionPath = resolve(__dirname, 'turnstile-patch');
    if (existsSync(extensionPath)) {
      chromeArgs.push(`--disable-extensions-except=${extensionPath}`);
      chromeArgs.push(`--load-extension=${extensionPath}`);
      log(`已加载 turnstile-patch 扩展: ${extensionPath}`);
    } else {
      log(`turnstile-patch 扩展不存在: ${extensionPath}，跳过`);
    }

    // 当配置了代理时，让浏览器也走同一代理
    // 确保浏览器提交表单的出口 IP 与 2Captcha 工人求解 token 时的 IP 一致
    if (HAS_PROXY) {
      const proxyScheme = CONFIG.PROXY_TYPE === 'socks5' ? 'socks5' :
        CONFIG.PROXY_TYPE === 'socks4' ? 'socks4' : 'http';
      chromeArgs.push(`--proxy-server=${proxyScheme}://${CONFIG.PROXY_ADDRESS}:${CONFIG.PROXY_PORT}`);
      const maskedAddr = maskProxyAddress(CONFIG.PROXY_ADDRESS);
      log(`浏览器代理已配置: ${proxyScheme}://${maskedAddr}:${CONFIG.PROXY_PORT}`);
    }

    // rebrowser-puppeteer-core + Stealth 插件启动，修复 Runtime.Enable 泄露
    log(`正在启动 Chrome（rebrowser + Stealth 模式）: ${CONFIG.CHROME_PATH}`);
    browser = await puppeteer.launch({
      executablePath: CONFIG.CHROME_PATH,
      userDataDir: CONFIG.CHROME_USER_DATA,
      headless: false,
      args: chromeArgs,
      defaultViewport: VIEWPORT,  // 🔧 优化：匹配启动参数
    });
    log('Chrome 启动成功（Stealth 模式完整注入）！');

    // 复用初始打开的空白标签页，关闭冗余标签，避免额外派生渲染进程浪费内存
    const existingPages = await browser.pages();
    const page = existingPages.length > 0 ? existingPages[0] : await browser.newPage();
    for (let i = 1; i < existingPages.length; i++) {
      await existingPages[i].close().catch(() => {});
    }

    log('注入浏览器指纹补丁...');
    await injectBrowserFingerprint(page);
    logDebug('浏览器指纹补丁已注入');

    // 代理需要认证时，通过 page.authenticate 传递凭据
    if (HAS_PROXY && CONFIG.PROXY_LOGIN) {
      await page.authenticate({
        username: CONFIG.PROXY_LOGIN,
        password: CONFIG.PROXY_PASSWORD,
      });
      log('浏览器代理认证已设置');
    }

    let actualUA = DEFAULT_UA;
    try {
      await Promise.race([
        page.setUserAgent(DEFAULT_UA),
        sleep(5000).then(() => {
          throw new Error('page.setUserAgent 初始化超时（5000ms）');
        }),
      ]);
      actualUA = await page.evaluate(() => navigator.userAgent).catch(() => DEFAULT_UA);
    } catch (e) {
      logWarn(`设置初始 UA 告警: ${e.message}`);
      actualUA = await page.evaluate(() => navigator.userAgent).catch(() => DEFAULT_UA);
    }
    // 将实际生效的浏览器 UA 反哺回 CONFIG.userAgent，确保打码平台任务与浏览器严格同源
    CONFIG.userAgent = actualUA;
    logDebug(`浏览器实际生效 UA: ${actualUA.substring(0, 60)}...`);
    page.setDefaultTimeout(CONFIG.NAVIGATION_TIMEOUT);

    // debug 级别监听浏览器 console / 页面 JS 异常 / 失败请求：
    // Cloudflare 或页面脚本报错在排障时由此可见；每类设条数上限防极端页面刷屏
    if (CONFIG.LOG_LEVEL === LOG_LEVEL_DEBUG) {
      const consoleCap = { count: 0, max: 50 };
      page.on('console', (msg) => {
        if (consoleCap.count >= consoleCap.max) return;
        consoleCap.count++;
        const text = String(msg.text?.() || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        if (text) logDebug(`[页面console:${msg.type()}] ${text}`);
      });
      const pageErrorCap = { count: 0, max: 30 };
      page.on('pageerror', (err) => {
        if (pageErrorCap.count >= pageErrorCap.max) return;
        pageErrorCap.count++;
        logDebug(`[页面JS异常] ${String(err?.message || err).slice(0, 300)}`);
      });
      const reqFailCap = { count: 0, max: 50 };
      page.on('requestfailed', (req) => {
        if (reqFailCap.count >= reqFailCap.max) return;
        const url = req.url();
        // 埋点 beacon 在页面导航时被中止（ERR_ABORTED）属正常现象，降噪跳过；
        // 保留面板/Cloudflare 等对排障有意义的失败请求
        if (isBenignRequestFailure(url)) return;
        reqFailCap.count++;
        const failure = req.failure?.();
        logDebug(`[请求失败] ${failure?.errorText || '未知原因'}: ${url.slice(0, 200)}`);
      });
    }

    // Standalone Turnstile：正常渲染 + API 求解（不拦截 render）
    logDebug('Turnstile 策略：正常渲染 + API 求解（不拦截 render）');

    // 步骤 1：登录
    pushStep('登录 Xserver 面板');
    const loginResult = await handleLogin(page, { config: CONFIG, logger: LOGGER });
    pushStep(loginResult?.viaCookie ? '登录成功（Cookie 复用）' : '登录成功');

    // 官方 2026-08-05 上线「個人情報の取り扱いについて」同意页（登录后必经，
    // 未同意时面板各页均被重定向回同意页，造成「未找到免费 VPS」）
    await ensureAgreementAccepted(page, { config: CONFIG, logger: LOGGER });
    await waitForPageReady(page, 5000, LOGGER);

    const fingerprint = await safeEvaluate(
      page,
      () => ({
        deviceMemory: navigator.deviceMemory || 'N/A',
        hardwareConcurrency: navigator.hardwareConcurrency || 'N/A',
        platform: navigator.platform,
        language: navigator.language,
        webdriver: navigator.webdriver || false,
      }),
      {
        deviceMemory: 'N/A',
        hardwareConcurrency: 'N/A',
        platform: 'N/A',
        language: 'N/A',
        webdriver: false,
      },
      5,
      800,
      LOGGER,
    );
    // 指纹体检：stealth 失效（webdriver=true）等高风险信号在启动时即告警
    for (const risk of analyzeFingerprintHealth(fingerprint)) {
      logWarn(`指纹体检: ${risk}`);
    }
    logDebug(
      `浏览器指纹: deviceMemory=${fingerprint.deviceMemory}GB,`
      + ` hardwareConcurrency=${fingerprint.hardwareConcurrency},`
      + ` platform=${fingerprint.platform}, webdriver=${fingerprint.webdriver}`,
    );

    // 步骤 2：检查续期
    pushStep('检查免费 VPS 到期状态');
    const renewalData = await checkRenewalNeeded(page, { config: CONFIG, logger: LOGGER });
    if (renewalData.vpsInfo && (renewalData.vpsInfo.serverName || renewalData.vpsInfo.plan || renewalData.vpsInfo.expireDate)) {
      knownVps = {
        serverName: renewalData.vpsInfo.serverName || null,
        plan: renewalData.vpsInfo.plan || null,
        expireDate: renewalData.vpsInfo.expireDate || null,
        remainingHours: renewalData.remainingHours ?? null,
      };
    } else if (prevLastRecord?.serverName) {
      // 若当前未提取到 VPS 信息但历史有记录，兜底保留已知信息用于告警通知展示
      knownVps = {
        serverName: prevLastRecord.serverName,
        plan: prevLastRecord.plan || null,
        expireDate: prevLastRecord.newExpireDate || prevLastRecord.oldExpireDate || null,
        remainingHours: null,
      };
    }
    if (!renewalData.needed) {
      // 官方新增/变更确认页导致未进入 VPS 面板（URL 不含 /xvps/）时转人工确认，
      // 发送提醒并置失败退出码，不当显普通「无免费 VPS」跳过
      if (renewalData.reasonCode === 'no_free_vps' && renewalData.needsManualConfirmation) {
        runOutcome = 'failure';
        runOutcomeLabel = '需要人工确认';
        const manualReason = `当前停留在 ${page.url()}，未进入 VPS 面板，疑似官方新增确认页面`;
        err(manualReason);
        persistRenewalRecord(buildRenewalRecord({
          success: false,
          serverName: knownVps.serverName,
          plan: knownVps.plan,
          oldExpireDate: knownVps.expireDate,
          errorMessage: manualReason,
        }));
        await notify(buildManualConfirmNotifyMessage({
          executedAt: formatTokyoDateTime(),
          reason: manualReason,
          nextRunAt: resolveNextRun(),
        }), { kind: 'manual_confirm' });
        process.exitCode = 1;
        return;
      }
      if (renewalData.reasonCode === 'no_free_vps' && prevLastRecord?.serverName) {
        const missingWarning = `⚠️ 历史记录中存在已知 VPS (${prevLastRecord.serverName})，但本次未检测到免费 VPS！请核实是否由于网络/渲染延迟、官方改版或机器已到期下线！`;
        logWarn(missingWarning);
        // 关键告警升级：即便配置了 TG_NOTIFY_SKIP=false 也通过 manual_confirm 渠道发送，杜绝静默漏报机器丢失
        await notify(buildManualConfirmNotifyMessage({
          executedAt: formatTokyoDateTime(),
          reason: missingWarning,
          nextRunAt: resolveNextRun(),
        }), { kind: 'manual_confirm' });
      }
      const skipLabel = renewalData.reasonCode === 'no_free_vps' ? '未找到免费 VPS' : '无需续期';
      const reasonDetail = (renewalData.reasonCode === 'no_free_vps' && prevLastRecord?.serverName)
        ? `${renewalData.reasonDetail}（注意：历史记录曾存在 ${prevLastRecord.serverName}）`
        : renewalData.reasonDetail;
      await finishWithSkip({
        page,
        reasonCode: renewalData.reasonCode,
        skipLabel,
        reasonDetail,
        logText: skipLabel,
      });
      return;
    }

    pushStep(
      `需要续期: ${renewalData.vpsInfo.serverName || '未知'}（到期 ${renewalData.vpsInfo.expireDate || '未知'}）`,
    );

    // 步骤 3：续期确认（可能被官方「12時間前」拦截页软跳过，见 #5）
    pushStep('打开续期确认页');
    const confirmResult = await handleRenewalConfirm(page, renewalData.renewUrl, {
      config: CONFIG,
      logger: LOGGER,
    });
    if (confirmResult.status === 'window_blocked') {
      const skipLabel = confirmResult.reason || '未进入官方 12 小时续期窗口';
      await finishWithSkip({
        page,
        reasonCode: 'window_blocked',
        skipLabel,
        runLabel: '未进入 12h 续期窗口',
        reasonDetail: skipLabel,
        logText: `无需续期（官方窗口未开）: ${skipLabel}`,
      });
      return;
    }

    // 步骤 4-6：验证码 + Turnstile + 提交（传入 renewUrl 供失败重试回到 index?id_vps）
    pushStep('识别验证码并求解 Turnstile，提交续期');
    const captchaMeta = await handleCaptchaPage(page, { renewUrl: renewalData.renewUrl }, {
      config: CONFIG,
      logger: LOGGER,
    }) || {
      turnstileProvider: null,
      turnstileAttempts: [],
    };
    if (captchaMeta.turnstileProvider) {
      const providerLabel = resolveTurnstileProviderLabel(captchaMeta.turnstileProvider)
        || captchaMeta.turnstileProvider;
      const failedBefore = listFailedTurnstileProviders(captchaMeta.turnstileAttempts);
      if (failedBefore.length > 0) {
        pushStep(
          `Turnstile 由 ${providerLabel} 求解成功`
          + `（${failedBefore.join(' → ')} 熔断后切换）`,
        );
      } else {
        pushStep(`Turnstile 由 ${providerLabel} 求解成功`);
      }
    }
    pushStep('续期表单提交完成');

    log('正在提取续期后的新到期日...');
    logDebug(`续期后页面 URL: ${page.url()}`);

    // 页面内优先读「更新後の利用期限」单元格；失败则回退纯文本日期解析
    // （TD 查找 + 回退逻辑收敛于 page-utils.extractNewExpireDate，可单测）
    const newExpireDate = await extractNewExpireDate(page);

    if (newExpireDate) {
      log(`✅ 成功提取新到期日: ${newExpireDate}`);
      pushStep(`提取新到期日: ${newExpireDate}`);
    } else {
      log(`⚠️ 未能自动提取新到期日，请检查页面结构`);
      pushStep('未能自动提取新到期日');
    }

    runOutcome = 'success';
    runOutcomeLabel = newExpireDate
      ? `续期成功 → ${newExpireDate}`
      : '续期成功（未提取新到期日）';
    log(`🎉 续期流程全部完成！（耗时 ${durationText()}）`);
    pushStep('续期流程全部完成');

    // 外部平台定时启停容器时通常无 CRON_SCHEDULE，依赖默认 6h 或自行配置 NOTIFY_NEXT_RUN_HOURS
    const nextRunStr = resolveNextRun();
    const executedAt = formatTokyoDateTime();

    // 持久化续期成功记录（使用配置的状态文件路径）
    persistRenewalRecord(buildRenewalRecord({
      success: true,
      serverName: renewalData.vpsInfo.serverName,
      plan: renewalData.vpsInfo.plan,
      oldExpireDate: renewalData.vpsInfo.expireDate,
      newExpireDate,
    }));

    // 持久化后仅读取一次，同时取两个信号：
    // - consecutiveSuccesses：含本轮在内的连续成功次数（通知展示「稳定运行」信号）
    // - hasHistory：持久化前总数为 N，写入后为 N+1，故「totalRuns > 1」等价于存在历史累计；
    //   非持久化部署（容器每轮重建、状态文件随容器丢失）首轮 totalRuns=1，
    //   通知应展示「本轮续期成功」而非恒为 1 的「已连续成功 N 次」
    const { consecutiveSuccesses, totalRuns: postTotalRuns } = getRenewalStatus(
      RENEWAL_STATUS_FILE,
      ALERT_AFTER_CONSECUTIVE_FAILURES,
      LOGGER,
    );
    const hasHistory = postTotalRuns > 1;

    await notify(buildSuccessNotifyMessage({
      serverName: renewalData.vpsInfo.serverName,
      plan: renewalData.vpsInfo.plan,
      oldExpireDate: renewalData.vpsInfo.expireDate,
      newExpireDate,
      executedAt,
      nextRunAt: nextRunStr,
      processSteps,
      detail: CONFIG.TG_NOTIFY_DETAIL,
      turnstileProvider: captchaMeta.turnstileProvider,
      turnstileAttempts: captchaMeta.turnstileAttempts,
      durationMs: elapsedMs(),
      remainingHours: renewalData.remainingHours,
      consecutiveSuccesses,
      hasHistory,
    }), { kind: 'success' });
    // 安全关闭：close 抛错不误入 catch（续期已成功且记录已持久化，误报失败会引发恐慌）
    await safeClosePage(page, LOGGER);
  } catch (e) {
    // 失败分类只求值一次，outage 判定从分类结果派生（避免同一判定被重复求值）
    const failureMeta = classifyRenewalFailure({
      errorMessage: e.message,
      errorCode: e?.code,
    });
    const turnstileAllProvidersFailed = failureMeta.category === FAILURE_CATEGORY.TURNSTILE_OUTAGE;
    runOutcome = 'failure';
    // 需人工确认的错误不套用失败分类标签，避免误导
    const needsManualConfirmation = e?.code === 'MANUAL_CONFIRMATION_REQUIRED';
    runOutcomeLabel = needsManualConfirmation ? '需要人工确认' : failureMeta.label;
    err(
      `流程异常终止 [${runOutcomeLabel}]: ${e.message}（耗时 ${durationText()}）`,
    );

    // 持久化续期失败记录
    persistRenewalRecord(buildRenewalRecord({
      success: false,
      serverName: knownVps.serverName,
      plan: knownVps.plan,
      oldExpireDate: knownVps.expireDate,
      errorMessage: e.message,
    }));

    // 告警升级：连续失败达到阈值时发送升级告警
    const { consecutiveFailures } = getRenewalStatus(
      RENEWAL_STATUS_FILE,
      ALERT_AFTER_CONSECUTIVE_FAILURES,
      LOGGER,
    );
    const isEscalation = consecutiveFailures >= ALERT_AFTER_CONSECUTIVE_FAILURES;

    const antiProxyMode = resolveAntiCaptchaProxyMode(CONFIG);
    const proxyHint = buildProxyHint({
      hasProxy: HAS_PROXY,
      proxyType: CONFIG.PROXY_TYPE,
      maskedAddress: maskProxyAddress(CONFIG.PROXY_ADDRESS),
      proxyPort: CONFIG.PROXY_PORT,
      antiCaptchaHostnameSkipped: antiProxyMode.reason === 'hostname_skipped',
    });

    const failureSteps = [...processSteps, `异常终止: ${e.message}`];

    const failedProviders = Array.isArray(e?.providerNames)
      ? e.providerNames
      : (Array.isArray(e?.attempts)
        ? e.attempts.map((a) => a.provider).filter(Boolean)
        : []);

    // 图形验证码实际已尝试次数（handleCaptchaPage 最后一次重试抛错时附带）
    const captchaRetries = Number.isInteger(e?.captchaAttempts) ? e.captchaAttempts : 0;

    // 需人工确认：发送专门提醒（登录检查新确认页，手动处理后重跑容器），区别于通用失败通知
    if (needsManualConfirmation) {
      await notify(buildManualConfirmNotifyMessage({
        executedAt: formatTokyoDateTime(),
        reason: e.message,
        nextRunAt: resolveNextRun(),
      }), { kind: 'manual_confirm' });
    } else {
      await notify(buildFailureNotifyMessage({
        errorMessage: e.message,
        consecutiveFailures,
        isEscalation: isEscalation || turnstileAllProvidersFailed,
        proxyHint,
        captchaMaxRetry: CONFIG.CAPTCHA_MAX_RETRY,
        executedAt: formatTokyoDateTime(),
        processSteps: failureSteps,
        detail: CONFIG.TG_NOTIFY_DETAIL,
        turnstileAllProvidersFailed,
        failedProviders,
        errorCode: e?.code || '',
        turnstileAttempts: Array.isArray(e?.attempts) ? e.attempts : [],
        serverName: knownVps.serverName,
        plan: knownVps.plan,
        expireDate: knownVps.expireDate,
        remainingHours: knownVps.remainingHours,
        durationMs: elapsedMs(),
        failureCategory: failureMeta.category,
        nextRunAt: resolveNextRun(),
        captchaRetries,
      }), { kind: 'failure' });
    }
    process.exitCode = 1;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch { /* 忽略 */ }
    }
    cleanChromeCaches(CONFIG.CHROME_USER_DATA);
    const outcomeIcon = runOutcome === 'success'
      ? '✅'
      : runOutcome === 'skip'
        ? 'ℹ️'
        : runOutcome === 'failure'
          ? '❌'
          : '⚠️';
    log(
      `========== 流程结束 · ${outcomeIcon} ${runOutcomeLabel}`
      + `（总耗时 ${durationText()}）==========`,
    );
  }
}

// ============================================================
// CLI 入口
// ============================================================

/** --help / --version 用法文本（不依赖 main()，可在未配置环境时查看） */
const USAGE_TEXT = `Xserver VPS 自动续期 v${PROJECT_VERSION}

用法: node xserver-vps-renew.mjs [选项]

选项:
  -v, --version  显示版本号
  -h, --help     显示本帮助

关键环境变量（完整清单见 .env.example / README.md）:
  XSERVER_MEMBER_ID    会员 ID（必填）
  XSERVER_PASSWORD     登录密码（必填）
  CAPSOLVER_API_KEY    Turnstile 打码平台主密钥（推荐）
  TG_BOT_TOKEN         Telegram Bot Token（可选）
  TG_CHAT_ID           Telegram Chat ID（可选）
  LOG_LEVEL            debug / info / warn / error（默认 info）

文档: README.md（配置与入门） / RUNBOOK.md（排障手册）
源项目: ${PROJECT_REPO_URL}`;

// 仅在直接执行时运行 main()
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes('--version') || cliArgs.includes('-v')) {
    console.log(PROJECT_VERSION);
    process.exit(0);
  }
  if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
    console.log(USAGE_TEXT);
    process.exit(0);
  }
  main().catch((e) => {
    // 兜底路径也走统一日志格式（时间戳 + [ERROR] 标签），与 emitLog 输出一致
    err(`未捕获异常: ${e.message}`);
    process.exitCode = 1;
  });
}
