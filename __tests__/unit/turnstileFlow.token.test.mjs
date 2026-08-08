import { describe, it, expect, vi } from 'vitest';
import { waitForTurnstileToken } from '../../src/turnstile-flow.mjs';
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
