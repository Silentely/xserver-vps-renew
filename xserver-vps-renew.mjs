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
import { execSync } from 'child_process';

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
// 步骤 5：Turnstile 处理（CDP DOM 穿透定位 + xdotool 真实点击）
// ============================================================
// 核心思路：
//   1. 通过 browser.targets() 找到 Turnstile OOPIF target
//   2. 用 CDP DOM.getDocument({pierce:true}) 穿透 closed shadow root
//   3. 递归查找 INPUT[type=checkbox] 获取 nodeId
//   4. 用 DOM.getBoxModel 获取 checkbox 精确坐标
//   5. 通过 xdotool 发送真实 X11 鼠标事件（避免 screenX/screenY 检测）

/**
 * 注入 attachShadow hook 到所有 frame（在 document_start 阶段执行）
 * 这个脚本会在 Turnstile iframe 内运行，拦截 closed shadow DOM，
 * 捕获 checkbox 位置并通过全局变量暴露坐标比例
 */
function getTurnstileHookScript() {
  return `
    (function() {
      // 仅在 Turnstile iframe 内执行
      if (window.top === window.self) return;
      if (!window.location.href.includes('challenges.cloudflare.com')) return;

      // 防止重复注入
      if (window.__turnstileHooked) return;
      window.__turnstileHooked = true;

      // 随机化 MouseEvent 的 screenX/screenY，模拟真实环境
      const screenX = 800 + Math.floor(Math.random() * 400);
      const screenY = 400 + Math.floor(Math.random() * 200);
      try {
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
      } catch(e) {}

      function runHook() {
        try {
          // 通过隐藏 iframe 获取原生 attachShadow，避免被其他 hook 干扰
          let nativeAttachShadow;
          try {
            const tmpFrame = document.createElement('iframe');
            tmpFrame.style.display = 'none';
            document.body.appendChild(tmpFrame);
            nativeAttachShadow = tmpFrame.contentWindow.Element.prototype.attachShadow;
            document.body.removeChild(tmpFrame);
          } catch(e) {
            nativeAttachShadow = Element.prototype.attachShadow;
          }

          if (!nativeAttachShadow) return;

          // Hook attachShadow：拦截所有 shadow root 创建
          Element.prototype.attachShadow = function(...args) {
            const shadowRoot = nativeAttachShadow.apply(this, args);
            if (shadowRoot) {
              // 立即检查是否已有 checkbox
              const existing = shadowRoot.querySelector('input[type="checkbox"]');
              if (existing) {
                window.__turnstileCheckbox = existing;
              } else {
                // 用 MutationObserver 等待 checkbox 出现
                const obs = new MutationObserver((_, o) => {
                  const cb = shadowRoot.querySelector('input[type="checkbox"]');
                  if (cb) {
                    window.__turnstileCheckbox = cb;
                    o.disconnect();
                  }
                });
                obs.observe(shadowRoot, { childList: true, subtree: true });
              }
            }
            return shadowRoot;
          };
        } catch(e) {}
      }

      // 确保 body 存在后再执行 hook
      if (document.body) {
        runHook();
      } else {
        const obs = new MutationObserver(() => {
          if (document.body) { runHook(); obs.disconnect(); }
        });
        obs.observe(document.documentElement, { childList: true });
      }

      // 轮询检测 checkbox 并计算坐标比例，存入全局变量
      (function pollCheckbox() {
        if (window.__turnstileCheckbox) {
          const cb = window.__turnstileCheckbox;
          const rect = cb.getBoundingClientRect();
          const w = window.innerWidth;
          const h = window.innerHeight;
          if (w > 0 && h > 0 && rect.width > 0) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            window.__checkboxRatio = { x: cx / w, y: cy / h };
          }
          try { delete window.__turnstileCheckbox; } catch(e) {}
        } else {
          setTimeout(pollCheckbox, 200);
        }
      })();
    })();
  `;
}

/**
 * 通过 CDP 在 Turnstile iframe 的执行上下文中注入 attachShadow hook，
 * 获取 checkbox 的精确坐标比例，然后结合 iframe 绝对位置进行点击
 */
async function clickTurnstileWithCDP(page) {
  const client = await page.createCDPSession();

  try {
    await client.send('DOM.enable');
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    // 用 getFlattenedDocument 穿透所有 shadow DOM 和 iframe
    const { nodes } = await client.send('DOM.getFlattenedDocument', {
      depth: -1,
      pierce: true,
    });

    // 查找 Turnstile iframe 节点
    const iframeNode = nodes.find((n) => {
      if (n.nodeName !== 'IFRAME') return false;
      const attrs = n.attributes || [];
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === 'src' && attrs[i + 1].includes('challenges.cloudflare.com')) {
          return true;
        }
      }
      return false;
    });

    if (!iframeNode) {
      const allIframes = nodes.filter((n) => n.nodeName === 'IFRAME');
      const iframeSrcs = allIframes.map((n) => {
        const attrs = n.attributes || [];
        for (let i = 0; i < attrs.length; i += 2) {
          if (attrs[i] === 'src') return attrs[i + 1];
        }
        return '(无src)';
      });
      log(`CDP 穿透扫描完成，共 ${nodes.length} 个节点，${allIframes.length} 个 iframe: ${iframeSrcs.join(' | ')}`);
      return false;
    }

    log(`CDP 找到 Turnstile iframe (nodeId: ${iframeNode.nodeId})`);

    // 获取 iframe 的精确位置
    const { model } = await client.send('DOM.getBoxModel', {
      nodeId: iframeNode.nodeId,
    });

    const [x1, y1, , , x2, y2] = model.content;
    const iframeWidth = x2 - x1;
    const iframeHeight = y2 - y1;

    log(`Turnstile iframe 位置: (${x1},${y1}) 尺寸: ${iframeWidth}x${iframeHeight}`);

    // 获取页面滚动偏移量，修正坐标
    const scrollInfo = await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ scrollX: window.scrollX, scrollY: window.scrollY, innerW: window.innerWidth, innerH: window.innerHeight })',
      returnByValue: true,
    });
    const scroll = JSON.parse(scrollInfo.result.value);
    log(`页面滚动: scrollY=${scroll.scrollY}, 视口: ${scroll.innerW}x${scroll.innerH}`);

    // 如果 Turnstile widget 不在可视区域内，先滚动到它
    if (y1 > scroll.innerH || y1 < 0) {
      log('Turnstile widget 不在可视区域，正在滚动...');
      await client.send('Runtime.evaluate', {
        expression: `window.scrollTo(0, ${Math.max(0, y1 - 300)})`,
      });
      await sleep(500);

      // 重新获取坐标
      const { model: newModel } = await client.send('DOM.getBoxModel', {
        nodeId: iframeNode.nodeId,
      });
      const [nx1, ny1, , , nx2, ny2] = newModel.content;
      log(`滚动后 iframe 位置: (${nx1},${ny1})`);
      // 更新坐标（后续使用 viewport 坐标）
    }

    // ========== 核心：通过 OOPIF Target 进入 Turnstile iframe ==========
    // Turnstile iframe 是跨域的（challenges.cloudflare.com），Chrome 会将其
    // 放入独立进程（OOPIF），主页面的 getFrameTree 看不到它。
    // 需要用 browser.targets() 找到该 target，attach 后在其中执行 JS。

    let xRatio = null;
    let yRatio = null;

    // 方法1：通过 Puppeteer 的 browser.targets() 查找 OOPIF target
    try {
      const browser = page.browser();
      const targets = browser.targets();
      const turnstileTarget = targets.find(
        (t) => t.url().includes('challenges.cloudflare.com')
      );

      if (turnstileTarget) {
        log(`找到 Turnstile OOPIF target: ${turnstileTarget.url().substring(0, 80)}...`);

        // 创建独立的 CDP session 连接到 Turnstile iframe 进程
        const iframeClient = await turnstileTarget.createCDPSession();
        await iframeClient.send('DOM.enable');
        await iframeClient.send('Runtime.enable');

        // ===== 方法1：直接用 CDP DOM API 穿透 closed shadow root 获取 checkbox 坐标 =====
        // CDP DOM.getDocument(pierce:true) 能穿透 closed shadow DOM
        // 这是 Runtime.evaluate (JS) 做不到的！
        try {
          const { root } = await iframeClient.send('DOM.getDocument', {
            depth: -1,
            pierce: true,
          });

          // 递归查找 INPUT[type=checkbox] 节点
          let checkboxNodeId = null;
          function findCheckboxNode(node) {
            if (checkboxNodeId) return;
            if (node.nodeName === 'INPUT') {
              const attrs = node.attributes || [];
              for (let i = 0; i < attrs.length; i += 2) {
                if (attrs[i] === 'type' && attrs[i + 1] === 'checkbox') {
                  checkboxNodeId = node.nodeId;
                  return;
                }
              }
            }
            // 穿透 shadow root
            if (node.shadowRoots) {
              for (const sr of node.shadowRoots) {
                findCheckboxNode(sr);
              }
            }
            // 穿透 contentDocument（嵌套 iframe）
            if (node.contentDocument) {
              findCheckboxNode(node.contentDocument);
            }
            // 遍历子节点
            for (const child of (node.children || [])) {
              findCheckboxNode(child);
            }
          }
          findCheckboxNode(root);

          if (checkboxNodeId) {
            log(`✅ CDP 穿透找到 checkbox nodeId: ${checkboxNodeId}`);

            // 获取 checkbox 在 OOPIF viewport 中的位置
            const { model: cbModel } = await iframeClient.send('DOM.getBoxModel', {
              nodeId: checkboxNodeId,
            });

            const [cbX1, cbY1, , , cbX2, cbY2] = cbModel.content;
            const cbWidth = cbX2 - cbX1;
            const cbHeight = cbY2 - cbY1;
            const cbCenterX = cbX1 + cbWidth / 2;
            const cbCenterY = cbY1 + cbHeight / 2;

            log(`checkbox 在 iframe 内位置: (${cbX1.toFixed(1)},${cbY1.toFixed(1)}) 尺寸: ${cbWidth.toFixed(0)}x${cbHeight.toFixed(0)} 中心: (${cbCenterX.toFixed(1)},${cbCenterY.toFixed(1)})`);

            // 获取 iframe 自身的尺寸来计算比例
            const iframeViewport = await iframeClient.send('Runtime.evaluate', {
              expression: 'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })',
              returnByValue: true,
            });
            const ivp = JSON.parse(iframeViewport.result.value);
            log(`iframe 内部视口: ${ivp.w}x${ivp.h}`);

            if (ivp.w > 0 && ivp.h > 0) {
              xRatio = cbCenterX / ivp.w;
              yRatio = cbCenterY / ivp.h;
              log(`✅ 精确 checkbox 坐标比例: x=${xRatio.toFixed(4)}, y=${yRatio.toFixed(4)}`);
            }
          } else {
            log('CDP DOM 穿透未找到 checkbox INPUT 节点');

            // 输出 DOM 树诊断
            const treeInfo = [];
            function collectNodeInfo(node, depth = 0) {
              const tag = node.nodeName || '';
              const attrs = (node.attributes || []);
              const attrPairs = [];
              for (let i = 0; i < attrs.length; i += 2) {
                attrPairs.push(attrs[i]);
              }
              if (tag !== '#text' && tag !== '#comment') {
                treeInfo.push(`${'  '.repeat(depth)}${tag}${attrPairs.length ? `[${attrPairs.join(',')}]` : ''}`);
              }
              if (node.shadowRoots) {
                for (const sr of node.shadowRoots) {
                  treeInfo.push(`${'  '.repeat(depth + 1)}#shadow-root (${sr.shadowRootType})`);
                  collectNodeInfo(sr, depth + 2);
                }
              }
              if (node.contentDocument) {
                treeInfo.push(`${'  '.repeat(depth + 1)}#document (contentDocument)`);
                collectNodeInfo(node.contentDocument, depth + 2);
              }
              for (const child of (node.children || [])) {
                collectNodeInfo(child, depth + 1);
              }
            }
            collectNodeInfo(root);
            log(`OOPIF DOM 树结构 (${treeInfo.length} 行):\n${treeInfo.slice(0, 40).join('\n')}`);
          }
        } catch (e) {
          log(`CDP DOM 穿透查找失败: ${e.message}`);
        }

        await iframeClient.detach().catch(() => {});
      } else {
        // 列出所有 targets 供诊断
        const targetInfo = targets.map((t) => `${t.type()}:${t.url().substring(0, 60)}`).join(' | ');
        log(`未找到 Turnstile OOPIF target。所有 targets: ${targetInfo}`);
      }
    } catch (e) {
      log(`OOPIF 方式查找失败: ${e.message}`);
    }

    // 降级：使用标准 checkbox 坐标
    if (xRatio === null || yRatio === null) {
      xRatio = 0.085 + Math.random() * 0.02;
      yRatio = 0.45 + Math.random() * 0.10;
      log(`降级使用标准 checkbox 坐标比例: x=${xRatio.toFixed(3)}, y=${yRatio.toFixed(3)}`);
    }

    // 重新获取最新的 iframe 位置（滚动可能已改变）
    let finalX1 = x1;
    let finalY1 = y1;
    let finalWidth = iframeWidth;
    let finalHeight = iframeHeight;

    try {
      const { model: freshModel } = await client.send('DOM.getBoxModel', {
        nodeId: iframeNode.nodeId,
      });
      [finalX1, finalY1, , , ] = freshModel.content;
      const freshX2 = freshModel.content[4];
      const freshY2 = freshModel.content[5];
      finalWidth = freshX2 - finalX1;
      finalHeight = freshY2 - finalY1;
    } catch (e) {
      log(`重新获取 iframe 位置失败: ${e.message}`);
    }

    // DOM.getBoxModel 返回的是视口坐标（CSS pixels relative to viewport）
    // xdotool 需要屏幕坐标，需加上 Chrome 窗口位置和标题栏偏移
    let windowOffsetX = 0;
    let windowOffsetY = 0;
    let chromeWindowId = null;
    try {
      // 查找 Chrome 窗口 ID 并聚焦
      const winIdOutput = execSync('DISPLAY=:99 xdotool search --onlyvisible --name "." | head -1', { timeout: 3000, encoding: 'utf-8' }).trim();
      if (winIdOutput) {
        chromeWindowId = winIdOutput;
        log(`找到 Chrome 窗口 ID: ${chromeWindowId}`);
        execSync(`DISPLAY=:99 xdotool windowactivate --sync ${chromeWindowId}`, { timeout: 3000 });
        execSync(`DISPLAY=:99 xdotool windowfocus --sync ${chromeWindowId}`, { timeout: 3000 });
        log('Chrome 窗口已聚焦');
      } else {
        log('未找到 Chrome 窗口 ID，将尝试直接点击');
      }
    } catch (e) {
      log(`窗口聚焦失败: ${e.message}`);
    }

    try {
      const winInfo = await client.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ screenX: window.screenX, screenY: window.screenY, outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight })',
        returnByValue: true,
      });
      const win = JSON.parse(winInfo.result.value);
      // Chrome 窗口在屏幕上的位置 + 标题栏/工具栏高度
      // fluxbox [Deco] {NONE} 配置下标题栏高度为0，viewport 坐标 ≈ 屏幕坐标
      const titleBarHeight = Math.max(0, win.outerH - win.innerH);
      // screenY 可能为负（窗口超出屏幕顶部），取 max(0) 保护
      windowOffsetX = Math.max(0, win.screenX);
      windowOffsetY = Math.max(0, win.screenY) + titleBarHeight;
      log(`Chrome 窗口偏移: screenX=${win.screenX}, screenY=${win.screenY}, 标题栏高度=${titleBarHeight}, 最终偏移: (${windowOffsetX}, ${windowOffsetY})`);
    } catch (e) {
      log(`获取窗口偏移失败，假设无偏移: ${e.message}`);
    }

    const clickX = finalX1 + finalWidth * xRatio + windowOffsetX;
    const clickY = finalY1 + finalHeight * yRatio + windowOffsetY;

    log(`精确点击坐标: (${clickX.toFixed(1)}, ${clickY.toFixed(1)}) [iframe: (${finalX1.toFixed(0)},${finalY1.toFixed(0)}) ${finalWidth}x${finalHeight}]`);

    // 使用 xdotool 发送真实 X11 鼠标事件
    // CDP Input.dispatchMouseEvent 的 screenX/screenY 相对于 iframe（<100），
    // 会被 Cloudflare Turnstile 检测为自动化行为。
    // xdotool 产生真正的 X11 事件，screenX/screenY 是屏幕绝对坐标（几百以上），不会触发检测。
    const intX = Math.round(clickX);
    const intY = Math.round(clickY);

    // 模拟人类鼠标移动轨迹（从随机位置出发，贝塞尔曲线移动）
    const startX = intX - 80 - Math.floor(Math.random() * 150);
    const startY = intY - 40 - Math.floor(Math.random() * 80);
    const steps = 8 + Math.floor(Math.random() * 8);

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const easeT = t * t * (3 - 2 * t); // smoothstep
      const curX = Math.round(startX + (intX - startX) * easeT + (Math.random() - 0.5) * 4);
      const curY = Math.round(startY + (intY - startY) * easeT + (Math.random() - 0.5) * 4);
      try {
        execSync(`DISPLAY=:99 xdotool mousemove --sync ${curX} ${curY}`, { timeout: 2000 });
      } catch (_) { /* 忽略移动错误 */ }
      await sleep(10 + Math.random() * 25);
    }

    // 最终精确移动到目标
    execSync(`DISPLAY=:99 xdotool mousemove --sync ${intX} ${intY}`, { timeout: 2000 });
    await sleep(80 + Math.random() * 120);

    // 真实鼠标点击
    execSync(`DISPLAY=:99 xdotool click 1`, { timeout: 2000 });

    log('xdotool 真实鼠标点击已完成！');
    return true;
  } catch (e) {
    err(`CDP 点击异常: ${e.message}`);
    return false;
  } finally {
    await client.detach().catch(() => {});
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

  // 等待 Turnstile widget 渲染和 iframe 加载
  log('等待 Turnstile 渲染...');
  await sleep(5000);

  // 截图诊断：确认 Turnstile 的视觉状态
  try {
    await page.screenshot({ path: '/tmp/turnstile-before-click.png', fullPage: false });
    log('已保存点击前截图: /tmp/turnstile-before-click.png');
  } catch (e) {
    log(`截图失败: ${e.message}`);
  }

  // 先用 CDP 穿透扫描尝试点击
  log('尝试 CDP 穿透点击...');
  const clicked = await clickTurnstileWithCDP(page);
  if (clicked) {
    log('CDP 穿透点击完成，等待令牌生成...');

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

    // 每 8 秒重试 CDP 点击一次
    const elapsed = Date.now() - startTime;
    if (elapsed > 8000 && elapsed % 8000 < 1000) {
      log(`令牌未生成，第 ${Math.floor(elapsed / 8000)} 次重试 CDP 点击...`);
      await clickTurnstileWithCDP(page);
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

    // 注入 Turnstile attachShadow hook（在所有 frame 的 document_start 阶段执行）
    await page.evaluateOnNewDocument(getTurnstileHookScript());
    log('Turnstile attachShadow hook 已注入。');

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
