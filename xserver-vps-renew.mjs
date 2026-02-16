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
 *   CAPTCHA_API        - 验证码识别API地址
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
import { setTimeout as sleep } from 'timers/promises';
import { existsSync, rmSync } from 'fs';

// 使用 rebrowser-puppeteer-core 替代原生 puppeteer-core
// rebrowser-patches 修复了 Runtime.Enable 泄露检测，避免被 Cloudflare Turnstile 识别为自动化浏览器
const puppeteer = addExtra(rebrowserPuppeteer);
puppeteer.use(StealthPlugin());

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  MEMBER_ID: process.env.XSERVER_MEMBER_ID || '',
  PASSWORD: process.env.XSERVER_PASSWORD || '',
  CAPTCHA_API: process.env.CAPTCHA_API || 'https://captcha-120546510085.asia-northeast1.run.app',

  BASE_URL: 'https://secure.xserver.ne.jp',
  LOGIN_PATH: '/xapanel/login/xvps/',

  NAVIGATION_TIMEOUT: 30_000,
  TURNSTILE_TIMEOUT: 60_000,
  TURNSTILE_API_TIMEOUT: 120_000, // Turnstile API 求解超时（轮询上限）
  CAPTCHA_MAX_RETRY: 3,

  CHROME_PATH: process.env.CHROME_PATH || findChromePath(),
  CHROME_USER_DATA: process.env.CHROME_USER_DATA || '/data/chrome-profile',

  // Turnstile API 求解（CapSolver 或 2Captcha，优先 CapSolver）
  CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY || '',
  TWOCAPTCHA_API_KEY: process.env.TWOCAPTCHA_API_KEY || '',

  // Telegram 通知（可选）
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || '',
  TG_CHAT_ID: process.env.TG_CHAT_ID || '',
};

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
// ============================================================

const ts = () => new Date().toISOString();
const log = (msg) => console.log(`[VPS续期] ${ts()} ${msg}`);
const err = (msg) => console.error(`[VPS续期] ${ts()} ❌ ${msg}`);

/** 转义 HTML 特殊字符，避免 Telegram parse_mode=HTML 解析失败 */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
// 工具函数
// ============================================================

/** 等待导航完成 */
async function waitForNav(page, timeout = CONFIG.NAVIGATION_TIMEOUT) {
  return page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }).catch(() => {});
}

/** 获取元素文本 */
async function getText(page, selector) {
  const el = await page.$(selector);
  if (!el) return null;
  return page.evaluate((e) => e.textContent.trim(), el);
}

/** 清理 Chrome 锁文件 */
function cleanChromeLocks(userDataDir) {
  for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = `${userDataDir}/${lock}`;
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

  // 计算明天的日期（东京时区，yyyy-mm-dd 格式）
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('sv', {
    timeZone: 'Asia/Tokyo',
  });
  log(`明天日期（东京时区）: ${tomorrow}`);

  const result = await page.evaluate(() => {
    const row = document.querySelector('tr:has(.freeServerIco)');
    if (!row) return null;

    const termEl = row.querySelector('.contract__term');
    const detailLink = row.querySelector('a[href^="/xapanel/xvps/server/detail?id="]');

    return {
      expireDate: termEl ? termEl.textContent.trim() : null,
      detailHref: detailLink ? detailLink.href : null,
    };
  });

  if (!result) {
    log('未找到免费 VPS 条目。');
    return null;
  }

  log(`VPS 到期日期: ${result.expireDate ?? '未找到'}`);

  if (result.expireDate !== tomorrow) {
    log(`无需续期（到期日 ${result.expireDate} ≠ 明天 ${tomorrow}）。`);
    return null;
  }

  if (!result.detailHref) {
    throw new Error('检测到需续期但未找到续期链接。');
  }

  const renewUrl = result.detailHref.replace('detail?id', 'freevps/extend/index?id_vps');
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
  await Promise.all([waitForNav(page), extendBtn.click()]);

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
// 步骤 5：Turnstile 处理（CapSolver / 2Captcha API 令牌求解）
// ============================================================
// 核心思路：
//   1. 从页面 .cf-turnstile[data-sitekey] 提取 Turnstile sitekey
//   2. 调用 CapSolver 或 2Captcha API 的 createTask 创建求解任务
//   3. 轮询 getTaskResult 获取 token
//   4. 将 token 注入到 input[name="cf-turnstile-response"] 并触发回调
//   5. 无 API 密钥时降级为简单点击尝试

/**
 * 获取 Turnstile 求解服务商配置
 * 优先使用 CapSolver，备选 2Captcha，均无密钥则返回 null
 */
function getTurnstileProvider() {
  if (CONFIG.CAPSOLVER_API_KEY) {
    return {
      name: 'CapSolver',
      apiBase: 'https://api.capsolver.com',
      clientKey: CONFIG.CAPSOLVER_API_KEY,
      taskType: 'AntiTurnstileTaskProxyLess',
    };
  }
  if (CONFIG.TWOCAPTCHA_API_KEY) {
    return {
      name: '2Captcha',
      apiBase: 'https://api.2captcha.com',
      clientKey: CONFIG.TWOCAPTCHA_API_KEY,
      taskType: 'TurnstileTaskProxyless',
    };
  }
  return null;
}

/**
 * 从页面提取 Turnstile sitekey
 * 策略：优先读取 .cf-turnstile[data-sitekey]，降级正则匹配页面源码
 */
async function extractTurnstileSitekey(page) {
  // 方法 1：直接读取 data-sitekey 属性
  const sitekey = await page.evaluate(() => {
    const el = document.querySelector('.cf-turnstile[data-sitekey]');
    return el ? el.getAttribute('data-sitekey') : null;
  });

  if (sitekey) {
    log(`Turnstile sitekey 提取成功（data-sitekey）: ${sitekey}`);
    return sitekey;
  }

  // 方法 2：正则匹配页面 HTML 源码中的 sitekey
  const html = await page.content();
  const match = html.match(/data-sitekey=["']([0-9a-zA-Z_-]+)["']/);
  if (match) {
    log(`Turnstile sitekey 提取成功（正则匹配）: ${match[1]}`);
    return match[1];
  }

  // 方法 3：匹配 turnstile.render 调用中的 sitekey 参数
  const renderMatch = html.match(/sitekey\s*[:=]\s*["']([0-9a-zA-Z_-]+)["']/);
  if (renderMatch) {
    log(`Turnstile sitekey 提取成功（render 参数）: ${renderMatch[1]}`);
    return renderMatch[1];
  }

  return null;
}

/**
 * 通过 CapSolver / 2Captcha API 求解 Turnstile token
 *
 * 流程：createTask → 轮询 getTaskResult → 返回 token
 * 使用原生 fetch()，不引入额外依赖
 */
async function solveTurnstileViaAPI(websiteURL, websiteKey) {
  const provider = getTurnstileProvider();
  if (!provider) throw new Error('未配置 Turnstile 求解 API 密钥');

  log(`使用 ${provider.name} 求解 Turnstile (sitekey=${websiteKey.substring(0, 12)}...)`);

  // 创建求解任务
  const createRes = await fetch(`${provider.apiBase}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: provider.clientKey,
      task: {
        type: provider.taskType,
        websiteURL,
        websiteKey,
      },
    }),
  });

  if (!createRes.ok) {
    throw new Error(`${provider.name} createTask HTTP 错误: ${createRes.status}`);
  }

  const createData = await createRes.json();
  if (createData.errorId && createData.errorId !== 0) {
    throw new Error(`${provider.name} createTask 错误: ${createData.errorDescription || createData.errorCode || JSON.stringify(createData)}`);
  }

  const taskId = createData.taskId;
  if (!taskId) {
    throw new Error(`${provider.name} createTask 未返回 taskId: ${JSON.stringify(createData)}`);
  }

  log(`${provider.name} 任务已创建: taskId=${taskId}`);

  // 轮询获取结果（间隔 3 秒，最多轮询 TURNSTILE_API_TIMEOUT 毫秒）
  const startTime = Date.now();
  const pollInterval = 3000;
  const maxPolls = Math.ceil(CONFIG.TURNSTILE_API_TIMEOUT / pollInterval);

  for (let i = 1; i <= maxPolls; i++) {
    await sleep(pollInterval);

    const elapsed = Date.now() - startTime;
    if (elapsed > CONFIG.TURNSTILE_API_TIMEOUT) {
      throw new Error(`${provider.name} 求解超时（${CONFIG.TURNSTILE_API_TIMEOUT}ms）`);
    }

    const resultRes = await fetch(`${provider.apiBase}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: provider.clientKey,
        taskId,
      }),
    });

    if (!resultRes.ok) {
      log(`${provider.name} getTaskResult HTTP 错误: ${resultRes.status}，继续轮询...`);
      continue;
    }

    const resultData = await resultRes.json();

    if (resultData.errorId && resultData.errorId !== 0) {
      throw new Error(`${provider.name} getTaskResult 错误: ${resultData.errorDescription || resultData.errorCode}`);
    }

    if (resultData.status === 'ready' && resultData.solution) {
      const token = resultData.solution.token;
      if (!token) {
        throw new Error(`${provider.name} 返回 ready 但 solution.token 为空`);
      }
      log(`${provider.name} 求解成功！耗时 ${Date.now() - startTime}ms，token 长度: ${token.length}`);
      return token;
    }

    // 任务仍在处理中
    log(`${provider.name} 轮询中 (${i}/${maxPolls})... 状态: ${resultData.status || 'processing'}`);
  }

  throw new Error(`${provider.name} 轮询次数耗尽，求解失败`);
}

/**
 * 将 Turnstile token 注入页面并触发回调
 *
 * 注入目标：input[name="cf-turnstile-response"] 或同名 textarea
 * 触发回调：通过 window.turnstile API 或 widgetId 调用 callback
 */
async function injectTurnstileToken(page, token) {
  const injected = await page.evaluate((tkn) => {
    // 注入 token 到所有匹配的 input/textarea 元素
    const selectors = [
      'input[name="cf-turnstile-response"]',
      'textarea[name="cf-turnstile-response"]',
      'input[name="g-recaptcha-response"]', // Turnstile reCAPTCHA 兼容模式
    ];

    let injectedCount = 0;
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      els.forEach((el) => {
        el.value = tkn;
        // 触发事件通知表单框架 token 已变更
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        injectedCount++;
      });
    }

    // 尝试调用 Turnstile 回调函数
    let callbackCalled = false;
    try {
      // 方法 1：通过 window.turnstile 获取 widget 的 callback
      if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
        // 检查是否有全局注册的 callback
        const cfDiv = document.querySelector('.cf-turnstile');
        if (cfDiv) {
          const callbackName = cfDiv.getAttribute('data-callback');
          if (callbackName && typeof window[callbackName] === 'function') {
            window[callbackName](tkn);
            callbackCalled = true;
          }
        }
      }
    } catch (_) { /* 忽略回调异常 */ }

    try {
      // 方法 2：检查全局 tsCallback（2Captcha 文档推荐的拦截方式）
      if (!callbackCalled && typeof window.tsCallback === 'function') {
        window.tsCallback(tkn);
        callbackCalled = true;
      }
    } catch (_) { /* 忽略 */ }

    // 方法 3：启用提交按钮（某些表单在 token 注入前禁用提交）
    const submitBtn = document.querySelector('input[type="submit"], button[type="submit"]');
    if (submitBtn && submitBtn.disabled) {
      submitBtn.disabled = false;
      submitBtn.removeAttribute('disabled');
    }

    return { injectedCount, callbackCalled };
  }, token);

  log(`Turnstile token 已注入: ${injected.injectedCount} 个元素, 回调触发: ${injected.callbackCalled}`);
  return injected.injectedCount > 0;
}

/**
 * 简化版点击降级：当无 API 密钥时尝试直接点击 Turnstile checkbox
 * 成功率较低，仅作为最后手段
 */
async function clickTurnstileFallback(page) {
  try {
    log('降级模式：尝试直接点击 Turnstile checkbox...');
    const frames = page.frames();
    const turnstileFrame = frames.find((f) =>
      f.url().includes('challenges.cloudflare.com'),
    );

    if (turnstileFrame) {
      const frameHandle = await turnstileFrame.frameElement();
      if (frameHandle) {
        const box = await frameHandle.boundingBox();
        if (box && box.width > 10 && box.height > 10) {
          const clickX = box.x + 30;
          const clickY = box.y + box.height / 2;
          log(`Turnstile iframe 位置: (${box.x.toFixed(0)},${box.y.toFixed(0)}) ` +
            `${box.width.toFixed(0)}x${box.height.toFixed(0)}, 点击: (${clickX.toFixed(0)},${clickY.toFixed(0)})`);
          await page.mouse.click(clickX, clickY);
          return true;
        }
      }
    }

    log('未找到 Turnstile iframe，降级点击失败');
    return false;
  } catch (e) {
    err(`降级点击异常: ${e.message}`);
    return false;
  }
}

async function waitForTurnstile(page) {
  log('正在处理 Cloudflare Turnstile...');

  const cfContainer = await page.$('.cf-turnstile');
  if (!cfContainer) {
    log('页面无 Turnstile 组件，跳过。');
    return true;
  }

  // 令牌是否已经存在
  const existingToken = await page
    .$eval('[name="cf-turnstile-response"]', (el) => el.value)
    .catch(() => '');

  if (existingToken) {
    log('Turnstile 令牌已就绪。');
    return true;
  }

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

  const provider = getTurnstileProvider();

  if (provider) {
    // ========== API 求解模式 ==========
    log(`Turnstile API 模式：使用 ${provider.name}`);

    // 提取 sitekey
    const sitekey = await extractTurnstileSitekey(page);
    if (!sitekey) {
      err('无法提取 Turnstile sitekey，尝试降级点击模式...');
      await clickTurnstileFallback(page);
      return waitForTurnstileToken(page);
    }

    // 调用 API 求解
    try {
      const currentURL = page.url();
      const token = await solveTurnstileViaAPI(currentURL, sitekey);

      // 注入 token 到页面
      const success = await injectTurnstileToken(page, token);
      if (!success) {
        err('token 注入失败：未找到 cf-turnstile-response 元素');
        return false;
      }

      // 等待一小段时间让页面处理 token
      await sleep(1500);

      // 验证注入是否生效
      const verifyToken = await page
        .$eval('[name="cf-turnstile-response"]', (el) => el.value)
        .catch(() => '');

      if (verifyToken) {
        log(`Turnstile token 注入验证成功！token 长度: ${verifyToken.length}`);

        // 截图诊断：求解后状态
        try {
          await page.screenshot({ path: '/tmp/turnstile-after-solve.png', fullPage: false });
          log('已保存求解后截图: /tmp/turnstile-after-solve.png');
        } catch (e) {
          log(`截图失败: ${e.message}`);
        }

        return true;
      }

      err('token 注入后验证失败：cf-turnstile-response 值为空');
      return false;
    } catch (e) {
      err(`API 求解失败: ${e.message}，尝试降级点击模式...`);
      await clickTurnstileFallback(page);
      return waitForTurnstileToken(page);
    }
  } else {
    // ========== 降级点击模式（无 API 密钥） ==========
    log('未配置 Turnstile API 密钥，使用降级点击模式...');
    await clickTurnstileFallback(page);
    return waitForTurnstileToken(page);
  }
}

/**
 * 轮询等待 Turnstile token 生成（降级模式专用）
 * 用于点击方式后等待 Turnstile 自行生成 token
 */
async function waitForTurnstileToken(page) {
  const startTime = Date.now();
  while (Date.now() - startTime < CONFIG.TURNSTILE_TIMEOUT) {
    const token = await page
      .$eval('[name="cf-turnstile-response"]', (el) => el.value)
      .catch(() => '');

    if (token) {
      log(`Turnstile 令牌已生成！（耗时 ${Date.now() - startTime}ms）`);
      return true;
    }

    // 每 10 秒重试点击一次
    const elapsed = Date.now() - startTime;
    if (elapsed > 10000 && elapsed % 10000 < 1000) {
      log(`令牌未生成，第 ${Math.floor(elapsed / 10000)} 次重试点击...`);
      await clickTurnstileFallback(page);
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

  // 等待验证码图片
  await page.waitForSelector('img[src^="data:image"], img[src^="data:"]', { timeout: 10_000 });
  const imgSrc = await page.$eval('img[src^="data:image"], img[src^="data:"]', (el) => el.src);
  if (!imgSrc) throw new Error('未找到验证码图片。');

  // 识别验证码
  const code = await recognizeCaptcha(imgSrc);

  // 填入验证码（模拟人类输入）
  const captchaInput = await page.$('[placeholder*="上の画像"]');
  if (!captchaInput) throw new Error('未找到验证码输入框。');
  await captchaInput.click();
  await page.type('[placeholder*="上の画像"]', code, { delay: 80 });
  log('验证码已填入输入框。');

  // 等待 Turnstile
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

  // 还停在确认页，说明提交未被服务端接受（token 无效或验证码错误）
  if (currentUrl.includes('/conf')) {
    const hasAuthFail = pageText.includes('認証に失敗');
    const reason = hasAuthFail ? 'Turnstile 认证失败' : '页面未跳转，可能验证码或 token 无效';
    throw new Error(`续期提交失败（${reason}）`);
  }

  // 检查是否有明确错误
  const errorPatterns = ['エラー', '失敗', '不正', 'もう一度'];
  const hasError = errorPatterns.some((pat) => pageText.includes(pat));
  if (hasError) {
    const snippet = pageText.substring(0, 300).replace(/\s+/g, ' ').trim();
    throw new Error(`续期提交后出现错误: ${snippet}`);
  }

  // 检查是否包含成功关键词
  const successPatterns = ['完了', '延長', '更新'];
  const isSuccess = successPatterns.some((pat) => pageText.includes(pat));
  if (isSuccess) {
    log('页面确认续期成功！');
  } else {
    log(`页面未检测到明确的成功标识，请人工确认。URL: ${currentUrl}`);
  }
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

  try {
    // 清理锁文件
    cleanChromeLocks(CONFIG.CHROME_USER_DATA);

    // rebrowser-puppeteer-core + Stealth 插件启动，修复 Runtime.Enable 泄露
    log(`正在启动 Chrome（rebrowser + Stealth 模式）: ${CONFIG.CHROME_PATH}`);
    browser = await puppeteer.launch({
      executablePath: CONFIG.CHROME_PATH,
      userDataDir: CONFIG.CHROME_USER_DATA,
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--window-size=1280,900',
        '--window-position=0,0',
      ],
      defaultViewport: { width: 1280, height: 900 },
    });
    log('Chrome 启动成功（Stealth 模式完整注入）！');

    const page = await browser.newPage();
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
    await notify(
      `✅ <b>Xserver VPS 续期成功</b>\n\n⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' })}\n📋 续期页面: ${escapeHtml(page.url())}`,
    );
    await page.close();
  } catch (e) {
    err(`流程异常终止: ${e.message}`);
    await notify(
      `❌ <b>Xserver VPS 续期失败</b>\n\n⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' })}\n💥 错误: <code>${escapeHtml(e.message)}</code>`,
    );
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

main();
