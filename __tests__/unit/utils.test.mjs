import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  maskProxyAddress,
  getTokyoDateString,
  fetchWithTimeout,
  validateRequiredConfig,
  parsePositiveInt,
  parseLogLevel,
  parseEnvBool,
  shouldLog,
  formatLogLine,
  NOOP_LOGGER,
  escapeHtml,
  formatTokyoDateTime,
  formatLogTimestamp,
  analyzeFingerprintHealth,
  TOKYO_OFFSET_MS,
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_DEBUG,
  LOG_LEVEL_INFO,
  LOG_LEVEL_WARN,
  LOG_LEVEL_ERROR,
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

  it('严格拒绝非纯数字（含数字前缀的拼接值）', () => {
    expect(parsePositiveInt('12abc', 7)).toBe(7);
    expect(parsePositiveInt('30000ms', 7)).toBe(7);
    expect(parsePositiveInt('1e3', 7)).toBe(7);
    expect(parsePositiveInt(' 42 ', 7)).toBe(42);
    expect(parsePositiveInt('0x10', 7)).toBe(7);
  });
});

describe('parseEnvBool', () => {
  it('解析常见真/假与回退', () => {
    expect(parseEnvBool('true', false)).toBe(true);
    expect(parseEnvBool('1', false)).toBe(true);
    expect(parseEnvBool('yes', false)).toBe(true);
    expect(parseEnvBool('false', true)).toBe(false);
    expect(parseEnvBool('0', true)).toBe(false);
    expect(parseEnvBool('', true)).toBe(true);
    expect(parseEnvBool(undefined, false)).toBe(false);
    expect(parseEnvBool('maybe', true)).toBe(true);
  });
});

describe('parseLogLevel / shouldLog / NOOP_LOGGER', () => {
  it('解析级别与别名', () => {
    expect(parseLogLevel('debug')).toBe(LOG_LEVEL_DEBUG);
    expect(parseLogLevel('VERBOSE')).toBe(LOG_LEVEL_DEBUG);
    expect(parseLogLevel('info')).toBe(LOG_LEVEL_INFO);
    expect(parseLogLevel('warn')).toBe(LOG_LEVEL_WARN);
    expect(parseLogLevel('quiet')).toBe(LOG_LEVEL_ERROR);
    expect(parseLogLevel('nope')).toBe(DEFAULT_LOG_LEVEL);
  });

  it('shouldLog 按级别过滤', () => {
    expect(shouldLog('info', 'debug')).toBe(false);
    expect(shouldLog('info', 'info')).toBe(true);
    expect(shouldLog('info', 'warn')).toBe(true);
    expect(shouldLog('error', 'warn')).toBe(false);
    expect(shouldLog('error', 'error')).toBe(true);
    expect(shouldLog('debug', 'debug')).toBe(true);
  });

  it('NOOP_LOGGER 各级别为空操作（默认 logger）', () => {
    expect(() => {
      NOOP_LOGGER.info('x');
      NOOP_LOGGER.debug('x');
      NOOP_LOGGER.warn('x');
      NOOP_LOGGER.error('x');
    }).not.toThrow();
  });
});

describe('formatLogLine', () => {
  it('输出 时间戳 + [级别] + 消息', () => {
    expect(formatLogLine('2026-08-07 12:00:00', 'info', '正在检查续期状态'))
      .toBe('2026-08-07 12:00:00 [INFO] 正在检查续期状态');
    expect(formatLogLine('2026-08-07 12:00:00', 'warn', '警告'))
      .toBe('2026-08-07 12:00:00 [WARN] 警告');
    expect(formatLogLine('2026-08-07 12:00:00', 'debug', '细节'))
      .toBe('2026-08-07 12:00:00 [DEBUG] 细节');
  });

  it('error 消息未带 ❌ 时自动补充', () => {
    expect(formatLogLine('t', 'error', '流程失败'))
      .toBe('t [ERROR] ❌ 流程失败');
  });

  it('error 消息已带 ❌ 时不重复', () => {
    expect(formatLogLine('t', 'error', '❌ 流程失败'))
      .toBe('t [ERROR] ❌ 流程失败');
  });

  it('未知级别回退 [INFO]，空消息输出空内容', () => {
    expect(formatLogLine('t', 'nope', 'x')).toBe('t [INFO] x');
    expect(formatLogLine('t', 'info', null)).toBe('t [INFO] ');
  });
});

describe('formatLogTimestamp', () => {
  it('输出固定宽度 YYYY-MM-DD HH:mm:ss', () => {
    const out = formatLogTimestamp();
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('按东京时区转换（UTC 15:00 → JST 次日 00:00）', () => {
    const utc = Date.UTC(2026, 6, 10, 15, 0, 0);
    expect(formatLogTimestamp(utc, 'Asia/Tokyo')).toBe('2026-07-11 00:00:00');
  });

  it('午夜不出现 24 点制（h23）', () => {
    const utc = Date.UTC(2026, 6, 10, 15, 30, 5);
    expect(formatLogTimestamp(utc, 'Asia/Tokyo')).toBe('2026-07-11 00:30:05');
  });

  it('支持自定义时区', () => {
    const utc = Date.UTC(2026, 6, 10, 15, 0, 0);
    expect(formatLogTimestamp(utc, 'UTC')).toBe('2026-07-10 15:00:00');
  });
});

describe('analyzeFingerprintHealth', () => {
  it('webdriver=true 提示 stealth 失效风险', () => {
    const risks = analyzeFingerprintHealth({ webdriver: true });
    expect(risks.length).toBe(1);
    expect(risks[0]).toContain('webdriver=true');
  });

  it('设备内存/核心数异常时提示', () => {
    expect(analyzeFingerprintHealth({ deviceMemory: 0 }).length).toBe(1);
    expect(analyzeFingerprintHealth({ hardwareConcurrency: 0 }).length).toBe(1);
  });

  it('健康指纹返回空数组', () => {
    expect(analyzeFingerprintHealth({
      webdriver: false,
      deviceMemory: 8,
      hardwareConcurrency: 8,
    })).toEqual([]);
  });

  it('空值/缺省不误报', () => {
    expect(analyzeFingerprintHealth({})).toEqual([]);
    expect(analyzeFingerprintHealth()).toEqual([]);
    expect(analyzeFingerprintHealth({
      webdriver: false,
      deviceMemory: 'N/A',
      hardwareConcurrency: 'N/A',
    })).toEqual([]);
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
describe('escapeHtml', () => {
  it('转义混合内容（原 renewalLogic 用例）', () => {
    expect(escapeHtml('<a>&"\'')).toBe('&lt;a&gt;&amp;&quot;&#39;');
  });

  it('转义 & 符号', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('转义尖括号', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('空字符串原样返回', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('转义混合特殊字符', () => {
    expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });

  it('安全字符串不被修改', () => {
    expect(escapeHtml('host123')).toBe('host123');
  });

  it('转义双引号', () => {
    expect(escapeHtml('a"b')).toBe('a&quot;b');
  });

  it('转义单引号', () => {
    expect(escapeHtml("a'b")).toBe('a&#39;b');
  });

  it('转义全部 HTML 特殊字符', () => {
    expect(escapeHtml('<a href="x">\'y\'</a>'))
      .toBe('&lt;a href=&quot;x&quot;&gt;&#39;y&#39;&lt;/a&gt;');
  });
});

describe('formatTokyoDateTime', () => {
  it('返回非空字符串', () => {
    expect(formatTokyoDateTime(Date.UTC(2026, 6, 11, 0, 0, 0))).toBeTruthy();
  });
});
