import { describe, it, expect, vi } from 'vitest';

const {
  extractTurnstileParams,
  readTurnstileWidgetParams,
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

  it('属性名清单以模块常量透传进 evaluate（单一来源）', async () => {
    const page = createMockPage({ sitekey: '0x4AAA' });

    await extractTurnstileParams(page);

    expect(page.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      [
        ['data-c-data', 'data-cdata'],
        ['data-chl-page-data', 'data-chlpagedata'],
      ],
    );
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
    const logger = { info: vi.fn(), debug: vi.fn() };

    await extractTurnstileParams(page, logger);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Turnstile 参数提取成功'),
    );
  });

  it('正则降级时记录日志', async () => {
    const page = createMockPage({ hasTurnstileEl: false });
    page.content.mockReturnValue(
      Promise.resolve('data-sitekey="0x4REGEX"'),
    );
    const logger = { info: vi.fn(), debug: vi.fn() };

    await extractTurnstileParams(page, logger);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('正则匹配'),
    );
  });

  it('无 logger 时不报错（默认空函数）', async () => {
    const page = createMockPage();

    expect(() => extractTurnstileParams(page)).not.toThrow();
  });

  describe('readTurnstileWidgetParams（纯函数，属性名双名兼容）', () => {
    const makeEl = (attrs) => ({
      getAttribute: (name) => (name in attrs ? attrs[name] : null),
    });

    it('读取官方写法 data-c-data / data-chl-page-data', () => {
      const el = makeEl({
        'data-sitekey': '0x4AAA',
        'data-action': 'login',
        'data-c-data': 'cdata-val',
        'data-chl-page-data': 'chl-val',
        'data-callback': 'onTurnstileSuccess',
      });
      expect(readTurnstileWidgetParams(el)).toEqual({
        sitekey: '0x4AAA',
        action: 'login',
        cData: 'cdata-val',
        chlPageData: 'chl-val',
        callbackName: 'onTurnstileSuccess',
      });
    });

    it('读取社区写法 data-cdata / data-chlpagedata', () => {
      const el = makeEl({
        'data-sitekey': '0x4BBB',
        'data-cdata': 'legacy-cd',
        'data-chlpagedata': 'legacy-chl',
      });
      expect(readTurnstileWidgetParams(el)).toEqual({
        sitekey: '0x4BBB',
        action: '',
        cData: 'legacy-cd',
        chlPageData: 'legacy-chl',
        callbackName: '',
      });
    });

    it('两种写法并存时官方写法优先', () => {
      const el = makeEl({
        'data-sitekey': '0x4CCC',
        'data-c-data': 'official',
        'data-cdata': 'legacy',
      });
      expect(readTurnstileWidgetParams(el).cData).toBe('official');
    });

    it('无属性或元素非法时返回空对象', () => {
      expect(readTurnstileWidgetParams(null)).toEqual({
        sitekey: '', action: '', cData: '', chlPageData: '', callbackName: '',
      });
      expect(readTurnstileWidgetParams({})).toEqual({
        sitekey: '', action: '', cData: '', chlPageData: '', callbackName: '',
      });
    });
  });
});
