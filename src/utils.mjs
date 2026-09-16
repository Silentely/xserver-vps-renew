/**
 * 通用纯工具函数
 * 日志脱敏、东京时区日期、带超时的 fetch、HTML 转义、Chrome 路径探测、锁文件清理
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** 东京时区相对 UTC 的固定偏移（毫秒），日本无夏令时 */
export const TOKYO_OFFSET_MS = 9 * 3600_000;

/** 项目 GitHub 仓库地址（启动日志与失败通知共用，唯一来源） */
export const PROJECT_REPO_URL = 'https://github.com/Silentely/xserver-vps-renew';

/** 项目版权署名（MIT 许可要求保留版权声明；单一来源，可随时改名） */
export const PROJECT_COPYRIGHT = '© 2026 Silentely';

/** 源项目标识行：启动横幅与各类通知尾部统一展示，让使用者始终知晓第一来源（防冒充/转售） */
export const PROJECT_SOURCE_LINE = `🔗 源项目: ${PROJECT_REPO_URL} · ${PROJECT_COPYRIGHT}（MIT License）`;

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
  const raw = String(value ?? '').trim();
  // 严格整数校验：仅接受纯数字。环境变量被意外拼接（如 "30000ms"）时回退默认，
  // 不再静默取数字前缀，避免超时/重试参数被错误放大或缩小。
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
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

/** 日志级别标签（输出行中插入，便于 docker logs 按级别过滤/告警采集） */
const LOG_LEVEL_TAG = {
  [LOG_LEVEL_DEBUG]: '[DEBUG]',
  [LOG_LEVEL_INFO]: '[INFO]',
  [LOG_LEVEL_WARN]: '[WARN]',
  [LOG_LEVEL_ERROR]: '[ERROR]',
};

/**
 * 格式化单条日志行（纯函数，供主脚本 emitLog 使用）
 * 输出形如 `2026-08-07 12:00:00 [INFO] 消息`；error 消息未带 ❌ 前缀时自动补充
 * @param {string} stamp - 时间戳（YYYY-MM-DD HH:mm:ss）
 * @param {string} level - debug|info|warn|error
 * @param {unknown} msg - 日志内容
 * @returns {string} 完整日志行
 */
export function formatLogLine(stamp, level, msg) {
  const text = String(msg ?? '');
  const tag = LOG_LEVEL_TAG[level] || LOG_LEVEL_TAG[LOG_LEVEL_INFO];
  const base = `${stamp} ${tag}`;
  if (level === LOG_LEVEL_ERROR && !text.startsWith('❌')) {
    return `${base} ❌ ${text}`;
  }
  return `${base} ${text}`;
}

/**
 * 截断超长日志消息（防 docker logs 刷屏；保留截断标记）
 * 错误堆栈/诊断片段可能数千字符，正常日志不受影响
 * @param {unknown} msg
 * @param {number} [maxLen=3000] - 截断上限（字符）
 * @returns {string}
 */
export function clampLogMessage(msg, maxLen = 3000) {
  const s = String(msg ?? '');
  const limit = Math.max(128, Number(maxLen) || 3000);
  if (s.length <= limit) return s;
  const marker = `…(日志过长已截断,共${s.length}字符)`;
  const bodyLen = Math.max(32, limit - marker.length);
  return `${s.slice(0, bodyLen)}${marker}`;
}

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
 * 空日志对象（src 模块 logger 参数的默认值）
 * 模块按级别调用 logger.info/debug/warn/error，级别决策归属模块而非调用方
 */
export const NOOP_LOGGER = Object.freeze({
  info() {},
  debug() {},
  warn() {},
  error() {},
});

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

/**
 * 转义 HTML 特殊字符（Telegram parse_mode=HTML）
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * formatLogTimestamp 的 DateTimeFormat 缓存（按 timeZone 复用）
 * Intl.DateTimeFormat 构造是日志输出路径上最重的对象，每条日志新建不划算；
 * tz 实际取值仅 TZ 环境变量一两种，缓存基数极小无需上限
 */
const LOG_TIMESTAMP_FORMATTERS = new Map();

/** 按 timeZone 取（或惰性创建）共享的日志时间戳 formatter */
function getLogTimestampFormatter(tz) {
  let formatter = LOG_TIMESTAMP_FORMATTERS.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    });
    LOG_TIMESTAMP_FORMATTERS.set(tz, formatter);
  }
  return formatter;
}

/**
 * 格式化日志时间戳（YYYY-MM-DD HH:mm:ss，时区取 TZ 环境变量，默认 Asia/Tokyo）
 * locale 无关、固定宽度，避免不同 Node 版本 toLocaleString 输出漂移（如年份格式/24 点制差异）
 * @param {number|Date} [when=Date.now()]
 * @param {string} [tz=process.env.TZ || 'Asia/Tokyo']
 * @returns {string}
 */
export function formatLogTimestamp(when = Date.now(), tz = process.env.TZ || 'Asia/Tokyo') {
  const d = when instanceof Date ? when : new Date(when);
  const parts = getLogTimestampFormatter(tz).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * 按东京时区格式化日期时间（固定宽度 YYYY-MM-DD HH:mm:ss，与日志时间戳同一实现）
 * 时区取 TZ 环境变量（与日志 ts() 一致），默认 Asia/Tokyo。
 * 2026-08-07 起委托 formatLogTimestamp：通知与日志格式统一，便于 docker logs 对账。
 * @param {Date|number} [when=new Date()]
 * @returns {string}
 */
export function formatTokyoDateTime(when = new Date()) {
  return formatLogTimestamp(when, process.env.TZ || 'Asia/Tokyo');
}

/**
 * 探测 Chrome 可执行文件路径（Linux 容器优先，macOS 兜底）
 * @returns {string} 找到的路径或默认命令名
 */
export function findChromePath() {
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => existsSync(p)) || 'google-chrome-stable';
}

/**
 * 分析浏览器指纹健康度（纯函数，供主脚本启动时体检）
 * webdriver=true 是 stealth 失效的最强信号；设备内存/核心数异常也可能被检测
 * @param {object} fingerprint - { webdriver, deviceMemory, hardwareConcurrency }
 * @returns {string[]} 风险提示列表（空数组表示健康）
 */
export function analyzeFingerprintHealth(fingerprint = {}) {
  const risks = [];
  if (fingerprint.webdriver === true) {
    risks.push('检测到 navigator.webdriver=true：Stealth 反检测可能失效，被 Cloudflare 识别的风险极高');
  }
  const mem = Number(fingerprint.deviceMemory);
  if (Number.isFinite(mem) && mem <= 0) {
    risks.push('deviceMemory 异常（<=0）：指纹与真实浏览器差异明显');
  }
  const cores = Number(fingerprint.hardwareConcurrency);
  if (Number.isFinite(cores) && cores <= 0) {
    risks.push('hardwareConcurrency 异常（<=0）：指纹与真实浏览器差异明显');
  }
  return risks;
}

/**
 * 是否保存 Turnstile 求解前后截图（纯函数）
 * 默认仅 LOG_LEVEL=debug 时写盘，避免默认级别下每轮运行向 /tmp 累积无用截图
 * （容器内 /tmp 是有限资源，截图通常仅排查时有用）；
 * 显式设置 SAVE_TURNSTILE_SCREENSHOTS=true 时可在 info 级别强制开启（故障排查）。
 * @param {object} [config] - CONFIG 对象（含 LOG_LEVEL / SAVE_TURNSTILE_SCREENSHOTS）
 * @returns {boolean}
 */
export function shouldSaveTurnstileScreenshot(config) {
  if (!config || typeof config !== 'object') return false;
  if (config.SAVE_TURNSTILE_SCREENSHOTS === true) return true;
  return config.LOG_LEVEL === 'debug';
}

/**
 * 清理 Chrome 用户数据目录中的残留锁文件
 * 避免异常退出后下次启动报 SingletonLock 错误
 * @param {string} userDataDir
 */
export function cleanChromeLocks(userDataDir) {
  if (!userDataDir) return;
  for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = join(userDataDir, lock);
    try { rmSync(lockPath, { force: true }); } catch { /* 忽略 */ }
  }
}

/**
 * 清理 Chrome 用户数据目录中的临时缓存与崩溃转储文件
 * 仅清理易产生大文件占用的临时缓存，严格保留 Cookies / Local Storage / Preferences 等会话数据
 * @param {string} userDataDir
 */
export function cleanChromeCaches(userDataDir) {
  if (!userDataDir) return;
  const ephemeralDirs = [
    'Default/Cache',
    'Default/Code Cache',
    'Default/GPUCache',
    'Default/DawnWebGPUCache',
    'GrShaderCache',
    'ShaderCache',
    'Crashpad',
  ];
  for (const dir of ephemeralDirs) {
    const p = join(userDataDir, dir);
    try {
      rmSync(p, { recursive: true, force: true });
    } catch { /* 忽略 */ }
  }
}

/** 已知埋点/统计域名：请求被页面导航中止属正常现象，debug 日志降噪用 */
const BENIGN_TRACKING_HOSTS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'googleadservices.com',
  'doubleclick.net',
  'apm.yahoo.co.jp',
];

/**
 * 是否为可忽略的埋点类请求失败（纯函数）
 * 页面跳转时 Google Analytics / 广告回传等 beacon 请求被浏览器中止（ERR_ABORTED）
 * 属正常现象；命中已知埋点域名的失败不写入 debug 日志，避免刷屏挤占条数上限，
 * 让「请求失败」日志只保留对排障有意义的请求（xserver 面板 / Cloudflare 挑战等）
 * @param {string} url - 失败的请求 URL
 * @returns {boolean}
 */
export function isBenignRequestFailure(url) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  // 命中埋点域名（含子域，如 www.google-analytics.com / stats.g.doubleclick.net）
  if (BENIGN_TRACKING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  // google.com 的广告/转化回传（ccm/rmkt collect）同样在导航时被中止
  return (host === 'google.com' || host === 'www.google.com')
    && /^\/(ccm|rmkt)\/collect/.test(parsed.pathname);
}
