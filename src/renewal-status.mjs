/**
 * 续期结果持久化与监控模块
 * 负责续期记录读写、健康状态查询、连续失败统计
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, accessSync, constants } from 'node:fs';
import { dirname } from 'node:path';

/** 默认状态文件路径 */
export const DEFAULT_STATUS_FILE = '/data/renewal-status.json';

/** 默认连续失败告警阈值 */
export const DEFAULT_ALERT_AFTER_FAILURES = 3;

/** 默认最大保留记录数 */
const DEFAULT_MAX_RECORDS = 30;

/**
 * 读取续期状态历史
 * @param {string} filePath - 状态文件路径
 * @returns {object} - { records: [...], lastRecord: object|null }
 */
export function readRenewalStatus(filePath = DEFAULT_STATUS_FILE) {
  try {
    const data = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
      return { records: [], lastRecord: null };
    }
    return {
      records: parsed.records,
      lastRecord: parsed.records.length > 0 ? parsed.records[parsed.records.length - 1] : null,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[renewal-status] 读取状态文件异常: ${error.message}，重置为空记录`);
    }
    return { records: [], lastRecord: null };
  }
}

/**
 * 写入续期状态记录
 * @param {object} record - 续期记录
 * @param {string} filePath - 状态文件路径
 * @param {number} maxRecords - 最大保留记录数
 */
export function writeRenewalStatus(record, filePath = DEFAULT_STATUS_FILE, maxRecords = DEFAULT_MAX_RECORDS) {
  const { records } = readRenewalStatus(filePath);
  records.push(record);
  const trimmed = records.slice(-maxRecords);
  const dir = dirname(filePath);
  try { mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  // 检查目录写权限，提前给出友好提示
  try { accessSync(dir, constants.W_OK); } catch {
    console.error(`[renewal-status] ❌ 目录 ${dir} 不可写，请检查挂载卷权限（容器内需 appuser 可写）`);
  }
  // 使用 write-to-temp-then-rename 保证原子性 + 文件权限 0600
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ records: trimmed }, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmpPath, filePath);
}

/**
 * 构建续期结果记录对象（纯函数）
 * @param {object} params - 结果参数
 * @returns {object} - 标准化的续期记录
 */
export function buildRenewalRecord({ success, serverName, plan, oldExpireDate, newExpireDate, errorMessage }) {
  return {
    timestamp: new Date().toISOString(),
    success,
    serverName: serverName || null,
    plan: plan || null,
    oldExpireDate: oldExpireDate || null,
    newExpireDate: newExpireDate || null,
    errorMessage: errorMessage || null,
  };
}

/**
 * 计算连续失败次数（从记录尾部向前统计）
 * @param {Array} records - 续期记录数组
 * @returns {number} - 连续失败次数
 */
export function countConsecutiveFailures(records) {
  let count = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (!records[i].success) count++;
    else break;
  }
  return count;
}

/**
 * 获取续期健康状态
 * @param {string} filePath - 状态文件路径
 * @param {number} alertThreshold - 连续失败告警阈值
 * @returns {object} - { healthy, lastRecord, lastSuccess, consecutiveFailures, totalRuns }
 */
export function getRenewalStatus(filePath = DEFAULT_STATUS_FILE, alertThreshold = DEFAULT_ALERT_AFTER_FAILURES) {
  const { records, lastRecord } = readRenewalStatus(filePath);
  const consecutiveFailures = countConsecutiveFailures(records);
  const lastSuccess = [...records].reverse().find((r) => r.success) || null;
  return {
    healthy: consecutiveFailures < alertThreshold,
    lastRecord,
    lastSuccess,
    consecutiveFailures,
    totalRuns: records.length,
  };
}
