/**
 * 续期业务纯逻辑
 * 到期判定、URL 构建、提交结果解析、到期日提取、通知文案
 */

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
 * 判断到期日是否需要续期（今天或明天到期）
 * @param {string|null|undefined} expireDate - 页面上的到期日 YYYY-MM-DD
 * @param {string} today - 东京时区今天
 * @param {string} tomorrow - 东京时区明天
 * @returns {boolean}
 */
export function isRenewalDue(expireDate, today, tomorrow) {
  if (!expireDate || typeof expireDate !== 'string') return false;
  const date = expireDate.trim();
  return date === today || date === tomorrow;
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

/**
 * 构建续期成功 Telegram 消息
 * @param {object} params
 * @returns {string}
 */
export function buildSuccessNotifyMessage({
  serverName,
  plan,
  oldExpireDate,
  newExpireDate,
  executedAt,
  nextRunAt,
}) {
  return (
    `✅ <b>Xserver VPS 续期成功</b>\n\n` +
    `⏰ 执行时间: ${escapeHtml(executedAt || formatTokyoDateTime())}\n` +
    `🖥️ 服务器名: ${escapeHtml(serverName || '未知')}\n` +
    `📦 VPS 规格: ${escapeHtml(plan || '未知')}\n` +
    `📅 原到期日: ${escapeHtml(oldExpireDate || '未知')}\n` +
    `📅 新到期日: ${escapeHtml(newExpireDate || '未提取')}\n` +
    `⏭️ 下次执行: ${escapeHtml(nextRunAt || '')}`
  );
}

/**
 * 构建续期失败 Telegram 消息
 * @param {object} params
 * @returns {string}
 */
export function buildFailureNotifyMessage({
  errorMessage,
  consecutiveFailures = 0,
  isEscalation = false,
  proxyHint = '',
  captchaMaxRetry = 3,
  executedAt,
}) {
  return (
    `${isEscalation ? '🚨 <b>【告警升级】</b>' : '❌'} <b>Xserver VPS 续期失败</b>\n\n` +
    `⏰ 执行时间: ${escapeHtml(executedAt || formatTokyoDateTime())}\n` +
    `💥 错误信息: <code>${escapeHtml(errorMessage || '未知错误')}</code>\n` +
    `${isEscalation ? `⚠️ <b>连续失败 ${consecutiveFailures} 次</b>，请立即人工介入！\n` : ''}` +
    `\n${proxyHint}\n\n` +
    `📋 失败说明:\n` +
    `- 验证码识别已自动重试 ${captchaMaxRetry} 次\n` +
    `- Turnstile 已使用 API 求解\n` +
    `- 如持续失败，可尝试:\n` +
    `  1. 配置住宅 IP 代理（PROXY_* 环境变量）\n` +
    `  2. 检查 CapSolver API 余额是否充足\n` +
    `  3. 人工登录确认账号状态`
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
