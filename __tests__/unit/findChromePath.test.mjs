import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs 模块，控制 existsSync 的返回行为
const mockExistsSync = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: (...args) => mockExistsSync(...args),
  rmSync: vi.fn(),
}));

// 导入被测模块（需要在 mock 之后）
const { findChromePath } = await import('../../xserver-vps-renew.mjs');

describe('findChromePath', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    mockExistsSync.mockReset();
  });

  it('返回第一个存在的候选路径', () => {
    // 模拟 /usr/bin/google-chrome-stable 存在
    mockExistsSync.mockImplementation((p) => p === '/usr/bin/google-chrome-stable');
    expect(findChromePath()).toBe('/usr/bin/google-chrome-stable');
  });

  it('跳过不存在的路径，返回后续候选', () => {
    // 只有 /usr/bin/chromium 存在
    mockExistsSync.mockImplementation((p) => p === '/usr/bin/chromium');
    expect(findChromePath()).toBe('/usr/bin/chromium');
  });

  it('当所有候选都不存在时返回默认值', () => {
    mockExistsSync.mockReturnValue(false);
    expect(findChromePath()).toBe('google-chrome-stable');
  });

  it('优先返回排序靠前的候选（Linux 路径优先于 macOS）', () => {
    // 模拟 macOS 路径存在，但 Linux 路径不存在
    mockExistsSync.mockImplementation(
      (p) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    );
    expect(findChromePath()).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('候选列表包含所有预期的 Chrome 路径', () => {
    const checkedPaths = [];
    mockExistsSync.mockImplementation((p) => {
      checkedPaths.push(p);
      return false; // 全部不存在
    });

    findChromePath();

    expect(checkedPaths).toContain('/usr/bin/google-chrome-stable');
    expect(checkedPaths).toContain('/usr/bin/google-chrome');
    expect(checkedPaths).toContain('/usr/bin/chromium-browser');
    expect(checkedPaths).toContain('/usr/bin/chromium');
    expect(checkedPaths).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });
});
