#!/bin/bash
# 容器网络与环境诊断脚本

echo "====== 环境诊断 $(date -Iseconds) ======"

echo "📡 代理配置:"
echo "  PROXY_TYPE=${PROXY_TYPE:-未设置}"
echo "  PROXY_ADDRESS=${PROXY_ADDRESS:-未设置}"
echo "  PROXY_PORT=${PROXY_PORT:-未设置}"
if [ -n "$PROXY_LOGIN" ]; then
  echo "  PROXY_LOGIN=已设置"
else
  echo "  PROXY_LOGIN=未设置"
fi

echo "🌐 网络测试:"
curl -s -o /dev/null -w "  直连外网: %{http_code} (%{time_total}s)\n" https://secure.xserver.ne.jp --connect-timeout 10 || echo "  直连外网: 失败"

if [ -n "$PROXY_ADDRESS" ] && [ -n "$PROXY_PORT" ]; then
  PROXY_SCHEME="${PROXY_TYPE:-http}"
  AUTH=""
  if [ -n "$PROXY_LOGIN" ] && [ -n "$PROXY_PASSWORD" ]; then
    AUTH="${PROXY_LOGIN}:${PROXY_PASSWORD}@"
  fi
  curl -s -o /dev/null -w "  代理连通: %{http_code} (%{time_total}s)\n" \
    -x "${PROXY_SCHEME}://${AUTH}${PROXY_ADDRESS}:${PROXY_PORT}" \
    https://secure.xserver.ne.jp --connect-timeout 15 || echo "  代理连通: 失败"
else
  echo "  代理连通: 未配置代理，跳过"
fi

echo "🖥️ 容器信息:"
echo "  出口 IP: $(curl -s ifconfig.me --connect-timeout 10 2>/dev/null || echo '获取失败')"
echo "  内存: $(free -h 2>/dev/null | awk '/Mem/{print $2}' || echo 'N/A')"
echo "  磁盘剩余: $(df -h /tmp 2>/dev/null | awk 'NR==2{print $4}' || echo 'N/A')"
echo "  Chrome: $(google-chrome-stable --version 2>/dev/null || echo '未安装')"
echo "  Node: $(node --version 2>/dev/null || echo '未安装')"

echo "====== 诊断结束 ======"
