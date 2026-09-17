/**
 * Xserver 面板业务流程
 * 登录 / 个人信息同意页 / 到期检查 / 续期确认 / 验证码提交
 * （浏览器步骤；流程编排与通知由 xserver-vps-renew.mjs 的 main() 负责）
 *
 * 所有函数接收 { config, logger } 上下文：
 * - config：CONFIG 对象（URL、超时、API 端点等）
 * - logger：分级日志对象（info/debug/warn/error）
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { NOOP_LOGGER, getTokyoDateString } from './utils.mjs';
import { waitForNav, getText, getBodyText, waitForSelectorSoft, waitForPageReady, safeEvaluate } from './page-utils.mjs';
import {
  isRenewalDue,
  buildRenewUrl,
  resolveCaptchaRetryNavigation,
  shouldSubmitAfterTurnstile,
  evaluateSubmissionResult,
  detectRenewalWindowBlocked,
  normalizeCellText,
  extractVpsInfoFromCellTexts,
  getRemainingHours,
  FREE_VPS_MAX_HOURS,
  RENEWAL_WINDOW_HOURS,
} from './renewal-logic.mjs';
import { waitForTurnstile, getTurnstileToken } from './turnstile-flow.mjs';
import { isTurnstileOutageError } from './turnstile.mjs';
import { recognizeCaptcha, saveCaptchaSample } from './captcha.mjs';

const RETRYABLE_LOGIN_NAVIGATION_ERRORS = [
  'net::err_timed_out',
  'navigation timeout',
  'net::err_connection_reset',
  'net::err_connection_closed',
  'net::err_network_changed',
  'net::err_proxy_connection_failed',
];

function isRetryableLoginNavigationError(error) {
  const message = String(error?.message || '').toLowerCase();
  return RETRYABLE_LOGIN_NAVIGATION_ERRORS.some((pattern) => message.includes(pattern));
}

async function reloadVpsIndex(page, config, logger) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(`${config.BASE_URL}/xapanel/xvps/index`, {
        waitUntil: 'domcontentloaded',
        timeout: config.NAVIGATION_TIMEOUT,
      });
      const ready = await waitForPageReady(
        page,
        Math.min(config?.NAVIGATION_TIMEOUT || 15_000, 15_000),
        logger,
      );
      if (!ready) {
        throw new Error('VPS 列表页页面上下文未就绪');
      }
      try {
        await page.waitForSelector('tr:has(.freeServerIco)', { timeout: 15_000 });
      } catch {
        // 页面已稳定但没有免费 VPS 行，交由调用方按业务规则处理。
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        logger.warn?.(`VPS 列表页上下文未就绪，将重载重试（${attempt}/1）: ${error.message}`);
        await sleep(1_000);
      }
    }
  }
  throw new Error(`VPS 列表页页面上下文未就绪: ${lastError?.message || '未知导航错误'}`, {
    cause: lastError,
  });
}

/**
 * 访问登录页；代理偶发超时只在登录初始导航阶段有限重试，避免重复提交凭据。
 * @param {import('puppeteer').Page} page
 * @param {object} config
 * @param {object} logger
 * @returns {Promise<void>}
 */
export async function navigateToLoginPage(page, config, logger = NOOP_LOGGER) {
  const maxAttempts = Math.max(1, Number(config?.LOGIN_NAVIGATION_RETRIES) || 1);
  const retryDelayMs = Math.max(0, Number(config?.LOGIN_NAVIGATION_RETRY_DELAY_MS) || 0);
  const loginUrl = `${config.BASE_URL}${config.LOGIN_PATH}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.NAVIGATION_TIMEOUT,
      });
      return;
    } catch (error) {
      if (!isRetryableLoginNavigationError(error) || attempt >= maxAttempts) {
        throw error;
      }
      logger.warn?.(
        `登录页导航网络异常，将重试（${attempt}/${maxAttempts - 1}）: ${error.message}`,
      );
      await sleep(retryDelayMs);
    }
  }
}

/** 构造「需要人工确认」错误：自动同意处理无效，需用户登录手动确认后重跑容器 */
function manualConfirmError(message) {
  const error = new Error(message);
  error.code = 'MANUAL_CONFIRMATION_REQUIRED';
  return error;
}

/**
 * 登录 Xserver 面板
 * @param {import('puppeteer').Page} page
 * @param {{ config?: object, logger?: object }} [ctx]
 * @returns {Promise<{ viaCookie: boolean }>}
 */
export async function handleLogin(page, { config, logger = NOOP_LOGGER } = {}) {
  logger.info('正在导航到登录页面...');
  await navigateToLoginPage(page, config, logger);

  // 若已登录（被重定向到面板），直接返回
  if (page.url().includes('/xvps/index')) {
    logger.info('Cookie 有效，已处于登录状态。');
    return { viaCookie: true };
  }

  // 检查页面是否有登录错误（记录并在最终抛错时附带，便于 Telegram 诊断）
  let loginErrorText = null;
  const errorText = await getText(page, '.errorMessage');
  if (errorText) {
    loginErrorText = errorText;
    logger.error(`登录页存在错误信息: ${errorText}`);
  }

  logger.info('正在填充凭据并提交...');
  await page.type('#memberid', config.MEMBER_ID, { delay: 50 });
  await page.type('#user_password', config.PASSWORD, { delay: 50 });

  // 点击提交并等待导航
  const submitBtn = await page.$('input[name="action_user_login"]')
    || await page.$('#login_area input[type="submit"]');

  if (submitBtn) {
    await Promise.all([
      waitForNav(page, config.NAVIGATION_TIMEOUT, logger),
      submitBtn.click(),
    ]);
  } else {
    await Promise.all([
      waitForNav(page, config.NAVIGATION_TIMEOUT, logger),
      page.$eval('#login_area', (form) => form.submit()),
    ]);
  }

  // 提交后确保新页面上下文稳定挂载，防 detached Frame 瞬态报错
  await waitForPageReady(page, 15_000, logger);

  if (page.url().includes('/login/')) {
    const pageHint = loginErrorText ? `（页面提示: ${loginErrorText}）` : '';
    throw new Error(`登录失败，请检查 XSERVER_MEMBER_ID 和 XSERVER_PASSWORD。${pageHint}`);
  }

  logger.info('登录成功！');
  return { viaCookie: false };
}

/**
 * 处理官方「個人情報の取り扱いについて」同意页（2026-08-05 上线，登录后必经）。
 * 未同意时面板各页均会被重定向回 /xapanel/myaccount/agreement，导致误判「未找到免费 VPS」。
 * 勾选 agree_flag 复选框并提交表单（原生表单 POST /xapanel/myaccount/agreement/do）。
 * 提交后仍停留在同意页则抛错，避免静默误判。
 * @param {import('puppeteer').Page} page
 * @param {{ config?: object, logger?: object }} [ctx]
 */
export async function ensureAgreementAccepted(page, { config, logger = NOOP_LOGGER } = {}) {
  await waitForPageReady(page, 10_000, logger);
  if (!page.url().includes('/xapanel/myaccount/agreement')) {
    return;
  }

  logger.info('检测到官方「個人情報の取り扱いについて」同意页，正在同意...');

  // 勾选同意复选框（原生 checkbox，传统 jQuery 表单无复杂校验）
  const checkbox = await page.$('#agree_flag_1, input[name="agree_flag"]');
  if (!checkbox) {
    throw manualConfirmError('同意页未找到同意复选框（agree_flag），可能为官方改版，需人工确认。');
  }
  const checked = await checkbox.evaluate((el) => el.checked);
  if (!checked) {
    await checkbox.click();
    logger.info('已勾选「個人情報の取り扱いについて」同意复选框');
  }

  // 提交表单（POST /xapanel/myaccount/agreement/do）
  const submitBtn = await page.$('input[name="action_user_agreement_do"]');
  if (!submitBtn) {
    throw manualConfirmError('同意页未找到提交按钮（action_user_agreement_do），可能为官方改版，需人工确认。');
  }
  await Promise.all([waitForNav(page, config.NAVIGATION_TIMEOUT, logger), submitBtn.click()]);
  await waitForPageReady(page, 15_000, logger);

  // 校验：提交后仍停留在同意页说明同意未生效，直接抛错避免后续误判
  if (page.url().includes('/xapanel/myaccount/agreement')) {
    const bodyText = await getBodyText(page);
    logger.error(`同意提交后仍停留在同意页，页面片段: ${bodyText.replace(/\s+/g, ' ').slice(0, 200)}`);
    throw manualConfirmError('個人情報同意提交失败，仍停留在同意页，需人工登录确认。');
  }

  logger.info(`同意页处理完成，当前页面: ${page.url()}`);
}

/**
 * 检查是否需要续期
 * @param {import('puppeteer').Page} page
 * @param {{ config?: object, logger?: object }} [ctx]
 * @returns {Promise<
 *   | { needed: true, renewUrl: string, vpsInfo: { serverName: string|null, plan: string|null, expireDate: string|null }, remainingHours: number|null }
 *   | { needed: false, reasonCode: 'not_due'|'no_free_vps'|'window_blocked', vpsInfo: object, remainingHours: number|null, reasonDetail: string, needsManualConfirmation?: boolean }
 * >}
 */
export async function checkRenewalNeeded(page, { config, logger = NOOP_LOGGER } = {}) {
  logger.info('正在检查续期状态...');

  // 确保进入状态检查前页面上下文稳定
  await waitForPageReady(page, Math.min(config?.NAVIGATION_TIMEOUT || 15_000, 15_000), logger);

  if (!page.url().includes('/xvps/index')) {
    await page.goto(`${config.BASE_URL}/xapanel/xvps/index`, {
      waitUntil: 'domcontentloaded',
      timeout: config.NAVIGATION_TIMEOUT,
    });
    await waitForPageReady(page, Math.min(config?.NAVIGATION_TIMEOUT || 15_000, 15_000), logger);
  }

  // 官方 xvps 列表表格为 JS 异步渲染，domcontentloaded 时行可能尚未插入 DOM；
  // 等待免费 VPS 行出现，避免在页面加载变慢时误判「未找到免费 VPS」。
  // 超时后先采集页面结构诊断（区分「官方改版」与「渲染时序」两类根因），再走原判定路径。
  const tableWaitTimeout = Math.min(Math.max(config?.NAVIGATION_TIMEOUT || 30_000, 10_000), 30_000);
  try {
    await page.waitForSelector('tr:has(.freeServerIco)', { timeout: tableWaitTimeout });
  } catch {
    logger.warn(`等待免费 VPS 表格超时（${Math.round(tableWaitTimeout / 1000)}s），正在采集页面诊断信息...`);
    await waitForPageReady(page, 10_000, logger);
    const diag = await safeEvaluate(page, () => {
      const firstTable = document.querySelector('table');
      return {
        url: location.href,
        freeIcoCount: document.querySelectorAll('.freeServerIco').length,
        trCount: document.querySelectorAll('tr').length,
        detailLinkCount: document.querySelectorAll('a[href*="/xvps/server/detail"]').length,
        tableHtml: firstTable ? firstTable.outerHTML.slice(0, 800) : null,
        bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
      };
    }, null, 3, 500, logger);
    if (diag) {
      logger.warn(
        `诊断: url=${diag.url} | freeServerIco=${diag.freeIcoCount} | tr=${diag.trCount}`
        + ` | detail链接=${diag.detailLinkCount}`,
      );
      if (diag.tableHtml) {
        logger.warn(`诊断-表格HTML片段: ${diag.tableHtml}`);
      } else {
        logger.warn(`诊断-正文片段: ${diag.bodyText}`);
      }
    }

    // 若诊断显示页面完全没有表格或 tr 行（可能因慢网络导致渲染尚未完成或页面加载中断），尝试重新加载 VPS 列表页
    if (!diag || diag.trCount === 0) {
      logger.warn('未在页面中检测到有效表格，可能因慢网络加载中断，尝试重新加载 VPS 列表页...');
      try {
        await reloadVpsIndex(page, config, logger);
      } catch (retryErr) {
        logger.error(`重新加载 VPS 列表页失败，停止使用当前页面上下文: ${retryErr.message}`);
        throw retryErr;
      }
    }
  }

  // 计算今天和明天的日期（东京时区，yyyy-mm-dd 格式）
  const today = getTokyoDateString();
  const tomorrow = getTokyoDateString(Date.now(), 1);
  logger.debug(`参考日期（东京）: 今天 ${today} / 明天 ${tomorrow}`);

  // 页面端仅提取原始文本（DOM 上下文不做业务判定），
  // 服务器名/规格解析收敛到纯函数 extractVpsInfoFromCellTexts（可单测）
  // 注意：此处 defaultValue 为 undefined，若 evaluate 因 Frame 销毁/崩溃报错则直接抛出，
  // 严禁回退为 null 误判为业务上的「未找到免费 VPS」导致静默跳过！
  const result = await safeEvaluate(page, () => {
    const row = document.querySelector('tr:has(.freeServerIco)');
    if (!row) {
      return null;
    }

    const termEl = row.querySelector('.contract__term');
    const detailLink = row.querySelector('a[href^="/xapanel/xvps/server/detail?id="]');

    return {
      expireDate: termEl ? termEl.textContent.trim() : null,
      detailHref: detailLink ? detailLink.href : null,
      cellTexts: Array.from(row.querySelectorAll('td'))
        .map((cell) => cell.textContent.replace(/\s+/g, ' ').trim()),
    };
  }, undefined, 5, 800, logger);

  if (!result) {
    // 未停留在 VPS 面板页（URL 不含 /xvps/）说明被官方新增/变更的确认页拦截，
    // 标记需人工确认，由 main() 发送提醒而不是当作普通「无免费 VPS」跳过
    const onVpsPanel = page.url().includes('/xvps/');
    const needsManualConfirmation = !onVpsPanel;
    logger.info(needsManualConfirmation
      ? `未找到免费 VPS 条目（当前页面: ${page.url()}，疑似被官方确认页拦截）。`
      : '未找到免费 VPS 条目。');
    return {
      needed: false,
      reasonCode: 'no_free_vps',
      vpsInfo: {
        serverName: null,
        plan: null,
        expireDate: null,
      },
      remainingHours: null,
      reasonDetail: needsManualConfirmation
        ? `未停留在 VPS 列表页（当前: ${page.url()}），疑似被官方新增/变更的确认页拦截，需人工登录确认`
        : '面板中未找到带免费标识的 VPS 条目',
      needsManualConfirmation,
    };
  }

  // 清理 VPS 信息中的多余空白符
  const { serverName: parsedServerName, plan: parsedPlan } =
    extractVpsInfoFromCellTexts(result.cellTexts);
  const cleanServerName = normalizeCellText(parsedServerName);
  const cleanPlan = normalizeCellText(parsedPlan);
  // 统一时间基准：剩余小时与到期判定使用同一 nowMs，避免跨秒边界判定不一致
  const nowMs = Date.now();
  const remainingHours = getRemainingHours(result.expireDate, nowMs);

  logger.info(
    `VPS: ${cleanServerName ?? '未找到'}`
    + ` | 规格 ${cleanPlan ?? '未找到'}`
    + ` | 到期 ${result.expireDate ?? '未找到'}`
    + (remainingHours != null ? ` | 剩余约 ${remainingHours.toFixed(1)}h` : ''),
  );

  // 官方规则：4GB 最长 FREE_VPS_MAX_HOURS 小时，剩余 ≤ RENEWAL_WINDOW_HOURS 小时可续期
  // 纯日期按东京日末估算剩余小时，不再把「明天到期」一律判为可续（#5）
  if (!isRenewalDue(result.expireDate, today, { nowMs })) {
    const remainingLabel =
      remainingHours != null ? `剩余约 ${remainingHours.toFixed(1)}h` : '剩余时间未知';
    const reasonDetail =
      `无需续期（到期: ${result.expireDate}；${remainingLabel}；` +
      `规则: 最长 ${FREE_VPS_MAX_HOURS}h / 剩余≤${RENEWAL_WINDOW_HOURS}h 可续；` +
      `今天 ${today} / 明天 ${tomorrow}）`;
    logger.info(reasonDetail);
    return {
      needed: false,
      reasonCode: 'not_due',
      vpsInfo: {
        serverName: cleanServerName,
        plan: cleanPlan,
        expireDate: result.expireDate,
      },
      remainingHours,
      reasonDetail,
    };
  }

  const renewUrl = buildRenewUrl(result.detailHref, config.BASE_URL);
  logger.info(`需要续期！URL: ${renewUrl}`);

  // 返回续期 URL 和 VPS 信息
  return {
    needed: true,
    renewUrl,
    vpsInfo: {
      serverName: cleanServerName,
      plan: cleanPlan,
      expireDate: result.expireDate,
    },
    remainingHours,
  };
}

/**
 * 读取当前页正文并检测官方续期窗口拦截
 * @param {import('puppeteer').Page} page
 * @param {object} [logger=NOOP_LOGGER] - 分级日志对象
 * @returns {Promise<null | { status: 'window_blocked', reason: string, retryAfter: string|null }>}
 */
async function detectBlockedPage(page, logger = NOOP_LOGGER) {
  const pageText = await getBodyText(page);
  const detection = detectRenewalWindowBlocked(pageText, page.url());
  if (!detection.blocked) return null;
  logger.info(`⏳ 官方拦截：${detection.reason}`);
  return {
    status: 'window_blocked',
    reason: detection.reason,
    retryAfter: detection.retryAfter,
  };
}

/**
 * 打开续期申请页并点击确认。
 * 若官方返回「未满 12 小时窗口」拦截页，则软跳过，不进入验证码流程。
 *
 * 官方页面路径（2026-07-23 核对）：
 * 1. GET `/freevps/extend/index?id_vps=…` — 可能已显示「以降にお試し」说明，但按钮仍在
 * 2. POST/导航 → `/freevps/extend/conf` — 窗口未开时为纯拦截页（issue #5 用户报错 URL）；
 *    窗口已开时才是验证码 + Turnstile 页
 *
 * @param {import('puppeteer').Page} page
 * @param {string} renewUrl
 * @param {{ config?: object, logger?: object }} [ctx]
 * @returns {Promise<
 *   | { status: 'ready' }
 *   | { status: 'window_blocked', reason: string, retryAfter: string|null }
 * >}
 */
export async function handleRenewalConfirm(page, renewUrl, { config, logger = NOOP_LOGGER } = {}) {
  logger.info('正在导航到续期申请页面...');
  await page.goto(renewUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.NAVIGATION_TIMEOUT,
  });

  // index 页：未开窗时正文已含「以降にお試し」——直接软跳过，不必再点确认
  // （实机：按钮 formaction=/extend/conf 在未开窗时仍可能存在，不能靠「有无按钮」判断）
  const indexBlocked = await detectBlockedPage(page, logger);
  if (indexBlocked) return indexBlocked;

  const extendBtn = await page.$('[formaction="/xapanel/xvps/server/freevps/extend/conf"]');
  if (!extendBtn) {
    // 无确认按钮时再读一次正文，优先识别窗口拦截，避免笼统报错
    const blocked = await detectBlockedPage(page, logger);
    if (blocked) return blocked;
    throw new Error('未找到续期确认按钮。');
  }

  logger.info('正在点击续期确认...');
  const [navOk] = await Promise.all([
    waitForNav(page, config.NAVIGATION_TIMEOUT, logger),
    extendBtn.click(),
  ]);

  if (!navOk) {
    logger.warn('⚠️ 确认进入续期页导航未能在预期时间内完成，尝试确保页面上下文就绪...');
    await waitForPageReady(page, config.NAVIGATION_TIMEOUT, logger);
  }

  // conf 页：#5 用户反馈的拦截 URL；也可能是真正的验证码页
  const confBlocked = await detectBlockedPage(page, logger);
  if (confBlocked) return confBlocked;

  let currentUrl = '';
  try {
    currentUrl = page.url();
  } catch (e) {
    logger.debug(`获取当前页面 URL 异常: ${e.message}`);
  }

  // 业务校验 Invariant Gate：必须确认离开 index 申请页，或确实进入了验证码/Turnstile 页面
  const isConfUrl = currentUrl.includes('/extend/conf');
  const hasCaptchaFeatures = await page.evaluate(() => {
    return Boolean(
      document.querySelector('img[src^="data:"]')
      || document.querySelector('[placeholder*="上の画像"]')
      || document.querySelector('.cf-turnstile')
      || document.querySelector('iframe[src*="challenges.cloudflare.com"]')
      || document.querySelector('input[name="cf-turnstile-response"]')
    );
  }).catch(() => false);

  if (!isConfUrl && !hasCaptchaFeatures) {
    if (currentUrl.includes('/extend/index')) {
      throw new Error(`点击续期确认后仍停留在申请首页（${currentUrl}），未成功跳转至验证码确认页`);
    }
    throw new Error(`进入续期确认页异常，未检测到验证码特征（当前 URL: ${currentUrl || 'unknown'}）`);
  }

  logger.info(`已进入验证码页面: ${currentUrl}`);
  return { status: 'ready' };
}

/**
 * 验证码/提交失败后回到可识别验证码的页面
 * 优先经带 id_vps 的 index 再点确认进 conf；裸 /conf 常无验证码图。
 * @param {import('puppeteer').Page} page
 * @param {string} currentUrl
 * @param {string|null|undefined} renewUrl
 * @param {{ config?: object, logger?: object }} [ctx]
 */
async function navigateForCaptchaRetry(page, currentUrl, renewUrl, { config, logger = NOOP_LOGGER } = {}) {
  await waitForPageReady(page, config?.NAVIGATION_TIMEOUT || 30_000, logger);
  let safeCurrentUrl = currentUrl;
  if (!safeCurrentUrl) {
    try {
      safeCurrentUrl = page.url();
    } catch {
      safeCurrentUrl = '';
    }
  }
  const nav = resolveCaptchaRetryNavigation(safeCurrentUrl, { renewUrl });

  if (nav.mode === 'renew_index') {
    logger.info(`⏭️ 重试：回到续期申请页再进入验证码（${nav.url}）`);
    const confirmResult = await handleRenewalConfirm(page, nav.url, { config, logger });
    if (confirmResult?.status === 'window_blocked') {
      throw new Error(confirmResult.reason || '未进入官方 12 小时续期窗口');
    }
    // handleRenewalConfirm 已落到 conf；软等待验证码图渲染（原固定 2s，渲染快时更快）
    await waitForSelectorSoft(page, 'img[src^="data:"]', 2000, logger);
    return;
  }

  if (nav.mode === 'reload_conf') {
    logger.info('⏭️ 重试：刷新当前验证码确认页');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: config.NAVIGATION_TIMEOUT });
  } else {
    if (!nav.url) {
      throw new Error('无法推导验证码重试 URL（缺少 renewUrl 且当前页无法映射到 conf）');
    }
    logger.warn(`⏭️ 重试：降级直接打开 conf（可能无验证码图）: ${nav.url}`);
    await page.goto(nav.url, { waitUntil: 'domcontentloaded', timeout: config.NAVIGATION_TIMEOUT });
  }
  // Base64 内嵌图渲染需要时间：软等待替代固定 3s（渲染快时立即继续）
  await waitForSelectorSoft(page, 'img[src^="data:"]', 3000, logger);
}

/** 提交结果轮询的自适应退避阈值：早期窗口（毫秒），此期间保持基础间隔灵敏探测 */
const SUBMISSION_POLL_DENSE_WINDOW_MS = 10_000;
/** 中期窗口（毫秒）：超过后进入稀疏轮询（官方处理需 60-90s，后期密轮询无收益） */
const SUBMISSION_POLL_SPARSE_WINDOW_MS = 30_000;
/** 中期轮询间隔下限（毫秒） */
const SUBMISSION_POLL_MID_INTERVAL_MS = 1_000;
/** 后期轮询间隔下限（毫秒） */
const SUBMISSION_POLL_LATE_INTERVAL_MS = 2_000;

/**
 * 提交结果轮询间隔自适应退避（纯函数）
 * 提交后前 10s 是成功/失败信号最常见窗口，保持 base 间隔灵敏度；
 * 官方 /extend/do 处理需 60-90s，中后期每次轮询都是一次 CDP evaluate 往返，
 * 固定 400ms 跑满 120s ≈ 300 次往返；退避后 ≈90 次（降约 70%）且判定语义不变
 * @param {number} elapsedMs - 距轮询开始的毫秒数
 * @param {number} baseIntervalMs - 调用方基础间隔
 * @returns {number} 本轮应睡眠的毫秒数
 */
export function resolveSubmissionPollIntervalMs(elapsedMs, baseIntervalMs) {
  const base = Math.max(1, Number(baseIntervalMs) || 400);
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  if (elapsed >= SUBMISSION_POLL_SPARSE_WINDOW_MS) {
    return Math.max(base, SUBMISSION_POLL_LATE_INTERVAL_MS);
  }
  if (elapsed >= SUBMISSION_POLL_DENSE_WINDOW_MS) {
    return Math.max(base, SUBMISSION_POLL_MID_INTERVAL_MS);
  }
  return base;
}

/**
 * 提交后轮询等待续期结果（替代固定 sleep(2000)）
 * 每 intervalMs 读取一次页面正文与 URL 并评估（间隔随 elapsed 自适应退避）：
 * - success / retry（服务端已响应的明确结果）立即返回，避免无谓空等
 * - pending（仍停留确认页无失败标识，服务端处理中）/ fail 持续轮询至 timeoutMs——
 *   实机提交后官方处理需 60-90s，页面停留 conf 期间不代表失败，过早判定并重试会
 *   中止在途 POST（ERR_ABORTED）导致本可成功的提交被误判（2026-08 两次手动运行日志对比）；
 *   fail 不提前终止同理：提交导航的中间态可能瞬时读到旧文档产生「状态不明确」
 * - 超时仍未响应时把 pending 归一化为 retry（页面未跳转），由调用方按重试处理
 * @param {import('puppeteer').Page} page
 * @param {{ timeoutMs?: number, intervalMs?: number, logger?: object }} [opts]
 * @returns {Promise<{ pageText: string, currentUrl: string, evaluation: object }>}
 */
export async function waitForSubmissionResult(
  page,
  { timeoutMs = 5000, intervalMs = 400, logger = NOOP_LOGGER } = {},
) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let pageText = '';
  let currentUrl = '';
  let evaluation = null;
  while (Date.now() < deadline) {
    pageText = await getBodyText(page);
    currentUrl = page.url();
    evaluation = evaluateSubmissionResult(pageText, currentUrl);
    // 提前返回仅限服务端已响应的明确结果：
    // - success 正常提速；retry（認証に失敗 等）为已响应的可重试失败，等下去不会改变
    // - pending / fail 继续轮询：提交导航的中间态可能瞬时读到旧文档（URL=/extend/do、
    //   正文为 conf 表单），此时 fail「状态不明确」不代表最终结果，提前终止会把
    //   本可成功的提交误判为不可重试失败
    if (evaluation.status === 'success' || evaluation.status === 'retry') break;
    await sleep(resolveSubmissionPollIntervalMs(Date.now() - startedAt, intervalMs));
  }

  // 超时仍停留在确认页（pending）：服务端未在窗口内响应，按可重试失败归一化
  if (evaluation?.status === 'pending') {
    evaluation = {
      status: 'retry',
      reason: '页面未跳转，可能验证码或 token 无效',
      matched: '/conf',
    };
  }

  if (evaluation?.status === 'success') {
    logger.debug(`续期结果轮询命中成功信号（${Date.now() - startedAt}ms 内）`);
  } else {
    // 未识别成功信号时输出页面诊断：官方常在提交成功后跳回 xvps/index 列表页，
    // 兜底 fail 分支只带 URL 不带正文，debug 记录正文便于确认「成功文案」特征
    const normalizedText = String(pageText || '').replace(/\s+/g, ' ').trim();
    logger.debug(
      `[提交结果诊断] 状态=${evaluation?.status || 'unknown'} | URL: ${currentUrl}`
      + ` | 正文片段: ${normalizedText.slice(0, 500)}`,
    );
  }
  return { pageText, currentUrl, evaluation };
}

/**
 * 同步续期确认页表单字段（auth_code 与 cf-turnstile-response）
 * 解决页面同时存在顶部隐藏域与可见输入框时的空值覆盖或多字段解析不一致问题
 *
 * @param {import('puppeteer').Page} page
 * @param {{ code?: string, token?: string }} [fields]
 * @param {object} [logger=NOOP_LOGGER]
 * @returns {Promise<{
 *   authCodeCount: number,
 *   authCodeUpdated: number,
 *   turnstileCount: number,
 *   turnstileUpdated: number,
 *   formFields: Array<{ name: string, type: string, valLen: number, preview: string }>
 * }>}
 */
export async function syncRenewalFormFields(page, { code = '', token = '' } = {}, logger = NOOP_LOGGER) {
  try {
    const result = await page.evaluate(
      ({ codeVal, tokenVal }) => {
        let authCodeCount = 0;
        let authCodeUpdated = 0;
        let turnstileCount = 0;
        let turnstileUpdated = 0;

        if (codeVal && typeof codeVal === 'string') {
          const authInputs = document.querySelectorAll('input[name="auth_code"]');
          authCodeCount = authInputs.length;
          authInputs.forEach((el) => {
            if (el.value !== codeVal) {
              el.value = codeVal;
              authCodeUpdated++;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });
        }

        if (tokenVal && typeof tokenVal === 'string') {
          const tsInputs = document.querySelectorAll(
            'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
          );
          turnstileCount = tsInputs.length;
          tsInputs.forEach((el) => {
            if (el.value !== tokenVal) {
              el.value = tokenVal;
              turnstileUpdated++;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });
        }

        const form = document.querySelector('form');
        const formFields = [];
        if (form && form.elements) {
          for (const el of form.elements) {
            if (!el || !el.name) continue;
            const val = el.value || '';
            const isSensitive = el.name.includes('turnstile') || el.name.includes('uniqid');
            formFields.push({
              name: el.name,
              type: el.type || (el.tagName ? el.tagName.toLowerCase() : 'unknown'),
              valLen: val.length,
              preview: isSensitive && val.length > 10 ? `${val.substring(0, 10)}...` : val,
            });
          }
        }

        return {
          authCodeCount,
          authCodeUpdated,
          turnstileCount,
          turnstileUpdated,
          formFields,
        };
      },
      { codeVal: code, tokenVal: token },
    );

    return result || {
      authCodeCount: 0,
      authCodeUpdated: 0,
      turnstileCount: 0,
      turnstileUpdated: 0,
      formFields: [],
    };
  } catch (error) {
    logger?.debug?.(`syncRenewalFormFields 执行异常（可能处于导航中间态）: ${error?.message || error}`);
    return {
      authCodeCount: 0,
      authCodeUpdated: 0,
      turnstileCount: 0,
      turnstileUpdated: 0,
      formFields: [],
    };
  }
}

/**
 * 验证码页面完整流程
 * @param {import('puppeteer').Page} page
 * @param {{ renewUrl?: string|null }} [options] - renewUrl 用于失败后回到 index?id_vps=
 * @param {{ config?: object, logger?: object }} [ctx]
 * @returns {Promise<{ turnstileProvider: string|null, turnstileAttempts: object[] }>}
 */
export async function handleCaptchaPage(page, options = {}, { config, logger = NOOP_LOGGER } = {}) {
  logger.info('正在处理验证码页面...');
  const renewUrl = typeof options?.renewUrl === 'string' ? options.renewUrl : null;

  // 确保页面上下文稳定就绪（防止在上一阶段导航或代理重定向的瞬间调用 DOM API 崩溃）
  await waitForPageReady(page, config?.NAVIGATION_TIMEOUT || 30_000, logger);

  // 最多重试 3 次（验证码识别错误时刷新重试）；下限 1 保证循环至少执行一次
  const maxRetries = Math.max(1, Number(config.CAPTCHA_MAX_RETRY) || 3);
  let lastError = null;
  /** @type {{ turnstileProvider: string|null, turnstileAttempts: object[] }} */
  let lastTurnstileMeta = { turnstileProvider: null, turnstileAttempts: [] };
  const rejectedProviders = new Set();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`验证码识别第 ${attempt} 次尝试...`);

      // 等待验证码图片元素（验证码图片是 Base64 内嵌在 src 属性中）
      await page.waitForSelector('img[src^="data:"]', { timeout: 10_000 });

      // 直接读取 img 元素的 src 属性（已经是 Base64 格式）
      const imgDataUri = await page.$eval('img[src^="data:"]', (el) => el.src);
      if (!imgDataUri) throw new Error('未找到验证码图片。');

      // 在验证码识别期间，并行检查 Turnstile 是否已提前通过
      // （复用 getTurnstileToken，避免重复实现「找有值 cf-turnstile-response」逻辑）
      const turnstileCheckPromise = getTurnstileToken(page, logger).then((tkn) => Boolean(tkn));
      let turnstileAlreadyPassed = false;

      // 识别验证码（并行进行 Turnstile 检查）
      const code = await recognizeCaptcha(imgDataUri, config.CAPTCHA_API, logger);

      // 检查 Turnstile 结果
      turnstileAlreadyPassed = await turnstileCheckPromise;
      if (turnstileAlreadyPassed) {
        logger.info('✅ Turnstile 在验证码识别期间已提前通过！');
      }

      // 填入验证码（模拟人类输入，先清空可能残留的旧值）
      const captchaInput = await page.$('[placeholder*="上の画像"], input[name="auth_code"]:not([type="hidden"])');
      if (!captchaInput) throw new Error('未找到验证码输入框。');
      await captchaInput.click({ clickCount: 3 });
      await captchaInput.evaluate((el) => {
        el.value = '';
      });
      await page.type('[placeholder*="上の画像"], input[name="auth_code"]:not([type="hidden"])', code, { delay: 80 });
      await captchaInput.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // 关键修复：同步表单中所有 auth_code 字段（消除顶部 hidden 字段与可见输入框的值不一致隐患）
      const authSync = await syncRenewalFormFields(page, { code }, logger);
      logger.info(`验证码已填入输入框，已同步 ${authSync.authCodeCount} 处 auth_code 字段。`);

      // 主动回收 Base64 图片与局部变量，降低内存压力
      if (typeof global.gc === 'function') { try { global.gc(); } catch { /* 忽略 */ } }

      // 等待 Turnstile（返回 { ok, providerName, attempts }）
      const turnstileResult = await waitForTurnstile(page, {
        config,
        logger,
        excludeProviders: Array.from(rejectedProviders),
      });
      lastTurnstileMeta = {
        turnstileProvider: turnstileResult?.providerName || (turnstileAlreadyPassed ? 'prefilled' : null),
        turnstileAttempts: Array.isArray(turnstileResult?.attempts) ? turnstileResult.attempts : [],
      };

      // 无有效 Turnstile 时禁止强制提交（否则必然 認証に失敗，且 /do 重试常无验证码图）
      if (!shouldSubmitAfterTurnstile(turnstileResult) && !turnstileAlreadyPassed) {
        throw new Error(turnstileResult?.reason || 'Turnstile 未通过，跳过提交以免认证失败');
      }

      // 提交表单
      logger.info('正在提交表单...');

      // 提交前现场快照与字段终态同步：
      // 1. 同步所有 cf-turnstile-response（覆盖天然验证通过时顶部 hidden 字段遗留的空值）
      // 2. 再次确保所有 auth_code 保持一致
      const currentToken = await getTurnstileToken(page, logger).catch(() => '');
      const finalSync = await syncRenewalFormFields(page, { code, token: currentToken }, logger);

      const formFieldsSummary = finalSync.formFields
        .map((f) => `${f.name}(${f.type},长${f.valLen},值=${f.preview})`)
        .join(', ');
      logger.info(
        `🔍 提交诊断 | 验证码: "${code}" (长 ${code.length}, 同步 ${finalSync.authCodeCount} 处) | `
        + `Turnstile: 来源=${lastTurnstileMeta.turnstileProvider || 'none'}, Token长=${currentToken ? currentToken.length : 0} (同步 ${finalSync.turnstileCount} 处) | `
        + `表单字段(${finalSync.formFields.length}): [${formFieldsSummary}] | `
        + `URL: ${page.url()}`,
      );

      const submitBtn = await page.$('input[type="submit"], button[type="submit"]');
      if (!submitBtn) throw new Error('未找到提交按钮。');

      await Promise.all([waitForNav(page, config.NAVIGATION_TIMEOUT, logger), submitBtn.click()]);

      // 提交后页面 URL 由轮询结果行（info）统一输出，此处降噪为 debug，避免相邻两条重复 URL 日志
      logger.debug(`提交完成，当前页面: ${page.url()}`);

      // 验证续期是否真正成功：长轮询等待服务端处理结果（官方处理需 60-90s，
      // 停留 conf 页期间持续等待而非判定失败；成功/明确失败信号提前返回）
      const { pageText, currentUrl, evaluation } = await waitForSubmissionResult(page, {
        timeoutMs: config.SUBMISSION_RESULT_TIMEOUT_MS,
        logger,
      });

      logger.info(`📄 续期提交后页面 URL: ${currentUrl}`);

      if (evaluation.status === 'success') {
        logger.info(`✅ 页面确认续期成功！检测到: "${evaluation.matched}"`);
        if (config?.SAVE_CAPTCHA_DATASET && imgDataUri) {
          const savedPath = saveCaptchaSample(imgDataUri, {
            type: 'verified',
            label: code,
            baseDir: config.CAPTCHA_DATASET_DIR,
            logger,
          });
          if (savedPath) {
            logger.info(`📦 真实正样本已沉淀至数据集: ${savedPath}`);
          }
        }
        return lastTurnstileMeta;
      }

      if (evaluation.status === 'retry') {
        const isAuthFailure = evaluation.reason.includes('認証に失敗') || evaluation.reason.includes('认证失败');
        if (isAuthFailure && lastTurnstileMeta.turnstileProvider && lastTurnstileMeta.turnstileProvider !== 'prefilled') {
          rejectedProviders.add(lastTurnstileMeta.turnstileProvider);
        }
        if (config?.SAVE_CAPTCHA_DATASET && imgDataUri && isAuthFailure) {
          const savedPath = saveCaptchaSample(imgDataUri, {
            type: 'unlabeled',
            label: `failed_${code}`,
            baseDir: config.CAPTCHA_DATASET_DIR,
            logger,
          });
          if (savedPath) {
            logger.info(`📦 识别错误样本已存入待打标集: ${savedPath}`);
          }
        }
        if (attempt < maxRetries) {
          logger.info(`❌ 第 ${attempt} 次尝试失败: ${evaluation.reason}`);
          if (evaluation.reason.includes('認証に失敗') || evaluation.reason.includes('认证失败')) {
            logger.warn(
              `⚠️ 认证失败诊断: 本次提交验证码="${code}"，Turnstile平台=[${lastTurnstileMeta.turnstileProvider || '未知'}]。`
              + (rejectedProviders.size > 0 ? ` 下一轮将优先切换其他打码平台。` : ''),
            );
          }
          logger.info(`⏭️ 刷新验证码，准备第 ${attempt + 1} 次尝试...`);
          await navigateForCaptchaRetry(page, currentUrl, renewUrl, { config, logger });
          continue;
        }
        throw new Error(`续期提交失败（${evaluation.reason}），已尝试 ${maxRetries} 次`);
      }

      // status === 'fail'：不可重试的业务/页面错误
      logger.info(`❌ ${evaluation.reason}`);
      throw new Error(
        evaluation.reason.startsWith('续期') || evaluation.reason.includes('URL:')
          ? evaluation.reason
          : `续期提交后${evaluation.reason}`,
      );

    } catch (error) {
      lastError = error;

      // Turnstile 多平台全挂：不可靠图形验证码重试挽回，立即上抛触发最高级告警
      if (isTurnstileOutageError(error)) {
        logger.info('❌ Turnstile 多平台均已熔断，跳过验证码重试，立即终止本轮');
        throw error;
      }

      if (attempt < maxRetries) {
        logger.info(`❌ 第 ${attempt} 次尝试失败: ${error.message}`);
        logger.info(`⏭️ 准备第 ${attempt + 1} 次尝试...`);

        try {
          let retryUrl = '';
          try {
            retryUrl = page.url();
          } catch {
            await waitForPageReady(page, 5000, logger);
            try { retryUrl = page.url(); } catch {}
          }
          await navigateForCaptchaRetry(page, retryUrl, renewUrl, { config, logger });
        } catch (reloadError) {
          logger.warn(`⚠️ 页面刷新失败: ${reloadError.message}`);
          // 官方窗口关闭等业务错误优先于「原验证码错误」
          if (String(reloadError?.message || '').includes('未进入官方')) {
            throw reloadError;
          }
          throw error; // 无法刷新，抛出原始错误
        }
      } else {
        // 最后一次重试仍失败：附带已尝试次数，供失败通知展示「重试上下文」
        // （Turnstile failover 的 attempts 是数组，不能混用，故用独立字段）
        if (error && typeof error === 'object') {
          error.captchaAttempts = attempt;
        }
        logger.info(`❌ 验证码识别/提交失败，已尝试 ${maxRetries} 次`);
        throw error;
      }
    }
  }

  // 循环各路径均显式 return/throw，正常不会到达此处；
  // 防御异常控制流（如未来改动），避免静默返回 undefined 被调用方当作成功元数据处理
  throw lastError || new Error('验证码流程异常结束（未产生明确结果）');
}
