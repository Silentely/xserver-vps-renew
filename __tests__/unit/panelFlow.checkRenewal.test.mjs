import { describe, it, expect, vi } from 'vitest';
import { checkRenewalNeeded } from '../../src/panel-flow.mjs';
import { getTokyoDateString, NOOP_LOGGER } from '../../src/utils.mjs';

describe('checkRenewalNeeded', () => {
  const baseConfig = {
    BASE_URL: 'https://secure.xserver.ne.jp',
    NAVIGATION_TIMEOUT: 500,
  };

  // 构造「今天到期」的免费 VPS 模拟页：expireDate 为纯日期，源内按东京日末估算剩余时间，
  // 因此是否落在 12h 续期窗口内取决于被钉住的时钟，调用方必须显式固定时间基准。
  function buildExpiringTodayPage(todayTokyo) {
    return {
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
  }

  it('成功找到今天到期的免费 VPS 时返回 needed: true', async () => {
    // 固定时钟为东京 20:00（UTC 11:00），处于到期日 12h 续期窗口内（东京 12:00 之后）
    const fixedMs = Date.parse('2026-10-11T11:00:00Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedMs);
    try {
      const todayTokyo = getTokyoDateString(fixedMs);
      const mockPage = buildExpiringTodayPage(todayTokyo);

      const result = await checkRenewalNeeded(mockPage, { config: baseConfig, logger: NOOP_LOGGER });
      expect(result.needed).toBe(true);
      expect(result.vpsInfo.expireDate).toBe(todayTokyo);
      expect(result.renewUrl).toContain('id_vps=12345');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('东京上午（12:00 前）到期日为今天时按日末估算剩余时间返回 not_due', async () => {
    // 固定时钟为东京 09:00（UTC 00:00），距东京日末约 15h，尚未进入 12h 续期窗口
    const fixedMs = Date.parse('2026-10-11T00:00:00Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedMs);
    try {
      const todayTokyo = getTokyoDateString(fixedMs);
      const mockPage = buildExpiringTodayPage(todayTokyo);

      const result = await checkRenewalNeeded(mockPage, { config: baseConfig, logger: NOOP_LOGGER });
      expect(result.needed).toBe(false);
      expect(result.reasonCode).toBe('not_due');
      expect(result.vpsInfo.expireDate).toBe(todayTokyo);
    } finally {
      nowSpy.mockRestore();
    }
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

  it('重载后页面上下文仍未就绪时抛出明确网络错误，不再继续使用失效 Frame', async () => {
    const mockPage = {
      url: vi.fn().mockReturnValue('https://secure.xserver.ne.jp/xapanel/xvps/index'),
      goto: vi.fn().mockImplementation(async (url) => {
        if (url.includes('/xvps/index')) {
          throw new Error("Attempted to use detached Frame 'RELOAD_FRAME'");
        }
        return null;
      }),
      waitForSelector: vi.fn().mockRejectedValue(new Error('timeout exceeded')),
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('readyState')) return 'complete';
          if (fnStr.includes('firstTable')) return { trCount: 0 };
          if (fnStr.includes('freeServerIco')) {
            throw new Error("Attempted to use detached Frame 'RELOAD_FRAME'");
          }
        }
        return null;
      }),
    };

    await expect(
      checkRenewalNeeded(mockPage, { config: baseConfig, logger: NOOP_LOGGER }),
    ).rejects.toThrow('页面上下文未就绪');
  });
});
