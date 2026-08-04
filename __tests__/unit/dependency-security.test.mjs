import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('依赖安全回归', () => {
  it('brace-expansion 使用 CVE-2026-14257 的 1.x 修复版且保持 CommonJS 兼容', () => {
    const { version } = require('brace-expansion/package.json');
    const expand = require('brace-expansion');

    expect(version).toBe('1.1.18');
    expect(typeof expand).toBe('function');
    expect(expand('file{1,2}.txt')).toEqual(['file1.txt', 'file2.txt']);
  });

  it('minimatch@3 仍能通过安全回补版执行 brace 匹配', () => {
    const minimatch = require('minimatch');

    expect(minimatch('file2.txt', 'file{1,2}.txt')).toBe(true);
    expect(minimatch('file3.txt', 'file{1,2}.txt')).toBe(false);
  });

  it('安全回补会限制展开结果总长度，避免无界内存增长', () => {
    const expand = require('brace-expansion');

    expect(expand('{a,b}{c,d}', { maxLength: 3 })).toEqual(['ac']);
  });
});
