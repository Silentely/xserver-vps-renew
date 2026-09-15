import { describe, it, expect, vi } from 'vitest';
import { injectTurnstileTokenWithRetry } from '../../src/turnstile-flow.mjs';

describe('injectTurnstileTokenWithRetry', () => {
  it('frame 脱离错误时原地重试，恢复后返回注入结果', async () => {
    const injectFn = vi.fn()
      .mockRejectedValueOnce(new Error("Attempted to use detached Frame '6E6E82FD89AC2AA0F0C8FFACD111B2C9'"))
      .mockResolvedValueOnce({ callbackCalled: true });
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const result = await injectTurnstileTokenWithRetry({}, 'tok', logger, {
      retryDelayMs: 0,
      injectFn,
    });
    expect(result).toEqual({ callbackCalled: true });
    expect(injectFn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('frame 脱离');
  });

  it('非 frame 脱离错误立即上抛，不重试', async () => {
    const injectFn = vi.fn().mockRejectedValue(new Error('timeout of 10000 ms exceeded'));
    const logger = { warn: vi.fn() };
    await expect(
      injectTurnstileTokenWithRetry({}, 'tok', logger, { retryDelayMs: 0, injectFn }),
    ).rejects.toThrow('timeout of 10000 ms exceeded');
    expect(injectFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('重试耗尽后抛出最后一次错误', async () => {
    const err = new Error('Attempted to use detached Frame');
    const injectFn = vi.fn().mockRejectedValue(err);
    await expect(
      injectTurnstileTokenWithRetry({}, 'tok', { warn: vi.fn() }, {
        maxRetries: 2,
        retryDelayMs: 0,
        injectFn,
      }),
    ).rejects.toBe(err);
    // 初始 1 次 + 2 次重试
    expect(injectFn).toHaveBeenCalledTimes(3);
  });

  it('首次即成功时只调用一次，无警告', async () => {
    const injectFn = vi.fn().mockResolvedValue({ callbackCalled: false });
    const logger = { warn: vi.fn() };
    const result = await injectTurnstileTokenWithRetry({}, 'tok', logger, {
      retryDelayMs: 0,
      injectFn,
    });
    expect(result).toEqual({ callbackCalled: false });
    expect(injectFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it('正确透传 callbackName 给底层 injectFn', async () => {
    const injectFn = vi.fn().mockResolvedValue({ ok: true, callbackCalled: true });
    const logger = { warn: vi.fn(), debug: vi.fn() };
    await injectTurnstileTokenWithRetry({}, 'tok-123', logger, {
      injectFn,
      callbackName: 'myTurnstileCb',
    });
    expect(injectFn).toHaveBeenCalledWith(
      {},
      'tok-123',
      logger,
      expect.objectContaining({
        returnDetails: true,
        callbackName: 'myTurnstileCb',
      }),
    );
  });
});
