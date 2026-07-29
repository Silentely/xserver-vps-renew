/**
 * 回归 #7：CRON_SCHEDULE 继承导致 cron 嵌套死锁
 *
 * 根因：cron-run.sh 调用 `./entrypoint.sh --once` 时仍继承 CRON_SCHEDULE，
 * entrypoint 优先进入定时模式并再次拉起 supercronic，flock 永不释放。
 *
 * 期望：只要 argv 含 --once，无论 CRON_SCHEDULE 是否设置，都只执行一次续期并退出。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRYPOINT_SRC = join(REPO_ROOT, 'entrypoint.sh');

/** 创建带 mock 二进制的临时环境，避免真实 Xvfb / node 续期 / supercronic */
function setupHarness() {
  const root = mkdtempSync(join(tmpdir(), 'entrypoint-once-'));
  const bin = join(root, 'bin');
  const app = join(root, 'app');
  mkdirSync(bin);
  mkdirSync(app);

  const writeMarker = (name) => join(root, name);

  // mock：记录调用并成功退出
  const nodeMarker = writeMarker('node-called');
  const supercronicMarker = writeMarker('supercronic-called');
  const pgrepMarker = writeMarker('pgrep-called');

  writeFileSync(join(bin, 'node'), `#!/bin/bash
echo "mock-node $*" >> "${nodeMarker}"
# 模拟主脚本成功
exit 0
`);
  writeFileSync(join(bin, 'supercronic'), `#!/bin/bash
echo "mock-supercronic $*" >> "${supercronicMarker}"
# 若被错误拉起会挂起，用短 sleep 便于超时检测
sleep 60
`);
  writeFileSync(join(bin, 'pgrep'), `#!/bin/bash
echo "pgrep $*" >> "${pgrepMarker}"
# 假装 Xvfb 已在运行，跳过启动
exit 0
`);
  writeFileSync(join(bin, 'Xvfb'), `#!/bin/bash
exit 0
`);
  // flock：macOS 常无；提供兼容实现（仅支持 flock -n FD）
  writeFileSync(join(bin, 'flock'), `#!/bin/bash
# 简易非阻塞锁：成功则持有到进程结束
mode="$1"
fd="$2"
lockfile="/tmp/xserver-renew.lock.harness.$$"
if [ "$mode" = "-n" ]; then
  if [ -f "$lockfile" ]; then
    exit 1
  fi
  # 关联到传入的 fd 对应的锁文件（测试单进程足够）
  touch /tmp/xserver-renew.lock
  exit 0
fi
exit 0
`);

  for (const name of ['node', 'supercronic', 'pgrep', 'Xvfb', 'flock']) {
    chmodSync(join(bin, name), 0o755);
  }

  // 复制 entrypoint，并让它在 /app 工作
  const entrypoint = join(app, 'entrypoint.sh');
  writeFileSync(entrypoint, readFileSync(ENTRYPOINT_SRC, 'utf8'));
  chmodSync(entrypoint, 0o755);

  // 主脚本路径：entrypoint 调用 node /app/xserver-vps-renew.mjs
  writeFileSync(join(app, 'xserver-vps-renew.mjs'), '// mock\n');

  return { root, bin, app, entrypoint, nodeMarker, supercronicMarker };
}

function runEntrypoint(harness, args, env = {}) {
  return spawnSync('bash', [harness.entrypoint, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      PATH: `${harness.bin}:/usr/bin:/bin`,
      HOME: harness.root,
      // 避免 set -u 下未定义变量
      CRON_SCHEDULE: '',
      ...env,
    },
    cwd: harness.app,
  });
}

describe('entrypoint.sh --once 优先于 CRON_SCHEDULE（#7）', () => {
  let harness;

  beforeEach(() => {
    harness = setupHarness();
  });

  afterEach(() => {
    if (harness?.root && existsSync(harness.root)) {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('源码：--once 分支必须先于 CRON_SCHEDULE 定时模式判断', () => {
    const src = readFileSync(ENTRYPOINT_SRC, 'utf8');
    // 去掉 heredoc 内 cron-run 模板，只看顶层控制流
    const topLevel = src.replace(/cat > \/app\/cron-run\.sh <<'CRONSCRIPT'[\s\S]*?CRONSCRIPT/, '');

    const onceIdx = topLevel.search(/if \[ "\$\{1:-\}" = "--once" \]/);
    // 顶层定时模式必须是 --once 之后的 elif（run_renew 内 if 仅用于日志，不算模式入口）
    const cronModeIdx = topLevel.search(/elif \[ -n "\$\{CRON_SCHEDULE:-\}" \]/);

    expect(onceIdx, '--once 判断应存在').toBeGreaterThanOrEqual(0);
    expect(cronModeIdx, 'CRON_SCHEDULE 定时模式应为 elif（接在 --once 之后）').toBeGreaterThanOrEqual(0);
    expect(onceIdx, '--once 必须写在 CRON_SCHEDULE 定时分支之前，避免嵌套 supercronic').toBeLessThan(cronModeIdx);
  });

  it('运行：CRON_SCHEDULE 已设置时 --once 只跑 node 一次并退出，不启动 supercronic', () => {
    const result = runEntrypoint(harness, ['--once'], {
      CRON_SCHEDULE: '24 */3 * * *',
      TZ: 'Asia/Tokyo',
      RENEWAL_STATUS_FILE: join(harness.root, 'status.json'),
    });

    expect(result.error, `不应超时/异常: ${result.error}`).toBeUndefined();
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(existsSync(harness.nodeMarker), '应调用 node 执行续期').toBe(true);
    expect(existsSync(harness.supercronicMarker), '禁止再拉起 supercronic（#7 死锁根因）').toBe(false);
    expect(result.stdout).not.toMatch(/定时模式/);
    expect(result.stdout).not.toMatch(/supercronic 已启动/);
  });

  it('运行：无 --once 且 CRON_SCHEDULE 为空时走单次模式并调用 node', () => {
    const result = runEntrypoint(harness, [], {
      CRON_SCHEDULE: '',
      TZ: 'Asia/Tokyo',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(existsSync(harness.nodeMarker)).toBe(true);
    expect(existsSync(harness.supercronicMarker)).toBe(false);
    expect(result.stdout).toMatch(/单次执行模式/);
  });

  it('源码：cron-run 调用 --once 时应清空或覆盖 CRON_SCHEDULE（防御纵深）', () => {
    const src = readFileSync(ENTRYPOINT_SRC, 'utf8');
    const cronRunMatch = src.match(/cat > \/app\/cron-run\.sh <<'CRONSCRIPT'([\s\S]*?)CRONSCRIPT/);
    expect(cronRunMatch, '应生成 cron-run.sh').toBeTruthy();
    const cronBody = cronRunMatch[1];

    // 调用处清空：CRON_SCHEDULE="" … ./entrypoint.sh --once（中间可夹其他 env 赋值）
    const clearsOnInvoke = /CRON_SCHEDULE=(?:""|'')(?:\s+\w+=\S+)*\s+\.\/entrypoint\.sh\s+--once/.test(cronBody)
      || /env\s+-u\s+CRON_SCHEDULE\s+\.\/entrypoint\.sh\s+--once/.test(cronBody)
      || /CRON_SCHEDULE=\s+\.\/entrypoint\.sh\s+--once/.test(cronBody);

    // 若顶层已保证 --once 优先，调用处清空为加分项；至少不能只依赖错误的嵌套路径
    // 本用例要求调用处也清空，形成双保险
    expect(
      clearsOnInvoke,
      'cron-run.sh 调用 entrypoint --once 时应 CRON_SCHEDULE=""（或 env -u），切断嵌套定时模式',
    ).toBe(true);
  });
});
