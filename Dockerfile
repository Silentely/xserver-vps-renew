# 编译 supercronic：官方 v0.2.48 release 用 Go 1.26.5 构建，低于 Go stdlib 修复版本 1.26.6
# （CVE-2026-39821 Punycode / CVE-2026-46600 DNS 解析），改用 Go 1.26.6+ 从同 tag 源码重建
# （ldflags 注入方式与官方 Makefile 一致：-X main.Version）
FROM golang:1.26 AS supercronic-build
ARG SUPERCRONIC_VERSION=v0.2.48
RUN CGO_ENABLED=0 go install -ldflags "-X main.Version=${SUPERCRONIC_VERSION}" \
        github.com/aptible/supercronic@${SUPERCRONIC_VERSION}

FROM node:22-slim

# 元数据
LABEL maintainer="adair"
LABEL description="Xserver VPS 自动续期 - Puppeteer Stealth"

# 安装 Chrome、Xvfb、cron 及依赖
# 装完后 upgrade：吃掉 curl/mesa/libxfont2 等安全补丁，避免 Trivy HIGH/CRITICAL 门禁失败
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
       wget gnupg2 ca-certificates fonts-liberation \
       xvfb dbus cron procps curl gosu \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
       http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --only-upgrade xvfb xserver-common \
    && rm -rf /var/lib/apt/lists/*

# 持久化 Chrome 用户数据（续期状态文件默认也写在此目录，便于同卷持久化）
VOLUME /data/chrome-profile

WORKDIR /app

# 先复制 package.json 安装依赖（利用 Docker 缓存层）
# npm 仅构建期工具：ci 完成后整体移除（含 npx/corepack/yarn，node 基础镜像自带的
# 包管理器全部清掉），消除捆绑运行期依赖的 CVE 打地鼠（picomatch/sigstore/tar 皆源于此）；
# 运行时仅需 node（entrypoint 直接执行 node 主脚本）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
       /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
       /opt/yarn-v1.22.22 /usr/local/bin/yarn /usr/local/bin/yarnpkg

# 复制项目文件
COPY xserver-vps-renew.mjs .
COPY src/ src/
COPY browser-fingerprint-patch.js .
COPY turnstile-patch/ turnstile-patch/
COPY assets/ assets/
COPY entrypoint.sh .
COPY diagnostics.sh .
RUN chmod +x entrypoint.sh diagnostics.sh

ENV TZ=Asia/Tokyo \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    CHROME_USER_DATA=/data/chrome-profile \
    RENEWAL_STATUS_FILE=/data/chrome-profile/renewal-status.json \
    CDP_URL=http://127.0.0.1:9222 \
    PROXY_TYPE= \
    PROXY_ADDRESS= \
    PROXY_PORT= \
    PROXY_LOGIN= \
    DISPLAY=:99 \
    ENABLE_DIAGNOSTICS= \
    NODE_OPTIONS="--max-old-space-size=128 --expose-gc" \
    XVFB_RESOLUTION="1440x900x24"

# 创建非 root 用户（Chrome 在容器内以非 root 运行更安全）
# /data/ 目录需要 appuser 可写（renewal-status.json 持久化）
# /tmp/.X11-unix 必须 root 所有 + 1777 权限（Xvfb 要求，非 root 用户可创建 socket）
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser \
    && mkdir -p /data/chrome-profile /var/log /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && chown -R appuser:appuser /data /app /var/log

# 安装 supercronic（多阶段编译产物，Go 1.26.6+ 构建）
COPY --from=supercronic-build /go/bin/supercronic /usr/local/bin/supercronic

# 保持 root 入口以便挂载卷权限自愈并降权至 appuser
# USER appuser

# 定时模式：supercronic；执行中：node 主脚本；均不在则视为不健康
HEALTHCHECK --interval=30m --timeout=10s --retries=3 \
  CMD pgrep -f "supercronic" >/dev/null || pgrep -f "xserver-vps-renew" >/dev/null || exit 1

ENTRYPOINT ["./entrypoint.sh"]
