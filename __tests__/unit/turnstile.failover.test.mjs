import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listTurnstileProviders,
  getTurnstileProvider,
  parseTurnstileProviderOrder,
  normalizeProviderName,
  solveTurnstileWithFailover,
  truncateErrorSummary,
  isTurnstileOutageError,
  DEFAULT_TURNSTILE_PROVIDER_ORDER,
  DEFAULT_TURNSTILE_PROVIDER_MAX_FAILURES,
  TURNSTILE_ALL_PROVIDERS_FAILED,
  TURNSTILE_ERROR_SUMMARY_MAX_LEN,
  ANTICAPTCHA_API_BASE,
} from '../../src/turnstile.mjs';

const makeConfig = (overrides = {}) => ({
  CAPSOLVER_API_KEY: '',
  ANTICAPTCHA_API_KEY: '',
  ANTICAPTCHA_SOFT_ID: '',
  YESCAPTCHA_API_KEY: '',
  YESCAPTCHA_API_BASE: '',
  YESCAPTCHA_TASK_TYPE: '',
  TWOCAPTCHA_API_KEY: '',
  TURNSTILE_PROVIDER_ORDER: '',
  PROXY_TYPE: '',
  PROXY_ADDRESS: '',
  PROXY_PORT: '',
  ...overrides,
});

describe('normalizeProviderName / parseTurnstileProviderOrder', () => {
  it('识别常见别名', () => {
    expect(normalizeProviderName('capsolver')).toBe('CapSolver');
    expect(normalizeProviderName('Anti-Captcha')).toBe('AntiCaptcha');
    expect(normalizeProviderName('anti_captcha')).toBe('AntiCaptcha');
    expect(normalizeProviderName('yescaptcha')).toBe('YesCaptcha');
    expect(normalizeProviderName('2captcha')).toBe('2Captcha');
    expect(normalizeProviderName('twocaptcha')).toBe('2Captcha');
    expect(normalizeProviderName('unknown')).toBeNull();
  });

  it('空配置返回默认顺序', () => {
    expect(parseTurnstileProviderOrder()).toEqual(DEFAULT_TURNSTILE_PROVIDER_ORDER);
    expect(parseTurnstileProviderOrder('')).toEqual(DEFAULT_TURNSTILE_PROVIDER_ORDER);
  });

  it('解析自定义顺序并去重', () => {
    expect(parseTurnstileProviderOrder('AntiCaptcha, CapSolver, CapSolver, 2Captcha')).toEqual([
      'AntiCaptcha',
      'CapSolver',
      '2Captcha',
    ]);
  });

  it('非法项忽略；全非法回退默认', () => {
    expect(parseTurnstileProviderOrder('foo, bar')).toEqual(DEFAULT_TURNSTILE_PROVIDER_ORDER);
    expect(parseTurnstileProviderOrder('CapSolver, foo, YesCaptcha')).toEqual([
      'CapSolver',
      'YesCaptcha',
    ]);
  });
});

describe('listTurnstileProviders', () => {
  it('无 key 返回空数组', () => {
    expect(listTurnstileProviders(makeConfig())).toEqual([]);
    expect(listTurnstileProviders(null)).toEqual([]);
  });

  it('仅 CapSolver', () => {
    const list = listTurnstileProviders(makeConfig({ CAPSOLVER_API_KEY: 'c' }));
    expect(list.map((p) => p.name)).toEqual(['CapSolver']);
  });

  it('多 key 按默认顺序：CapSolver → AntiCaptcha → YesCaptcha → 2Captcha', () => {
    const list = listTurnstileProviders(makeConfig({
      CAPSOLVER_API_KEY: 'c',
      ANTICAPTCHA_API_KEY: 'a',
      YESCAPTCHA_API_KEY: 'y',
      TWOCAPTCHA_API_KEY: 't',
    }));
    expect(list.map((p) => p.name)).toEqual([
      'CapSolver',
      'AntiCaptcha',
      'YesCaptcha',
      '2Captcha',
    ]);
  });

  it('自定义顺序生效', () => {
    const list = listTurnstileProviders(makeConfig({
      CAPSOLVER_API_KEY: 'c',
      ANTICAPTCHA_API_KEY: 'a',
      TWOCAPTCHA_API_KEY: 't',
      TURNSTILE_PROVIDER_ORDER: '2Captcha,AntiCaptcha,CapSolver',
    }));
    expect(list.map((p) => p.name)).toEqual(['2Captcha', 'AntiCaptcha', 'CapSolver']);
  });

  it('getTurnstileProvider 返回链上第一家', () => {
    const config = makeConfig({
      YESCAPTCHA_API_KEY: 'y',
      ANTICAPTCHA_API_KEY: 'a',
    });
    expect(getTurnstileProvider(config).name).toBe('AntiCaptcha');
  });

  it('AntiCaptcha 有代理时使用 TurnstileTask', () => {
    const list = listTurnstileProviders(makeConfig({
      ANTICAPTCHA_API_KEY: 'a',
      PROXY_TYPE: 'http',
      PROXY_ADDRESS: '1.2.3.4',
      PROXY_PORT: '8080',
    }));
    expect(list[0].name).toBe('AntiCaptcha');
    expect(list[0].apiBase).toBe(ANTICAPTCHA_API_BASE);
    expect(list[0].taskType).toBe('TurnstileTask');
    expect(list[0].supportsProxy).toBe(true);
  });

  it('AntiCaptcha 无代理时使用 TurnstileTaskProxyless', () => {
    const list = listTurnstileProviders(makeConfig({ ANTICAPTCHA_API_KEY: 'a' }));
    expect(list[0].taskType).toBe('TurnstileTaskProxyless');
    expect(list[0].supportsProxy).toBe(false);
  });

  it('AntiCaptcha softId 透传', () => {
    const list = listTurnstileProviders(makeConfig({
      ANTICAPTCHA_API_KEY: 'a',
      ANTICAPTCHA_SOFT_ID: '1187',
    }));
    expect(list[0].softId).toBe(1187);
  });

  it('AntiCaptcha softId 非法字符串时不设置 softId', () => {
    const list = listTurnstileProviders(makeConfig({
      ANTICAPTCHA_API_KEY: 'a',
      ANTICAPTCHA_SOFT_ID: 'not-a-number',
    }));
    expect(list[0].softId).toBeUndefined();
  });
});

describe('solveTurnstileWithFailover', () => {
  const logger = vi.fn();
  const params = { sitekey: '0x4AAAA' };

  beforeEach(() => {
    logger.mockReset();
  });

  it('无 key 抛错', async () => {
    await expect(
      solveTurnstileWithFailover('https://ex.com', params, makeConfig(), logger),
    ).rejects.toThrow('未配置 Turnstile 求解 API 密钥');
  });

  it('第一家成功即返回，不调用后续平台', async () => {
    const solveFn = vi.fn()
      .mockResolvedValueOnce({ token: 'tok-1', userAgent: 'UA-1' });

    const config = makeConfig({
      CAPSOLVER_API_KEY: 'c',
      ANTICAPTCHA_API_KEY: 'a',
    });

    const result = await solveTurnstileWithFailover(
      'https://ex.com', params, config, logger,
      { maxFailuresPerProvider: 3, solveFn },
    );

    expect(result.token).toBe('tok-1');
    expect(result.providerName).toBe('CapSolver');
    expect(result.userAgent).toBe('UA-1');
    expect(solveFn).toHaveBeenCalledTimes(1);
    expect(solveFn.mock.calls[0][5].name).toBe('CapSolver');
  });

  it('主平台连续失败达阈值后切换副平台并成功', async () => {
    const solveFn = vi.fn()
      .mockRejectedValueOnce(new Error('CapSolver down 1'))
      .mockRejectedValueOnce(new Error('CapSolver down 2'))
      .mockRejectedValueOnce(new Error('CapSolver down 3'))
      .mockResolvedValueOnce({ token: 'tok-anti', userAgent: null });

    const config = makeConfig({
      CAPSOLVER_API_KEY: 'c',
      ANTICAPTCHA_API_KEY: 'a',
    });

    const result = await solveTurnstileWithFailover(
      'https://ex.com', params, config, logger,
      { maxFailuresPerProvider: 3, solveFn },
    );

    expect(result.token).toBe('tok-anti');
    expect(result.providerName).toBe('AntiCaptcha');
    expect(solveFn).toHaveBeenCalledTimes(4);
    expect(result.attempts).toEqual([
      { provider: 'CapSolver', success: false, failures: 3, lastError: 'CapSolver down 3' },
      { provider: 'AntiCaptcha', success: true, failures: 0 },
    ]);
  });

  it('主平台第 2 次成功则不切换', async () => {
    const solveFn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ token: 'tok-ok', userAgent: null });

    const config = makeConfig({
      CAPSOLVER_API_KEY: 'c',
      ANTICAPTCHA_API_KEY: 'a',
    });

    const result = await solveTurnstileWithFailover(
      'https://ex.com', params, config, logger,
      { maxFailuresPerProvider: 3, solveFn },
    );

    expect(result.providerName).toBe('CapSolver');
    expect(solveFn).toHaveBeenCalledTimes(2);
  });

  it('全部平台熔断后抛出 TURNSTILE_ALL_PROVIDERS_FAILED', async () => {
    const solveFn = vi.fn().mockRejectedValue(new Error('all dead'));

    const config = makeConfig({
      CAPSOLVER_API_KEY: 'c',
      ANTICAPTCHA_API_KEY: 'a',
    });

    let caught;
    try {
      await solveTurnstileWithFailover(
        'https://ex.com', params, config, logger,
        { maxFailuresPerProvider: 2, solveFn },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught.code).toBe(TURNSTILE_ALL_PROVIDERS_FAILED);
    expect(caught.message).toContain('多平台均失败');
    expect(caught.providerNames).toEqual(['CapSolver', 'AntiCaptcha']);
    expect(solveFn).toHaveBeenCalledTimes(4); // 2 platforms × 2 failures
  });

  it('默认 maxFailures 为 3', () => {
    expect(DEFAULT_TURNSTILE_PROVIDER_MAX_FAILURES).toBe(3);
  });

  it('全挂错误 message 被截断且 attempts 含 lastError', async () => {
    const longMsg = 'x'.repeat(500);
    const solveFn = vi.fn().mockRejectedValue(new Error(longMsg));
    const config = makeConfig({ CAPSOLVER_API_KEY: 'c' });

    let caught;
    try {
      await solveTurnstileWithFailover(
        'https://ex.com', params, config, logger,
        { maxFailuresPerProvider: 2, solveFn },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught.code).toBe(TURNSTILE_ALL_PROVIDERS_FAILED);
    expect(caught.message.length).toBeLessThanOrEqual(TURNSTILE_ERROR_SUMMARY_MAX_LEN + 80);
    expect(caught.message).toContain('已截断');
    expect(caught.attempts[0].lastError.length).toBeLessThanOrEqual(200);
    expect(caught.attempts[0].lastError).toContain('已截断');
    expect(caught.errors.every((e) => e.error.length <= 200)).toBe(true);
    expect(caught.providerNames).toEqual(['CapSolver']);
  });
});

describe('truncateErrorSummary / isTurnstileOutageError', () => {
  it('短文本原样返回', () => {
    expect(truncateErrorSummary('ok')).toBe('ok');
  });

  it('超长文本截断', () => {
    const s = 'a'.repeat(1000);
    const out = truncateErrorSummary(s, 100);
    expect(out.length).toBeLessThan(130);
    expect(out).toContain('已截断');
  });

  it('识别 outage error 对象与文案', () => {
    const e = new Error('Turnstile 多平台均失败（链路: A）');
    e.code = TURNSTILE_ALL_PROVIDERS_FAILED;
    expect(isTurnstileOutageError(e)).toBe(true);
    expect(isTurnstileOutageError(new Error('timeout'))).toBe(false);
    expect(isTurnstileOutageError(null)).toBe(false);
  });
});
