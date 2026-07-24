/**
 * Turnstile 求解模块
 * 负责 Cloudflare Turnstile 的参数提取、API 求解、token 注入、多平台 failover
 *
 * 支持提供商（默认可配置顺序）：
 * CapSolver / Anti-Captcha / YesCaptcha / 2Captcha
 *
 * Anti-Captcha 官方文档（2026 核对）：
 * - https://anti-captcha.com/apidoc/task-types/TurnstileTaskProxyless
 * - https://anti-captcha.com/apidoc/task-types/TurnstileTask
 * - https://anti-captcha.com/apidoc/methods/createTask
 * - https://anti-captcha.com/apidoc/methods/getTaskResult
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { fetchWithTimeout, maskProxyAddress } from './utils.mjs';

/** API 请求超时（毫秒） */
const FETCH_TIMEOUT_MS = 30_000;

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 3_000;

/** YesCaptcha 默认 API 节点（国际）；国内可用 https://cn.yescaptcha.com */
export const YESCAPTCHA_DEFAULT_API_BASE = 'https://api.yescaptcha.com';

/** YesCaptcha 默认任务类型（Turnstile 无代理） */
export const YESCAPTCHA_DEFAULT_TASK_TYPE = 'TurnstileTaskProxyless';

/**
 * YesCaptcha 开发者 softID（createTask 顶层参数，用于开发分成）
 * 文档：https://yescaptcha.atlassian.net/wiki/spaces/YESCAPTCHA/pages/25526273
 */
export const YESCAPTCHA_SOFT_ID = 97020;

/** Anti-Captcha API 基址 */
export const ANTICAPTCHA_API_BASE = 'https://api.anti-captcha.com';

/**
 * 默认提供商顺序（多 key 同时配置时按此链 failover）
 * CapSolver（AI）→ Anti-Captcha（真人/混合，CF 大更新时异构备份）→ YesCaptcha → 2Captcha
 */
export const DEFAULT_TURNSTILE_PROVIDER_ORDER = [
  'CapSolver',
  'AntiCaptcha',
  'YesCaptcha',
  '2Captcha',
];

/** 单平台连续失败达到此次数后切换下一平台 */
export const DEFAULT_TURNSTILE_PROVIDER_MAX_FAILURES = 3;

/** 多平台全挂错误码（供主流程识别高级告警） */
export const TURNSTILE_ALL_PROVIDERS_FAILED = 'TURNSTILE_ALL_PROVIDERS_FAILED';

/** 全挂错误摘要最大长度（避免 Telegram / 日志被超长堆栈撑爆） */
export const TURNSTILE_ERROR_SUMMARY_MAX_LEN = 800;

/**
 * 解析 YesCaptcha API 基址（去掉尾部斜杠；非法时回退默认国际节点）
 * @param {string|undefined} apiBase
 * @returns {string}
 */
export function resolveYesCaptchaApiBase(apiBase) {
  if (!apiBase || typeof apiBase !== 'string') return YESCAPTCHA_DEFAULT_API_BASE;
  const trimmed = apiBase.trim().replace(/\/+$/, '');
  if (!trimmed) return YESCAPTCHA_DEFAULT_API_BASE;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return YESCAPTCHA_DEFAULT_API_BASE;
    }
    return trimmed;
  } catch {
    return YESCAPTCHA_DEFAULT_API_BASE;
  }
}

/**
 * 解析 YesCaptcha 任务类型
 * 官方支持 TurnstileTaskProxyless（25 点）与 TurnstileTaskProxylessM1（30 点）
 * @param {string|undefined} taskType
 * @returns {string}
 */
export function resolveYesCaptchaTaskType(taskType) {
  if (!taskType || typeof taskType !== 'string') return YESCAPTCHA_DEFAULT_TASK_TYPE;
  const t = taskType.trim();
  if (t === 'TurnstileTaskProxyless' || t === 'TurnstileTaskProxylessM1') return t;
  return YESCAPTCHA_DEFAULT_TASK_TYPE;
}

/**
 * 规范化提供商名称（配置别名 → 内部名）
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeProviderName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/[-_\s]/g, '');
  const map = {
    capsolver: 'CapSolver',
    anticaptcha: 'AntiCaptcha',
    anti: 'AntiCaptcha',
    yescaptcha: 'YesCaptcha',
    yes: 'YesCaptcha',
    '2captcha': '2Captcha',
    twocaptcha: '2Captcha',
    '2cap': '2Captcha',
  };
  return map[key] || null;
}

/**
 * 解析 TURNSTILE_PROVIDER_ORDER（逗号分隔）
 * 非法项忽略；空/未配置时返回默认顺序
 * @param {string|undefined} orderStr
 * @returns {string[]}
 */
export function parseTurnstileProviderOrder(orderStr) {
  if (!orderStr || typeof orderStr !== 'string' || !orderStr.trim()) {
    return [...DEFAULT_TURNSTILE_PROVIDER_ORDER];
  }
  const seen = new Set();
  const order = [];
  for (const part of orderStr.split(/[,|]/)) {
    const name = normalizeProviderName(part);
    if (name && !seen.has(name)) {
      seen.add(name);
      order.push(name);
    }
  }
  return order.length > 0 ? order : [...DEFAULT_TURNSTILE_PROVIDER_ORDER];
}

/**
 * 根据 config 构建单个提供商对象（未配置 key 时返回 null）
 * @param {string} name - CapSolver | AntiCaptcha | YesCaptcha | 2Captcha
 * @param {object} config
 * @returns {object|null}
 */
export function buildProviderByName(name, config) {
  if (!config || typeof config !== 'object') return null;
  const hasProxy = !!(config.PROXY_TYPE && config.PROXY_ADDRESS && config.PROXY_PORT);

  switch (name) {
    case 'CapSolver':
      if (!config.CAPSOLVER_API_KEY) return null;
      return {
        name: 'CapSolver',
        apiBase: 'https://api.capsolver.com',
        clientKey: config.CAPSOLVER_API_KEY,
        taskType: 'AntiTurnstileTaskProxyLess',
        supportsProxy: false,
      };
    case 'AntiCaptcha': {
      if (!config.ANTICAPTCHA_API_KEY) return null;
      // 官方：优先 TurnstileTaskProxyless；仅当 proxyless 失败时才用带代理的 TurnstileTask
      // 文档：https://anti-captcha.com/apidoc/task-types/TurnstileTaskProxyless
      const softIdRaw = config.ANTICAPTCHA_SOFT_ID;
      const softIdNum = softIdRaw === '' || softIdRaw == null
        ? NaN
        : Number(softIdRaw);
      return {
        name: 'AntiCaptcha',
        apiBase: ANTICAPTCHA_API_BASE,
        clientKey: config.ANTICAPTCHA_API_KEY,
        taskType: hasProxy ? 'TurnstileTask' : 'TurnstileTaskProxyless',
        supportsProxy: hasProxy,
        // 官方 createTask 顶层 softId（camelCase）；非法/未配置时不传
        softId: Number.isFinite(softIdNum) ? softIdNum : undefined,
      };
    }
    case 'YesCaptcha':
      if (!config.YESCAPTCHA_API_KEY) return null;
      return {
        name: 'YesCaptcha',
        apiBase: resolveYesCaptchaApiBase(config.YESCAPTCHA_API_BASE),
        clientKey: config.YESCAPTCHA_API_KEY,
        taskType: resolveYesCaptchaTaskType(config.YESCAPTCHA_TASK_TYPE),
        supportsProxy: false,
        softID: YESCAPTCHA_SOFT_ID,
      };
    case '2Captcha':
      if (!config.TWOCAPTCHA_API_KEY) return null;
      return {
        name: '2Captcha',
        apiBase: 'https://api.2captcha.com',
        clientKey: config.TWOCAPTCHA_API_KEY,
        taskType: hasProxy ? 'TurnstileTask' : 'TurnstileTaskProxyless',
        supportsProxy: hasProxy,
      };
    default:
      return null;
  }
}

/**
 * 列出已配置的 Turnstile 提供商（按顺序，仅含有 key 的）
 * @param {object} config - CONFIG 对象
 * @returns {object[]}
 */
export function listTurnstileProviders(config) {
  if (!config || typeof config !== 'object') return [];
  const order = parseTurnstileProviderOrder(config.TURNSTILE_PROVIDER_ORDER);
  const providers = [];
  for (const name of order) {
    const p = buildProviderByName(name, config);
    if (p) providers.push(p);
  }
  return providers;
}

/**
 * 获取 Turnstile 求解服务商配置（兼容旧接口：返回链上第一家）
 * 优先级默认：CapSolver > AntiCaptcha > YesCaptcha > 2Captcha
 * @param {object} config - CONFIG 对象
 * @returns {object|null} - 服务商配置或 null
 */
export function getTurnstileProvider(config) {
  const list = listTurnstileProviders(config);
  return list.length > 0 ? list[0] : null;
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
 * @param {object} provider - getTurnstileProvider() / listTurnstileProviders() 返回的服务商配置
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
  };

  // CapSolver / YesCaptcha / 2Captcha 可带 userAgent；
  // Anti-Captcha 官方明确：自定义 User-Agent 无效且不应提交
  // https://anti-captcha.com/apidoc/task-types/TurnstileTaskProxyless
  if (provider.name !== 'AntiCaptcha') {
    task.userAgent = config.userAgent || '';
  }

  if (provider.supportsProxy) {
    task.proxyType = config.proxyType;
    task.proxyAddress = config.proxyAddress;
    task.proxyPort = parseInt(config.proxyPort, 10);
    if (config.proxyLogin) task.proxyLogin = config.proxyLogin;
    if (config.proxyPassword) task.proxyPassword = config.proxyPassword;
  }

  // CapSolver 用 metadata；YesCaptcha 仅需 websiteURL/websiteKey；
  // Anti-Captcha 用 action / cData / chlPageData（官方字段名）；
  // 2Captcha 用顶层 action / data / pagedata
  if (provider.name === 'CapSolver') {
    if (params.action || params.cData) {
      task.metadata = {};
      if (params.action) task.metadata.action = params.action;
      if (params.cData) task.metadata.cdata = params.cData;
    }
  } else if (provider.name === 'YesCaptcha') {
    // 官方文档无扩展字段
  } else if (provider.name === 'AntiCaptcha') {
    if (params.action) task.action = params.action;
    if (params.cData) task.cData = params.cData;
    if (params.chlPageData) task.chlPageData = params.chlPageData;
  } else {
    // 2Captcha 及其他同构协议
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
 * 构建 createTask 请求体（纯函数，便于单元测试）
 * - YesCaptcha：顶层 softID（注意大小写）
 * - Anti-Captcha：顶层 softId（官方 camelCase，可选）
 * @param {object} provider - getTurnstileProvider() 返回值
 * @param {object} task - buildTurnstileTask 返回的任务参数
 * @returns {object}
 */
export function buildCreateTaskPayload(provider, task) {
  const payload = {
    clientKey: provider.clientKey,
    task,
  };
  if (provider.name === 'YesCaptcha') {
    payload.softID = provider.softID ?? YESCAPTCHA_SOFT_ID;
  }
  // Anti-Captcha createTask 可选 softId（开发者分成）
  // 文档：https://anti-captcha.com/apidoc/methods/createTask
  if (provider.name === 'AntiCaptcha' && Number.isFinite(provider.softId)) {
    payload.softId = provider.softId;
  }
  return payload;
}

/**
 * 截断错误摘要（纯函数）
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string}
 */
export function truncateErrorSummary(text, maxLen = TURNSTILE_ERROR_SUMMARY_MAX_LEN) {
  const s = String(text || '');
  const limit = Math.max(32, Number(maxLen) || TURNSTILE_ERROR_SUMMARY_MAX_LEN);
  if (s.length <= limit) return s;
  const marker = `…(已截断,共${s.length}字)`;
  const bodyLen = Math.max(8, limit - marker.length);
  return `${s.slice(0, bodyLen)}${marker}`;
}

/**
 * 是否为 Turnstile 多平台全挂错误（优先读 error.code）
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTurnstileOutageError(error) {
  if (!error || typeof error !== 'object') {
    const msg = String(error || '');
    return msg.includes(TURNSTILE_ALL_PROVIDERS_FAILED)
      || msg.includes('Turnstile 多平台均失败');
  }
  const err = /** @type {{ code?: string, message?: string }} */ (error);
  if (err.code === TURNSTILE_ALL_PROVIDERS_FAILED) return true;
  const msg = String(err.message || '');
  return msg.includes(TURNSTILE_ALL_PROVIDERS_FAILED)
    || msg.includes('Turnstile 多平台均失败');
}

/**
 * 通过指定/默认提供商 API 求解 Turnstile token（单平台单次）
 * @param {string} websiteURL - 目标页面 URL
 * @param {object} params - { sitekey, action, cData, chlPageData }
 * @param {object} config - CONFIG 对象
 * @param {Function} logger - 日志函数
 * @param {number} timeout - 轮询超时（毫秒）
 * @param {object|null} [providerOverride] - 指定提供商；默认取链上第一家
 * @returns {Promise<{ token: string, userAgent: string|null, providerName: string }>}
 */
export async function solveTurnstileViaAPI(
  websiteURL,
  params,
  config,
  logger = () => {},
  timeout = 120_000,
  providerOverride = null,
) {
  const provider = providerOverride || getTurnstileProvider(config);
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

  const createPayload = buildCreateTaskPayload(provider, task);

  let createRes;
  try {
    createRes = await fetchWithTimeout(
      `${provider.apiBase}/createTask`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPayload),
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
      return { token, userAgent, providerName: provider.name };
    }

    logger(`${provider.name} 轮询中 (${i}/${maxPolls})... 状态: ${resultData.status || 'processing'}`);
  }

  throw new Error(`${provider.name} 轮询次数耗尽，求解失败`);
}

/**
 * 多平台串行 failover 求解 Turnstile
 * 对每个已配置提供商：连续失败 maxFailuresPerProvider 次后切换下一家；
 * 全部熔断后抛出 code=TURNSTILE_ALL_PROVIDERS_FAILED 的错误
 *
 * @param {string} websiteURL
 * @param {object} params
 * @param {object} config
 * @param {Function} [logger]
 * @param {object} [options]
 * @param {number} [options.timeout]
 * @param {number} [options.maxFailuresPerProvider]
 * @param {Function} [options.solveFn] - 可注入，便于单测
 * @returns {Promise<{ token: string, userAgent: string|null, providerName: string, attempts: object[] }>}
 */
export async function solveTurnstileWithFailover(
  websiteURL,
  params,
  config,
  logger = () => {},
  options = {},
) {
  const timeout = options.timeout ?? 120_000;
  const maxFailuresPerProvider = Math.max(
    1,
    Number(options.maxFailuresPerProvider) || DEFAULT_TURNSTILE_PROVIDER_MAX_FAILURES,
  );
  const solveFn = options.solveFn || solveTurnstileViaAPI;

  const providers = listTurnstileProviders(config);
  if (providers.length === 0) {
    throw new Error('未配置 Turnstile 求解 API 密钥');
  }

  const chain = providers.map((p) => p.name).join(' → ');
  logger(`Turnstile 多平台链路: ${chain}（每平台最多连续失败 ${maxFailuresPerProvider} 次后切换）`);

  /** @type {{ provider: string, success: boolean, failures: number, lastError?: string }[]} */
  const attempts = [];
  /** @type {{ provider: string, attempt: number, error: string }[]} */
  const allErrors = [];

  for (const provider of providers) {
    let consecutiveFailures = 0;
    let lastError = '';

    while (consecutiveFailures < maxFailuresPerProvider) {
      const tryNo = consecutiveFailures + 1;
      try {
        logger(`▶ ${provider.name} 第 ${tryNo}/${maxFailuresPerProvider} 次尝试...`);
        const result = await solveFn(websiteURL, params, config, logger, timeout, provider);
        attempts.push({
          provider: provider.name,
          success: true,
          failures: consecutiveFailures,
        });
        logger(`✅ ${provider.name} 求解成功（本平台此前失败 ${consecutiveFailures} 次）`);
        return {
          token: result.token,
          userAgent: result.userAgent ?? null,
          providerName: provider.name,
          attempts: [...attempts],
        };
      } catch (error) {
        consecutiveFailures += 1;
        lastError = truncateErrorSummary(error?.message || String(error), 200);
        allErrors.push({
          provider: provider.name,
          attempt: consecutiveFailures,
          error: lastError,
        });
        logger(`✖ ${provider.name} 第 ${consecutiveFailures}/${maxFailuresPerProvider} 次失败: ${lastError}`);
      }
    }

    attempts.push({
      provider: provider.name,
      success: false,
      failures: consecutiveFailures,
      lastError,
    });
    const isLast = provider === providers[providers.length - 1];
    if (!isLast) {
      logger(`⚡ ${provider.name} 已熔断（连续 ${maxFailuresPerProvider} 次失败），切换下一平台`);
    }
  }

  const summary = truncateErrorSummary(
    allErrors
      .map((e) => `${e.provider}#${e.attempt}: ${e.error}`)
      .join('; '),
  );
  const err = new Error(
    `Turnstile 多平台均失败（链路: ${chain}）: ${summary}`,
  );
  err.code = TURNSTILE_ALL_PROVIDERS_FAILED;
  err.attempts = attempts;
  err.errors = allErrors;
  err.providerNames = providers.map((p) => p.name);
  throw err;
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
