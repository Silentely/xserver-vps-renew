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
