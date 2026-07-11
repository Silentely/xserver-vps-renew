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
docker exec xserver-vps-renew du -sh /tmp
# 续期状态文件（默认与 Chrome 配置同目录，compose 已挂载 chrome-data 卷）
docker exec xserver-vps-renew ls -la /data/chrome-profile/renewal-status.json 2>/dev/null || true
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
| `配置校验失败: XSERVER_MEMBER_ID` 等 | 必填环境变量缺失 | 检查 `.env` 中 `XSERVER_MEMBER_ID` / `XSERVER_PASSWORD` / `CAPTCHA_API` |
| `代理配置不完整` | 只配了部分 `PROXY_*` | 同时设置 `PROXY_TYPE` + `PROXY_ADDRESS` + `PROXY_PORT` |
| `目录 ... 不可写` | 状态文件目录无写权限 | 挂载 `/data` 且确保容器用户 `appuser` 可写 |
| `登录失败` | 凭据错误 | 检查会员ID和密码 |
| `Keras 模型 API 响应 503` / `请求超时` | Cloud Run 冷启动或网络 | 等待后重试；检查 `CAPTCHA_API` 可达性 |
| `Turnstile 等待超时` / `未配置 Turnstile 求解 API` | Cloudflare 拦截或未配密钥 | 配置 `CAPSOLVER_API_KEY` 或住宅代理 |
