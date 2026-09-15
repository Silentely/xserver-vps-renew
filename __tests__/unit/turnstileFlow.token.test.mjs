import { describe, it, expect, vi } from 'vitest';
import { waitForTurnstileToken, getTurnstileToken, waitForTurnstile } from '../../src/turnstile-flow.mjs';
import { NOOP_LOGGER } from '../../src/utils.mjs';

describe('waitForTurnstileToken', () => {
  it('进入降级模式后立即尝试点击（不再前 10 秒空等）', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue('') };
    const clickFn = vi.fn().mockResolvedValue(false);
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ok = await waitForTurnstileToken(page, {
      timeoutMs: 1200,
      logger,
      clickFn,
    });
    expect(ok).toBe(false);
    // lastClickTime 从 0 起算，首个轮询周期即触发点击
    expect(clickFn).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('尝试点击'));
  });

  it('token 已存在时立即返回 true 且不点击', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue('tok-abc') };
    const clickFn = vi.fn();
    const ok = await waitForTurnstileToken(page, {
      timeoutMs: 2000,
      logger: NOOP_LOGGER,
      clickFn,
    });
    expect(ok).toBe(true);
    expect(clickFn).not.toHaveBeenCalled();
  });

  it('后续点击按 10 秒间隔重试（首次后不再频繁点击）', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue('') };
    const clickFn = vi.fn().mockResolvedValue(false);
    const ok = await waitForTurnstileToken(page, {
      timeoutMs: 2200,
      logger: NOOP_LOGGER,
      clickFn,
    });
    expect(ok).toBe(false);
    // 2.2s 窗口内：首次立即 + 10s 间隔未到 → 恰好 1 次
    expect(clickFn).toHaveBeenCalledTimes(1);
  });
});

describe('getTurnstileToken', () => {
  it('读取失败按无 token 返回空串，且仅记 debug（导航竞态非 error 级异常）', async () => {
    const page = { evaluate: vi.fn().mockRejectedValue(new Error('detached Frame')) };
    const logger = { debug: vi.fn(), error: vi.fn() };
    const token = await getTurnstileToken(page, logger);
    expect(token).toBe('');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('detached Frame'));
  });

  it('evaluate 异常时不向 NOOP_LOGGER 外抛错', async () => {
    const page = { evaluate: vi.fn().mockRejectedValue(new Error('x')) };
    await expect(getTurnstileToken(page, NOOP_LOGGER)).resolves.toBe('');
  });
});

describe('waitForTurnstile token gate', () => {
  it('注入后无 callback、ok=false 且无验证 token 时，判定为注入失败返回 ok: false', async () => {
    const mockPage = {
      evaluate: vi.fn().mockImplementation((fn) => {
        const fnStr = fn.toString();
        // injectTurnstileToken 内部 evaluate 返回 { ok: false, injectedCount: 0, callbackCalled: false }
        if (fnStr.includes('data-callback')) {
          return Promise.resolve({ ok: false, injectedCount: 0, callbackCalled: false });
        }
        // getTurnstileToken 返回空
        return Promise.resolve('');
      }),
      url: vi.fn().mockReturnValue("https://example.com"),
      content: vi.fn().mockResolvedValue('<div class="cf-turnstile" data-sitekey="0x4AAAAAA" data-callback="tsCallback"></div>'),
      setUserAgent: vi.fn().mockResolvedValue(),
      $$eval: vi.fn().mockResolvedValue([]),
      $: vi.fn().mockImplementation((sel) => {
        if (sel === ".cf-turnstile") return Promise.resolve({ asElement: () => ({}) });
        return Promise.resolve(null);
      }),
    };

    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await waitForTurnstile(mockPage, {
      config: {
        CAPSOLVER_API_KEY: 'mock-key',
        TURNSTILE_RENDER_WAIT_MS: 100,
      },
      logger: mockLogger,
      solveFn: vi.fn().mockResolvedValue({
        token: 'dummy-token',
        providerName: 'CapSolver',
        attempts: [],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Turnstile token 注入失败');
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('未找到输入元素'));
  });

  it('waitForTurnstile 求解成功后将页面上提取的 callbackName 透传给注入流程', async () => {
    let capturedCallbackName = null;
    const mockPage = {
      url: vi.fn().mockReturnValue('https://example.com'),
      evaluate: vi.fn().mockImplementation(async (fn, ...args) => {
        if (Array.isArray(args[0])) {
          return {
            sitekey: '0x4AAAAAA',
            action: '',
            cData: '',
            chlPageData: '',
            callbackName: 'pageTurnstileCb',
          };
        }
        if (args[1] === 'pageTurnstileCb') {
          capturedCallbackName = args[1];
          return { injectedCount: 1, callbackCalled: true };
        }
        return '';
      }),
      $: vi.fn().mockResolvedValue({ asElement: () => ({}) }),
      $$: vi.fn().mockResolvedValue([]),
    };

    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await waitForTurnstile(mockPage, {
      config: { CAPSOLVER_API_KEY: 'mock-key', TURNSTILE_RENDER_WAIT_MS: 50 },
      logger: mockLogger,
      solveFn: vi.fn().mockResolvedValue({
        token: 'tok-123',
        providerName: 'CapSolver',
        attempts: [],
      }),
    });

    expect(result.ok).toBe(true);
    expect(capturedCallbackName).toBe('pageTurnstileCb');
  });

  it('waitForTurnstile 当 API UA 不匹配且 UA 对齐失败时，返回 ok: false 阻断提交', async () => {
    const mockPage = {
      url: vi.fn().mockReturnValue('https://example.com'),
      evaluate: vi.fn().mockImplementation(async (fn, ...args) => {
        if (Array.isArray(args[0])) {
          return { sitekey: '0x4AAAAAA', callbackName: '' };
        }
        if (fn.toString().includes('navigator.userAgent')) {
          return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
        }
        if (typeof args[0] === 'string' && args[0].startsWith('tok-')) {
          return { injectedCount: 1, callbackCalled: true };
        }
        return '';
      }),
      $: vi.fn().mockResolvedValue({ asElement: () => ({}) }),
      $$: vi.fn().mockResolvedValue([]),
      setUserAgent: vi.fn().mockRejectedValue(new Error('CDP protocol timeout')),
    };

    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await waitForTurnstile(mockPage, {
      config: { CAPSOLVER_API_KEY: 'mock-key', TURNSTILE_RENDER_WAIT_MS: 50 },
      logger: mockLogger,
      solveFn: vi.fn().mockResolvedValue({
        token: 'tok-mismatched',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        providerName: 'CapSolver',
        attempts: [],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('UA 对齐失败');
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('对齐 UA 失败'));
  });
});
