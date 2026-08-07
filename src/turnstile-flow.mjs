/**
 * Turnstile 浏览器交互流程
 * 负责 widget 的自然通过降级（点击/轮询）与 API 求解成功后的注入、UA 对齐编排。
 *
 * 职责边界：
 * - src/turnstile.mjs：参数提取、单平台 API 求解、token 注入（页面无关的纯函数/单次操作）
 * - 本模块：以 page + config + logger 编排上述能力，供续期流程调用
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { NOOP_LOGGER } from './utils.mjs';
import { waitForSelectorSoft } from './page-utils.mjs';
import {
  listTurnstileProviders,
  extractTurnstileParams,
  solveTurnstileWithFailover,
  injectTurnstileToken,
  isTurnstileOutageError,
} from './turnstile.mjs';
import { needsUserAgentAlignment } from './renewal-logic.mjs';
import { resolveTurnstileProviderLabel } from './notify.mjs';

/**
 * 模拟人类鼠标移动轨迹（贝塞尔曲线 + 随机抖动）
 * Cloudflare Turnstile 会分析鼠标移动模式来判定是否为自动化
 * @param {import('puppeteer').Page} page
 */
export async function humanMouseMove(page, fromX, fromY, toX, toY) {
  const steps = 15 + Math.floor(Math.random() * 10); // 15-25 步
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // 简单的缓动函数（ease-in-out）
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const x = fromX + (toX - fromX) * ease + (Math.random() - 0.5) * 2;
    const y = fromY + (toY - fromY) * ease + (Math.random() - 0.5) * 2;
    await page.mouse.move(x, y);
    // 人类鼠标移动间隔不是完全均匀的
    await sleep(5 + Math.floor(Math.random() * 15));
  }
}

/**
 * 点击 Turnstile checkbox：模拟真实人类行为
 * 1. 找到 Turnstile iframe 的位置
 * 2. 模拟鼠标从随机起点移动到 checkbox 位置
 * 3. 短暂停留后点击
 * @param {import('puppeteer').Page} page
 * @param {object} [logger=NOOP_LOGGER] - 分级日志对象
 * @returns {Promise<boolean>}
 */
export async function clickTurnstileFallback(page, logger = NOOP_LOGGER) {
  try {
    logger.debug('尝试点击 Turnstile checkbox...');
    const frames = page.frames();
    const turnstileFrame = frames.find((f) =>
      f.url().includes('challenges.cloudflare.com'),
    );

    if (turnstileFrame) {
      const frameHandle = await turnstileFrame.frameElement();
      if (frameHandle) {
        const box = await frameHandle.boundingBox();
        if (box && box.width > 10 && box.height > 10) {
          // checkbox 在 iframe 内的偏移位置（左侧约 30px 处）
          const clickX = box.x + 28 + Math.random() * 6;
          const clickY = box.y + box.height / 2 + (Math.random() - 0.5) * 8;

          // 模拟人类行为：从页面随机位置移动到目标
          const startX = 200 + Math.random() * 400;
          const startY = 300 + Math.random() * 200;

          logger.debug(
            `Turnstile iframe: (${box.x.toFixed(0)},${box.y.toFixed(0)}) `
            + `${box.width.toFixed(0)}x${box.height.toFixed(0)}`,
          );
          logger.debug(
            `鼠标轨迹: (${startX.toFixed(0)},${startY.toFixed(0)})`
            + ` → (${clickX.toFixed(0)},${clickY.toFixed(0)})`,
          );

          await page.mouse.move(startX, startY);
          await sleep(200 + Math.random() * 300);
          await humanMouseMove(page, startX, startY, clickX, clickY);
          await sleep(50 + Math.random() * 150);
          await page.mouse.click(clickX, clickY);
          logger.debug('Turnstile checkbox 已点击');
          return true;
        }
      }
    }

    logger.debug('未找到 Turnstile iframe，点击失败');
    return false;
  } catch (e) {
    logger.warn(`Turnstile 点击异常: ${e.message}`);
    return false;
  }
}

/**
 * 获取页面中已有的 Turnstile token
 * @param {import('puppeteer').Page} page - Puppeteer Page 对象
 * @param {object} [logger=NOOP_LOGGER] - 分级日志对象
 * @returns {Promise<string>} - token 值，无 token 返回空字符串
 */
export async function getTurnstileToken(page, logger = NOOP_LOGGER) {
  try {
    return await page.evaluate(() => {
      const fields = document.querySelectorAll('[name="cf-turnstile-response"]');
      for (const field of fields) {
        if (field.value) return field.value;
      }
      return '';
    });
  } catch (error) {
    logger.error(`获取 Turnstile token 失败: ${error.message}`);
    return '';
  }
}

/**
 * 轮询等待 Turnstile token 生成（降级模式专用）
 * 用于点击方式后等待 Turnstile 自行生成 token
 * @param {import('puppeteer').Page} page
 * @param {{ timeoutMs?: number, logger?: object }} [opts]
 * @returns {Promise<boolean>}
 */
export async function waitForTurnstileToken(page, { timeoutMs, logger = NOOP_LOGGER } = {}) {
  const startTime = Date.now();
  let lastClickTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    // 读取所有 cf-turnstile-response 字段，返回第一个有值的
    const token = await getTurnstileToken(page, logger);

    if (token) {
      logger.info(`Turnstile 令牌已生成！（耗时 ${Date.now() - startTime}ms）`);
      return true;
    }

    // 每 10 秒重试点击一次
    const now = Date.now();
    if (now - lastClickTime >= 10000) {
      logger.info('令牌未生成，重试点击...');
      await clickTurnstileFallback(page, logger);
      lastClickTime = now;
    }

    await sleep(1000);
  }

  logger.error(`Turnstile 等待超时（${timeoutMs}ms），本轮将跳过提交以免认证失败。`);
  return false;
}

/**
 * 处理 Cloudflare Turnstile
 * @param {import('puppeteer').Page} page
 * @param {{ config?: object, logger?: object }} [opts] - config 为 CONFIG（含各超时与提供商配置）
 * @returns {Promise<{ ok: boolean, providerName?: string|null, attempts?: object[] }>}
 */
export async function waitForTurnstile(page, { config, logger = NOOP_LOGGER } = {}) {
  logger.info('正在处理 Cloudflare Turnstile...');

  const cfContainer = await page.$('.cf-turnstile');
  if (!cfContainer) {
    logger.info('页面无 Turnstile 组件，跳过。');
    return { ok: true, providerName: null, attempts: [] };
  }

  const turnstileConfig = await page.evaluate(() => {
    const div = document.querySelector('.cf-turnstile');
    if (!div) return null;
    return {
      sitekey: div.getAttribute('data-sitekey'),
      callback: div.getAttribute('data-callback'),
      theme: div.getAttribute('data-theme') || '(默认)',
      action: div.getAttribute('data-action') || '(无)',
    };
  }).catch(() => null);

  if (turnstileConfig) {
    logger.debug(
      `Turnstile 配置: sitekey=${turnstileConfig.sitekey}, callback=${turnstileConfig.callback}`,
    );
  } else {
    logger.warn('无法获取 Turnstile 配置（继续尝试提取参数）');
  }

  const existingToken = await getTurnstileToken(page, logger);
  if (existingToken) {
    logger.info('Turnstile 令牌已就绪。');
    return { ok: true, providerName: 'prefilled', attempts: [] };
  }

  const fieldCount = await page.evaluate(() => (
    document.querySelectorAll('[name="cf-turnstile-response"]').length
  )).catch(() => 0);
  logger.debug(`检测到 ${fieldCount} 个 cf-turnstile-response 字段`);

  logger.debug('等待 Turnstile 渲染...');
  // 软等待 iframe 出现替代固定 3s：渲染快时立即继续，慢时最坏仍等 3s（行为下限不变）
  await waitForSelectorSoft(
    page,
    'iframe[src*="challenges.cloudflare.com"], .cf-turnstile iframe',
    3000,
    logger,
  );

  try {
    await page.screenshot({ path: '/tmp/turnstile-before-solve.png', fullPage: false });
    logger.debug('已保存求解前截图: /tmp/turnstile-before-solve.png');
  } catch (e) {
    logger.debug(`截图失败: ${e.message}`);
  }

  // Docker 环境自然通过成功率极低；有 key 时直接走多平台 API failover
  const providers = listTurnstileProviders(config);

  if (providers.length > 0) {
    logger.info('Turnstile: 使用多平台 API failover 求解');
    logger.debug(`已配置平台: ${providers.map((p) => p.name).join(' → ')}`);

    const params = await extractTurnstileParams(page, logger);
    if (!params) {
      logger.error('无法提取 Turnstile 参数');
      return { ok: false };
    }

    try {
      const result = await solveTurnstileWithFailover(page.url(), params, config, logger, {
        timeout: config.TURNSTILE_API_TIMEOUT,
        maxFailuresPerProvider: config.TURNSTILE_PROVIDER_MAX_FAILURES,
      });
      const providerLabel = resolveTurnstileProviderLabel(result.providerName) || result.providerName;
      logger.info(`Turnstile 由 ${providerLabel} 求解成功`);

      // 注入 token（含回调触发）——单次调用即完成「写字段 + 触发 data-callback」，
      // 避免回调被重复触发（注入逻辑见 src/turnstile.mjs 的 injectTurnstileToken）
      const injected = await injectTurnstileToken(page, result.token, logger);
      if (injected.callbackCalled) {
        logger.debug('Turnstile token 已通过 callback 传递');
      } else {
        logger.debug('未找到 Turnstile callback，已注入 input 元素');
      }
      // 软等待 token 就绪（替代固定 2s）：注入后回调通常很快写入，成功时立即继续；
      // 未写入则轮询至 2s 上限后按原逻辑处理（callback 可能已消费 token）
      const tokenDeadline = Date.now() + 2000;
      let verifyToken = '';
      while (Date.now() < tokenDeadline) {
        verifyToken = await getTurnstileToken(page, logger);
        if (verifyToken) break;
        await sleep(400);
      }
      if (verifyToken) {
        logger.debug(`Turnstile token 已就绪，长度: ${verifyToken.length}`);
      } else {
        logger.debug('cf-turnstile-response 无值，callback 可能已处理 token');
      }

      // UA 对齐尽力而为：失败只记 warn，不回滚已注入 token、不判求解失败
      if (result.userAgent) {
        try {
          const currentUA = await page.evaluate(() => navigator.userAgent);
          if (needsUserAgentAlignment(currentUA, result.userAgent)) {
            logger.warn(
              `UA 不匹配，更新浏览器 UA 以匹配 API`
              + `（当前: ${currentUA.substring(0, 40)}… → API: ${result.userAgent.substring(0, 40)}…）`,
            );
            await page.setUserAgent(result.userAgent);
            logger.debug('浏览器 UA 已对齐到打码平台返回值');
          } else {
            logger.debug('浏览器 UA 与 API 返回值一致或无需对齐');
          }
        } catch (uaError) {
          logger.warn(
            `对齐 UA 失败（已保留已注入 token，继续提交）: ${uaError.message}`,
          );
        }
      }

      try {
        await page.screenshot({ path: '/tmp/turnstile-after-solve.png', fullPage: false });
        logger.debug('已保存求解后截图: /tmp/turnstile-after-solve.png');
      } catch (e) {
        logger.debug(`截图失败: ${e.message}`);
      }

      return {
        ok: true,
        providerName: result.providerName || null,
        attempts: Array.isArray(result.attempts) ? result.attempts : [],
      };
    } catch (e) {
      if (isTurnstileOutageError(e)) {
        logger.error(`Turnstile 多平台均失败，触发最高级告警: ${e.message}`);
        throw e;
      }
      logger.error(`API 求解失败: ${e.message}`);
      return { ok: false, attempts: Array.isArray(e?.attempts) ? e.attempts : [] };
    }
  }

  logger.warn('未配置 Turnstile API 密钥，继续等待自然通过（成功率极低）...');
  const naturalOk = await waitForTurnstileToken(page, {
    timeoutMs: config.TURNSTILE_TIMEOUT,
    logger,
  });
  return { ok: naturalOk, providerName: naturalOk ? 'natural' : null, attempts: [] };
}
