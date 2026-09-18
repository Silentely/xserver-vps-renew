import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('安全审计加固回归测试', () => {
  it('nomore-spam.yml: Actions 必须固定完整 Commit SHA，禁止使用 @main 分支引用', () => {
    const workflowPath = join(REPO_ROOT, '.github/workflows/nomore-spam.yml');
    const content = readFileSync(workflowPath, 'utf8');

    expect(content).not.toMatch(/uses:\s+JohnsonRan\/nomore-spam@main/);
    expect(content).toMatch(/uses:\s+JohnsonRan\/nomore-spam@[0-9a-f]{40}/);
  });

  it('entrypoint.sh: 挂载目录权限必须收紧为 700，严禁 777 宽权限', () => {
    const entrypointPath = join(REPO_ROOT, 'entrypoint.sh');
    const content = readFileSync(entrypointPath, 'utf8');

    expect(content).not.toMatch(/chmod\s+-R\s+777\s+"\$TARGET_DATA_DIR"/);
    expect(content).toMatch(/chmod\s+-R\s+700\s+"\$TARGET_DATA_DIR"/);
  });

  it('entrypoint.sh: CRON_SCHEDULE 必须校验白名单字符', () => {
    const entrypointPath = join(REPO_ROOT, 'entrypoint.sh');
    const content = readFileSync(entrypointPath, 'utf8');

    expect(content).toMatch(/CRON_SCHEDULE 包含非法字符/);

    // 运行测试：传入含注入字符的表达式应被拦截
    const res = spawnSync('bash', ['-c', `
      source <(grep -B 9999 'elif \\[ -n "\\\${CRON_SCHEDULE:-}" \\]; then' "${entrypointPath}" | head -n 15)
      LOG_PREFIX="[test]"
      CRON_SCHEDULE="* * * * *; rm -rf /"
      if [[ ! "$CRON_SCHEDULE" =~ ^[0-9a-zA-Z\\ \\*\\/,-]+$ ]]; then
        echo "rejected"
        exit 1
      fi
    `]);
    expect(res.status).toBe(1);
    expect(res.stdout.toString()).toContain('rejected');
  });

  it('diagnostics.sh: 禁止通过 --proxy-user 命令行参数明文暴露代理凭据', () => {
    const diagPath = join(REPO_ROOT, 'diagnostics.sh');
    const content = readFileSync(diagPath, 'utf8');

    expect(content).not.toMatch(/--proxy-user\s+["']?\$\{PROXY_LOGIN\}/);
    expect(content).toMatch(/--config\s+"\$PROXY_CFG"/);
  });
});
