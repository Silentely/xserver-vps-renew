#!/bin/bash
set -euo pipefail
# 容器网络与环境诊断脚本

# 脱敏主机/代理地址：保留末尾 4 字符，其余替换为 *（与主脚本 maskProxyAddress 惯例一致）
mask_address() {
  local addr="${1:-}"
  if [ -z "$addr" ]; then
    echo "未设置"
    return
  fi
  local len=${#addr}
  if [ "$len" -le 4 ]; then
    echo "$addr"
    return
  fi
  local head_len=$((len - 4))
  local masked=""
  local i
  for ((i = 0; i < head_len; i++)); do
    masked="${masked}*"
  done
  echo "${masked}${addr: -4}"
}

# 统一时间戳：尊重 TZ，缺省东京时区（与主脚本日志 formatLogTimestamp 一致）
ts() {
    TZ="${TZ:-Asia/Tokyo}" date -Iseconds
}

echo "====== 环境诊断 $(ts) ======"

echo "📡 代理配置:"
echo "  PROXY_TYPE=${PROXY_TYPE:-未设置}"
echo "  PROXY_ADDRESS=$(mask_address "${PROXY_ADDRESS:-}")"
echo "  PROXY_PORT=${PROXY_PORT:-未设置}"
if [ -n "$PROXY_LOGIN" ]; then
  echo "  PROXY_LOGIN=已设置"
else
  echo "  PROXY_LOGIN=未设置"
fi

echo "🌐 网络测试:"
curl -s -o /dev/null -w "  直连外网: %{http_code} (%{time_total}s)\n" https://secure.xserver.ne.jp --connect-timeout 5 --max-time 10 || echo "  直连外网: 失败"

if [ -n "$PROXY_ADDRESS" ] && [ -n "$PROXY_PORT" ]; then
  PROXY_SCHEME="${PROXY_TYPE:-http}"
  if [ -n "$PROXY_LOGIN" ] && [ -n "$PROXY_PASSWORD" ]; then
    curl -s -o /dev/null -w "  代理连通: %{http_code} (%{time_total}s)\n" \
      -x "${PROXY_SCHEME}://${PROXY_ADDRESS}:${PROXY_PORT}" \
      --proxy-user "${PROXY_LOGIN}:${PROXY_PASSWORD}" \
      https://secure.xserver.ne.jp --connect-timeout 8 --max-time 12 || echo "  代理连通: 失败"
  else
    curl -s -o /dev/null -w "  代理连通: %{http_code} (%{time_total}s)\n" \
      -x "${PROXY_SCHEME}://${PROXY_ADDRESS}:${PROXY_PORT}" \
      https://secure.xserver.ne.jp --connect-timeout 8 --max-time 12 || echo "  代理连通: 失败"
  fi
else
  echo "  代理连通: 未配置代理，跳过"
fi

echo "🖥️ 容器信息:"
echo "  出口 IP: $(curl -s ifconfig.me --connect-timeout 5 --max-time 8 2>/dev/null || echo '获取失败')"
echo "  内存: $(free -h 2>/dev/null | awk '/Mem/{print $2}' || echo 'N/A')"
echo "  磁盘剩余: $(df -h /tmp 2>/dev/null | awk 'NR==2{print $4}' || echo 'N/A')"
echo "  Chrome: $(google-chrome-stable --version 2>/dev/null || echo '未安装')"
echo "  Node: $(node --version 2>/dev/null || echo '未安装')"

# 状态文件目录可写性探测：挂载卷权限不足时 writeRenewalStatus 只能在运行中失败，
# 提前在诊断阶段暴露（连续失败统计/告警升级均依赖状态文件持久化）
check_status_file_writability() {
  local status_file="${RENEWAL_STATUS_FILE:-/data/chrome-profile/renewal-status.json}"
  local status_dir
  status_dir=$(dirname "$status_file")
  echo "  状态文件: $status_file"
  if [ ! -d "$status_dir" ]; then
    echo "  目录: 不存在（首次运行时将自动创建）"
  elif [ -w "$status_dir" ]; then
    echo "  目录: 可写"
  else
    echo "  目录: ❌ 不可写（续期记录无法持久化，请检查挂载卷属主/权限）"
  fi
  if [ -f "$status_file" ]; then
    if [ -w "$status_file" ]; then
      echo "  文件: 已存在且可写"
    else
      echo "  文件: ❌ 已存在但不可写（writeRenewalStatus 将失败）"
    fi
  fi
}

echo "💾 状态持久化:"
check_status_file_writability

echo "🎯 关键 API 连通性:"
# Keras 验证码识别（Cloud Run）：冷启动/不可达是续期失败高频根因。
# GET 可能返回 405（端点仅接受 POST），有 HTTP 响应即视为可达。
if [ -n "${CAPTCHA_API:-}" ]; then
  curl -s -o /dev/null -w "  CAPTCHA_API (Keras): HTTP %{http_code} (%{time_total}s)\n" \
    "$CAPTCHA_API" --connect-timeout 5 --max-time 8 || echo "  CAPTCHA_API (Keras): 失败"
else
  echo "  CAPTCHA_API (Keras): 未设置（使用内置默认端点）"
fi

# Turnstile 打码平台：按已配置 key 探测对应 API 基址可达性
while IFS='|' read -r provider base envvar; do
  if [ -n "${!envvar:-}" ]; then
    curl -s -o /dev/null -w "  ${provider}: HTTP %{http_code} (%{time_total}s)\n" \
      "$base" --connect-timeout 5 --max-time 8 || echo "  ${provider}: 失败"
  fi
done <<'PROVIDERS'
CapSolver|https://api.capsolver.com|CAPSOLVER_API_KEY
AntiCaptcha|https://api.anti-captcha.com|ANTICAPTCHA_API_KEY
YesCaptcha|https://api.yescaptcha.com|YESCAPTCHA_API_KEY
2Captcha|https://api.2captcha.com|TWOCAPTCHA_API_KEY
PROVIDERS

echo "====== 诊断结束 ======"
