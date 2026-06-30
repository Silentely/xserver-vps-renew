/**
 * Turnstile 求解模块
 * 负责 Cloudflare Turnstile 的参数提取、API 求解、token 注入
 */

import { setTimeout as sleep } from 'node:timers/promises';

/** API 请求超时（毫秒） */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * 获取 Turnstile 求解服务商配置
 * @param {object} config - CONFIG 对象
 * @returns {object|null} - 服务商配置或 null
 */
export function getTurnstileProvider(config) {
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
  const masked = { ...task };
  if (masked.proxyAddress) {
    masked.proxyAddress = masked.proxyAddress.replace(/.(?=.{4})/g, '*');
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

  logger(`使用 ${provider.name} 求解 Turnstile (sitekey=${params.sitekey.substring(0, 12)}...)`);

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
    const maskedProxyAddr = taskConfig.proxyAddress.replace(/.(?=.{4})/g, '*');
    logger(`${provider.name} 使用住宅代理: ${taskConfig.proxyType}://${maskedProxyAddr}:${taskConfig.proxyPort}`);
  }

  logger(`${provider.name} 任务参数: ${JSON.stringify(maskTaskForLog(task))}`);

  const createController = new AbortController();
  const createTimeout = setTimeout(() => createController.abort(), FETCH_TIMEOUT_MS);
  let createRes;
  try {
    createRes = await fetch(`${provider.apiBase}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: provider.clientKey, task }),
      signal: createController.signal,
    });
  } finally {
    clearTimeout(createTimeout);
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
  const pollInterval = 3000;
  const maxPolls = Math.ceil(timeout / pollInterval);

  for (let i = 1; i <= maxPolls; i++) {
    if (Date.now() - startTime > timeout) {
      throw new Error(`${provider.name} 求解超时（${timeout}ms）`);
    }
    await sleep(pollInterval);

    const resultController = new AbortController();
    const resultTimeout = setTimeout(() => resultController.abort(), FETCH_TIMEOUT_MS);
    let resultRes;
    try {
      resultRes = await fetch(`${provider.apiBase}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: provider.clientKey, taskId }),
        signal: resultController.signal,
      });
    } finally {
      clearTimeout(resultTimeout);
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
 * 仅注入 input/textarea 元素并调用 turnstile.reset()，不触发事件或启用提交按钮
 * （Docker 环境下 Xserver 的 Standalone Turnstile 不需要额外事件触发）
 * @param {object} page - Puppeteer page 对象
 * @param {string} token - Turnstile token
 * @param {Function} logger - 日志函数
 * @returns {Promise<boolean>} - 是否成功注入
 */
export async function injectTurnstileToken(page, token, logger = () => {}) {
  const injected = await page.evaluate((tk) => {
    const input = document.querySelector('input[name="cf-turnstile-response"]')
      || document.querySelector('textarea[name="cf-turnstile-response"]');
    if (input) {
      input.value = tk;
    }

    if (window.turnstile && window.turnstile.reset) {
      const widgets = document.querySelectorAll('.cf-turnstile');
      if (widgets.length > 0) {
        const widgetId = widgets[0].getAttribute('data-widget-id') || '0';
        try {
          window.turnstile.reset(widgetId);
        } catch { /* 忽略 */ }
      }
    }

    return !!input;
  }, token);

  if (injected) {
    logger('Turnstile token 已注入页面');
  } else {
    logger('⚠️ 未找到 cf-turnstile-response 输入框');
  }

  return injected;
}
