import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { saveCaptchaSample } from '../../src/captcha.mjs';

describe('saveCaptchaSample', () => {
  let tmpDir;
  const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captcha-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const samplePngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('成功保存 verified 样本并创建目录', () => {
    const savedPath = saveCaptchaSample(samplePngBase64, {
      type: 'verified',
      label: '123456',
      baseDir: tmpDir,
      logger: mockLogger,
    });

    expect(savedPath).toBeTruthy();
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(savedPath).toContain(path.join(tmpDir, 'verified'));
    expect(path.basename(savedPath)).toMatch(/^123456_\d+_[a-z0-9]+\.png$/);
    expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('验证码样本已保存 (verified)'));
  });

  it('成功保存 unlabeled 错题样本', () => {
    const savedPath = saveCaptchaSample(samplePngBase64, {
      type: 'unlabeled',
      label: 'failed_654321',
      baseDir: tmpDir,
      logger: mockLogger,
    });

    expect(savedPath).toBeTruthy();
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(savedPath).toContain(path.join(tmpDir, 'unlabeled'));
    expect(path.basename(savedPath)).toMatch(/^failed_654321_\d+_[a-z0-9]+\.png$/);
    expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('验证码样本已保存 (unlabeled)'));
  });

  it('输入空或无效 data URI 时返回 null，不抛出异常', () => {
    expect(saveCaptchaSample('', { baseDir: tmpDir })).toBeNull();
    expect(saveCaptchaSample(null, { baseDir: tmpDir })).toBeNull();
    expect(saveCaptchaSample('not-a-valid-data-uri', { baseDir: tmpDir })).toBeNull();
  });

  it('文件写入异常时被捕获，打印 warn 并返回 null', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    const result = saveCaptchaSample(samplePngBase64, {
      type: 'verified',
      label: 'test',
      baseDir: tmpDir,
      logger: mockLogger,
    });

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('保存样本失败'));
    writeSpy.mockRestore();
  });
});
