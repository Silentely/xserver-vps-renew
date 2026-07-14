import { describe, it, expect } from 'vitest';
import {
  isRenewalDue,
  parseExpireTimestamp,
  getRemainingHours,
  buildRenewUrl,
  resolveCaptchaRetryUrl,
  evaluateSubmissionResult,
  extractExpireDateFromText,
  normalizeCellText,
  escapeHtml,
  formatTokyoDateTime,
  resolveNextRunAt,
  estimateNextRunMs,
  parseCronIntervalHours,
  buildSuccessNotifyMessage,
  buildFailureNotifyMessage,
  buildProxyHint,
  FREE_VPS_MAX_HOURS,
  RENEWAL_WINDOW_HOURS,
  DEFAULT_NEXT_RUN_INTERVAL_HOURS,
} from '../../src/renewal-logic.mjs';

describe('政策常量', () => {
  it('4GB 最长 24 小时，剩余 ≤12 小时可续期', () => {
    expect(FREE_VPS_MAX_HOURS).toBe(24);
    expect(RENEWAL_WINDOW_HOURS).toBe(12);
  });
});

describe('parseExpireTimestamp / getRemainingHours', () => {
  it('解析纯日期为东京日末', () => {
    // 2026-07-11 23:59:59 JST = 2026-07-11 14:59:59 UTC
    const ms = parseExpireTimestamp('2026-07-11');
    expect(ms).toBe(Date.UTC(2026, 6, 11, 14, 59, 59));
  });

  it('解析带时间的 ISO 文案', () => {
    // 2026-07-11 12:00:00 JST = 2026-07-11 03:00:00 UTC
    const ms = parseExpireTimestamp('2026-07-11 12:00:00');
    expect(ms).toBe(Date.UTC(2026, 6, 11, 3, 0, 0));
  });

  it('计算剩余小时', () => {
    const nowMs = Date.UTC(2026, 6, 11, 0, 0, 0); // 2026-07-11 09:00 JST
    // expire 2026-07-11 15:00 JST = 06:00 UTC → 剩余 6h
    expect(getRemainingHours('2026-07-11 15:00', nowMs)).toBeCloseTo(6, 5);
  });
});

describe('isRenewalDue', () => {
  it('仅日期：今天或明天到期返回 true', () => {
    expect(isRenewalDue('2026-07-11', '2026-07-11', '2026-07-12')).toBe(true);
    expect(isRenewalDue('2026-07-12', '2026-07-11', '2026-07-12')).toBe(true);
  });

  it('仅日期：其他日期返回 false', () => {
    expect(isRenewalDue('2026-07-20', '2026-07-11', '2026-07-12')).toBe(false);
  });

  it('空值返回 false', () => {
    expect(isRenewalDue(null, '2026-07-11', '2026-07-12')).toBe(false);
    expect(isRenewalDue('', '2026-07-11', '2026-07-12')).toBe(false);
  });

  it('允许首尾空白', () => {
    expect(isRenewalDue(' 2026-07-11 ', '2026-07-11', '2026-07-12')).toBe(true);
  });

  it('含时间：剩余 ≤12h 返回 true', () => {
    // now = 2026-07-11 10:00 JST = 01:00 UTC；expire 20:00 JST → 剩余 10h
    const nowMs = Date.UTC(2026, 6, 11, 1, 0, 0);
    expect(
      isRenewalDue('2026-07-11 20:00', '2026-07-11', '2026-07-12', { nowMs }),
    ).toBe(true);
  });

  it('含时间：剩余 >12h 返回 false', () => {
    // now = 2026-07-11 06:00 JST = 2026-07-10 21:00 UTC；expire 20:00 JST → 剩余 14h
    const nowMs = Date.UTC(2026, 6, 10, 21, 0, 0);
    expect(
      isRenewalDue('2026-07-11 20:00', '2026-07-11', '2026-07-12', { nowMs }),
    ).toBe(false);
  });

  it('含时间：略过期在宽限内仍可续', () => {
    // expire 10:00 JST，now 10:30 JST → 剩余 -0.5h
    const nowMs = Date.UTC(2026, 6, 11, 1, 30, 0);
    expect(
      isRenewalDue('2026-07-11 10:00', '2026-07-11', '2026-07-12', { nowMs }),
    ).toBe(true);
  });
});

describe('buildRenewUrl', () => {
  const origin = 'https://secure.xserver.ne.jp';

  it('从详情链接生成续期 URL', () => {
    const detail = `${origin}/xapanel/xvps/server/detail?id=12345`;
    expect(buildRenewUrl(detail, origin)).toBe(
      `${origin}/xapanel/xvps/server/freevps/extend/index?id_vps=12345`,
    );
  });

  it('空链接抛错', () => {
    expect(() => buildRenewUrl('', origin)).toThrow(/未找到续期链接/);
  });

  it('origin 不匹配抛错', () => {
    expect(() => buildRenewUrl('https://evil.example/detail?id=1', origin)).toThrow(/来源异常/);
  });

  it('非法 URL 抛错', () => {
    expect(() => buildRenewUrl('not-a-url', origin)).toThrow(/格式异常/);
  });
});

describe('resolveCaptchaRetryUrl', () => {
  it('conf 页原样返回', () => {
    const url = 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/conf';
    expect(resolveCaptchaRetryUrl(url)).toBe(url);
  });

  it('/do 替换为 /conf', () => {
    expect(resolveCaptchaRetryUrl('https://example.com/extend/do')).toBe(
      'https://example.com/extend/conf',
    );
  });

  it('空值返回空字符串', () => {
    expect(resolveCaptchaRetryUrl('')).toBe('');
    expect(resolveCaptchaRetryUrl(null)).toBe('');
  });
});

describe('evaluateSubmissionResult', () => {
  it('仍在 conf 页 → retry', () => {
    const r = evaluateSubmissionResult('何か', 'https://x/conf');
    expect(r.status).toBe('retry');
  });

  it('conf 页含认证失败 → retry 且匹配', () => {
    const r = evaluateSubmissionResult('認証に失敗しました', 'https://x/conf');
    expect(r.status).toBe('retry');
    expect(r.matched).toBe('認証に失敗');
  });

  it('明确失败关键词 → retry', () => {
    const r = evaluateSubmissionResult('失敗しました', 'https://x/do');
    expect(r.status).toBe('retry');
    expect(r.matched).toBe('失敗しました');
  });

  it('其他错误 → fail', () => {
    const r = evaluateSubmissionResult('エラーが発生しました', 'https://x/do');
    // 失敗/エラーが発生 优先于 エラー
    expect(r.status).toBe('retry');
  });

  it('仅 エラー 时 → fail', () => {
    const r = evaluateSubmissionResult('システムエラー', 'https://x/do');
    expect(r.status).toBe('fail');
  });

  it('成功关键词 → success', () => {
    const r = evaluateSubmissionResult('手続きが完了しました', 'https://x/do');
    expect(r.status).toBe('success');
    expect(r.matched).toBe('手続きが完了');
  });

  it('信用卡相关 → fail 业务原因', () => {
    const r = evaluateSubmissionResult('クレジットカードの登録が必要', 'https://x/do');
    expect(r.status).toBe('fail');
    expect(r.reason).toContain('信用卡');
  });

  it('无明确标识 → fail 不明确', () => {
    const r = evaluateSubmissionResult('hello world', 'https://x/do');
    expect(r.status).toBe('fail');
    expect(r.reason).toContain('不明确');
  });
});

describe('extractExpireDateFromText', () => {
  it('提取最后一个 ISO 日期', () => {
    expect(extractExpireDateFromText('旧 2026-06-01 新 2026-07-31')).toBe('2026-07-31');
  });

  it('提取日本格式日期', () => {
    expect(extractExpireDateFromText('期限は2026年7月5日です')).toBe('2026-07-05');
  });

  it('无日期返回 null', () => {
    expect(extractExpireDateFromText('no date here')).toBeNull();
    expect(extractExpireDateFromText('')).toBeNull();
  });
});

describe('normalizeCellText', () => {
  it('压缩空白', () => {
    expect(normalizeCellText('  a \n b  ')).toBe('a b');
  });

  it('空值返回 null', () => {
    expect(normalizeCellText('')).toBeNull();
    expect(normalizeCellText(null)).toBeNull();
  });
});

describe('escapeHtml', () => {
  it('转义特殊字符', () => {
    expect(escapeHtml('<a>&"\'')).toBe('&lt;a&gt;&amp;&quot;&#39;');
  });
});

describe('formatTokyoDateTime', () => {
  it('返回非空字符串', () => {
    expect(formatTokyoDateTime(Date.UTC(2026, 6, 11, 0, 0, 0))).toBeTruthy();
  });
});

describe('parseCronIntervalHours / estimateNextRunMs', () => {
  it('解析 */6 小时 cron', () => {
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
});

describe('buildProxyHint', () => {
  it('有代理时显示脱敏信息', () => {
    expect(buildProxyHint({
      hasProxy: true,
      proxyType: 'socks5',
      maskedAddress: '****.100',
      proxyPort: 1080,
    })).toContain('socks5://****.100:1080');
  });

  it('无代理时给出优化建议', () => {
    expect(buildProxyHint({ hasProxy: false })).toContain('优化建议');
  });
});
