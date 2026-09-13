import { describe, it, expect, vi } from 'vitest';
import {
  waitForNav,
  getText,
  getBodyText,
  waitForSelectorSoft,
  safeClosePage,
  extractNewExpireDate,
  isFrameDetachError,
  waitForPageReady,
  safeEvaluate,
} from '../../src/page-utils.mjs';

describe('isFrameDetachError', () => {
  it('识别各类 frame 脱离和执行上下文销毁错误', () => {
    expect(isFrameDetachError(new Error("Attempted to use detached Frame '57A4FC5CF7AC46D1E98DE625C150AB55'"))).toBe(true);
    expect(isFrameDetachError(new Error('Navigating frame was detached'))).toBe(true);
    expect(isFrameDetachError(new Error('Execution context was destroyed, most likely because of a navigation.'))).toBe(true);
    expect(isFrameDetachError(new Error('Cannot find context with specified id'))).toBe(true);
    expect(isFrameDetachError(new Error('Navigation timeout of 30000 ms exceeded'))).toBe(false);
    expect(isFrameDetachError(null)).toBe(false);
  });
});

describe('waitForPageReady', () => {
  it('页面 evaluate 正常时立即返回 true', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue('complete') };
    const ok = await waitForPageReady(page, 2000);
    expect(ok).toBe(true);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('遭遇 detached Frame 并在重试后成功', async () => {
    const page = {
      evaluate: vi
        .fn()
        .mockRejectedValueOnce(new Error("Attempted to use detached Frame '123'"))
        .mockResolvedValueOnce('complete'),
    };
    const ok = await waitForPageReady(page, 2000);
    expect(ok).toBe(true);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  it('page 不含 evaluate 方法时防御性返回 true', async () => {
    expect(await waitForPageReady(null)).toBe(true);
    expect(await waitForPageReady({})).toBe(true);
  });
});

describe('safeEvaluate', () => {
  it('正常执行 evaluate 并返回值', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue({ webdriver: false }) };
    const res = await safeEvaluate(page, () => ({ webdriver: false }));
    expect(res).toEqual({ webdriver: false });
  });

  it('遭遇 Frame detach 时原地重试并成功', async () => {
    const page = {
      evaluate: vi
        .fn()
        .mockRejectedValueOnce(new Error('Navigating frame was detached'))
        .mockResolvedValueOnce({ ok: 1 }),
    };
    const res = await safeEvaluate(page, () => ({ ok: 1 }), null, 2, 10);
    expect(res).toEqual({ ok: 1 });
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  it('重试耗尽且提供了默认值时回退到默认值', async () => {
    const page = {
      evaluate: vi.fn().mockRejectedValue(new Error('detached Frame')),
    };
    const fallback = { webdriver: false };
    const res = await safeEvaluate(page, () => 1, fallback, 1, 10);
    expect(res).toEqual(fallback);
  });
});

describe('waitForNav', () => {
  it('导航成功返回 true', async () => {
    const page = {
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue('complete'),
    };
    const ok = await waitForNav(page, 30000);
    expect(ok).toBe(true);
    expect(page.waitForNavigation).toHaveBeenCalledWith({
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  });

  it('遇到 Navigating frame was detached 时调用 waitForPageReady 恢复并返回 true', async () => {
    const page = {
      waitForNavigation: vi.fn().mockRejectedValue(new Error('Navigating frame was detached')),
      evaluate: vi.fn().mockResolvedValue('complete'),
    };
    const logger = { warn: vi.fn(), info: vi.fn() };
    const ok = await waitForNav(page, 5000, logger);
    expect(ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('导航等待异常'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('检测到导航 Frame 脱离'));
  });

  it('普通超时返回 false 并记录 warn 日志', async () => {
    const page = {
      waitForNavigation: vi.fn().mockRejectedValue(new Error('Navigation timeout')),
    };
    const logger = { warn: vi.fn() };
    const ok = await waitForNav(page, 5000, logger);
    expect(ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('导航等待异常'));
  });

  it('无 logger 时不报错（默认 NOOP_LOGGER）', async () => {
    const page = {
      waitForNavigation: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    expect(() => waitForNav(page, 5000)).not.toThrow();
  });
});

describe('getText', () => {
  it('元素存在时返回去除空白后的文本', async () => {
    const el = { textContent: '   hello world  ' };
    const page = {
      $: vi.fn().mockResolvedValue(el),
      evaluate: vi.fn().mockImplementation((fn, e) => fn(e)),
    };
    expect(await getText(page, '.errorMessage')).toBe('hello world');
  });

  it('元素不存在时返回 null', async () => {
    const page = { $: vi.fn().mockResolvedValue(null) };
    expect(await getText(page, '.nope')).toBeNull();
  });
});

describe('getBodyText', () => {
  it('读取 document.body.innerText', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue('页面正文'),
    };
    expect(await getBodyText(page)).toBe('页面正文');
  });

  it('evaluate 异常时返回空串（统一容错）', async () => {
    const page = {
      evaluate: vi.fn().mockRejectedValue(new Error('Execution context destroyed')),
    };
    expect(await getBodyText(page)).toBe('');
  });
});

describe('waitForSelectorSoft', () => {
  it('元素在超时前出现时立即返回 true', async () => {
    const page = {
      waitForSelector: vi.fn().mockResolvedValue(true),
    };
    const logger = { debug: vi.fn() };
    expect(await waitForSelectorSoft(page, 'img[src^="data:"]', 2000, logger)).toBe(true);
    expect(page.waitForSelector).toHaveBeenCalledWith('img[src^="data:"]', { timeout: 2000 });
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('超时未出现时返回 false 并记 debug 日志（不抛错）', async () => {
    const page = {
      waitForSelector: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    const logger = { debug: vi.fn() };
    expect(await waitForSelectorSoft(page, '.nope', 3000, logger)).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('.nope'));
  });

  it('无 logger 时不报错（默认 NOOP_LOGGER）', async () => {
    const page = {
      waitForSelector: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    await expect(waitForSelectorSoft(page, '.nope', 1000)).resolves.toBe(false);
  });
});

describe('safeClosePage', () => {
  it('正常关闭页面', async () => {
    const page = { close: vi.fn().mockResolvedValue(undefined) };
    await expect(safeClosePage(page)).resolves.toBeUndefined();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('close 抛错时仅记 warn 不向上抛（防止 skip/success 误入失败路径）', async () => {
    const page = { close: vi.fn().mockRejectedValue(new Error('Target closed')) };
    const logger = { warn: vi.fn() };
    await expect(safeClosePage(page, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('页面关闭异常'));
  });

  it('空页面直接返回不报错', async () => {
    await expect(safeClosePage(null)).resolves.toBeUndefined();
    await expect(safeClosePage(undefined)).resolves.toBeUndefined();
  });

  it('无 logger 时 close 抛错也不抛（默认 NOOP_LOGGER）', async () => {
    const page = { close: vi.fn().mockRejectedValue(new Error('boom')) };
    await expect(safeClosePage(page)).resolves.toBeUndefined();
  });
});

describe('extractNewExpireDate', () => {
  it('优先取「更新後の利用期限」单元格值', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue('2026-08-09'),
    };
    await expect(extractNewExpireDate(page)).resolves.toBe('2026-08-09');
  });

  it('未命中单元格时回退正文文本解析（日本格式）', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue('更新が完了しました。2026年8月9日まで利用可能です。'),
    };
    await expect(extractNewExpireDate(page)).resolves.toBe('2026-08-09');
  });

  it('evaluate 异常时回退为空并返回 null（不抛错）', async () => {
    const page = {
      evaluate: vi.fn().mockRejectedValue(new Error('context destroyed')),
    };
    await expect(extractNewExpireDate(page)).resolves.toBeNull();
  });

  it('无法解析时返回 null', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue('まだ更新されていません'),
    };
    await expect(extractNewExpireDate(page)).resolves.toBeNull();
  });
});
