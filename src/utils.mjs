/**
 * 通用纯工具函数
 * 日志脱敏、东京时区日期、带超时的 fetch 等
 */

/** 东京时区相对 UTC 的固定偏移（毫秒），日本无夏令时 */
export const TOKYO_OFFSET_MS = 9 * 3600_000;

/**
 * 脱敏代理/主机地址：保留末尾 4 个字符，其余替换为 *
 * 长度 ≤4 时原样返回（每个字符后不足 4 位，正则不匹配）
 * @param {string} address - 原始地址
 * @returns {string}
 */
export function maskProxyAddress(address) {
  if (!address || typeof address !== 'string') return '';
  return address.replace(/.(?=.{4})/g, '*');
}

/**
 * 按东京时区返回 YYYY-MM-DD 日期字符串
 * @param {number} [nowMs=Date.now()] - 基准时间戳（毫秒）
 * @param {number} [dayOffset=0] - 相对今天的天数偏移（1=明天，-1=昨天）
 * @returns {string}
 */
export function getTokyoDateString(nowMs = Date.now(), dayOffset = 0) {
  const tokyoMs = nowMs + TOKYO_OFFSET_MS + dayOffset * 86400_000;
  return new Date(tokyoMs).toISOString().slice(0, 10);
}

/**
 * 带超时的 fetch 封装
 * @param {string} url - 请求 URL
 * @param {RequestInit} [options={}] - fetch 选项（可含 signal，会与超时合并）
 * @param {number} [timeoutMs=30000] - 超时毫秒
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // 若调用方已提供 signal，在其 abort 时同步中止
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timeoutId);
      controller.abort();
    } else {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 解析正整数环境变量，非法时回退默认值
 * @param {string|undefined|null} value - 原始值
 * @param {number} fallback - 默认值
 * @param {{ min?: number, max?: number }} [opts]
 * @returns {number}
 */
export function parsePositiveInt(value, fallback, opts = {}) {
  const min = opts.min ?? 1;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  const n = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * 解析布尔环境变量
 * 支持 true/false、1/0、yes/no、on/off（大小写不敏感）；空值回退默认
 * @param {string|undefined|null} value
 * @param {boolean} [fallback=false]
 * @returns {boolean}
 */
export function parseEnvBool(value, fallback = false) {
  if (value == null || String(value).trim() === '') return Boolean(fallback);
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return Boolean(fallback);
}

/** 日志级别（由低到高） */
export const LOG_LEVEL_DEBUG = 'debug';
export const LOG_LEVEL_INFO = 'info';
export const LOG_LEVEL_WARN = 'warn';
export const LOG_LEVEL_ERROR = 'error';

/** 默认日志级别 */
export const DEFAULT_LOG_LEVEL = LOG_LEVEL_INFO;

/** 级别权重（数值越大越“吵”侧越少输出） */
const LOG_LEVEL_RANK = {
  [LOG_LEVEL_DEBUG]: 10,
  [LOG_LEVEL_INFO]: 20,
  [LOG_LEVEL_WARN]: 30,
  [LOG_LEVEL_ERROR]: 40,
};

/**
 * 解析 LOG_LEVEL 环境变量
 * 支持 debug/verbose/trace → debug；info/log/normal → info；warn；error/quiet → error
 * @param {string|undefined|null} value
 * @param {string} [fallback=DEFAULT_LOG_LEVEL]
 * @returns {'debug'|'info'|'warn'|'error'}
 */
export function parseLogLevel(value, fallback = DEFAULT_LOG_LEVEL) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === LOG_LEVEL_DEBUG || v === 'verbose' || v === 'trace') return LOG_LEVEL_DEBUG;
  if (v === LOG_LEVEL_INFO || v === 'log' || v === 'normal' || v === 'default') {
    return LOG_LEVEL_INFO;
  }
  if (v === LOG_LEVEL_WARN || v === 'warning') return LOG_LEVEL_WARN;
  if (v === LOG_LEVEL_ERROR || v === 'err' || v === 'quiet' || v === 'silent') {
    return LOG_LEVEL_ERROR;
  }
  const fb = String(fallback ?? '').trim().toLowerCase();
  if (fb === LOG_LEVEL_DEBUG || fb === LOG_LEVEL_WARN || fb === LOG_LEVEL_ERROR) {
    return fb;
  }
  return DEFAULT_LOG_LEVEL;
}

/**
 * 当前配置级别是否应输出该条日志
 * @param {string} configuredLevel - 用户配置的最低输出级别
 * @param {string} messageLevel - 本条日志级别
 * @returns {boolean}
 */
export function shouldLog(configuredLevel, messageLevel) {
  const cfg = LOG_LEVEL_RANK[parseLogLevel(configuredLevel)] ?? LOG_LEVEL_RANK[LOG_LEVEL_INFO];
  const msg = LOG_LEVEL_RANK[parseLogLevel(messageLevel, LOG_LEVEL_INFO)]
    ?? LOG_LEVEL_RANK[LOG_LEVEL_INFO];
  return msg >= cfg;
}

/**
 * 模块日志是否应降为 debug（轮询/原始响应/任务参数等噪音）
 * @param {unknown} message
 * @returns {boolean}
 */
export function isNoisyModuleLog(message) {
  const s = String(message ?? '');
  if (!s) return false;
  return (
    s.includes('任务参数:')
    || s.includes('轮询中')
    || s.includes('getTaskResult 网络异常')
    || s.includes('getTaskResult HTTP')
    || s.includes('瞬态 init')
    || s.includes('原始结果')
    || s.includes('响应状态')
    || s.includes('使用住宅代理:')
    || /sitekey=[0-9a-f]{8,}/i.test(s)
  );
}

/**
 * 校验续期脚本必填配置
 * @param {object} config - 配置对象
 * @returns {string[]} - 缺失项描述列表，空数组表示通过
 */
export function validateRequiredConfig(config) {
  if (!config || typeof config !== 'object') {
    return ['配置对象无效'];
  }
  const missing = [];
  if (!config.MEMBER_ID) missing.push('XSERVER_MEMBER_ID');
  if (!config.PASSWORD) missing.push('XSERVER_PASSWORD');
  if (!config.CAPTCHA_API) missing.push('CAPTCHA_API');
  if (config.CAPTCHA_API && typeof config.CAPTCHA_API === 'string') {
    try {
      const u = new URL(config.CAPTCHA_API);
      if (!['http:', 'https:'].includes(u.protocol)) {
        missing.push(`CAPTCHA_API 协议无效（当前: "${u.protocol}"）`);
      }
    } catch {
      missing.push(`CAPTCHA_API 不是合法 URL（当前: "${config.CAPTCHA_API}"）`);
    }
  }
  if (config.PROXY_PORT && !/^\d+$/.test(String(config.PROXY_PORT))) {
    missing.push(`PROXY_PORT 必须是数字（当前: "${config.PROXY_PORT}"）`);
  }
  if (config.PROXY_TYPE && !['http', 'socks4', 'socks5'].includes(config.PROXY_TYPE)) {
    missing.push(`PROXY_TYPE 必须是 http/socks4/socks5（当前: "${config.PROXY_TYPE}"）`);
  }
  const hasAnyProxy = !!(config.PROXY_TYPE || config.PROXY_ADDRESS || config.PROXY_PORT);
  const hasFullProxy = !!(config.PROXY_TYPE && config.PROXY_ADDRESS && config.PROXY_PORT);
  if (hasAnyProxy && !hasFullProxy) {
    missing.push('代理配置不完整（需同时设置 PROXY_TYPE、PROXY_ADDRESS、PROXY_PORT）');
  }
  return missing;
}
