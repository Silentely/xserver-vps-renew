/**
 * 续期结果持久化与监控模块
 * 负责续期记录读写、健康状态查询、连续失败统计
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      lastRecord: Array.isArray(parsed.records) && parsed.records.length > 0
        ? parsed.records[parsed.records.length - 1]
        : null,
    };
  } catch {
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
  writeFileSync(filePath, JSON.stringify({ records: trimmed }, null, 2), 'utf8');
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
