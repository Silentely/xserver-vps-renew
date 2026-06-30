import { describe, it, expect, vi } from 'vitest';

const {
  extractTurnstileParams,
} = await import('../../src/turnstile.mjs');

// 构造 mock page 对象
const createMockPage = (options = {}) => {
  const {
    hasTurnstileEl = true,
    sitekey = '0x4AAAAAAABTESTKEY',
    action = '',
    cData = '',
    chlPageData = '',
    callbackName = 'onTurnstileSuccess',
    htmlFallback = null,
  } = options;

  return {
    evaluate: vi.fn().mockImplementation((fn) => {
      const fnStr = fn.toString();
      // 第一个 evaluate 调用：尝试从 DOM 提取
      if (fnStr.includes('cf-turnstile[data-sitekey]')) {
        if (!hasTurnstileEl) return Promise.resolve(null);
        return Promise.resolve({ sitekey, action, cData, chlPageData, callbackName });
      }
      // 第二个 evaluate 调用：查找 Turnstile callback
      if (fnStr.includes('getElementById') || fnStr.includes('data-callback')) {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    }),
    content: vi.fn().mockImplementation(() => {
      if (htmlFallback) return Promise.resolve(htmlFallback);
      return Promise.resolve('<html><body>no turnstile</body></html>');
    }),
  };
};

describe('extractTurnstileParams', () => {
  it('从 data-* 属性成功提取参数', async () => {
    const page = createMockPage({ sitekey: '0x4AAA', action: 'login', cData: 'xyz' });

    const params = await extractTurnstileParams(page);

    expect(params).toEqual({
      sitekey: '0x4AAA',
      action: 'login',
      cData: 'xyz',
      chlPageData: '',
      callbackName: 'onTurnstileSuccess',
    });
  });

  it('无 Turnstile 元素时降级到正则匹配', async () => {
    const page = createMockPage({ hasTurnstileEl: false });
    page.content.mockReturnValue(
      Promise.resolve('<div data-sitekey="0x4FALLBACK"></div>'),
    );

    const params = await extractTurnstileParams(page);

    expect(params).toEqual({
      sitekey: '0x4FALLBACK',
      action: '',
      cData: '',
      chlPageData: '',
      callbackName: '',
    });
  });

  it('无 Turnstile 元素且无正则匹配时返回 null', async () => {
    const page = createMockPage({ hasTurnstileEl: false });
    page.content.mockReturnValue(Promise.resolve('<html><body>nothing</body></html>'));

    const params = await extractTurnstileParams(page);

    expect(params).toBeNull();
  });

  it('sitekey 为空时返回 null', async () => {
    const page = createMockPage({ sitekey: '' });

    const params = await extractTurnstileParams(page);

    expect(params).toBeNull();
  });

  it('提取成功时记录日志', async () => {
    const page = createMockPage({ sitekey: '0x4LOGTEST' });
    const logger = vi.fn();

    await extractTurnstileParams(page, logger);

    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('Turnstile 参数提取成功'),
    );
  });

  it('正则降级时记录日志', async () => {
    const page = createMockPage({ hasTurnstileEl: false });
    page.content.mockReturnValue(
      Promise.resolve('data-sitekey="0x4REGEX"'),
    );
    const logger = vi.fn();

    await extractTurnstileParams(page, logger);

    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('正则匹配'),
    );
  });

  it('无 logger 时不报错（默认空函数）', async () => {
    const page = createMockPage();

    expect(() => extractTurnstileParams(page)).not.toThrow();
  });
});
