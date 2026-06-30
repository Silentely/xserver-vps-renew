import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:timers/promises 的 sleep
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const {
  solveTurnstileViaAPI,
  injectTurnstileToken,
} = await import('../../src/turnstile.mjs');

const makeConfig = (overrides = {}) => ({
  CAPSOLVER_API_KEY: '',
  TWOCAPTCHA_API_KEY: '',
  PROXY_TYPE: '',
  PROXY_ADDRESS: '',
  PROXY_PORT: '',
  PROXY_LOGIN: '',
  PROXY_PASSWORD: '',
  DEFAULT_UA: 'Mozilla/5.0 Test-UA',
  ...overrides,
});

describe('solveTurnstileViaAPI', () => {
  const mockLogger = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    mockLogger.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('无 API 密钥时抛出错误', async () => {
    const config = makeConfig();
    await expect(
      solveTurnstileViaAPI('https://example.com', { sitekey: '0x4' }, config, mockLogger),
    ).rejects.toThrow('未配置 Turnstile 求解 API 密钥');
  });

  it('CapSolver 成功求解', async () => {
    // createTask 响应
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errorId: 0, taskId: 'task-123' }),
    });
    // getTaskResult 响应
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        errorId: 0,
        status: 'ready',
        solution: { token: 'token-abc-xyz', userAgent: 'Mozilla/5.0 API-UA' },
      }),
    });

    const config = makeConfig({ CAPSOLVER_API_KEY: 'cap-key' });
    const result = await solveTurnstileViaAPI(
      'https://example.com/page',
      { sitekey: '0x4AAAA', action: 'login' },
      config,
      mockLogger,
    );

    expect(result.token).toBe('token-abc-xyz');
    expect(result.userAgent).toBe('Mozilla/5.0 API-UA');
  });

  it('2Captcha 成功求解', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errorId: 0, taskId: 'task-456' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        errorId: 0,
        status: 'ready',
        solution: { token: 'token-2cap-789' },
      }),
    });

    const config = makeConfig({ TWOCAPTCHA_API_KEY: '2cap-key' });
    const result = await solveTurnstileViaAPI(
      'https://example.com/page',
      { sitekey: '0x4BBBB' },
      config,
      mockLogger,
    );

    expect(result.token).toBe('token-2cap-789');
    expect(result.userAgent).toBeNull();
  });

  it('createTask HTTP 错误时抛出异常', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
    });

    const config = makeConfig({ CAPSOLVER_API_KEY: 'bad-key' });
    await expect(
      solveTurnstileViaAPI('https://example.com', { sitekey: '0x4' }, config, mockLogger),
    ).rejects.toThrow('createTask HTTP 错误: 403');
  });

  it('createTask 返回业务错误时抛出异常', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errorId: 1, errorDescription: 'Invalid key' }),
    });

    const config = makeConfig({ CAPSOLVER_API_KEY: 'invalid' });
    await expect(
      solveTurnstileViaAPI('https://example.com', { sitekey: '0x4' }, config, mockLogger),
    ).rejects.toThrow('Invalid key');
  });

  it('createTask 未返回 taskId 时抛出异常', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errorId: 0 }),
    });

    const config = makeConfig({ CAPSOLVER_API_KEY: 'cap-key' });
    await expect(
      solveTurnstileViaAPI('https://example.com', { sitekey: '0x4' }, config, mockLogger),
    ).rejects.toThrow('未返回 taskId');
  });

  it('轮询次数耗尽后抛出异常', async () => {
    // createTask 成功
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errorId: 0, taskId: 'task-slow' }),
    });
    // getTaskResult 始终返回 processing（模拟 API 一直不返回结果）
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errorId: 0, status: 'processing' }),
    });

    const config = makeConfig({ CAPSOLVER_API_KEY: 'cap-key' });

    // 使用极短超时（1ms），使 maxPolls=1，一轮即退出循环
    await expect(
      solveTurnstileViaAPI('https://example.com', { sitekey: '0x4' }, config, mockLogger, 1),
    ).rejects.toThrow('轮询次数耗尽');
  });

  it('getTaskResult HTTP 错误时继续轮询', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errorId: 0, taskId: 'task-retry' }),
    });
    // 第一次轮询 HTTP 错误
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
    });
    // 第二次轮询成功
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        errorId: 0,
        status: 'ready',
        solution: { token: 'token-after-retry' },
      }),
    });

    const config = makeConfig({ CAPSOLVER_API_KEY: 'cap-key' });
    const result = await solveTurnstileViaAPI(
      'https://example.com', { sitekey: '0x4' }, config, mockLogger, 5000,
    );

    expect(result.token).toBe('token-after-retry');
  });

  it('2Captcha 带代理时传递代理参数', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errorId: 0, taskId: 'task-proxy' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        errorId: 0,
        status: 'ready',
        solution: { token: 'token-proxy' },
      }),
    });

    const config = makeConfig({
      TWOCAPTCHA_API_KEY: '2cap-key',
      PROXY_TYPE: 'socks5',
      PROXY_ADDRESS: '1.2.3.4',
      PROXY_PORT: '1080',
      proxyLogin: 'user',
      proxyPassword: 'pass',
    });

    await solveTurnstileViaAPI('https://example.com', { sitekey: '0x4' }, config, mockLogger, 5000);

    // 验证 createTask 调用包含代理参数
    const createCall = mockFetch.mock.calls[0];
    const body = JSON.parse(createCall[1].body);
    expect(body.task.proxyType).toBe('socks5');
    expect(body.task.proxyAddress).toBe('1.2.3.4');
    expect(body.task.proxyPort).toBe(1080);
  });
});

describe('injectTurnstileToken', () => {
  it('成功注入 token 到 input 元素', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(true),
    };

    const result = await injectTurnstileToken(mockPage, 'test-token-123');

    expect(result).toBe(true);
    expect(mockPage.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      'test-token-123',
    );
  });

  it('注入失败时记录警告日志', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(false),
    };
    const logger = vi.fn();

    const result = await injectTurnstileToken(mockPage, 'test-token', logger);

    expect(result).toBe(false);
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('未找到 cf-turnstile-response'),
    );
  });

  it('注入成功时记录成功日志', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(true),
    };
    const logger = vi.fn();

    await injectTurnstileToken(mockPage, 'test-token', logger);

    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('已注入页面'),
    );
  });

  it('无 logger 时不报错', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(true),
    };

    expect(() => injectTurnstileToken(mockPage, 'token')).not.toThrow();
  });
});
