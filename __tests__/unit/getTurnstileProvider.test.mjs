import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getTurnstileProvider,
  resolveYesCaptchaApiBase,
  resolveYesCaptchaTaskType,
  YESCAPTCHA_DEFAULT_API_BASE,
  YESCAPTCHA_DEFAULT_TASK_TYPE,
  YESCAPTCHA_SOFT_ID,
} from '../../src/turnstile.mjs';

// 构造一个可变 CONFIG 对象供测试修改
const CONFIG = {
  CAPSOLVER_API_KEY: '',
  YESCAPTCHA_API_KEY: '',
  YESCAPTCHA_API_BASE: '',
  YESCAPTCHA_TASK_TYPE: '',
  TWOCAPTCHA_API_KEY: '',
  PROXY_TYPE: '',
  PROXY_ADDRESS: '',
  PROXY_PORT: '',
};

describe('getTurnstileProvider', () => {
  const saved = {};

  beforeEach(() => {
    // 备份并清空 CONFIG 中与 Turnstile 相关的字段
    saved.CAPSOLVER_API_KEY = CONFIG.CAPSOLVER_API_KEY;
    saved.YESCAPTCHA_API_KEY = CONFIG.YESCAPTCHA_API_KEY;
    saved.YESCAPTCHA_API_BASE = CONFIG.YESCAPTCHA_API_BASE;
    saved.YESCAPTCHA_TASK_TYPE = CONFIG.YESCAPTCHA_TASK_TYPE;
    saved.TWOCAPTCHA_API_KEY = CONFIG.TWOCAPTCHA_API_KEY;
    saved.PROXY_TYPE = CONFIG.PROXY_TYPE;
    saved.PROXY_ADDRESS = CONFIG.PROXY_ADDRESS;
    saved.PROXY_PORT = CONFIG.PROXY_PORT;

    CONFIG.CAPSOLVER_API_KEY = '';
    CONFIG.YESCAPTCHA_API_KEY = '';
    CONFIG.YESCAPTCHA_API_BASE = '';
    CONFIG.YESCAPTCHA_TASK_TYPE = '';
    CONFIG.TWOCAPTCHA_API_KEY = '';
    CONFIG.PROXY_TYPE = '';
    CONFIG.PROXY_ADDRESS = '';
    CONFIG.PROXY_PORT = '';
  });

  afterEach(() => {
    // 恢复原始值
    CONFIG.CAPSOLVER_API_KEY = saved.CAPSOLVER_API_KEY;
    CONFIG.YESCAPTCHA_API_KEY = saved.YESCAPTCHA_API_KEY;
    CONFIG.YESCAPTCHA_API_BASE = saved.YESCAPTCHA_API_BASE;
    CONFIG.YESCAPTCHA_TASK_TYPE = saved.YESCAPTCHA_TASK_TYPE;
    CONFIG.TWOCAPTCHA_API_KEY = saved.TWOCAPTCHA_API_KEY;
    CONFIG.PROXY_TYPE = saved.PROXY_TYPE;
    CONFIG.PROXY_ADDRESS = saved.PROXY_ADDRESS;
    CONFIG.PROXY_PORT = saved.PROXY_PORT;
  });

  it('returns null when no API keys configured', () => {
    expect(getTurnstileProvider(CONFIG)).toBeNull();
  });

  it('returns null for null/undefined config', () => {
    expect(getTurnstileProvider(null)).toBeNull();
    expect(getTurnstileProvider(undefined)).toBeNull();
  });

  it('returns CapSolver when CAPSOLVER_API_KEY is set', () => {
    CONFIG.CAPSOLVER_API_KEY = 'test-key';
    const provider = getTurnstileProvider(CONFIG);
    expect(provider.name).toBe('CapSolver');
    expect(provider.taskType).toBe('AntiTurnstileTaskProxyLess');
    expect(provider.supportsProxy).toBe(false);
  });

  it('returns YesCaptcha when only YESCAPTCHA_API_KEY is set', () => {
    CONFIG.YESCAPTCHA_API_KEY = 'yes-key';
    const provider = getTurnstileProvider(CONFIG);
    expect(provider.name).toBe('YesCaptcha');
    expect(provider.apiBase).toBe(YESCAPTCHA_DEFAULT_API_BASE);
    expect(provider.clientKey).toBe('yes-key');
    expect(provider.taskType).toBe(YESCAPTCHA_DEFAULT_TASK_TYPE);
    expect(provider.supportsProxy).toBe(false);
    expect(provider.softID).toBe(YESCAPTCHA_SOFT_ID);
    expect(provider.softID).toBe(97020);
  });

  it('YesCaptcha 支持国内节点与 M1 任务类型', () => {
    CONFIG.YESCAPTCHA_API_KEY = 'yes-key';
    CONFIG.YESCAPTCHA_API_BASE = 'https://cn.yescaptcha.com/';
    CONFIG.YESCAPTCHA_TASK_TYPE = 'TurnstileTaskProxylessM1';
    const provider = getTurnstileProvider(CONFIG);
    expect(provider.apiBase).toBe('https://cn.yescaptcha.com');
    expect(provider.taskType).toBe('TurnstileTaskProxylessM1');
  });

  it('returns 2Captcha when only TWOCAPTCHA_API_KEY is set', () => {
    CONFIG.TWOCAPTCHA_API_KEY = 'test-key';
    const provider = getTurnstileProvider(CONFIG);
    expect(provider.name).toBe('2Captcha');
    expect(provider.taskType).toBe('TurnstileTaskProxyless');
    expect(provider.supportsProxy).toBe(false);
  });

  it('prefers CapSolver over YesCaptcha and 2Captcha', () => {
    CONFIG.CAPSOLVER_API_KEY = 'cap-key';
    CONFIG.YESCAPTCHA_API_KEY = 'yes-key';
    CONFIG.TWOCAPTCHA_API_KEY = '2cap-key';
    expect(getTurnstileProvider(CONFIG).name).toBe('CapSolver');
  });

  it('prefers YesCaptcha over 2Captcha when CapSolver missing', () => {
    CONFIG.YESCAPTCHA_API_KEY = 'yes-key';
    CONFIG.TWOCAPTCHA_API_KEY = '2cap-key';
    expect(getTurnstileProvider(CONFIG).name).toBe('YesCaptcha');
  });

  it('enables proxy mode for 2Captcha when proxy vars set', () => {
    CONFIG.TWOCAPTCHA_API_KEY = 'test-key';
    CONFIG.PROXY_TYPE = 'socks5';
    CONFIG.PROXY_ADDRESS = '1.2.3.4';
    CONFIG.PROXY_PORT = '1080';
    const provider = getTurnstileProvider(CONFIG);
    expect(provider.taskType).toBe('TurnstileTask');
    expect(provider.supportsProxy).toBe(true);
  });

  it('requires all three proxy vars for proxy mode', () => {
    CONFIG.TWOCAPTCHA_API_KEY = 'test-key';
    CONFIG.PROXY_TYPE = 'socks5';
    CONFIG.PROXY_ADDRESS = '1.2.3.4';
    // PROXY_PORT is empty, so proxy mode should not activate
    const provider = getTurnstileProvider(CONFIG);
    expect(provider.taskType).toBe('TurnstileTaskProxyless');
  });

  it('YesCaptcha never enables proxy mode even if proxy vars set', () => {
    CONFIG.YESCAPTCHA_API_KEY = 'yes-key';
    CONFIG.PROXY_TYPE = 'socks5';
    CONFIG.PROXY_ADDRESS = '1.2.3.4';
    CONFIG.PROXY_PORT = '1080';
    const provider = getTurnstileProvider(CONFIG);
    expect(provider.name).toBe('YesCaptcha');
    expect(provider.supportsProxy).toBe(false);
    expect(provider.taskType).toBe('TurnstileTaskProxyless');
  });
});

describe('resolveYesCaptchaApiBase', () => {
  it('默认国际节点', () => {
    expect(resolveYesCaptchaApiBase()).toBe(YESCAPTCHA_DEFAULT_API_BASE);
    expect(resolveYesCaptchaApiBase('')).toBe(YESCAPTCHA_DEFAULT_API_BASE);
    expect(resolveYesCaptchaApiBase('   ')).toBe(YESCAPTCHA_DEFAULT_API_BASE);
  });

  it('去掉尾部斜杠', () => {
    expect(resolveYesCaptchaApiBase('https://cn.yescaptcha.com/')).toBe('https://cn.yescaptcha.com');
  });

  it('非法 URL 或协议回退默认', () => {
    expect(resolveYesCaptchaApiBase('not-a-url')).toBe(YESCAPTCHA_DEFAULT_API_BASE);
    expect(resolveYesCaptchaApiBase('ftp://api.yescaptcha.com')).toBe(YESCAPTCHA_DEFAULT_API_BASE);
  });
});

describe('resolveYesCaptchaTaskType', () => {
  it('默认 TurnstileTaskProxyless', () => {
    expect(resolveYesCaptchaTaskType()).toBe(YESCAPTCHA_DEFAULT_TASK_TYPE);
    expect(resolveYesCaptchaTaskType('')).toBe(YESCAPTCHA_DEFAULT_TASK_TYPE);
  });

  it('接受 M1 变体', () => {
    expect(resolveYesCaptchaTaskType('TurnstileTaskProxylessM1')).toBe('TurnstileTaskProxylessM1');
  });

  it('未知类型回退默认', () => {
    expect(resolveYesCaptchaTaskType('TurnstileTask')).toBe(YESCAPTCHA_DEFAULT_TASK_TYPE);
  });
});
