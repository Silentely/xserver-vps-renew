/**
 * 续期业务纯逻辑
 * 到期判定、URL 构建、提交结果解析、到期日提取、通知文案
 *
 * 官方免费 VPS（4GB）规则（2026-07 起）：
 * - 最长使用时间：24 小时（原 48 小时）
 * - 可续期条件：剩余使用时间 ≤ 12 小时（原 ≤ 24 小时）
 */

/** 4GB 免费 VPS 最长使用时长（小时） */
export const FREE_VPS_MAX_HOURS = 24;

/** 允许续期的剩余时间阈值（小时）：剩余 ≤ 此值时可续期 */
export const RENEWAL_WINDOW_HOURS = 12;

/** 略过期仍尝试续期的宽限（小时），覆盖时钟偏差/页面延迟 */
export const RENEWAL_OVERDUE_GRACE_HOURS = 1;

/** 提交后明确失败关键词 */
export const FAILURE_PATTERNS = ['認証に失敗', '失敗しました', 'エラーが発生', '不正なアクセス'];

/** 其他错误关键词（非可重试硬失败） */
export const ERROR_PATTERNS = ['エラー', '不正', 'もう一度'];

/** 明确成功关键词（长词优先，避免短词误匹配） */
export const SUCCESS_PATTERNS = ['手続きが完了', '更新が完了', '延長しました', '完了しました'];

/** 业务侧已知失败原因 */
export const KNOWN_FAILURE_REASONS = [
  { pattern: 'クレジットカード', reason: '需要绑定信用卡才能续期' },
  { pattern: 'カード登録', reason: '需要注册信用卡才能续期' },
  { pattern: '決済方法', reason: '需要设置支付方式才能续期' },
  { pattern: '無料枠', reason: '免费额度相关问题' },
];

/**
 * 从页面到期文案解析东京时区下的到期时间戳（毫秒）
 * 支持：YYYY-MM-DD、YYYY/MM/DD、含 HH:mm[:ss]、日本格式年月日
 * 仅日期时按当天结束（23:59:59 东京）处理，便于保守判定
 * @param {string} expireText
 * @returns {number|null} epoch ms，无法解析时 null
 */
export function parseExpireTimestamp(expireText) {
  if (!expireText || typeof expireText !== 'string') return null;
  const text = expireText.trim();
  if (!text) return null;

  // ISO / 斜杠：2026-07-15 10:30:00 或 2026/07/15 10:30
  let m = text.match(
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (m) {
    const [, y, mo, d, hh, mm, ss] = m;
    const hasTime = hh !== undefined;
    return tokyoLocalToUtcMs(
      Number(y),
      Number(mo),
      Number(d),
      hasTime ? Number(hh) : 23,
      hasTime ? Number(mm) : 59,
      // 有时分无秒 → 0；纯日期 → 日末 59
      hasTime ? (ss !== undefined ? Number(ss) : 0) : 59,
    );
  }

  // 日本格式：2026年7月15日 10時30分 / 2026年7月15日
  m = text.match(
    /(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})[時:](\d{1,2})(?:分(?::?(\d{1,2})秒?)?)?)?/,
  );
  if (m) {
    const [, y, mo, d, hh, mm, ss] = m;
    const hasTime = hh !== undefined;
    return tokyoLocalToUtcMs(
      Number(y),
      Number(mo),
      Number(d),
      hasTime ? Number(hh) : 23,
      hasTime ? Number(mm) : 59,
      hasTime ? (ss !== undefined ? Number(ss) : 0) : 59,
    );
  }

  return null;
}

/**
 * 将东京本地年月日时分秒转为 UTC epoch ms
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @returns {number}
 */
function tokyoLocalToUtcMs(year, month, day, hour, minute, second) {
  // 东京固定 UTC+9，无夏令时：构造为「当作 UTC 的本地分量」再减去 9 小时
  return Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 3600_000;
}

/**
 * 计算剩余使用小时数（到期时间 - 当前时间）
 * @param {string} expireText - 页面到期文案
 * @param {number} [nowMs=Date.now()]
 * @returns {number|null} 剩余小时（可为负表示已过期），无法解析时 null
 */
export function getRemainingHours(expireText, nowMs = Date.now()) {
  const expireMs = parseExpireTimestamp(expireText);
  if (expireMs == null) return null;
  return (expireMs - nowMs) / 3_600_000;
}

/**
 * 判断是否进入可续期窗口
 *
 * 官方规则：剩余使用时间 ≤ {@link RENEWAL_WINDOW_HOURS} 小时时可续期。
 * - 能解析到具体时间：按剩余小时判定（含短暂过期宽限）
 * - 仅有日期或无法解析时间：回退为「今天或明天到期」（24h 寿命下的日期粒度策略）
 *
 * @param {string|null|undefined} expireDate - 页面上的到期日/时间文案
 * @param {string} today - 东京时区今天 YYYY-MM-DD
 * @param {string} tomorrow - 东京时区明天 YYYY-MM-DD
 * @param {{ nowMs?: number, windowHours?: number, overdueGraceHours?: number }} [opts]
 * @returns {boolean}
 */
export function isRenewalDue(expireDate, today, tomorrow, opts = {}) {
  if (!expireDate || typeof expireDate !== 'string') return false;
  const text = expireDate.trim();
  if (!text) return false;

  const windowHours = opts.windowHours ?? RENEWAL_WINDOW_HOURS;
  const overdueGraceHours = opts.overdueGraceHours ?? RENEWAL_OVERDUE_GRACE_HOURS;
  const nowMs = opts.nowMs ?? Date.now();

  // 文案含时分 → 按剩余小时精确判定
  const hasClock = /(?:\d{1,2}:\d{2}|\d{1,2}時\d{1,2})/.test(text);
  if (hasClock) {
    const remaining = getRemainingHours(text, nowMs);
    if (remaining == null) return false;
    return remaining <= windowHours && remaining >= -overdueGraceHours;
  }

  // 仅日期：提取 YYYY-MM-DD（或日本格式）后与今天/明天比较
  const iso = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const date = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    return date === today || date === tomorrow;
  }

  const jp = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (jp) {
    const date = `${jp[1]}-${jp[2].padStart(2, '0')}-${jp[3].padStart(2, '0')}`;
    return date === today || date === tomorrow;
  }

  // 纯日期字符串 YYYY-MM-DD（无多余文字）
  return text === today || text === tomorrow;
}

/**
 * 从详情页链接构建续期申请 URL，并校验来源
 * @param {string} detailHref - 详情页完整 URL
 * @param {string} expectedOrigin - 期望 origin（如 https://secure.xserver.ne.jp）
 * @returns {string} 续期 URL
 * @throws {Error} 链接为空或 origin 不匹配
 */
export function buildRenewUrl(detailHref, expectedOrigin) {
  if (!detailHref || typeof detailHref !== 'string') {
    throw new Error('检测到需续期但未找到续期链接。');
  }
  const renewUrl = detailHref.replace('detail?id', 'freevps/extend/index?id_vps');
  let parsed;
  try {
    parsed = new URL(renewUrl);
  } catch {
    throw new Error(`续期 URL 格式异常: ${renewUrl}`);
  }
  if (parsed.origin !== expectedOrigin) {
    throw new Error(`续期 URL 来源异常: ${parsed.origin} (预期: ${expectedOrigin})`);
  }
  return renewUrl;
}

/**
 * 从当前 URL 推导验证码确认页地址（用于失败重试）
 * @param {string} currentUrl
 * @returns {string}
 */
export function resolveCaptchaRetryUrl(currentUrl) {
  if (!currentUrl || typeof currentUrl !== 'string') return '';
  if (currentUrl.includes('/conf')) return currentUrl;
  return currentUrl.replace('/do', '/conf').replace('/index', '/extend/conf');
}

/**
 * 解析续期提交后的页面结果（纯函数）
 * @param {string} pageText - document.body.innerText
 * @param {string} currentUrl - 当前 URL
 * @returns {{ status: 'success'|'retry'|'fail', reason: string, matched?: string }}
 */
export function evaluateSubmissionResult(pageText = '', currentUrl = '') {
  const text = String(pageText || '');
  const url = String(currentUrl || '');

  // 仍在确认页：通常验证码/Turnstile 未通过，可重试
  if (url.includes('/conf')) {
    const hasAuthFail = text.includes('認証に失敗');
    const reason = hasAuthFail
      ? '验证码识别错误或 Turnstile 认证失败'
      : '页面未跳转，可能验证码或 token 无效';
    return { status: 'retry', reason, matched: hasAuthFail ? '認証に失敗' : '/conf' };
  }

  // 明确失败标识 → 可重试
  const matchedFailure = FAILURE_PATTERNS.find((pat) => text.includes(pat));
  if (matchedFailure) {
    return { status: 'retry', reason: matchedFailure, matched: matchedFailure };
  }

  // 其他错误标识 → 不可重试（避免误刷）
  const matchedError = ERROR_PATTERNS.find((pat) => text.includes(pat));
  if (matchedError) {
    return { status: 'fail', reason: `出现错误标识: ${matchedError}`, matched: matchedError };
  }

  // 明确成功
  const matchedSuccess = SUCCESS_PATTERNS.find((pat) => text.includes(pat));
  if (matchedSuccess) {
    return { status: 'success', reason: '续期成功', matched: matchedSuccess };
  }

  // 无成功标识：尝试识别已知业务失败原因
  const known = KNOWN_FAILURE_REASONS.find((f) => text.includes(f.pattern));
  if (known) {
    return {
      status: 'fail',
      reason: `${known.reason}。URL: ${url}`,
      matched: known.pattern,
    };
  }

  return {
    status: 'fail',
    reason: `续期状态不明确，请人工检查页面内容。URL: ${url}`,
    matched: undefined,
  };
}

/**
 * 从纯文本中提取到期日（ISO 或日本格式）
 * 优先返回最后一个 YYYY-MM-DD（通常是新到期日）
 * @param {string} allText
 * @returns {string|null}
 */
export function extractExpireDateFromText(allText) {
  if (!allText || typeof allText !== 'string') return null;

  const dateMatches = allText.match(/\d{4}-\d{2}-\d{2}/g);
  if (dateMatches && dateMatches.length > 0) {
    return dateMatches[dateMatches.length - 1];
  }

  const jpDateMatch = allText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (jpDateMatch) {
    const [, year, month, day] = jpDateMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return null;
}

/**
 * 清理单元格文本中的多余空白
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function normalizeCellText(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned || null;
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
 * 按东京时区格式化日期时间（中文 locale）
 * @param {Date|number} [when=new Date()]
 * @returns {string}
 */
export function formatTokyoDateTime(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when);
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' });
}

/** 通知中「下次执行」默认间隔（小时）；适配 4GB 剩余≤12h 窗口，建议 ≤6 */
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
 * （不再写死 +24h，避免与每 6 小时调度不符）
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
 * 将执行步骤列表格式化为通知段落（仅 full 模式使用）
 * @param {string[]|null|undefined} processSteps
 * @param {string} [detail=TG_NOTIFY_DETAIL_FULL] - full 时输出步骤；compact 时返回空
 * @returns {string} 空字符串或带前导换行的段落
 */
export function formatProcessSteps(processSteps, detail = TG_NOTIFY_DETAIL_FULL) {
  if (!isFullNotifyDetail(detail)) return '';
  if (!Array.isArray(processSteps) || processSteps.length === 0) return '';
  const lines = processSteps
    .filter((s) => s != null && String(s).trim() !== '')
    .map((s, i) => `${i + 1}. ${escapeHtml(String(s))}`);
  if (lines.length === 0) return '';
  return `\n\n📋 <b>执行过程</b>:\n${lines.join('\n')}`;
}

/**
 * 构建续期成功 Telegram 消息
 * @param {object} params
 * @param {string[]} [params.processSteps] - 执行过程（仅 detail=full 时展示）
 * @param {'full'|'compact'|string} [params.detail='full'] - 通知详细程度
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
}) {
  const mode = parseNotifyDetail(detail);
  const time = escapeHtml(executedAt || formatTokyoDateTime());
  const name = escapeHtml(serverName || '未知');
  const next = escapeHtml(nextRunAt || '');

  if (mode === TG_NOTIFY_DETAIL_COMPACT) {
    return (
      `✅ <b>Xserver VPS 续期成功</b>\n\n` +
      `⏰ 执行时间: ${time}\n` +
      `🖥️ 服务器名: ${name}\n` +
      `📅 新到期日: ${escapeHtml(newExpireDate || '未提取')}\n` +
      `⏭️ 下次执行: ${next}`
    );
  }

  return (
    `✅ <b>Xserver VPS 续期成功</b>\n\n` +
    `⏰ 执行时间: ${time}\n` +
    `🖥️ 服务器名: ${name}\n` +
    `📦 VPS 规格: ${escapeHtml(plan || '未知')}\n` +
    `📅 原到期日: ${escapeHtml(oldExpireDate || '未知')}\n` +
    `📅 新到期日: ${escapeHtml(newExpireDate || '未提取')}\n` +
    `⏭️ 下次执行: ${next}` +
    formatProcessSteps(processSteps, mode)
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
} = {}) {
  const mode = parseNotifyDetail(detail);
  const isNoVps = reasonCode === 'no_free_vps';
  const title = isNoVps
    ? 'ℹ️ <b>Xserver VPS 检查完成 · 未找到免费 VPS</b>'
    : 'ℹ️ <b>Xserver VPS 检查完成 · 无需续期</b>';

  const defaultDetail = isNoVps
    ? '面板中未找到带免费标识的 VPS 条目'
    : `剩余时间未进入可续期窗口（规则: 最长 ${maxHours}h / 剩余≤${windowHours}h 可续）`;

  const time = escapeHtml(executedAt || formatTokyoDateTime());
  const name = escapeHtml(serverName || (isNoVps ? '—' : '未知'));
  const expire = escapeHtml(expireDate || '—');
  const remaining = escapeHtml(formatRemainingHours(remainingHours));
  const next = escapeHtml(nextRunAt || '');

  if (mode === TG_NOTIFY_DETAIL_COMPACT) {
    return [
      title,
      '',
      `⏰ 执行时间: ${time}`,
      `🖥️ 服务器名: ${name}`,
      `📅 当前到期: ${expire}`,
      `⏳ 剩余时间: ${remaining}`,
      `⏭️ 下次执行: ${next}`,
    ].join('\n');
  }

  const lines = [
    title,
    '',
    `⏰ 执行时间: ${time}`,
    `🖥️ 服务器名: ${name}`,
    `📦 VPS 规格: ${escapeHtml(plan || (isNoVps ? '—' : '未知'))}`,
    `📅 当前到期: ${expire}`,
    `⏳ 剩余时间: ${remaining}`,
    `📌 判定结果: ${escapeHtml(reasonDetail || defaultDetail)}`,
    `⏭️ 下次执行: ${next}`,
  ];

  return lines.join('\n') + formatProcessSteps(processSteps, mode);
}

/**
 * 构建续期失败 Telegram 消息
 * @param {object} params
 * @param {string[]} [params.processSteps] - 执行过程（仅 detail=full 时展示）
 * @param {'full'|'compact'|string} [params.detail='full']
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
}) {
  const mode = parseNotifyDetail(detail);
  const head =
    `${isEscalation ? '🚨 <b>【告警升级】</b>' : '❌'} <b>Xserver VPS 续期失败</b>\n\n` +
    `⏰ 执行时间: ${escapeHtml(executedAt || formatTokyoDateTime())}\n` +
    `💥 错误信息: <code>${escapeHtml(errorMessage || '未知错误')}</code>\n` +
    `${isEscalation ? `⚠️ <b>连续失败 ${consecutiveFailures} 次</b>，请立即人工介入！\n` : ''}`;

  if (mode === TG_NOTIFY_DETAIL_COMPACT) {
    return head.trimEnd();
  }

  return (
    head +
    `\n${proxyHint}\n\n` +
    `📋 失败说明:\n` +
    `- 验证码识别已自动重试 ${captchaMaxRetry} 次\n` +
    `- Turnstile 已使用 API 求解\n` +
    `- 如持续失败，可尝试:\n` +
    `  1. 配置住宅 IP 代理（PROXY_* 环境变量）\n` +
    `  2. 检查 CapSolver API 余额是否充足\n` +
    `  3. 人工登录确认账号状态` +
    formatProcessSteps(processSteps, mode)
  );
}

/**
 * 构建代理提示文案（失败通知用）
 * @param {object} opts
 * @param {boolean} opts.hasProxy
 * @param {string} [opts.proxyType]
 * @param {string} [opts.maskedAddress]
 * @param {string|number} [opts.proxyPort]
 * @returns {string}
 */
export function buildProxyHint({ hasProxy, proxyType, maskedAddress, proxyPort }) {
  if (hasProxy) {
    return `📡 当前使用代理: ${proxyType}://${maskedAddress}:${proxyPort}`;
  }
  return (
    `💡 <b>优化建议</b>:\n` +
    `如果多次续期失败，建议配置纯净家宽 IP 代理后重试。\n` +
    `代理可提高 Cloudflare Turnstile 通过率。`
  );
}
