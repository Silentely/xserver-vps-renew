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
    const logger = vi.fn();
    const ok = await injectTurnstileToken(page, '', logger);
    expect(ok).toBe(false);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('为空'));
  });

  it('注入成功返回 true', async () => {
    const page = makePage(async () => ({ injectedCount: 2, callbackCalled: true }));
    const logger = vi.fn();
    const ok = await injectTurnstileToken(page, 'token-abc', logger);
    expect(ok).toBe(true);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), 'token-abc');
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('2 个元素'));
  });

  it('未找到元素返回 false', async () => {
    const page = makePage(async () => ({ injectedCount: 0, callbackCalled: false }));
    const ok = await injectTurnstileToken(page, 'token-abc', () => {});
    expect(ok).toBe(false);
  });
});
