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
 *   CAPTCHA_API        - 验证码识别API地址（可选，有默认公共端点）
 *   CAPSOLVER_API_KEY  - CapSolver API 密钥（Turnstile 求解，与 2Captcha 二选一）
 *   TWOCAPTCHA_API_KEY - 2Captcha API 密钥（Turnstile 求解备选）
 *   CHROME_PATH        - Chrome 可执行文件路径（默认自动检测）
 *   CHROME_USER_DATA   - Chrome 用户数据目录（默认 /data/chrome-profile）
 *   TG_BOT_TOKEN       - Telegram Bot Token（可选，启用通知）
 *   TG_CHAT_ID         - Telegram Chat ID（可选，启用通知）
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
  getTurnstileProvider as _getTurnstileProvider,
  extractTurnstileParams as _extractTurnstileParams,
  solveTurnstileViaAPI as _solveTurnstileViaAPI,
  injectTurnstileToken as _injectTurnstileToken,
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
} from './src/utils.mjs';
import {
  isRenewalDue,
  buildRenewUrl,
  resolveCaptchaRetryUrl,
  evaluateSubmissionResult,
  extractExpireDateFromText,
  normalizeCellText,
  escapeHtml as _escapeHtml,
  formatTokyoDateTime,
  buildSuccessNotifyMessage,
  buildFailureNotifyMessage,
  buildProxyHint,
  RENEWAL_WINDOW_HOURS,
  FREE_VPS_MAX_HOURS,
  resolveNextRunAt,
  DEFAULT_NEXT_RUN_INTERVAL_HOURS,
} from './src/renewal-logic.mjs';

/** 默认 Keras 验证码识别 API（Cloud Run，可被 CAPTCHA_API 覆盖） */
const DEFAULT_CAPTCHA_API = 'https://captcha-120546510085.asia-northeast1.run.app';

// ============================================================
// 模块函数包装层（桥接模块函数与主脚本的 log/CONFIG 依赖）
// ============================================================

/** 验证码识别包装（注入 CONFIG 和 log） */
async function recognizeCaptcha(imgSrc) {
  return _recognizeCaptcha(imgSrc, CONFIG.CAPTCHA_API, log);
}

/** Turnstile 服务商选择包装（注入 CONFIG） */
function getTurnstileProvider() {
  return _getTurnstileProvider(CONFIG);
}

/** Turnstile 参数提取包装（注入 log） */
async function extractTurnstileParams(page) {
  return _extractTurnstileParams(page, log);
}

/** Turnstile API 求解包装（注入 CONFIG 和 log） */
async function solveTurnstileViaAPI(websiteURL, params) {
  return _solveTurnstileViaAPI(websiteURL, params, CONFIG, log, CONFIG.TURNSTILE_API_TIMEOUT);
}

/** Turnstile token 注入包装（注入 log） */
async function injectTurnstileToken(page, token) {
  return _injectTurnstileToken(page, token, log);
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

  // Turnstile API 求解（CapSolver 优先，2Captcha 备选）
  CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY || '',
  TWOCAPTCHA_API_KEY: process.env.TWOCAPTCHA_API_KEY || '',  // 仅用于 Turnstile 求解

  // 住宅代理（可选，用于 2Captcha TurnstileTask 带代理求解）
  PROXY_TYPE: process.env.PROXY_TYPE || '',           // http | socks4 | socks5
  PROXY_ADDRESS: process.env.PROXY_ADDRESS || '',     // IP 或域名
  PROXY_PORT: process.env.PROXY_PORT || '',            // 端口
  PROXY_LOGIN: process.env.PROXY_LOGIN || '',          // 用户名（可选）
  PROXY_PASSWORD: process.env.PROXY_PASSWORD || '',    // 密码（可选）

  // Telegram 通知（可选）
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || '',
  TG_CHAT_ID: process.env.TG_CHAT_ID || '',

  // 容器内 cron（可选）；外部平台调度时也可只设 NOTIFY_NEXT_RUN_HOURS
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '',
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

const log = (msg) => console.log(`${ts()} ${msg}`);
const err = (msg) => console.error(`${ts()} ❌ ${msg}`);

/** 转义 HTML 特殊字符，避免 Telegram parse_mode=HTML 解析失败 */
function escapeHtml(str) {
  return _escapeHtml(str);
}

// ============================================================
// Telegram 通知
// ============================================================

async function notify(message) {
  if (!CONFIG.TG_BOT_TOKEN || !CONFIG.TG_CHAT_ID) return;

  const url = `https://api.telegram.org/bot${CONFIG.TG_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.TG_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    }, 10_000);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      err(`Telegram 通知发送失败: ${res.status} ${body}`);
      return;
    }

    log('Telegram 通知已发送。');
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

async function handleLogin(page) {
  log('正在导航到登录页面...');
  await page.goto(`${CONFIG.BASE_URL}${CONFIG.LOGIN_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.NAVIGATION_TIMEOUT,
  });

  // 若已登录（被重定向到面板），直接返回
  if (page.url().includes('/xvps/index')) {
    log('Cookie 有效，已处于登录状态。');
    return;
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
}

// ============================================================
// 步骤 2：检查是否需要续期
// ============================================================

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
  log(`今天日期（东京时区）: ${today}`);
  log(`明天日期（东京时区）: ${tomorrow}`);

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
    return null;
  }

  // 清理 VPS 信息中的多余空白符
  const cleanServerName = normalizeCellText(result.serverName);
  const cleanPlan = normalizeCellText(result.plan);

  log(`VPS 到期日期: ${result.expireDate ?? '未找到'}`);
  log(`VPS 服务器名: ${cleanServerName ?? '未找到'}`);
  log(`VPS 规格: ${cleanPlan ?? '未找到'}`);

  // 官方规则：4GB 最长 FREE_VPS_MAX_HOURS 小时，剩余 ≤ RENEWAL_WINDOW_HOURS 小时可续期
  if (!isRenewalDue(result.expireDate, today, tomorrow)) {
    log(
      `无需续期（到期: ${result.expireDate}；规则: 最长 ${FREE_VPS_MAX_HOURS}h / 剩余≤${RENEWAL_WINDOW_HOURS}h 可续；` +
        `今天 ${today} / 明天 ${tomorrow}）。`,
    );
    return null;
  }

  const renewUrl = buildRenewUrl(result.detailHref, CONFIG.BASE_URL);
  log(`需要续期！URL: ${renewUrl}`);

  // 返回续期 URL 和 VPS 信息
  return {
    renewUrl,
    vpsInfo: {
      serverName: cleanServerName,
      plan: cleanPlan,
      expireDate: result.expireDate,
    }
  };
}

// ============================================================
// 步骤 3：续期申请确认
// ============================================================

async function handleRenewalConfirm(page, renewUrl) {
  log('正在导航到续期申请页面...');
  await page.goto(renewUrl, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.NAVIGATION_TIMEOUT,
  });

  const extendBtn = await page.$('[formaction="/xapanel/xvps/server/freevps/extend/conf"]');
  if (!extendBtn) throw new Error('未找到续期确认按钮。');

  log('正在点击续期确认...');
  await Promise.all([waitForNav(page), extendBtn.click()]);

  log(`已进入验证码页面: ${page.url()}`);
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
    log('尝试点击 Turnstile checkbox...');
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

          log(`Turnstile iframe: (${box.x.toFixed(0)},${box.y.toFixed(0)}) ` +
            `${box.width.toFixed(0)}x${box.height.toFixed(0)}`);
          log(`鼠标轨迹: (${startX.toFixed(0)},${startY.toFixed(0)}) → (${clickX.toFixed(0)},${clickY.toFixed(0)})`);

          // 移动鼠标到起始位置
          await page.mouse.move(startX, startY);
          await sleep(200 + Math.random() * 300);

          // 模拟人类鼠标移动轨迹
          await humanMouseMove(page, startX, startY, clickX, clickY);

          // 短暂停留（人类反应时间）
          await sleep(50 + Math.random() * 150);

          // 点击
          await page.mouse.click(clickX, clickY);
          log('Turnstile checkbox 已点击');
          return true;
        }
      }
    }

    log('未找到 Turnstile iframe，点击失败');
    return false;
  } catch (e) {
    err(`点击异常: ${e.message}`);
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

async function waitForTurnstile(page) {
  log('正在处理 Cloudflare Turnstile...');

  const cfContainer = await page.$('.cf-turnstile');
  if (!cfContainer) {
    log('页面无 Turnstile 组件，跳过。');
    return true;
  }

  // 🆕 调试：输出 Turnstile 配置信息
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
    log(`📊 Turnstile 配置: sitekey=${turnstileConfig.sitekey}, callback=${turnstileConfig.callback}`);
  }

  // 令牌是否已经存在
  const existingToken = await getTurnstileToken(page);

  if (existingToken) {
    log('Turnstile 令牌已就绪。');
    return true;
  }

  // 🆕 调试：输出字段数量
  const fieldCount = await page.evaluate(() => {
    return document.querySelectorAll('[name="cf-turnstile-response"]').length;
  }).catch(() => 0);
  log(`📊 检测到 ${fieldCount} 个 cf-turnstile-response 字段`);

  // 等待 Turnstile widget 渲染
  log('等待 Turnstile 渲染...');
  await sleep(3000);

  // 截图诊断：确认 Turnstile 的视觉状态
  try {
    await page.screenshot({ path: '/tmp/turnstile-before-solve.png', fullPage: false });
    log('已保存求解前截图: /tmp/turnstile-before-solve.png');
  } catch (e) {
    log(`截图失败: ${e.message}`);
  }

  // ========== Turnstile 验证：直接使用 API 求解 ==========
  // 🔧 优化说明：
  // - 策略 1（点击 checkbox 自然通过）在 Docker 环境成功率极低（<5%），且耗时 8-9 秒
  // - 直接使用策略 2（API 求解），成功率 >90%，耗时 5-7 秒
  // - 总耗时优化：22.9s → 12.1s（-10.8s）
  log('Turnstile 验证: 跳过自然通过方式（Docker 环境成功率低），直接使用 API 求解');

  // ========== API 求解模式 ==========
  const provider = getTurnstileProvider();

  if (provider) {
    log(`正在调用 ${provider.name} API 求解 Turnstile...`);

    // 提取 sitekey 及参数
    const params = await extractTurnstileParams(page);
    if (!params) {
      err('无法提取 Turnstile 参数');
      return false;
    }

    try {
      const currentURL = page.url();
      const result = await solveTurnstileViaAPI(currentURL, params);

      // 如果 API 返回的 UA 与当前不同，更新浏览器 UA 以匹配 token 绑定
      if (result.userAgent) {
        const currentUA = await page.evaluate(() => navigator.userAgent);
        if (currentUA !== result.userAgent) {
          log(`UA 不匹配！当前: ${currentUA.substring(0, 40)}... → API: ${result.userAgent.substring(0, 40)}...`);
          log('更新浏览器 UA 以匹配 API 返回值');
          await page.setUserAgent(result.userAgent);
        } else {
          log('浏览器 UA 与 API 返回值一致，无需更新');
        }
      }

      // 通过 data-callback 属性名查找全局回调函数，传递 token
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
        log(`Turnstile token 已通过 callback 传递: ${callbackResult}`);
      } else {
        log('未找到 Turnstile callback，注入 input 元素...');
      }

      // 注入 token 到 input 元素
      await injectTurnstileToken(page, result.token);

      // 等待页面处理 token
      await sleep(2000);

      // 验证 token 是否生效
      const verifyToken = await getTurnstileToken(page);

      if (verifyToken) {
        log(`Turnstile token 验证成功！token 长度: ${verifyToken.length}`);
      } else {
        log('cf-turnstile-response 元素无值，但 callback 可能已处理 token');
      }

      // 截图诊断
      try {
        await page.screenshot({ path: '/tmp/turnstile-after-solve.png', fullPage: false });
        log('已保存求解后截图: /tmp/turnstile-after-solve.png');
      } catch (e) {
        log(`截图失败: ${e.message}`);
      }

      return true;
    } catch (e) {
      err(`API 求解失败: ${e.message}`);
      return false;
    }
  } else {
    // 无 API 密钥，继续等待点击生效
    log('未配置 API 密钥，继续等待 Turnstile 自行通过...');
    return waitForTurnstileToken(page);
  }
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

async function handleCaptchaPage(page) {
  log('正在处理验证码页面...');

  // 最多重试 3 次（验证码识别错误时刷新重试）
  const maxRetries = CONFIG.CAPTCHA_MAX_RETRY || 3;
  let lastError = null;

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

      // 等待 Turnstile（如果已提前通过，waitForTurnstile 会立即返回 true）
      const turnstilePassed = await waitForTurnstile(page);

      // 提交表单
      log('正在提交表单...');
      if (!turnstilePassed) {
        await page.evaluate(() => {
          const btn = document.querySelector('input[type="submit"], button[type="submit"]');
          if (btn) {
            btn.disabled = false;
            btn.removeAttribute('disabled');
          }
        });
      }

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
        return;
      }

      if (evaluation.status === 'retry') {
        if (attempt < maxRetries) {
          log(`❌ 第 ${attempt} 次尝试失败: ${evaluation.reason}`);
          log(`⏭️ 刷新验证码，准备第 ${attempt + 1} 次尝试...`);
          if (currentUrl.includes('/conf')) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT });
          } else {
            const retryUrl = resolveCaptchaRetryUrl(currentUrl);
            await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT });
          }
          await sleep(1000);
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

      if (attempt < maxRetries) {
        log(`❌ 第 ${attempt} 次尝试失败: ${error.message}`);
        log(`⏭️ 准备第 ${attempt + 1} 次尝试...`);

        try {
          // 尝试刷新/回到验证码确认页
          const currentUrl = page.url();
          if (currentUrl.includes('/conf')) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT });
          } else {
            const retryUrl = resolveCaptchaRetryUrl(currentUrl);
            await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT });
          }
          // 等待足够时间让验证码图片渲染完成（Base64 内嵌图片加载需要时间）
          await sleep(3000);
        } catch (reloadError) {
          log(`⚠️ 页面刷新失败: ${reloadError.message}`);
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
  log('========== Xserver VPS 自动续期开始 ==========');

  const configErrors = validateRequiredConfig(CONFIG);
  if (configErrors.length > 0) {
    throw new Error(`配置校验失败: ${configErrors.join('；')}`);
  }

  if (!CONFIG.CAPSOLVER_API_KEY && !CONFIG.TWOCAPTCHA_API_KEY) {
    log('⚠️ 未配置 CAPSOLVER_API_KEY / TWOCAPTCHA_API_KEY，Turnstile 将依赖自然通过（成功率较低）');
  }

  let browser = null;

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

    // 🆕 注入浏览器指纹补丁（基于真实浏览器调试数据）
    log('注入浏览器指纹补丁...');
    await injectBrowserFingerprint(page);
    log('✅ 浏览器指纹补丁已注入！');

    // 代理需要认证时，通过 page.authenticate 传递凭据
    if (HAS_PROXY && CONFIG.PROXY_LOGIN) {
      await page.authenticate({
        username: CONFIG.PROXY_LOGIN,
        password: CONFIG.PROXY_PASSWORD,
      });
      log('浏览器代理认证已设置');
    }

    // 🔧 优化：使用真实浏览器调试的 UA (Chrome 149)
    await page.setUserAgent(DEFAULT_UA);
    log(`浏览器 UA 已设置: ${DEFAULT_UA.substring(0, 60)}...`);
    page.setDefaultTimeout(CONFIG.NAVIGATION_TIMEOUT);

    // Turnstile 处理策略：不拦截渲染，让 widget 正常显示
    // Xserver 使用 Standalone Turnstile（隐式渲染），Object.defineProperty 会破坏其初始化
    // API 求解只需 sitekey（从 data-sitekey 属性提取），无需拦截 render 调用
    log('Turnstile 策略：正常渲染 + API 求解（不拦截 render）');

    // 步骤 1：登录
    await handleLogin(page);

    // 🆕 验证浏览器指纹是否正确应用（在第一次导航后）
    const fingerprint = await page.evaluate(() => {
      return {
        deviceMemory: navigator.deviceMemory || 'N/A',
        hardwareConcurrency: navigator.hardwareConcurrency || 'N/A',
        platform: navigator.platform,
        language: navigator.language,
        webdriver: navigator.webdriver || false,
      };
    });
    log(`📊 浏览器指纹: deviceMemory=${fingerprint.deviceMemory}GB, hardwareConcurrency=${fingerprint.hardwareConcurrency}, platform=${fingerprint.platform}, webdriver=${fingerprint.webdriver}`);

    // 步骤 2：检查续期
    const renewalData = await checkRenewalNeeded(page);
    if (!renewalData) {
      log('无需续期，流程结束。');
      // 记录跳过，避免「长期无写入」被误判为监控静默
      persistRenewalRecord(buildRenewalRecord({
        success: true,
        skipped: true,
        errorMessage: '无需续期',
      }));
      await page.close();
      return;
    }

    log(`📊 VPS 信息: 服务器名=${renewalData.vpsInfo.serverName}, 规格=${renewalData.vpsInfo.plan}, 原到期日=${renewalData.vpsInfo.expireDate}`);

    // 步骤 3：续期确认
    await handleRenewalConfirm(page, renewalData.renewUrl);

    // 步骤 4-6：验证码 + Turnstile + 提交
    await handleCaptchaPage(page);

    // 提取续期后的到期时间
    log('正在提取续期后的新到期日...');
    log(`📄 当前页面 URL: ${page.url()}`);

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
    } else {
      log(`⚠️ 未能自动提取新到期日，请检查页面结构`);
    }

    log('🎉 续期流程全部完成！');

    // 下次执行：优先从 CRON_SCHEDULE（如 32 */6 * * *）解析间隔，否则用 NOTIFY_NEXT_RUN_HOURS（默认 6h）
    // 外部平台定时启停容器时通常无 CRON_SCHEDULE，依赖默认 6h 或自行配置 NOTIFY_NEXT_RUN_HOURS
    const nextRunStr = resolveNextRunAt(Date.now(), {
      cronSchedule: CONFIG.CRON_SCHEDULE,
      intervalHours: CONFIG.NOTIFY_NEXT_RUN_HOURS,
    });
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
    }));
    await page.close();
  } catch (e) {
    err(`流程异常终止: ${e.message}`);

    // 持久化续期失败记录
    persistRenewalRecord(buildRenewalRecord({
      success: false,
      errorMessage: e.message,
    }));

    // 告警升级：连续失败达到阈值时发送升级告警
    const { consecutiveFailures } = getRenewalStatus(RENEWAL_STATUS_FILE, ALERT_AFTER_CONSECUTIVE_FAILURES);
    const isEscalation = consecutiveFailures >= ALERT_AFTER_CONSECUTIVE_FAILURES;

    const proxyHint = buildProxyHint({
      hasProxy: HAS_PROXY,
      proxyType: CONFIG.PROXY_TYPE,
      maskedAddress: maskProxyAddress(CONFIG.PROXY_ADDRESS),
      proxyPort: CONFIG.PROXY_PORT,
    });

    await notify(buildFailureNotifyMessage({
      errorMessage: e.message,
      consecutiveFailures,
      isEscalation,
      proxyHint,
      captchaMaxRetry: CONFIG.CAPTCHA_MAX_RETRY,
      executedAt: formatTokyoDateTime(),
    }));
    process.exitCode = 1;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch { /* 忽略 */ }
    }
    log('========== 流程结束 ==========');
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
  extractExpireDateFromText,
  resolveCaptchaRetryUrl,
  buildSuccessNotifyMessage,
  buildFailureNotifyMessage,
  buildProxyHint,
  formatTokyoDateTime,
};
