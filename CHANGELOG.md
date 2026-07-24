# Changelog

## [Unreleased]

### 功能（2026-07-24）
- **Turnstile 多平台 failover + Anti-Captcha**
  - 新增 `ANTICAPTCHA_API_KEY`：按 [Anti-Captcha 官方文档](https://anti-captcha.com/apidoc/task-types/TurnstileTaskProxyless) 调用 `TurnstileTaskProxyless` / `TurnstileTask`（字段 `cData`/`chlPageData`，createTask 可选 `softId`，不提交自定义 UA）
  - 多 key 时按顺序串行降级：默认 `CapSolver → AntiCaptcha → YesCaptcha → 2Captcha`（可用 `TURNSTILE_PROVIDER_ORDER` 覆盖）
  - 单平台连续失败 `TURNSTILE_PROVIDER_MAX_FAILURES`（默认 3）次后切换下一家；全部熔断抛出 `TURNSTILE_ALL_PROVIDERS_FAILED`
  - Telegram 多平台全挂时推送【最高级告警·删机风险】，明确要求当日手动续期
  - 全挂时跳过图形验证码重试，立即上抛；错误摘要截断，避免日志/Telegram 过长
  - 不再「只启用一家」：预埋的备选 key 会在主平台挂掉时真正被使用

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

### 第二轮打磨（2026-07-11）
- 新增 `src/renewal-logic.mjs`：到期判定、续期 URL、提交结果解析、到期日提取、通知文案纯函数化
- 超时/重试环境变量：`NAVIGATION_TIMEOUT_MS` / `TURNSTILE_TIMEOUT_MS` / `TURNSTILE_API_TIMEOUT_MS` / `CAPTCHA_MAX_RETRY`
- `CAPTCHA_API` URL 合法性校验；`parsePositiveInt` 统一环境变量解析
- Docker：默认状态文件改为 `/data/chrome-profile/renewal-status.json`（与 Chrome 配置同卷持久化）；健康检查兼容 supercronic / 执行中进程
- 单元测试增至 15 文件 / 209+ 用例（含 `renewalLogic` / `injectTurnstileToken`）

### 修复（2026-07-11 第一轮）
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
