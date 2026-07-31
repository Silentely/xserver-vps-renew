/**
 * 回归 #10：Docker cron 模式下 Telegram「下次执行」恒显示 +6h 的误导
 *
 * 根因：#7 修复要求 cron-run.sh 对 --once 子进程清空 CRON_SCHEDULE，
 * node 侧「下次执行」估算失去 cron 依据，只能回退 NOTIFY_NEXT_RUN_HOURS（默认 6h）。
 *
 * 修复：entrypoint 白名单透传仅展示用的 CRON_SCHEDULE_DISPLAY，
 * 主脚本估算时优先读取；该变量不参与模式判断，避免 #7 防线回撤。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAIN_SRC = readFileSync(join(REPO_ROOT, 'xserver-vps-renew.mjs'), 'utf8');
const ENTRYPOINT_SRC = readFileSync(join(REPO_ROOT, 'entrypoint.sh'), 'utf8');

describe('下次执行估算优先使用 CRON_SCHEDULE_DISPLAY（#10）', () => {
  it('CONFIG 读取 CRON_SCHEDULE_DISPLAY 环境变量', () => {
    expect(MAIN_SRC).toMatch(/CRON_SCHEDULE_DISPLAY:\s*process\.env\.CRON_SCHEDULE_DISPLAY\s*\|\|\s*''/);
  });

  it('resolveNextRun 优先 CRON_SCHEDULE_DISPLAY，回落 CRON_SCHEDULE', () => {
    expect(MAIN_SRC).toMatch(/cronSchedule:\s*CONFIG\.CRON_SCHEDULE_DISPLAY\s*\|\|\s*CONFIG\.CRON_SCHEDULE/);
  });

  it('cron-run 白名单透传 CRON_SCHEDULE_DISPLAY（取自 CRON_SCHEDULE）', () => {
    const cronBody = ENTRYPOINT_SRC.match(/cat > \/app\/cron-run\.sh <<'CRONSCRIPT'([\s\S]*?)CRONSCRIPT/);
    expect(cronBody, '应生成 cron-run.sh').toBeTruthy();
    expect(
      cronBody[1],
      '应透传真实调度供「下次执行」估算',
    ).toMatch(/export CRON_SCHEDULE_DISPLAY="\$\{CRON_SCHEDULE:-\}"/);
  });

  it('防线不回撤：白名单不得原样导出 CRON_SCHEDULE（#7）', () => {
    const cronBody = ENTRYPOINT_SRC.match(/cat > \/app\/cron-run\.sh <<'CRONSCRIPT'([\s\S]*?)CRONSCRIPT/);
    expect(cronBody, '应生成 cron-run.sh').toBeTruthy();
    // 注意：CRON_SCHEDULE_DISPLAY 不会被 /export CRON_SCHEDULE=/ 命中（变量名更长）
    expect(
      cronBody[1],
      '禁止 export CRON_SCHEDULE=，避免子进程误入定时模式（#7）',
    ).not.toMatch(/^export CRON_SCHEDULE=/m);
  });
});
