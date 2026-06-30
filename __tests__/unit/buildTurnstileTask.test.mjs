import { describe, it, expect } from 'vitest';
import { buildTurnstileTask, maskTaskForLog } from '../../src/turnstile.mjs';

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0';

// 测试数据工厂
const makeCapSolverProvider = () => ({
  name: 'CapSolver',
  apiBase: 'https://api.capsolver.com',
  clientKey: 'cap-key',
  taskType: 'AntiTurnstileTaskProxyLess',
  supportsProxy: false,
});

const make2CaptchaProvider = (withProxy = false) => ({
  name: '2Captcha',
  apiBase: 'https://api.2captcha.com',
  clientKey: '2cap-key',
  taskType: withProxy ? 'TurnstileTask' : 'TurnstileTaskProxyless',
  supportsProxy: withProxy,
});

const makeConfig = (overrides = {}) => ({
  proxyType: '',
  proxyAddress: '',
  proxyPort: '',
  proxyLogin: '',
  proxyPassword: '',
  userAgent: DEFAULT_UA,
  ...overrides,
});

const makeParams = (overrides = {}) => ({
  sitekey: '0x4AAAAAAABTESTKEY',
  action: '',
  cData: '',
  chlPageData: '',
  ...overrides,
});

describe('buildTurnstileTask', () => {
  // === CapSolver 基础参数 ===

  it('CapSolver 生成包含正确 taskType 的任务', () => {
    const task = buildTurnstileTask(
      makeCapSolverProvider(),
      makeParams(),
      makeConfig(),
      'https://example.com/login',
    );
    expect(task.type).toBe('AntiTurnstileTaskProxyLess');
    expect(task.websiteKey).toBe('0x4AAAAAAABTESTKEY');
    expect(task.websiteURL).toBe('https://example.com/login');
    expect(task.userAgent).toBe(DEFAULT_UA);
  });

  it('CapSolver 不支持代理，不生成代理参数', () => {
    const task = buildTurnstileTask(
      makeCapSolverProvider(),
      makeParams(),
      makeConfig({ proxyType: 'socks5', proxyAddress: '1.2.3.4', proxyPort: '1080' }),
      'https://example.com',
    );
    expect(task.proxyType).toBeUndefined();
    expect(task.proxyAddress).toBeUndefined();
    expect(task.proxyPort).toBeUndefined();
  });

  it('CapSolver 通过 metadata 传递 action', () => {
    const task = buildTurnstileTask(
      makeCapSolverProvider(),
      makeParams({ action: 'login' }),
      makeConfig(),
      'https://example.com',
    );
    expect(task.metadata).toEqual({ action: 'login' });
  });

  it('CapSolver 通过 metadata 传递 cdata', () => {
    const task = buildTurnstileTask(
      makeCapSolverProvider(),
      makeParams({ cData: 'abc123' }),
      makeConfig(),
      'https://example.com',
    );
    expect(task.metadata).toEqual({ cdata: 'abc123' });
  });

  it('CapSolver 同时传递 action 和 cdata', () => {
    const task = buildTurnstileTask(
      makeCapSolverProvider(),
      makeParams({ action: 'login', cData: 'xyz789' }),
      makeConfig(),
      'https://example.com',
    );
    expect(task.metadata).toEqual({ action: 'login', cdata: 'xyz789' });
  });

  it('CapSolver 无 action/cdata 时不生成 metadata', () => {
    const task = buildTurnstileTask(
      makeCapSolverProvider(),
      makeParams(),
      makeConfig(),
      'https://example.com',
    );
    expect(task.metadata).toBeUndefined();
  });

  // === 2Captcha 基础参数 ===

  it('2Captcha 无代理时使用 TurnstileTaskProxyless', () => {
    const task = buildTurnstileTask(
      make2CaptchaProvider(false),
      makeParams(),
      makeConfig(),
      'https://example.com',
    );
    expect(task.type).toBe('TurnstileTaskProxyless');
  });

  it('2Captcha 有代理时使用 TurnstileTask', () => {
    const task = buildTurnstileTask(
      make2CaptchaProvider(true),
      makeParams(),
      makeConfig({ proxyType: 'socks5', proxyAddress: '1.2.3.4', proxyPort: '1080' }),
      'https://example.com',
    );
    expect(task.type).toBe('TurnstileTask');
  });

  // === 2Captcha 代理参数 ===

  it('2Captcha 带代理模式生成完整代理参数', () => {
    const task = buildTurnstileTask(
      make2CaptchaProvider(true),
      makeParams(),
      makeConfig({
        proxyType: 'socks5',
        proxyAddress: '1.2.3.4',
        proxyPort: '1080',
        proxyLogin: 'user',
        proxyPassword: 'pass123',
      }),
      'https://example.com',
    );
    expect(task.proxyType).toBe('socks5');
    expect(task.proxyAddress).toBe('1.2.3.4');
    expect(task.proxyPort).toBe(1080);
    expect(task.proxyLogin).toBe('user');
    expect(task.proxyPassword).toBe('pass123');
  });

  it('2Captcha 代理端口从字符串转为数字', () => {
    const task = buildTurnstileTask(
      make2CaptchaProvider(true),
      makeParams(),
      makeConfig({ proxyType: 'http', proxyAddress: '5.6.7.8', proxyPort: '3128' }),
      'https://example.com',
    );
    expect(task.proxyPort).toBe(3128);
    expect(typeof task.proxyPort).toBe('number');
  });

  it('2Captcha 代理无用户名密码时不生成对应字段', () => {
    const task = buildTurnstileTask(
      make2CaptchaProvider(true),
      makeParams(),
      makeConfig({ proxyType: 'http', proxyAddress: '5.6.7.8', proxyPort: '3128' }),
      'https://example.com',
    );
    expect(task.proxyLogin).toBeUndefined();
    expect(task.proxyPassword).toBeUndefined();
  });

  // === 2Captcha 顶层 action/data/pagedata ===

  it('2Captcha 使用顶层字段传递 action', () => {
    const task = buildTurnstileTask(
      make2CaptchaProvider(),
      makeParams({ action: 'submit' }),
      makeConfig(),
      'https://example.com',
    );
    expect(task.action).toBe('submit');
    expect(task.metadata).toBeUndefined();
  });

  it('2Captcha 使用顶层字段传递 data（cData 映射为 data）', () => {
    const task = buildTurnstileTask(
      make2CaptchaProvider(),
      makeParams({ cData: 'challenge-data' }),
      makeConfig(),
      'https://example.com',
    );
    expect(task.data).toBe('challenge-data');
  });

  it('2Captcha 使用顶层字段传递 pagedata（chlPageData 映射为 pagedata）', () => {
    const task = buildTurnstileTask(
      make2CaptchaProvider(),
      makeParams({ chlPageData: 'page-data-xxx' }),
      makeConfig(),
      'https://example.com',
    );
    expect(task.pagedata).toBe('page-data-xxx');
  });

  it('2Captcha 同时传递 action + data + pagedata', () => {
    const task = buildTurnstileTask(
      make2CaptchaProvider(),
      makeParams({ action: 'login', cData: 'cdata-val', chlPageData: 'pagedata-val' }),
      makeConfig(),
      'https://example.com',
    );
    expect(task.action).toBe('login');
    expect(task.data).toBe('cdata-val');
    expect(task.pagedata).toBe('pagedata-val');
  });

  // === CapSolver 不生成顶层 action/data/pagedata ===

  it('CapSolver 不生成顶层 action 字段', () => {
    const task = buildTurnstileTask(
      makeCapSolverProvider(),
      makeParams({ action: 'login', cData: 'data', chlPageData: 'pagedata' }),
      makeConfig(),
      'https://example.com',
    );
    expect(task.action).toBeUndefined();
    expect(task.data).toBeUndefined();
    expect(task.pagedata).toBeUndefined();
  });

  // === 不修改输入对象 ===

  it('不修改原始 params 对象', () => {
    const params = makeParams({ action: 'login' });
    const paramsCopy = { ...params };
    buildTurnstileTask(makeCapSolverProvider(), params, makeConfig(), 'https://example.com');
    expect(params).toEqual(paramsCopy);
  });

  it('不修改原始 config 对象', () => {
    const config = makeConfig({ proxyAddress: '1.2.3.4' });
    const configCopy = { ...config };
    buildTurnstileTask(make2CaptchaProvider(true), makeParams(), config, 'https://example.com');
    expect(config).toEqual(configCopy);
  });
});

describe('maskTaskForLog', () => {
  it('mask 代理地址（保留后 4 位，其余替换为星号）', () => {
    // 正则 /.(?=.{4})/g 匹配"后面还有 >=4 个字符的任意字符"
    // '123.123.123.123' (15 字符) → 保留最后 4 位 '.123'，前 11 个字符被替换
    const masked = maskTaskForLog({ proxyAddress: '123.123.123.123' });
    expect(masked.proxyAddress).toBe('***********.123');
  });

  it('mask 代理密码', () => {
    const masked = maskTaskForLog({ proxyPassword: 'supersecret' });
    expect(masked.proxyPassword).toBe('***');
  });

  it('mask 代理用户名', () => {
    const masked = maskTaskForLog({ proxyLogin: 'admin' });
    expect(masked.proxyLogin).toBe('***');
  });

  it('不 mask 非敏感字段', () => {
    const masked = maskTaskForLog({
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: 'https://example.com',
      websiteKey: '0x4AAAA',
    });
    expect(masked.type).toBe('AntiTurnstileTaskProxyLess');
    expect(masked.websiteURL).toBe('https://example.com');
    expect(masked.websiteKey).toBe('0x4AAAA');
  });

  it('不修改原始任务对象', () => {
    const task = { proxyAddress: '1.2.3.4', proxyPassword: 'secret' };
    maskTaskForLog(task);
    expect(task.proxyAddress).toBe('1.2.3.4');
    expect(task.proxyPassword).toBe('secret');
  });

  it('空对象不报错', () => {
    expect(() => maskTaskForLog({})).not.toThrow();
    expect(maskTaskForLog({})).toEqual({});
  });

  it('短代理地址（<5 字符）不 mask（每个字符后面都不足 4 个字符）', () => {
    // '1.2' 每个字符后面都不足 4 个字符，正则不匹配
    const masked = maskTaskForLog({ proxyAddress: '1.2' });
    expect(masked.proxyAddress).toBe('1.2');
  });
});
