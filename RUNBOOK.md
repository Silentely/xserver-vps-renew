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
| `配置校验失败: XSERVER_MEMBER_ID` 等 | 必填环境变量缺失 | 检查 `.env` 中 `XSERVER_MEMBER_ID` / `XSERVER_PASSWORD`（`CAPTCHA_API` 有默认公共端点，一般可不配） |
| `未配置任何 Turnstile 打码平台` | 未配置 Turnstile 求解 | **配置 `CAPSOLVER_API_KEY`**；并建议再配 `ANTICAPTCHA_API_KEY` 等第二家 |
| `Turnstile 多平台均失败` / `TURNSTILE_ALL_PROVIDERS_FAILED` | 已配置平台全部熔断（常见于 CF 大更新） | **当日立即人工登录官网续期**；检查各平台余额与状态；平台恢复后等下次 cron |
| `代理配置不完整` | 只配了部分 `PROXY_*` | 同时设置 `PROXY_TYPE` + `PROXY_ADDRESS` + `PROXY_PORT` |
| `目录 ... 不可写` | 状态文件目录无写权限 | 挂载 `/data` 且确保容器用户 `appuser` 可写 |
| `登录失败` | 凭据错误 | 检查会员ID和密码 |
| `Keras 模型 API 响应 503` / `请求超时` | Cloud Run 冷启动或网络 | 等待后重试；检查 `CAPTCHA_API`（默认或自建）可达性 |
| `Turnstile 等待超时` / `未配置 Turnstile 求解 API` | 未配打码平台或 Cloudflare 拦截 | **配置至少 1 家 API key** 并确认余额；可选住宅代理 |
| CapSolver / Anti-Captcha 求解失败 / 余额错误 | 密钥无效或欠费 | 检查对应平台 Key 与余额；有第二家 key 时会自动 failover |
| `Proxy address 'xxx' is invalid. Only IP addresses are supported` | AntiCaptcha 收到了域名代理（旧版行为） | 升级到含「域名自动 Proxyless」的版本；或把 `PROXY_ADDRESS` 改为 IP；浏览器域名代理可保留 |
| `AntiCaptcha …自动改用 TurnstileTaskProxyless` 后 `認証に失敗` | 域名代理无法提交给 AntiCaptcha 带代理任务 → Proxyless token 的 IP 与浏览器出口不一致 | **推荐**：把 `TURNSTILE_PROVIDER_ORDER` 以 CapSolver 为首；或把 `PROXY_ADDRESS` 改为 **IP** 让 AntiCaptcha 走 `TurnstileTask`；紧急时人工续期 |
| `UA 不匹配` / `对齐 UA 失败` / 旧版 `setUserAgentOverride: Target closed` | 打码平台返回的 UA 与浏览器 DEFAULT_UA 不同；rebrowser 下改 UA 可能关掉 target | 新版本会**先注入 token 再改 UA**，UA 失败不阻断提交。若仍认证失败，优先查 Proxyless IP 不一致 |
| `Turnstile 未通过，跳过提交` | API 求解/注入失败，脚本不再强行点提交 | 看 failover 是否切到下一家；检查 key/余额/网络；勿把「未提交」当成图形码识别错误 |
| `Waiting for selector img[src^="data:…"]` 超时（重试中） | 直接打开裸 `/extend/conf` 或窗口拦截页，无 Base64 验证码图 | 新版本重试会回到 `index?id_vps=` 再进 conf。若仍超时：查是否未进 12h 窗口、会话是否掉线 |
| 长期 `无需续期` 后 VPS 被回收 | 调度过稀，错过 12h 窗口 | 4GB 最长 24h、剩余 ≤12h 才可续；将 `CRON_SCHEDULE` 设为至少 `0 */6 * * *` |

### Anti-Captcha 专项（域名代理 / Proxyless）

1. 浏览器可用 `PROXY_ADDRESS=proxy.example.com` 等域名；**AntiCaptcha 带代理任务官方只认 IP**。  
2. 脚本检测到域名后自动 `TurnstileTaskProxyless`：token 在工人侧 IP 解出，浏览器仍走你的代理 → **出口 IP 不一致**，易 `認証に失敗`。  
3. 生产建议：  
   - 主平台用 **CapSolver**（默认顺序第一）；AntiCaptcha 作备份；或  
   - 若坚持 AntiCaptcha + 同 IP：把住宅代理解析为 IP 写入 `PROXY_ADDRESS`。  
4. 不要把 AntiCaptcha 单独放在 `TURNSTILE_PROVIDER_ORDER` 第一位且同时使用域名代理——日志里「求解成功」≠「官网会接受 token」。

## 配置检查清单

生产 / Docker 部署前请确认：

1. `XSERVER_MEMBER_ID`、`XSERVER_PASSWORD` 已填写  
2. **至少 1 家 Turnstile key**（推荐 `CAPSOLVER_API_KEY`）  
3. **强烈建议第 2 家**（如 `ANTICAPTCHA_API_KEY`）实现 failover  
4. 各打码平台账户有可用余额  
5. `CRON_SCHEDULE` 至少每 6 小时一次（适配 12h 续期窗口）
