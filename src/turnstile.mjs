/**
 * Turnstile 求解模块
 * 负责 Cloudflare Turnstile 的参数提取、API 求解、token 注入
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { fetchWithTimeout, maskProxyAddress } from './utils.mjs';

/** API 请求超时（毫秒） */
const FETCH_TIMEOUT_MS = 30_000;

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 3_000;

/**
 * 获取 Turnstile 求解服务商配置
 * @param {object} config - CONFIG 对象
 * @returns {object|null} - 服务商配置或 null
 */
export function getTurnstileProvider(config) {
  if (!config || typeof config !== 'object') return null;
  const hasProxy = !!(config.PROXY_TYPE && config.PROXY_ADDRESS && config.PROXY_PORT);

  if (config.CAPSOLVER_API_KEY) {
    return {
      name: 'CapSolver',
      apiBase: 'https://api.capsolver.com',
      clientKey: config.CAPSOLVER_API_KEY,
      taskType: 'AntiTurnstileTaskProxyLess',
      supportsProxy: false,
    };
  }
  if (config.TWOCAPTCHA_API_KEY) {
    return {
      name: '2Captcha',
      apiBase: 'https://api.2captcha.com',
      clientKey: config.TWOCAPTCHA_API_KEY,
      taskType: hasProxy ? 'TurnstileTask' : 'TurnstileTaskProxyless',
      supportsProxy: hasProxy,
    };
  }
  return null;
}

/**
 * 从页面提取 Turnstile 参数
 * @param {object} page - Puppeteer page 对象
 * @param {Function} logger - 日志函数
 * @returns {Promise<object|null>} - { sitekey, action, cData, chlPageData, callbackName }
 */
export async function extractTurnstileParams(page, logger = () => {}) {
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
    logger(`Turnstile 参数提取成功（data-* 属性）: sitekey=${params.sitekey}, ` +
      `action=${params.action || '(空)'}, callback=${params.callbackName || '(空)'}`);
    return params;
  }

  const html = await page.content();
  const match = html.match(/data-sitekey=["']([0-9a-zA-Z_-]+)["']/);
  if (match) {
    logger(`Turnstile sitekey 提取成功（正则匹配）: ${match[1]}`);
    return { sitekey: match[1], action: '', cData: '', chlPageData: '', callbackName: '' };
  }

  return null;
}

/**
 * 构建 Turnstile 求解 API 的任务参数（纯函数，便于单元测试）
 * @param {object} provider - getTurnstileProvider() 返回的服务商配置
 * @param {object} params - { sitekey, action, cData, chlPageData }
 * @param {object} config - { proxyType, proxyAddress, proxyPort, proxyLogin, proxyPassword, userAgent }
 * @param {string} websiteURL - 目标页面 URL
 * @returns {object} - 完整的任务参数对象
 */
export function buildTurnstileTask(provider, params, config, websiteURL) {
  const task = {
    type: provider.taskType,
    websiteURL,
    websiteKey: params.sitekey,
    userAgent: config.userAgent || '',
  };

  if (provider.supportsProxy) {
    task.proxyType = config.proxyType;
    task.proxyAddress = config.proxyAddress;
    task.proxyPort = parseInt(config.proxyPort, 10);
    if (config.proxyLogin) task.proxyLogin = config.proxyLogin;
    if (config.proxyPassword) task.proxyPassword = config.proxyPassword;
  }

  if (provider.name === 'CapSolver') {
    if (params.action || params.cData) {
      task.metadata = {};
      if (params.action) task.metadata.action = params.action;
      if (params.cData) task.metadata.cdata = params.cData;
    }
  } else {
    if (params.action) task.action = params.action;
    if (params.cData) task.data = params.cData;
    if (params.chlPageData) task.pagedata = params.chlPageData;
  }

  return task;
}

/**
 * 创建任务参数的日志安全副本（mask 敏感信息）
 * @param {object} task - buildTurnstileTask 返回的任务参数
 * @returns {object} - mask 后的副本
 */
export function maskTaskForLog(task) {
  if (!task || typeof task !== 'object') return {};
  const masked = { ...task };
  if (masked.proxyAddress) {
    masked.proxyAddress = maskProxyAddress(masked.proxyAddress);
  }
  if (masked.proxyPassword) masked.proxyPassword = '***';
  if (masked.proxyLogin) masked.proxyLogin = '***';
  return masked;
}

/**
 * 通过 CapSolver / 2Captcha API 求解 Turnstile token
 * @param {string} websiteURL - 目标页面 URL
 * @param {object} params - { sitekey, action, cData, chlPageData }
 * @param {object} config - CONFIG 对象
 * @param {Function} logger - 日志函数
 * @param {number} timeout - 轮询超时（毫秒）
 * @returns {Promise<{ token: string, userAgent: string|null }>}
 */
export async function solveTurnstileViaAPI(websiteURL, params, config, logger = () => {}, timeout = 120_000) {
  const provider = getTurnstileProvider(config);
  if (!provider) throw new Error('未配置 Turnstile 求解 API 密钥');
  if (!params?.sitekey) throw new Error('Turnstile sitekey 为空，无法求解');

  const sitekeyPreview = params.sitekey.length > 12
    ? `${params.sitekey.substring(0, 12)}...`
    : params.sitekey;
  logger(`使用 ${provider.name} 求解 Turnstile (sitekey=${sitekeyPreview})`);

  const taskConfig = {
    proxyType: config.PROXY_TYPE,
    proxyAddress: config.PROXY_ADDRESS,
    proxyPort: config.PROXY_PORT,
    proxyLogin: config.PROXY_LOGIN,
    proxyPassword: config.PROXY_PASSWORD,
    userAgent: config.DEFAULT_UA || '',
  };

  const task = buildTurnstileTask(provider, params, taskConfig, websiteURL);

  if (provider.supportsProxy) {
    const maskedProxyAddr = maskProxyAddress(taskConfig.proxyAddress);
    logger(`${provider.name} 使用住宅代理: ${taskConfig.proxyType}://${maskedProxyAddr}:${taskConfig.proxyPort}`);
  }

  logger(`${provider.name} 任务参数: ${JSON.stringify(maskTaskForLog(task))}`);

  let createRes;
  try {
    createRes = await fetchWithTimeout(
      `${provider.apiBase}/createTask`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: provider.clientKey, task }),
      },
      FETCH_TIMEOUT_MS,
    );
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${provider.name} createTask 请求超时（${FETCH_TIMEOUT_MS}ms）`);
    }
    throw new Error(`${provider.name} createTask 网络异常: ${error.message}`);
  }

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

  logger(`${provider.name} 任务已创建: taskId=${taskId}`);

  const startTime = Date.now();
  const maxPolls = Math.max(1, Math.ceil(timeout / POLL_INTERVAL_MS));

  for (let i = 1; i <= maxPolls; i++) {
    if (Date.now() - startTime > timeout) {
      throw new Error(`${provider.name} 求解超时（${timeout}ms）`);
    }
    await sleep(POLL_INTERVAL_MS);

    let resultRes;
    try {
      resultRes = await fetchWithTimeout(
        `${provider.apiBase}/getTaskResult`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: provider.clientKey, taskId }),
        },
        FETCH_TIMEOUT_MS,
      );
    } catch (error) {
      logger(`${provider.name} getTaskResult 网络异常: ${error.message}，继续轮询...`);
      continue;
    }

    if (!resultRes.ok) {
      logger(`${provider.name} getTaskResult HTTP 错误: ${resultRes.status}，继续轮询...`);
      continue;
    }

    const resultData = await resultRes.json();

    if (resultData.errorId && resultData.errorId !== 0) {
      const errMsg = resultData.errorDescription || resultData.errorCode;
      // "init error" 是 CapSolver 瞬态错误，短暂等待后重试而非直接终止
      if (errMsg === 'init error' && i < maxPolls) {
        logger(`${provider.name} 遇到瞬态 init error，等待后重试 (${i}/${maxPolls})...`);
        continue;
      }
      throw new Error(`${provider.name} getTaskResult 错误: ${errMsg}`);
    }

    if (resultData.status === 'ready' && resultData.solution) {
      const token = resultData.solution.token;
      if (!token) {
        throw new Error(`${provider.name} 返回 ready 但 solution.token 为空`);
      }
      const userAgent = resultData.solution.userAgent || null;
      logger(`${provider.name} 求解成功！耗时 ${Date.now() - startTime}ms，token 长度: ${token.length}` +
        (userAgent ? `，UA: ${userAgent.substring(0, 50)}...` : ''));
      return { token, userAgent };
    }

    logger(`${provider.name} 轮询中 (${i}/${maxPolls})... 状态: ${resultData.status || 'processing'}`);
  }

  throw new Error(`${provider.name} 轮询次数耗尽，求解失败`);
}

/**
 * 将 Turnstile token 注入页面并触发回调
 * 1. 注入 token 到所有匹配的 input/textarea（含 reCAPTCHA 兼容模式）
 * 2. 触发 input/change 事件通知表单框架
 * 3. 通过 data-callback 调用 Turnstile 回调函数
 * 4. 启用被禁用的提交按钮
 * @param {object} page - Puppeteer page 对象
 * @param {string} token - Turnstile token
 * @param {Function} logger - 日志函数
 * @returns {Promise<boolean>} - 是否成功注入
 */
export async function injectTurnstileToken(page, token, logger = () => {}) {
  if (!token) {
    logger('Turnstile token 为空，跳过注入');
    return false;
  }

  const injected = await page.evaluate((tkn) => {
    const selectors = [
      'input[name="cf-turnstile-response"]',
      'textarea[name="cf-turnstile-response"]',
      'input[name="g-recaptcha-response"]',
    ];

    let injectedCount = 0;
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      els.forEach((el) => {
        el.value = tkn;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        injectedCount++;
      });
    }

    let callbackCalled = false;
    try {
      const cfDiv = document.querySelector('.cf-turnstile[data-callback]');
      if (cfDiv) {
        const callbackName = cfDiv.getAttribute('data-callback');
        if (callbackName && typeof window[callbackName] === 'function') {
          window[callbackName](tkn);
          callbackCalled = true;
        }
      }
    } catch { /* 忽略回调异常 */ }

    const submitBtn = document.querySelector('input[type="submit"], button[type="submit"]');
    if (submitBtn && submitBtn.disabled) {
      submitBtn.disabled = false;
      submitBtn.removeAttribute('disabled');
    }

    return { injectedCount, callbackCalled };
  }, token);

  logger(`Turnstile token 已注入: ${injected.injectedCount} 个元素, 回调触发: ${injected.callbackCalled}`);
  return injected.injectedCount > 0;
}
