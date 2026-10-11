import { describe, expect, it } from 'vitest';
import {
  buildKnownVpsInfo,
  buildMissingVpsWarning,
  resolveEscalation,
  resolveOutcomeIcon,
  resolveSkipOutcome,
} from '../../src/main-logic.mjs';

describe('buildKnownVpsInfo', () => {
  it('本轮提取到完整 VPS 信息时按字段归一化返回', () => {
    expect(
      buildKnownVpsInfo(
        { vpsInfo: { serverName: 'vps-1', plan: '4GB', expireDate: '2026-10-11' }, remainingHours: 3.5 },
        null,
      ),
    ).toEqual({
      serverName: 'vps-1',
      plan: '4GB',
      expireDate: '2026-10-11',
      remainingHours: 3.5,
    });
  });

  it('字段不全时缺失项回落为 null，剩余 0 小时保持为 0', () => {
    expect(buildKnownVpsInfo({ vpsInfo: { serverName: 'vps-1' }, remainingHours: 0 }, null)).toEqual({
      serverName: 'vps-1',
      plan: null,
      expireDate: null,
      remainingHours: 0,
    });
    expect(buildKnownVpsInfo({ vpsInfo: { plan: '4GBメモリ' } }, null)).toEqual({
      serverName: null,
      plan: '4GBメモリ',
      expireDate: null,
      remainingHours: null,
    });
  });

  it('本轮未提取到信息时回退历史记录，新到期日优先于旧到期日', () => {
    expect(
      buildKnownVpsInfo(
        { vpsInfo: { serverName: null, plan: null, expireDate: null }, remainingHours: null },
        { serverName: 'vps-old', plan: '2GB', oldExpireDate: '2026-09-01', newExpireDate: '2026-10-01' },
      ),
    ).toEqual({
      serverName: 'vps-old',
      plan: '2GB',
      expireDate: '2026-10-01',
      remainingHours: null,
    });
  });

  it('历史记录仅有旧到期日时回退旧到期日', () => {
    expect(buildKnownVpsInfo({}, { serverName: 'vps-old', oldExpireDate: '2026-09-01' })).toEqual({
      serverName: 'vps-old',
      plan: null,
      expireDate: '2026-09-01',
      remainingHours: null,
    });
  });

  it('本轮与历史均无信息时返回空上下文', () => {
    const empty = { serverName: null, plan: null, expireDate: null, remainingHours: null };
    expect(buildKnownVpsInfo(null, null)).toEqual(empty);
    expect(buildKnownVpsInfo({ vpsInfo: null }, {})).toEqual(empty);
  });
});

describe('resolveSkipOutcome', () => {
  it('官方确认页拦截时转人工确认出口', () => {
    expect(resolveSkipOutcome({ reasonCode: 'no_free_vps', needsManualConfirmation: true })).toEqual({
      kind: 'manual_confirm',
      missingKnownVps: false,
    });
  });

  it('not_due 归入普通跳过并给出「无需续期」标签', () => {
    const out = resolveSkipOutcome({ reasonCode: 'not_due', baseReasonDetail: '剩余约 13.1h' });
    expect(out.kind).toBe('skip');
    expect(out.skipLabel).toBe('无需续期');
    expect(out.reasonDetail).toBe('剩余约 13.1h');
    expect(out.missingKnownVps).toBe(false);
  });

  it('window_blocked 同样归入「无需续期」标签', () => {
    expect(resolveSkipOutcome({ reasonCode: 'window_blocked', baseReasonDetail: '窗口未开' }).skipLabel).toBe(
      '无需续期',
    );
  });

  it('no_free_vps 且历史存在已知 VPS 时标记缺失并追加提示', () => {
    const out = resolveSkipOutcome({
      reasonCode: 'no_free_vps',
      prevLastRecord: { serverName: 'vps-old' },
      baseReasonDetail: '面板中未找到带免费标识的 VPS 条目',
    });
    expect(out.skipLabel).toBe('未找到免费 VPS');
    expect(out.missingKnownVps).toBe(true);
    expect(out.reasonDetail).toBe('面板中未找到带免费标识的 VPS 条目（注意：历史记录曾存在 vps-old）');
  });

  it('no_free_vps 但历史无服务器名时不标记缺失', () => {
    const out = resolveSkipOutcome({
      reasonCode: 'no_free_vps',
      prevLastRecord: { plan: '4GB' },
      baseReasonDetail: '无条目',
    });
    expect(out.missingKnownVps).toBe(false);
    expect(out.reasonDetail).toBe('无条目');
  });
});

describe('buildMissingVpsWarning', () => {
  it('包含服务器名与核实指引', () => {
    const text = buildMissingVpsWarning('vps-12345');
    expect(text).toContain('历史记录中存在已知 VPS (vps-12345)');
    expect(text).toContain('本次未检测到免费 VPS');
    expect(text).toContain('官方改版');
  });
});

describe('resolveEscalation', () => {
  it('连续失败达到或超过阈值时升级', () => {
    expect(resolveEscalation({ consecutiveFailures: 3, threshold: 3 })).toBe(true);
    expect(resolveEscalation({ consecutiveFailures: 4, threshold: 3 })).toBe(true);
  });

  it('连续失败未达阈值时不升级', () => {
    expect(resolveEscalation({ consecutiveFailures: 2, threshold: 3 })).toBe(false);
    expect(resolveEscalation({ consecutiveFailures: 0, threshold: 1 })).toBe(false);
  });

  it('Turnstile 全平台熔断时立即升级', () => {
    expect(
      resolveEscalation({
        consecutiveFailures: 0,
        threshold: 3,
        turnstileAllProvidersFailed: true,
      }),
    ).toBe(true);
  });
});

describe('resolveOutcomeIcon', () => {
  it('按结局返回图标', () => {
    expect(resolveOutcomeIcon('success')).toBe('✅');
    expect(resolveOutcomeIcon('skip')).toBe('ℹ️');
    expect(resolveOutcomeIcon('failure')).toBe('❌');
  });

  it('未完成等其余结局返回告警图标', () => {
    expect(resolveOutcomeIcon('aborted')).toBe('⚠️');
    expect(resolveOutcomeIcon(undefined)).toBe('⚠️');
  });
});
