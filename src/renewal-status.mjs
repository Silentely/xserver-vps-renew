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
    // 文件不存在属于正常冷启动，静默返回空状态
    if (error.code !== 'ENOENT') {
      console.warn(`[renewal-status] 读取状态文件异常: ${error.message}，重置为空记录`);
    }
    return { records: [], lastRecord: null };
  }
}

/**
 * 写入续期状态记录（原子写：temp + rename）
 * @param {object} record - 续期记录
 * @param {string} filePath - 状态文件路径
 * @param {number} maxRecords - 最大保留记录数
 * @throws {Error} 目录不可写或写入失败时抛出
 */
export function writeRenewalStatus(record, filePath = DEFAULT_STATUS_FILE, maxRecords = DEFAULT_MAX_RECORDS) {
  const { records } = readRenewalStatus(filePath);
  records.push(record);
  const trimmed = records.slice(-Math.max(1, maxRecords));
  const dir = dirname(filePath);

  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    // 目录已存在时 mkdir 可能报错，后续 accessSync / write 会再次校验
    if (error.code !== 'EEXIST') {
      console.warn(`[renewal-status] 创建目录 ${dir} 失败: ${error.message}`);
    }
  }

  try {
    accessSync(dir, constants.W_OK);
  } catch {
    const msg = `目录 ${dir} 不可写，请检查挂载卷权限（容器内需 appuser 可写）`;
    console.error(`[renewal-status] ❌ ${msg}`);
    throw new Error(msg);
  }

  const tmpPath = `${filePath}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify({ records: trimmed }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
  } catch (error) {
    const msg = `写入状态文件失败: ${error.message}`;
    console.error(`[renewal-status] ❌ ${msg}`);
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
 * 获取续期健康状态
 * @param {string} filePath - 状态文件路径
 * @param {number} alertThreshold - 连续失败告警阈值
 * @returns {object} - { healthy, lastRecord, lastSuccess, consecutiveFailures, totalRuns }
 */
export function getRenewalStatus(filePath = DEFAULT_STATUS_FILE, alertThreshold = DEFAULT_ALERT_AFTER_FAILURES) {
  const { records, lastRecord } = readRenewalStatus(filePath);
  const consecutiveFailures = countConsecutiveFailures(records);
  const lastSuccess = [...records].reverse().find((r) => r && r.success && !r.skipped) || null;
  const threshold = Number.isFinite(alertThreshold) && alertThreshold > 0
    ? alertThreshold
    : DEFAULT_ALERT_AFTER_FAILURES;
  return {
    healthy: consecutiveFailures < threshold,
    lastRecord,
    lastSuccess,
    consecutiveFailures,
    totalRuns: records.length,
  };
}
