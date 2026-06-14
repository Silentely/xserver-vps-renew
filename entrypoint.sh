#!/bin/bash
set -e

LOG_PREFIX="[entrypoint]"

# ============================================================
# 启动虚拟显示器（Xvfb）
# Xvfb 提供虚拟 X11 显示（headless:false 模式需要）
# ============================================================
echo "$LOG_PREFIX 启动 Xvfb 虚拟显示器..."
rm -f /tmp/.X99-lock 2>/dev/null || true
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
XVFB_PID=$!
sleep 1

# ============================================================
# 计算下次运行时间
# ============================================================
calculate_next_run() {
    local cron_expr="$1"
    if [ -z "$cron_expr" ]; then
        echo "未设置定时"
        return
    fi

    # 使用 date 命令计算明天同一时间
    local next_run=$(date -d "tomorrow" '+%Y-%m-%d %H:%M:%S %Z')
    echo "$next_run"
}

# ============================================================
# 执行续期脚本（Chrome 由 puppeteer.launch 管理）
# ============================================================
run_renew() {
    echo "$LOG_PREFIX ====== 开始执行续期 $(date -Iseconds) ======"

    # 执行续期脚本，捕获退出码
    if node /app/xserver-vps-renew.mjs; then
        echo "$LOG_PREFIX ✅ 续期检查完成（成功或无需续期）"
        return 0
    else
        EXIT_CODE=$?
        echo "$LOG_PREFIX ❌ 续期失败，退出码: $EXIT_CODE"
        return $EXIT_CODE
    fi

    echo "$LOG_PREFIX ====== 执行完毕 $(date -Iseconds) ======"
}

# ============================================================
# 信号处理（优雅退出）
# ============================================================
cleanup() {
    echo "$LOG_PREFIX 收到退出信号，正在清理..."
    [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT

# ============================================================
# 运行模式判断
# ============================================================
if [ -n "$CRON_SCHEDULE" ]; then
    # 定时模式：先立即执行一次，然后定时调度
    echo "$LOG_PREFIX 🕐 定时模式: $CRON_SCHEDULE"

    # 计算下次运行时间
    NEXT_RUN=$(calculate_next_run "$CRON_SCHEDULE")
    echo "$LOG_PREFIX ⏭️ 下次运行时间: $NEXT_RUN"

    # 将环境变量传递给 cron 子进程
    ENV_FILE="/app/.env.cron"
    env | grep -E '^(XSERVER_|CAPTCHA_|CDP_|CHROME_|DISPLAY|TZ|PATH|NODE_|TG_|CAPSOLVER_|TWOCAPTCHA_|PROXY_)' > "$ENV_FILE"

    # 创建 cron 执行脚本
    cat > /app/cron-run.sh <<'CRONSCRIPT'
#!/bin/bash
set -e
source /app/.env.cron
export $(cut -d= -f1 /app/.env.cron)
echo "[cron] ====== 定时任务触发 $(date -Iseconds) ======"
cd /app && ./entrypoint.sh --once
CRONSCRIPT
    chmod +x /app/cron-run.sh

    # 写入 crontab
    echo "$CRON_SCHEDULE /app/cron-run.sh >> /var/log/xserver-renew.log 2>&1" | crontab -

    echo "$LOG_PREFIX cron 已配置，容器将持续运行。"

    # 立即执行第一次检查（失败最多重试 3 次）
    echo "$LOG_PREFIX 启动后立即检查一次到期情况..."
    RETRY_COUNT=0
    MAX_RETRIES=3

    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if run_renew; then
            echo "$LOG_PREFIX ✅ 首次检查成功，进入定时模式"
            break
        else
            RETRY_COUNT=$((RETRY_COUNT + 1))
            if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
                echo "$LOG_PREFIX ⚠️ 第 $RETRY_COUNT 次失败，等待 10 秒后重试..."
                sleep 10
            else
                echo "$LOG_PREFIX ❌ 失败 $MAX_RETRIES 次，跳过本次续期，等待下次定时执行"
            fi
        fi
    done

    # 启动 cron 并保持前台
    cron
    echo "$LOG_PREFIX cron 守护进程已启动，等待下次调度..."
    echo "$LOG_PREFIX ⏭️ 下次运行时间: $NEXT_RUN"
    tail -f /var/log/xserver-renew.log 2>/dev/null &
    wait
else
    if [ "$1" = "--once" ]; then
        # 被 cron 内部调用：执行一次，失败不重试
        run_renew
    else
        # 单次模式：执行完毕后退出
        echo "$LOG_PREFIX 单次执行模式"
        run_renew
        cleanup
    fi
fi
