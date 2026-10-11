import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 测试必须使用确定的时间基准：读取真实时钟会让断言随运行时刻变化。
// 历史上「今天到期的免费 VPS 返回 needed: true」用例在东京上午运行时误判为 not_due，
// 导致 npm test 非零退出，docker-publish 工作流的镜像构建被阻断。
//
// 允许的写法（不产生时刻依赖）：
//   固定时刻入参 —— new Date(fixedMs) / Date.parse(...) / Date.UTC(...)
//   假时钟      —— vi.useFakeTimers() / vi.setSystemTime(...)
//   时钟替身    —— vi.spyOn(Date, 'now').mockReturnValue(...) 或 Date.now = () => 固定值
const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
const TESTS_DIR = join(ROOT_DIR, '__tests__');
const SELF_FILE = 'testClockHygiene.test.mjs';

const BARE_CLOCK_PATTERNS = [
  { label: 'new Date() 读取当前时刻', regex: /\bnew Date\(\s*\)/ },
  { label: 'Date.now() 读取当前时刻', regex: /\bDate\.now\(\s*\)/ },
  { label: 'performance.now() 读取当前时刻', regex: /\bperformance\.now\(\s*\)/ },
];

/**
 * 列出被检查的测试文件
 * @returns {string[]} 绝对路径列表
 */
function listTestFiles() {
  return readdirSync(TESTS_DIR, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.test.mjs'))
    .filter((entry) => !entry.includes(SELF_FILE))
    .map((entry) => join(TESTS_DIR, entry));
}

/**
 * 去除注释，保留原有行数以便报告准确行号
 * @param {string} code
 * @returns {string}
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('测试时钟卫生', () => {
  it('测试文件不读取真实时钟，必须固定时间基准', () => {
    const files = listTestFiles();
    // 防止匹配失效导致守卫空转
    expect(files.length).toBeGreaterThan(20);

    const violations = [];
    for (const file of files) {
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        for (const { label, regex } of BARE_CLOCK_PATTERNS) {
          if (regex.test(line)) {
            violations.push(`${relative(ROOT_DIR, file)}:${index + 1} ${label} → ${line.trim()}`);
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
