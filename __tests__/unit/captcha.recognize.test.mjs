import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock 全局 fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

const {
  recognizeCaptcha,
  recognizeCaptchaWithKerasAPI,
  normalizeCaptchaCode,
} = await import('../../src/captcha.mjs');

describe('recognizeCaptchaWithKerasAPI', () => {
  const mockLogger = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    mockLogger.mockReset();
  });

  it('成功识别验证码', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('123456'),
    });

    const result = await recognizeCaptchaWithKerasAPI(
      'data:image/png;base64,abc',
      'https://api.example.com/captcha',
      mockLogger,
    );

    expect(result).toBe('123456');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/captcha',
      expect.objectContaining({
        method: 'POST',
        body: 'data:image/png;base64,abc',
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
  });

  it('API 返回平假名时自动转换', async () => {
    // いち=1, に=2, さん=3, よん=4, ご=5, ろく=6 → 123456
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('いちにさんよんごろく'),
    });

    const result = await recognizeCaptchaWithKerasAPI(
      'data:image/png;base64,abc',
      'https://api.example.com/captcha',
      mockLogger,
    );

    expect(result).toBe('123456');
  });

  it('API 未配置时抛出错误', async () => {
    await expect(
      recognizeCaptchaWithKerasAPI('data:image/png;base64,abc', '', mockLogger),
    ).rejects.toThrow('未配置 CAPTCHA_API');
  });

  it('API 返回非 ok 时抛出错误', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(
      recognizeCaptchaWithKerasAPI('data:image/png;base64,abc', 'https://api.example.com', mockLogger),
    ).rejects.toThrow('Keras 模型 API 响应 500');
  });

  it('API 返回无效结果（非 6 位数字）时抛出错误', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('abc'),
    });

    await expect(
      recognizeCaptchaWithKerasAPI('data:image/png;base64,abc', 'https://api.example.com', mockLogger),
    ).rejects.toThrow('返回无效结果');
  });

  it('API 超时时抛出可读超时错误', async () => {
    mockFetch.mockImplementationOnce(() => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });

    await expect(
      recognizeCaptchaWithKerasAPI('data:image/png;base64,abc', 'https://api.example.com', mockLogger),
    ).rejects.toThrow(/超时/);
  });

  it('图片数据为空时抛出错误', async () => {
    await expect(
      recognizeCaptchaWithKerasAPI('', 'https://api.example.com', mockLogger),
    ).rejects.toThrow('验证码图片数据为空');
  });

  it('记录日志：识别成功', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('123456'),
    });

    await recognizeCaptchaWithKerasAPI('data:image/png;base64,abc', 'https://api.example.com', mockLogger);

    expect(mockLogger).toHaveBeenCalledWith(expect.stringContaining('Keras 模型 API 识别成功'));
  });
});

describe('recognizeCaptcha', () => {
  const mockLogger = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    mockLogger.mockReset();
  });

  it('非 Base64 格式抛出错误', async () => {
    await expect(
      recognizeCaptcha('https://example.com/captcha.png', 'https://api.example.com', mockLogger),
    ).rejects.toThrow('必须是 Base64 格式');
  });

  it('未配置 API 抛出错误', async () => {
    await expect(
      recognizeCaptcha('data:image/png;base64,abc', '', mockLogger),
    ).rejects.toThrow('未配置 Keras 模型 API');
  });

  it('成功时返回验证码', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('654321'),
    });

    const result = await recognizeCaptcha('data:image/png;base64,abc', 'https://api.example.com', mockLogger);
    expect(result).toBe('654321');
  });

  it('底层失败时记录日志并重抛', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve('Service Unavailable'),
    });

    await expect(
      recognizeCaptcha('data:image/png;base64,abc', 'https://api.example.com', mockLogger),
    ).rejects.toThrow('503');

    expect(mockLogger).toHaveBeenCalledWith(expect.stringContaining('识别失败'));
  });
});
