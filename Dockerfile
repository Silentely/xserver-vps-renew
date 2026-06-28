FROM node:22-slim

# 元数据
LABEL maintainer="adair"
LABEL description="Xserver VPS 自动续期 - Puppeteer Stealth"

# 安装 Chrome、Xvfb、cron 及依赖
RUN apt-get update \
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
    && rm -rf /var/lib/apt/lists/*

# 持久化 Chrome 用户数据的挂载点
VOLUME /data/chrome-profile

WORKDIR /app

# 先复制 package.json 安装依赖（利用 Docker 缓存层）
COPY package.json package-lock.json ./
RUN npm install -g npm@latest \
    && npm ci --omit=dev \
    && npm cache clean --force

# 复制项目文件
COPY xserver-vps-renew.mjs .
COPY browser-fingerprint-patch.js .
COPY turnstile-patch/ turnstile-patch/
COPY entrypoint.sh .
COPY diagnostics.sh .
RUN chmod +x entrypoint.sh diagnostics.sh

ENV TZ=Asia/Tokyo \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    CHROME_USER_DATA=/data/chrome-profile \
    CDP_URL=http://127.0.0.1:9222 \
    PROXY_TYPE= \
    PROXY_ADDRESS= \
    PROXY_PORT= \
    PROXY_LOGIN= \
    DISPLAY=:99

# 注意：容器以 root 运行，因为 cron 守护进程和 /var/log 写入需要 root 权限
# Chrome 通过 --no-sandbox 在容器内安全运行
HEALTHCHECK --interval=30m --timeout=10s --retries=3 \
  CMD pgrep -f "cron" || exit 1

ENTRYPOINT ["./entrypoint.sh"]
