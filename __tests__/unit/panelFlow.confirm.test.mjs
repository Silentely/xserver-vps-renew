import { describe, it, expect, vi } from 'vitest';
import { handleRenewalConfirm } from '../../src/panel-flow.mjs';
import { NOOP_LOGGER } from '../../src/utils.mjs';

describe('handleRenewalConfirm', () => {
  it('当点击续期确认后仍停留在 index 页面且无验证码特征时，抛出明确异常而不是返回 ready', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue(null),
      $: vi.fn().mockResolvedValue({ click: vi.fn().mockResolvedValue(null) }),
      $$: vi.fn().mockResolvedValue([]),
      waitForNavigation: vi.fn().mockResolvedValue(null),
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          try {
            return fn();
          } catch {
            return false;
          }
        }
        return 'complete';
      }),
      url: vi.fn().mockReturnValue('https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/index?id_vps=123'),
    };

    const config = { NAVIGATION_TIMEOUT: 5000 };

    await expect(
      handleRenewalConfirm(mockPage, 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/index?id_vps=123', {
        config,
        logger: NOOP_LOGGER,
      }),
    ).rejects.toThrow('仍停留在申请首页');
  });

  it('成功进入 /extend/conf 时返回 status: ready', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue(null),
      $: vi.fn().mockResolvedValue({ click: vi.fn().mockResolvedValue(null) }),
      $$: vi.fn().mockResolvedValue([]),
      waitForNavigation: vi.fn().mockResolvedValue(null),
      evaluate: vi.fn().mockResolvedValue('complete'),
      url: vi.fn().mockReturnValue('https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/conf'),
    };

    const config = { NAVIGATION_TIMEOUT: 5000 };

    const result = await handleRenewalConfirm(mockPage, 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/index?id_vps=123', {
      config,
      logger: NOOP_LOGGER,
    });

    expect(result).toEqual({ status: 'ready' });
  });

  it('遇到官方未开窗拦截时返回 window_blocked 状态', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue(null),
      $: vi.fn().mockResolvedValue(null),
      $$: vi.fn().mockResolvedValue([]),
      waitForNavigation: vi.fn().mockResolvedValue(null),
      evaluate: vi.fn().mockResolvedValue('ご利用期限の12時間前以降にお試しください。'),
      url: vi.fn().mockReturnValue('https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/index?id_vps=123'),
    };

    const config = { NAVIGATION_TIMEOUT: 5000 };

    const result = await handleRenewalConfirm(mockPage, 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/index?id_vps=123', {
      config,
      logger: NOOP_LOGGER,
    });

    expect(result?.status).toBe('window_blocked');
    expect(result?.reason).toContain('12h');
  });
});
