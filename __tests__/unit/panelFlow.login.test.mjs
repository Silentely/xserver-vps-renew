import { describe, expect, it, vi } from 'vitest';
import { handleLogin, navigateToLoginPage } from '../../src/panel-flow.mjs';

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

describe('handleLogin', () => {
  it('提交后页面上下文未就绪时失败，不报告登录成功', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(null),
      url: vi.fn().mockReturnValue('https://secure.xserver.ne.jp/xapanel/login/xvps/'),
      type: vi.fn().mockResolvedValue(null),
      $: vi.fn().mockImplementation(async (selector) => {
        if (selector === 'input[name="action_user_login"]') {
          return { click: vi.fn().mockResolvedValue(null) };
        }
        return null;
      }),
      waitForNavigation: vi.fn().mockRejectedValue(new Error('Navigation timeout')),
      evaluate: vi.fn().mockRejectedValue(new Error('Protocol error (Runtime.evaluate): Target closed')),
    };

    await expect(handleLogin(page, {
      config: {
        BASE_URL: 'https://secure.xserver.ne.jp',
        LOGIN_PATH: '/xapanel/login/xvps/',
        MEMBER_ID: 'member',
        PASSWORD: 'password',
        NAVIGATION_TIMEOUT: 1000,
        LOGIN_NAVIGATION_RETRIES: 1,
      },
      logger: LOGGER,
    })).rejects.toThrow('页面上下文未就绪');

    expect(LOGGER.info).not.toHaveBeenCalledWith('登录成功！');
  });
});
