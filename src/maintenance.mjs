/**
 * 官方维护（503 智能降级）模块
 * 探测登录页是否命中 Xserver 官方维护页，并在命中时抛出带 code='MAINTENANCE' 的
 * MaintenanceError（供主流程识别为「不可重试」场景）；同时负责「维护提醒」的同日去重。
 *
 * 判定原则（宁可漏判走原失败流程，不可误判吞掉真实故障）：
 * - 主判据：page.goto 返回的 HTTP 状态码 ∈ 可配置的 MAINTENANCE_HTTP_CODES（默认 503/502/504）
 * - 辅助判据（命中其一才确认）：
 *   1. 响应体/标题匹配可配置关键词 MAINTENANCE_KEYWORDS（默认 メンテナンス / 一時停止 / 保守）
 *   2. 页面缺少 #memberid 登录表单（状态码非 200 时，说明不是真实登录页但显示为维护态）
 * - 仅当状态码归属维护码 + 辅助判据命中才降级；否则返回 null 走原有流程。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NOOP_LOGGER, getLocalDateString } from './utils.mjs';
import { hasRenewedToday, hasTodaySkipCoverage } from './renewal-status.mjs';

/** MaintenanceError 的专用 code（供主流程与 cron-run 识别） */
export const MAINTENANCE_ERROR_CODE = 'MAINTENANCE';

/** 官方维护专用退出码：当日已续期/已保障，静默跳过（cron 识别后不重试） */
export const EXIT_MAINTENANCE_RENEWED = 75;

/** 官方维护专用退出码：当日未续期，已发送（或按开关关闭）维护提醒（cron 识别后不重试） */
export const EXIT_MAINTENANCE_NOTIFIED = 76;

/** 维护降级动作 */
export const MAINTENANCE_ACTION = {
  /** 当日已续期/已保障：静默跳过，不发通知 */
  SILENT_SKIP: 'silent_skip',
  /** 当日未续期：发送维护提醒（同日去重后） */
  SEND_NOTICE: 'send_notice',
  /** 当日未续期，但今日已发过提醒：不再重复发送 */
  DEDUP_SKIP: 'dedup_skip',
};

/** 默认维护 HTTP 状态码集合（官方维护时 return 503；502/504 为网关类维护兜底） */
export const DEFAULT_MAINTENANCE_HTTP_CODES = [503, 502, 504];

/** 默认维护关键词（命中其一即确认；官方换文案时可经 MAINTENANCE_KEYWORDS 免改代码） */
export const DEFAULT_MAINTENANCE_KEYWORDS = ['メンテナンス', '一時停止', '保守'];

/** 维护提醒去重文件默认路径（与 Chrome 用户数据同目录，便于 Docker 单卷持久化） */
export const DEFAULT_MAINTENANCE_NOTICE_FILE = '/data/chrome-profile/maintenance-notice.json';

/** 是否是维护专用异常 */
export function isMaintenanceError(error) {
  return Boolean(error && typeof error === 'object' && error.code === MAINTENANCE_ERROR_CODE);
}

/**
 * 官方维护专用错误：登录页命中 503 维护态，不可重试（cron 识别后直接结束本轮）。
 * @param {object} opts
 * @param {number} opts.status - HTTP 状态码
 * @param {string|null} [opts.keyword] - 命中的维护关键词（未命中时为 null，表示靠无登录表单判定）
 * @param {string} [opts.pageUrl] - 命中时的页面 URL（便于 Telegram 诊断）
 */
export class MaintenanceError extends Error {
  constructor({ status, keyword = null, pageUrl = '' } = {}) {
    const reason = keyword ? `关键词「${keyword}」` : '页面无登录表单';
    const urlPart = pageUrl ? `（${pageUrl}）` : '';
    super(`面板因官方维护暂停（HTTP ${status}，${reason}）${urlPart}`);
    this.name = 'MaintenanceError';
    this.code = MAINTENANCE_ERROR_CODE;
    this.status = status;
    this.keyword = keyword || null;
  }
}

/**
 * 解析 MAINTENANCE_HTTP_CODES 环境变量（逗号分隔整数）
 * @param {string|null|undefined} str
 * @returns {number[]|null} 解析失败时返回 null（调用方回退默认）
 */
export function parseMaintenanceHttpCodes(str) {
  if (str == null || typeof str !== 'string' || String(str).trim() === '') return null;
  const codes = String(str)
    .split(',')
    .map((s) => parseInt(String(s).trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 100 && n < 600);
  return codes.length > 0 ? codes : null;
}

/**
 * 解析 MAINTENANCE_KEYWORDS 环境变量（逗号分隔关键词）
 * @param {string|null|undefined} str
 * @returns {string[]|null} 解析失败时返回 null（调用方回退默认）
 */
export function parseMaintenanceKeywords(str) {
  if (str == null || typeof str !== 'string' || String(str).trim() === '') return null;
  const list = String(str)
    .split(',')
    .map((s) => String(s).trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/**
 * 在文本中匹配任一维护关键词（纯函数，供单测）
 * @param {string|null|undefined} text
 * @param {string[]} [keywords=DEFAULT_MAINTENANCE_KEYWORDS]
 * @returns {string|null} 命中的关键词；未命中返回 null
 */
export function matchMaintenanceKeyword(text, keywords = DEFAULT_MAINTENANCE_KEYWORDS) {
  if (!text) return null;
  const list = Array.isArray(keywords) ? keywords : [];
  return list.find((k) => k && text.includes(k)) || null;
}

/**
 * 探测是否命中官方维护页（纯 Puppeteer 交互，可在 navigateToLoginPage 的 goto 之后调用）
 * @param {object} opts
 * @param {import('puppeteer').HTTPResponse|null|undefined} opts.response - page.goto 的响应
 * @param {import('puppeteer').Page} opts.page
 * @param {number[]} [opts.httpCodes=DEFAULT_MAINTENANCE_HTTP_CODES]
 * @param {string[]} [opts.keywords=DEFAULT_MAINTENANCE_KEYWORDS]
 * @param {object} [opts.logger=NOOP_LOGGER] - debug 日志对象
 * @returns {Promise<{ error: MaintenanceError, status: number, keyword: string|null }|null>}
 *   null 表示未命中维护（走原有流程）；命中返回异常与命中信息
 */
export async function detectMaintenance({ response, page, httpCodes, keywords, logger = NOOP_LOGGER } = {}) {
  if (!response) return null;
  const codes = Array.isArray(httpCodes) && httpCodes.length > 0 ? httpCodes : DEFAULT_MAINTENANCE_HTTP_CODES;
  const kwList = Array.isArray(keywords) && keywords.length > 0 ? keywords : DEFAULT_MAINTENANCE_KEYWORDS;
  const status = response.status();

  // 主判据：状态码归属维护码；否则视为正常/其他错误，不做降级（宁可漏判不可误判）
  if (!codes.includes(status)) return null;

  // 辅助判据：响应体/标题匹配关键词（优先），或页面缺少 #memberid 登录表单
  let keyword = null;
  try {
    const responseText = await response.text();
    const domTitle = await page.title().catch(() => '');
    keyword = matchMaintenanceKeyword(`${responseText} ${domTitle}`, kwList);
  } catch {
    /* 读取响应体异常时继续尝试 #memberid 兜底 */
  }

  let missingMemberId = false;
  if (!keyword) {
    try {
      missingMemberId = !(await page.$('#memberid'));
    } catch {
      missingMemberId = false;
    }
  }

  if (!keyword && !missingMemberId) return null;

  let pageUrl = '';
  try {
    pageUrl = page.url();
  } catch {
    /* 忽略 */
  }
  const error = new MaintenanceError({ status, keyword, pageUrl });
  logger.debug?.(`维护探测: 状态码=${status} 关键词=${keyword || '无'} 缺memberid=${missingMemberId}`);
  return { error, status, keyword };
}

/**
 * 读取维护提醒去重记录（旧文件缺失字段/不存在均返回 null，兼容冷启动）
 * @param {string} filePath
 * @param {object} [logger=NOOP_LOGGER]
 * @returns {{ lastMaintenanceNoticeAt: string|null }}
 */
export function readMaintenanceNotice(filePath = DEFAULT_MAINTENANCE_NOTICE_FILE, logger = NOOP_LOGGER) {
  try {
    const data = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data);
    const last = parsed && typeof parsed === 'object' ? parsed.lastMaintenanceNoticeAt : null;
    return { lastMaintenanceNoticeAt: typeof last === 'string' && last ? last : null };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn?.(`读取维护提醒记录异常: ${error.message}，重置为空`);
    }
    return { lastMaintenanceNoticeAt: null };
  }
}

/**
 * 写入维护提醒去重记录（写入失败不抛出，避免影响主流程）
 * @param {string} filePath
 * @param {string} localDate - 本地时区日期（YYYY-MM-DD）
 * @param {object} [logger=NOOP_LOGGER]
 * @returns {boolean} 是否写入成功
 */
export function recordMaintenanceNotice(filePath, localDate, logger = NOOP_LOGGER) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ lastMaintenanceNoticeAt: localDate }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return true;
  } catch (error) {
    logger.warn?.(`写入维护提醒记录失败: ${error.message}`);
    return false;
  }
}

/**
 * 是否应发送维护提醒（同日去重：上次发送日期与当前本地日相同则不再发送）
 * @param {string|null} lastSentDate - 上次发送的本地日期
 * @param {string} todayKey - 当前本地日期（YYYY-MM-DD）
 * @returns {boolean}
 */
export function shouldSendMaintenanceNotice(lastSentDate, todayKey) {
  return lastSentDate !== todayKey;
}

/**
 * 当前本地时区日期字符串（供维护提醒去重使用）
 * @param {number|Date} [when=Date.now()]
 * @param {string} [tz=process.env.TZ || 'Asia/Tokyo']
 * @returns {string}
 */
export function formatLocalDateKey(when = Date.now(), tz = process.env.TZ || 'Asia/Tokyo') {
  return getLocalDateString(when, tz);
}

/**
 * 维护命中后的分流决策（纯函数，供主流程与验收测试共用）
 * 核心规则：
 * - 当日已续期（success && !skipped && newExpireDate）→ 静默跳过
 * - 当日仅有 skipped（无需续期）记录 → 同样视为已保障，静默跳过（边界决策）
 * - 当日未续期：当日未发过提醒 → 发送；已发过 → 去重跳过
 * @param {object} opts
 * @param {Array} opts.records - 续期记录
 * @param {string|null} [opts.lastMaintenanceNoticeAt] - 上次维护提醒发送日期（本地时区）
 * @param {string} opts.todayKey - 当前本地日期（YYYY-MM-DD）
 * @param {number} [opts.now=Date.now()] - 基准时间
 * @param {string} [opts.tz=process.env.TZ || 'Asia/Tokyo'] - 本地时区
 * @returns {{
 *   action: 'silent_skip'|'send_notice'|'dedup_skip',
 *   exitCode: number,
 *   renewedToday: boolean,
 *   skipCoveredToday: boolean,
 * }}
 */
export function resolveMaintenanceOutcome({
  records,
  lastMaintenanceNoticeAt = null,
  todayKey,
  now = Date.now(),
  tz = process.env.TZ || 'Asia/Tokyo',
} = {}) {
  const renewedToday = hasRenewedToday(records, { now, tz });
  // 边界决策：当日仅有 skipped（无需续期）记录，也视为已保障，走静默跳过
  const skipCoveredToday = hasTodaySkipCoverage(records, { now, tz });

  if (renewedToday || skipCoveredToday) {
    return {
      action: MAINTENANCE_ACTION.SILENT_SKIP,
      exitCode: EXIT_MAINTENANCE_RENEWED,
      renewedToday,
      skipCoveredToday,
    };
  }
  if (!shouldSendMaintenanceNotice(lastMaintenanceNoticeAt, todayKey)) {
    return {
      action: MAINTENANCE_ACTION.DEDUP_SKIP,
      exitCode: EXIT_MAINTENANCE_NOTIFIED,
      renewedToday,
      skipCoveredToday,
    };
  }
  return {
    action: MAINTENANCE_ACTION.SEND_NOTICE,
    exitCode: EXIT_MAINTENANCE_NOTIFIED,
    renewedToday,
    skipCoveredToday,
  };
}
