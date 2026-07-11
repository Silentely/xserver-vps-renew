import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  maskProxyAddress,
  getTokyoDateString,
  fetchWithTimeout,
  validateRequiredConfig,
  parsePositiveInt,
  TOKYO_OFFSET_MS,
} from '../../src/utils.mjs';

describe('maskProxyAddress', () => {
  it('脱敏长地址保留末尾 4 字符', () => {
    expect(maskProxyAddress('192.168.1.100')).toBe('*********.100');
  });

  it('短地址（≤4）原样返回', () => {
    expect(maskProxyAddress('abc')).toBe('abc');
    expect(maskProxyAddress('1.2')).toBe('1.2');
    expect(maskProxyAddress('abcd')).toBe('abcd');
  });

  it('空值返回空字符串', () => {
    expect(maskProxyAddress('')).toBe('');
    expect(maskProxyAddress(null)).toBe('');
    expect(maskProxyAddress(undefined)).toBe('');
  });
});

describe('getTokyoDateString', () => {
  it('按东京时区返回 YYYY-MM-DD', () => {
    // 2026-07-10 15:00:00 UTC = 2026-07-11 00:00:00 JST
    const utc = Date.UTC(2026, 6, 10, 15, 0, 0);
    expect(getTokyoDateString(utc)).toBe('2026-07-11');
  });

  it('支持 dayOffset 计算明天/昨天', () => {
    const utc = Date.UTC(2026, 6, 10, 15, 0, 0); // JST 2026-07-11
    expect(getTokyoDateString(utc, 1)).toBe('2026-07-12');
    expect(getTokyoDateString(utc, -1)).toBe('2026-07-10');
  });

  it('导出的偏移常量正确', () => {
    expect(TOKYO_OFFSET_MS).toBe(9 * 3600_000);
  });
});

describe('parsePositiveInt', () => {
  it('解析合法正整数', () => {
    expect(parsePositiveInt('42', 1)).toBe(42);
  });

  it('非法值回退默认', () => {
    expect(parsePositiveInt('abc', 7)).toBe(7);
    expect(parsePositiveInt('', 7)).toBe(7);
    expect(parsePositiveInt(undefined, 7)).toBe(7);
    expect(parsePositiveInt('-1', 7)).toBe(7);
  });

  it('尊重 min/max', () => {
    expect(parsePositiveInt('2', 10, { min: 5, max: 100 })).toBe(10);
    expect(parsePositiveInt('200', 10, { min: 5, max: 100 })).toBe(10);
    expect(parsePositiveInt('50', 10, { min: 5, max: 100 })).toBe(50);
  });
});

describe('validateRequiredConfig', () => {
  const base = {
    MEMBER_ID: 'user1',
    PASSWORD: 'pass1',
    CAPTCHA_API: 'https://api.example.com/captcha',
  };

  it('完整配置返回空数组', () => {
    expect(validateRequiredConfig(base)).toEqual([]);
  });

  it('配置对象无效时返回错误', () => {
    expect(validateRequiredConfig(null)).toContain('配置对象无效');
  });

  it('CAPTCHA_API 非法 URL 时报错', () => {
    const missing = validateRequiredConfig({ ...base, CAPTCHA_API: 'not-a-url' });
    expect(missing.some((m) => m.includes('CAPTCHA_API'))).toBe(true);
  });

  it('缺少必填项时列出缺失项', () => {
    const missing = validateRequiredConfig({});
    expect(missing).toContain('XSERVER_MEMBER_ID');
    expect(missing).toContain('XSERVER_PASSWORD');
    expect(missing).toContain('CAPTCHA_API');
  });

  it('PROXY_PORT 非数字时报错', () => {
    const missing = validateRequiredConfig({ ...base, PROXY_PORT: 'abc' });
    expect(missing.some((m) => m.includes('PROXY_PORT'))).toBe(true);
  });

  it('PROXY_TYPE 非法时报错', () => {
    const missing = validateRequiredConfig({
      ...base,
      PROXY_TYPE: 'ftp',
      PROXY_ADDRESS: '1.2.3.4',
      PROXY_PORT: '8080',
    });
    expect(missing.some((m) => m.includes('PROXY_TYPE'))).toBe(true);
  });

  it('代理配置不完整时报错', () => {
    const missing = validateRequiredConfig({
      ...base,
      PROXY_TYPE: 'http',
      // 缺少 ADDRESS / PORT
    });
    expect(missing.some((m) => m.includes('代理配置不完整'))).toBe(true);
  });

  it('完整代理配置通过', () => {
    expect(validateRequiredConfig({
      ...base,
      PROXY_TYPE: 'socks5',
      PROXY_ADDRESS: '1.2.3.4',
      PROXY_PORT: '1080',
    })).toEqual([]);
  });
});

describe('fetchWithTimeout', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('成功转发请求并返回响应', async () => {
    const fakeRes = { ok: true, status: 200 };
    mockFetch.mockResolvedValueOnce(fakeRes);

    const res = await fetchWithTimeout('https://example.com', { method: 'GET' }, 5000);
    expect(res).toBe(fakeRes);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        method: 'GET',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('超时后抛出 AbortError', async () => {
    mockFetch.mockImplementationOnce((_url, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    await expect(
      fetchWithTimeout('https://example.com', {}, 20),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
