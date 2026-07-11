import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs 模块，追踪 rmSync 调用
const mockRmSync = vi.fn();
const mockExistsSync = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: (...args) => mockExistsSync(...args),
  rmSync: (...args) => mockRmSync(...args),
}));

const { cleanChromeLocks } = await import('../../xserver-vps-renew.mjs');

describe('cleanChromeLocks', () => {
  beforeEach(() => {
    mockRmSync.mockReset();
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    mockRmSync.mockReset();
    mockExistsSync.mockReset();
  });

  it('清理三种 Chrome 锁文件', () => {
    cleanChromeLocks('/data/chrome-profile');

    expect(mockRmSync).toHaveBeenCalledTimes(3);
    expect(mockRmSync).toHaveBeenCalledWith('/data/chrome-profile/SingletonLock', { force: true });
    expect(mockRmSync).toHaveBeenCalledWith('/data/chrome-profile/SingletonSocket', { force: true });
    expect(mockRmSync).toHaveBeenCalledWith('/data/chrome-profile/SingletonCookie', { force: true });
  });

  it('使用正确的 force 选项', () => {
    cleanChromeLocks('/tmp/test-profile');

    // 确保所有调用都使用了 force: true
    mockRmSync.mock.calls.forEach((callArgs) => {
      expect(callArgs[1]).toEqual({ force: true });
    });
  });

  it('传入空字符串或假值时跳过清理', () => {
    expect(() => cleanChromeLocks('')).not.toThrow();
    expect(() => cleanChromeLocks(null)).not.toThrow();
    expect(() => cleanChromeLocks(undefined)).not.toThrow();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('传入嵌套路径时正确拼接', () => {
    cleanChromeLocks('/home/user/.config/chromium/Default');

    expect(mockRmSync).toHaveBeenCalledWith(
      '/home/user/.config/chromium/Default/SingletonLock',
      { force: true }
    );
  });

  it('锁文件不存在时静默忽略错误（force: true 行为）', () => {
    // rmSync 在 force: true 时不会抛出 ENOENT，但验证 mock 正常执行
    mockRmSync.mockImplementation(() => {});
    expect(() => cleanChromeLocks('/data/profile')).not.toThrow();
  });

  it('返回值为 undefined（无返回值函数）', () => {
    const result = cleanChromeLocks('/data/profile');
    expect(result).toBeUndefined();
  });
});
