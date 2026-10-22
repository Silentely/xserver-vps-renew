import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  MAINTENANCE_ERROR_CODE,
  MAINTENANCE_ACTION,
  EXIT_MAINTENANCE_RENEWED,
  EXIT_MAINTENANCE_NOTIFIED,
  DEFAULT_MAINTENANCE_HTTP_CODES,
  DEFAULT_MAINTENANCE_KEYWORDS,
  MaintenanceError,
  isMaintenanceError,
  parseMaintenanceHttpCodes,
  parseMaintenanceKeywords,
  matchMaintenanceKeyword,
  detectMaintenance,
  isConnectionMaintenanceSuspect,
  confirmMaintenanceViaMainSite,
  readMaintenanceNotice,
  recordMaintenanceNotice,
  shouldSendMaintenanceNotice,
  formatLocalDateKey,
  resolveMaintenanceOutcome,
} from '../../src/maintenance.mjs';
import { hasRenewedToday, hasTodaySkipCoverage, readRenewalStatus } from '../../src/renewal-status.mjs';
import { navigateToLoginPage } from '../../src/panel-flow.mjs';
import { buildMaintenanceNotifyMessage } from '../../src/notify.mjs';

/** 命中的维护页响应（503 + 关键词） */
function maintenanceResponse({
  status = 503,
  body = '<title>一時停止のお知らせ</title><p>メンテナンス中です</p>',
} = {}) {
  return { status: () => status, text: async () => body };
}

/** 构造最小 Puppeteer page stub */
function pageStub({ hasMemberId = false, url = 'https://secure.xserver.ne.jp/xapanel/login/xvps/' } = {}) {
  return {
    goto: vi.fn(),
    status: () => 503,
    title: vi.fn().mockResolvedValue('Xserver'),
    $: vi.fn().mockResolvedValue(hasMemberId ? { id: 'memberid' } : null),
    url: vi.fn().mockReturnValue(url),
  };
}

/** 命中主站的维护公告响应（可达 + 含维护关键词） */
function flatMaintenance() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '<title>一時停止のお知らせ</title><p>メンテナンス中です</p>',
  });
}

describe('parseMaintenanceHttpCodes', () => {
  it('解析逗号分隔状态码', () => {
    expect(parseMaintenanceHttpCodes('503,502,504')).toEqual([503, 502, 504]);
    expect(parseMaintenanceHttpCodes(' 503 , 500 ')).toEqual([503, 500]);
  });

  it('空值/非法值返回 null 以回退默认', () => {
    expect(parseMaintenanceHttpCodes(undefined)).toBeNull();
    expect(parseMaintenanceHttpCodes('')).toBeNull();
    expect(parseMaintenanceHttpCodes('abc')).toBeNull();
    expect(parseMaintenanceHttpCodes('99,700')).toBeNull();
  });
});

describe('parseMaintenanceKeywords', () => {
  it('解析逗号分隔关键词', () => {
    expect(parseMaintenanceKeywords('メンテナンス,一時停止,保守')).toEqual(['メンテナンス', '一時停止', '保守']);
  });

  it('空值返回 null 以回退默认', () => {
    expect(parseMaintenanceKeywords(undefined)).toBeNull();
    expect(parseMaintenanceKeywords(' , ')).toBeNull();
  });
});

describe('matchMaintenanceKeyword', () => {
  it('命中任一关键词返回该关键词', () => {
    expect(matchMaintenanceKeyword('系统维护中 メンテナンス', DEFAULT_MAINTENANCE_KEYWORDS)).toBe('メンテナンス');
    expect(matchMaintenanceKeyword('サービス一時停止のお知らせ')).toBe('一時停止');
    expect(matchMaintenanceKeyword('保守作業')).toBe('保守');
  });

  it('未命中返回 null', () => {
    expect(matchMaintenanceKeyword('正常登录页')).toBeNull();
    expect(matchMaintenanceKeyword('')).toBeNull();
  });
});

describe('MaintenanceError', () => {
  it('携带专用 code、状态码与命中关键词', () => {
    const error = new MaintenanceError({ status: 503, keyword: 'メンテナンス', pageUrl: 'https://x' });
    expect(error.code).toBe(MAINTENANCE_ERROR_CODE);
    expect(error.status).toBe(503);
    expect(error.keyword).toBe('メンテナンス');
    expect(error.message).toContain('503');
    expect(error.message).toContain('メンテナンス');
    expect(isMaintenanceError(error)).toBe(true);
  });

  it('无关键词时说明靠无登录表单判定', () => {
    const error = new MaintenanceError({ status: 502 });
    expect(error.keyword).toBeNull();
    expect(error.message).toContain('页面无登录表单');
  });

  it('连接层经主站确认：状态为字符串、理由为主站公告、可读无语义错误', () => {
    const error = new MaintenanceError({
      status: 'connection',
      keyword: 'メンテナンス',
      pageUrl: 'https://secure.xserver.ne.jp/xapanel/login/xvps/',
      reason: '主站公告确认维护',
    });
    expect(error.code).toBe(MAINTENANCE_ERROR_CODE);
    expect(error.status).toBe('connection');
    expect(error.keyword).toBe('メンテナンス');
    expect(error.message).toContain('连接层故障');
    expect(error.message).toContain('主站公告确认维护');
  });

  it('普通错误不被识别为维护错误', () => {
    expect(isMaintenanceError(new Error('net::ERR_TIMED_OUT'))).toBe(false);
    expect(isMaintenanceError(null)).toBe(false);
  });
});

describe('detectMaintenance（维护判定）', () => {
  it('503 + 关键词 → 命中维护', async () => {
    const result = await detectMaintenance({ response: maintenanceResponse(), page: pageStub() });
    expect(result).not.toBeNull();
    expect(result.status).toBe(503);
    expect(result.keyword).toBe('メンテナンス');
    expect(isMaintenanceError(result.error)).toBe(true);
  });

  it('503 + 无关键但页面缺 #memberid → 命中维护', async () => {
    const response = maintenanceResponse({ body: 'Service Unavailable' });
    const result = await detectMaintenance({ response, page: pageStub({ hasMemberId: false }) });
    expect(result).not.toBeNull();
    expect(result.keyword).toBeNull();
    expect(result.status).toBe(503);
  });

  it('503 但页面存在 #memberid 且无维护关键词 → 不误判', async () => {
    const response = maintenanceResponse({ body: 'real login page' });
    const result = await detectMaintenance({ response, page: pageStub({ hasMemberId: true }) });
    expect(result).toBeNull();
  });

  it('200 正常登录页（即使含关键词）不触发', async () => {
    const response = maintenanceResponse({ status: 200, body: 'メンテナンス' });
    const result = await detectMaintenance({ response, page: pageStub({ hasMemberId: true }) });
    expect(result).toBeNull();
  });

  it('500（不在维护码内）不触发，走原失败流程', async () => {
    const response = maintenanceResponse({ status: 500 });
    const result = await detectMaintenance({ response, page: pageStub() });
    expect(result).toBeNull();
  });

  it('无响应（导航异常）不触发', async () => {
    expect(await detectMaintenance({ response: null, page: pageStub() })).toBeNull();
    expect(await detectMaintenance({ response: undefined, page: pageStub() })).toBeNull();
  });

  it('支持自定义状态码与关键词', async () => {
    const response = maintenanceResponse({ status: 521, body: 'maintenance window' });
    const hit = await detectMaintenance({
      response,
      page: pageStub({ hasMemberId: true }),
      httpCodes: [521],
      keywords: ['maintenance'],
    });
    expect(hit?.keyword).toBe('maintenance');

    const miss = await detectMaintenance({ response, page: pageStub(), httpCodes: DEFAULT_MAINTENANCE_HTTP_CODES });
    expect(miss).toBeNull();
  });
});

describe('isConnectionMaintenanceSuspect', () => {
  it('命中连接层故障错误判定为疑似维护', () => {
    expect(isConnectionMaintenanceSuspect(new Error('net::ERR_TIMED_OUT'))).toBe(true);
    expect(isConnectionMaintenanceSuspect(new Error('net::ERR_CONNECTION_TIMED_OUT'))).toBe(true);
    expect(isConnectionMaintenanceSuspect('net::ERR_CONNECTION_REFUSED')).toBe(true);
    expect(isConnectionMaintenanceSuspect('net::ERR_NAME_NOT_RESOLVED')).toBe(true);
  });

  it('非连接层错误（HTTP 类/其他网络态）不判为疑似维护', () => {
    expect(isConnectionMaintenanceSuspect(new Error('No element found for selector: #memberid'))).toBe(false);
    expect(isConnectionMaintenanceSuspect('net::ERR_ABORTED')).toBe(false);
    expect(isConnectionMaintenanceSuspect(null)).toBe(false);
    expect(isConnectionMaintenanceSuspect(undefined)).toBe(false);
  });
});

describe('confirmMaintenanceViaMainSite（连接层故障交叉验证）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('主站可达且含维护关键词 → 确认维护', async () => {
    vi.stubGlobal('fetch', flatMaintenance());
    const verdict = await confirmMaintenanceViaMainSite({});
    expect(verdict).toEqual({ confirmed: true, keyword: 'メンテナンス', reason: 'main_site_keyword' });
  });

  it('主站可达但无维护关键词 → 未确认（网络问题）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<p>正常首页</p>' }));
    const verdict = await confirmMaintenanceViaMainSite({});
    expect(verdict.confirmed).toBe(false);
    expect(verdict.reason).toBe('main_site_no_keyword');
  });

  it('主站不可达 → 未确认（本机/代理网络问题）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const verdict = await confirmMaintenanceViaMainSite({});
    expect(verdict.confirmed).toBe(false);
    expect(verdict.reason).toBe('main_site_unreachable');
  });

  it('支持自定义关键词', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'maintenance window' }));
    const verdict = await confirmMaintenanceViaMainSite({ keywords: ['maintenance'] });
    expect(verdict.confirmed).toBe(true);
    expect(verdict.keyword).toBe('maintenance');
  });
});

describe('navigateToLoginPage 维护拦截', () => {
  const baseConfig = {
    BASE_URL: 'https://secure.xserver.ne.jp',
    LOGIN_PATH: '/xapanel/login/xvps/',
    NAVIGATION_TIMEOUT: 1000,
    LOGIN_NAVIGATION_RETRIES: 3,
    LOGIN_NAVIGATION_RETRY_DELAY_MS: 0,
  };
  const silentLogger = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() });

  afterEach(() => vi.unstubAllGlobals());

  it('命中 503 维护时抛 MaintenanceError 且不重试', async () => {
    const page = pageStub();
    page.goto = vi.fn().mockResolvedValue(maintenanceResponse());
    await expect(navigateToLoginPage(page, baseConfig, silentLogger())).rejects.toMatchObject({
      code: MAINTENANCE_ERROR_CODE,
      status: 503,
    });
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('连接层故障 + 主站公告确认维护 → 升级为 MaintenanceError，不继续重试登录', async () => {
    vi.stubGlobal('fetch', flatMaintenance());
    const page = pageStub();
    page.goto = vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
    await expect(navigateToLoginPage(page, baseConfig, silentLogger())).rejects.toMatchObject({
      code: MAINTENANCE_ERROR_CODE,
      status: 'connection',
    });
    // 已确认维护：即使 ERR_CONNECTION_REFUSED 不在原重试列表，也不再继续内层重试
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('连接层故障 + 主站不可达 → 走原失败流程（不降级）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const error = new Error('net::ERR_CONNECTION_REFUSED');
    const page = pageStub();
    page.goto = vi.fn().mockRejectedValue(error);
    await expect(navigateToLoginPage(page, baseConfig, silentLogger())).rejects.toBe(error);
    // ERR_CONNECTION_REFUSED 不在原内层重试列表：直接抛原始错误（由外层 cron 重试）
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('连接层故障（可重试类 ERR_TIMED_OUT）+ 主站未确认 → 按原逻辑重试', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<p>正常首页</p>' }));
    const page = pageStub();
    page.goto = vi
      .fn()
      .mockRejectedValueOnce(new Error('net::ERR_TIMED_OUT'))
      .mockResolvedValueOnce(maintenanceResponse({ status: 200, body: 'ok' }));
    await navigateToLoginPage(page, baseConfig, silentLogger());
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1); // 仅交叉验证一次
  });
});

describe('维护提醒去重持久化', () => {
  const file = join(tmpdir(), `xserver-maint-notice-${process.pid}-${randomUUID()}.json`);
  afterEach(() => rmSync(file, { force: true }));

  it('文件不存在时返回 null', () => {
    expect(readMaintenanceNotice(file).lastMaintenanceNoticeAt).toBeNull();
  });

  it('写入后可读回，且同日判定去重', () => {
    const logger = { warn: vi.fn() };
    expect(recordMaintenanceNotice(file, '2026-10-21', logger)).toBe(true);
    expect(readMaintenanceNotice(file).lastMaintenanceNoticeAt).toBe('2026-10-21');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ lastMaintenanceNoticeAt: '2026-10-21' });

    expect(shouldSendMaintenanceNotice('2026-10-21', '2026-10-21')).toBe(false);
    expect(shouldSendMaintenanceNotice('2026-10-21', '2026-10-22')).toBe(true);
    expect(shouldSendMaintenanceNotice(null, '2026-10-21')).toBe(true);
  });

  it('损坏文件回退为空并告警', () => {
    const logger = { warn: vi.fn() };
    recordMaintenanceNotice(file, '2026-10-21');
    // 覆盖为非法 JSON
    writeFileSync(file, '{ not json');
    expect(readMaintenanceNotice(file, logger).lastMaintenanceNoticeAt).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('formatLocalDateKey（时区）', () => {
  it('UTC 23:xx 在东京为次日 08:xx', () => {
    const now = Date.parse('2026-10-21T23:30:00Z');
    expect(formatLocalDateKey(now, 'Asia/Tokyo')).toBe('2026-10-22');
    expect(formatLocalDateKey(now, 'UTC')).toBe('2026-10-21');
  });
});

describe('hasRenewedToday / hasTodaySkipCoverage（跨时区当日判定）', () => {
  // UTC 2026-10-21 23:30 → 东京 2026-10-22 08:30
  const now = Date.parse('2026-10-21T23:30:00Z');

  it('当日成功续期按东京日期归类', () => {
    const records = [{ timestamp: '2026-10-21T15:00:00Z', success: true, skipped: false, newExpireDate: '2026-10-23' }];
    expect(hasRenewedToday(records, { now, tz: 'Asia/Tokyo' })).toBe(true);
    // 同一记录在 UTC 日期为 10-21，而 UTC 当日也为 10-21，仍命中
    expect(hasRenewedToday(records, { now, tz: 'UTC' })).toBe(true);
  });

  it('东京昨日 23:59 的记录不算当日', () => {
    const records = [{ timestamp: '2026-10-21T14:59:00Z', success: true, skipped: false, newExpireDate: '2026-10-23' }];
    expect(hasRenewedToday(records, { now, tz: 'Asia/Tokyo' })).toBe(false);
  });

  it('缺失 newExpireDate 不算「已续期」（按规格严格判定）', () => {
    const records = [{ timestamp: '2026-10-21T15:00:00Z', success: true, skipped: false, newExpireDate: null }];
    expect(hasRenewedToday(records, { now, tz: 'Asia/Tokyo' })).toBe(false);
  });

  it('skipped 记录不算「已续期」，但可构成「仅有跳过」保障', () => {
    const records = [{ timestamp: '2026-10-21T15:00:00Z', success: true, skipped: true }];
    expect(hasRenewedToday(records, { now, tz: 'Asia/Tokyo' })).toBe(false);
    expect(hasTodaySkipCoverage(records, { now, tz: 'Asia/Tokyo' })).toBe(true);
  });

  it('当日存在失败记录时不算「仅有跳过」', () => {
    const records = [
      { timestamp: '2026-10-21T15:00:00Z', success: true, skipped: true },
      { timestamp: '2026-10-21T16:00:00Z', success: false, skipped: false },
    ];
    expect(hasTodaySkipCoverage(records, { now, tz: 'Asia/Tokyo' })).toBe(false);
  });

  it('官方维护跳过记录不算「无需续期」保障（防止自我满足静默）', () => {
    const records = [{ timestamp: '2026-10-21T15:00:00Z', success: true, skipped: true, maintenance: true }];
    expect(hasTodaySkipCoverage(records, { now, tz: 'Asia/Tokyo' })).toBe(false);
  });

  it('存在正常跳过记录时，混合维护跳过仍算保障', () => {
    const records = [
      { timestamp: '2026-10-21T15:00:00Z', success: true, skipped: true, maintenance: false },
      { timestamp: '2026-10-21T16:00:00Z', success: true, skipped: true, maintenance: true },
    ];
    expect(hasTodaySkipCoverage(records, { now, tz: 'Asia/Tokyo' })).toBe(true);
  });

  it('空/非数组安全返回 false', () => {
    expect(hasRenewedToday([], { now })).toBe(false);
    expect(hasRenewedToday(null, { now })).toBe(false);
    expect(hasTodaySkipCoverage(undefined, { now })).toBe(false);
  });
});

describe('resolveMaintenanceOutcome（验收表格）', () => {
  const todayKeyJst = '2026-10-22';
  // UTC 2026-10-21 23:30 → 东京 2026-10-22 08:30
  const now = Date.parse('2026-10-21T23:30:00Z');
  const tz = 'Asia/Tokyo';

  it('当日已续期成功 + 503 → 静默跳过（exit 75，无通知）', () => {
    const outcome = resolveMaintenanceOutcome({
      records: [{ timestamp: '2026-10-21T15:00:00Z', success: true, skipped: false, newExpireDate: '2026-10-23' }],
      lastMaintenanceNoticeAt: null,
      todayKey: todayKeyJst,
      now,
      tz,
    });
    expect(outcome.action).toBe(MAINTENANCE_ACTION.SILENT_SKIP);
    expect(outcome.exitCode).toBe(EXIT_MAINTENANCE_RENEWED);
    expect(outcome.renewedToday).toBe(true);
  });

  it('当日仅有 skipped（无需续期）→ 静默跳过（边界决策，exit 75）', () => {
    const outcome = resolveMaintenanceOutcome({
      records: [{ timestamp: '2026-10-21T15:00:00Z', success: true, skipped: true }],
      lastMaintenanceNoticeAt: null,
      todayKey: todayKeyJst,
      now,
      tz,
    });
    expect(outcome.action).toBe(MAINTENANCE_ACTION.SILENT_SKIP);
    expect(outcome.exitCode).toBe(EXIT_MAINTENANCE_RENEWED);
    expect(outcome.skipCoveredToday).toBe(true);
  });

  it('当日未续期 + 当日首条 → 发送维护提醒（exit 76）', () => {
    const outcome = resolveMaintenanceOutcome({
      records: [],
      lastMaintenanceNoticeAt: null,
      todayKey: todayKeyJst,
      now,
      tz,
    });
    expect(outcome.action).toBe(MAINTENANCE_ACTION.SEND_NOTICE);
    expect(outcome.exitCode).toBe(EXIT_MAINTENANCE_NOTIFIED);
  });

  it('当日未续期 + 今日已发过 → 去重不再发（exit 76）', () => {
    const outcome = resolveMaintenanceOutcome({
      records: [],
      lastMaintenanceNoticeAt: todayKeyJst,
      todayKey: todayKeyJst,
      now,
      tz,
    });
    expect(outcome.action).toBe(MAINTENANCE_ACTION.DEDUP_SKIP);
    expect(outcome.exitCode).toBe(EXIT_MAINTENANCE_NOTIFIED);
  });

  it('次日仍维护且未续期 → 允许再次发送提醒', () => {
    const outcome = resolveMaintenanceOutcome({
      records: [],
      lastMaintenanceNoticeAt: '2026-10-21',
      todayKey: '2026-10-22',
      now,
      tz,
    });
    expect(outcome.action).toBe(MAINTENANCE_ACTION.SEND_NOTICE);
  });

  it('当日仅失败记录 → 不视为已保障，发送提醒', () => {
    const outcome = resolveMaintenanceOutcome({
      records: [{ timestamp: '2026-10-21T15:00:00Z', success: false, skipped: false }],
      lastMaintenanceNoticeAt: null,
      todayKey: todayKeyJst,
      now,
      tz,
    });
    expect(outcome.action).toBe(MAINTENANCE_ACTION.SEND_NOTICE);
  });

  it('当日仅有维护跳过记录（未续期）→ 不被误判为已保障', () => {
    const records = [{ timestamp: '2026-10-21T15:00:00Z', success: true, skipped: true, maintenance: true }];
    const first = resolveMaintenanceOutcome({
      records,
      lastMaintenanceNoticeAt: null,
      todayKey: todayKeyJst,
      now,
      tz,
    });
    expect(first.action).toBe(MAINTENANCE_ACTION.SEND_NOTICE);
    expect(first.skipCoveredToday).toBe(false);

    const second = resolveMaintenanceOutcome({
      records,
      lastMaintenanceNoticeAt: todayKeyJst,
      todayKey: todayKeyJst,
      now,
      tz,
    });
    expect(second.action).toBe(MAINTENANCE_ACTION.DEDUP_SKIP);
  });
});

describe('mock 状态文件端到端（验收表格）', () => {
  const silent = { warn: () => {}, error: () => {}, info: () => {} };
  const statusFile = join(tmpdir(), `xserver-maint-status-${process.pid}-${randomUUID()}.json`);
  const noticeFile = join(tmpdir(), `xserver-maint-notice-e2e-${process.pid}-${randomUUID()}.json`);
  // UTC 2026-10-21 23:30 → 东京 2026-10-22 08:30
  const now = Date.parse('2026-10-21T23:30:00Z');
  const tz = 'Asia/Tokyo';
  const todayKey = '2026-10-22';
  const writeRecords = (records) => writeFileSync(statusFile, JSON.stringify({ successStreak: 3, records }, null, 2));

  afterEach(() => {
    rmSync(statusFile, { force: true });
    rmSync(noticeFile, { force: true });
  });

  const decide = () => {
    const { records } = readRenewalStatus(statusFile, silent);
    const { lastMaintenanceNoticeAt } = readMaintenanceNotice(noticeFile, silent);
    return resolveMaintenanceOutcome({
      records,
      lastMaintenanceNoticeAt,
      todayKey: formatLocalDateKey(now, tz),
      now,
      tz,
    });
  };

  it('状态文件记录当日已续期成功 → 静默跳过', () => {
    writeRecords([{ timestamp: '2026-10-21T15:00:00Z', success: true, skipped: false, newExpireDate: '2026-10-23' }]);
    expect(decide().action).toBe(MAINTENANCE_ACTION.SILENT_SKIP);
    expect(decide().exitCode).toBe(EXIT_MAINTENANCE_RENEWED);
  });

  it('状态文件仅有当日 skipped 记录 → 静默跳过', () => {
    writeRecords([{ timestamp: '2026-10-21T15:00:00Z', success: true, skipped: true, errorMessage: '无需续期' }]);
    expect(decide().action).toBe(MAINTENANCE_ACTION.SILENT_SKIP);
  });

  it('状态文件仅有当日维护跳过记录（未续期）→ 仍发送提醒', () => {
    writeRecords([
      { timestamp: '2026-10-21T15:00:00Z', success: true, skipped: true, maintenance: true, errorMessage: '官方维护' },
    ]);
    expect(decide().action).toBe(MAINTENANCE_ACTION.SEND_NOTICE);
  });

  it('状态文件当日未续期 → 首次发送提醒，同日再次命中则去重', () => {
    writeRecords([{ timestamp: '2026-10-20T15:00:00Z', success: true, skipped: false, newExpireDate: '2026-10-21' }]);
    expect(decide().action).toBe(MAINTENANCE_ACTION.SEND_NOTICE);

    // 模拟主流程发送后写入去重记录
    recordMaintenanceNotice(noticeFile, todayKey);
    expect(decide().action).toBe(MAINTENANCE_ACTION.DEDUP_SKIP);
  });

  it('次日（本地时区）仍维护且未续期 → 允许再次提醒', () => {
    writeRecords([{ timestamp: '2026-10-21T15:00:00Z', success: true, skipped: true }]);
    recordMaintenanceNotice(noticeFile, '2026-10-21');
    // 东京次日 2026-10-23 08:30
    const nextDay = Date.parse('2026-10-22T23:30:00Z');
    const { records } = readRenewalStatus(statusFile, silent);
    const outcome = resolveMaintenanceOutcome({
      records,
      lastMaintenanceNoticeAt: readMaintenanceNotice(noticeFile, silent).lastMaintenanceNoticeAt,
      todayKey: formatLocalDateKey(nextDay, tz),
      now: nextDay,
      tz,
    });
    expect(outcome.action).toBe(MAINTENANCE_ACTION.SEND_NOTICE);
  });
});

describe('buildMaintenanceNotifyMessage', () => {
  it('包含维护原因、到期日、风险提示、下次执行与自动重试说明', () => {
    const text = buildMaintenanceNotifyMessage({
      executedAt: '2026-10-21 16:27:00',
      expireDate: '2026-10-22',
      nextRunAt: '2026-10-21 20:27:00',
      serverName: 'host02-23',
    });
    expect(text).toContain('官方维护');
    expect(text).toContain('503');
    expect(text).toContain('2026-10-22');
    expect(text).toContain('风险');
    expect(text).toContain('请在官方维护结束后及时续期');
    expect(text).toContain('下个周期自动重试');
    expect(text).toContain('2026-10-21 20:27:00');
    expect(text).toContain('host02-23');

    // 连接层经主站确认的维护：标题标注「连接层故障」而非 HTTP 503
    const connText = buildMaintenanceNotifyMessage({
      executedAt: '2026-10-22 00:30:00',
      expireDate: '2026-10-23',
      nextRunAt: '2026-10-22 04:30:00',
      statusLabel: '连接层故障',
    });
    expect(connText).toContain('连接层故障');
    expect(connText).not.toContain('HTTP 503');
  });
});
