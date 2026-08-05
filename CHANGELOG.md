# Changelog

## [Unreleased]

### 修复（2026-08-05）
- **官方新增「個人情報の取り扱いについて」同意页导致误判「未找到免费 VPS」**
  - 现象：2026-08-05 起登录成功后面板各页均被重定向至 `/xapanel/myaccount/agreement/index`（官方因网络オウル レジストラ业务移管新增的强制同意页）；未同意时 `goto /xapanel/xvps/index` 也被弹回，VPS 列表永不出现 → `no_free_vps`。代码逻辑自项目初始未变，8/4 重构前后一致，属官方页面变更而非代码回归
  - 修复：新增 `ensureAgreementAccepted`（主脚本）/ `handleAgreement`（用户脚本）：检测 `/xapanel/myaccount/agreement` 路径 → 勾选 `#agree_flag_1` → 提交 `input[name="action_user_agreement_do"]`（原生表单 POST `/xapanel/myaccount/agreement/do`）；提交后仍停留在同意页则抛错，避免静默误判
  - 辅助：`checkRenewalNeeded` 查询前等待表格（`waitForSelector` 10s）超时后采集页面结构诊断（URL / `freeServerIco` 数量 / `tr` 行数 / detail 链接 / 表格 HTML 或正文片段），本次即靠该诊断日志定位到同意页
- **自动处理无效时通过 Telegram 提醒用户人工确认**（官方再次改版确认页时不再静默误判）
  - `ensureAgreementAccepted` 失败（找不到复选框/提交按钮、提交后仍停留）抛 `MANUAL_CONFIRMATION_REQUIRED` 错误；`checkRenewalNeeded` 在 `no_free_vps` 且当前 URL 未进入 VPS 面板（`/xvps/`）时标记 `needsManualConfirmation`
  - 两类场景均发送 `buildManualConfirmNotifyMessage`（新通知：提醒登录 Xserver 检查新确认页、手动完成后重跑容器命令），退出码置 1，区别于通用失败/跳过通知
  - 验证：`node --check` + 19 文件 / 359 用例全绿（新增 3 用例），覆盖率门禁达标

### 修复（2026-08-04）
- **「无需续期」场景同一轮发出两条 Telegram 通知（skip + failure）且退出码为 1**
  - 根因：`finishWithSkip`（skip 统一出口）定义于 `main()` 的 `try` 块之外，内部 `page.close()` 所引用的 `page` 为 `try` 块内 `const` 声明的块级变量，不在其词法作用域——skip 通知发送成功后执行 `page.close()` 抛 `ReferenceError: page is not defined`，被 catch 误判为「续期失败」，追加发送失败通知并置退出码 1
  - 触发面：`not_due / no_free_vps / window_blocked` 三个跳过分支（真正续期路径不调用 `finishWithSkip`，故此前未被发现）
  - 修复：`page` 改为显式参数传入 `finishWithSkip`（定义处 + 两处调用点），补充 JSDoc 说明作用域约束
  - 回归：最小复现验证 skip 通知后不再进入 catch；`node --check` + 19 文件 / 356 用例全绿

### 优化（2026-08-04）
- **重构：拆分 `src/notify.mjs`，收敛通用工具到 `src/utils.mjs`**
  - `renewal-logic.mjs`（1303 行）原混合「续期判定 + 通知文案」两类职责；通知构建（消息文案 / 失败分类 / 下次执行估算 / 详情模式 / 截断）约 850 行移入新模块 `src/notify.mjs`，业务逻辑文件降至 440 行
  - `escapeHtml` / `formatTokyoDateTime` / `findChromePath` / `cleanChromeLocks` 收归 `src/utils.mjs`，消除 `escapeHtml` 双份实现
  - `xserver-vps-renew.mjs` 删除 37 项测试驱动死重导出、6 个模块函数薄包装与 `escapeHtml` 死代码包装（原仅为 `escapeHtml.test.mjs` 从主脚本 import 而存在），测试改从 `src/` 直接 import；`escapeHtml.test.mjs` 用例并入 `utils.test.mjs`
  - 顺带修复 `main()` 内 `finishWithSkip` 对后定义 `resolveNextRun` 的前向引用（提升定义，消除 TDZ 隐患）
  - 行为不变：19 测试文件 / 356 用例全绿；`src/` 整体行覆盖率 91.9%（CI 阈值 28%）
- **日志：修复 error 级别跨秒双时间戳 / 重复 ❌**
  - 原 `emitLog` error 分支最多调用 3 次 `ts()`：消息已带 `❌` 前缀且两次取时跨秒时，会输出 `时间戳 ❌ 时间戳 ❌ 消息` 的重复格式
  - 修复：每条日志单次取时间戳；`❌` 前缀是否补充仅依据消息本身是否已带，不再依赖时间戳字符串匹配
- **重构：skip 通知统一出口 `finishWithSkip`**
  - `not_due / no_free_vps / window_blocked` 三个「跳过」分支原先重复约 40 行相同逻辑（结局标记 + 持久化 + skip 通知 + 关页），收敛为单一辅助函数，行为不变
- **健壮性：`parsePositiveInt` 严格整数校验**
  - 原实现 `parseInt` 会静默接受 `"30000ms"` 这类被意外拼接的值（取数字前缀），现仅接受纯数字，非法即回退默认；补充边界测试
- **清理：验证码图片选择器去冗余**（`img[src^="data:image"]` 是 `img[src^="data:"]` 子集，保留后者）
- **文档：`waitForTurnstileToken` 超时日志改准确文案**（原「将尝试强制提交」与实际跳过提交的行为不符）

### 修复（2026-07-31）
- **Docker cron 模式下 Telegram「下次执行」恒显示 +6h 的误导**（核实 [#10](https://github.com/Silentely/xserver-vps-renew/issues/10) 时的附带发现）
  - 根因：#7 修复要求 `cron-run.sh` 对 `--once` 子进程清空 `CRON_SCHEDULE`，node 侧「下次执行」估算失去 cron 依据，回退到 `NOTIFY_NEXT_RUN_HOURS`（默认 6h）
  - 修复：白名单新增仅展示用的 `CRON_SCHEDULE_DISPLAY` 透传真实调度；主脚本估算链变为 `CRON_SCHEDULE_DISPLAY → CRON_SCHEDULE → NOTIFY_NEXT_RUN_HOURS`，该变量不参与任何模式判断（#7 防线不回撤）
  - 注：#10 的「成功+失败双通知」主因不是代码 bug——同一账号 / TG bot 下存在第二个独立运行的旧实例并发执行（排查指引见 issue 回复）

### 优化（2026-07-31）
- **compose 默认调度改为 `27 */4 * * *`**（[#9](https://github.com/Silentely/xserver-vps-renew/issues/9)）
  - 原默认 `0 */6 * * *` 在任意 12h 续期窗口内仅 2 次尝试，且 12:00 整点易踩官方窗口开启边界，被「12時間前」拦截页挡掉一次机会
  - 新默认每 4 小时 + 27 分错峰：窗口内 ≥3 次尝试，避开整点边界竞争；「下次执行」估算按 cron 的 `*/N` 解析自动适配
  - 存量部署不受影响（`CRON_SCHEDULE` 本来就是环境变量）；更新 compose 文件或自行设置 `CRON_SCHEDULE=27 */4 * * *` 即可生效

### 修复（2026-07-29）
- **Dependabot 高危告警 #4：`brace-expansion` 无界展开可导致进程内存耗尽**（[CVE-2026-14257](https://nvd.nist.gov/vuln/detail/CVE-2026-14257) / [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg)）
  - 将 `package.json` override 从 1.1.16 升级至官方 1.x 兼容安全回补版 1.1.17
  - 保持 `minimatch@3` 所需的 CommonJS 函数接口，避免跨主版本覆盖引入兼容性风险
  - 新增依赖版本、直接展开与 `minimatch` brace 匹配回归测试
- **Dependabot 高危告警：`brace-expansion` CVE-2026-69152 绕过此前回补**（[CVE-2026-69152](https://avd.aquasec.com/nvd/cve-2026-69152)）
  - 将 `package.json` override 从 1.1.17 升级至 1.1.18（`minimatch@3.1.5` 的 `^1.1.7` 范围包含此版本，无兼容性风险）
  - Dependabot 无法自动升级的原因：`overrides` 字面量钉住 `1.1.17`，覆盖了依赖树的自然解析
- **容器首次检查后反复重启并持续发送 Telegram 通知**（[#8](https://github.com/Silentely/xserver-vps-renew/issues/8)）
  - 根因：Supercronic v0.2.34 作为 PID 1 时，reaper 使用裸命令名自启动且不搜索 `PATH`，触发 `Failed to fork exec: no such file or directory`
  - 修复：升级至已修复的 v0.2.36，并通过 `/usr/local/bin/supercronic` 绝对路径启动，形成双层保护
  - 回归：单测固定最低安全版本与绝对启动路径；镜像发布后以真实 PID 1 运行 Supercronic smoke
- **Docker 定时任务死锁：cron 触发后永远「上一次执行仍在运行，跳过」**（[#7](https://github.com/Silentely/xserver-vps-renew/issues/7)）
  - 根因：`cron-run.sh` 调用 `./entrypoint.sh --once` 时继承 `CRON_SCHEDULE`，entrypoint 先判断环境变量再判断 `--once`，误入定时模式并再次 `exec supercronic`，`flock` 永不释放
  - 修复：`--once` **优先于** `CRON_SCHEDULE` 模式判断；`cron-run` 调用时 `CRON_SCHEDULE="" ./entrypoint.sh --once` 双保险
  - 回归：`__tests__/unit/entrypoint.once-mode.test.mjs`（源码顺序 + mock 运行时）
  - 部署后请 `docker compose pull && docker compose up -d` 换新镜像；若容器已假死可先 `docker compose restart`

### 修复（2026-07-26）
- **Turnstile 求解成功后 UA 对齐导致 token 未注入**
  - 先 `injectTurnstileToken` / callback，再尽力 `setUserAgent`；UA 失败只 warn，不判求解失败（避免 `Network.setUserAgentOverride: Target closed` 吞掉已解 token）
  - Turnstile 未通过时**禁止强制提交**，避免必然 `認証に失敗` 并污染重试页
  - 验证码失败重试优先回到 `extend/index?id_vps=…` 再点确认进 conf（裸 `/conf` 常无 Base64 验证码图）
  - 文档 / RUNBOOK / `.env.example` 补充 **Anti-Captcha + 域名代理 → Proxyless 与浏览器出口 IP 不一致** 的风险与处置

### 优化（2026-07-25）
- **日志与 Telegram 通知**
  - 成功 / 跳过 / 失败通知统一附带 **耗时**；失败通知在已知时附带 **服务器名 / 规格 / 到期日 / 剩余时间**
  - 失败自动分类（登录 / 配置 / 图形验证码 / Turnstile / 全平台熔断 / 超时 / 业务限制 / 其他），通知含 `🏷️ 失败类型`，full 模式按类给出处置建议
  - 跳过通知增加 **距可续窗口**（剩余 − 12h）；`TG_NOTIFY_SKIP=false` 可关闭跳过类推送（仅成功/失败）
  - 错误信息与执行过程步骤自动截断（错误默认 ≤500 字；过程最多 15 步、单步 ≤180 字），发送前再兜底 ≤4096 字，避免 Bot API 拒收
  - 新增 `LOG_LEVEL`（debug/info/warn/error）：默认 info；截图、字段数、API 轮询/原始响应、Turnstile 点击轨迹等降为 debug
  - VPS 状态合并为一行日志；Turnstile 求解路径 info 摘要更短；`prefilled`/`natural` 在 TG 中显示为中文
  - 执行过程步骤合并连续重复；失败标题去掉双重 `<b>` 嵌套；登录过程区分 Cookie 复用
  - 启动日志标明日志级别、通知模式与 Telegram 是否已配置；结束日志带结果摘要（成功/跳过/失败）与总耗时
  - 失败持久化记录复用已解析的 VPS 上下文
  - **entrypoint cron 环境白名单**：补齐 `ANTICAPTCHA_*` / `YESCAPTCHA_*` / `TURNSTILE_*` / `TG_NOTIFY_DETAIL` / `TG_NOTIFY_SKIP` / `LOG_LEVEL` 等

### 功能（2026-07-24）
- **Turnstile 多平台 failover + Anti-Captcha**
  - 新增 `ANTICAPTCHA_API_KEY`：按 [Anti-Captcha 官方文档](https://anti-captcha.com/apidoc/task-types/TurnstileTaskProxyless) 调用 `TurnstileTaskProxyless` / `TurnstileTask`（字段 `cData`/`chlPageData`，createTask 可选 `softId`，不提交自定义 UA）；注册邀请链接：https://getcaptchasolution.com/4isxcbvw0n
  - 多 key 时按顺序串行降级：默认 `CapSolver → AntiCaptcha → YesCaptcha → 2Captcha`（可用 `TURNSTILE_PROVIDER_ORDER` 覆盖）
  - 单平台连续失败 `TURNSTILE_PROVIDER_MAX_FAILURES`（默认 3）次后切换下一家；全部熔断抛出 `TURNSTILE_ALL_PROVIDERS_FAILED`
  - Telegram 多平台全挂时推送【最高级告警·删机风险】，明确要求当日手动续期
  - 全挂时跳过图形验证码重试，立即上抛；错误摘要截断，避免日志/Telegram 过长
  - 不再「只启用一家」：预埋的备选 key 会在主平台挂掉时真正被使用
  - **AntiCaptcha 域名代理自动 Proxyless**：`PROXY_ADDRESS` 非 IP（如 `proxy.example.com`）时不提交 `TurnstileTask`，避免官方「Only IP addresses are supported」连失败 3 次
  - Telegram 成功/失败通知补充 Turnstile 平台与 failover 摘要；失败代理提示区分浏览器代理与 AntiCaptcha IP 限制

### 修复（2026-07-23）
- **误判「明天到期」为可续期并进入验证码页**（[#5](https://github.com/Silentely/xserver-vps-renew/issues/5)）
  - `isRenewalDue`：纯日期改为按东京日末估算剩余小时，统一走 ≤12h 窗口；不再把「今天或明天」一律判为可续
  - 新增 `detectRenewalWindowBlocked` / `extractRetryAfterFromText`：识别官方「…以降にお試しください」拦截页
  - `handleRenewalConfirm`：index/conf 遇到窗口未开时软跳过并 Telegram 通知（`reasonCode: window_blocked`），不再误等验证码图导致失败
  - **官方面板核对**（已登录，到期 `2026-07-25`）：
    - 列表 `.contract__term` 仍为纯日期 `YYYY-MM-DD`（无时分）
    - 拦截文案在 `/freevps/extend/index` 与 `/freevps/extend/conf` 均会出现；**#5 用户报错 URL 即 conf 纯拦截页**
    - 未开窗时 index 仍可能保留确认按钮，故不能只靠按钮有无判断
    - conf 页无验证码图 / 输入框，仅标题 + 说明 + 戻る
  - 复现日志：剩余约 47h、到期 `2026-07-24` 时曾错误进入 `extend/conf` 并 `waitForSelector img[src^="data:image"]` 超时

### 修复（2026-07-22）
- Trivy 门禁：`brace-expansion` CVE-2026-13149（1.1.15 → 1.1.16，`package.json` overrides）

### 功能（2026-07-22）
- **Telegram 每次执行均推送**（[#4](https://github.com/Silentely/xserver-vps-renew/issues/4)）
  - 新增 `buildSkipNotifyMessage`：无需续期 / 未找到免费 VPS 时推送完整状态（服务器名、到期、剩余小时、判定原因、下次执行）
  - 成功 / 失败 / 跳过通知均支持「执行过程」步骤摘要
  - 新增 `TG_NOTIFY_DETAIL`：`full`（默认，完整摘要含过程）/ `compact`（简洁摘要，仅关键字段）
  - `checkRenewalNeeded` 改为结构化返回 `{ needed, ... }`，跳过路径可携带 VPS 详情

### 功能（2026-07-20）
- **YesCaptcha** 作为 Turnstile 可选备选提供商（`YESCAPTCHA_API_KEY`）
  - 任务类型：`TurnstileTaskProxyless`（默认）/ `TurnstileTaskProxylessM1`
  - 节点：默认 `https://api.yescaptcha.com`，可用 `YESCAPTCHA_API_BASE` 切国内 `https://cn.yescaptcha.com`
  - 优先级：CapSolver > YesCaptcha > 2Captcha
  - createTask 自动附带开发者参数 `softID: 97020`（[getSoftID](https://yescaptcha.atlassian.net/wiki/spaces/YESCAPTCHA/pages/25526273)）
  - 文档参考：[TurnstileTaskProxyless](https://yescaptcha.atlassian.net/wiki/spaces/YESCAPTCHA/pages/61734913)
- README / `.env.example`：CapSolver 注册改为邀请链接 `https://dashboard.capsolver.com/passport/register?inviteCode=qMhzQIY_e_aG`

### 文档（2026-07-16）
- 明确要求配置 **CapSolver API**（`CAPSOLVER_API_KEY`）用于 Turnstile 人机验证；未配置时成功率极低
- 同步 README / CLAUDE / RUNBOOK / `.env.example`：CapSolver 列入必填说明与快速开始示例

### 修复（2026-07-14）
- 成功通知「下次执行」不再写死 +24h：按 `CRON_SCHEDULE` 的 `*/N` 或 `NOTIFY_NEXT_RUN_HOURS`（默认 6）估算
- Docker：`npm ci` 后再 `npm install -g npm@latest`（先装依赖避开 EALLOWREMOTE，再修基础镜像 npm 内嵌 picomatch/sigstore）
- `package-lock.json` 解析源改回 `registry.npmjs.org`
- `.trivyignore`：登记暂无 apt 升级的 curl/Mesa/libxfont2，以及基础镜像 npm 内嵌 picomatch/sigstore CVE

### 适配官方续期规则变更（2026-07-14）
- **4GB 免费 VPS**：最长使用时间 48h → **24h**；可续期窗口 剩余 24h → **剩余 ≤12h**
- `src/renewal-logic.mjs`：新增 `FREE_VPS_MAX_HOURS` / `RENEWAL_WINDOW_HOURS`；`isRenewalDue` 支持含时分的精确剩余小时判定
- `CAPTCHA_API` 默认公共端点：`https://captcha-120546510085.asia-northeast1.run.app`（仍可用环境变量覆盖）
- `docker-compose.yml` 默认 `CRON_SCHEDULE` 改为每 6 小时（`0 */6 * * *`），避免 12h 续期窗口被错过
- 文档同步：README / CLAUDE / RUNBOOK / `.env.example`

### 优化（2026-07-11）
- 新增 `src/renewal-logic.mjs`：到期判定、续期 URL、提交结果解析、到期日提取、通知文案纯函数化
- 超时/重试环境变量：`NAVIGATION_TIMEOUT_MS` / `TURNSTILE_TIMEOUT_MS` / `TURNSTILE_API_TIMEOUT_MS` / `CAPTCHA_MAX_RETRY`
- `CAPTCHA_API` URL 合法性校验；`parsePositiveInt` 统一环境变量解析
- Docker：默认状态文件改为 `/data/chrome-profile/renewal-status.json`（与 Chrome 配置同卷持久化）；健康检查兼容 supercronic / 执行中进程
- 单元测试增至 15 文件 / 209+ 用例（含 `renewalLogic` / `injectTurnstileToken`）

### 修复（2026-07-11）
- **关键**：`writeRenewalStatus` / `getRenewalStatus` 未传入 `RENEWAL_STATUS_FILE`，自定义路径实际不生效
- **关键**：`CONFIG.DEFAULT_UA` 未注入 Turnstile 求解，API 任务始终空 UA
- **关键**：`writeRenewalStatus` 目录权限检查 mock 不全导致测试误报「目录不可写」；不可写时现在明确抛错
- 状态写入失败不再拖垮主流程（`persistRenewalRecord` 吞错记日志）
- `countConsecutiveFailures` 正确跳过 `skipped` 记录，避免「无需续期」打断/污染连败统计

### 新增
- `src/utils.mjs`：`maskProxyAddress` / `getTokyoDateString` / `fetchWithTimeout` / `validateRequiredConfig` / `parsePositiveInt`
- `src/renewal-logic.mjs`：续期业务纯逻辑
- 启动时完整配置校验（含 `CAPTCHA_API`、代理完整性、`PROXY_TYPE` 枚举）
- 无需续期时写入 `skipped` 状态记录，便于监控静默检测

### 优化
- captcha / turnstile / Telegram 统一使用 `fetchWithTimeout`，超时错误更可读
- 脱敏逻辑集中复用；提交结果匹配集中维护，避免主脚本内联散落
- 东京日期计算抽为纯函数，便于单测

### 文档
- 同步 README / CLAUDE / RUNBOOK / `.env.example`：超时变量、`/data` 挂载、测试规模

### 变更（2026-06-30 起累计）
- 核心脚本模块化重构：拆分为 `src/captcha.mjs`、`src/turnstile.mjs`、`src/renewal-status.mjs` 三个独立模块
- 主脚本精简为编排入口（约 1694 行 → 约 1155 行）
- 验证码模块函数签名改为纯函数（接收 `config`/`logger` 参数，不再依赖全局变量）
- Turnstile 模块函数签名改为纯函数（同上）
- 监控持久化模块独立导出常量（`DEFAULT_STATUS_FILE`、`DEFAULT_ALERT_AFTER_FAILURES`）
- Docker 改用非 root 用户 `appuser` + supercronic 替代系统 cron

### 新增
- 续期结果持久化功能（`renewal-status.mjs`），自动记录每次续期时间、结果、到期日
- 告警升级逻辑：连续失败 ≥N 次（`ALERT_AFTER_FAILURES`）时 Telegram 告警附加升级标记
- `RENEWAL_STATUS_FILE` 环境变量（自定义持久化文件路径）
- `ALERT_AFTER_FAILURES` 环境变量（自定义告警升级阈值）
- Vitest 单元测试（当前 13 文件 / 169 用例），覆盖 `src/` 与主脚本纯函数
- `buildTurnstileTask()` 和 `maskTaskForLog()` 从 `solveTurnstileViaAPI` 提取为独立纯函数
- CI 增强：shellcheck 静态分析 + 单元测试自动运行 + 覆盖率门禁（branches ≥25%，functions/lines/statements ≥28%）
- `vitest.config.mjs` 覆盖率覆盖范围扩展到 `src/**/*.mjs` 与 `xserver-vps-renew.mjs`

### 测试
- 新增 `findChromePath.test.mjs`（5 cases）— Chrome 路径搜索逻辑
- 新增 `cleanChromeLocks.test.mjs`（6 cases）— 锁文件清理逻辑
- 新增 `normalizeCaptchaCode.edge.test.mjs`（22 cases）— 验证码标准化边界条件
- 新增 `buildTurnstileTask.test.mjs`（25 cases）— Turnstile 参数构建 + 日志 mask
- 新增 `renewalStatus.test.mjs`（28 cases）— 续期持久化 + 健康检查 + 告警判断
- 新增 `captcha.recognize.test.mjs`、`turnstile.extract.test.mjs`、`turnstile.solve.test.mjs` — API 识别 / 参数提取 / 求解路径
- 已有测试迁移至直接从 `src/` 模块导入

## [2.0.0] - 2026-06-20

### 变更
- 移除废弃的 Google Vision 和 OCR.space OCR 服务，仅保留 Keras 模型 API
- 重命名 `recognizeCaptchaWithBaiduOCR` → `recognizeCaptchaWithKerasAPI`
- 代理凭据日志脱敏
- 添加 renewUrl 来源域名验证
- Canvas 指纹噪声添加边界值检查
- Telegram 通知添加 10 秒超时
- main() 添加直接执行判断，支持 import 测试
- 添加 CONFIG 基础输入验证
- 添加 node: 协议前缀
- 提取 getTurnstileToken 辅助函数消除代码重复
- 提取 HAS_PROXY 常量消除重复计算

### 新增
- `.dockerignore` 文件
- Docker HEALTHCHECK 配置
- CI 添加脚本语法验证步骤（node --check, bash -n）
- CI 添加 Trivy 镜像安全扫描
- docker-compose 日志轮转配置
- CHANGELOG.md
- RUNBOOK.md 故障排查手册
- Vitest 测试框架及单元测试

### 修复
- 修复 cron-run.sh 的 `set -e` 导致定时任务静默失败
- 修复 entrypoint.sh 中不可达代码
- 修复 Turnstile 重试时间窗口（模运算 → 显式计时器）
- 修复 DST 不安全的日期计算
- 修复 `waitForNav` 静默吞没错误
- 移除 Dockerfile 中的凭据 ENV 声明
- cron-run.sh 添加重试逻辑和 flock 互斥锁
- .env.cron 权限收紧（chmod 600）
- README 文档与实际实现同步

### 移除
- `recognizeCaptchaWithGoogleVision` 函数（废弃）
- `recognizeCaptchaWithOCRSpace` 函数（废弃）
- `withTimeout` 函数（死代码）
- `WINDOWS_UA` 常量（未使用）
- `GOOGLE_VISION_API_KEY` 配置项
- `OCRSPACE_API_KEY` 配置项
- `start:launch` 无效脚本
