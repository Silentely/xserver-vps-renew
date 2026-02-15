# Xserver VPS 自动续期

自动为 [Xserver](https://vps.xserver.ne.jp/) 免费 VPS 续期，到期前一天自动完成登录、验证码识别与提交。

## 功能特性

- 自动检测免费 VPS 到期日，仅在到期前一天执行续期
- 通过 Playwright CDP 连接真实 Chrome，完整模拟用户操作
- 支持验证码自动识别（调用外部 API）
- 支持 Cloudflare Turnstile 人机验证自动处理
- 可选 Telegram 通知，续期结果即时推送
- 支持 Docker 部署，内置 cron 定时调度
- 附带油猴脚本版本，可在浏览器中手动触发

## 工作流程

```
登录 → 检查到期日 → 续期申请 → 验证码识别 → Turnstile 通过 → 提交
```

## 快速开始

### Docker 部署（推荐）

1. 克隆仓库并配置环境变量：

```bash
git clone https://github.com/Silentely/xserver-vps-renew.git
cd xserver-vps-renew
cp .env.example .env
```

2. 编辑 `.env` 填入 Xserver 登录凭据：

```env
XSERVER_MEMBER_ID=你的会员ID
XSERVER_PASSWORD=你的密码
```

3. 运行：

```bash
# 单次执行
docker compose run --rm xserver-renew

# 定时模式（每天东京时间 08:00 自动执行）
docker compose up -d xserver-renew-cron
```

### 本地运行

需要 Node.js 22+ 和 Chrome 浏览器。

```bash
npm install

# 方式 A：先手动启动 Chrome，再运行脚本
google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.config/xserver-chrome
node xserver-vps-renew.mjs

# 方式 B：脚本自动启动 Chrome
node xserver-vps-renew.mjs --launch
```

### 油猴脚本

`xserver-renews.js` 是 [Greasy Fork](https://greasyfork.org/scripts/554644) 上发布的油猴脚本版本，安装后每天访问一次 Xserver 面板即可自动续期。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `XSERVER_MEMBER_ID` | 是 | - | Xserver 会员 ID |
| `XSERVER_PASSWORD` | 是 | - | Xserver 密码 |
| `CAPTCHA_API` | 否 | 内置地址 | 验证码识别 API 地址 |
| `CDP_URL` | 否 | `http://127.0.0.1:9222` | Chrome CDP 调试地址 |
| `TG_BOT_TOKEN` | 否 | - | Telegram Bot Token（启用通知） |
| `TG_CHAT_ID` | 否 | - | Telegram Chat ID（启用通知） |
| `CRON_SCHEDULE` | 否 | - | Cron 表达式，设置后启用定时模式 |
| `TZ` | 否 | `Asia/Tokyo` | 时区 |
| `CHROME_PATH` | 否 | 自动检测 | Chrome 可执行文件路径 |
| `CHROME_USER_DATA` | 否 | `/tmp/xserver-chrome-profile` | Chrome 用户数据目录 |

## 项目结构

```
├── xserver-vps-renew.mjs  # 主脚本（Playwright CDP 版）
├── xserver-renews.js      # 油猴脚本版（浏览器端）
├── Dockerfile             # 容器构建文件
├── docker-compose.yml     # 编排配置（单次 / 定时两种模式）
├── entrypoint.sh          # 容器入口（管理 Chrome 和 cron 生命周期）
├── .env.example           # 环境变量模板
└── package.json           # 依赖声明
```

## 许可证

MIT
