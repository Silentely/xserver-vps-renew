/**
 * diagnostics.sh 状态文件可写性探测
 *
 * 部署常见坑：/data 挂载卷属主/权限不足时 writeRenewalStatus 只能在运行中失败，
 * 诊断脚本提前探测目录/文件可写性，把问题暴露在排障第一阶段。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIAG_SRC = readFileSync(join(REPO_ROOT, 'diagnostics.sh'), 'utf8');

/** 提取 check_status_file_writability 函数并在 bash 中以指定状态文件路径求值 */
function probeStatusFile(statusFilePath) {
  const fnMatch = DIAG_SRC.match(/check_status_file_writability\(\) \{[\s\S]*?\n\}/);
  expect(fnMatch, 'diagnostics.sh 应定义 check_status_file_writability()').toBeTruthy();
  const r = spawnSync(
    'bash',
    ['-c', `${fnMatch[0]}\ncheck_status_file_writability`, '_'],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: { PATH: '/usr/bin:/bin', RENEWAL_STATUS_FILE: statusFilePath },
    },
  );
  expect(r.status, `bash 求值失败: ${r.stderr}`).toBe(0);
  return r.stdout;
}

describe('diagnostics.sh 状态文件可写性探测', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'diag-status-'));
  });

  afterEach(() => {
    if (root && existsSync(root)) {
      // 恢复权限以便清理
      try { chmodSync(root, 0o755); } catch { /* 忽略 */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('目录可写 → 提示可写', () => {
    const out = probeStatusFile(join(root, 'renewal-status.json'));
    expect(out).toContain('目录: 可写');
    expect(out).not.toContain('❌');
  });

  it('目录不存在 → 提示将自动创建', () => {
    const out = probeStatusFile(join(root, 'no-such-dir', 'renewal-status.json'));
    expect(out).toContain('目录: 不存在');
  });

  it('目录不可写 → ❌ 告警（挂载卷权限坑前置暴露）', () => {
    const dir = join(root, 'locked');
    mkdirSync(dir);
    chmodSync(dir, 0o555);
    const out = probeStatusFile(join(dir, 'renewal-status.json'));
    expect(out).toContain('❌ 不可写');
    chmodSync(dir, 0o755);
  });

  it('文件已存在但不可写 → ❌ 告警', () => {
    const file = join(root, 'renewal-status.json');
    writeFileSync(file, '{"records":[]}');
    chmodSync(file, 0o444);
    const out = probeStatusFile(file);
    expect(out).toContain('❌ 已存在但不可写');
    chmodSync(file, 0o644);
  });

  it('文件已存在且可写 → 正常提示', () => {
    const file = join(root, 'renewal-status.json');
    writeFileSync(file, '{"records":[]}');
    const out = probeStatusFile(file);
    expect(out).toContain('已存在且可写');
  });
});
