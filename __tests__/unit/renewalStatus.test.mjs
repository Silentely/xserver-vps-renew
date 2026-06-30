import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node:fs 模块
const mockFs = {
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  rmSync: vi.fn(),
};
vi.mock('node:fs', () => mockFs);

const {
  buildRenewalRecord,
  countConsecutiveFailures,
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

  it('缺失字段使用默认值 null', () => {
    const record = buildRenewalRecord({ success: true });
    expect(record.serverName).toBeNull();
    expect(record.plan).toBeNull();
    expect(record.oldExpireDate).toBeNull();
    expect(record.newExpireDate).toBeNull();
    expect(record.errorMessage).toBeNull();
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
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
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
  });
});

describe('writeRenewalStatus', () => {
  beforeEach(() => {
    mockFs.readFileSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
    mockFs.renameSync.mockReset();
  });

  it('追加新记录并写入文件', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ records: [] }));
    const record = buildRenewalRecord({ success: true, serverName: 'vps1' });

    writeRenewalStatus(record, TEST_FILE);

    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);

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
    // 最新的记录在末尾
    expect(written.records[29]).toEqual(record);
    // 最旧的记录被截断（原第 1 条被移除，原第 2 条变为第 1 条）
    expect(written.records[0].timestamp).toBe('2026-06-02');
  });

  it('写入文件不存在时从空状态开始', () => {
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
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

  it('返回最近一次成功记录', () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      records: [
        { timestamp: '2026-06-28', success: true, serverName: 'vps-old' },
        { timestamp: '2026-06-29', success: false },
        { timestamp: '2026-06-30', success: true, serverName: 'vps-new' },
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
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const status = getRenewalStatus(TEST_FILE);
    expect(status.healthy).toBe(true);
    expect(status.totalRuns).toBe(0);
  });
});
