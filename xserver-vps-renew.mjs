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
  CAPTCHA_MAX_RETRY: 3,

  CHROME_PATH: process.env.CHROME_PATH || findChromePath(),
  CHROME_USER_DATA: process.env.CHROME_USER_DATA || '/data/chrome-profile',

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
// 步骤 5：Turnstile 处理（Chrome 扩展修复 screenX/screenY + page.mouse.click）
// ============================================================
// 核心思路：
//   1. Chrome 扩展（turnstile-patch/）在 MAIN world 修复 MouseEvent.screenX/screenY
//      使 CDP Input.dispatchMouseEvent 产生的鼠标事件携带正确的屏幕坐标
//   2. 通过 page.frames() 枚举找到 challenges.cloudflare.com 的 Turnstile iframe
//   3. 获取 iframe DOM element 的 boundingBox，在 checkbox 区域用 page.mouse.click() 点击
//   4. 降级方案：查找页面中 300x65 左右的 iframe 元素

/**
 * 模拟人类鼠标移动 + 点击（避免直接 click 被 Turnstile 检测为机器行为）
 */
async function humanClick(page, targetX, targetY) {
  // 从随机偏移位置开始移动
  const startX = targetX - 50 + Math.random() * 30;
  const startY = targetY - 20 - Math.random() * 30;
  await page.mouse.move(startX, startY);
  await sleep(80 + Math.random() * 150);
  // 带 steps 的移动模拟人类手部轨迹
  await page.mouse.move(targetX, targetY, { steps: 8 + Math.floor(Math.random() * 8) });
  await sleep(40 + Math.random() * 80);
  // 分离 mousedown/mouseup 模拟真实按压时长
  await page.mouse.down();
  await sleep(30 + Math.random() * 60);
  await page.mouse.up();
}

/**
 * 在主页面层面定位并点击 Turnstile widget
 *
 * Turnstile 的 DOM 结构：
 *   .cf-turnstile → closed shadow root → iframe[src*="challenges.cloudflare.com"]
 * checkbox 位于 iframe 左侧约 30px、垂直居中处
 *
 * 策略优先级：
 *   1. page.frames() 枚举 → 找 challenges.cloudflare.com frame → frameElement boundingBox
 *   2. 主页面查询所有 iframe → 按 src 或尺寸匹配 Turnstile widget
 *   3. 扫描页面中 290-310px 宽的 div（最后降级手段）
 */
async function clickTurnstile(page) {
  try {
    // 方法1：通过 page.frames() 找到 Turnstile iframe 并获取其屏幕位置
    log('方法1：通过 page.frames() 查找 Turnstile iframe...');
    const frames = page.frames();
    const turnstileFrames = frames.filter((f) =>
      f.url().includes('challenges.cloudflare.com'),
    );
    log(`发现 ${turnstileFrames.length} 个 Turnstile frame（共 ${frames.length} 个 frame）`);

    for (const frame of turnstileFrames) {
      try {
        // 获取 iframe 对应的 DOM element（frameElement），再获取其在主页面中的 boundingBox
        const frameHandle = await frame.frameElement();
        if (!frameHandle) continue;

        const box = await frameHandle.boundingBox();
        if (!box || box.width < 10 || box.height < 10) {
          log(`Turnstile iframe boundingBox 无效: ${JSON.stringify(box)}`);
          continue;
        }

        // checkbox 位于 iframe 左侧偏移约 30px、垂直居中
        const clickX = box.x + 30;
        const clickY = box.y + box.height / 2;
        log(`Turnstile iframe 位置: (${box.x.toFixed(0)},${box.y.toFixed(0)}) ` +
          `尺寸: ${box.width.toFixed(0)}x${box.height.toFixed(0)}, ` +
          `点击坐标: (${clickX.toFixed(0)},${clickY.toFixed(0)})`);

        // 诊断：检查扩展是否成功注入 Turnstile iframe（screenX getter 是否被修改）
        try {
          const patchStatus = await frame.evaluate(() => {
            const desc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenX');
            return {
              hasCustomGetter: desc && desc.get && !desc.get.toString().includes('native code'),
              getterSource: desc && desc.get ? desc.get.toString().substring(0, 80) : 'N/A',
            };
          });
          log(`Turnstile iframe 扩展注入状态: customGetter=${patchStatus.hasCustomGetter}, ` +
            `getter=${patchStatus.getterSource}`);
        } catch (e) {
          log(`无法检查 iframe 扩展状态（跨域限制）: ${e.message}`);
        }

        // 模拟人类鼠标移动轨迹：从随机起点移动到目标，再点击
        await humanClick(page, clickX, clickY);
        return true;
      } catch (e) {
        log(`通过 frame.frameElement() 点击失败: ${e.message}`);
      }
    }

    // 方法2：在主页面中查询所有 iframe，按 src 或尺寸特征匹配 Turnstile widget
    log('方法2：查找页面中的 Turnstile iframe 元素...');
    const iframeBoxes = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('iframe').forEach((iframe) => {
        try {
          const src = iframe.src || '';
          const rect = iframe.getBoundingClientRect();
          // Turnstile iframe 特征：src 包含 cloudflare 或尺寸约 300x65
          const isCfSrc = src.includes('challenges.cloudflare.com') || src.includes('turnstile');
          const isCfSize = rect.width > 250 && rect.width <= 350 && rect.height > 50 && rect.height <= 80;
          if (isCfSrc || isCfSize) {
            results.push({
              x: rect.x, y: rect.y, w: rect.width, h: rect.height,
              src: src.substring(0, 80),
              match: isCfSrc ? 'src' : 'size',
            });
          }
        } catch (_) { /* 忽略 */ }
      });
      return results;
    });

    if (iframeBoxes.length > 0) {
      // 优先选择 src 匹配的，其次选尺寸匹配的
      iframeBoxes.sort((a, b) => (a.match === 'src' ? -1 : 1) - (b.match === 'src' ? -1 : 1));
      for (const item of iframeBoxes) {
        const clickX = item.x + 30;
        const clickY = item.y + item.h / 2;
        log(`找到候选 iframe [${item.match}]: (${item.x.toFixed(0)},${item.y.toFixed(0)}) ` +
          `${item.w.toFixed(0)}x${item.h.toFixed(0)} src=${item.src}, ` +
          `点击坐标: (${clickX.toFixed(0)},${clickY.toFixed(0)})`);
        await humanClick(page, clickX, clickY);
        return true;
      }
    }

    // 方法3（最终降级）：扫描主页面 div，寻找 Turnstile widget 壳层特征
    // Turnstile 外层 div 通常是 290-310px 宽、50-80px 高
    log('方法3（降级）：扫描页面 div 定位 Turnstile widget...');
    const divBoxes = await page.evaluate(() => {
      const coords = [];
      document.querySelectorAll('div').forEach((item) => {
        try {
          const rect = item.getBoundingClientRect();
          if (
            rect.width > 290 && rect.width <= 310 &&
            rect.height > 50 && rect.height <= 80
          ) {
            coords.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height });
          }
        } catch (_) { /* 忽略 */ }
      });
      return coords;
    });

    if (divBoxes.length > 0) {
      for (const item of divBoxes) {
        const clickX = item.x + 30;
        const clickY = item.y + item.h / 2;
        log(`降级定位到候选 div: (${item.x.toFixed(0)},${item.y.toFixed(0)}) ` +
          `${item.w.toFixed(0)}x${item.h.toFixed(0)}, 点击坐标: (${clickX.toFixed(0)},${clickY.toFixed(0)})`);
        await humanClick(page, clickX, clickY);
      }
      return true;
    }

    log('未找到 Turnstile widget 可点击区域');
    return false;
  } catch (e) {
    err(`Turnstile 点击异常: ${e.message}`);
    return false;
  }
}

// ============================================================
// screenX/screenY 补丁：通过 CDP 注入到 Turnstile iframe
// ============================================================
// Chrome 扩展（turnstile-patch/）的 content_scripts 无法注入到
// closed shadow root 内动态创建的 iframe 中。
// 改用 Puppeteer frame.evaluate() 直接在 Turnstile iframe 执行修复代码。

/** screenX/screenY 修复脚本（与 turnstile-patch/content.js 相同逻辑） */
const SCREEN_PATCH_SCRIPT = `(() => {
  const origXDesc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenX');
  const origYDesc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenY');
  if (!origXDesc || !origXDesc.get) return;
  const cache = new WeakMap();
  function patched(event) {
    if (cache.has(event)) return cache.get(event);
    const cx = event.clientX || 0, cy = event.clientY || 0;
    const r = {
      screenX: cx + (window.screenX || 0) + Math.floor(Math.random() * 3) - 1,
      screenY: cy + (window.screenY || 0) + Math.floor(Math.random() * 3) - 1,
    };
    cache.set(event, r);
    return r;
  }
  function suspicious(orig, client) { return orig === 0 || orig === client; }
  Object.defineProperties(MouseEvent.prototype, {
    screenX: { configurable: true, enumerable: true,
      get() { const o = origXDesc.get.call(this); return suspicious(o, this.clientX) ? patched(this).screenX : o; }},
    screenY: { configurable: true, enumerable: true,
      get() { const o = origYDesc.get.call(this); return suspicious(o, this.clientY) ? patched(this).screenY : o; }},
  });
})()`;

/**
 * 在所有 Turnstile iframe 中注入 screenX/screenY 修复补丁
 * 同时也注入到主页面和所有子 frame（确保全覆盖）
 */
async function injectScreenPatchToTurnstileFrames(page) {
  const frames = page.frames();
  let injected = 0;

  for (const frame of frames) {
    try {
      // 检查是否已经注入过（避免重复）
      const alreadyPatched = await frame.evaluate(() => {
        const desc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenX');
        return desc && desc.get && !desc.get.toString().includes('native code');
      }).catch(() => false);

      if (alreadyPatched) {
        log(`frame [${frame.url().substring(0, 60)}] 已有补丁，跳过`);
        continue;
      }

      await frame.evaluate(SCREEN_PATCH_SCRIPT);
      injected++;
      const isTurnstile = frame.url().includes('challenges.cloudflare.com');
      log(`已注入 screenX/screenY 补丁到 frame${isTurnstile ? '（Turnstile ✓）' : ''}: ${frame.url().substring(0, 60)}`);
    } catch (e) {
      // 某些 frame 可能无法执行（如 about:blank 或已卸载）
      log(`无法注入补丁到 frame [${frame.url().substring(0, 40)}]: ${e.message}`);
    }
  }

  log(`screenX/screenY 补丁注入完成：${injected}/${frames.length} 个 frame`);
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

  // 等待 Turnstile widget 渲染和 iframe 加载
  log('等待 Turnstile 渲染...');
  await sleep(5000);

  // 关键步骤：通过 CDP 直接在 Turnstile iframe 中注入 screenX/screenY 修复补丁
  // Chrome 扩展无法注入 closed shadow root 内动态创建的 iframe，
  // 但 Puppeteer 的 frame.evaluate() 通过 CDP 绕过同源策略可以直接执行
  await injectScreenPatchToTurnstileFrames(page);

  // 截图诊断：确认 Turnstile 的视觉状态
  try {
    await page.screenshot({ path: '/tmp/turnstile-before-click.png', fullPage: false });
    log('已保存点击前截图: /tmp/turnstile-before-click.png');
  } catch (e) {
    log(`截图失败: ${e.message}`);
  }

  // 用 page.mouse.click() 点击 Turnstile checkbox
  log('尝试点击 Turnstile...');
  const clicked = await clickTurnstile(page);
  if (clicked) {
    log('Turnstile 点击完成，等待令牌生成...');

    // 点击后截图诊断：观察 Turnstile 是否变成 spinner 或 checkmark
    await sleep(2000);
    try {
      await page.screenshot({ path: '/tmp/turnstile-after-click.png', fullPage: false });
      log('已保存点击后截图: /tmp/turnstile-after-click.png');
    } catch (e) {
      log(`点击后截图失败: ${e.message}`);
    }
  }

  // 轮询等待令牌生成
  const startTime = Date.now();
  while (Date.now() - startTime < CONFIG.TURNSTILE_TIMEOUT) {
    const token = await page
      .$eval('[name="cf-turnstile-response"]', (el) => el.value)
      .catch(() => '');

    if (token) {
      log(`Turnstile 令牌已生成！（耗时 ${Date.now() - startTime}ms）`);
      return true;
    }

    // 每 8 秒重试点击一次
    const elapsed = Date.now() - startTime;
    if (elapsed > 8000 && elapsed % 8000 < 1000) {
      log(`令牌未生成，第 ${Math.floor(elapsed / 8000)} 次重试点击...`);
      // 重新注入补丁（Turnstile 可能重新加载 iframe）
      await injectScreenPatchToTurnstileFrames(page);
      await clickTurnstile(page);
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
        // Chrome 扩展：修复 CDP MouseEvent.screenX/screenY 异常（Turnstile 检测绕过）
        '--load-extension=/app/turnstile-patch',
        '--disable-extensions-except=/app/turnstile-patch',
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
