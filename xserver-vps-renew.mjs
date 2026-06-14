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
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { injectBrowserFingerprint } from './browser-fingerprint-patch.js';

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

  // 验证码识别服务（OCR）
  GOOGLE_VISION_API_KEY: process.env.GOOGLE_VISION_API_KEY || '',      // Google Cloud Vision API
  OCRSPACE_API_KEY: process.env.OCRSPACE_API_KEY || '',                // OCR.space API Key
  CAPTCHA_API: process.env.CAPTCHA_API || 'https://captcha-120546510085.asia-northeast1.run.app',  // 百度 OCR（保底）

  BASE_URL: 'https://secure.xserver.ne.jp',
  LOGIN_PATH: '/xapanel/login/xvps/',

  NAVIGATION_TIMEOUT: 30_000,
  TURNSTILE_TIMEOUT: 60_000,
  TURNSTILE_API_TIMEOUT: 120_000, // Turnstile API 求解超时（轮询上限）
  CAPTCHA_MAX_RETRY: 3,

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
};

// ============================================================
// 常量
// ============================================================

// 🔧 优化：使用真实浏览器调试发现的 UA (Chrome 149 on macOS)
// 基于 Browser Relay 调试收集的真实指纹数据
const MACOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0';

// 备用：Windows UA (如果需要伪装成 Windows 环境)
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// 默认使用 macOS UA（与调试环境一致）
const DEFAULT_UA = MACOS_UA;

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

  // 计算今天和明天的日期（东京时区，yyyy-mm-dd 格式）
  const today = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' });
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('sv', {
    timeZone: 'Asia/Tokyo',
  });
  log(`今天日期（东京时区）: ${today}`);
  log(`明天日期（东京时区）: ${tomorrow}`);

  const result = await page.evaluate(() => {
    const row = document.querySelector('tr:has(.freeServerIco)');
    if (!row) {
      console.log('❌ 未找到免费 VPS 条目（.freeServerIco）');
      return null;
    }

    console.log('✅ 找到免费 VPS 条目');

    const termEl = row.querySelector('.contract__term');
    const detailLink = row.querySelector('a[href^="/xapanel/xvps/server/detail?id="]');

    // 提取 VPS 规格信息
    const cells = row.querySelectorAll('td');
    console.log(`📊 表格列数: ${cells.length}`);

    let serverName = null;
    let plan = null;

    // 遍历所有单元格，根据内容特征判断
    cells.forEach((cell, idx) => {
      const text = cell.textContent.replace(/\s+/g, ' ').trim(); // 移除多余空白符
      console.log(`  单元格[${idx}]: "${text.substring(0, 80)}"`);

      // 判断规格：包含内存/CPU/存储信息
      if ((text.includes('メモリ') || text.includes('コア') || text.includes('GB') || text.includes('NVMe'))
          && text.length > 10) {
        plan = text;
        console.log(`  → 识别为规格: "${plan}"`);
      }

      // 判断服务器名：包含 host/vps 关键词，且长度较短
      if ((text.includes('host') || text.includes('vps-')) && text.length < 30) {
        serverName = text;
        console.log(`  → 识别为服务器名: "${serverName}"`);
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
  const cleanServerName = result.serverName ? result.serverName.replace(/\s+/g, ' ').trim() : null;
  const cleanPlan = result.plan ? result.plan.replace(/\s+/g, ' ').trim() : null;

  log(`VPS 到期日期: ${result.expireDate ?? '未找到'}`);
  log(`VPS 服务器名: ${cleanServerName ?? '未找到'}`);
  log(`VPS 规格: ${cleanPlan ?? '未找到'}`);

  // 今天或明天到期都需要续期
  const needsRenewal = result.expireDate === today || result.expireDate === tomorrow;
  if (!needsRenewal) {
    log(`无需续期（到期日 ${result.expireDate} 不是今天 ${today} 或明天 ${tomorrow}）。`);
    return null;
  }

  if (!result.detailHref) {
    throw new Error('检测到需续期但未找到续期链接。');
  }

  const renewUrl = result.detailHref.replace('detail?id', 'freevps/extend/index?id_vps');
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
// 步骤 4：验证码识别（2Captcha 人工识别 + 百度 OCR 保底）
// ============================================================

/**
 * 平假名数字映射表（Xserver 验证码使用平假名书写数字）
 */
const HIRAGANA_NUMBER_MAP = {
  // 完整平假名
  'ぜろ': '0', 'れい': '0',
  'いち': '1',
  'に': '2',
  'さん': '3',
  'よん': '4', 'し': '4',
  'ご': '5',
  'ろく': '6',
  'なな': '7', 'しち': '7',
  'はち': '8',
  'きゅう': '9', 'く': '9',

  // 可能的片段（OCR 识别错误时的备选）
  'いちご': '15',  // 常见组合
  'さんろく': '36',
  'きゅうろく': '96',
};

/**
 * 统一验证码结果标准化（处理各种 OCR 输出格式）
 * @param {string} rawText - OCR 原始识别结果
 * @returns {string|null} - 标准化后的 6 位纯数字，失败返回 null
 */
function normalizeCaptchaCode(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return null;
  }

  // 步骤 1: 基础清理（移除空白和常见分隔符）
  let text = rawText.trim().replace(/[\s\-_]/g, '');

  // 步骤 2: 全角数字转半角
  text = text.replace(/[０-９]/g, (char) => {
    return String.fromCharCode(char.charCodeAt(0) - 0xFEE0);
  });

  // 步骤 3: 如果已经是纯数字，直接返回
  if (/^\d{6}$/.test(text)) {
    return text;
  }

  // 步骤 4: 尝试平假名转换
  const convertedFromHiragana = convertHiraganaToNumber(text);
  if (convertedFromHiragana && /^\d{6}$/.test(convertedFromHiragana)) {
    return convertedFromHiragana;
  }

  // 步骤 5: 提取所有数字字符（处理混合内容）
  const digitsOnly = text.replace(/\D/g, '');
  if (/^\d{6}$/.test(digitsOnly)) {
    log(`⚠️ 从混合内容提取数字: "${rawText}" → "${digitsOnly}"`);
    return digitsOnly;
  }

  // 无法标准化为 6 位数字
  return null;
}

/**
 * 尝试将平假名文本转换为数字（如果 OCR 返回平假名）
 * @param {string} text - OCR 识别结果
 * @returns {string|null} - 转换后的数字，失败返回 null
 */
function convertHiraganaToNumber(text) {
  if (!text || /^\d+$/.test(text)) {
    // 已经是纯数字，直接返回
    return text;
  }

  log(`🔄 检测到可能的平假名内容，尝试转换: "${text}"`);

  // 移除空格和特殊字符
  const cleanText = text.replace(/[\s\-_]/g, '');

  // 方法 1：完整匹配
  if (HIRAGANA_NUMBER_MAP[cleanText]) {
    const converted = HIRAGANA_NUMBER_MAP[cleanText];
    log(`✅ 平假名转换成功（完整匹配）: "${cleanText}" → ${converted}`);
    return converted;
  }

  // 方法 2：逐字匹配并拼接
  let result = '';
  let i = 0;
  while (i < cleanText.length) {
    let matched = false;

    // 尝试匹配 3 字符、2 字符、1 字符
    for (let len = 3; len >= 1; len--) {
      const substr = cleanText.substring(i, i + len);
      if (HIRAGANA_NUMBER_MAP[substr]) {
        result += HIRAGANA_NUMBER_MAP[substr];
        i += len;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // 无法匹配，跳过当前字符
      log(`⚠️ 无法匹配字符: "${cleanText[i]}"`);
      i++;
    }
  }

  if (result.length >= 4) {
    log(`✅ 平假名转换成功（逐字匹配）: "${cleanText}" → ${result}`);
    return result;
  }

  log(`❌ 平假名转换失败: "${text}"`);
  return null;
}

/**
 * 使用百度 OCR API 识别验证码（保底方案）
 * @param {string} imgBase64 - Base64 编码的图片数据
 * @returns {Promise<string>} - 识别的验证码
 */
async function recognizeCaptchaWithBaiduOCR(imgBase64) {
  if (!CONFIG.CAPTCHA_API) {
    throw new Error('未配置 CAPTCHA_API，无法使用百度 OCR 保底方案');
  }

  log(`使用百度 OCR API 识别验证码（保底方案）: ${CONFIG.CAPTCHA_API}`);

  const res = await fetch(CONFIG.CAPTCHA_API, {
    method: 'POST',
    body: imgBase64,
    headers: { 'Content-Type': 'text/plain' },
  });

  log(`百度 OCR API 响应状态: ${res.status}`);

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`百度 OCR API 响应 ${res.status}: ${errorText}`);
  }

  const rawCode = (await res.text()).trim();
  log(`百度 OCR 返回原始结果: "${rawCode}" (长度: ${rawCode.length})`);

  // 使用统一标准化函数
  const code = normalizeCaptchaCode(rawCode);

  if (code) {
    log(`✅ 百度 OCR 识别成功: ${code}`);
    return code;
  }

  throw new Error(`百度 OCR 返回无效结果: "${rawCode}"`);
}

/**
 * 使用 Google Cloud Vision API 识别验证码
 * @param {string} imgBase64 - Base64 编码的图片数据
 * @returns {Promise<string>} - 识别的验证码
 */
async function recognizeCaptchaWithGoogleVision(imgBase64) {
  if (!CONFIG.GOOGLE_VISION_API_KEY) {
    throw new Error('未配置 GOOGLE_VISION_API_KEY');
  }

  log('使用 Google Cloud Vision API 识别验证码...');
  const apiKey = CONFIG.GOOGLE_VISION_API_KEY;
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;

  const payload = {
    requests: [{
      image: {
        content: imgBase64.replace(/^data:image\/\w+;base64,/, '')
      },
      features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
      imageContext: {
        languageHints: ['ja']  // 日语优化
      }
    }]
  };

  const startTime = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Google Vision API 响应 ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  const elapsedTime = Date.now() - startTime;

  // 增强响应结构防御
  if (!data?.responses?.[0]) {
    throw new Error('Google Vision API 返回无效响应结构');
  }

  const response = data.responses[0];

  if (response.error) {
    throw new Error(`Google Vision API 错误: ${response.error.message}`);
  }

  if (!response.textAnnotations || response.textAnnotations.length === 0) {
    throw new Error('Google Vision API 未检测到文本');
  }

  const rawText = response.textAnnotations[0].description.trim();
  log(`Google Vision API 原始结果: "${rawText}" (耗时 ${elapsedTime}ms)`);

  // 使用统一标准化函数
  const code = normalizeCaptchaCode(rawText);

  if (code) {
    log(`✅ Google Vision API 识别成功: ${code}`);
    return code;
  }

  throw new Error(`Google Vision API 返回无效结果: "${rawText}"`);
}

/**
 * 使用 OCR.space Engine 3 识别验证码
 * @param {string} imgBase64 - Base64 编码的图片数据
 * @returns {Promise<string>} - 识别的验证码
 */
async function recognizeCaptchaWithOCRSpace(imgBase64) {
  if (!CONFIG.OCRSPACE_API_KEY) {
    throw new Error('未配置 OCRSPACE_API_KEY');
  }

  log('使用 OCR.space Engine 3 识别验证码...');
  const apiKey = CONFIG.OCRSPACE_API_KEY;
  const url = 'https://api.ocr.space/parse/image';

  const formData = new URLSearchParams();
  formData.append('apikey', apiKey);
  formData.append('language', 'jpn');
  formData.append('OCREngine', '3');  // Engine 3 专门优化日语
  formData.append('scale', 'true');    // 自动放大低分辨率图片
  formData.append('isOverlayRequired', 'false');
  formData.append('base64Image', imgBase64);

  const startTime = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OCR.space API 响应 ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  const elapsedTime = Date.now() - startTime;

  if (data.IsErroredOnProcessing) {
    throw new Error(`OCR.space 处理错误: ${data.ErrorMessage || data.ErrorDetails || 'Unknown error'}`);
  }

  if (!data.ParsedResults || data.ParsedResults.length === 0) {
    throw new Error('OCR.space 未返回识别结果');
  }

  const rawText = data.ParsedResults[0].ParsedText.trim();
  log(`OCR.space Engine 3 原始结果: "${rawText}" (耗时 ${elapsedTime}ms)`);

  // 使用统一标准化函数
  const code = normalizeCaptchaCode(rawText);

  if (code) {
    log(`✅ OCR.space Engine 3 识别成功: ${code}`);
    return code;
  }

  throw new Error(`OCR.space 返回无效结果: "${rawText}"`);
}

/**
 * 验证码识别主函数（2Captcha 优先 + 百度 OCR 保底）
 * @param {string} imgSrc - 验证码图片 src（Base64 格式）
 * @returns {Promise<string>} - 识别的 6 位数字验证码
 */
/**
 * 带超时的 Promise 包装
 * @param {Promise} promise - 原始 Promise
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @param {string} name - 服务名称（用于日志）
 * @returns {Promise} - 包装后的 Promise
 */
function withTimeout(promise, timeoutMs, name) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${name} 超时 (${timeoutMs}ms)`)), timeoutMs)
    )
  ]);
}

/**
 * 智能验证码识别（双 OCR 并行 + 投票机制）
 * @param {string} imgSrc - Base64 编码的图片数据
 * @returns {Promise<string>} - 识别的 6 位数字验证码
 */
async function recognizeCaptcha(imgSrc) {
  // 如果已经是 Base64，直接使用；否则需要下载图片转 Base64
  let imgBase64 = imgSrc;
  if (!imgSrc.startsWith('data:image/')) {
    throw new Error('imgSrc 必须是 Base64 格式（data:image/...）');
  }

  log('开始验证码识别（双 OCR 并行调用）...');

  const ocrPromises = [];
  const OCR_TIMEOUT = 15000; // 单个 OCR 超时 15 秒

  // OCR 1: Google Cloud Vision API（如果配置）
  if (CONFIG.GOOGLE_VISION_API_KEY) {
    ocrPromises.push({
      name: 'Google Vision',
      promise: withTimeout(
        recognizeCaptchaWithGoogleVision(imgBase64),
        OCR_TIMEOUT,
        'Google Vision'
      ).catch(e => {
        log(`⚠️ Google Vision API 失败: ${e.message}`);
        return null;
      })
    });
  }

  // OCR 2: OCR.space Engine 3（如果配置）
  if (CONFIG.OCRSPACE_API_KEY) {
    ocrPromises.push({
      name: 'OCR.space',
      promise: withTimeout(
        recognizeCaptchaWithOCRSpace(imgBase64),
        OCR_TIMEOUT,
        'OCR.space'
      ).catch(e => {
        log(`⚠️ OCR.space 失败: ${e.message}`);
        return null;
      })
    });
  }

  // OCR 3: 百度 OCR（如果配置，作为保底）
  if (CONFIG.CAPTCHA_API) {
    ocrPromises.push({
      name: '百度 OCR',
      promise: withTimeout(
        recognizeCaptchaWithBaiduOCR(imgBase64),
        OCR_TIMEOUT,
        '百度 OCR'
      ).catch(e => {
        log(`⚠️ 百度 OCR 失败: ${e.message}`);
        return null;
      })
    });
  }

  if (ocrPromises.length === 0) {
    throw new Error('未配置任何 OCR 服务（需要 GOOGLE_VISION_API_KEY、OCRSPACE_API_KEY 或 CAPTCHA_API 之一）');
  }

  // 并行调用所有 OCR 服务
  log(`📊 并行调用 ${ocrPromises.length} 个 OCR 服务（超时 ${OCR_TIMEOUT}ms）...`);
  const results = await Promise.all(ocrPromises.map(o => o.promise));

  // 过滤掉失败的结果，只保留 6 位数字，并记录来源
  const validResults = [];
  results.forEach((code, i) => {
    if (code && /^\d{6}$/.test(code)) {
      validResults.push({
        provider: ocrPromises[i].name,
        code: code
      });
    }
  });

  log(`📊 有效结果: ${validResults.length}/${results.length}`);
  validResults.forEach((r, i) => log(`  结果 ${i + 1}: ${r.code} (${r.provider})`));

  if (validResults.length === 0) {
    throw new Error('所有 OCR 服务均失败或返回无效结果');
  }

  // 投票机制：选择出现次数最多的结果
  const voteCounts = {};
  validResults.forEach(r => {
    voteCounts[r.code] = voteCounts[r.code] || { count: 0, providers: [] };
    voteCounts[r.code].count++;
    voteCounts[r.code].providers.push(r.provider);
  });

  const sortedVotes = Object.entries(voteCounts)
    .map(([code, data]) => ({ code, count: data.count, providers: data.providers }))
    .sort((a, b) => b.count - a.count);

  const winner = sortedVotes[0];

  // 置信度判断
  if (winner.count >= 2) {
    log(`✅ 投票结果: ${winner.code} (${winner.count}/${validResults.length} 票，高置信度)`);
    log(`   提供商: ${winner.providers.join(', ')}`);
    return winner.code;
  } else if (validResults.length === 1) {
    log(`✅ 单一结果: ${winner.code} (仅 ${winner.providers[0]} 成功)`);
    return winner.code;
  } else {
    // 所有结果不同 - 低置信度，抛出错误
    log(`❌ 投票结果分歧: 所有 OCR 返回不同结果`);
    sortedVotes.forEach(v => {
      log(`   ${v.code}: ${v.count} 票 (${v.providers.join(', ')})`);
    });
    throw new Error(`验证码识别结果分歧（${validResults.length} 个不同结果），建议刷新验证码重试`);
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
  const hasProxy = !!(CONFIG.PROXY_TYPE && CONFIG.PROXY_ADDRESS && CONFIG.PROXY_PORT);

  if (CONFIG.CAPSOLVER_API_KEY) {
    return {
      name: 'CapSolver',
      apiBase: 'https://api.capsolver.com',
      clientKey: CONFIG.CAPSOLVER_API_KEY,
      taskType: 'AntiTurnstileTaskProxyLess', // CapSolver 不支持代理
      supportsProxy: false,
    };
  }
  if (CONFIG.TWOCAPTCHA_API_KEY) {
    return {
      name: '2Captcha',
      apiBase: 'https://api.2captcha.com',
      clientKey: CONFIG.TWOCAPTCHA_API_KEY,
      taskType: hasProxy ? 'TurnstileTask' : 'TurnstileTaskProxyless',
      supportsProxy: hasProxy,
    };
  }
  return null;
}

/**
 * 从页面提取 Turnstile 参数
 * Standalone Turnstile 只需 sitekey（从 HTML data-sitekey 属性获取）
 * 同时提取 data-action / data-cdata 等可选属性
 * 返回 { sitekey, action, cData, chlPageData } 或 null
 */
async function extractTurnstileParams(page) {
  // 从 .cf-turnstile 元素的 data-* 属性提取所有参数
  const params = await page.evaluate(() => {
    const el = document.querySelector('.cf-turnstile[data-sitekey]')
      || document.querySelector('[data-sitekey]');
    if (!el) return null;
    return {
      sitekey: el.getAttribute('data-sitekey') || '',
      action: el.getAttribute('data-action') || '',
      cData: el.getAttribute('data-cdata') || '',
      chlPageData: el.getAttribute('data-chlpagedata') || '',
      callbackName: el.getAttribute('data-callback') || '',
    };
  });

  if (params && params.sitekey) {
    log(`Turnstile 参数提取成功（data-* 属性）: sitekey=${params.sitekey}, ` +
      `action=${params.action || '(空)'}, callback=${params.callbackName || '(空)'}`);
    return params;
  }

  // 降级：正则匹配页面源码
  const html = await page.content();
  const match = html.match(/data-sitekey=["']([0-9a-zA-Z_-]+)["']/);
  if (match) {
    log(`Turnstile sitekey 提取成功（正则匹配）: ${match[1]}`);
    return { sitekey: match[1], action: '', cData: '', chlPageData: '', callbackName: '' };
  }

  return null;
}

/**
 * 通过 CapSolver / 2Captcha API 求解 Turnstile token
 *
 * 流程：createTask → 轮询 getTaskResult → 返回 { token, userAgent }
 * 使用原生 fetch()，不引入额外依赖
 *
 * @param {string} websiteURL - 目标页面 URL
 * @param {object} params - { sitekey, action, cData, chlPageData }
 * @returns {{ token: string, userAgent: string|null }}
 */
async function solveTurnstileViaAPI(websiteURL, params) {
  const provider = getTurnstileProvider();
  if (!provider) throw new Error('未配置 Turnstile 求解 API 密钥');

  log(`使用 ${provider.name} 求解 Turnstile (sitekey=${params.sitekey.substring(0, 12)}...)`);

  // 构建任务参数
  const task = {
    type: provider.taskType,
    websiteURL,
    websiteKey: params.sitekey,
  };

  // 传递浏览器 UA 给 API（仅 2Captcha 支持，CapSolver 会忽略）
  task.userAgent = DEFAULT_UA;

  // 2Captcha 带代理模式：添加住宅代理参数
  if (provider.supportsProxy) {
    task.proxyType = CONFIG.PROXY_TYPE;
    task.proxyAddress = CONFIG.PROXY_ADDRESS;
    task.proxyPort = parseInt(CONFIG.PROXY_PORT, 10);
    if (CONFIG.PROXY_LOGIN) task.proxyLogin = CONFIG.PROXY_LOGIN;
    if (CONFIG.PROXY_PASSWORD) task.proxyPassword = CONFIG.PROXY_PASSWORD;
    log(`${provider.name} 使用住宅代理: ${CONFIG.PROXY_TYPE}://${CONFIG.PROXY_ADDRESS}:${CONFIG.PROXY_PORT}`);
  }

  // CapSolver 使用 metadata 传递 action/cdata
  if (provider.name === 'CapSolver') {
    if (params.action || params.cData) {
      task.metadata = {};
      if (params.action) task.metadata.action = params.action;
      if (params.cData) task.metadata.cdata = params.cData;
    }
  } else {
    // 2Captcha 使用顶层 action/data/pagedata
    if (params.action) task.action = params.action;
    if (params.cData) task.data = params.cData;
    if (params.chlPageData) task.pagedata = params.chlPageData;
  }

  // Mask 敏感信息后记录日志
  const taskForLog = { ...task };
  if (taskForLog.proxyPassword) {
    taskForLog.proxyPassword = '***';
  }
  if (taskForLog.proxyLogin) {
    taskForLog.proxyLogin = '***';
  }
  log(`${provider.name} 任务参数: ${JSON.stringify(taskForLog)}`);

  // 创建求解任务
  const createRes = await fetch(`${provider.apiBase}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: provider.clientKey,
      task,
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
      const userAgent = resultData.solution.userAgent || null;
      log(`${provider.name} 求解成功！耗时 ${Date.now() - startTime}ms，token 长度: ${token.length}` +
        (userAgent ? `，UA: ${userAgent.substring(0, 50)}...` : ''));
      return { token, userAgent };
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
      // 通过 data-callback 属性找到回调函数名
      const cfDiv = document.querySelector('.cf-turnstile[data-callback]');
      if (cfDiv) {
        const callbackName = cfDiv.getAttribute('data-callback');
        if (callbackName && typeof window[callbackName] === 'function') {
          window[callbackName](tkn);
          callbackCalled = true;
        }
      }
    } catch (_) { /* 忽略回调异常 */ }

    // 启用提交按钮（某些表单在 token 注入前禁用提交）
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
  // 🔧 优化：读取所有字段，返回第一个有值的
  const existingToken = await page.evaluate(() => {
    const fields = document.querySelectorAll('[name="cf-turnstile-response"]');
    for (const field of fields) {
      if (field.value) return field.value;
    }
    return '';
  }).catch(() => '');

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

  // ========== 策略 1：先尝试点击 Turnstile checkbox 让其自行通过 ==========
  // rebrowser + Stealth 模式下，部分场景可直接通过 Turnstile 验证
  // 优势：无需 API、无 IP 绑定问题、最快速
  log('策略 1：尝试点击 Turnstile checkbox 自行通过...');
  await clickTurnstileFallback(page);

  // 等待 Turnstile 自行验证通过（最多 15 秒）
  const clickWaitStart = Date.now();
  const clickWaitTimeout = 15_000;
  while (Date.now() - clickWaitStart < clickWaitTimeout) {
    // 🔧 优化：读取所有字段，返回第一个有值的
    const token = await page.evaluate(() => {
      const fields = document.querySelectorAll('[name="cf-turnstile-response"]');
      for (const field of fields) {
        if (field.value) return field.value;
      }
      return '';
    }).catch(() => '');

    if (token) {
      log(`Turnstile 自行通过！耗时 ${Date.now() - clickWaitStart}ms，token 长度: ${token.length}`);
      return true;
    }
    await sleep(1000);
  }

  log(`Turnstile 点击后 ${clickWaitTimeout}ms 内未通过，检查是否有 API 密钥...`);

  // ========== 策略 2：API 求解模式 ==========
  const provider = getTurnstileProvider();

  if (provider) {
    log(`策略 2：使用 ${provider.name} API 求解 Turnstile`);

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
      // 🔧 优化：读取所有字段，返回第一个有值的
      const verifyToken = await page.evaluate(() => {
        const fields = document.querySelectorAll('[name="cf-turnstile-response"]');
        for (const field of fields) {
          if (field.value) return field.value;
        }
        return '';
      }).catch(() => '');

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
  while (Date.now() - startTime < CONFIG.TURNSTILE_TIMEOUT) {
    // 🔧 优化：读取所有 cf-turnstile-response 字段，返回第一个有值的
    // 调试发现页面有两个字段，需要读取有值的那个
    const token = await page.evaluate(() => {
      const fields = document.querySelectorAll('[name="cf-turnstile-response"]');
      for (const field of fields) {
        if (field.value) return field.value;
      }
      return '';
    }).catch(() => '');

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

  // 等待验证码图片元素（验证码图片是 Base64 内嵌在 src 属性中）
  await page.waitForSelector('img[src^="data:image"], img[src^="data:"]', { timeout: 10_000 });

  // 直接读取 img 元素的 src 属性（已经是 Base64 格式）
  const imgDataUri = await page.$eval('img[src^="data:image"], img[src^="data:"]', (el) => el.src);
  if (!imgDataUri) throw new Error('未找到验证码图片。');

  // 识别验证码（2Captcha 人工识别）
  const code = await recognizeCaptcha(imgDataUri);

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

  log(`📄 续期提交后页面 URL: ${currentUrl}`);

  // 保存完整页面文本用于调试（前1000字符）
  const pageSnippet = pageText.substring(0, 1000).replace(/\s+/g, ' ').trim();
  log(`📝 页面内容片段: ${pageSnippet}`);

  // 还停在确认页，说明提交未被服务端接受（token 无效或验证码错误）
  if (currentUrl.includes('/conf')) {
    const hasAuthFail = pageText.includes('認証に失敗');
    const reason = hasAuthFail ? 'Turnstile 认证失败' : '页面未跳转，可能验证码或 token 无效';
    throw new Error(`续期提交失败（${reason}）`);
  }

  // 优先检查失败标识（必须在成功检查之前）
  const failurePatterns = ['認証に失敗', '失敗しました', 'エラーが発生', '不正なアクセス'];
  const matchedFailure = failurePatterns.find(pat => pageText.includes(pat));
  if (matchedFailure) {
    log(`❌ 检测到失败标识: "${matchedFailure}"`);
    throw new Error(`续期提交失败: ${pageSnippet}`);
  }

  // 检查其他错误标识
  const errorPatterns = ['エラー', '不正', 'もう一度'];
  const matchedError = errorPatterns.find(pat => pageText.includes(pat));
  if (matchedError) {
    log(`⚠️ 检测到错误标识: "${matchedError}"`);
    throw new Error(`续期提交后出现错误: ${pageSnippet}`);
  }

  // 检查是否包含明确的成功关键词
  const successPatterns = ['完了しました', '延長しました', '更新が完了', '手続きが完了'];
  const matchedSuccess = successPatterns.find(pat => pageText.includes(pat));
  if (matchedSuccess) {
    log(`✅ 页面确认续期成功！检测到: "${matchedSuccess}"`);
  } else {
    // 如果没有明确成功标识，输出完整页面内容用于调试
    log(`⚠️ 页面未检测到明确的成功标识`);
    log(`⚠️ 完整页面文本（前1500字符）: ${pageText.substring(0, 1500).replace(/\s+/g, ' ').trim()}`);

    // 不抛出异常，但标记为可能失败
    log(`⚠️ 续期状态不明确，请人工确认。URL: ${currentUrl}`);
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
    const hasProxy = !!(CONFIG.PROXY_TYPE && CONFIG.PROXY_ADDRESS && CONFIG.PROXY_PORT);
    if (hasProxy) {
      const proxyScheme = CONFIG.PROXY_TYPE === 'socks5' ? 'socks5' :
        CONFIG.PROXY_TYPE === 'socks4' ? 'socks4' : 'http';
      chromeArgs.push(`--proxy-server=${proxyScheme}://${CONFIG.PROXY_ADDRESS}:${CONFIG.PROXY_PORT}`);
      log(`浏览器代理已配置: ${proxyScheme}://${CONFIG.PROXY_ADDRESS}:${CONFIG.PROXY_PORT}`);
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
    if (hasProxy && CONFIG.PROXY_LOGIN) {
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
    const pageContent = await page.content();
    log(`📄 当前页面 URL: ${page.url()}`);

    const newExpireDate = await page.evaluate(() => {
      // 方法 1：查找包含"更新後の利用期限"的 td 元素
      const allTds = Array.from(document.querySelectorAll('td'));
      const expireTd = allTds.find(td => td.textContent.includes('更新後の利用期限') || td.textContent.includes('更新后的利用期限'));

      if (expireTd && expireTd.nextElementSibling) {
        const dateText = expireTd.nextElementSibling.textContent.trim();
        console.log('方法1找到日期:', dateText);
        return dateText;
      }

      // 方法 2：直接查找 yyyy-mm-dd 格式的日期
      const allText = document.body.textContent;
      const dateMatches = allText.match(/\d{4}-\d{2}-\d{2}/g);
      if (dateMatches && dateMatches.length > 0) {
        console.log('方法2找到日期:', dateMatches);
        // 返回最后一个日期（通常是新到期日）
        return dateMatches[dateMatches.length - 1];
      }

      // 方法 3：查找包含年月日的日本格式
      const jpDateMatch = allText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (jpDateMatch) {
        const [, year, month, day] = jpDateMatch;
        const formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        console.log('方法3找到日期:', formattedDate);
        return formattedDate;
      }

      console.log('所有方法均未找到日期');
      return null;
    });

    if (newExpireDate) {
      log(`✅ 成功提取新到期日: ${newExpireDate}`);
    } else {
      log(`⚠️ 未能自动提取新到期日，请检查页面结构`);
    }

    log('🎉 续期流程全部完成！');

    // 计算下次运行时间（明天同一时间）
    const now = new Date();
    const nextRun = new Date(now.getTime() + 86_400_000);
    const nextRunStr = nextRun.toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' });

    await notify(
      `✅ <b>Xserver VPS 续期成功</b>\n\n` +
      `⏰ 执行时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' })}\n` +
      `🖥️ 服务器名: ${escapeHtml(renewalData.vpsInfo.serverName || '未知')}\n` +
      `📦 VPS 规格: ${escapeHtml(renewalData.vpsInfo.plan || '未知')}\n` +
      `📅 原到期日: ${escapeHtml(renewalData.vpsInfo.expireDate || '未知')}\n` +
      `📅 新到期日: ${escapeHtml(newExpireDate || '未提取')}\n` +
      `⏭️ 下次执行: ${nextRunStr}\n` +
      `📋 续期页面: ${escapeHtml(page.url())}`,
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
