import { describe, it, expect, vi } from 'vitest';
import { checkRenewalNeeded } from '../../src/panel-flow.mjs';
import { NOOP_LOGGER } from '../../src/utils.mjs';

describe('checkRenewalNeeded', () => {
  const baseConfig = {
    BASE_URL: 'https://secure.xserver.ne.jp',
    NAVIGATION_TIMEOUT: 500,
  };

  it('成功找到今天到期的免费 VPS 时返回 needed: true', async () => {
    // 构造东京今天的日期
    const todayTokyo = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    const mockPage = {
      url: vi.fn().mockReturnValue('https://secure.xserver.ne.jp/xapanel/xvps/index'),
      goto: vi.fn().mockResolvedValue(null),
      waitForSelector: vi.fn().mockResolvedValue(null),
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('readyState')) return 'complete';
          if (fnStr.includes('freeServerIco')) {
            return {
              expireDate: todayTokyo,
              detailHref: 'https://secure.xserver.ne.jp/xapanel/xvps/server/detail?id=12345',
              cellTexts: ['vps-12345', '4GBメモリ', todayTokyo],
            };
          }
        }
        return 'complete';
      }),
    };

    const result = await checkRenewalNeeded(mockPage, { config: baseConfig, logger: NOOP_LOGGER });
    expect(result.needed).toBe(true);
    expect(result.vpsInfo.expireDate).toBe(todayTokyo);
    expect(result.renewUrl).toContain('id_vps=12345');
  });

  it('页面正常渲染但不存在免费 VPS 时返回 reasonCode: no_free_vps 且无需人工确认', async () => {
    const mockPage = {
      url: vi.fn().mockReturnValue('https://secure.xserver.ne.jp/xapanel/xvps/index'),
      goto: vi.fn().mockResolvedValue(null),
      waitForSelector: vi.fn().mockResolvedValue(null),
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('readyState')) return 'complete';
          if (fnStr.includes('freeServerIco')) return null;
        }
        return 'complete';
      }),
    };

    const result = await checkRenewalNeeded(mockPage, { config: baseConfig, logger: NOOP_LOGGER });
    expect(result.needed).toBe(false);
    expect(result.reasonCode).toBe('no_free_vps');
    expect(result.needsManualConfirmation).toBe(false);
  });

  it('页面停留在非 xvps 页面（疑似官方拦截页）时返回 needsManualConfirmation: true', async () => {
    const mockPage = {
      url: vi.fn().mockReturnValue('https://secure.xserver.ne.jp/xapanel/unknown/confirm'),
      goto: vi.fn().mockResolvedValue(null),
      waitForSelector: vi.fn().mockResolvedValue(null),
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('readyState')) return 'complete';
          if (fnStr.includes('freeServerIco')) return null;
        }
        return 'complete';
      }),
    };

    const result = await checkRenewalNeeded(mockPage, { config: baseConfig, logger: NOOP_LOGGER });
    expect(result.needed).toBe(false);
    expect(result.reasonCode).toBe('no_free_vps');
    expect(result.needsManualConfirmation).toBe(true);
  });

  it('safeEvaluate 发生 Frame 脱离且重试耗尽时抛出异常，绝不吞没为 no_free_vps', async () => {
    const mockPage = {
      url: vi.fn().mockReturnValue('https://secure.xserver.ne.jp/xapanel/xvps/index'),
      goto: vi.fn().mockResolvedValue(null),
      waitForSelector: vi.fn().mockResolvedValue(null),
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('readyState')) return 'complete';
          if (fnStr.includes('freeServerIco')) {
            throw new Error("Attempted to use detached Frame 'DEADBEEF'");
          }
        }
        return 'complete';
      }),
    };

    await expect(
      checkRenewalNeeded(mockPage, { config: baseConfig, logger: NOOP_LOGGER }),
    ).rejects.toThrow('detached Frame');
  });

  it('等待表格超时且诊断显示为空页面时，会触发重新加载 VPS 列表页', async () => {
    let reloadAttempted = false;
    const mockPage = {
      url: vi.fn().mockReturnValue('https://secure.xserver.ne.jp/xapanel/xvps/index'),
      goto: vi.fn().mockImplementation(async (url) => {
        if (url.includes('/xvps/index')) {
          reloadAttempted = true;
        }
        return null;
      }),
      waitForSelector: vi.fn().mockRejectedValue(new Error('timeout exceeded')),
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('readyState')) return 'complete';
          // 诊断评估返回 trCount: 0
          if (fnStr.includes('firstTable')) {
            return { trCount: 0, url: 'https://secure.xserver.ne.jp/xapanel/xvps/index' };
          }
          if (fnStr.includes('freeServerIco')) {
            return null;
          }
        }
        return 'complete';
      }),
    };

    const result = await checkRenewalNeeded(mockPage, { config: baseConfig, logger: NOOP_LOGGER });
    expect(reloadAttempted).toBe(true);
    expect(result.reasonCode).toBe('no_free_vps');
  });
});
