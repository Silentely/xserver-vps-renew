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
       xvfb dbus cron procps curl \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
       http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 持久化 Chrome 用户数据（续期状态文件默认也写在此目录，便于同卷持久化）
VOLUME /data/chrome-profile

WORKDIR /app

# 先复制 package.json 安装依赖（利用 Docker 缓存层）
# 顺序：先用镜像自带 npm 执行 ci（避免 npm@latest 对 remote tarball 的 EALLOWREMOTE），
# 再升级 npm，修补基础镜像自带 npm 内嵌的 picomatch/sigstore 等 HIGH 漏洞
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm install -g npm@latest \
    && npm cache clean --force

# 复制项目文件
COPY xserver-vps-renew.mjs .
COPY src/ src/
COPY browser-fingerprint-patch.js .
COPY turnstile-patch/ turnstile-patch/
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
    ENABLE_DIAGNOSTICS=

# 创建非 root 用户（Chrome 在容器内以非 root 运行更安全）
# /data/ 目录需要 appuser 可写（renewal-status.json 持久化）
# /tmp/.X11-unix 必须 root 所有 + 1777 权限（Xvfb 要求，非 root 用户可创建 socket）
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser \
    && mkdir -p /data/chrome-profile /var/log /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && chown -R appuser:appuser /data /app /var/log

# 安装 supercronic（支持非 root 的 cron 替代品）
ARG SUPERCRONIC_VERSION=v0.2.34
RUN set -e \
    && arch=$(uname -m) \
    && case "$arch" in \
       x86_64)  ARCH_SUFFIX=amd64 ;; \
       aarch64) ARCH_SUFFIX=arm64 ;; \
       *) echo "不支持的架构: $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${ARCH_SUFFIX}" \
      -o /usr/local/bin/supercronic \
    && chmod +x /usr/local/bin/supercronic

USER appuser

# 定时模式：supercronic；执行中：node 主脚本；均不在则视为不健康
HEALTHCHECK --interval=30m --timeout=10s --retries=3 \
  CMD pgrep -f "supercronic" >/dev/null || pgrep -f "xserver-vps-renew" >/dev/null || exit 1

ENTRYPOINT ["./entrypoint.sh"]
