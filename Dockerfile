# GPU-capable base: libglvnd (libGL/libEGL) so Chromium can reach the NVIDIA GPU via EGL.
FROM nvidia/opengl:1.2-glvnd-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg xvfb \
      python3 python3-pip \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpangocairo-1.0-0 libpango-1.0-0 libcairo2 libatspi2.0-0 libgtk-3-0 \
      libx11-xcb1 libxshmfence1 \
      fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Node 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# NDI sender. The manylinux wheel bundles the NDI runtime -> no NDI SDK needed.
RUN pip3 install --no-cache-dir cyndilib==0.1.1

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# GPU visibility (also requires `--gpus all` at run time)
ENV NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=all \
    CG_URL=https://rnd2.vu.studio/player?wallid=sienna \
    CG_WIDTH=1920 CG_HEIGHT=1080 CG_FPS=30 NDI_NAME=WebCG CG_ALPHA=1 CG_GL=egl \
    CTRL_PORT=8099

# Persistent Electron profile (cookies / localStorage / session). Mount a volume here.
VOLUME /data

EXPOSE 8099
ENTRYPOINT ["./entrypoint.sh"]
