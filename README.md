# Xserver VPS 自动续期

自动为 [Xserver](https://vps.xserver.ne.jp/) 免费 VPS 续期，到期前一天自动完成登录、验证码识别与提交。

## ✨ 功能特性

- ✅ 自动检测免费 VPS 到期日，仅在到期前一天执行续期
- ✅ **Puppeteer Stealth + rebrowser** 反检测技术栈
- ✅ **浏览器指纹优化** - 基于真实浏览器指纹数据，提升 Turnstile 通过率
- ✅ **图形验证码 OCR 识别** - 使用 Keras 模型识别（Cloud Run API，准确率 95%+，完全免费）
- ✅ **平假名智能转换** - 自动识别并转换日语平假名数字验证码
- ✅ Cloudflare Turnstile 人机验证双策略：
  - **策略 1**：点击 checkbox 自然通过（优先）
  - **策略 2**：API 求解（降级）
- ✅ Telegram 通知，续期结果即时推送
- ✅ Docker 部署，内置 cron 定时调度，开箱即用

## 🚀 快速开始

### Docker 部署（推荐）

```bash
# 1. 创建配置
mkdir xserver-vps-renew && cd xserver-vps-renew

# 2. 下载 docker-compose.yml
curl -O https://raw.githubusercontent.com/Silentely/xserver-vps-renew/main/docker-compose.yml

# 3. 创建环境变量（至少配置一个 OCR 服务）
cat > .env <<EOF
XSERVER_MEMBER_ID=你的会员ID
XSERVER_PASSWORD=你的密码

# 验证码识别（推荐配置 Google Vision 或 OCR.space）
GOOGLE_VISION_API_KEY=你的Google密钥  # 推荐，准确率最高
# OCRSPACE_API_KEY=你的OCRspace密钥  # 备选，免费额度大
EOF

# 4. 启动容器（每天东京时间 08:00 自动执行）
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
export GOOGLE_VISION_API_KEY="你的Google密钥"  # 或 OCRSPACE_API_KEY

# 运行脚本
node xserver-vps-renew.mjs
```

## 📊 工作流程

```
登录 → 检查到期日 → 续期申请 → 验证码识别（OCR 并行） → Turnstile 通过 → 提交
```

### 验证码识别策略

**Keras 模型 API**（Cloud Run 部署，完全免费）：
- 使用训练好的 Keras 模型识别日文平假名数字验证码
- 部署在 Google Cloud Run（无服务器）
- 准确率：95%+
- 响应速度：0.5 秒
- 成本：完全免费（Cloud Run 免费额度内）
- 自动识别失败重试（最多 3 次）
- 未来可优化：内置 TensorFlow.js 模型到 Docker 实现离线推理

### Turnstile 双策略

1. **策略 1**：尝试点击 Turnstile checkbox 让其自然通过（3-15秒）
   - 使用 rebrowser-puppeteer + Stealth 插件
   - 注入真实浏览器指纹（deviceMemory、WebGL、Canvas 等）
   - 成功率：30-70%（优化后）

2. **策略 2**：API 求解（策略 1 失败时降级）
   - 支持 CapSolver 和 2Captcha
   - 自动提取 sitekey 并调用 API
   - 成功率：>90%

## ⚙️ 环境变量

### 必填

| 变量 | 说明 |
|------|------|
| `XSERVER_MEMBER_ID` | Xserver 会员 ID |
| `XSERVER_PASSWORD` | Xserver 密码 |

### 验证码识别

| 变量 | 说明 | 费用 |
|------|------|------|
| `CAPTCHA_API` | Keras 模型 API（Cloud Run 部署，已内置默认值，无需配置） | 完全免费 |

### 可选 - Turnstile API 求解

| 变量 | 说明 |
|------|------|
| `CAPSOLVER_API_KEY` | CapSolver API 密钥（推荐，注册：https://www.capsolver.com/） |
| `TWOCAPTCHA_API_KEY` | 2Captcha API 密钥（备选，注册：https://2captcha.com/，仅用于 Turnstile） |

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
| `CRON_SCHEDULE` | 未设置（不启用定时） | Cron 表达式，使用容器本地时间（由 TZ 控制）<br>示例：`0 8 * * *` = 每天东京时间 08:00<br>示例：`0 23 * * *` = 每天东京时间 23:00 |
| `TZ` | `Asia/Tokyo` | 时区，影响 cron 执行时间和日志时间戳 |

## 🏗️ 项目结构

```
├── xserver-vps-renew.mjs          # 主脚本（Puppeteer Stealth 版）
├── browser-fingerprint-patch.js   # 浏览器指纹补丁
├── xserver-renews.js              # 油猴脚本版（浏览器端）
├── turnstile-patch/               # Turnstile 扩展（修复 screenX/Y）
├── Dockerfile                     # 容器构建文件
├── docker-compose.yml             # 编排配置（定时模式）
├── entrypoint.sh                  # 容器入口
├── .env.example                   # 环境变量模板
├── .github/workflows/
│   └── docker-publish.yml         # CI：自动构建并推送镜像
└── TURNSTILE-ANALYSIS.md          # Turnstile 技术分析文档
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

详细技术分析：[TURNSTILE-ANALYSIS.md](./TURNSTILE-ANALYSIS.md)

## 🐛 故障排查

### 图形验证码识别失败

**症状**：日志中出现 `认证に失敗しました`（认证失败）

**原因**：图形验证码识别错误（6 位平假名数字）

**解决方法**：
1. 确保已配置至少一个 OCR 服务：
   - `GOOGLE_VISION_API_KEY`（推荐，准确率最高）
   - `OCRSPACE_API_KEY`（备选，免费额度大）
2. 检查 API 密钥是否有效和余额充足
3. 查看日志中的投票结果，如有全分歧情况说明验证码质量较差

**注册地址**：
- Google Cloud Vision: https://console.cloud.google.com/
- OCR.space: https://ocr.space/ocrapi

### Turnstile 无法自动通过

**症状**：日志中出现 `策略 2：使用 CapSolver API 求解 Turnstile`

**可能原因**：
1. IP 地址被 Cloudflare 标记
2. Docker 环境 GPU 信息缺失

**解决方法**：
1. 配置代理（住宅 IP 更佳）
2. 配置 Turnstile API 密钥（CapSolver 或 2Captcha）

## 💰 成本估算

| 服务 | 用途 | 免费额度 | 超额成本 | 每月成本（30次） |
|------|------|---------|---------|----------------|
| 服务 | 用途 | 免费额度 | 超额成本 | 每月成本（30次） |
|------|------|---------|---------|----------------|
| Keras 模型 API | 验证码识别（Cloud Run） | 无限制 | $0 | **$0**（完全免费） |
| CapSolver | Turnstile 验证（推荐） | 无 | ~$0.002/次 | ~$0.06 |
| 2Captcha | Turnstile 验证（备选） | 无 | ~$0.002/次 | ~$0.06 |

**总计**：
- **推荐配置**（Keras 模型 API + CapSolver）：**~$0.06/月**
- **完全免费**（仅 Keras 模型 API，无 Turnstile API）：**$0/月**

## 📜 许可证

MIT

---

**祝续期顺利！如有问题欢迎提 Issue 🎉**
