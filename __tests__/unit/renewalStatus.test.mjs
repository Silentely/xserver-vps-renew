import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock node:fs 模块
const mockFs = {
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  accessSync: vi.fn(),
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { W_OK: 2 },
};
vi.mock('node:fs', () => mockFs);

const {
  buildRenewalRecord,
  countConsecutiveFailures,
  countConsecutiveSuccesses,
  nextSuccessStreak,
  readRenewalStatus,
  writeRenewalStatus,
  getRenewalStatus,
} = await import('../../src/renewal-status.mjs');

const TEST_FILE = '/tmp/test-renewal-status.json';

describe('buildRenewalRecord', () => {
  it('构建成功记录', () => {
    const record = buildRenewalRecord({
      success: true,
      serverName: 'test-vps',
      plan: '1GB',
      oldExpireDate: '2026-07-01',
      newExpireDate: '2026-07-31',
    });
    expect(record.success).toBe(true);
    expect(record.skipped).toBe(false);
    expect(record.serverName).toBe('test-vps');
    expect(record.plan).toBe('1GB');
    expect(record.oldExpireDate).toBe('2026-07-01');
    expect(record.newExpireDate).toBe('2026-07-31');
    expect(record.errorMessage).toBeNull();
    expect(record.timestamp).toBeDefined();
  });

  it('构建失败记录', () => {
    const record = buildRenewalRecord({
      success: false,
      errorMessage: '验证码识别失败',
    });
    expect(record.success).toBe(false);
    expect(record.errorMessage).toBe('验证码识别失败');
    expect(record.serverName).toBeNull();
    expect(record.newExpireDate).toBeNull();
  });

  it('构建跳过记录', () => {
    const record = buildRenewalRecord({
      success: true,
      skipped: true,
      errorMessage: '无需续期',
    });
    expect(record.success).toBe(true);
    expect(record.skipped).toBe(true);
    expect(record.errorMessage).toBe('无需续期');
  });

  it('缺失字段使用默认值 null', () => {
    const record = buildRenewalRecord({ success: true });
    expect(record.serverName).toBeNull();
    expect(record.plan).toBeNull();
    expect(record.oldExpireDate).toBeNull();
    expect(record.newExpireDate).toBeNull();
    expect(record.errorMessage).toBeNull();
    expect(record.skipped).toBe(false);
  });

  it('每次调用生成不同的 timestamp', async () => {
    const r1 = buildRenewalRecord({ success: true });
    await new Promise((r) => setTimeout(r, 10));
    const r2 = buildRenewalRecord({ success: true });
    expect(r1.timestamp).not.toBe(r2.timestamp);
  });
});

describe('countConsecutiveFailures', () => {
  it('空记录返回 0', () => {
    expect(countConsecutiveFailures([])).toBe(0);
  });

  it('非数组返回 0', () => {
    expect(countConsecutiveFailures(null)).toBe(0);
    expect(countConsecutiveFailures(undefined)).toBe(0);
  });

  it('从尾部统计连续失败', () => {
    const records = [
      { success: true },
      { success: false },
      { success: false },
      { success: false },
    ];
    expect(countConsecutiveFailures(records)).toBe(3);
  });

  it('最新记录成功时返回 0', () => {
    const records = [
      { success: false },
      { success: false },
      { success: true },
    ];
    expect(countConsecutiveFailures(records)).toBe(0);
  });

  it('全部失败时返回总数', () => {
    const records = [
      { success: false },
      { success: false },
      { success: false },
    ];
    expect(countConsecutiveFailures(records)).toBe(3);
  });

  it('全部成功时返回 0', () => {
    const records = [
      { success: true },
      { success: true },
    ];
    expect(countConsecutiveFailures(records)).toBe(0);
  });

  it('中间有成功但尾部是失败', () => {
    const records = [
      { success: false },
      { success: true },
      { success: false },
      { success: false },
    ];
    expect(countConsecutiveFailures(records)).toBe(2);
  });

  it('跳过记录不计入连续失败', () => {
    const records = [
      { success: false },
      { success: false },
      { success: true, skipped: true },
    ];
    expect(countConsecutiveFailures(records)).toBe(2);
  });

  it('跳过记录夹在失败之间不中断连败统计', () => {
    const records = [
      { success: false },
      { success: true, skipped: true },
      { success: false },
    ];
    expect(countConsecutiveFailures(records)).toBe(2);
  });
});

describe('countConsecutiveSuccesses', () => {
  it('空记录返回 0', () => {
    expect(countConsecutiveSuccesses([])).toBe(0);
    expect(countConsecutiveSuccesses(null)).toBe(0);
  });

  it('从尾部统计连续成功', () => {
    const records = [
      { success: false },
      { success: true },
      { success: true },
    ];
    expect(countConsecutiveSuccesses(records)).toBe(2);
  });

  it('最新记录失败时返回 0', () => {
    const records = [
      { success: true },
      { success: true },
      { success: false },
    ];
    expect(countConsecutiveSuccesses(records)).toBe(0);
  });

  it('跳过记录不计入也不中断连成功', () => {
    const records = [
      { success: false },
      { success: true, skipped: true },
      { success: true },
    ];
    expect(countConsecutiveSuccesses(records)).toBe(1);
  });
});

describe('nextSuccessStreak', () => {
  it('成功记录在当前计数上 +1', () => {
    expect(nextSuccessStreak(5, { success: true })).toBe(6);
    expect(nextSuccessStreak(0, { success: true })).toBe(1);
  });

  it('失败记录清零', () => {
    expect(nextSuccessStreak(12, { success: false })).toBe(0);
  });

  it('跳过记录不计数也不中断', () => {
    expect(nextSuccessStreak(7, { success: true, skipped: true })).toBe(7);
    expect(nextSuccessStreak(0, { success: true, skipped: true })).toBe(0);
  });

  it('当前计数非法或记录缺失时按 0 兜底', () => {
    expect(nextSuccessStreak(undefined, { success: true })).toBe(1);
    expect(nextSuccessStreak(-3, { success: true })).toBe(1);
    expect(nextSuccessStreak('5', { success: true })).toBe(1);
    expect(nextSuccessStreak(4, null)).toBe(4);
  });
});

describe('readRenewalStatus', () => {
  beforeEach(() => {
    mockFs.readFileSync.mockReset();
  });

  it('读取有效 JSON 返回 records 和 lastRecord', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      records: [
        { timestamp: '2026-06-30', success: true },
        { timestamp: '2026-06-29', success: false },
      ],
    }));
    const result = readRenewalStatus(TEST_FILE);
    expect(result.records).toHaveLength(2);
    expect(result.lastRecord.success).toBe(false);
  });

  it('文件不存在时返回空状态', () => {
    const error = new Error('ENOENT: no such file');
    error.code = 'ENOENT';
    mockFs.readFileSync.mockImplementation(() => { throw error; });
    const result = readRenewalStatus(TEST_FILE);
    expect(result.records).toEqual([]);
    expect(result.lastRecord).toBeNull();
  });

  it('JSON 解析失败时返回空状态', () => {
    mockFs.readFileSync.mockReturnValue('not valid json');
    const result = readRenewalStatus(TEST_FILE);
    expect(result.records).toEqual([]);
    expect(result.lastRecord).toBeNull();
  });

  it('解析失败时经注入 logger 输出警告', () => {
    mockFs.readFileSync.mockReturnValue('not valid json');
    const logger = { warn: vi.fn(), error: vi.fn() };
    readRenewalStatus(TEST_FILE, logger);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).toContain('读取状态文件异常');
  });

  it('records 非数组时返回空状态', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ records: 'invalid' }));
    const result = readRenewalStatus(TEST_FILE);
    expect(result.records).toEqual([]);
    expect(result.lastRecord).toBeNull();
  });

  it('空 records 数组时 lastRecord 为 null', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ records: [] }));
    const result = readRenewalStatus(TEST_FILE);
    expect(result.records).toEqual([]);
    expect(result.lastRecord).toBeNull();
  });

  it('文件权限不足时返回空状态', () => {
    const error = new Error('EACCES: permission denied');
    error.code = 'EACCES';
    mockFs.readFileSync.mockImplementation(() => { throw error; });
    const result = readRenewalStatus('/root/forbidden.json');
    expect(result.records).toEqual([]);
    expect(result.lastRecord).toBeNull();
  });

  it('文件内容为空字符串时返回空状态', () => {
    mockFs.readFileSync.mockReturnValue('');
    const result = readRenewalStatus(TEST_FILE);
    expect(result.records).toEqual([]);
    expect(result.lastRecord).toBeNull();
    expect(result.successStreak).toBe(0);
  });

  it('优先返回持久化的 successStreak', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      successStreak: 42,
      records: [{ success: true }, { success: true }],
    }));
    const result = readRenewalStatus(TEST_FILE);
    expect(result.successStreak).toBe(42);
  });

  it('旧格式文件无 successStreak 时按记录回退统计', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      records: [
        { success: false },
        { success: true, skipped: true },
        { success: true },
        { success: true },
      ],
    }));
    const result = readRenewalStatus(TEST_FILE);
    expect(result.successStreak).toBe(2);
  });

  it('successStreak 非法时回退按记录统计', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      successStreak: -1,
      records: [{ success: true }, { success: true }, { success: true }],
    }));
    expect(readRenewalStatus(TEST_FILE).successStreak).toBe(3);

    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      successStreak: '5',
      records: [{ success: true }],
    }));
    expect(readRenewalStatus(TEST_FILE).successStreak).toBe(1);
  });
});

describe('writeRenewalStatus', () => {
  beforeEach(() => {
    mockFs.readFileSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
    mockFs.renameSync.mockReset();
    mockFs.accessSync.mockReset();
    mockFs.accessSync.mockImplementation(() => undefined);
  });

  it('追加新记录并写入文件', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ records: [] }));
    const record = buildRenewalRecord({ success: true, serverName: 'vps1' });

    writeRenewalStatus(record, TEST_FILE);

    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(mockFs.accessSync).toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(mockFs.renameSync).toHaveBeenCalledTimes(1);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.records).toHaveLength(1);
    expect(written.records[0].serverName).toBe('vps1');
  });

  it('保留历史记录并追加新记录', () => {
    const existing = [
      { timestamp: '2026-06-28', success: true },
      { timestamp: '2026-06-29', success: false },
    ];
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ records: existing }));
    const record = buildRenewalRecord({ success: true });

    writeRenewalStatus(record, TEST_FILE);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.records).toHaveLength(3);
  });

  it('成功写入时 successStreak 递增并落盘', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ successStreak: 5, records: [] }));

    writeRenewalStatus(buildRenewalRecord({ success: true }), TEST_FILE);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.successStreak).toBe(6);
  });

  it('失败写入时 successStreak 清零', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ successStreak: 12, records: [] }));

    writeRenewalStatus(buildRenewalRecord({ success: false }), TEST_FILE);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.successStreak).toBe(0);
  });

  it('跳过写入时 successStreak 保持不变', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ successStreak: 7, records: [] }));

    writeRenewalStatus(buildRenewalRecord({ success: true, skipped: true }), TEST_FILE);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.successStreak).toBe(7);
  });

  it('旧格式文件首次写入时按记录回退后再累加', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      records: [{ success: true }, { success: true }, { success: true }],
    }));

    writeRenewalStatus(buildRenewalRecord({ success: true }), TEST_FILE);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.successStreak).toBe(4);
  });

  it('超过 maxRecords 时截断旧记录', () => {
    const existing = Array.from({ length: 30 }, (_, i) => ({
      timestamp: `2026-06-${String(i + 1).padStart(2, '0')}`,
      success: true,
    }));
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ records: existing }));
    const record = buildRenewalRecord({ success: true });

    writeRenewalStatus(record, TEST_FILE, 30);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.records).toHaveLength(30);
    expect(written.records[29]).toEqual(record);
    expect(written.records[0].timestamp).toBe('2026-06-02');
  });

  it('写入文件不存在时从空状态开始', () => {
    const error = new Error('ENOENT');
    error.code = 'ENOENT';
    mockFs.readFileSync.mockImplementation(() => { throw error; });
    const record = buildRenewalRecord({ success: false });

    writeRenewalStatus(record, TEST_FILE);

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1]);
    expect(written.records).toHaveLength(1);
    expect(written.records[0].success).toBe(false);
  });

  it('格式化输出（2 空格缩进）', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ records: [] }));
    const record = buildRenewalRecord({ success: true });

    writeRenewalStatus(record, TEST_FILE);

    const rawContent = mockFs.writeFileSync.mock.calls[0][1];
    expect(rawContent).toContain('\n  ');
    expect(rawContent).toContain('"records":');
  });

  it('目录不可写时抛出错误', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ records: [] }));
    mockFs.accessSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const record = buildRenewalRecord({ success: true });

    expect(() => writeRenewalStatus(record, TEST_FILE)).toThrow(/不可写/);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('writeFileSync 失败时抛出错误', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ records: [] }));
    mockFs.writeFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });
    const record = buildRenewalRecord({ success: true });

    expect(() => writeRenewalStatus(record, TEST_FILE)).toThrow(/写入状态文件失败/);
  });
});

describe('getRenewalStatus', () => {
  beforeEach(() => {
    mockFs.readFileSync.mockReset();
  });

  it('健康状态：连续失败 < 阈值', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      records: [
        { success: true },
        { success: false },
        { success: true },
      ],
    }));
    const status = getRenewalStatus(TEST_FILE);
    expect(status.healthy).toBe(true);
    expect(status.consecutiveFailures).toBe(0);
    expect(status.consecutiveSuccesses).toBe(1);
    expect(status.totalRuns).toBe(3);
  });

  it('不健康状态：连续失败 >= 阈值', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      records: [
        { success: true },
        { success: false },
        { success: false },
        { success: false },
      ],
    }));
    const status = getRenewalStatus(TEST_FILE);
    expect(status.healthy).toBe(false);
    expect(status.consecutiveFailures).toBe(3);
  });

  it('返回最近一次成功记录（忽略 skipped）', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      records: [
        { timestamp: '2026-06-28', success: true, serverName: 'vps-old' },
        { timestamp: '2026-06-29', success: false },
        { timestamp: '2026-06-30', success: true, serverName: 'vps-new' },
        { timestamp: '2026-07-01', success: true, skipped: true },
      ],
    }));
    const status = getRenewalStatus(TEST_FILE);
    expect(status.lastSuccess).not.toBeNull();
    expect(status.lastSuccess.serverName).toBe('vps-new');
  });

  it('无成功记录时 lastSuccess 为 null', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      records: [
        { success: false },
        { success: false },
      ],
    }));
    const status = getRenewalStatus(TEST_FILE);
    expect(status.lastSuccess).toBeNull();
  });

  it('空记录时返回健康状态', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ records: [] }));
    const status = getRenewalStatus(TEST_FILE);
    expect(status.healthy).toBe(true);
    expect(status.consecutiveFailures).toBe(0);
    expect(status.totalRuns).toBe(0);
    expect(status.lastRecord).toBeNull();
  });

  it('文件不存在时返回健康状态', () => {
    const error = new Error('ENOENT');
    error.code = 'ENOENT';
    mockFs.readFileSync.mockImplementation(() => { throw error; });
    const status = getRenewalStatus(TEST_FILE);
    expect(status.healthy).toBe(true);
    expect(status.totalRuns).toBe(0);
  });
});

describe('连续成功次数不受记录窗口截断（窗口封顶回归）', () => {
  // 真实部署节奏：每 4 小时检查一次，每日仅 12 点那次进入 ≤12h 续期窗口，其余写跳过记录
  const CHECK_HOURS = [0, 4, 8, 12, 16, 20];
  const RENEW_HOUR = 12;
  const silent = { warn: () => {}, error: () => {} };
  let fileContent = null;

  beforeEach(() => {
    fileContent = null;
    mockFs.readFileSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
    mockFs.renameSync.mockReset();
    mockFs.accessSync.mockReset();
    mockFs.accessSync.mockImplementation(() => undefined);
    // 有状态 mock：写入的内容即下一次读取的内容，模拟真实持久化文件
    mockFs.readFileSync.mockImplementation(() => {
      if (fileContent == null) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return fileContent;
    });
    mockFs.writeFileSync.mockImplementation((_path, data) => { fileContent = data; });
  });

  it('跨过 30 条记录窗口后连续成功次数继续增长', () => {
    const shown = [];
    for (let day = 1; day <= 10; day++) {
      for (const hour of CHECK_HOURS) {
        const record = hour === RENEW_HOUR
          ? buildRenewalRecord({ success: true, serverName: 'host02-23' })
          : buildRenewalRecord({ success: true, skipped: true, errorMessage: '无需续期' });
        writeRenewalStatus(record, TEST_FILE, undefined, silent);
      }
      shown.push(getRenewalStatus(TEST_FILE, 3, silent).consecutiveSuccesses);
    }

    // 窗口 30 条 = 5 天，旧实现（按窗口内记录统计）第 6 天起恒为 5
    expect(shown.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(shown.slice(5)).toEqual([6, 7, 8, 9, 10]);
    // 记录仍按 maxRecords 截断，计数与之解耦
    expect(JSON.parse(fileContent).records).toHaveLength(30);
  });

  it('中途失败一次后连续成功次数从 1 重新累计', () => {
    writeRenewalStatus(buildRenewalRecord({ success: true }), TEST_FILE, undefined, silent);
    writeRenewalStatus(buildRenewalRecord({ success: true }), TEST_FILE, undefined, silent);
    expect(getRenewalStatus(TEST_FILE, 3, silent).consecutiveSuccesses).toBe(2);

    writeRenewalStatus(buildRenewalRecord({ success: false, errorMessage: '验证码识别失败' }), TEST_FILE, undefined, silent);
    expect(getRenewalStatus(TEST_FILE, 3, silent).consecutiveSuccesses).toBe(0);

    writeRenewalStatus(buildRenewalRecord({ success: true, skipped: true }), TEST_FILE, undefined, silent);
    expect(getRenewalStatus(TEST_FILE, 3, silent).consecutiveSuccesses).toBe(0);

    writeRenewalStatus(buildRenewalRecord({ success: true }), TEST_FILE, undefined, silent);
    expect(getRenewalStatus(TEST_FILE, 3, silent).consecutiveSuccesses).toBe(1);
  });
});
