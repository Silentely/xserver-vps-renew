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
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectBrowserFingerprint } from './browser-fingerprint-patch.js';

// 模块化拆分
import {
  recognizeCaptcha as _recognizeCaptcha,
} from './src/captcha.mjs';
import {
  listTurnstileProviders as _listTurnstileProviders,
  extractTurnstileParams as _extractTurnstileParams,
  solveTurnstileWithFailover as _solveTurnstileWithFailover,
  injectTurnstileToken as _injectTurnstileToken,
  isTurnstileOutageError,
  resolveAntiCaptchaProxyMode,
  DEFAULT_TURNSTILE_PROVIDER_MAX_FAILURES,
} from './src/turnstile.mjs';
import {
  writeRenewalStatus,
  buildRenewalRecord,
  getRenewalStatus,
  DEFAULT_STATUS_FILE,
  DEFAULT_ALERT_AFTER_FAILURES,
} from './src/renewal-status.mjs';
import {
  maskProxyAddress,
  getTokyoDateString,
  fetchWithTimeout,
  validateRequiredConfig,
  parsePositiveInt,
  parseLogLevel,
  parseEnvBool,
  shouldLog,
  isNoisyModuleLog,
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_DEBUG,
  LOG_LEVEL_INFO,
  LOG_LEVEL_WARN,
  LOG_LEVEL_ERROR,
} from './src/utils.mjs';
import {
  isRenewalDue,
  buildRenewUrl,
  resolveCaptchaRetryUrl,
  resolveCaptchaRetryNavigation,
  needsUserAgentAlignment,
  shouldSubmitAfterTurnstile,
  evaluateSubmissionResult,
  detectRenewalWindowBlocked,
  extractExpireDateFromText,
  normalizeCellText,
  escapeHtml as _escapeHtml,
  formatTokyoDateTime,
  formatDurationMs,
  buildSuccessNotifyMessage,
  buildSkipNotifyMessage,
  buildFailureNotifyMessage,
  buildProxyHint,
  getRemainingHours,
  parseNotifyDetail,
  isTurnstileAllProvidersFailed,
  clampTelegramMessage,
  resolveTurnstileProviderLabel,
  classifyRenewalFailure,
  RENEWAL_WINDOW_HOURS,
  FREE_VPS_MAX_HOURS,
  resolveNextRunAt,
  DEFAULT_NEXT_RUN_INTERVAL_HOURS,
  DEFAULT_TG_NOTIFY_DETAIL,
} from './src/renewal-logic.mjs';

/** 默认 Keras 验证码识别 API（Cloud Run，可被 CAPTCHA_API 覆盖） */
const DEFAULT_CAPTCHA_API = 'https://captcha-120546510085.asia-northeast1.run.app';

// ============================================================
// 模块函数包装层（桥接模块函数与主脚本的 log/CONFIG 依赖）
// ============================================================

/** 模块内日志桥接：轮询/原始响应等噪音仅在 debug 输出 */
function moduleLog(msg) {
  if (isNoisyModuleLog(msg)) {
    logDebug(msg);
    return;
  }
  log(msg);
}

/** 验证码识别包装（注入 CONFIG 和 log） */
async function recognizeCaptcha(imgSrc) {
  return _recognizeCaptcha(imgSrc, CONFIG.CAPTCHA_API, moduleLog);
}

/** 已配置的 Turnstile 提供商列表（按 failover 顺序） */
function listTurnstileProviders() {
  return _listTurnstileProviders(CONFIG);
}

/** Turnstile 参数提取包装（注入 log） */
async function extractTurnstileParams(page) {
  return _extractTurnstileParams(page, moduleLog);
}

/** Turnstile 多平台 failover 求解（主路径） */
async function solveTurnstileWithFailover(websiteURL, params) {
  return _solveTurnstileWithFailover(websiteURL, params, CONFIG, moduleLog, {
    timeout: CONFIG.TURNSTILE_API_TIMEOUT,
    maxFailuresPerProvider: CONFIG.TURNSTILE_PROVIDER_MAX_FAILURES,
  });
}

/** Turnstile token 注入包装（注入 log） */
async function injectTurnstileToken(page, token) {
  return _injectTurnstileToken(page, token, moduleLog);
}

// 使用 rebrowser-puppeteer-core 替代原生 puppeteer-core
// rebrowser-patches 修复了 Runtime.Enable 泄露检测，避免被 Cloudflare Turnstile 识别为自动化浏览器
const puppeteer = addExtra(rebrowserPuppeteer);
puppeteer.use(StealthPlugin());

// ============================================================
// 配置
// ============================================================

// 真实浏览器调试收集的 UA (Chrome 149 Edge on macOS)
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0';

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
  TURNSTILE_TIMEOUT: parsePositiveInt(process.env.TURNSTILE_TIMEOUT_MS, 60_000, { min: 10_000, max: 300_000 }),
  TURNSTILE_API_TIMEOUT: parsePositiveInt(process.env.TURNSTILE_API_TIMEOUT_MS, 120_000, { min: 15_000, max: 300_000 }),
  CAPTCHA_MAX_RETRY: parsePositiveInt(process.env.CAPTCHA_MAX_RETRY, 3, { min: 1, max: 10 }),

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
  DEFAULT_UA,

  // 状态持久化
  RENEWAL_STATUS_FILE,
  ALERT_AFTER_FAILURES: ALERT_AFTER_CONSECUTIVE_FAILURES,
};

/** 运行时计算代理配置状态 */
const HAS_PROXY = !!(CONFIG.PROXY_TYPE && CONFIG.PROXY_ADDRESS && CONFIG.PROXY_PORT);

// ============================================================
// Chrome 路径检测
// ============================================================

function findChromePath() {
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => existsSync(p)) || 'google-chrome-stable';
}

// ============================================================
// 日志
// 🔧 优化：使用环境变量时区（默认东京时区），统一日志时间格式
// ============================================================

const LOG_TIMEZONE = process.env.TZ || 'Asia/Tokyo';

/**
 * 格式化时间戳（按环境变量时区）
 * @returns {string} 格式化后的时间字符串（YYYY-MM-DD HH:mm:ss）
 */
const ts = () => {
  const now = new Date();
  return now.toLocaleString('ja-JP', {
    timeZone: LOG_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\//g, '-');
};

/** 按 LOG_LEVEL 输出；error 始终带 ❌ 前缀写 stderr */
function emitLog(level, msg) {
  if (!shouldLog(CONFIG.LOG_LEVEL, level)) return;
  const line = `${ts()} ${msg}`;
  if (level === LOG_LEVEL_ERROR) {
    console.error(line.startsWith(`${ts()} ❌`) ? line : `${ts()} ❌ ${msg}`);
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

/** 转义 HTML 特殊字符，避免 Telegram parse_mode=HTML 解析失败 */
function escapeHtml(str) {
  return _escapeHtml(str);
}

// ============================================================
// Telegram 通知
// ============================================================

/**
 * 发送 Telegram 通知
 * @param {string} message
 * @param {{ kind?: 'success'|'skip'|'failure'|'other' }} [opts]
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
    writeRenewalStatus(record, RENEWAL_STATUS_FILE);
    log(`📝 续期记录已保存: ${RENEWAL_STATUS_FILE}`);
  } catch (e) {
    err(`续期记录保存失败: ${e.message}`);
  }
}

// ============================================================
// 工具函数
// ============================================================

/** 等待导航完成，返回布尔值表示导航是否成功 */
async function waitForNav(page, timeout = CONFIG.NAVIGATION_TIMEOUT) {
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout });
    return true;
  } catch (e) {
    log(`⚠️ 导航等待异常（已忽略）: ${e.message}`);
    return false;
  }
}

/** 获取元素文本 */
async function getText(page, selector) {
  const el = await page.$(selector);
  if (!el) return null;
  return page.evaluate((e) => e.textContent.trim(), el);
}

/** 清理 Chrome 锁文件 */
function cleanChromeLocks(userDataDir) {
  if (!userDataDir) return;
  for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = join(userDataDir, lock);
    try { rmSync(lockPath, { force: true }); } catch { /* 忽略 */ }
  }
}

// ============================================================
// 步骤 1：登录
// ============================================================

/**
 * 登录 Xserver 面板
 * @returns {Promise<{ viaCookie: boolean }>}
 */
async function handleLogin(page) {
  log('正在导航到登录页面...');
  await page.goto(`${CONFIG.BASE_URL}${CONFIG.LOGIN_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.NAVIGATION_TIMEOUT,
  });

  // 若已登录（被重定向到面板），直接返回
  if (page.url().includes('/xvps/index')) {
    log('Cookie 有效，已处于登录状态。');
    return { viaCookie: true };
  }

  // 检查页面是否有登录错误
  const errorText = await getText(page, '.errorMessage');
  if (errorText) {
    err(`登录页存在错误信息: ${errorText}`);
  }

  log('正在填充凭据并提交...');
  await page.type('#memberid', CONFIG.MEMBER_ID, { delay: 50 });
  await page.type('#user_password', CONFIG.PASSWORD, { delay: 50 });

  // 点击提交并等待导航
  const submitBtn = await page.$('input[name="action_user_login"]')
    || await page.$('#login_area input[type="submit"]');

  if (submitBtn) {
    await Promise.all([waitForNav(page), submitBtn.click()]);
  } else {
    await Promise.all([
      waitForNav(page),
      page.$eval('#login_area', (form) => form.submit()),
    ]);
  }

  if (page.url().includes('/login/')) {
    throw new Error('登录失败，请检查 XSERVER_MEMBER_ID 和 XSERVER_PASSWORD。');
  }

  log('登录成功！');
  return { viaCookie: false };
}

// ============================================================
// 步骤 2：检查是否需要续期
// ============================================================

/**
 * 检查是否需要续期
 * @returns {Promise<
 *   | { needed: true, renewUrl: string, vpsInfo: { serverName: string|null, plan: string|null, expireDate: string|null }, remainingHours: number|null }
 *   | { needed: false, reasonCode: 'not_due'|'no_free_vps'|'window_blocked', vpsInfo: object, remainingHours: number|null, reasonDetail: string }
 * >}
 */
async function checkRenewalNeeded(page) {
  log('正在检查续期状态...');

  if (!page.url().includes('/xvps/index')) {
    await page.goto(`${CONFIG.BASE_URL}/xapanel/xvps/index`, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.NAVIGATION_TIMEOUT,
    });
  }

  // 计算今天和明天的日期（东京时区，yyyy-mm-dd 格式）
  const today = getTokyoDateString();
  const tomorrow = getTokyoDateString(Date.now(), 1);
  logDebug(`参考日期（东京）: 今天 ${today} / 明天 ${tomorrow}`);

  const result = await page.evaluate(() => {
    const row = document.querySelector('tr:has(.freeServerIco)');
    if (!row) {
      return null;
    }

    const termEl = row.querySelector('.contract__term');
    const detailLink = row.querySelector('a[href^="/xapanel/xvps/server/detail?id="]');

    // 提取 VPS 规格信息
    const cells = row.querySelectorAll('td');

    let serverName = null;
    let plan = null;

    // 遍历所有单元格，根据内容特征判断
    cells.forEach((cell, idx) => {
      const text = cell.textContent.replace(/\s+/g, ' ').trim(); // 移除多余空白符

      // 判断规格：包含内存/CPU/存储信息
      if ((text.includes('メモリ') || text.includes('コア') || text.includes('GB') || text.includes('NVMe'))
          && text.length > 10) {
        plan = text;
      }

      // 判断服务器名：包含 host/vps 关键词，且长度较短
      if ((text.includes('host') || text.includes('vps-')) && text.length < 30) {
        serverName = text;
      }
    });

    return {
      expireDate: termEl ? termEl.textContent.trim() : null,
      detailHref: detailLink ? detailLink.href : null,
      serverName: serverName,
      plan: plan,
    };
  });

  if (!result) {
    log('未找到免费 VPS 条目。');
    return {
      needed: false,
      reasonCode: 'no_free_vps',
      vpsInfo: {
        serverName: null,
        plan: null,
        expireDate: null,
      },
      remainingHours: null,
      reasonDetail: '面板中未找到带免费标识的 VPS 条目',
    };
  }

  // 清理 VPS 信息中的多余空白符
  const cleanServerName = normalizeCellText(result.serverName);
  const cleanPlan = normalizeCellText(result.plan);
  const remainingHours = getRemainingHours(result.expireDate);

  log(
    `VPS: ${cleanServerName ?? '未找到'}`
    + ` | 规格 ${cleanPlan ?? '未找到'}`
    + ` | 到期 ${result.expireDate ?? '未找到'}`
    + (remainingHours != null ? ` | 剩余约 ${remainingHours.toFixed(1)}h` : ''),
  );

  // 官方规则：4GB 最长 FREE_VPS_MAX_HOURS 小时，剩余 ≤ RENEWAL_WINDOW_HOURS 小时可续期
  // 纯日期按东京日末估算剩余小时，不再把「明天到期」一律判为可续（#5）
  if (!isRenewalDue(result.expireDate, today, tomorrow)) {
    const remainingLabel =
      remainingHours != null ? `剩余约 ${remainingHours.toFixed(1)}h` : '剩余时间未知';
    const reasonDetail =
      `无需续期（到期: ${result.expireDate}；${remainingLabel}；` +
      `规则: 最长 ${FREE_VPS_MAX_HOURS}h / 剩余≤${RENEWAL_WINDOW_HOURS}h 可续；` +
      `今天 ${today} / 明天 ${tomorrow}）`;
    log(reasonDetail);
    return {
      needed: false,
      reasonCode: 'not_due',
      vpsInfo: {
        serverName: cleanServerName,
        plan: cleanPlan,
        expireDate: result.expireDate,
      },
      remainingHours,
      reasonDetail,
    };
  }

  const renewUrl = buildRenewUrl(result.detailHref, CONFIG.BASE_URL);
  log(`需要续期！URL: ${renewUrl}`);

  // 返回续期 URL 和 VPS 信息
  return {
    needed: true,
    renewUrl,
    vpsInfo: {
      serverName: cleanServerName,
      plan: cleanPlan,
      expireDate: result.expireDate,
    },
    remainingHours,
  };
}

// ============================================================
// 步骤 3：续期申请确认
// ============================================================

/**
 * 打开续期申请页并点击确认。
 * 若官方返回「未满 12 小时窗口」拦截页，则软跳过，不进入验证码流程。
 *
 * 官方页面路径（2026-07-23 核对）：
 * 1. GET `/freevps/extend/index?id_vps=…` — 可能已显示「以降にお試し」说明，但按钮仍在
 * 2. POST/导航 → `/freevps/extend/conf` — 窗口未开时为纯拦截页（issue #5 用户报错 URL）；
 *    窗口已开时才是验证码 + Turnstile 页
 *
 * @returns {Promise<
 *   | { status: 'ready' }
 *   | { status: 'window_blocked', reason: string, retryAfter: string|null }
 * >}
 */
async function handleRenewalConfirm(page, renewUrl) {
  log('正在导航到续期申请页面...');
  await page.goto(renewUrl, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.NAVIGATION_TIMEOUT,
  });

  // index 页：未开窗时正文已含「以降にお試し」——直接软跳过，不必再点确认
  // （实机：按钮 formaction=/extend/conf 在未开窗时仍可能存在，不能靠「有无按钮」判断）
  const indexBlocked = await detectBlockedPage(page);
  if (indexBlocked) return indexBlocked;

  const extendBtn = await page.$('[formaction="/xapanel/xvps/server/freevps/extend/conf"]');
  if (!extendBtn) {
    // 无确认按钮时再读一次正文，优先识别窗口拦截，避免笼统报错
    const blocked = await detectBlockedPage(page);
    if (blocked) return blocked;
    throw new Error('未找到续期确认按钮。');
  }

  log('正在点击续期确认...');
  await Promise.all([waitForNav(page), extendBtn.click()]);

  // conf 页：#5 用户反馈的拦截 URL；也可能是真正的验证码页
  const confBlocked = await detectBlockedPage(page);
  if (confBlocked) return confBlocked;

  log(`已进入验证码页面: ${page.url()}`);
  return { status: 'ready' };
}

/**
 * 读取当前页正文并检测官方续期窗口拦截
 * @returns {Promise<null | { status: 'window_blocked', reason: string, retryAfter: string|null }>}
 */
async function detectBlockedPage(page) {
  const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const detection = detectRenewalWindowBlocked(pageText, page.url());
  if (!detection.blocked) return null;
  log(`⏳ 官方拦截：${detection.reason}`);
  return {
    status: 'window_blocked',
    reason: detection.reason,
    retryAfter: detection.retryAfter,
  };
}

// ============================================================
// 步骤 4-6：验证码识别 + Turnstile 求解（已拆分为独立模块）
// 详见 src/captcha.mjs 和 src/turnstile.mjs
// ============================================================

/**
 * 模拟人类鼠标移动轨迹（贝塞尔曲线 + 随机抖动）
 * Cloudflare Turnstile 会分析鼠标移动模式来判定是否为自动化
 */
async function humanMouseMove(page, fromX, fromY, toX, toY) {
  const steps = 15 + Math.floor(Math.random() * 10); // 15-25 步
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // 简单的缓动函数（ease-in-out）
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const x = fromX + (toX - fromX) * ease + (Math.random() - 0.5) * 2;
    const y = fromY + (toY - fromY) * ease + (Math.random() - 0.5) * 2;
    await page.mouse.move(x, y);
    // 人类鼠标移动间隔不是完全均匀的
    await sleep(5 + Math.floor(Math.random() * 15));
  }
}

/**
 * 点击 Turnstile checkbox：模拟真实人类行为
 * 1. 找到 Turnstile iframe 的位置
 * 2. 模拟鼠标从随机起点移动到 checkbox 位置
 * 3. 短暂停留后点击
 */
async function clickTurnstileFallback(page) {
  try {
    logDebug('尝试点击 Turnstile checkbox...');
    const frames = page.frames();
    const turnstileFrame = frames.find((f) =>
      f.url().includes('challenges.cloudflare.com'),
    );

    if (turnstileFrame) {
      const frameHandle = await turnstileFrame.frameElement();
      if (frameHandle) {
        const box = await frameHandle.boundingBox();
        if (box && box.width > 10 && box.height > 10) {
          // checkbox 在 iframe 内的偏移位置（左侧约 30px 处）
          const clickX = box.x + 28 + Math.random() * 6;
          const clickY = box.y + box.height / 2 + (Math.random() - 0.5) * 8;

          // 模拟人类行为：从页面随机位置移动到目标
          const startX = 200 + Math.random() * 400;
          const startY = 300 + Math.random() * 200;

          logDebug(
            `Turnstile iframe: (${box.x.toFixed(0)},${box.y.toFixed(0)}) `
            + `${box.width.toFixed(0)}x${box.height.toFixed(0)}`,
          );
          logDebug(
            `鼠标轨迹: (${startX.toFixed(0)},${startY.toFixed(0)})`
            + ` → (${clickX.toFixed(0)},${clickY.toFixed(0)})`,
          );

          await page.mouse.move(startX, startY);
          await sleep(200 + Math.random() * 300);
          await humanMouseMove(page, startX, startY, clickX, clickY);
          await sleep(50 + Math.random() * 150);
          await page.mouse.click(clickX, clickY);
          logDebug('Turnstile checkbox 已点击');
          return true;
        }
      }
    }

    logDebug('未找到 Turnstile iframe，点击失败');
    return false;
  } catch (e) {
    logWarn(`Turnstile 点击异常: ${e.message}`);
    return false;
  }
}

/**
 * 获取页面中已有的 Turnstile token
 * @param {Page} page - Puppeteer Page 对象
 * @returns {Promise<string>} - token 值，无 token 返回空字符串
 */
async function getTurnstileToken(page) {
  try {
    return await page.evaluate(() => {
      const fields = document.querySelectorAll('[name="cf-turnstile-response"]');
      for (const field of fields) {
        if (field.value) return field.value;
      }
      return '';
    });
  } catch (error) {
    err(`获取 Turnstile token 失败: ${error.message}`);
    return '';
  }
}

/**
 * 处理 Cloudflare Turnstile
 * @returns {Promise<{ ok: boolean, providerName?: string|null, attempts?: object[] }>}
 */
async function waitForTurnstile(page) {
  log('正在处理 Cloudflare Turnstile...');

  const cfContainer = await page.$('.cf-turnstile');
  if (!cfContainer) {
    log('页面无 Turnstile 组件，跳过。');
    return { ok: true, providerName: null, attempts: [] };
  }

  const turnstileConfig = await page.evaluate(() => {
    const div = document.querySelector('.cf-turnstile');
    if (!div) return null;
    return {
      sitekey: div.getAttribute('data-sitekey'),
      callback: div.getAttribute('data-callback'),
      theme: div.getAttribute('data-theme') || '(默认)',
      action: div.getAttribute('data-action') || '(无)',
    };
  }).catch(() => null);

  if (turnstileConfig) {
    logDebug(
      `Turnstile 配置: sitekey=${turnstileConfig.sitekey}, callback=${turnstileConfig.callback}`,
    );
  } else {
    logWarn('无法获取 Turnstile 配置（继续尝试提取参数）');
  }

  const existingToken = await getTurnstileToken(page);
  if (existingToken) {
    log('Turnstile 令牌已就绪。');
    return { ok: true, providerName: 'prefilled', attempts: [] };
  }

  const fieldCount = await page.evaluate(() => (
    document.querySelectorAll('[name="cf-turnstile-response"]').length
  )).catch(() => 0);
  logDebug(`检测到 ${fieldCount} 个 cf-turnstile-response 字段`);

  logDebug('等待 Turnstile 渲染...');
  await sleep(3000);

  try {
    await page.screenshot({ path: '/tmp/turnstile-before-solve.png', fullPage: false });
    logDebug('已保存求解前截图: /tmp/turnstile-before-solve.png');
  } catch (e) {
    logDebug(`截图失败: ${e.message}`);
  }

  // Docker 环境自然通过成功率极低；有 key 时直接走多平台 API failover
  const providers = listTurnstileProviders();

  if (providers.length > 0) {
    log('Turnstile: 使用多平台 API failover 求解');
    logDebug(`已配置平台: ${providers.map((p) => p.name).join(' → ')}`);

    const params = await extractTurnstileParams(page);
    if (!params) {
      err('无法提取 Turnstile 参数');
      return { ok: false };
    }

    try {
      const result = await solveTurnstileWithFailover(page.url(), params);
      const providerLabel = resolveTurnstileProviderLabel(result.providerName) || result.providerName;
      log(`Turnstile 由 ${providerLabel} 求解成功`);

      // 先注入 token：setUserAgent 在 rebrowser 下可能 Target closed，绝不能挡住已拿到的 token
      const callbackResult = await page.evaluate((tkn) => {
        const cfDiv = document.querySelector('.cf-turnstile[data-callback]');
        if (cfDiv) {
          const callbackName = cfDiv.getAttribute('data-callback');
          if (callbackName && typeof window[callbackName] === 'function') {
            window[callbackName](tkn);
            return `data-callback:${callbackName}`;
          }
        }
        if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
          return 'turnstile_loaded';
        }
        return null;
      }, result.token);

      if (callbackResult) {
        logDebug(`Turnstile token 已通过 callback 传递: ${callbackResult}`);
      } else {
        logDebug('未找到 Turnstile callback，注入 input 元素...');
      }

      await injectTurnstileToken(page, result.token);
      await sleep(2000);

      const verifyToken = await getTurnstileToken(page);
      if (verifyToken) {
        logDebug(`Turnstile token 已就绪，长度: ${verifyToken.length}`);
      } else {
        logDebug('cf-turnstile-response 无值，callback 可能已处理 token');
      }

      // UA 对齐尽力而为：失败只记 warn，不回滚已注入 token、不判求解失败
      if (result.userAgent) {
        try {
          const currentUA = await page.evaluate(() => navigator.userAgent);
          if (needsUserAgentAlignment(currentUA, result.userAgent)) {
            logWarn(
              `UA 不匹配，更新浏览器 UA 以匹配 API`
              + `（当前: ${currentUA.substring(0, 40)}… → API: ${result.userAgent.substring(0, 40)}…）`,
            );
            await page.setUserAgent(result.userAgent);
            logDebug('浏览器 UA 已对齐到打码平台返回值');
          } else {
            logDebug('浏览器 UA 与 API 返回值一致或无需对齐');
          }
        } catch (uaError) {
          logWarn(
            `对齐 UA 失败（已保留已注入 token，继续提交）: ${uaError.message}`,
          );
        }
      }

      try {
        await page.screenshot({ path: '/tmp/turnstile-after-solve.png', fullPage: false });
        logDebug('已保存求解后截图: /tmp/turnstile-after-solve.png');
      } catch (e) {
        logDebug(`截图失败: ${e.message}`);
      }

      return {
        ok: true,
        providerName: result.providerName || null,
        attempts: Array.isArray(result.attempts) ? result.attempts : [],
      };
    } catch (e) {
      if (isTurnstileOutageError(e)) {
        err(`Turnstile 多平台均失败，触发最高级告警: ${e.message}`);
        throw e;
      }
      err(`API 求解失败: ${e.message}`);
      return { ok: false, attempts: Array.isArray(e?.attempts) ? e.attempts : [] };
    }
  }

  logWarn('未配置 Turnstile API 密钥，继续等待自然通过（成功率极低）...');
  const naturalOk = await waitForTurnstileToken(page);
  return { ok: naturalOk, providerName: naturalOk ? 'natural' : null, attempts: [] };
}

/**
 * 轮询等待 Turnstile token 生成（降级模式专用）
 * 用于点击方式后等待 Turnstile 自行生成 token
 */
async function waitForTurnstileToken(page) {
  const startTime = Date.now();
  let lastClickTime = Date.now();
  while (Date.now() - startTime < CONFIG.TURNSTILE_TIMEOUT) {
    // 🔧 优化：读取所有 cf-turnstile-response 字段，返回第一个有值的
    const token = await getTurnstileToken(page);

    if (token) {
      log(`Turnstile 令牌已生成！（耗时 ${Date.now() - startTime}ms）`);
      return true;
    }

    // 每 10 秒重试点击一次
    const now = Date.now();
    if (now - lastClickTime >= 10000) {
      log(`令牌未生成，重试点击...`);
      await clickTurnstileFallback(page);
      lastClickTime = now;
    }

    await sleep(1000);
  }

  err(`Turnstile 等待超时（${CONFIG.TURNSTILE_TIMEOUT}ms），将尝试强制提交。`);
  return false;
}

// ============================================================
// 步骤 6：验证码页面完整流程（识别 + Turnstile + 提交）
// ============================================================

/**
 * 验证码/提交失败后回到可识别验证码的页面
 * 优先经带 id_vps 的 index 再点确认进 conf；裸 /conf 常无验证码图。
 * @param {import('puppeteer').Page} page
 * @param {string} currentUrl
 * @param {string|null|undefined} renewUrl
 */
async function navigateForCaptchaRetry(page, currentUrl, renewUrl) {
  const nav = resolveCaptchaRetryNavigation(currentUrl, { renewUrl });

  if (nav.mode === 'renew_index') {
    log(`⏭️ 重试：回到续期申请页再进入验证码（${nav.url}）`);
    const confirmResult = await handleRenewalConfirm(page, nav.url);
    if (confirmResult?.status === 'window_blocked') {
      throw new Error(confirmResult.reason || '未进入官方 12 小时续期窗口');
    }
    // handleRenewalConfirm 已落到 conf；再等图渲染
    await sleep(2000);
    return;
  }

  if (nav.mode === 'reload_conf') {
    log('⏭️ 重试：刷新当前验证码确认页');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT });
  } else {
    if (!nav.url) {
      throw new Error('无法推导验证码重试 URL（缺少 renewUrl 且当前页无法映射到 conf）');
    }
    logWarn(`⏭️ 重试：降级直接打开 conf（可能无验证码图）: ${nav.url}`);
    await page.goto(nav.url, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT });
  }
  // Base64 内嵌图渲染需要时间
  await sleep(3000);
}

/**
 * 验证码页面完整流程
 * @param {import('puppeteer').Page} page
 * @param {{ renewUrl?: string|null }} [options] - renewUrl 用于失败后回到 index?id_vps=
 * @returns {Promise<{ turnstileProvider: string|null, turnstileAttempts: object[] }>}
 */
async function handleCaptchaPage(page, options = {}) {
  log('正在处理验证码页面...');
  const renewUrl = typeof options?.renewUrl === 'string' ? options.renewUrl : null;

  // 最多重试 3 次（验证码识别错误时刷新重试）
  const maxRetries = CONFIG.CAPTCHA_MAX_RETRY || 3;
  let lastError = null;
  /** @type {{ turnstileProvider: string|null, turnstileAttempts: object[] }} */
  let lastTurnstileMeta = { turnstileProvider: null, turnstileAttempts: [] };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`验证码识别第 ${attempt} 次尝试...`);

      // 等待验证码图片元素（验证码图片是 Base64 内嵌在 src 属性中）
      await page.waitForSelector('img[src^="data:image"], img[src^="data:"]', { timeout: 10_000 });

      // 直接读取 img 元素的 src 属性（已经是 Base64 格式）
      const imgDataUri = await page.$eval('img[src^="data:image"], img[src^="data:"]', (el) => el.src);
      if (!imgDataUri) throw new Error('未找到验证码图片。');

      // 优化：在验证码识别期间，并行检查 Turnstile 是否已提前通过
      let turnstileCheckPromise = null;
      let turnstileAlreadyPassed = false;

      // 启动 Turnstile 提前检查（不阻塞验证码识别）
      turnstileCheckPromise = page.evaluate(() => {
        const fields = document.querySelectorAll('[name="cf-turnstile-response"]');
        for (const field of fields) {
          if (field.value) return true;
        }
        return false;
      }).catch(() => false);

      // 识别验证码（并行进行 Turnstile 检查）
      const code = await recognizeCaptcha(imgDataUri);

      // 检查 Turnstile 结果
      turnstileAlreadyPassed = await turnstileCheckPromise;
      if (turnstileAlreadyPassed) {
        log('✅ Turnstile 在验证码识别期间已提前通过！');
      }

      // 填入验证码（模拟人类输入）
      const captchaInput = await page.$('[placeholder*="上の画像"]');
      if (!captchaInput) throw new Error('未找到验证码输入框。');
      await captchaInput.click();
      await page.type('[placeholder*="上の画像"]', code, { delay: 80 });
      log('验证码已填入输入框。');

      // 等待 Turnstile（返回 { ok, providerName, attempts }）
      const turnstileResult = await waitForTurnstile(page);
      lastTurnstileMeta = {
        turnstileProvider: turnstileResult?.providerName || (turnstileAlreadyPassed ? 'prefilled' : null),
        turnstileAttempts: Array.isArray(turnstileResult?.attempts) ? turnstileResult.attempts : [],
      };

      // 无有效 Turnstile 时禁止强制提交（否则必然 認証に失敗，且 /do 重试常无验证码图）
      if (!shouldSubmitAfterTurnstile(turnstileResult) && !turnstileAlreadyPassed) {
        throw new Error('Turnstile 未通过，跳过提交以免认证失败');
      }

      // 提交表单
      log('正在提交表单...');

      const submitBtn = await page.$('input[type="submit"], button[type="submit"]');
      if (!submitBtn) throw new Error('未找到提交按钮。');

      await Promise.all([waitForNav(page), submitBtn.click()]);

      log(`提交完成，当前页面: ${page.url()}`);

      // 验证续期是否真正成功
      await sleep(2000);
      const pageText = await page.evaluate(() => document.body.innerText);
      const currentUrl = page.url();

      log(`📄 续期提交后页面 URL: ${currentUrl}`);

      // 纯函数解析提交结果（不输出 pageText，避免日志泄露）
      const evaluation = evaluateSubmissionResult(pageText, currentUrl);

      if (evaluation.status === 'success') {
        log(`✅ 页面确认续期成功！检测到: "${evaluation.matched}"`);
        return lastTurnstileMeta;
      }

      if (evaluation.status === 'retry') {
        if (attempt < maxRetries) {
          log(`❌ 第 ${attempt} 次尝试失败: ${evaluation.reason}`);
          log(`⏭️ 刷新验证码，准备第 ${attempt + 1} 次尝试...`);
          await navigateForCaptchaRetry(page, currentUrl, renewUrl);
          continue;
        }
        throw new Error(`续期提交失败（${evaluation.reason}），已尝试 ${maxRetries} 次`);
      }

      // status === 'fail'：不可重试的业务/页面错误
      log(`❌ ${evaluation.reason}`);
      throw new Error(
        evaluation.reason.startsWith('续期') || evaluation.reason.includes('URL:')
          ? evaluation.reason
          : `续期提交后${evaluation.reason}`,
      );

    } catch (error) {
      lastError = error;

      // Turnstile 多平台全挂：不可靠图形验证码重试挽回，立即上抛触发最高级告警
      if (isTurnstileOutageError(error)) {
        log('❌ Turnstile 多平台均已熔断，跳过验证码重试，立即终止本轮');
        throw error;
      }

      if (attempt < maxRetries) {
        log(`❌ 第 ${attempt} 次尝试失败: ${error.message}`);
        log(`⏭️ 准备第 ${attempt + 1} 次尝试...`);

        try {
          await navigateForCaptchaRetry(page, page.url(), renewUrl);
        } catch (reloadError) {
          log(`⚠️ 页面刷新失败: ${reloadError.message}`);
          // 官方窗口关闭等业务错误优先于「原验证码错误」
          if (String(reloadError?.message || '').includes('未进入官方')) {
            throw reloadError;
          }
          throw error; // 无法刷新，抛出原始错误
        }
      } else {
        // 最后一次重试仍失败
        log(`❌ 验证码识别/提交失败，已尝试 ${maxRetries} 次`);
        throw error;
      }
    }
  }

  // 如果循环结束仍未成功（理论上不会走到这里）
  if (lastError) {
    throw lastError;
  }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const startedAtMs = Date.now();
  log('========== Xserver VPS 自动续期开始 ==========');
  log(
    `日志级别: ${CONFIG.LOG_LEVEL}`
    + ` | 通知: ${CONFIG.TG_NOTIFY_DETAIL}`
    + `${CONFIG.TG_NOTIFY_SKIP ? '' : '（跳过类不推送）'}`
    + `${CONFIG.TG_BOT_TOKEN && CONFIG.TG_CHAT_ID ? ' | Telegram 已配置' : ' | Telegram 未配置'}`,
  );

  const configErrors = validateRequiredConfig(CONFIG);
  if (configErrors.length > 0) {
    throw new Error(`配置校验失败: ${configErrors.join('；')}`);
  }

  {
    const tsProviders = listTurnstileProviders();
    if (tsProviders.length === 0) {
      log('⚠️ 未配置任何 Turnstile 打码平台密钥：将依赖自然通过，成功率极低（Docker 几乎不可用）。推荐至少配置 CAPSOLVER_API_KEY，并另配 ANTICAPTCHA_API_KEY 作异构备份');
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
  const pushStep = (step) => {
    processSteps.push(step);
    log(step);
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

  try {
    // 清理锁文件
    cleanChromeLocks(CONFIG.CHROME_USER_DATA);

    // 构建 Chrome 启动参数
    const chromeArgs = [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1440,900',  // 🔧 优化：使用真实浏览器调试的分辨率
      '--window-position=0,0',
      '--tz=Asia/Tokyo',         // 🔧 修正：Xserver 位于日本，使用东京时区
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
      defaultViewport: { width: 1440, height: 900 },  // 🔧 优化：匹配启动参数
    });
    log('Chrome 启动成功（Stealth 模式完整注入）！');

    const page = await browser.newPage();

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

    await page.setUserAgent(DEFAULT_UA);
    logDebug(`浏览器 UA: ${DEFAULT_UA.substring(0, 60)}...`);
    page.setDefaultTimeout(CONFIG.NAVIGATION_TIMEOUT);

    // Standalone Turnstile：正常渲染 + API 求解（不拦截 render）
    logDebug('Turnstile 策略：正常渲染 + API 求解（不拦截 render）');

    // 下次执行：优先展示用调度（cron-run 透传的真实 cron，如 27 */4 * * *），
    // 退回 CRON_SCHEDULE（本地/单次模式），最后退化到 NOTIFY_NEXT_RUN_HOURS（默认 6h）
    const resolveNextRun = () => resolveNextRunAt(Date.now(), {
      cronSchedule: CONFIG.CRON_SCHEDULE_DISPLAY || CONFIG.CRON_SCHEDULE,
      intervalHours: CONFIG.NOTIFY_NEXT_RUN_HOURS,
    });

    // 步骤 1：登录
    pushStep('登录 Xserver 面板');
    const loginResult = await handleLogin(page);
    pushStep(loginResult?.viaCookie ? '登录成功（Cookie 复用）' : '登录成功');

    const fingerprint = await page.evaluate(() => ({
      deviceMemory: navigator.deviceMemory || 'N/A',
      hardwareConcurrency: navigator.hardwareConcurrency || 'N/A',
      platform: navigator.platform,
      language: navigator.language,
      webdriver: navigator.webdriver || false,
    }));
    logDebug(
      `浏览器指纹: deviceMemory=${fingerprint.deviceMemory}GB,`
      + ` hardwareConcurrency=${fingerprint.hardwareConcurrency},`
      + ` platform=${fingerprint.platform}, webdriver=${fingerprint.webdriver}`,
    );

    // 步骤 2：检查续期
    pushStep('检查免费 VPS 到期状态');
    const renewalData = await checkRenewalNeeded(page);
    if (renewalData.vpsInfo) {
      knownVps = {
        serverName: renewalData.vpsInfo.serverName || null,
        plan: renewalData.vpsInfo.plan || null,
        expireDate: renewalData.vpsInfo.expireDate || null,
        remainingHours: renewalData.remainingHours ?? null,
      };
    }
    if (!renewalData.needed) {
      const skipLabel = renewalData.reasonCode === 'no_free_vps' ? '未找到免费 VPS' : '无需续期';
      runOutcome = 'skip';
      runOutcomeLabel = skipLabel;
      pushStep(`判定结果: ${skipLabel}`);
      log(`${skipLabel}，流程结束（耗时 ${durationText()}）`);
      // 记录跳过，避免「长期无写入」被误判为监控静默
      persistRenewalRecord(buildRenewalRecord({
        success: true,
        skipped: true,
        serverName: renewalData.vpsInfo?.serverName,
        plan: renewalData.vpsInfo?.plan,
        oldExpireDate: renewalData.vpsInfo?.expireDate,
        errorMessage: skipLabel,
      }));

      const nextRunStr = resolveNextRun();
      const executedAt = formatTokyoDateTime();
      await notify(buildSkipNotifyMessage({
        reasonCode: renewalData.reasonCode,
        serverName: renewalData.vpsInfo?.serverName,
        plan: renewalData.vpsInfo?.plan,
        expireDate: renewalData.vpsInfo?.expireDate,
        remainingHours: renewalData.remainingHours,
        reasonDetail: renewalData.reasonDetail,
        executedAt,
        nextRunAt: nextRunStr,
        maxHours: FREE_VPS_MAX_HOURS,
        windowHours: RENEWAL_WINDOW_HOURS,
        processSteps,
        detail: CONFIG.TG_NOTIFY_DETAIL,
        durationMs: elapsedMs(),
      }), { kind: 'skip' });
      await page.close();
      return;
    }

    pushStep(
      `需要续期: ${renewalData.vpsInfo.serverName || '未知'}（到期 ${renewalData.vpsInfo.expireDate || '未知'}）`,
    );

    // 步骤 3：续期确认（可能被官方「12時間前」拦截页软跳过，见 #5）
    pushStep('打开续期确认页');
    const confirmResult = await handleRenewalConfirm(page, renewalData.renewUrl);
    if (confirmResult.status === 'window_blocked') {
      const skipLabel = confirmResult.reason || '未进入官方 12 小时续期窗口';
      runOutcome = 'skip';
      runOutcomeLabel = '未进入 12h 续期窗口';
      pushStep(`判定结果: ${skipLabel}`);
      log(`无需续期（官方窗口未开）: ${skipLabel}（耗时 ${durationText()}）`);
      persistRenewalRecord(buildRenewalRecord({
        success: true,
        skipped: true,
        serverName: renewalData.vpsInfo?.serverName,
        plan: renewalData.vpsInfo?.plan,
        oldExpireDate: renewalData.vpsInfo?.expireDate,
        errorMessage: skipLabel,
      }));

      const nextRunStr = resolveNextRun();
      const executedAt = formatTokyoDateTime();
      await notify(buildSkipNotifyMessage({
        reasonCode: 'window_blocked',
        serverName: renewalData.vpsInfo?.serverName,
        plan: renewalData.vpsInfo?.plan,
        expireDate: renewalData.vpsInfo?.expireDate,
        remainingHours: renewalData.remainingHours,
        reasonDetail: skipLabel,
        executedAt,
        nextRunAt: nextRunStr,
        maxHours: FREE_VPS_MAX_HOURS,
        windowHours: RENEWAL_WINDOW_HOURS,
        processSteps,
        detail: CONFIG.TG_NOTIFY_DETAIL,
        durationMs: elapsedMs(),
      }), { kind: 'skip' });
      await page.close();
      return;
    }

    // 步骤 4-6：验证码 + Turnstile + 提交（传入 renewUrl 供失败重试回到 index?id_vps）
    pushStep('识别验证码并求解 Turnstile，提交续期');
    const captchaMeta = await handleCaptchaPage(page, { renewUrl: renewalData.renewUrl }) || {
      turnstileProvider: null,
      turnstileAttempts: [],
    };
    if (captchaMeta.turnstileProvider) {
      const providerLabel = resolveTurnstileProviderLabel(captchaMeta.turnstileProvider)
        || captchaMeta.turnstileProvider;
      const failedBefore = (captchaMeta.turnstileAttempts || [])
        .filter((a) => a && a.success === false)
        .map((a) => resolveTurnstileProviderLabel(a.provider) || a.provider)
        .filter(Boolean);
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
    const pageDateSource = await page.evaluate(() => {
      const allTds = Array.from(document.querySelectorAll('td'));
      const expireTd = allTds.find((td) =>
        td.textContent.includes('更新後の利用期限') || td.textContent.includes('更新后的利用期限'),
      );
      if (expireTd && expireTd.nextElementSibling) {
        return expireTd.nextElementSibling.textContent.trim();
      }
      return document.body.textContent || '';
    });
    const newExpireDate = extractExpireDateFromText(pageDateSource);

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
    }), { kind: 'success' });
    await page.close();
  } catch (e) {
    const failureClass = classifyRenewalFailure({
      errorMessage: e.message,
      errorCode: e?.code,
    });
    runOutcome = 'failure';
    runOutcomeLabel = failureClass.label;
    err(
      `流程异常终止 [${failureClass.label}]: ${e.message}（耗时 ${durationText()}）`,
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
    const { consecutiveFailures } = getRenewalStatus(RENEWAL_STATUS_FILE, ALERT_AFTER_CONSECUTIVE_FAILURES);
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

    const turnstileAllProvidersFailed = isTurnstileAllProvidersFailed({
      errorMessage: e.message,
      errorCode: e?.code,
    });
    const failedProviders = Array.isArray(e?.providerNames)
      ? e.providerNames
      : (Array.isArray(e?.attempts)
        ? e.attempts.map((a) => a.provider).filter(Boolean)
        : []);

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
      failureCategory: failureClass.category,
    }), { kind: 'failure' });
    process.exitCode = 1;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch { /* 忽略 */ }
    }
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

// 仅在直接执行时运行 main()，支持 import 测试
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`未捕获异常: ${e.message}`);
    process.exitCode = 1;
  });
}

export {
  escapeHtml,
  findChromePath,
  cleanChromeLocks,
  getTurnstileToken,
  HAS_PROXY,
  CONFIG,
  DEFAULT_UA,
  maskProxyAddress,
  getTokyoDateString,
  validateRequiredConfig,
  persistRenewalRecord,
  parsePositiveInt,
  isRenewalDue,
  buildRenewUrl,
  evaluateSubmissionResult,
  detectRenewalWindowBlocked,
  extractExpireDateFromText,
  resolveCaptchaRetryUrl,
  resolveCaptchaRetryNavigation,
  needsUserAgentAlignment,
  shouldSubmitAfterTurnstile,
  buildSuccessNotifyMessage,
  buildSkipNotifyMessage,
  buildFailureNotifyMessage,
  buildProxyHint,
  parseNotifyDetail,
  formatTokyoDateTime,
  formatDurationMs,
  clampTelegramMessage,
  resolveTurnstileProviderLabel,
  classifyRenewalFailure,
  parseLogLevel,
  parseEnvBool,
  listTurnstileProviders,
  isTurnstileAllProvidersFailed,
};
