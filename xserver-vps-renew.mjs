#!/usr/bin/env node

/**
 * Xserver VPS 自动续期脚本 - Playwright CDP 版本
 *
 * 通过 CDP 连接真实 Chrome 实例，全自动完成：
 * 登录 → 检查到期 → 续期申请 → 验证码识别 → Turnstile 通过 → 提交
 *
 * 使用方式：
 *   方式A（连接已运行的 Chrome）：
 *     1. 启动 Chrome：google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.config/xserver-chrome
 *     2. node xserver-vps-renew.mjs
 *
 *   方式B（脚本自动启动 Chrome）：
 *     node xserver-vps-renew.mjs --launch
 *
 * 环境变量：
 *   XSERVER_MEMBER_ID  - 会员ID（必填）
 *   XSERVER_PASSWORD   - 密码（必填）
 *   CDP_URL            - Chrome CDP 地址（默认 http://127.0.0.1:9222）
 *   CAPTCHA_API        - 验证码识别API地址
 *   CHROME_PATH        - Chrome 可执行文件路径（--launch 模式）
 *   CHROME_USER_DATA   - Chrome 用户数据目录（--launch 模式）
 *   TG_BOT_TOKEN       - Telegram Bot Token（可选，启用通知）
 *   TG_CHAT_ID         - Telegram Chat ID（可选，启用通知）
 *
 * Cron 示例（每天东京时间 8:00）：
 *   0 23 * * * cd /path/to/scripts && node xserver-vps-renew.mjs --launch >> /var/log/xserver-renew.log 2>&1
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { setTimeout as sleep } from 'timers/promises';

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  CDP_URL: process.env.CDP_URL || 'http://127.0.0.1:9222',
  MEMBER_ID: process.env.XSERVER_MEMBER_ID || '',
  PASSWORD: process.env.XSERVER_PASSWORD || '',
  CAPTCHA_API: process.env.CAPTCHA_API || 'https://captcha-120546510085.asia-northeast1.run.app',

  BASE_URL: 'https://secure.xserver.ne.jp',
  LOGIN_PATH: '/xapanel/login/xvps/',

  NAVIGATION_TIMEOUT: 30_000,
  TURNSTILE_TIMEOUT: 30_000,
  CAPTCHA_MAX_RETRY: 3,

  AUTO_LAUNCH: process.argv.includes('--launch'),
  CHROME_USER_DATA: process.env.CHROME_USER_DATA || '/tmp/xserver-chrome-profile',

  // Telegram 通知（可选）
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || '',
  TG_CHAT_ID: process.env.TG_CHAT_ID || '',
};

// ============================================================
// 日志
// ============================================================

const ts = () => new Date().toISOString();
const log = (msg) => console.log(`[VPS续期] ${ts()} ${msg}`);
const err = (msg) => console.error(`[VPS续期] ${ts()} ❌ ${msg}`);

// ============================================================
// Telegram 通知
// ============================================================

async function notify(message) {
  if (!CONFIG.TG_BOT_TOKEN || !CONFIG.TG_CHAT_ID) return;

  const url = `https://api.telegram.org/bot${CONFIG.TG_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.TG_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      err(`Telegram 通知发送失败: ${res.status} ${body}`);
      return;
    }

    log('Telegram 通知已发送。');
  } catch (e) {
    err(`Telegram 通知异常: ${e.message}`);
  }
}

// ============================================================
// Chrome 启动（--launch 模式）
// ============================================================

function findChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const candidates = [
    // Linux
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('未找到 Chrome，请设置 CHROME_PATH 环境变量。');
  return found;
}

/**
 * 启动 Chrome 进程并返回子进程句柄
 */
function spawnChrome() {
  const bin = findChromePath();
  log(`正在启动 Chrome: ${bin}`);

  const child = spawn(
    bin,
    [
      `--remote-debugging-port=9222`,
      `--user-data-dir=${CONFIG.CHROME_USER_DATA}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // 窗口大小（即使是虚拟显示器也需要）
      '--window-size=1280,900',
    ],
    { stdio: 'ignore', detached: true },
  );

  child.unref();
  return child;
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
  const errorEl = await page.$('.errorMessage');
  if (errorEl) {
    const text = await errorEl.textContent();
    err(`登录页存在错误信息: ${text.trim()}`);
  }

  log('正在填充凭据并提交...');
  await page.fill('#memberid', CONFIG.MEMBER_ID);
  await page.fill('#user_password', CONFIG.PASSWORD);

  // 点击提交并等待导航
  const submitBtn =
    (await page.$('input[name="action_user_login"]')) ??
    (await page.$('#login_area input[type="submit"]'));

  if (submitBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT }),
      submitBtn.click(),
    ]);
  } else {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT }),
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

  // 计算明天的日期（东京时区，yyyy-mm-dd 格式）
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('sv', {
    timeZone: 'Asia/Tokyo',
  });
  log(`明天日期（东京时区）: ${tomorrow}`);

  const row = await page.$('tr:has(.freeServerIco)');
  if (!row) {
    log('未找到免费 VPS 条目。');
    return null;
  }

  const expireDate = await row
    .$eval('.contract__term', (el) => el.textContent.trim())
    .catch(() => null);
  log(`VPS 到期日期: ${expireDate ?? '未找到'}`);

  if (expireDate !== tomorrow) {
    log(`无需续期（到期日 ${expireDate} ≠ 明天 ${tomorrow}）。`);
    return null;
  }

  // 构造续期 URL
  const detailHref = await row
    .$eval('a[href^="/xapanel/xvps/server/detail?id="]', (el) => el.href)
    .catch(() => null);

  if (!detailHref) {
    throw new Error('检测到需续期但未找到续期链接。');
  }

  const renewUrl = detailHref.replace('detail?id', 'freevps/extend/index?id_vps');
  log(`需要续期！URL: ${renewUrl}`);
  return renewUrl;
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
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT }),
    extendBtn.click(),
  ]);

  log(`已进入验证码页面: ${page.url()}`);
}

// ============================================================
// 步骤 4：验证码识别（远程 API）
// ============================================================

async function recognizeCaptcha(imgSrc) {
  for (let attempt = 1; attempt <= CONFIG.CAPTCHA_MAX_RETRY; attempt++) {
    try {
      log(`验证码识别第 ${attempt} 次尝试...`);
      const res = await fetch(CONFIG.CAPTCHA_API, {
        method: 'POST',
        body: imgSrc,
        headers: { 'Content-Type': 'text/plain' },
      });

      if (!res.ok) throw new Error(`API 响应 ${res.status}`);

      const code = (await res.text()).trim();
      if (code && code.length >= 4) {
        log(`验证码识别成功: ${code}`);
        return code;
      }
      throw new Error(`返回无效结果: "${code}"`);
    } catch (e) {
      err(`第 ${attempt} 次识别失败: ${e.message}`);
      if (attempt >= CONFIG.CAPTCHA_MAX_RETRY) throw e;
      await sleep(1000);
    }
  }
}

// ============================================================
// 步骤 5：等待 Cloudflare Turnstile 通过
// ============================================================

async function waitForTurnstile(page) {
  log('正在处理 Cloudflare Turnstile...');

  const cfContainer = await page.$('.cf-turnstile');
  if (!cfContainer) {
    log('页面无 Turnstile 组件，跳过。');
    return;
  }

  // 令牌是否已经存在
  const existingToken = await page
    .$eval('[name="cf-turnstile-response"]', (el) => el.value)
    .catch(() => '');

  if (existingToken) {
    log('Turnstile 令牌已就绪。');
    return;
  }

  // 等待 Turnstile iframe 加载
  log('等待 Turnstile 初始化...');
  await sleep(2000);

  // 尝试与 Turnstile iframe 交互（点击复选框）
  // 这是 Playwright 相比 UserScript 的核心优势：可以操作跨域 iframe
  try {
    const frames = page.frames();
    const cfFrame = frames.find((f) => f.url().includes('challenges.cloudflare.com'));

    if (cfFrame) {
      log('已找到 Turnstile iframe，尝试交互...');

      // Turnstile 复选框可能的选择器
      const checkboxSelectors = [
        'input[type="checkbox"]',
        '.ctp-checkbox-label',
        '#challenge-stage',
      ];

      for (const sel of checkboxSelectors) {
        const el = await cfFrame.$(sel);
        if (el && (await el.isVisible().catch(() => false))) {
          log(`点击 Turnstile 元素: ${sel}`);
          await el.click();
          break;
        }
      }
    }
  } catch (e) {
    log(`Turnstile iframe 交互跳过（非交互模式或已自动通过）: ${e.message}`);
  }

  // 轮询等待令牌生成
  log('等待 Turnstile 令牌生成...');
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[name="cf-turnstile-response"]');
        return el && el.value && el.value.length > 0;
      },
      { timeout: CONFIG.TURNSTILE_TIMEOUT },
    );
    log('Turnstile 令牌已成功生成！');
  } catch {
    err(`Turnstile 等待超时（${CONFIG.TURNSTILE_TIMEOUT}ms），将尝试强制提交。`);
  }
}

// ============================================================
// 步骤 6：验证码页面完整流程（识别 + Turnstile + 提交）
// ============================================================

async function handleCaptchaPage(page) {
  log('正在处理验证码页面...');

  // 等待验证码图片
  const imgSelector = 'img[src^="data:image"], img[src^="data:"]';
  await page.waitForSelector(imgSelector, { timeout: 10_000 });
  const imgSrc = await page.$eval(imgSelector, (el) => el.src);
  if (!imgSrc) throw new Error('未找到验证码图片。');

  // 识别验证码
  const code = await recognizeCaptcha(imgSrc);

  // 填入验证码
  const captchaInput = await page.$('[placeholder*="上の画像"]');
  if (!captchaInput) throw new Error('未找到验证码输入框。');
  await captchaInput.fill(code);
  log('验证码已填入输入框。');

  // 等待 Turnstile
  await waitForTurnstile(page);

  // 提交表单
  log('正在提交表单...');
  const submitBtn = await page.$('input[type="submit"], button[type="submit"]');
  if (!submitBtn) throw new Error('未找到提交按钮。');

  await Promise.all([
    page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT })
      .catch(() => {}),
    submitBtn.click(),
  ]);

  log(`提交完成，当前页面: ${page.url()}`);
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  log('========== Xserver VPS 自动续期开始 ==========');

  if (!CONFIG.MEMBER_ID || !CONFIG.PASSWORD) {
    throw new Error('请设置环境变量 XSERVER_MEMBER_ID 和 XSERVER_PASSWORD。');
  }

  let browser = null;
  let chromeProcess = null;

  try {
    // --launch 模式：由脚本自行启动 Chrome
    if (CONFIG.AUTO_LAUNCH) {
      chromeProcess = spawnChrome();
      log('等待 Chrome 启动...');
      await sleep(4000);
    }

    // 通过 CDP 连接到 Chrome
    log(`正在连接 CDP: ${CONFIG.CDP_URL}`);
    browser = await chromium.connectOverCDP(CONFIG.CDP_URL);
    log('CDP 连接成功！');

    // 获取或创建页面
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.NAVIGATION_TIMEOUT);

    // 步骤 1：登录
    await handleLogin(page);

    // 步骤 2：检查续期
    const renewUrl = await checkRenewalNeeded(page);
    if (!renewUrl) {
      log('无需续期，流程结束。');
      await page.close();
      return;
    }

    // 步骤 3：续期确认
    await handleRenewalConfirm(page, renewUrl);

    // 步骤 4-6：验证码 + Turnstile + 提交
    await handleCaptchaPage(page);

    log('🎉 续期流程全部完成！');
    await notify(`✅ <b>Xserver VPS 续期成功</b>\n\n⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' })}\n📋 续期页面: ${page.url()}`);
    await page.close();
  } catch (e) {
    err(`流程异常终止: ${e.message}`);
    await notify(`❌ <b>Xserver VPS 续期失败</b>\n\n⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' })}\n💥 错误: <code>${e.message}</code>`);
    process.exitCode = 1;
  } finally {
    // 断开 CDP（不关闭浏览器）
    if (browser) {
      try {
        browser.close();
      } catch {
        /* 忽略断开连接错误 */
      }
    }
    // --launch 模式下关闭 Chrome 进程
    if (chromeProcess) {
      log('正在关闭 Chrome 进程...');
      try {
        process.kill(-chromeProcess.pid, 'SIGTERM');
      } catch {
        chromeProcess.kill('SIGTERM');
      }
    }
    log('========== 流程结束 ==========');
  }
}

main();
