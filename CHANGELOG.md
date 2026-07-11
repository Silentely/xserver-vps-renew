# Changelog

## [Unreleased]

### 文档
- 同步 README / CLAUDE / RUNBOOK：默认 cron 时间（东京 23:00）、supercronic、非 root `appuser`、截图路径 `/tmp`、测试规模（12 文件 / 147 用例）与覆盖率门禁

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
- Vitest 单元测试（当前 12 文件 / 147 用例），覆盖 `src/` 与主脚本纯函数
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
