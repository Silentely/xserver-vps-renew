/**
 * 页面通用工具
 * 浏览器交互共享原语：导航等待、元素文本、正文读取
 * （跨流程复用，避免在编排文件与各流程中重复实现）
 */

import { NOOP_LOGGER } from './utils.mjs';

/**
 * 等待导航完成，返回布尔值表示导航是否成功
 * @param {import('puppeteer').Page} page
 * @param {number} [timeout=30000] - 导航超时（毫秒）
 * @param {object} [logger=NOOP_LOGGER] - 分级日志对象（warn）
 * @returns {Promise<boolean>}
 */
export async function waitForNav(page, timeout = 30_000, logger = NOOP_LOGGER) {
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout });
    return true;
  } catch (e) {
    logger.warn(`⚠️ 导航等待异常（已忽略）: ${e.message}`);
    return false;
  }
}

/**
 * 获取元素文本
 * @param {import('puppeteer').Page} page
 * @param {string} selector
 * @returns {Promise<string|null>}
 */
export async function getText(page, selector) {
  const el = await page.$(selector);
  if (!el) return null;
  return page.evaluate((e) => e.textContent.trim(), el);
}

/**
 * 读取当前页面正文文本（统一容错：evaluate 异常时返回空串）
 * 多个流程（同意页校验/拦截检测/提交结果解析/页面诊断）共用
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string>}
 */
export async function getBodyText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

/**
 * 软等待元素出现：selector 在 timeout 内出现则立即返回，否则等到 timeout 后返回
 * 用于替代固定 sleep（如等 Turnstile 渲染 / 验证码图渲染）：
 * 正常路径渲染快时立即继续，慢时最坏情况与原固定等待一致
 * @param {import('puppeteer').Page} page
 * @param {string} selector - CSS 选择器
 * @param {number} [timeoutMs=3000] - 等待上限（毫秒）
 * @param {object} [logger=NOOP_LOGGER] - 分级日志对象（debug）
 * @returns {Promise<boolean>} 元素是否在超时前出现
 */
export async function waitForSelectorSoft(page, selector, timeoutMs = 3000, logger = NOOP_LOGGER) {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch {
    logger.debug(`等待 ${selector} 超时（${timeoutMs}ms），继续流程`);
    return false;
  }
}
