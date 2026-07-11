import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTurnstileProvider } from '../../src/turnstile.mjs';

// 构造一个可变 CONFIG 对象供测试修改
const CONFIG = {
  CAPSOLVER_API_KEY: '',
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
    saved.TWOCAPTCHA_API_KEY = CONFIG.TWOCAPTCHA_API_KEY;
    saved.PROXY_TYPE = CONFIG.PROXY_TYPE;
    saved.PROXY_ADDRESS = CONFIG.PROXY_ADDRESS;
    saved.PROXY_PORT = CONFIG.PROXY_PORT;

    CONFIG.CAPSOLVER_API_KEY = '';
    CONFIG.TWOCAPTCHA_API_KEY = '';
    CONFIG.PROXY_TYPE = '';
    CONFIG.PROXY_ADDRESS = '';
    CONFIG.PROXY_PORT = '';
  });

  afterEach(() => {
    // 恢复原始值
    CONFIG.CAPSOLVER_API_KEY = saved.CAPSOLVER_API_KEY;
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

  it('returns 2Captcha when only TWOCAPTCHA_API_KEY is set', () => {
    CONFIG.TWOCAPTCHA_API_KEY = 'test-key';
    const provider = getTurnstileProvider(CONFIG);
    expect(provider.name).toBe('2Captcha');
    expect(provider.taskType).toBe('TurnstileTaskProxyless');
    expect(provider.supportsProxy).toBe(false);
  });

  it('prefers CapSolver over 2Captcha', () => {
    CONFIG.CAPSOLVER_API_KEY = 'cap-key';
    CONFIG.TWOCAPTCHA_API_KEY = '2cap-key';
    expect(getTurnstileProvider(CONFIG).name).toBe('CapSolver');
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
});
