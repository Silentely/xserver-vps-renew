import { describe, it, expect } from 'vitest';
import {
  DEFAULT_NEXT_RUN_INTERVAL_HOURS,
  parseCronIntervalHours,
  estimateNextRunMs,
  resolveNextRunAt,
  TG_NOTIFY_DETAIL_FULL,
  TG_NOTIFY_DETAIL_COMPACT,
  DEFAULT_TG_NOTIFY_DETAIL,
  TG_MESSAGE_MAX_LEN,
  TG_ERROR_MESSAGE_MAX_LEN,
  TG_PROCESS_STEP_MAX_COUNT,
  parseNotifyDetail,
  isFullNotifyDetail,
  formatRemainingHours,
  getHoursUntilRenewalWindow,
  formatHoursUntilWindow,
  formatDurationMs,
  truncateNotifyText,
  normalizeProcessSteps,
  clampProcessSteps,
  formatProcessSteps,
  clampTelegramMessage,
  resolveTurnstileProviderLabel,
  formatTurnstileNotifyLine,
  buildSuccessNotifyMessage,
  buildSkipNotifyMessage,
  isTurnstileAllProvidersFailed,
  FAILURE_CATEGORY,
  classifyRenewalFailure,
  buildFailureHints,
  buildFailureNotifyMessage,
  buildProxyHint,
} from '../../src/notify.mjs';

describe('parseCronIntervalHours / estimateNextRunMs', () => {
  it('解析 */N 小时 cron（含 compose 默认 27 */4）', () => {
    expect(parseCronIntervalHours('27 */4 * * *')).toBe(4);
    expect(parseCronIntervalHours('32 */6 * * *')).toBe(6);
    expect(parseCronIntervalHours('0 */6 * * *')).toBe(6);
    expect(parseCronIntervalHours('0 */12 * * *')).toBe(12);
  });

  it('非每 N 小时表达式返回 null', () => {
    expect(parseCronIntervalHours('0 23 * * *')).toBeNull();
    expect(parseCronIntervalHours('')).toBeNull();
    expect(parseCronIntervalHours(null)).toBeNull();
  });

  it('默认间隔为 6 小时（非 24 小时）', () => {
    expect(DEFAULT_NEXT_RUN_INTERVAL_HOURS).toBe(6);
    const now = Date.UTC(2026, 6, 14, 6, 34, 0);
    expect(estimateNextRunMs(now, {})).toBe(now + 6 * 3_600_000);
  });

  it('优先使用 CRON 间隔', () => {
    const now = Date.UTC(2026, 6, 14, 6, 34, 0);
    expect(estimateNextRunMs(now, {
      cronSchedule: '32 */6 * * *',
      intervalHours: 24,
    })).toBe(now + 6 * 3_600_000);
  });

  it('无 cron 时使用 intervalHours', () => {
    const now = Date.UTC(2026, 6, 14, 6, 34, 0);
    expect(estimateNextRunMs(now, { intervalHours: 8 })).toBe(now + 8 * 3_600_000);
  });

  it('resolveNextRunAt 返回非空字符串', () => {
    expect(resolveNextRunAt(Date.UTC(2026, 6, 14, 6, 34, 0), {
      cronSchedule: '32 */6 * * *',
    })).toBeTruthy();
  });
});

describe('parseNotifyDetail', () => {
  it('默认 full', () => {
    expect(parseNotifyDetail(undefined)).toBe(TG_NOTIFY_DETAIL_FULL);
    expect(parseNotifyDetail('')).toBe(TG_NOTIFY_DETAIL_FULL);
    expect(DEFAULT_TG_NOTIFY_DETAIL).toBe(TG_NOTIFY_DETAIL_FULL);
  });

  it('识别 full 与别名', () => {
    expect(parseNotifyDetail('full')).toBe(TG_NOTIFY_DETAIL_FULL);
    expect(parseNotifyDetail('FULL')).toBe(TG_NOTIFY_DETAIL_FULL);
    expect(parseNotifyDetail('detailed')).toBe(TG_NOTIFY_DETAIL_FULL);
    expect(parseNotifyDetail('verbose')).toBe(TG_NOTIFY_DETAIL_FULL);
  });

  it('识别 compact 与别名', () => {
    expect(parseNotifyDetail('compact')).toBe(TG_NOTIFY_DETAIL_COMPACT);
    expect(parseNotifyDetail('COMPACT')).toBe(TG_NOTIFY_DETAIL_COMPACT);
    expect(parseNotifyDetail('brief')).toBe(TG_NOTIFY_DETAIL_COMPACT);
    expect(parseNotifyDetail('simple')).toBe(TG_NOTIFY_DETAIL_COMPACT);
    expect(parseNotifyDetail('short')).toBe(TG_NOTIFY_DETAIL_COMPACT);
  });

  it('非法值回退 fallback', () => {
    expect(parseNotifyDetail('nope')).toBe(TG_NOTIFY_DETAIL_FULL);
    expect(parseNotifyDetail('nope', 'compact')).toBe(TG_NOTIFY_DETAIL_COMPACT);
  });

  it('isFullNotifyDetail', () => {
    expect(isFullNotifyDetail('full')).toBe(true);
    expect(isFullNotifyDetail('compact')).toBe(false);
  });
});

describe('formatRemainingHours', () => {
  it('null/非有限数返回未知', () => {
    expect(formatRemainingHours(null)).toBe('未知');
    expect(formatRemainingHours(undefined)).toBe('未知');
    expect(formatRemainingHours(NaN)).toBe('未知');
  });

  it('正数显示约 N 小时', () => {
    expect(formatRemainingHours(18.25)).toBe('约 18.3 小时');
  });

  it('负数显示已过期', () => {
    expect(formatRemainingHours(-1.5)).toBe('已过期 1.5 小时');
  });
});

describe('formatProcessSteps', () => {
  it('空数组返回空字符串', () => {
    expect(formatProcessSteps([])).toBe('');
    expect(formatProcessSteps(null)).toBe('');
  });

  it('格式化为编号列表并转义 HTML', () => {
    const out = formatProcessSteps(['登录成功', '检查 <b>状态']);
    expect(out).toContain('执行过程');
    expect(out).toContain('1. 登录成功');
    expect(out).toContain('2. 检查 &lt;b&gt;状态');
    expect(out).not.toContain('检查 <b>状态');
  });

  it('compact 模式不输出过程步骤', () => {
    expect(formatProcessSteps(['登录成功'], 'compact')).toBe('');
  });

  it('步骤过多时保留最近步骤并提示省略', () => {
    const many = Array.from({ length: TG_PROCESS_STEP_MAX_COUNT + 5 }, (_, i) => `步骤${i + 1}`);
    const out = formatProcessSteps(many, 'full');
    expect(out).toContain('此前另有');
    expect(out).toContain(`步骤${many.length}`);
    expect(out).not.toContain('步骤1\n');
  });

  it('连续重复步骤合并后再编号', () => {
    const out = formatProcessSteps(['登录成功', '登录成功', '提交完成'], 'full');
    expect(out).toContain('1. 登录成功');
    expect(out).toContain('2. 提交完成');
    expect(out).not.toContain('3.');
  });
});

describe('formatDurationMs / truncateNotifyText / clampTelegramMessage', () => {
  it('formatDurationMs 秒/分/小时', () => {
    expect(formatDurationMs(0)).toBe('0 秒');
    expect(formatDurationMs(4500)).toBe('5 秒');
    expect(formatDurationMs(65_000)).toBe('1 分 5 秒');
    expect(formatDurationMs(120_000)).toBe('2 分');
    expect(formatDurationMs(3_600_000)).toBe('1 小时');
    expect(formatDurationMs(3_660_000)).toBe('1 小时 1 分');
    expect(formatDurationMs(null)).toBe('未知');
  });

  it('truncateNotifyText 超长截断并标注总字数', () => {
    const long = 'a'.repeat(TG_ERROR_MESSAGE_MAX_LEN + 50);
    const out = truncateNotifyText(long);
    expect(out.length).toBeLessThanOrEqual(TG_ERROR_MESSAGE_MAX_LEN);
    expect(out).toContain('已截断');
    expect(out).toContain(String(long.length));
  });

  it('clampTelegramMessage 不超过上限', () => {
    const long = 'x'.repeat(TG_MESSAGE_MAX_LEN + 200);
    const out = clampTelegramMessage(long);
    expect(out.length).toBeLessThanOrEqual(TG_MESSAGE_MAX_LEN);
    expect(out).toContain('消息过长已截断');
  });

  it('clampProcessSteps 限制条数与单行长度', () => {
    const steps = clampProcessSteps(
      ['  a  ', '', 'b'.repeat(300), ...Array.from({ length: 20 }, (_, i) => `s${i}`)],
      { maxCount: 5, maxLen: 20 },
    );
    expect(steps.length).toBeLessThanOrEqual(5);
    expect(steps.some((s) => s.includes('省略'))).toBe(true);
    expect(steps.every((s) => s.length <= 20 || s.includes('省略'))).toBe(true);
  });
});

describe('buildSuccessNotifyMessage', () => {
  it('包含服务器名与到期日', () => {
    const msg = buildSuccessNotifyMessage({
      serverName: 'vps-1',
      plan: '1GB',
      oldExpireDate: '2026-07-01',
      newExpireDate: '2026-07-31',
      executedAt: '2026/7/11 12:00:00',
      nextRunAt: '2026/7/12 12:00:00',
    });
    expect(msg).toContain('续期成功');
    expect(msg).toContain('vps-1');
    expect(msg).toContain('2026-07-31');
  });

  it('HTML 特殊字符被转义', () => {
    const msg = buildSuccessNotifyMessage({
      serverName: '<script>',
      executedAt: 't',
      nextRunAt: 'n',
    });
    expect(msg).toContain('&lt;script&gt;');
    expect(msg).not.toContain('<script>');
  });

  it('full 可附带执行过程摘要', () => {
    const msg = buildSuccessNotifyMessage({
      serverName: 'vps-1',
      executedAt: 't',
      nextRunAt: 'n',
      processSteps: ['登录成功', '提交完成'],
      detail: 'full',
    });
    expect(msg).toContain('执行过程');
    expect(msg).toContain('1. 登录成功');
    expect(msg).toContain('2. 提交完成');
    expect(msg).toContain('VPS 规格');
  });

  it('compact 省略规格、原到期日与过程', () => {
    const msg = buildSuccessNotifyMessage({
      serverName: 'vps-1',
      plan: '4GB',
      oldExpireDate: 'old',
      newExpireDate: 'new',
      executedAt: 't',
      nextRunAt: 'n',
      processSteps: ['登录成功'],
      detail: 'compact',
    });
    expect(msg).toContain('续期成功');
    expect(msg).toContain('vps-1');
    expect(msg).toContain('new');
    expect(msg).not.toContain('执行过程');
    expect(msg).not.toContain('VPS 规格');
    expect(msg).not.toContain('原到期日');
  });

  it('成功通知含 Turnstile 平台与 failover 摘要', () => {
    const msg = buildSuccessNotifyMessage({
      serverName: 'vps-1',
      newExpireDate: '2026-07-26',
      executedAt: 't',
      nextRunAt: 'n',
      turnstileProvider: 'CapSolver',
      turnstileAttempts: [
        { provider: 'AntiCaptcha', success: false, failures: 3 },
        { provider: 'CapSolver', success: true, failures: 0 },
      ],
      detail: 'full',
    });
    expect(msg).toContain('Turnstile: CapSolver');
    expect(msg).toContain('AntiCaptcha');
    expect(msg).toContain('熔断后切换');
  });

  it('成功通知含耗时', () => {
    const msg = buildSuccessNotifyMessage({
      serverName: 'vps-1',
      executedAt: 't',
      nextRunAt: 'n',
      durationMs: 95_000,
      detail: 'compact',
    });
    expect(msg).toContain('耗时');
    expect(msg).toContain('1 分 35 秒');
  });

  it('full 成功通知可附带续期前剩余时间', () => {
    const msg = buildSuccessNotifyMessage({
      serverName: 'vps-1',
      executedAt: 't',
      nextRunAt: 'n',
      remainingHours: 8.5,
      detail: 'full',
    });
    expect(msg).toContain('续期前剩余');
    expect(msg).toContain('约 8.5 小时');
  });
});

describe('formatTurnstileNotifyLine / resolveTurnstileProviderLabel', () => {
  it('无平台返回空', () => {
    expect(formatTurnstileNotifyLine({})).toBe('');
  });

  it('仅成功平台', () => {
    expect(formatTurnstileNotifyLine({ providerName: 'CapSolver' }))
      .toBe('🔐 Turnstile: CapSolver');
  });

  it('prefilled / natural 使用中文标签', () => {
    expect(resolveTurnstileProviderLabel('prefilled')).toBe('页面预填');
    expect(resolveTurnstileProviderLabel('natural')).toBe('自然通过');
    expect(formatTurnstileNotifyLine({ providerName: 'prefilled' }))
      .toBe('🔐 Turnstile: 页面预填');
  });
});

describe('normalizeProcessSteps', () => {
  it('合并连续重复并去空', () => {
    expect(normalizeProcessSteps(['登录', '登录', '', ' 检查 ', '检查', '提交']))
      .toEqual(['登录', '检查', '提交']);
  });
});

describe('getHoursUntilRenewalWindow / formatHoursUntilWindow', () => {
  it('计算距可续窗口小时数', () => {
    expect(getHoursUntilRenewalWindow(20, 12)).toBe(8);
    expect(getHoursUntilRenewalWindow(10, 12)).toBe(0);
    expect(getHoursUntilRenewalWindow(null, 12)).toBeNull();
  });

  it('格式化文案', () => {
    expect(formatHoursUntilWindow(20, 12)).toBe('约 8.0 小时后可续');
    expect(formatHoursUntilWindow(8, 12)).toBe('已进入可续期窗口');
    expect(formatHoursUntilWindow(null)).toBe('');
  });
});

describe('buildSkipNotifyMessage', () => {
  it('无需续期时包含 VPS 状态与判定说明', () => {
    const msg = buildSkipNotifyMessage({
      reasonCode: 'not_due',
      serverName: 'vps-host-1',
      plan: '4GB',
      expireDate: '2026-07-22 20:00:00',
      remainingHours: 15.5,
      executedAt: '2026/7/22 10:00:00',
      nextRunAt: '2026/7/22 16:00:00',
      processSteps: ['登录成功', '检查到期状态', '判定结果: 无需续期'],
      detail: 'full',
    });
    expect(msg).toContain('无需续期');
    expect(msg).toContain('vps-host-1');
    expect(msg).toContain('4GB');
    expect(msg).toContain('2026-07-22 20:00:00');
    expect(msg).toContain('约 15.5 小时');
    expect(msg).toContain('距可续窗口');
    expect(msg).toContain('约 3.5 小时后可续');
    expect(msg).toContain('剩余≤12h 可续');
    expect(msg).toContain('执行过程');
    expect(msg).toContain('1. 登录成功');
  });

  it('compact 保留关键状态与距窗口，省略规格、判定详情与过程', () => {
    const msg = buildSkipNotifyMessage({
      reasonCode: 'not_due',
      serverName: 'vps-host-1',
      plan: '4GB',
      expireDate: '2026-07-22 20:00:00',
      remainingHours: 15.5,
      executedAt: 't',
      nextRunAt: 'n',
      reasonDetail: '很长的判定说明',
      processSteps: ['登录成功'],
      detail: 'compact',
    });
    expect(msg).toContain('无需续期');
    expect(msg).toContain('vps-host-1');
    expect(msg).toContain('2026-07-22 20:00:00');
    expect(msg).toContain('约 15.5 小时');
    expect(msg).toContain('距可续窗口');
    expect(msg).not.toContain('4GB');
    expect(msg).not.toContain('很长的判定说明');
    expect(msg).not.toContain('执行过程');
  });

  it('未找到免费 VPS 时使用对应标题', () => {
    const msg = buildSkipNotifyMessage({
      reasonCode: 'no_free_vps',
      executedAt: 't',
      nextRunAt: 'n',
    });
    expect(msg).toContain('未找到免费 VPS');
    expect(msg).toContain('未找到带免费标识');
  });

  it('官方 12h 窗口拦截时使用对应标题与原因', () => {
    const msg = buildSkipNotifyMessage({
      reasonCode: 'window_blocked',
      serverName: 'host02-18',
      expireDate: '2026-07-24',
      remainingHours: 47.1,
      reasonDetail: '未进入官方续期窗口；请于 2026-07-24 12:00（东京）之后再试',
      executedAt: 't',
      nextRunAt: 'n',
      detail: 'full',
    });
    expect(msg).toContain('未进入 12h 续期窗口');
    expect(msg).toContain('host02-18');
    expect(msg).toContain('2026-07-24 12:00');
    expect(msg).toContain('约 47.1 小时');
  });

  it('HTML 特殊字符被转义', () => {
    const msg = buildSkipNotifyMessage({
      serverName: '<x>',
      reasonDetail: 'a & b',
      executedAt: 't',
      nextRunAt: 'n',
    });
    expect(msg).toContain('&lt;x&gt;');
    expect(msg).toContain('a &amp; b');
  });
});

describe('isTurnstileAllProvidersFailed', () => {
  it('flag / errorCode / 文案均可识别', () => {
    expect(isTurnstileAllProvidersFailed({ turnstileAllProvidersFailed: true })).toBe(true);
    expect(isTurnstileAllProvidersFailed({
      errorCode: 'TURNSTILE_ALL_PROVIDERS_FAILED',
    })).toBe(true);
    expect(isTurnstileAllProvidersFailed({
      errorMessage: 'Turnstile 多平台均失败（链路: CapSolver）',
    })).toBe(true);
    expect(isTurnstileAllProvidersFailed({ errorMessage: 'timeout' })).toBe(false);
    expect(isTurnstileAllProvidersFailed()).toBe(false);
  });
});

describe('classifyRenewalFailure / buildFailureHints', () => {
  it('按错误文案/错误码分类', () => {
    expect(classifyRenewalFailure({
      errorCode: 'TURNSTILE_ALL_PROVIDERS_FAILED',
    }).category).toBe(FAILURE_CATEGORY.TURNSTILE_OUTAGE);

    expect(classifyRenewalFailure({
      errorMessage: '登录失败，请检查 XSERVER_MEMBER_ID 和 XSERVER_PASSWORD。',
    }).category).toBe(FAILURE_CATEGORY.LOGIN);

    expect(classifyRenewalFailure({
      errorMessage: '配置校验失败: XSERVER_MEMBER_ID',
    }).category).toBe(FAILURE_CATEGORY.CONFIG);

    expect(classifyRenewalFailure({
      errorMessage: 'Keras 模型 API 返回无效结果: "ab"',
    }).category).toBe(FAILURE_CATEGORY.CAPTCHA);

    expect(classifyRenewalFailure({
      errorMessage: 'Turnstile 等待超时，将尝试强制提交',
    }).category).toBe(FAILURE_CATEGORY.TURNSTILE);

    expect(classifyRenewalFailure({
      errorMessage: '需要绑定信用卡才能续期',
    }).category).toBe(FAILURE_CATEGORY.BUSINESS);

    expect(classifyRenewalFailure({
      errorMessage: 'Navigation timeout of 30000 ms exceeded',
    }).category).toBe(FAILURE_CATEGORY.TIMEOUT);

    expect(classifyRenewalFailure({
      errorMessage: 'something weird',
    }).category).toBe(FAILURE_CATEGORY.UNKNOWN);
  });

  it('按分类输出差异化处置建议', () => {
    expect(buildFailureHints({ category: FAILURE_CATEGORY.LOGIN }))
      .toContain('XSERVER_MEMBER_ID');
    expect(buildFailureHints({ category: FAILURE_CATEGORY.CAPTCHA, captchaMaxRetry: 5 }))
      .toContain('5 次');
    expect(buildFailureHints({ category: FAILURE_CATEGORY.TURNSTILE_OUTAGE }))
      .toContain('立即人工登录');
    expect(buildFailureHints({ category: FAILURE_CATEGORY.CONFIG }))
      .toContain('配置校验');
  });
});

describe('buildFailureNotifyMessage', () => {
  it('普通失败不含告警升级', () => {
    const msg = buildFailureNotifyMessage({
      errorMessage: 'boom',
      isEscalation: false,
      proxyHint: 'hint',
      captchaMaxRetry: 3,
      executedAt: 't',
    });
    expect(msg).toContain('续期失败');
    expect(msg).not.toContain('告警升级');
    expect(msg).toContain('boom');
  });

  it('升级告警含连续失败次数', () => {
    const msg = buildFailureNotifyMessage({
      errorMessage: 'x',
      consecutiveFailures: 5,
      isEscalation: true,
      proxyHint: '',
      executedAt: 't',
    });
    expect(msg).toContain('告警升级');
    expect(msg).toContain('连续失败 5 次');
  });

  it('full 可附带执行过程摘要与失败说明', () => {
    const msg = buildFailureNotifyMessage({
      errorMessage: 'timeout',
      executedAt: 't',
      processSteps: ['登录成功', '异常终止: timeout'],
      detail: 'full',
      proxyHint: 'hint',
    });
    expect(msg).toContain('执行过程');
    expect(msg).toContain('1. 登录成功');
    expect(msg).toContain('timeout');
    expect(msg).toContain('失败说明');
  });

  it('compact 仅核心错误，无过程与失败说明', () => {
    const msg = buildFailureNotifyMessage({
      errorMessage: 'timeout',
      executedAt: 't',
      processSteps: ['登录成功'],
      detail: 'compact',
      proxyHint: 'hint',
      captchaMaxRetry: 3,
    });
    expect(msg).toContain('续期失败');
    expect(msg).toContain('timeout');
    expect(msg).not.toContain('执行过程');
    expect(msg).not.toContain('失败说明');
    expect(msg).not.toContain('hint');
  });

  it('多平台全挂时发出最高级删机风险告警', () => {
    const msg = buildFailureNotifyMessage({
      errorMessage: 'Turnstile 多平台均失败（链路: CapSolver → AntiCaptcha）: ...',
      executedAt: 't',
      turnstileAllProvidersFailed: true,
      failedProviders: ['CapSolver', 'AntiCaptcha'],
      processSteps: ['API 熔断'],
      detail: 'full',
      proxyHint: 'hint',
    });
    expect(msg).toContain('最高级告警');
    expect(msg).toContain('删机风险');
    expect(msg).toContain('手动登录');
    expect(msg).toContain('CapSolver');
    expect(msg).toContain('AntiCaptcha');
  });

  it('errorCode 为 TURNSTILE_ALL_PROVIDERS_FAILED 时同样升级', () => {
    const msg = buildFailureNotifyMessage({
      errorMessage: 'boom',
      errorCode: 'TURNSTILE_ALL_PROVIDERS_FAILED',
      executedAt: 't',
      detail: 'compact',
    });
    expect(msg).toContain('最高级告警');
  });

  it('失败通知附带 VPS 上下文、耗时，并截断超长错误', () => {
    const longErr = `fail-${'x'.repeat(800)}`;
    const msg = buildFailureNotifyMessage({
      errorMessage: longErr,
      executedAt: 't',
      serverName: 'host-a',
      plan: '4GB',
      expireDate: '2026-07-26',
      remainingHours: 3.2,
      durationMs: 12_000,
      detail: 'full',
      proxyHint: 'hint',
    });
    expect(msg).toContain('host-a');
    expect(msg).toContain('4GB');
    expect(msg).toContain('2026-07-26');
    expect(msg).toContain('约 3.2 小时');
    expect(msg).toContain('失败类型');
    expect(msg).toContain('耗时');
    expect(msg).toContain('已截断');
    expect(msg).not.toContain(longErr);
    expect(msg.length).toBeLessThanOrEqual(TG_MESSAGE_MAX_LEN);
  });

  it('compact 失败通知仍可含服务器名与失败类型，不含规格与失败说明', () => {
    const msg = buildFailureNotifyMessage({
      errorMessage: '登录失败，请检查 XSERVER_MEMBER_ID 和 XSERVER_PASSWORD。',
      executedAt: 't',
      serverName: 'host-b',
      plan: '4GB',
      detail: 'compact',
    });
    expect(msg).toContain('host-b');
    expect(msg).toContain('失败类型');
    expect(msg).toContain('登录失败');
    expect(msg).not.toContain('4GB');
    expect(msg).not.toContain('失败说明');
  });

  it('登录类失败使用登录处置建议', () => {
    const msg = buildFailureNotifyMessage({
      errorMessage: '登录失败，请检查 XSERVER_MEMBER_ID 和 XSERVER_PASSWORD。',
      executedAt: 't',
      detail: 'full',
      proxyHint: 'hint',
    });
    expect(msg).toContain('登录失败');
    expect(msg).toContain('XSERVER_MEMBER_ID');
    expect(msg).not.toContain('验证码识别已自动重试');
  });
});

describe('buildProxyHint', () => {
  it('有代理时显示浏览器代理脱敏信息', () => {
    const msg = buildProxyHint({
      hasProxy: true,
      proxyType: 'socks5',
      maskedAddress: '****.100',
      proxyPort: 1080,
    });
    expect(msg).toContain('浏览器代理');
    expect(msg).toContain('socks5://****.100:1080');
  });

  it('域名代理跳过 AntiCaptcha 时附加说明', () => {
    const msg = buildProxyHint({
      hasProxy: true,
      proxyType: 'http',
      maskedAddress: '***e.io',
      proxyPort: 80,
      antiCaptchaHostnameSkipped: true,
    });
    expect(msg).toContain('仅支持 IP');
    expect(msg).toContain('Proxyless');
  });

  it('无代理时给出优化建议', () => {
    const msg = buildProxyHint({ hasProxy: false });
    expect(msg).toContain('优化建议');
    expect(msg).toContain('仅接受 IP');
  });
});
