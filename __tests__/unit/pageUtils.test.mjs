import { describe, it, expect, vi } from 'vitest';
import { waitForNav, getText, getBodyText, waitForSelectorSoft, safeClosePage, extractNewExpireDate } from '../../src/page-utils.mjs';

describe('waitForNav', () => {
  it('导航成功返回 true', async () => {
    const page = {
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
    };
    const ok = await waitForNav(page, 30000);
    expect(ok).toBe(true);
    expect(page.waitForNavigation).toHaveBeenCalledWith({
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  });

  it('导航失败返回 false 并记录 warn 日志', async () => {
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
