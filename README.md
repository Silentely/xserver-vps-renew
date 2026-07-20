# Xserver VPS 自动续期

自动为 [Xserver](https://vps.xserver.ne.jp/) 免费 VPS 续期：在可续期窗口内完成登录、验证码识别与提交。

> **官方 4GB 规则（2026-07 起）**  
> - 最长使用时间：**24 小时**（原 48 小时）  
> - 可续期条件：剩余使用时间 **≤ 12 小时**（原 ≤ 24 小时）  
> 建议至少每 6 小时检查一次，避免错过 12 小时窗口。

## ✨ 功能特性

- ✅ 自动检测免费 VPS 到期状态，进入剩余 ≤12 小时窗口时执行续期
- ✅ **Puppeteer Stealth + rebrowser** 反检测技术栈
- ✅ **浏览器指纹优化** - 基于真实浏览器指纹数据，提升 Turnstile 通过率
- ✅ **图形验证码识别** - Keras 模型 API（Cloud Run，准确率 95%+；内置默认端点，可自建覆盖）
- ✅ **平假名智能转换** - 自动识别并转换日语平假名数字验证码
- ✅ Cloudflare Turnstile 人机验证：
  - **CapSolver API（必须配置）**：`CAPSOLVER_API_KEY`，使用 `AntiTurnstileTaskProxyLess`；**未配置时成功率极低**；[注册邀请链接](https://dashboard.capsolver.com/passport/register?inviteCode=qMhzQIY_e_aG)
  - **YesCaptcha API**（备选）：配置 `YESCAPTCHA_API_KEY` 后使用 `TurnstileTaskProxyless`（国内节点友好；自动附带 `softID: 97020`）
  - **2Captcha API**（备选）：配置 `TWOCAPTCHA_API_KEY` 后使用 `TurnstileTask` 或 `TurnstileTaskProxyless`
  - **降级**：无 API 密钥时等待自然通过（Docker / 无头环境几乎不可用，**不建议**）
- ✅ Telegram 通知，续期结果即时推送
- ✅ Docker 部署，内置 supercronic 定时调度，开箱即用

## 🚀 快速开始

### Docker 部署（推荐）

```bash
# 1. 创建配置
mkdir xserver-vps-renew && cd xserver-vps-renew

# 2. 下载 docker-compose.yml
curl -O https://raw.githubusercontent.com/Silentely/xserver-vps-renew/main/docker-compose.yml

# 3. 创建环境变量
# 必填：XSERVER_MEMBER_ID、XSERVER_PASSWORD、CAPSOLVER_API_KEY（Turnstile，否则成功率极低）
cat > .env <<EOF
XSERVER_MEMBER_ID=你的会员ID
XSERVER_PASSWORD=你的密码

# Turnstile 人机验证（必须配置 CapSolver，否则成功率极低）
# 注册（邀请链接）：https://dashboard.capsolver.com/passport/register?inviteCode=qMhzQIY_e_aG
CAPSOLVER_API_KEY=你的CapSolver密钥

# 验证码识别（可选；不填则使用内置默认公共端点）
# CAPTCHA_API=https://captcha-120546510085.asia-northeast1.run.app
EOF

# 4. 启动容器（默认每 6 小时检查一次，见 docker-compose.yml 中 CRON_SCHEDULE）
docker compose up -d

# 5. 查看日志
docker logs -f xserver-vps-renew
```

### 本地运行

需要 Node.js 22+ 和 Chrome 浏览器：

```bash
git clone https://github.com/Silentely/xserver-vps-renew.git
cd xserver-vps-renew
npm install

# 设置环境变量
export XSERVER_MEMBER_ID="你的会员ID"
export XSERVER_PASSWORD="你的密码"
# Turnstile 必须配置 CapSolver，否则成功率极低
# 注册（邀请链接）：https://dashboard.capsolver.com/passport/register?inviteCode=qMhzQIY_e_aG
export CAPSOLVER_API_KEY="你的CapSolver密钥"
# CAPTCHA_API 可选，默认公共端点
# export CAPTCHA_API="https://your-own-captcha-api.example.com"

# 运行脚本
node xserver-vps-renew.mjs
```

## 📊 工作流程

```
登录 → 检查到期日 → 续期申请 → 验证码识别（Keras API） → Turnstile 通过 → 提交
```

### 验证码识别策略

**Keras 模型 API**（Cloud Run 部署）：
- 使用训练好的 Keras 模型识别日文平假名数字验证码
- 部署在 Google Cloud Run（无服务器）
- 准确率：95%+
- 响应速度：0.5 秒
- 成本：完全免费（Cloud Run 免费额度内）
- 自动识别失败重试（最多 3 次）

> `CAPTCHA_API` 可选。未设置时使用默认公共端点 `https://captcha-120546510085.asia-northeast1.run.app`；也可指向自建 Cloud Run。格式：POST 请求，body = 原始 base64 图片，response = 纯文本 6 位验证码。

### Turnstile 求解策略

> ⚠️ **必须配置 CapSolver API**（`CAPSOLVER_API_KEY`）用于 Cloudflare Turnstile 人机验证。  
> 未配置时脚本会降级为等待自然通过，**成功率极低**（尤其 Docker / 无头环境几乎必然失败）。费用约 **~$0.0015–0.002/次**，按每 6 小时续期约 **$0.06/月**。

Docker / 生产环境下直接使用 API 求解（跳过自然通过，因为自动化浏览器通过率很低）。优先级（只启用一家）：

1. **CapSolver API（必须 / 优先）**：配置 `CAPSOLVER_API_KEY` 后使用 `AntiTurnstileTaskProxyLess`。注册：[CapSolver（邀请链接）](https://dashboard.capsolver.com/passport/register?inviteCode=qMhzQIY_e_aG)
2. **YesCaptcha API**（备选）：无 CapSolver 时配置 `YESCAPTCHA_API_KEY`，使用 `TurnstileTaskProxyless`（可选 `TurnstileTaskProxylessM1`）；国际节点 `https://api.yescaptcha.com`，国内可用 `YESCAPTCHA_API_BASE=https://cn.yescaptcha.com`。文档：[YesCaptcha Turnstile](https://yescaptcha.atlassian.net/wiki/spaces/YESCAPTCHA/pages/61734913)。请求会自动附带开发者参数 `softID: 97020`（[getSoftID 说明](https://yescaptcha.atlassian.net/wiki/spaces/YESCAPTCHA/pages/25526273)）
3. **2Captcha API**（备选）：无 CapSolver / YesCaptcha 时可用 `TWOCAPTCHA_API_KEY`（`TurnstileTask` / `TurnstileTaskProxyless`）
4. **降级（不推荐）**：无任何 Turnstile API 密钥时等待自然通过——**成功率极低，请勿在生产环境依赖此模式**

## ⚙️ 环境变量

### 必填

| 变量 | 说明 |
|------|------|
| `XSERVER_MEMBER_ID` | Xserver 会员 ID |
| `XSERVER_PASSWORD` | Xserver 密码 |
| `CAPSOLVER_API_KEY` | **CapSolver API 密钥（必须）**：Turnstile 人机验证。未配置时成功率极低。注册：[CapSolver（邀请链接）](https://dashboard.capsolver.com/passport/register?inviteCode=qMhzQIY_e_aG) |

### 验证码识别

| 变量 | 默认值 | 说明 | 费用 |
|------|--------|------|------|
| `CAPTCHA_API` | `https://captcha-120546510085.asia-northeast1.run.app` | Keras 模型 API（Cloud Run；可覆盖为自建端点） | 完全免费 |

### 可选 - Turnstile 备选

| 变量 | 说明 |
|------|------|
| `YESCAPTCHA_API_KEY` | YesCaptcha API 密钥（无 CapSolver 时的备选；注册：[yescaptcha.com](https://yescaptcha.com/)，`TurnstileTaskProxyless`；内置 `softID: 97020`） |
| `YESCAPTCHA_API_BASE` | YesCaptcha API 节点（可选，默认 `https://api.yescaptcha.com`；国内可用 `https://cn.yescaptcha.com`） |
| `YESCAPTCHA_TASK_TYPE` | 任务类型（可选，默认 `TurnstileTaskProxyless`；或 `TurnstileTaskProxylessM1`） |
| `TWOCAPTCHA_API_KEY` | 2Captcha API 密钥（无 CapSolver / YesCaptcha 时的备选；注册：https://2captcha.com/，仅用于 Turnstile） |

### 可选 - Telegram 通知

| 变量 | 说明 |
|------|------|
| `TG_BOT_TOKEN` | Telegram Bot Token（从 @BotFather 获取） |
| `TG_CHAT_ID` | Telegram Chat ID（从 @userinfobot 获取） |

### 可选 - 代理配置

| 变量 | 说明 |
|------|------|
| `PROXY_TYPE` | http / socks4 / socks5 |
| `PROXY_ADDRESS` | 代理 IP 或域名 |
| `PROXY_PORT` | 代理端口 |
| `PROXY_LOGIN` | 代理用户名（可选） |
| `PROXY_PASSWORD` | 代理密码（可选） |

### 可选 - 定时调度

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CRON_SCHEDULE` | 未设置（不启用定时）；compose 默认 `0 */6 * * *` | Cron 表达式，使用容器本地时间（由 TZ 控制）。**4GB 最长 24h / 剩余 ≤12h 可续**，建议至少每 6 小时一次（`0 */6 * * *`），勿仅每日一次 |
| `TZ` | `Asia/Tokyo` | 时区，影响 cron 执行时间和日志时间戳 |

### 可选 - 监控与持久化

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RENEWAL_STATUS_FILE` | `/data/chrome-profile/renewal-status.json` | 续期记录持久化文件路径（与 Chrome 配置同卷） |
| `ALERT_AFTER_FAILURES` | `3` | 连续失败达到此次值时，Telegram 告警升级为【告警升级】 |

## 🏗️ 项目结构

```
├── xserver-vps-renew.mjs          # 主脚本（编排入口：浏览器操作 + 流程控制）
├── src/                           # 可复用模块
│   ├── captcha.mjs                # 验证码处理（标准化/识别/平假名转换）
│   ├── turnstile.mjs              # Turnstile 求解（参数构建/API 调用/token 注入）
│   └── renewal-status.mjs         # 续期结果持久化与健康检查
├── browser-fingerprint-patch.js   # 浏览器指纹补丁
├── xserver-renews.js              # 油猴脚本版（浏览器端）
├── turnstile-patch/               # Turnstile 扩展（修复 screenX/Y）
├── __tests__/unit/                 # 单元测试（Vitest）
├── Dockerfile                     # 容器构建文件
├── docker-compose.yml             # 编排配置（定时模式）
├── entrypoint.sh                  # 容器入口
├── diagnostics.sh                 # 容器环境诊断脚本
├── vitest.config.mjs              # 测试配置
├── .env.example                   # 环境变量模板
├── .github/workflows/
│   └── docker-publish.yml         # CI：自动构建 + 测试 + 覆盖率门禁 + 镜像推送
├── CHANGELOG.md                   # 变更日志
└── RUNBOOK.md                     # 故障排查手册
```

## 🐳 Docker 镜像

镜像托管在 GitHub Container Registry，每次推送到 `main` 分支时自动构建：

```bash
# 拉取最新版本
docker pull ghcr.io/silentely/xserver-vps-renew:latest

# 拉取特定 commit 版本
docker pull ghcr.io/silentely/xserver-vps-renew:sha-abc1234
```

### 镜像标签策略

- `latest` - 最新稳定版本
- `sha-<commit>` - 特定 commit 版本（前 7 位）

### 手动触发续期

```bash
# 手动触发一次续期（禁用 cron 模式，仅执行一次）
docker compose run --rm -e CRON_SCHEDULE= xserver-renew --once
```

## 🧪 测试

```bash
# 运行单元测试
npm test

# 覆盖率报告
npm run test:coverage

# 监听模式（开发时）
npm run test:watch
```

测试覆盖 `src/` 模块中的纯函数（验证码标准化、Turnstile 参数构建、续期状态读写等）。浏览器操作流程需集成测试或手动验证。

## 📊 监控

续期结果自动持久化到 `RENEWAL_STATUS_FILE`（默认 `/data/chrome-profile/renewal-status.json`），保留最近 30 条记录：

```json
{
  "records": [
    {
      "timestamp": "2026-06-30T15:00:00.000Z",
      "success": true,
      "serverName": "vps-xxx",
      "plan": "1GB",
      "oldExpireDate": "2026-07-01",
      "newExpireDate": "2026-07-31",
      "errorMessage": null
    }
  ]
}
```

当连续失败次数 ≥ `ALERT_AFTER_FAILURES`（默认 3）时，Telegram 告警会附加 `🚨 【告警升级】` 标记和连续失败次数，提示人工介入。

## 🔧 技术细节

### 反检测技术栈

1. **rebrowser-puppeteer-core** - 修复 CDP Runtime.Enable 泄露
2. **puppeteer-extra-plugin-stealth** - 隐藏自动化特征
3. **浏览器指纹补丁** - 补充真实环境指纹：
   - `navigator.deviceMemory` = 8 GB
   - `navigator.hardwareConcurrency` = 8 核
   - WebGL 渲染器信息
   - Canvas 指纹优化
4. **turnstile-patch 扩展** - 修复 CDP 鼠标事件 screenX/Y 异常

详细技术分析见仓库源码及浏览器指纹补丁实现

### Docker 环境注意事项

- 容器以非 root 用户 `appuser` 运行；Chrome 仍使用 `--no-sandbox` 等参数（镜像与脚本已默认包含）
- `headless: false` 需要 X11 显示服务器；Docker 镜像已内置 Xvfb
- 定时调度使用 **supercronic**（非系统 cron），由 `CRON_SCHEDULE` 控制
- 调试截图写入容器内 `/tmp/`（如 `turnstile-before-solve.png`），默认不挂载到宿主机

## 🐛 故障排查

### 图形验证码识别失败

**症状**：日志中出现 `认证に失敗しました`（认证失败）

**原因**：图形验证码识别错误（6 位平假名数字）

**解决方法**：
1. 确认 `CAPTCHA_API` 可达（默认公共端点或自建 Cloud Run）
2. 检查 Cloud Run 服务是否正常运行（冷启动时可能 503）
3. 查看日志中的识别结果，连续失败可稍后重试

### Turnstile 无法自动通过 / 成功率极低

**症状**：
- 启动日志：`未配置 CAPSOLVER_API_KEY（必须）：Turnstile 人机验证将依赖自然通过，成功率极低...`
- 或：`Turnstile 等待超时` / `未配置 Turnstile 求解 API`

**可能原因**：
1. **未配置 `CAPSOLVER_API_KEY`（最常见）** — 自然通过在 Docker 中几乎不可用
2. CapSolver 余额不足或密钥无效
3. IP 地址被 Cloudflare 标记
4. Docker 环境 GPU / 指纹信息异常

**解决方法**：
1. **必须**：在 `.env` 中配置 `CAPSOLVER_API_KEY`（[注册 CapSolver（邀请链接）](https://dashboard.capsolver.com/passport/register?inviteCode=qMhzQIY_e_aG)）并重启容器
2. 检查 CapSolver 控制台余额是否充足
3. 可选：配置住宅代理提升网络侧通过率
4. 无法使用 CapSolver 时，可改配 `YESCAPTCHA_API_KEY`（[YesCaptcha](https://yescaptcha.com/)，国内可用 `YESCAPTCHA_API_BASE=https://cn.yescaptcha.com`）或 `TWOCAPTCHA_API_KEY` 作为备选

## 💰 成本估算

| 服务 | 用途 | 免费额度 | 超额成本 | 每月成本（约 30 次） |
|------|------|---------|---------|---------------------|
| Keras 模型 API | 验证码识别（Cloud Run） | 有免费额度 | $0 | **$0** |
| CapSolver | **Turnstile 验证（必须配置）** | — | ~$0.002/次 | **~$0.06** |
| YesCaptcha | Turnstile 验证（备选，国内友好） | 约 25 点/次 | 按官方点数 | 按充值计 |
| 2Captcha | Turnstile 验证（备选） | — | ~$0.002/次 | ~$0.06 |

**总计**：
- **推荐 / 生产配置**（Keras 模型 API + **CapSolver**）：**约 $0.06/月**
- 不配置 Turnstile API 虽“免费”，但 **成功率极低，不建议**，尤其 Docker 部署几乎无法完成续期

## 📜 许可证

MIT

---

**祝续期顺利！如有问题欢迎提 Issue 🎉**
