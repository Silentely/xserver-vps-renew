import { describe, expect, it, vi } from 'vitest';
import { navigateToLoginPage } from '../../src/panel-flow.mjs';

const LOGGER = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

describe('navigateToLoginPage', () => {
  it('网络超时后有限重试并最终成功', async () => {
    const page = {
      goto: vi.fn()
        .mockRejectedValueOnce(new Error('net::ERR_TIMED_OUT'))
        .mockResolvedValueOnce(null),
    };

    await navigateToLoginPage(page, {
      BASE_URL: 'https://secure.xserver.ne.jp',
      LOGIN_PATH: '/xapanel/login/xvps/',
      NAVIGATION_TIMEOUT: 1000,
      LOGIN_NAVIGATION_RETRIES: 2,
      LOGIN_NAVIGATION_RETRY_DELAY_MS: 0,
    }, LOGGER);

    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.goto).toHaveBeenLastCalledWith(
      'https://secure.xserver.ne.jp/xapanel/login/xvps/',
      { waitUntil: 'domcontentloaded', timeout: 1000 },
    );
  });

  it('非网络错误不重试并原样抛出', async () => {
    const error = new Error('Invalid URL');
    const page = { goto: vi.fn().mockRejectedValue(error) };

    await expect(navigateToLoginPage(page, {
      BASE_URL: 'https://secure.xserver.ne.jp',
      LOGIN_PATH: '/xapanel/login/xvps/',
      NAVIGATION_TIMEOUT: 1000,
      LOGIN_NAVIGATION_RETRIES: 2,
      LOGIN_NAVIGATION_RETRY_DELAY_MS: 0,
    }, LOGGER)).rejects.toBe(error);

    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('达到重试上限后抛出最后一次网络错误', async () => {
    const error = new Error('Navigation timeout of 1000 ms exceeded');
    const page = { goto: vi.fn().mockRejectedValue(error) };

    await expect(navigateToLoginPage(page, {
      BASE_URL: 'https://secure.xserver.ne.jp',
      LOGIN_PATH: '/xapanel/login/xvps/',
      NAVIGATION_TIMEOUT: 1000,
      LOGIN_NAVIGATION_RETRIES: 2,
      LOGIN_NAVIGATION_RETRY_DELAY_MS: 0,
    }, LOGGER)).rejects.toBe(error);

    expect(page.goto).toHaveBeenCalledTimes(2);
  });
});
