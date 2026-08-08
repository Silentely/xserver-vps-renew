/**
 * 页面通用工具
 * 浏览器交互共享原语：导航等待、元素文本、正文读取
 * （跨流程复用，避免在编排文件与各流程中重复实现）
 */

import { NOOP_LOGGER } from './utils.mjs';
import { extractExpireDateFromText } from './renewal-logic.mjs';

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

/**
 * 从续期成功页面提取新到期日（页面读取 + 文本解析收敛，供主脚本复用）
 *
 * 页面内优先读「更新後の利用期限 / 更新后的利用期限」单元格的值；
 * 未命中或读取异常时回退整页正文文本，交由 extractExpireDateFromText 解析。
 * 主脚本原内联实现（TD 查找 + 回退）由此函数承接，便于单测与复用。
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string|null>} 新到期日（YYYY-MM-DD 或 null）
 */
export async function extractNewExpireDate(page) {
  const source = await page.evaluate(() => {
    const allTds = Array.from(document.querySelectorAll('td'));
    const expireTd = allTds.find((td) =>
      td.textContent.includes('更新後の利用期限') || td.textContent.includes('更新后的利用期限'),
    );
    if (expireTd && expireTd.nextElementSibling) {
      return expireTd.nextElementSibling.textContent.trim();
    }
    return document.body.textContent || '';
  }).catch(() => '');
  return extractExpireDateFromText(source);
}

/**
 * 安全关闭页面：close 失败仅记 warn，不中断流程
 *
 * 编排层（main）的 skip / success 路径若直接 await page.close()，一旦 close 抛错
 * （页面已提前关闭等罕见情况）会误入 catch，造成「已跳过/已成功 + 失败」双通知；
 * 页面资源由 finally 中的 browser.close() 兜底回收，此处失败不构成流程失败。
 * @param {import('puppeteer').Page|null|undefined} page
 * @param {object} [logger=NOOP_LOGGER] - 分级日志对象（warn）
 * @returns {Promise<void>}
 */
export async function safeClosePage(page, logger = NOOP_LOGGER) {
  if (!page) return;
  try {
    await page.close();
  } catch (e) {
    logger.warn(`页面关闭异常（已忽略，浏览器退出时兜底回收）: ${e?.message || e}`);
  }
}
