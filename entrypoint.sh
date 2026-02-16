#!/bin/bash
set -e

LOG_PREFIX="[entrypoint]"

# ============================================================
# 启动虚拟显示器（Xvfb）+ 窗口管理器（fluxbox）
# Xvfb 提供虚拟 X11 显示，fluxbox 管理窗口焦点
# xdotool 需要窗口管理器才能正确路由鼠标事件到 Chrome 窗口
# ============================================================
echo "$LOG_PREFIX 启动 Xvfb 虚拟显示器..."
rm -f /tmp/.X99-lock 2>/dev/null || true
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
XVFB_PID=$!
sleep 1

echo "$LOG_PREFIX 启动 fluxbox 窗口管理器..."
DISPLAY=:99 fluxbox &
FLUXBOX_PID=$!
sleep 1

# ============================================================
# 执行续期脚本（Chrome 由 puppeteer.launch 管理）
# ============================================================
run_renew() {
    echo "$LOG_PREFIX ====== 开始执行续期 $(date -Iseconds) ======"
    node /app/xserver-vps-renew.mjs || true
    echo "$LOG_PREFIX ====== 执行完毕 $(date -Iseconds) ======"
}

# ============================================================
# 信号处理（优雅退出）
# ============================================================
cleanup() {
    echo "$LOG_PREFIX 收到退出信号，正在清理..."
    [ -n "$FLUXBOX_PID" ] && kill "$FLUXBOX_PID" 2>/dev/null || true
    [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT

# ============================================================
# 运行模式判断
# ============================================================
if [ -n "$CRON_SCHEDULE" ]; then
    # 定时模式：写入 cron 任务并保持容器运行
    echo "$LOG_PREFIX 定时模式：$CRON_SCHEDULE"

    # 将环境变量传递给 cron 子进程
    ENV_FILE="/app/.env.cron"
    env | grep -E '^(XSERVER_|CAPTCHA_|CDP_|CHROME_|DISPLAY|TZ|PATH|NODE_|TG_)' > "$ENV_FILE"

    # 创建 cron 执行脚本
    cat > /app/cron-run.sh <<'CRONSCRIPT'
#!/bin/bash
set -e
source /app/.env.cron
export $(cut -d= -f1 /app/.env.cron)
cd /app && ./entrypoint.sh --once
CRONSCRIPT
    chmod +x /app/cron-run.sh

    # 写入 crontab
    echo "$CRON_SCHEDULE /app/cron-run.sh >> /var/log/xserver-renew.log 2>&1" | crontab -

    echo "$LOG_PREFIX cron 已配置，容器将持续运行。"

    # 先立即执行一次
    run_renew

    # 启动 cron 并保持前台
    cron
    echo "$LOG_PREFIX cron 守护进程已启动，等待下次调度..."
    tail -f /var/log/xserver-renew.log 2>/dev/null &
    wait
else
    if [ "$1" = "--once" ]; then
        # 被 cron 内部调用
        run_renew
    else
        # 单次模式：执行完毕后退出
        echo "$LOG_PREFIX 单次执行模式"
        run_renew
        cleanup
    fi
fi
