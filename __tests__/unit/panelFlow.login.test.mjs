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

  it('登录页存在 Turnstile 且求解成功时，同步 token 并顺利提交登录', async () => {
    let turnstileQueried = false;
    let currentUrl = 'https://secure.xserver.ne.jp/xapanel/login/xvps/';
    const page = {
      goto: vi.fn().mockResolvedValue(null),
      url: vi.fn()
        .mockImplementation(() => currentUrl),
      type: vi.fn().mockResolvedValue(null),
      $: vi.fn().mockImplementation(async (selector) => {
        if (selector === '.cf-turnstile, [data-sitekey]') {
          turnstileQueried = true;
          return { id: 'turnstile-widget' };
        }
        if (selector === '.cf-turnstile') {
          return { id: 'cf-turnstile' };
        }
        if (selector === 'input[name="action_user_login"]') {
          return { click: vi.fn().mockResolvedValue(null) };
        }
        return null;
      }),
      evaluate: vi.fn().mockImplementation(async (fn, arg) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('cf-turnstile')) {
            return { sitekey: '0x4AAAAAABlb1fIlWBrSDU3B', callback: 'callbackSuccessTurnstile' };
          }
          if (fnStr.includes('tokenVal')) {
            return { turnstileUpdated: 1, formFields: [] };
          }
          if (fnStr.includes('document.readyState')) {
            return true;
          }
        }
        return null;
      }),
      $$eval: vi.fn().mockImplementation(async (selector) => {
        if (selector.includes('cf-turnstile-response')) {
          return ['mocked-login-token-123456'];
        }
        return [];
      }),
      waitForNavigation: vi.fn().mockImplementation(async () => { currentUrl = 'https://secure.xserver.ne.jp/xapanel/xvps/index'; }),
    };

    const result = await handleLogin(page, {
      config: {
        BASE_URL: 'https://secure.xserver.ne.jp',
        LOGIN_PATH: '/xapanel/login/xvps/',
        MEMBER_ID: 'member',
        PASSWORD: 'password',
        NAVIGATION_TIMEOUT: 1000,
        LOGIN_NAVIGATION_RETRIES: 1,
        TURNSTILE_RENDER_WAIT_MS: 10,
      },
      logger: LOGGER,
    });

    expect(turnstileQueried).toBe(true);
    expect(result).toEqual({ viaCookie: false });
    expect(LOGGER.info).toHaveBeenCalledWith(expect.stringContaining('检测到登录页包含 Cloudflare Turnstile 验证码'));
    expect(LOGGER.info).toHaveBeenCalledWith('登录成功！');
  });

  it('登录页 Turnstile 求解失败时跳过提交并抛出错误', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(null),
      url: vi.fn().mockReturnValue('https://secure.xserver.ne.jp/xapanel/login/xvps/'),
      type: vi.fn().mockResolvedValue(null),
      $: vi.fn().mockImplementation(async (selector) => {
        if (selector === '.cf-turnstile, [data-sitekey]') {
          return { id: 'turnstile-widget' };
        }
        if (selector === '.cf-turnstile') {
          return { id: 'cf-turnstile' };
        }
        return null;
      }),
      evaluate: vi.fn().mockImplementation(async (fn) => {
        const fnStr = fn?.toString?.() || '';
        if (fnStr.includes('cf-turnstile')) {
          return { sitekey: '0x4AAAAAABlb1fIlWBrSDU3B' };
        }
        return null;
      }),
      $$eval: vi.fn().mockResolvedValue([]),
    };

    await expect(handleLogin(page, {
      config: {
        BASE_URL: 'https://secure.xserver.ne.jp',
        LOGIN_PATH: '/xapanel/login/xvps/',
        MEMBER_ID: 'member',
        PASSWORD: 'password',
        NAVIGATION_TIMEOUT: 1000,
        LOGIN_NAVIGATION_RETRIES: 1,
        TURNSTILE_RENDER_WAIT_MS: 10,
        TURNSTILE_SOLVE_TIMEOUT_MS: 50,
      },
      logger: LOGGER,
    })).rejects.toThrow();
  });
});
