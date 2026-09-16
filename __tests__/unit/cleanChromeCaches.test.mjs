import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs 模块，追踪 rmSync 调用
const mockRmSync = vi.fn();
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rmSync: (...args) => mockRmSync(...args),
  };
});

const { cleanChromeCaches } = await import('../../src/utils.mjs');

describe('cleanChromeCaches', () => {
  beforeEach(() => {
    mockRmSync.mockReset();
  });

  afterEach(() => {
    mockRmSync.mockReset();
  });

  it('清理 Chrome 常用临时缓存目录且保留 recursive 与 force 选项', () => {
    cleanChromeCaches('/data/chrome-profile');

    expect(mockRmSync).toHaveBeenCalledWith('/data/chrome-profile/Default/Cache', { recursive: true, force: true });
    expect(mockRmSync).toHaveBeenCalledWith('/data/chrome-profile/Default/Code Cache', { recursive: true, force: true });
    expect(mockRmSync).toHaveBeenCalledWith('/data/chrome-profile/Default/GPUCache', { recursive: true, force: true });
    expect(mockRmSync).toHaveBeenCalledWith('/data/chrome-profile/Crashpad', { recursive: true, force: true });
    expect(mockRmSync).toHaveBeenCalledWith('/data/chrome-profile/Default/DawnGraphiteCache', { recursive: true, force: true });
    expect(mockRmSync).toHaveBeenCalledWith('/data/chrome-profile/Default/Service Worker/CacheStorage', { recursive: true, force: true });
  });

  it('传入假值或空字符串时直接跳过且不抛异常', () => {
    expect(() => cleanChromeCaches('')).not.toThrow();
    expect(() => cleanChromeCaches(null)).not.toThrow();
    expect(() => cleanChromeCaches(undefined)).not.toThrow();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('rmSync 报错时不向上抛出（静默处理）', () => {
    mockRmSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    expect(() => cleanChromeCaches('/data/chrome-profile')).not.toThrow();
  });
});
