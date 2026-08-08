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
import { waitForNav, getText, getBodyText, waitForSelectorSoft } from './page-utils.mjs';
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
import { recognizeCaptcha } from './captcha.mjs';

/** 构造「需要人工确认」错误：自动同意处理无效，需用户登录手动确认后重跑容器 */
export function manualConfirmError(message) {
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
  await page.goto(`${config.BASE_URL}${config.LOGIN_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: config.NAVIGATION_TIMEOUT,
  });

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

  if (!page.url().includes('/xvps/index')) {
    await page.goto(`${config.BASE_URL}/xapanel/xvps/index`, {
      waitUntil: 'domcontentloaded',
      timeout: config.NAVIGATION_TIMEOUT,
    });
  }

  // 官方 xvps 列表表格为 JS 异步渲染，domcontentloaded 时行可能尚未插入 DOM；
  // 等待免费 VPS 行出现，避免在页面加载变慢时误判「未找到免费 VPS」。
  // 超时后先采集页面结构诊断（区分「官方改版」与「渲染时序」两类根因），再走原判定路径。
  try {
    await page.waitForSelector('tr:has(.freeServerIco)', { timeout: 10000 });
  } catch {
    logger.warn('等待免费 VPS 表格超时（10s），正在采集页面诊断信息...');
    const diag = await page.evaluate(() => {
      const firstTable = document.querySelector('table');
      return {
        url: location.href,
        freeIcoCount: document.querySelectorAll('.freeServerIco').length,
        trCount: document.querySelectorAll('tr').length,
        detailLinkCount: document.querySelectorAll('a[href*="/xvps/server/detail"]').length,
        tableHtml: firstTable ? firstTable.outerHTML.slice(0, 800) : null,
        bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
      };
    }).catch(() => null);
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
  }

  // 计算今天和明天的日期（东京时区，yyyy-mm-dd 格式）
  const today = getTokyoDateString();
  const tomorrow = getTokyoDateString(Date.now(), 1);
  logger.debug(`参考日期（东京）: 今天 ${today} / 明天 ${tomorrow}`);

  // 页面端仅提取原始文本（DOM 上下文不做业务判定），
  // 服务器名/规格解析收敛到纯函数 extractVpsInfoFromCellTexts（可单测）
  const result = await page.evaluate(() => {
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
  });

  if (!result) {
    // 未停留在 VPS 面板页（URL 不含 /xvps/）说明被官方新增/变更的确认页拦截，
    // 标记需人工确认，由 main() 发送提醒而不是当作普通「无免费 VPS」跳过
    const needsManualConfirmation = !page.url().includes('/xvps/');
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
      reasonDetail: '面板中未找到带免费标识的 VPS 条目',
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
export async function detectBlockedPage(page, logger = NOOP_LOGGER) {
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
  await Promise.all([waitForNav(page, config.NAVIGATION_TIMEOUT, logger), extendBtn.click()]);

  // conf 页：#5 用户反馈的拦截 URL；也可能是真正的验证码页
  const confBlocked = await detectBlockedPage(page, logger);
  if (confBlocked) return confBlocked;

  logger.info(`已进入验证码页面: ${page.url()}`);
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
export async function navigateForCaptchaRetry(page, currentUrl, renewUrl, { config, logger = NOOP_LOGGER } = {}) {
  const nav = resolveCaptchaRetryNavigation(currentUrl, { renewUrl });

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

/**
 * 提交后轮询等待续期结果（替代固定 sleep(2000)）
 * 每 intervalMs 读取一次页面正文与 URL 并评估：
 * - 出现明确「成功」信号立即返回（正常路径提速）
 * - 其余情况持续轮询至 timeoutMs（与原固定等待的行为下限一致），
 *   避免在成功页渲染完成前过早读到中间态而误判失败
 * @param {import('puppeteer').Page} page
 * @param {{ timeoutMs?: number, intervalMs?: number, logger?: object }} [opts]
 * @returns {Promise<{ pageText: string, currentUrl: string, evaluation: object }>}
 */
export async function waitForSubmissionResult(
  page,
  { timeoutMs = 2000, intervalMs = 400, logger = NOOP_LOGGER } = {},
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
    if (evaluation.status === 'success') break;
    await sleep(intervalMs);
  }
  if (evaluation?.status === 'success') {
    logger.debug(`续期结果轮询命中成功信号（${Date.now() - startedAt}ms 内）`);
  }
  return { pageText, currentUrl, evaluation };
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

  // 最多重试 3 次（验证码识别错误时刷新重试）
  const maxRetries = config.CAPTCHA_MAX_RETRY || 3;
  let lastError = null;
  /** @type {{ turnstileProvider: string|null, turnstileAttempts: object[] }} */
  let lastTurnstileMeta = { turnstileProvider: null, turnstileAttempts: [] };

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

      // 填入验证码（模拟人类输入）
      const captchaInput = await page.$('[placeholder*="上の画像"]');
      if (!captchaInput) throw new Error('未找到验证码输入框。');
      await captchaInput.click();
      await page.type('[placeholder*="上の画像"]', code, { delay: 80 });
      logger.info('验证码已填入输入框。');

      // 等待 Turnstile（返回 { ok, providerName, attempts }）
      const turnstileResult = await waitForTurnstile(page, { config, logger });
      lastTurnstileMeta = {
        turnstileProvider: turnstileResult?.providerName || (turnstileAlreadyPassed ? 'prefilled' : null),
        turnstileAttempts: Array.isArray(turnstileResult?.attempts) ? turnstileResult.attempts : [],
      };

      // 无有效 Turnstile 时禁止强制提交（否则必然 認証に失敗，且 /do 重试常无验证码图）
      if (!shouldSubmitAfterTurnstile(turnstileResult) && !turnstileAlreadyPassed) {
        throw new Error('Turnstile 未通过，跳过提交以免认证失败');
      }

      // 提交表单
      logger.info('正在提交表单...');

      const submitBtn = await page.$('input[type="submit"], button[type="submit"]');
      if (!submitBtn) throw new Error('未找到提交按钮。');

      await Promise.all([waitForNav(page, config.NAVIGATION_TIMEOUT, logger), submitBtn.click()]);

      // 提交后页面 URL 由轮询结果行（info）统一输出，此处降噪为 debug，避免相邻两条重复 URL 日志
      logger.debug(`提交完成，当前页面: ${page.url()}`);

      // 验证续期是否真正成功：轮询等待明确结果（成功信号提前返回，行为下限与原固定 2s 一致）
      const { pageText, currentUrl, evaluation } = await waitForSubmissionResult(page, { logger });

      logger.info(`📄 续期提交后页面 URL: ${currentUrl}`);

      if (evaluation.status === 'success') {
        logger.info(`✅ 页面确认续期成功！检测到: "${evaluation.matched}"`);
        return lastTurnstileMeta;
      }

      if (evaluation.status === 'retry') {
        if (attempt < maxRetries) {
          logger.info(`❌ 第 ${attempt} 次尝试失败: ${evaluation.reason}`);
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
          await navigateForCaptchaRetry(page, page.url(), renewUrl, { config, logger });
        } catch (reloadError) {
          logger.warn(`⚠️ 页面刷新失败: ${reloadError.message}`);
          // 官方窗口关闭等业务错误优先于「原验证码错误」
          if (String(reloadError?.message || '').includes('未进入官方')) {
            throw reloadError;
          }
          throw error; // 无法刷新，抛出原始错误
        }
      } else {
        // 最后一次重试仍失败
        logger.info(`❌ 验证码识别/提交失败，已尝试 ${maxRetries} 次`);
        throw error;
      }
    }
  }

  // 如果循环结束仍未成功（理论上不会走到这里）
  if (lastError) {
    throw lastError;
  }
}
