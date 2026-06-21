# Changelog

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
