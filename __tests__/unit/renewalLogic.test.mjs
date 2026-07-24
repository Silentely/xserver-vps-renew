import { describe, it, expect } from 'vitest';
import {
  isRenewalDue,
  parseExpireTimestamp,
  getRemainingHours,
  buildRenewUrl,
  resolveCaptchaRetryUrl,
  evaluateSubmissionResult,
  detectRenewalWindowBlocked,
  extractRetryAfterFromText,
  extractExpireDateFromText,
  normalizeCellText,
  escapeHtml,
  formatTokyoDateTime,
  resolveNextRunAt,
  estimateNextRunMs,
  parseCronIntervalHours,
  buildSuccessNotifyMessage,
  buildSkipNotifyMessage,
  buildFailureNotifyMessage,
  buildProxyHint,
  formatRemainingHours,
  formatProcessSteps,
  parseNotifyDetail,
  isFullNotifyDetail,
  isTurnstileAllProvidersFailed,
  FREE_VPS_MAX_HOURS,
  RENEWAL_WINDOW_HOURS,
  DEFAULT_NEXT_RUN_INTERVAL_HOURS,
  TG_NOTIFY_DETAIL_FULL,
  TG_NOTIFY_DETAIL_COMPACT,
  DEFAULT_TG_NOTIFY_DETAIL,
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
  it('仅日期：今天到期且剩余 ≤12h（日末估算）返回 true', () => {
    // 2026-07-11 20:00 JST = 11:00 UTC；到期日末 23:59:59 JST → 剩余约 4h
    const nowMs = Date.UTC(2026, 6, 11, 11, 0, 0);
    expect(
      isRenewalDue('2026-07-11', '2026-07-11', '2026-07-12', { nowMs }),
    ).toBe(true);
  });

  it('仅日期：明天到期剩余 >12h 返回 false（#5 回归：勿误入续期）', () => {
    // 2026-07-23 00:56 JST = 2026-07-22 15:56 UTC；到期 2026-07-24 日末 → 剩余约 47h
    const nowMs = Date.UTC(2026, 6, 22, 15, 56, 0);
    expect(
      isRenewalDue('2026-07-24', '2026-07-23', '2026-07-24', { nowMs }),
    ).toBe(false);
  });

  it('仅日期：今天到期但上午（剩余 >12h）返回 false', () => {
    // 2026-07-11 06:00 JST = 2026-07-10 21:00 UTC；到期日末 → 剩余约 18h
    const nowMs = Date.UTC(2026, 6, 10, 21, 0, 0);
    expect(
      isRenewalDue('2026-07-11', '2026-07-11', '2026-07-12', { nowMs }),
    ).toBe(false);
  });

  it('仅日期：其他日期返回 false', () => {
    const nowMs = Date.UTC(2026, 6, 11, 1, 0, 0);
    expect(
      isRenewalDue('2026-07-20', '2026-07-11', '2026-07-12', { nowMs }),
    ).toBe(false);
  });

  it('空值返回 false', () => {
    expect(isRenewalDue(null, '2026-07-11', '2026-07-12')).toBe(false);
    expect(isRenewalDue('', '2026-07-11', '2026-07-12')).toBe(false);
  });

  it('允许首尾空白', () => {
    // 2026-07-11 20:00 JST，到期日末 → 可续
    const nowMs = Date.UTC(2026, 6, 11, 11, 0, 0);
    expect(
      isRenewalDue(' 2026-07-11 ', '2026-07-11', '2026-07-12', { nowMs }),
    ).toBe(true);
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

  it('日本格式纯日期：明天到期不可续', () => {
    const nowMs = Date.UTC(2026, 6, 22, 15, 56, 0); // 2026-07-23 00:56 JST
    expect(
      isRenewalDue('2026年7月24日', '2026-07-23', '2026-07-24', { nowMs }),
    ).toBe(false);
  });
});

describe('detectRenewalWindowBlocked / extractRetryAfterFromText', () => {
  // issue #5 用户原文（URL: .../freevps/extend/conf）
  const officialBlockedText = [
    '無料VPS)契約更新',
    '利用期限の12時間前から更新手続きが可能です。',
    '利用を継続される場合は、2026年7月24日12：00以降にお試しください。',
    '戻る',
  ].join('\n');

  // 实机 2026-07-23 conf 页（半角冒号 + 空格）
  const liveConfText =
    '無料VPSの契約更新 利用期限の12時間前から更新手続きが可能です。 利用を継続される場合は、2026年7月25日 12:00以降にお試しください。 戻る';

  // 实机 index 页：说明 + 继续按钮文案仍在
  const liveIndexText =
    '無料VPSの契約更新 利用期限の12時間前から更新手続きが可能です。 利用を継続される場合は、2026年7月25日 12:00以降にお試しください。 引き続き無料VPSの利用を継続する 戻る';

  it('识别官方 12 小时窗口拦截页（issue #5）', () => {
    const r = detectRenewalWindowBlocked(
      officialBlockedText,
      'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/conf',
    );
    expect(r.blocked).toBe(true);
    expect(r.matched).toBe('以降にお試し');
    expect(r.retryAfter).toBe('2026-07-24 12:00');
    expect(r.reason).toMatch(/12h|12/);
    expect(r.reason).toMatch(/2026-07-24 12:00/);
  });

  it('识别实机 conf 纯拦截页文案', () => {
    const r = detectRenewalWindowBlocked(
      liveConfText,
      'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/conf',
    );
    expect(r.blocked).toBe(true);
    expect(r.retryAfter).toBe('2026-07-25 12:00');
  });

  it('识别实机 index 页「未开窗」说明（即使仍有继续按钮文案）', () => {
    const r = detectRenewalWindowBlocked(
      liveIndexText,
      'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/index?id_vps=1',
    );
    expect(r.blocked).toBe(true);
    expect(r.retryAfter).toBe('2026-07-25 12:00');
  });

  it('仅政策脚注「12時間前」不误拦', () => {
    const policyOnly =
      '無料VPSは、1日ごとに契約を更新する必要があります。利用期限の12時間前から更新手続きが可能です。';
    expect(detectRenewalWindowBlocked(policyOnly).blocked).toBe(false);
  });

  it('普通验证码页不误判', () => {
    const captchaText = '画像認証\n上の画像に表示されている文字を入力してください\n送信';
    const r = detectRenewalWindowBlocked(captchaText, 'https://x/conf');
    expect(r.blocked).toBe(false);
    expect(r.retryAfter).toBeNull();
  });

  it('空文本不拦截', () => {
    expect(detectRenewalWindowBlocked('').blocked).toBe(false);
    expect(detectRenewalWindowBlocked(null).blocked).toBe(false);
  });

  it('extractRetryAfterFromText 支持全角冒号、空格与 ISO', () => {
    expect(extractRetryAfterFromText('2026年7月24日12：00以降')).toBe('2026-07-24 12:00');
    expect(extractRetryAfterFromText('2026年7月25日 12:00以降')).toBe('2026-07-25 12:00');
    expect(extractRetryAfterFromText('请于 2026-07-24 12:00 之后')).toBe('2026-07-24 12:00');
    expect(extractRetryAfterFromText('无时间')).toBeNull();
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
    expect(msg).toContain('剩余≤12h 可续');
    expect(msg).toContain('执行过程');
    expect(msg).toContain('1. 登录成功');
  });

  it('compact 保留关键状态，省略规格、判定详情与过程', () => {
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
