/**
 * 续期结果持久化与监控模块
 * 负责续期记录读写、健康状态查询、连续失败统计
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, accessSync, constants } from 'node:fs';
import { dirname } from 'node:path';

/** 默认状态文件路径（与 Chrome 用户数据同目录，便于 Docker 单卷持久化） */
export const DEFAULT_STATUS_FILE = '/data/chrome-profile/renewal-status.json';

/** 默认连续失败告警阈值 */
export const DEFAULT_ALERT_AFTER_FAILURES = 3;

/** 默认最大保留记录数 */
const DEFAULT_MAX_RECORDS = 30;

/**
 * 默认控制台 logger（未注入 logger 参数时使用，保持向后兼容）
 * 与主脚本 LOGGER 同构：{ warn, error }；注入后时间戳/级别标签由主脚本统一输出
 */
const CONSOLE_LOGGER = {
  warn: (msg) => console.warn(`[renewal-status] ${msg}`),
  error: (msg) => console.error(`[renewal-status] ❌ ${msg}`),
};

/**
 * 解析状态文件中持久化的连续成功次数
 * 旧格式文件（或字段被破坏）无有效值时返回 null，由调用方回退到按记录统计
 * @param {unknown} value - 状态文件中的 successStreak 字段
 * @returns {number|null} - 非负整数，无法识别时为 null
 */
function parsePersistedStreak(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 读取续期状态历史
 * @param {string} filePath - 状态文件路径
 * @param {{ warn?: Function, error?: Function }} [logger=CONSOLE_LOGGER] - 分级日志对象
 * @returns {object} - { records: [...], lastRecord: object|null, successStreak: number }
 */
export function readRenewalStatus(filePath = DEFAULT_STATUS_FILE, logger = CONSOLE_LOGGER) {
  try {
    const data = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
      return { records: [], lastRecord: null, successStreak: 0 };
    }
    // 连续成功次数是独立持久化字段，与 records 的 30 条滚动窗口解耦，
    // 否则「每日 1 次成功 + 5 次跳过」的部署会把计数封顶在窗口内的成功条数；
    // 旧格式文件缺失该字段时按现有记录回退统计，升级后首次写入即补齐
    const persistedStreak = parsePersistedStreak(parsed.successStreak);
    return {
      records: parsed.records,
      lastRecord: parsed.records.length > 0 ? parsed.records[parsed.records.length - 1] : null,
      successStreak: persistedStreak ?? countConsecutiveSuccesses(parsed.records),
    };
  } catch (error) {
    // 文件不存在属于正常冷启动，静默返回空状态
    if (error.code !== 'ENOENT') {
      logger.warn(`读取状态文件异常: ${error.message}，重置为空记录`);
    }
    return { records: [], lastRecord: null, successStreak: 0 };
  }
}

/**
 * 写入续期状态记录（原子写：temp + rename）
 * @param {object} record - 续期记录
 * @param {string} filePath - 状态文件路径
 * @param {number} maxRecords - 最大保留记录数
 * @param {{ warn?: Function, error?: Function }} [logger=CONSOLE_LOGGER] - 分级日志对象
 * @throws {Error} 目录不可写或写入失败时抛出
 */
export function writeRenewalStatus(record, filePath = DEFAULT_STATUS_FILE, maxRecords = DEFAULT_MAX_RECORDS, logger = CONSOLE_LOGGER) {
  const { records, successStreak } = readRenewalStatus(filePath, logger);
  records.push(record);
  const trimmed = records.slice(-Math.max(1, maxRecords));
  const nextStreak = nextSuccessStreak(successStreak, record);
  const dir = dirname(filePath);

  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    // 目录已存在时 mkdir 可能报错，后续 accessSync / write 会再次校验
    if (error.code !== 'EEXIST') {
      logger.warn(`创建目录 ${dir} 失败: ${error.message}`);
    }
  }

  try {
    accessSync(dir, constants.W_OK);
  } catch {
    const msg = `目录 ${dir} 不可写，请检查挂载卷权限（容器内需 appuser 可写）`;
    logger.error(msg);
    throw new Error(msg);
  }

  const tmpPath = `${filePath}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify({ successStreak: nextStreak, records: trimmed }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
  } catch (error) {
    const msg = `写入状态文件失败: ${error.message}`;
    logger.error(msg);
    throw new Error(msg);
  }
}

/**
 * 构建续期结果记录对象（纯函数）
 * @param {object} params - 结果参数
 * @returns {object} - 标准化的续期记录
 */
export function buildRenewalRecord({
  success,
  serverName,
  plan,
  oldExpireDate,
  newExpireDate,
  errorMessage,
  skipped = false,
}) {
  return {
    timestamp: new Date().toISOString(),
    success: !!success,
    skipped: !!skipped,
    serverName: serverName || null,
    plan: plan || null,
    oldExpireDate: oldExpireDate || null,
    newExpireDate: newExpireDate || null,
    errorMessage: errorMessage || null,
  };
}

/**
 * 计算连续失败次数（从记录尾部向前统计）
 * 跳过类记录（skipped=true）不计入失败也不中断连败
 * @param {Array} records - 续期记录数组
 * @returns {number} - 连续失败次数
 */
export function countConsecutiveFailures(records) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  let count = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (!rec || rec.skipped) continue;
    if (!rec.success) count++;
    else break;
  }
  return count;
}

/**
 * 计算连续成功次数（从记录尾部向前统计）
 * 跳过类记录（skipped=true）不计入成功也不中断连成功
 * @param {Array} records - 续期记录数组
 * @returns {number} - 连续成功次数
 */
export function countConsecutiveSuccesses(records) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  let count = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (!rec || rec.skipped) continue;
    if (rec.success) count++;
    else break;
  }
  return count;
}

/**
 * 计算追加本条记录后的连续成功次数（纯函数）
 * 成功 +1、失败清零、跳过记录不变（不计入也不中断）
 * @param {number} currentStreak - 当前连续成功次数
 * @param {object} record - 即将追加的续期记录
 * @returns {number} - 追加后的连续成功次数
 */
export function nextSuccessStreak(currentStreak, record) {
  const base = Number.isInteger(currentStreak) && currentStreak >= 0 ? currentStreak : 0;
  if (!record || record.skipped) return base;
  return record.success ? base + 1 : 0;
}

/**
 * 获取续期健康状态
 * @param {string} filePath - 状态文件路径
 * @param {number} alertThreshold - 连续失败告警阈值
 * @param {{ warn?: Function, error?: Function }} [logger=CONSOLE_LOGGER] - 分级日志对象
 * @returns {object} - { healthy, lastRecord, lastSuccess, consecutiveFailures, consecutiveSuccesses, totalRuns }
 */
export function getRenewalStatus(filePath = DEFAULT_STATUS_FILE, alertThreshold = DEFAULT_ALERT_AFTER_FAILURES, logger = CONSOLE_LOGGER) {
  const { records, lastRecord, successStreak } = readRenewalStatus(filePath, logger);
  const consecutiveFailures = countConsecutiveFailures(records);
  // 连续成功次数取持久化字段（不受 30 条记录窗口截断影响），连败仍按窗口内记录统计
  const consecutiveSuccesses = successStreak;
  const lastSuccess = [...records].reverse().find((r) => r && r.success && !r.skipped) || null;
  const threshold = Number.isFinite(alertThreshold) && alertThreshold > 0
    ? alertThreshold
    : DEFAULT_ALERT_AFTER_FAILURES;
  return {
    healthy: consecutiveFailures < threshold,
    lastRecord,
    lastSuccess,
    consecutiveFailures,
    consecutiveSuccesses,
    totalRuns: records.length,
  };
}
