import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 防漂移测试：cron-run.sh 环境变量白名单（entrypoint.sh 内联生成）必须与
// 主脚本 CONFIG 读取项、.env.example 文档清单保持同步。
// 新增配置项时漏掉任一处，定时模式下该配置会静默丢失或文档缺失。

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const mainSource = read('xserver-vps-renew.mjs');
const entrypointSource = read('entrypoint.sh');
const envExample = read('.env.example');

/** 主脚本读取的环境变量（CONFIG 定义 + 时区），去重保序 */
const mainEnvVars = [...new Set(
  [...mainSource.matchAll(/\bprocess\.env\.([A-Z_]+)\b/g)].map((m) => m[1]),
)];

/** cron-run.sh 白名单导出的变量（entrypoint.sh 中行首 export，即 heredoc 段） */
const whitelistExports = [...entrypointSource.matchAll(/^export ([A-Z_]+)=/gm)].map((m) => m[1]);
const whitelistVars = [...new Set(whitelistExports)];

/** .env.example 中出现的配置变量（含注释示例行） */
const envExampleVars = new Set(
  [...envExample.matchAll(/^#?\s*([A-Z_]+)\s*=/gm)].map((m) => m[1]),
);

// 有意不在白名单导出的变量：cron 模式调用处显式 CRON_SCHEDULE="" 清空，
// 避免嵌套 supercronic 死锁（entrypoint.sh #7），主脚本仅单次模式读取
const INTENTIONALLY_UNEXPORTED = new Set(['CRON_SCHEDULE']);

// entrypoint.sh 内部透传变量（cron 模式自动注入，用户无需在 .env.example 配置）
const INTERNAL_ONLY = new Set(['CRON_SCHEDULE_DISPLAY']);

// 由 entrypoint.sh / diagnostics.sh 读取、主脚本不读取的变量（预期例外）
const READ_BY_ENTRYPOINT_ONLY = new Set(['ENABLE_DIAGNOSTICS']);

describe('cron-run.sh 环境变量白名单同步（entrypoint ↔ 主脚本 ↔ .env.example）', () => {
  it('主脚本读取的每个环境变量都应在白名单中（防定时模式配置丢失）', () => {
    const missing = mainEnvVars.filter(
      (v) => !whitelistVars.includes(v) && !INTENTIONALLY_UNEXPORTED.has(v),
    );
    expect(
      missing,
      `以下变量被主脚本读取但 cron-run.sh 未导出（定时模式下配置将丢失）: ${missing.join(', ')}。`
      + '请在 entrypoint.sh 的 cron-run.sh 白名单中补充 export。',
    ).toEqual([]);
  });

  it('白名单中的每个变量都应在 .env.example 中有说明（防漏文档）', () => {
    const undocumented = whitelistVars.filter(
      (v) => !envExampleVars.has(v) && !INTERNAL_ONLY.has(v),
    );
    expect(
      undocumented,
      `以下变量已在 cron-run.sh 白名单导出但 .env.example 未收录: ${undocumented.join(', ')}。`
      + '请补充 .env.example 说明。',
    ).toEqual([]);
  });

  it('白名单无重复导出（防 heredoc 内重复 export）', () => {
    const dup = whitelistExports.filter((v, i) => whitelistExports.indexOf(v) !== i);
    expect(dup).toEqual([]);
  });

  it('主脚本 CONFIG 覆盖 .env.example 全部可配置项（防新增配置漏接）', () => {
    const unread = [...envExampleVars].filter(
      (v) => !mainEnvVars.includes(v) && !READ_BY_ENTRYPOINT_ONLY.has(v),
    );
    expect(
      unread,
      `.env.example 已收录但主脚本未读取的变量: ${unread.join(', ')}。`
      + '若为主脚本应读取的配置，请补充 CONFIG 定义。',
    ).toEqual([]);
  });
});
