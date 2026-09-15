import { describe, it, expect, vi } from 'vitest';
import { injectTurnstileToken } from '../../src/turnstile.mjs';

function makePage(evaluateImpl) {
  return {
    evaluate: vi.fn(evaluateImpl),
  };
}

describe('injectTurnstileToken', () => {
  it('空 token 跳过并返回 false', async () => {
    const page = makePage(async () => ({ injectedCount: 1, callbackCalled: true }));
    const logger = { info: vi.fn() };
    const ok = await injectTurnstileToken(page, '', logger);
    expect(ok).toBe(false);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('为空'));
  });

  it('注入成功返回 true', async () => {
    const page = makePage(async () => ({ injectedCount: 2, callbackCalled: true }));
    const logger = { info: vi.fn() };
    const ok = await injectTurnstileToken(page, 'token-abc', logger);
    expect(ok).toBe(true);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), 'token-abc');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('2 个元素'));
  });

  it('未找到元素返回 false', async () => {
    const page = makePage(async () => ({ injectedCount: 0, callbackCalled: false }));
    const ok = await injectTurnstileToken(page, 'token-abc', { info: vi.fn() });
    expect(ok).toBe(false);
  });

  it('returnDetails 为 true 时返回详细对象', async () => {
    const page = makePage(async () => ({ injectedCount: 2, callbackCalled: true }));
    const logger = { info: vi.fn() };
    const res = await injectTurnstileToken(page, 'token-abc', logger, { returnDetails: true });
    expect(res).toEqual({ ok: true, injectedCount: 2, callbackCalled: true });
  });

  it('空 token 且 returnDetails 为 true 时返回 ok: false 对象', async () => {
    const page = makePage(async () => ({ injectedCount: 1, callbackCalled: true }));
    const res = await injectTurnstileToken(page, '', { info: vi.fn() }, { returnDetails: true });
    expect(res).toEqual({ ok: false, injectedCount: 0, callbackCalled: false });
  });

  it('支持传入 explicit callbackName 并传递给 evaluate', async () => {
    const page = makePage(async () => ({ injectedCount: 2, callbackCalled: true }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const res = await injectTurnstileToken(page, 'token-abc', logger, {
      returnDetails: true,
      callbackName: 'callbackTurnstile',
    });
    expect(res).toEqual({ ok: true, injectedCount: 2, callbackCalled: true });
    expect(page.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      'token-abc',
      'callbackTurnstile',
    );
  });

  it('callback 执行抛错时记录 warning 并在 details 中返回 callbackError', async () => {
    const page = makePage(async () => ({
      injectedCount: 2,
      callbackCalled: false,
      callbackError: 'callbackTurnstile is not defined',
    }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const res = await injectTurnstileToken(page, 'token-abc', logger, {
      returnDetails: true,
      callbackName: 'callbackTurnstile',
    });
    expect(res).toEqual({
      ok: true,
      injectedCount: 2,
      callbackCalled: false,
      callbackError: 'callbackTurnstile is not defined',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('callbackTurnstile is not defined'),
    );
  });
  it('浏览器端 evaluateFn 安全解析 dotted-path 回调，并拒绝对恶意表达式执行 eval', async () => {
    let capturedFn = null;
    const page = {
      evaluate: vi.fn((fn, ...args) => {
        capturedFn = fn;
        return { injectedCount: 1, callbackCalled: true };
      }),
    };
    await injectTurnstileToken(page, 'token-123', { info: vi.fn() }, { callbackName: 'customCb' });
    expect(capturedFn).toBeTypeOf('function');

    const originalWindow = global.window;
    const originalDoc = global.document;
    const originalEvent = global.Event;

    try {
      global.Event = class { constructor(type) { this.type = type; } };
      const calls = [];
      global.window = {
        app: {
          turnstile: {
            receivedToken: null,
            onSuccess(token) {
              this.receivedToken = token;
              calls.push(token);
            },
          },
        },
      };
      global.document = {
        querySelectorAll: () => [],
        querySelector: () => null,
      };

      // 1. 安全 dotted-path 解析与执行
      const result1 = capturedFn('token-123', 'app.turnstile.onSuccess');
      expect(result1.callbackCalled).toBe(true);
      expect(calls).toEqual(['token-123']);
      expect(global.window.app.turnstile.receivedToken).toBe('token-123');

      // 2. 恶意表达式被拦截，不执行 eval
      const result2 = capturedFn('token-123', '(()=>{ window.hacked = true; })()');
      expect(result2.callbackCalled).toBe(false);
      expect(global.window.hacked).toBeUndefined();

      // 3. 候选列表回退：explicitCallback 不存在时，回退到 DOM 的 data-callback
      global.window.domCallback = (token) => calls.push('dom-' + token);
      global.document.querySelector = (sel) => {
        if (sel === '.cf-turnstile[data-callback]') {
          return { getAttribute: () => 'domCallback' };
        }
        return null;
      };
      const result3 = capturedFn('token-456', 'nonExistentCb');
      expect(result3.callbackCalled).toBe(true);
      expect(calls).toContain('dom-token-456');
    } finally {
      global.window = originalWindow;
      global.document = originalDoc;
      global.Event = originalEvent;
    }
  });
});
