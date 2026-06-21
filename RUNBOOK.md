# Runbook — 故障排查手册

## 检查上次续期是否成功

```bash
docker logs --tail 50 xserver-vps-renew | grep -E "(✅|❌)"
```

## 手动触发续期

```bash
docker compose run --rm -e CRON_SCHEDULE= xserver-renew --once
```

## 回滚到上一个镜像版本

```bash
# 查看可用的镜像版本
docker images ghcr.io/silentely/xserver-vps-renew

# 修改 docker-compose.yml 中的镜像标签为特定 SHA
# 然后重新启动
docker compose pull && docker compose up -d
```

## 轮换凭据

1. 更新 `.env` 文件中的相关变量
2. 重启容器：`docker compose restart`

## 检查磁盘空间

```bash
docker exec xserver-vps-renew du -sh /data/chrome-profile
docker exec xserver-vps-renew du -sh /app/screenshots
```

## Chrome 僵尸进程

```bash
docker exec xserver-vps-renew pgrep -f chrome
# 如果无输出，说明无 Chrome 进程，重启容器
docker compose restart
```

## 常见错误

| 错误信息 | 原因 | 解决方案 |
|----------|------|----------|
| `请设置环境变量 XSERVER_MEMBER_ID 和 XSERVER_PASSWORD` | .env 未配置 | 检查 .env 文件 |
| `登录失败` | 凭据错误 | 检查会员ID和密码 |
| `Keras 模型 API 响应 503` | Cloud Run 冷启动 | 等待后重试 |
| `Turnstile 等待超时` | Cloudflare 检测到自动化 | 配置代理或 CapSolver API |
