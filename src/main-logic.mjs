/**
 * 主脚本可测试决策逻辑（纯函数）
 *
 * 从 xserver-vps-renew.mjs 主流程中抽出，保持行为一致：
 * 主脚本只负责编排与副作用（浏览器/文件/网络），判定与文案收敛到本模块，
 * 使「需要续期/人工确认/告警升级」等关键分支可单元测试。
 */

/**
 * 汇总本轮 VPS 上下文：优先采用本轮提取结果，缺失时回退历史记录
 * （历史兜底防止告警通知丢失机器信息，见主脚本 knownVps 逻辑）
 * @param {{ vpsInfo?: { serverName?: string|null, plan?: string|null, expireDate?: string|null }, remainingHours?: number|null }|null} renewalData
 * @param {{ serverName?: string|null, plan?: string|null, oldExpireDate?: string|null, newExpireDate?: string|null }|null} prevLastRecord
 * @returns {{ serverName: string|null, plan: string|null, expireDate: string|null, remainingHours: number|null }}
 */
export function buildKnownVpsInfo(renewalData, prevLastRecord) {
  const info = renewalData?.vpsInfo;
  if (info && (info.serverName || info.plan || info.expireDate)) {
    return {
      serverName: info.serverName || null,
      plan: info.plan || null,
      expireDate: info.expireDate || null,
      remainingHours: renewalData.remainingHours ?? null,
    };
  }
  if (prevLastRecord?.serverName) {
    return {
      serverName: prevLastRecord.serverName,
      plan: prevLastRecord.plan || null,
      expireDate: prevLastRecord.newExpireDate || prevLastRecord.oldExpireDate || null,
      remainingHours: null,
    };
  }
  return { serverName: null, plan: null, expireDate: null, remainingHours: null };
}

/**
 * 判定「无需续期」分支的出口类型与文案
 * @param {object} opts
 * @param {string} opts.reasonCode - not_due | no_free_vps | window_blocked
 * @param {boolean} [opts.needsManualConfirmation] - 官方新增确认页拦截标记
 * @param {object|null} [opts.prevLastRecord] - 历史记录（用于已知 VPS 本次缺失告警）
 * @param {string} [opts.baseReasonDetail] - 基础原因说明
 * @returns {{
 *   kind: 'manual_confirm'|'skip',
 *   missingKnownVps: boolean,
 *   skipLabel?: string,
 *   reasonDetail?: string,
 * }}
 */
export function resolveSkipOutcome({ reasonCode, needsManualConfirmation = false, prevLastRecord = null, baseReasonDetail = '' }) {
  // 官方新增/变更确认页导致未进入 VPS 面板：转人工确认（failure 路径），不当作普通跳过
  if (reasonCode === 'no_free_vps' && needsManualConfirmation) {
    return { kind: 'manual_confirm', missingKnownVps: false };
  }
  const missingKnownVps = reasonCode === 'no_free_vps' && Boolean(prevLastRecord?.serverName);
  const skipLabel = reasonCode === 'no_free_vps' ? '未找到免费 VPS' : '无需续期';
  const reasonDetail = missingKnownVps
    ? `${baseReasonDetail}（注意：历史记录曾存在 ${prevLastRecord.serverName}）`
    : baseReasonDetail;
  return { kind: 'skip', missingKnownVps, skipLabel, reasonDetail };
}

/**
 * 已知 VPS 本次未检测到的告警文案（即使 TG_NOTIFY_SKIP=false 也走 manual_confirm 渠道推送）
 * @param {string} serverName
 * @returns {string}
 */
export function buildMissingVpsWarning(serverName) {
  return `⚠️ 历史记录中存在已知 VPS (${serverName})，但本次未检测到免费 VPS！请核实是否由于网络/渲染延迟、官方改版或机器已到期下线！`;
}

/**
 * 是否升级告警：连续失败达到阈值，或 Turnstile 全平台熔断
 * @param {object} opts
 * @param {number} opts.consecutiveFailures - 连续失败次数
 * @param {number} opts.threshold - 告警升级阈值
 * @param {boolean} [opts.turnstileAllProvidersFailed] - Turnstile 全平台失败
 * @returns {boolean}
 */
export function resolveEscalation({ consecutiveFailures, threshold, turnstileAllProvidersFailed = false }) {
  return consecutiveFailures >= threshold || turnstileAllProvidersFailed;
}

/**
 * 流程结束图标：success / skip / failure，其余视为 aborted
 * @param {string} outcome
 * @returns {string}
 */
export function resolveOutcomeIcon(outcome) {
  if (outcome === 'success') return '✅';
  if (outcome === 'skip') return 'ℹ️';
  if (outcome === 'failure') return '❌';
  return '⚠️';
}