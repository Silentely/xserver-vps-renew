/**
 * Telegram 通知构建模块
 * 消息文案、过程摘要、失败分类、下次执行估算
 *
 * 2026-08-04 自 renewal-logic.mjs 拆分：通知相关纯函数统一收纳于此，
 * renewal-logic.mjs 仅保留续期业务判定逻辑。
 */

import { escapeHtml, formatTokyoDateTime } from './utils.mjs';
import { FREE_VPS_MAX_HOURS, RENEWAL_WINDOW_HOURS } from './renewal-logic.mjs';
import { isTurnstileOutageError, TURNSTILE_ALL_PROVIDERS_FAILED } from './turnstile.mjs';

export const DEFAULT_NEXT_RUN_INTERVAL_HOURS = 6;

/**
 * 从 CRON 表达式解析「每 N 小时」间隔
 * 支持形如 "32 *\/6 * * *"、"0 *\/6 * * *"（小时字段为 star-slash-N）
 * @param {string|null|undefined} cronSchedule
 * @returns {number|null} 小时数，无法解析时 null
 */
export function parseCronIntervalHours(cronSchedule) {
  if (!cronSchedule || typeof cronSchedule !== 'string') return null;
  const parts = cronSchedule.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const hourField = parts[1];
  // 避免正则字面量含 "*/" 干扰 esbuild/vite 扫描
  if (!hourField.startsWith('*/')) return null;
  const n = Number(hourField.slice(2));
  if (!Number.isFinite(n) || n < 1 || n > 168 || String(n) !== hourField.slice(2)) return null;
  return n;
}

/**
 * 估算下次检查时间戳（毫秒）
 * 优先级：CRON 的每 N 小时 → intervalHours → 默认 6 小时
 * （不再写死 +24h，避免与实际调度间隔不符）
 * @param {number} [nowMs=Date.now()]
 * @param {{ cronSchedule?: string, intervalHours?: number }} [opts]
 * @returns {number}
 */
export function estimateNextRunMs(nowMs = Date.now(), opts = {}) {
  const fromCron = parseCronIntervalHours(opts.cronSchedule);
  const hours = fromCron ?? opts.intervalHours ?? DEFAULT_NEXT_RUN_INTERVAL_HOURS;
  const safeHours = Number.isFinite(hours) && hours >= 1 && hours <= 168
    ? hours
    : DEFAULT_NEXT_RUN_INTERVAL_HOURS;
  return nowMs + safeHours * 3_600_000;
}

/**
 * 估算下次检查时间文案（东京时区）
 * @param {number} [nowMs=Date.now()]
 * @param {{ cronSchedule?: string, intervalHours?: number }} [opts]
 * @returns {string}
 */
export function resolveNextRunAt(nowMs = Date.now(), opts = {}) {
  return formatTokyoDateTime(estimateNextRunMs(nowMs, opts));
}

/** Telegram 通知详细程度：完整摘要（含执行过程） */
export const TG_NOTIFY_DETAIL_FULL = 'full';

/** Telegram 通知详细程度：简洁摘要（关键字段，无过程步骤） */
export const TG_NOTIFY_DETAIL_COMPACT = 'compact';

/** 默认通知详细程度 */
export const DEFAULT_TG_NOTIFY_DETAIL = TG_NOTIFY_DETAIL_FULL;

/** Telegram Bot API 单条消息硬上限（字符） */
export const TG_MESSAGE_MAX_LEN = 4096;

/** 通知中错误信息最大长度（避免 HTML/长堆栈撑爆 4096） */
export const TG_ERROR_MESSAGE_MAX_LEN = 500;

/** full 模式下「执行过程」最多保留步数 */
export const TG_PROCESS_STEP_MAX_COUNT = 15;

/** 单条过程步骤最大字符数 */
export const TG_PROCESS_STEP_MAX_LEN = 180;

/**
 * 解析 TG_NOTIFY_DETAIL 环境变量
 * 支持 full / compact，及常见别名（detailed/verbose → full；brief/simple/short → compact）
 * @param {string|undefined|null} value
 * @param {string} [fallback=DEFAULT_TG_NOTIFY_DETAIL]
 * @returns {'full'|'compact'}
 */
export function parseNotifyDetail(value, fallback = DEFAULT_TG_NOTIFY_DETAIL) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === TG_NOTIFY_DETAIL_FULL || v === 'detailed' || v === 'verbose') {
    return TG_NOTIFY_DETAIL_FULL;
  }
  if (
    v === TG_NOTIFY_DETAIL_COMPACT ||
    v === 'brief' ||
    v === 'simple' ||
    v === 'short'
  ) {
    return TG_NOTIFY_DETAIL_COMPACT;
  }
  const fb = String(fallback ?? '').trim().toLowerCase();
  return fb === TG_NOTIFY_DETAIL_COMPACT
    ? TG_NOTIFY_DETAIL_COMPACT
    : TG_NOTIFY_DETAIL_FULL;
}

/**
 * 是否为完整摘要模式
 * @param {string|undefined|null} detail
 * @returns {boolean}
 */
export function isFullNotifyDetail(detail) {
  return parseNotifyDetail(detail) === TG_NOTIFY_DETAIL_FULL;
}

/**
 * 格式化剩余小时数（通知展示用）
 * @param {number|null|undefined} hours
 * @returns {string}
 */
export function formatRemainingHours(hours) {
  if (hours == null || !Number.isFinite(Number(hours))) return '未知';
  const h = Number(hours);
  if (h < 0) return `已过期 ${Math.abs(h).toFixed(1)} 小时`;
  return `约 ${h.toFixed(1)} 小时`;
}

/**
 * 距官方可续期窗口（剩余 ≤ windowHours）还有多少小时
 * @param {number|null|undefined} remainingHours - 当前剩余小时
 * @param {number} [windowHours=RENEWAL_WINDOW_HOURS]
 * @returns {number|null} 已进入窗口为 0；无法计算为 null；否则为正数
 */
export function getHoursUntilRenewalWindow(
  remainingHours,
  windowHours = RENEWAL_WINDOW_HOURS,
) {
  if (remainingHours == null || !Number.isFinite(Number(remainingHours))) return null;
  const rem = Number(remainingHours);
  const win = Number(windowHours);
  if (!Number.isFinite(win) || win < 0) return null;
  if (rem <= win) return 0;
  return rem - win;
}

/**
 * 格式化「距可续窗口」文案（通知用，未转义）
 * @param {number|null|undefined} remainingHours
 * @param {number} [windowHours=RENEWAL_WINDOW_HOURS]
 * @returns {string} 空字符串表示不展示
 */
export function formatHoursUntilWindow(
  remainingHours,
  windowHours = RENEWAL_WINDOW_HOURS,
) {
  const until = getHoursUntilRenewalWindow(remainingHours, windowHours);
  if (until == null) return '';
  if (until <= 0) return '已进入可续期窗口';
  return `约 ${until.toFixed(1)} 小时后可续`;
}

/**
 * 格式化耗时（毫秒 → 可读中文）
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatDurationMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) < 0) return '未知';
  const totalSec = Math.round(Number(ms) / 1000);
  if (totalSec < 60) return `${totalSec} 秒`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin > 0 ? `${hours} 小时 ${remMin} 分` : `${hours} 小时`;
}

/**
 * 截断通知字段（纯函数；保留可读尾注）
 * @param {unknown} text
 * @param {number} [maxLen=TG_ERROR_MESSAGE_MAX_LEN]
 * @returns {string}
 */
export function truncateNotifyText(text, maxLen = TG_ERROR_MESSAGE_MAX_LEN) {
  const s = String(text ?? '');
  const limit = Math.max(16, Number(maxLen) || TG_ERROR_MESSAGE_MAX_LEN);
  if (s.length <= limit) return s;
  const marker = `…(已截断,共${s.length}字)`;
  const bodyLen = Math.max(8, limit - marker.length);
  return `${s.slice(0, bodyLen)}${marker}`;
}

/**
 * 规范化执行过程步骤：去空、压空白、合并连续重复
 * @param {string[]|null|undefined} processSteps
 * @returns {string[]}
 */
export function normalizeProcessSteps(processSteps) {
  if (!Array.isArray(processSteps)) return [];
  const out = [];
  for (const raw of processSteps) {
    if (raw == null) continue;
    const t = String(raw).trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (out.length > 0 && out[out.length - 1] === t) continue;
    out.push(t);
  }
  return out;
}

/**
 * 裁剪执行过程步骤：限制条数与单行长度；超限时保留最近步骤
 * @param {string[]|null|undefined} processSteps
 * @param {{ maxCount?: number, maxLen?: number }} [opts]
 * @returns {string[]}
 */
export function clampProcessSteps(processSteps, opts = {}) {
  if (!Array.isArray(processSteps)) return [];
  const maxCount = Math.max(1, Number(opts.maxCount) || TG_PROCESS_STEP_MAX_COUNT);
  const maxLen = Math.max(16, Number(opts.maxLen) || TG_PROCESS_STEP_MAX_LEN);

  const cleaned = normalizeProcessSteps(processSteps).map((t) => (
    t.length > maxLen ? `${t.slice(0, Math.max(8, maxLen - 1))}…` : t
  ));

  if (cleaned.length <= maxCount) return cleaned;

  const keep = Math.max(1, maxCount - 1);
  const omitted = cleaned.length - keep;
  return [`…此前另有 ${omitted} 步已省略`, ...cleaned.slice(-keep)];
}

/**
 * 将执行步骤列表格式化为通知段落（仅 full 模式使用）
 * @param {string[]|null|undefined} processSteps
 * @param {string} [detail=TG_NOTIFY_DETAIL_FULL] - full 时输出步骤；compact 时返回空
 * @returns {string} 空字符串或带前导换行的段落
 */
export function formatProcessSteps(processSteps, detail = TG_NOTIFY_DETAIL_FULL) {
  if (!isFullNotifyDetail(detail)) return '';
  const steps = clampProcessSteps(processSteps);
  if (steps.length === 0) return '';
  const lines = steps.map((s, i) => `${i + 1}. ${escapeHtml(s)}`);
  return `\n\n📋 <b>执行过程</b>:\n${lines.join('\n')}`;
}

/**
 * 格式化耗时通知行
 * @param {number|null|undefined} durationMs
 * @param {string|null|undefined} [durationText] - 若已格式化则优先使用
 * @returns {string} 空字符串或一行（无尾换行）
 */
export function formatDurationNotifyLine(durationMs, durationText = null) {
  const text = durationText != null && String(durationText).trim() !== ''
    ? String(durationText).trim()
    : (durationMs != null ? formatDurationMs(durationMs) : '');
  if (!text || text === '未知') return '';
  return `⏱️ 耗时: ${escapeHtml(text)}`;
}

/**
 * 最终兜底：保证 Telegram 消息不超过 Bot API 上限
 * @param {unknown} message
 * @param {number} [maxLen=TG_MESSAGE_MAX_LEN]
 * @returns {string}
 */
export function clampTelegramMessage(message, maxLen = TG_MESSAGE_MAX_LEN) {
  const s = String(message ?? '');
  const limit = Math.max(64, Number(maxLen) || TG_MESSAGE_MAX_LEN);
  if (s.length <= limit) return s;
  const marker = '\n…(消息过长已截断)';
  return `${s.slice(0, Math.max(16, limit - marker.length))}${marker}`;
}

/**
 * Turnstile 平台/来源展示名（通知与过程步骤共用）
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function resolveTurnstileProviderLabel(name) {
  if (name == null || String(name).trim() === '') return '';
  const key = String(name).trim();
  const labels = {
    prefilled: '页面预填',
    natural: '自然通过',
    CapSolver: 'CapSolver',
    AntiCaptcha: 'AntiCaptcha',
    YesCaptcha: 'YesCaptcha',
    '2Captcha': '2Captcha',
  };
  return labels[key] || key;
}

/**
 * 提取 failover 尝试中失败（熔断）的平台展示名列表
 * 主脚本过程摘要与 formatTurnstileNotifyLine 共用，避免重复实现
 * @param {{ provider?: string, success?: boolean }[]|null|undefined} attempts
 * @returns {string[]} 已熔断平台名（转标签后去空）
 */
export function listFailedTurnstileProviders(attempts) {
  if (!Array.isArray(attempts)) return [];
  return attempts
    .filter((a) => a && a.success === false)
    .map((a) => resolveTurnstileProviderLabel(a.provider) || a.provider)
    .filter(Boolean);
}

/**
 * 格式化 Turnstile 求解摘要（通知用）
 * @param {object} [opts]
 * @param {string|null} [opts.providerName] - 最终成功的平台
 * @param {{ provider: string, success: boolean, failures?: number, lastError?: string }[]} [opts.attempts]
 * @returns {string} 空字符串或一行摘要（已 HTML 转义）
 */
export function formatTurnstileNotifyLine({ providerName, attempts } = {}) {
  const label = resolveTurnstileProviderLabel(providerName);
  if (!label) return '';
  const name = escapeHtml(label);
  const failed = listFailedTurnstileProviders(attempts);
  if (failed.length === 0) {
    return `🔐 Turnstile: ${name}`;
  }
  const failedText = escapeHtml(failed.join(' → '));
  return `🔐 Turnstile: ${name}（${failedText} 熔断后切换）`;
}

/**
 * 构建续期成功 Telegram 消息
 * @param {object} params
 * @param {string[]} [params.processSteps] - 执行过程（仅 detail=full 时展示）
 * @param {'full'|'compact'|string} [params.detail='full'] - 通知详细程度
 * @param {string|null} [params.turnstileProvider] - 最终成功的打码平台
 * @param {object[]} [params.turnstileAttempts] - failover 尝试记录
 * @param {number|null} [params.durationMs] - 本轮耗时（毫秒）
 * @param {string|null} [params.durationText] - 已格式化的耗时文案（优先于 durationMs）
 * @param {number|null} [params.remainingHours] - 续期前剩余小时（可选）
 * @param {number|null} [params.consecutiveSuccesses] - 含本轮在内的连续成功次数（可选）
 * @returns {string}
 */
export function buildSuccessNotifyMessage({
  serverName,
  plan,
  oldExpireDate,
  newExpireDate,
  executedAt,
  nextRunAt,
  processSteps,
  detail = DEFAULT_TG_NOTIFY_DETAIL,
  turnstileProvider = null,
  turnstileAttempts = [],
  durationMs = null,
  durationText = null,
  remainingHours = null,
  consecutiveSuccesses = null,
}) {
  const mode = parseNotifyDetail(detail);
  const time = escapeHtml(executedAt || formatTokyoDateTime());
  const name = escapeHtml(serverName || '未知');
  const next = escapeHtml(nextRunAt || '');
  const turnstileLine = formatTurnstileNotifyLine({
    providerName: turnstileProvider,
    attempts: turnstileAttempts,
  });
  const durationLine = formatDurationNotifyLine(durationMs, durationText);
  const remainingLine = remainingHours != null && Number.isFinite(Number(remainingHours))
    ? `⏳ 续期前剩余: ${escapeHtml(formatRemainingHours(remainingHours))}`
    : '';
  // 连续成功（含本轮）≥1 时展示，给用户「自动化运行稳定」的直观信号
  const streakLine = consecutiveSuccesses != null && Number(consecutiveSuccesses) >= 1
    ? `📈 已连续成功 ${Number(consecutiveSuccesses)} 次`
    : '';

  if (mode === TG_NOTIFY_DETAIL_COMPACT) {
    return clampTelegramMessage(
      `✅ <b>Xserver VPS 续期成功</b>\n\n` +
      `⏰ 执行时间: ${time}\n` +
      `🖥️ 服务器名: ${name}\n` +
      `📅 新到期日: ${escapeHtml(newExpireDate || '未提取')}\n` +
      `${turnstileLine ? `${turnstileLine}\n` : ''}` +
      `${streakLine ? `${streakLine}\n` : ''}` +
      `${durationLine ? `${durationLine}\n` : ''}` +
      `⏭️ 下次检查: ${next}`,
    );
  }

  return clampTelegramMessage(
    `✅ <b>Xserver VPS 续期成功</b>\n\n` +
    `⏰ 执行时间: ${time}\n` +
    `🖥️ 服务器名: ${name}\n` +
    `📦 VPS 规格: ${escapeHtml(plan || '未知')}\n` +
    `📅 原到期日: ${escapeHtml(oldExpireDate || '未知')}\n` +
    `📅 新到期日: ${escapeHtml(newExpireDate || '未提取')}\n` +
    `${remainingLine ? `${remainingLine}\n` : ''}` +
    `${turnstileLine ? `${turnstileLine}\n` : ''}` +
    `${streakLine ? `${streakLine}\n` : ''}` +
    `${durationLine ? `${durationLine}\n` : ''}` +
    `⏭️ 下次检查: ${next}` +
    formatProcessSteps(processSteps, mode),
  );
}

/**
 * 构建「无需续期 / 跳过」Telegram 消息（每次检查后推送，便于掌控 VPS 状态）
 * @param {object} params
 * @param {'not_due'|'no_free_vps'|string} [params.reasonCode='not_due']
 * @param {string} [params.serverName]
 * @param {string} [params.plan]
 * @param {string} [params.expireDate]
 * @param {number|null} [params.remainingHours]
 * @param {string} [params.executedAt]
 * @param {string} [params.nextRunAt]
 * @param {number} [params.maxHours]
 * @param {number} [params.windowHours]
 * @param {string} [params.reasonDetail] - 额外说明（覆盖默认判定文案）
 * @param {string[]} [params.processSteps]
 * @param {'full'|'compact'|string} [params.detail='full']
 * @returns {string}
 */
export function buildSkipNotifyMessage({
  reasonCode = 'not_due',
  serverName,
  plan,
  expireDate,
  remainingHours,
  executedAt,
  nextRunAt,
  maxHours = FREE_VPS_MAX_HOURS,
  windowHours = RENEWAL_WINDOW_HOURS,
  reasonDetail,
  processSteps,
  detail = DEFAULT_TG_NOTIFY_DETAIL,
  durationMs = null,
  durationText = null,
} = {}) {
  const mode = parseNotifyDetail(detail);
  const isNoVps = reasonCode === 'no_free_vps';
  const isWindowBlocked = reasonCode === 'window_blocked';
  const title = isNoVps
    ? 'ℹ️ <b>Xserver VPS 检查完成 · 未找到免费 VPS</b>'
    : isWindowBlocked
      ? 'ℹ️ <b>Xserver VPS 检查完成 · 未进入 12h 续期窗口</b>'
      : 'ℹ️ <b>Xserver VPS 检查完成 · 无需续期</b>';

  const defaultDetail = isNoVps
    ? '面板中未找到带免费标识的 VPS 条目'
    : isWindowBlocked
      ? `官方页面提示：须在利用期限的 ${windowHours} 小时前起方可办理更新（最长 ${maxHours}h）`
      : `剩余时间未进入可续期窗口（规则: 最长 ${maxHours}h / 剩余≤${windowHours}h 可续）`;

  const time = escapeHtml(executedAt || formatTokyoDateTime());
  const name = escapeHtml(serverName || (isNoVps ? '—' : '未知'));
  const expire = escapeHtml(expireDate || '—');
  const remaining = escapeHtml(formatRemainingHours(remainingHours));
  const next = escapeHtml(nextRunAt || '');
  const durationLine = formatDurationNotifyLine(durationMs, durationText);
  // 未找到 VPS 时不展示「距可续窗口」；其余跳过路径在可计算时展示
  const untilWindowText = !isNoVps
    ? formatHoursUntilWindow(remainingHours, windowHours)
    : '';
  const untilWindowLine = untilWindowText
    ? `🔓 距可续窗口: ${escapeHtml(untilWindowText)}`
    : '';

  const lines = [
    title,
    '',
    `⏰ 执行时间: ${time}`,
    `🖥️ 服务器名: ${name}`,
  ];
  // 规格与判定详情仅 full 模式展示；其余行两模式共用（compact 由 formatProcessSteps 自动省略过程）
  if (mode === TG_NOTIFY_DETAIL_FULL) {
    lines.push(`📦 VPS 规格: ${escapeHtml(plan || (isNoVps ? '—' : '未知'))}`);
  }
  lines.push(
    `📅 当前到期: ${expire}`,
    `⏳ 剩余时间: ${remaining}`,
  );
  if (untilWindowLine) lines.push(untilWindowLine);
  if (mode === TG_NOTIFY_DETAIL_FULL) {
    lines.push(`📌 判定结果: ${escapeHtml(reasonDetail || defaultDetail)}`);
  }
  if (durationLine) lines.push(durationLine);
  lines.push(`⏭️ 下次检查: ${next}`);

  return clampTelegramMessage(lines.join('\n') + formatProcessSteps(processSteps, mode));
}

/**
 * 构建「需要人工确认」提醒通知
 * 自动同意 / 面板处理疑似遇到官方新增或变更的确认页面时，提醒用户登录 Xserver
 * 手动确认后重新运行容器；区别于通用失败通知，不携带续期失败分类信息
 * @param {object} opts
 * @param {string} [opts.executedAt] 执行时间（东京时区，已格式化）
 * @param {string} [opts.reason] 触发原因（错误信息或页面停留说明）
 * @param {string} [opts.nextRunAt] 下次执行时间
 * @returns {string}
 */
export function buildManualConfirmNotifyMessage({
  executedAt = '',
  reason = '',
  nextRunAt = '',
} = {}) {
  const lines = [
    '⚠️ <b>Xserver VPS 自动续期 · 需要人工确认</b>',
    '',
    '自动处理疑似遇到官方新增或变更的确认页面，无法继续自动续期。',
    '请登录 Xserver 面板检查是否存在需要确认的新页面',
    '（如个人信息同意、安全验证等），手动完成后重新运行容器：',
    '',
    '<code>docker exec xserver-vps-renew ./entrypoint.sh --once</code>',
  ];
  if (reason) {
    lines.push('', `原因: ${escapeHtml(reason)}`);
  }
  lines.push('', `⏰ 执行时间: ${executedAt || '—'}`);
  if (nextRunAt) {
    lines.push(`⏭️ 下次执行: ${nextRunAt}`);
  }
  return clampTelegramMessage(lines.join('\n'));
}

/**
 * 解析 Telegram sendMessage 响应（纯函数）
 * Bot API 对逻辑错误（chat 不存在、bot 被屏蔽等）返回 HTTP 200 + { ok:false, description }，
 * 仅检查 HTTP 状态会误报「已发送」。
 * @param {string|object|null|undefined} body - 响应体（JSON 字符串或已解析对象）
 * @returns {{ ok: boolean, description: string }}
 */
export function parseTelegramSendResult(body) {
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      return { ok: false, description: `响应非 JSON: ${body.slice(0, 100)}` };
    }
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, description: '响应体为空或非对象' };
  }
  if (data.ok === false) {
    return {
      ok: false,
      description: String(data.description || data.error_code || '未知错误'),
    };
  }
  return { ok: true, description: '' };
}

/**
 * 是否为 Turnstile 多平台全挂（删机风险最高级）
 * 统一委托 src/turnstile.mjs 的 isTurnstileOutageError（唯一来源），避免跨模块 magic string 漂移
 * @param {object} opts
 * @param {boolean} [opts.turnstileAllProvidersFailed]
 * @param {string} [opts.errorMessage]
 * @param {string} [opts.errorCode]
 * @returns {boolean}
 */
export function isTurnstileAllProvidersFailed({
  turnstileAllProvidersFailed,
  errorMessage,
  errorCode,
} = {}) {
  if (turnstileAllProvidersFailed === true) return true;
  if (errorCode === TURNSTILE_ALL_PROVIDERS_FAILED) return true;
  return isTurnstileOutageError({ code: errorCode, message: errorMessage });
}

/** 续期失败分类（通知标签与处置建议路由） */
export const FAILURE_CATEGORY = {
  TURNSTILE_OUTAGE: 'turnstile_outage',
  TURNSTILE: 'turnstile',
  CAPTCHA: 'captcha',
  LOGIN: 'login',
  CONFIG: 'config',
  TIMEOUT: 'timeout',
  BUSINESS: 'business',
  UNKNOWN: 'unknown',
};

/** 分类 → 中文标签（classifyRenewalFailure 与 buildFailureNotifyMessage 共用，唯一来源） */
export const FAILURE_CATEGORY_LABELS = {
  [FAILURE_CATEGORY.TURNSTILE_OUTAGE]: 'Turnstile 全平台熔断',
  [FAILURE_CATEGORY.TURNSTILE]: 'Turnstile 求解',
  [FAILURE_CATEGORY.CAPTCHA]: '图形验证码',
  [FAILURE_CATEGORY.LOGIN]: '登录失败',
  [FAILURE_CATEGORY.CONFIG]: '配置错误',
  [FAILURE_CATEGORY.TIMEOUT]: '超时/网络',
  [FAILURE_CATEGORY.BUSINESS]: '业务限制',
  [FAILURE_CATEGORY.UNKNOWN]: '其他错误',
};

/**
 * 分类续期失败原因（纯函数，供日志与 Telegram 共用）
 * @param {object} [opts]
 * @param {string} [opts.errorMessage]
 * @param {string} [opts.errorCode]
 * @param {boolean} [opts.turnstileAllProvidersFailed]
 * @returns {{ category: string, label: string }}
 */
export function classifyRenewalFailure({
  errorMessage,
  errorCode,
  turnstileAllProvidersFailed,
} = {}) {
  if (isTurnstileAllProvidersFailed({
    turnstileAllProvidersFailed,
    errorMessage,
    errorCode,
  })) {
    return {
      category: FAILURE_CATEGORY.TURNSTILE_OUTAGE,
      label: FAILURE_CATEGORY_LABELS[FAILURE_CATEGORY.TURNSTILE_OUTAGE],
    };
  }

  const msg = String(errorMessage || '');
  const code = String(errorCode || '');

  // 配置类优先于登录类（错误文案可能同时含 XSERVER_MEMBER_ID）
  if (
    /配置校验失败|配置对象无效|代理配置不完整|PROXY_TYPE|PROXY_PORT|CAPTCHA_API 协议|CAPTCHA_API 不是/.test(msg)
    || code === 'CONFIG_INVALID'
  ) {
    return { category: FAILURE_CATEGORY.CONFIG, label: FAILURE_CATEGORY_LABELS[FAILURE_CATEGORY.CONFIG] };
  }

  if (
    /登录失败|请检查 XSERVER_MEMBER_ID|请检查 XSERVER_PASSWORD|凭据|认证に失敗|会員ID|パスワード/.test(msg)
  ) {
    return { category: FAILURE_CATEGORY.LOGIN, label: FAILURE_CATEGORY_LABELS[FAILURE_CATEGORY.LOGIN] };
  }

  if (
    /信用卡|カード|決済|無料枠|需要绑定|需要注册|需要设置支付/.test(msg)
  ) {
    return { category: FAILURE_CATEGORY.BUSINESS, label: FAILURE_CATEGORY_LABELS[FAILURE_CATEGORY.BUSINESS] };
  }

  if (
    /验证码|Keras|CAPTCHA_API|imgSrc|平假名|识别失败|无效结果/.test(msg)
    && !/Turnstile|cf-turnstile|打码平台/.test(msg)
  ) {
    return { category: FAILURE_CATEGORY.CAPTCHA, label: FAILURE_CATEGORY_LABELS[FAILURE_CATEGORY.CAPTCHA] };
  }

  if (
    /Turnstile|cf-turnstile|令牌|sitekey|打码平台|CapSolver|AntiCaptcha|YesCaptcha|2Captcha/.test(msg)
    || code.startsWith('TURNSTILE_')
  ) {
    return { category: FAILURE_CATEGORY.TURNSTILE, label: FAILURE_CATEGORY_LABELS[FAILURE_CATEGORY.TURNSTILE] };
  }

  if (
    /超时|timeout|Timeout|Navigation|net::|ERR_|ECONN|ENOTFOUND|网络异常|AbortError/i.test(msg)
  ) {
    return { category: FAILURE_CATEGORY.TIMEOUT, label: FAILURE_CATEGORY_LABELS[FAILURE_CATEGORY.TIMEOUT] };
  }

  return { category: FAILURE_CATEGORY.UNKNOWN, label: FAILURE_CATEGORY_LABELS[FAILURE_CATEGORY.UNKNOWN] };
}

/**
 * 按失败分类生成处置建议（full 模式）
 * @param {object} opts
 * @param {string} opts.category
 * @param {number} [opts.captchaMaxRetry=3]
 * @returns {string}
 */
export function buildFailureHints({
  category,
  captchaMaxRetry = 3,
} = {}) {
  const cat = category || FAILURE_CATEGORY.UNKNOWN;

  if (cat === FAILURE_CATEGORY.TURNSTILE_OUTAGE) {
    return [
      `📋 失败说明:`,
      `- 已配置的 Turnstile 打码平台均已熔断（每平台连续失败达阈值后切换）`,
      `- 常见原因：Cloudflare 算法更新导致打码平台暂时失效`,
      `- <b>立即行动</b>:`,
      `  1. 立即人工登录 https://secure.xserver.ne.jp 完成续期`,
      `  2. 检查各打码平台余额与官方状态（CapSolver / Anti-Captcha / YesCaptcha / 2Captcha）`,
      `  3. 平台恢复后可依赖下次 cron 自动重试`,
    ].join('\n');
  }

  if (cat === FAILURE_CATEGORY.LOGIN) {
    return [
      `📋 失败说明:`,
      `- 无法登录 Xserver 面板，后续续期步骤均未执行`,
      `- 请检查:`,
      `  1. XSERVER_MEMBER_ID / XSERVER_PASSWORD 是否正确`,
      `  2. 账号是否被锁定或需二次验证`,
      `  3. 代理出口 IP 是否被面板拦截`,
    ].join('\n');
  }

  if (cat === FAILURE_CATEGORY.CONFIG) {
    return [
      `📋 失败说明:`,
      `- 启动配置校验未通过，脚本未进入浏览器流程`,
      `- 请对照 .env / docker-compose 检查必填项与代理三件套（TYPE/ADDRESS/PORT）`,
      `- 定时模式请确认 entrypoint 已导出相关环境变量`,
    ].join('\n');
  }

  if (cat === FAILURE_CATEGORY.CAPTCHA) {
    return [
      `📋 失败说明:`,
      `- 图形验证码识别已自动重试 ${captchaMaxRetry} 次仍失败`,
      `- 请检查:`,
      `  1. CAPTCHA_API（Keras）是否可达、是否冷启动超时`,
      `  2. 返回结果是否为 6 位数字（含平假名场景）`,
      `  3. 稍后重试或查看识别日志中的原始返回`,
    ].join('\n');
  }

  if (cat === FAILURE_CATEGORY.TURNSTILE) {
    return [
      `📋 失败说明:`,
      `- Turnstile 求解失败（尚未判定为全平台熔断）`,
      `- 可尝试:`,
      `  1. 检查打码平台 API 余额与任务错误码`,
      `  2. 配置第二家打码平台 key 实现 failover`,
      `  3. Anti-Captcha 带代理任务仅支持 IP（域名会自动 Proxyless）`,
      `  4. 浏览器侧可继续使用域名住宅代理（PROXY_*）`,
    ].join('\n');
  }

  if (cat === FAILURE_CATEGORY.BUSINESS) {
    return [
      `📋 失败说明:`,
      `- 官方业务侧限制（如需信用卡/支付方式/免费额度）`,
      `- 自动化无法绕过，请人工登录面板按提示完成账号设置后再试`,
    ].join('\n');
  }

  if (cat === FAILURE_CATEGORY.TIMEOUT) {
    return [
      `📋 失败说明:`,
      `- 页面导航或外部 API 超时/网络异常`,
      `- 可尝试:`,
      `  1. 检查容器出网与代理连通性`,
      `  2. 适当增大 NAVIGATION_TIMEOUT_MS / TURNSTILE_API_TIMEOUT_MS`,
      `  3. 查看是否为 Cloud Run 冷启动导致 CAPTCHA_API 超时`,
    ].join('\n');
  }

  return [
    `📋 失败说明:`,
    `- 验证码识别已自动重试 ${captchaMaxRetry} 次`,
    `- Turnstile 已使用 API 求解（支持多平台自动降级）`,
    `- 如持续失败，可尝试:`,
    `  1. 检查打码平台 API 余额是否充足`,
    `  2. 配置第二家打码平台 key 实现 failover`,
    `  3. Anti-Captcha 带代理任务仅支持 IP 地址（域名代理会自动 Proxyless）`,
    `  4. 浏览器侧可继续使用域名住宅代理（PROXY_*）`,
    `  5. 人工登录确认账号状态`,
  ].join('\n');
}

/**
 * 构建续期失败 Telegram 消息
 * @param {object} params
 * @param {string[]} [params.processSteps] - 执行过程（仅 detail=full 时展示）
 * @param {'full'|'compact'|string} [params.detail='full']
 * @param {boolean} [params.turnstileAllProvidersFailed] - 多平台全挂最高级告警
 * @param {string[]} [params.failedProviders] - 已熔断的平台名列表
 * @param {string} [params.errorCode]
 * @param {string} [params.serverName] - 已知时附带 VPS 上下文
 * @param {string} [params.plan]
 * @param {string} [params.expireDate] - 原/当前到期日
 * @param {number|null} [params.remainingHours] - 失败时已知的剩余小时
 * @param {number|null} [params.durationMs]
 * @param {string|null} [params.durationText]
 * @param {string} [params.failureCategory] - 预分类；缺省时自动 classify
 * @returns {string}
 */
export function buildFailureNotifyMessage({
  errorMessage,
  consecutiveFailures = 0,
  isEscalation = false,
  proxyHint = '',
  captchaMaxRetry = 3,
  executedAt,
  processSteps,
  detail = DEFAULT_TG_NOTIFY_DETAIL,
  turnstileAllProvidersFailed = false,
  failedProviders = [],
  errorCode = '',
  turnstileProvider = null,
  turnstileAttempts = [],
  serverName = null,
  plan = null,
  expireDate = null,
  remainingHours = null,
  durationMs = null,
  durationText = null,
  failureCategory = null,
}) {
  const mode = parseNotifyDetail(detail);
  const multiProviderOutage = isTurnstileAllProvidersFailed({
    turnstileAllProvidersFailed,
    errorMessage,
    errorCode,
  });
  // 多平台全挂视为最高级：即使连续失败未达阈值也升级
  const escalate = isEscalation || multiProviderOutage;

  const autoClassified = classifyRenewalFailure({
    errorMessage,
    errorCode,
    turnstileAllProvidersFailed: multiProviderOutage,
  });
  const failureMeta = failureCategory && FAILURE_CATEGORY_LABELS[failureCategory]
    ? { category: failureCategory, label: FAILURE_CATEGORY_LABELS[failureCategory] }
    : autoClassified;

  const title = multiProviderOutage
    || failureMeta.category === FAILURE_CATEGORY.TURNSTILE_OUTAGE
    ? '🚨🚨 <b>【最高级告警·删机风险】Xserver VPS 续期失败</b>'
    : escalate
      ? '🚨 <b>【告警升级】Xserver VPS 续期失败</b>'
      : '❌ <b>Xserver VPS 续期失败</b>';

  const turnstileLine = formatTurnstileNotifyLine({
    providerName: turnstileProvider,
    attempts: turnstileAttempts,
  });
  const failedLabels = (failedProviders || [])
    .map((p) => resolveTurnstileProviderLabel(p))
    .filter(Boolean);
  // 失败且未成功求解时，用熔断列表补充 Turnstile 行
  const turnstileFailLine = !turnstileLine && failedLabels.length
    ? `🔐 Turnstile: 已熔断 ${escapeHtml(failedLabels.join(' → '))}`
    : turnstileLine;

  const safeError = escapeHtml(truncateNotifyText(errorMessage || '未知错误'));
  const durationLine = formatDurationNotifyLine(durationMs, durationText);
  const remainingLine = remainingHours != null && Number.isFinite(Number(remainingHours))
    ? `⏳ 剩余时间: ${escapeHtml(formatRemainingHours(remainingHours))}`
    : '';

  const contextLines = [];
  if (serverName) contextLines.push(`🖥️ 服务器名: ${escapeHtml(serverName)}`);
  if (mode === TG_NOTIFY_DETAIL_FULL && plan) {
    contextLines.push(`📦 VPS 规格: ${escapeHtml(plan)}`);
  }
  if (expireDate) contextLines.push(`📅 当前到期: ${escapeHtml(expireDate)}`);
  if (remainingLine) contextLines.push(remainingLine);

  const head =
    `${title}\n\n` +
    `⏰ 执行时间: ${escapeHtml(executedAt || formatTokyoDateTime())}\n` +
    `🏷️ 失败类型: ${escapeHtml(failureMeta.label)}\n` +
    `${contextLines.length ? `${contextLines.join('\n')}\n` : ''}` +
    `💥 错误信息: <code>${safeError}</code>\n` +
    `${turnstileFailLine ? `${turnstileFailLine}\n` : ''}` +
    `${durationLine ? `${durationLine}\n` : ''}` +
    `${multiProviderOutage || failureMeta.category === FAILURE_CATEGORY.TURNSTILE_OUTAGE
      ? `🛑 <b>Turnstile 打码平台已全部失败</b>${failedLabels.length
        ? `（${escapeHtml(failedLabels.join(' → '))}）`
        : ''}，请<strong>今天内手动登录官网续期</strong>，否则 VPS 可能被删除！\n`
      : ''}` +
    `${escalate && consecutiveFailures > 0
      ? `⚠️ <b>连续失败 ${consecutiveFailures} 次</b>，请立即人工介入！\n`
      : ''}`;

  if (mode === TG_NOTIFY_DETAIL_COMPACT) {
    return clampTelegramMessage(head.trimEnd());
  }

  const failHints = buildFailureHints({
    category: failureMeta.category,
    captchaMaxRetry,
  });

  // proxyHint 为空时避免产生多余空行（head 末尾恒有 \n，空提示只需补一个 \n 形成单一空行）
  const hintBlock = proxyHint ? `\n${proxyHint}\n\n` : '\n';
  return clampTelegramMessage(
    head +
    hintBlock +
    failHints +
    formatProcessSteps(processSteps, mode),
  );
}

/**
 * 构建代理提示文案（失败通知用）
 * @param {object} opts
 * @param {boolean} opts.hasProxy
 * @param {string} [opts.proxyType]
 * @param {string} [opts.maskedAddress]
 * @param {string|number} [opts.proxyPort]
 * @param {boolean} [opts.antiCaptchaHostnameSkipped] - AntiCaptcha 因域名代理改走 Proxyless
 * @returns {string}
 */
export function buildProxyHint({
  hasProxy,
  proxyType,
  maskedAddress,
  proxyPort,
  antiCaptchaHostnameSkipped = false,
}) {
  if (hasProxy) {
    const base = `📡 浏览器代理: ${proxyType}://${maskedAddress}:${proxyPort}`;
    if (antiCaptchaHostnameSkipped) {
      return (
        `${base}\n` +
        `ℹ️ Anti-Captcha 官方仅支持 IP 代理，当前为域名地址，打码任务已自动改用 Proxyless`
      );
    }
    return base;
  }
  return (
    `💡 <b>优化建议</b>:\n` +
    `如果多次续期失败，建议配置纯净家宽 IP 代理后重试。\n` +
    `代理可提高 Cloudflare Turnstile 通过率。\n` +
    `注意：Anti-Captcha 的 TurnstileTask 仅接受 IP 形式代理，域名代理会自动走 Proxyless。`
  );
}
