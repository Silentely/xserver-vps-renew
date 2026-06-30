#!/bin/bash
set -e

LOG_PREFIX="[xserver-vps-renew]"

# ============================================================
# 容器环境诊断（通过 ENABLE_DIAGNOSTICS=true 启用）
# ============================================================
if [ "$ENABLE_DIAGNOSTICS" = "true" ] && [ -x /app/diagnostics.sh ]; then
    /app/diagnostics.sh
fi

# ============================================================
# 启动虚拟显示器（Xvfb）
# Xvfb 提供虚拟 X11 显示（headless:false 模式需要）
# 🔧 修复：检测 Xvfb 是否已运行，避免 cron 触发时重复启动
# ============================================================
if ! pgrep -f "Xvfb :99" > /dev/null; then
    echo "$LOG_PREFIX 启动 Xvfb 虚拟显示器..."
    rm -f /tmp/.X99-lock 2>/dev/null || true
    Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
    XVFB_PID=$!
    sleep 1
else
    echo "$LOG_PREFIX Xvfb 已在运行，跳过启动"
fi

# ============================================================
# 显示定时任务信息
# ============================================================
show_cron_schedule() {
    local cron_expr="$1"
    if [ -z "$cron_expr" ]; then
        echo "未设置定时"
        return
    fi

    # 解析 cron 表达式显示易读时间
    local minute=$(echo "$cron_expr" | awk '{print $1}')
    local hour=$(echo "$cron_expr" | awk '{print $2}')

    # 如果是简单的时间表达式（如 "30 20 * * *"），显示易读格式
    if [[ "$minute" =~ ^[0-9]+$ ]] && [[ "$hour" =~ ^[0-9]+$ ]]; then
        echo "每天 $(printf "%02d:%02d" "$hour" "$minute") (容器本地时间 - 东京)"
    else
        echo "$cron_expr (容器本地时间)"
    fi
}

# ============================================================
# 执行续期脚本（Chrome 由 puppeteer.launch 管理）
# 🔧 修复：执行成功后显示下次续期时间
# ============================================================
run_renew() {
    echo "$LOG_PREFIX ====== 开始执行续期 $(date -Iseconds) ======"

    local EXIT_CODE=0
    node /app/xserver-vps-renew.mjs || EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        echo "$LOG_PREFIX ✅ 续期检查完成（成功或无需续期）"
        if [ -n "$CRON_SCHEDULE" ]; then
            NEXT_RUN=$(show_cron_schedule "$CRON_SCHEDULE")
            echo "$LOG_PREFIX ⏭️ 下次续期检查: $NEXT_RUN"
        fi
    else
        echo "$LOG_PREFIX ❌ 续期失败，退出码: $EXIT_CODE"
    fi

    echo "$LOG_PREFIX ====== 执行完毕 $(date -Iseconds) ======"
    return $EXIT_CODE
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

    # 显示定时任务信息
    SCHEDULE_INFO=$(show_cron_schedule "$CRON_SCHEDULE")
    echo "$LOG_PREFIX ⏭️ 定时任务: $SCHEDULE_INFO"

    # 创建 cron 执行脚本（通过环境变量白名单内联导出，不落盘敏感信息）
    # 使用命名管道将 cron 输出同时写入文件和 stdout（确保 docker logs 可见）
    cat > /app/cron-run.sh <<'CRONSCRIPT'
#!/bin/bash
LOG_PREFIX="[xserver-vps-renew]"

exec 9>/tmp/xserver-renew.lock
if ! flock -n 9; then
    echo "$LOG_PREFIX ⏭️ 上一次执行仍在运行，跳过"
    exit 0
fi

# 从父进程环境继承所需变量（白名单内联导出，避免凭据落盘）
export XSERVER_MEMBER_ID="${XSERVER_MEMBER_ID:-}"
export XSERVER_PASSWORD="${XSERVER_PASSWORD:-}"
export CAPTCHA_API="${CAPTCHA_API:-}"
export CAPSOLVER_API_KEY="${CAPSOLVER_API_KEY:-}"
export TWOCAPTCHA_API_KEY="${TWOCAPTCHA_API_KEY:-}"
export TG_BOT_TOKEN="${TG_BOT_TOKEN:-}"
export TG_CHAT_ID="${TG_CHAT_ID:-}"
export PROXY_TYPE="${PROXY_TYPE:-}"
export PROXY_ADDRESS="${PROXY_ADDRESS:-}"
export PROXY_PORT="${PROXY_PORT:-}"
export PROXY_LOGIN="${PROXY_LOGIN:-}"
export PROXY_PASSWORD="${PROXY_PASSWORD:-}"
export CHROME_PATH="${CHROME_PATH:-}"
export CHROME_USER_DATA="${CHROME_USER_DATA:-}"
export TZ="${TZ:-Asia/Tokyo}"
export CRON_SCHEDULE="${CRON_SCHEDULE:-}"
export RENEWAL_STATUS_FILE="${RENEWAL_STATUS_FILE:-}"
export ALERT_AFTER_FAILURES="${ALERT_AFTER_FAILURES:-}"
export ENABLE_DIAGNOSTICS="${ENABLE_DIAGNOSTICS:-}"

echo "$LOG_PREFIX ====== 定时任务触发 $(date -Iseconds) ======"

MAX_RETRIES=3
for i in $(seq 1 $MAX_RETRIES); do
    if cd /app && ./entrypoint.sh --once; then
        echo "$LOG_PREFIX ✅ 续期成功"
        exit 0
    fi
    if [ $i -lt $MAX_RETRIES ]; then
        echo "$LOG_PREFIX ⚠️ 第 $i 次失败，等待 30 秒后重试..."
        sleep 30
    fi
done
echo "$LOG_PREFIX ❌ 续期失败，已重试 $MAX_RETRIES 次"
exit 1
CRONSCRIPT
    chmod +x /app/cron-run.sh

    # 确保日志文件存在（tail -f 需要文件已存在）
    touch /var/log/xserver-renew.log

    # 写入 crontab：输出同时写文件和 stdout（通过 tee）
    echo "$CRON_SCHEDULE /app/cron-run.sh 2>&1 | tee -a /var/log/xserver-renew.log" | crontab -

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
    echo "$LOG_PREFIX ⏭️ 定时任务: $SCHEDULE_INFO"
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
