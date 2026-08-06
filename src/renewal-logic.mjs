/**
 * 续期业务纯逻辑
 * 到期判定、URL 构建、提交结果解析、到期日提取
 *
 * 官方免费 VPS（4GB）规则（2026-07 起）：
 * - 最长使用时间：24 小时（原 48 小时）
 * - 可续期条件：剩余使用时间 ≤ 12 小时（原 ≤ 24 小时）
 *
 * 通知文案构建见 src/notify.mjs（2026-08-04 拆分）。
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
 * 官方「未进入 12 小时续期窗口」拦截页特征（2026-07-23 官方面板核对）
 *
 * 路径：
 * - `/freevps/extend/index`：可能同时展示政策说明 +「以降にお試し」+ 继续按钮
 * - `/freevps/extend/conf`：纯拦截页（无验证码图、无提交），用户 issue #5 报错即此 URL
 *
 * 判定以「请之后再试」为主信号，避免仅出现政策脚注「12時間前から更新手続きが可能」时误拦。
 * 文案示例：
 *   利用期限の12時間前から更新手続きが可能です。
 *   利用を継続される場合は、2026年7月24日12：00以降にお試しください。
 */
export const RENEWAL_WINDOW_BLOCKED_PATTERNS = [
  '以降にお試し',
  '以降に再度',
  '以降にお申し込み',
];

/** 辅助确认：与「请之后再试」同时出现时增强可信度 */
export const RENEWAL_WINDOW_CONTEXT_PATTERNS = [
  '12時間前',
  '更新手続き',
  '契約更新',
  '利用期限',
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
 * - 优先按剩余小时判定（含时分则精确；仅日期时按东京日末 23:59:59 保守估算）
 * - 无法解析时间戳时：回退为「今天到期」（不再把「明天」一律视为可续，避免 #5 误入流程）
 *
 * 说明：面板常只显示日期。纯日期按日末估算时，剩余 ≤12h 约等于「到期日 12:00 之后」，
 * 与官方「利用期限の12時間前から」在「期限=当日结束」场景一致。
 *
 * @param {string|null|undefined} expireDate - 页面上的到期日/时间文案
 * @param {string} today - 东京时区今天 YYYY-MM-DD
 * @param {string} tomorrow - 东京时区明天 YYYY-MM-DD（保留参数兼容调用方；小时判定下可不依赖）
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

  // 能解析时间戳 → 统一按剩余小时（官方 12h 窗口 + 过期宽限）
  const remaining = getRemainingHours(text, nowMs);
  if (remaining != null) {
    return remaining <= windowHours && remaining >= -overdueGraceHours;
  }

  // 无法解析：仅当文案明确是「今天」时才视为可续（避免明天日期误触发）
  const iso = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const date = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    return date === today;
  }

  const jp = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (jp) {
    const date = `${jp[1]}-${jp[2].padStart(2, '0')}-${jp[3].padStart(2, '0')}`;
    return date === today;
  }

  return text === today;
}

/**
 * 从官方拦截页文案提取「请于某时之后再试」的建议时间
 * 支持：2026年7月24日12：00 / 2026年7月24日 12:00 / 2026-07-24 12:00
 * @param {string} pageText
 * @returns {string|null} 规范化展示文案，如 `2026-07-24 12:00`
 */
export function extractRetryAfterFromText(pageText) {
  if (!pageText || typeof pageText !== 'string') return null;
  const text = pageText.replace(/\s+/g, ' ');

  // 日本格式：2026年7月24日12：00 / 2026年7月24日 12:00
  const jp = text.match(
    /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[：:時](\d{1,2})/,
  );
  if (jp) {
    const [, y, mo, d, hh, mm] = jp;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')} ${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`;
  }

  // ISO：2026-07-24 12:00 或 2026/07/24 12:00
  const iso = text.match(
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/,
  );
  if (iso) {
    const [, y, mo, d, hh, mm] = iso;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')} ${hh.padStart(2, '0')}:${mm}`;
  }

  return null;
}

/**
 * 检测是否为官方「未满 12 小时续期窗口」拦截页（非验证码页）
 *
 * 实机观察（已登录面板，到期 2026-07-25，剩余约 52h）：
 * - index / conf 均可出现「12時間前…」「yyyy年m月d日 HH:mm以降にお試し」
 * - conf 页无 `img[src^=data:]`、无验证码输入框；仅标题 + 说明 + 戻る
 * - index 页即使未开窗也可能仍有「引き続き無料VPSの利用を継続する」按钮，故必须以文案判定，不能只靠按钮有无
 *
 * @param {string} pageText - document.body.innerText
 * @param {string} [currentUrl]
 * @returns {{ blocked: boolean, reason: string|null, retryAfter: string|null, matched: string|null, url?: string|null }}
 */
export function detectRenewalWindowBlocked(pageText = '', currentUrl = '') {
  const text = String(pageText || '');
  if (!text.trim()) {
    return { blocked: false, reason: null, retryAfter: null, matched: null };
  }

  // 已进入验证码流程则不当作窗口拦截
  if (
    text.includes('画像認証') ||
    text.includes('上の画像') ||
    /cf-turnstile|turnstile/i.test(text)
  ) {
    return { blocked: false, reason: null, retryAfter: null, matched: null };
  }

  const matched = RENEWAL_WINDOW_BLOCKED_PATTERNS.find((pat) => text.includes(pat));
  if (!matched) {
    return { blocked: false, reason: null, retryAfter: null, matched: null };
  }

  // 要求同时具备续期语境，降低其它「以降にお試し」页面的误匹配
  const hasContext = RENEWAL_WINDOW_CONTEXT_PATTERNS.some((pat) => text.includes(pat));
  if (!hasContext) {
    return { blocked: false, reason: null, retryAfter: null, matched: null };
  }

  const retryAfter = extractRetryAfterFromText(text);
  const reason = retryAfter
    ? `未进入官方续期窗口（剩余须 ≤${RENEWAL_WINDOW_HOURS}h）；请于 ${retryAfter}（东京）之后再试`
    : `未进入官方续期窗口（剩余须 ≤${RENEWAL_WINDOW_HOURS}h 方可办理更新手续）`;

  return {
    blocked: true,
    reason,
    retryAfter,
    matched,
    // 附带 URL 便于日志（不参与判定）
    url: currentUrl || null,
  };
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
  // index 段 → conf 段：官方路径为 .../freevps/extend/index → .../freevps/extend/conf
  // （原实现 /index → /extend/conf 会把 extend 段重复拼接成 .../extend/extend/conf）
  return currentUrl.replace('/do', '/conf').replace('/index', '/conf');
}

/**
 * 验证码/提交失败后的重试导航决策（纯函数）
 *
 * 实机：`/extend/do` 与裸 `/extend/conf` 常无 `id_vps`，直接 goto conf 往往拿不到
 * Base64 验证码图。优先回到带 `id_vps` 的 index，再由编排层点确认进入 conf。
 *
 * @param {string} currentUrl
 * @param {{ renewUrl?: string|null }} [options]
 * @returns {{ mode: 'renew_index'|'reload_conf'|'goto_conf', url: string }}
 */
export function resolveCaptchaRetryNavigation(currentUrl, options = {}) {
  const renewUrl = typeof options?.renewUrl === 'string' ? options.renewUrl.trim() : '';
  if (renewUrl) {
    return { mode: 'renew_index', url: renewUrl };
  }

  const url = typeof currentUrl === 'string' ? currentUrl : '';
  if (url.includes('/conf')) {
    return { mode: 'reload_conf', url };
  }

  return { mode: 'goto_conf', url: resolveCaptchaRetryUrl(url) };
}

/**
 * 是否需要将浏览器 UA 对齐到打码平台返回的 UA（纯函数）
 * @param {string} currentUA
 * @param {string|null|undefined} apiUserAgent
 * @returns {boolean}
 */
export function needsUserAgentAlignment(currentUA, apiUserAgent) {
  const current = typeof currentUA === 'string' ? currentUA : '';
  const api = typeof apiUserAgent === 'string' ? apiUserAgent : '';
  if (!current || !api) return false;
  return current !== api;
}

/**
 * Turnstile 求解结果是否允许继续提交续期表单（纯函数）
 * 无有效 token 时禁止强行提交，避免必然「認証に失敗」并污染重试页。
 * @param {{ ok?: boolean }|null|undefined} turnstileResult
 * @returns {boolean}
 */
export function shouldSubmitAfterTurnstile(turnstileResult) {
  return turnstileResult?.ok === true;
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
