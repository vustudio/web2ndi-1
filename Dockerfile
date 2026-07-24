# GPU-capable base: libglvnd (libGL/libEGL) so Chromium can reach the NVIDIA GPU via EGL.
FROM nvidia/opengl:1.2-glvnd-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg xvfb \
      build-essential \
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

# cyndilib's wheel bundles both the NDI runtime AND the full NDI SDK headers,
# which is the only redistributable source of them we have. Stage them where the
# native addon can include/link against them.
RUN pip3 install --no-cache-dir cyndilib==0.1.1 \
 && CY=$(python3 -c "import cyndilib,os;print(os.path.dirname(cyndilib.__file__))") \
 && mkdir -p /opt/ndi/include /opt/ndi/lib \
 && cp $CY/wrapper/include/*.h /opt/ndi/include/ \
 && cp $CY/../cyndilib.libs/*.so* /opt/ndi/lib/ \
 && ln -sf /opt/ndi/lib/$(ls /opt/ndi/lib | grep '^libndi' | head -1) /opt/ndi/lib/libndi.so \
 && echo /opt/ndi/lib > /etc/ld.so.conf.d/ndi.conf && ldconfig

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
# Build the in-process NDI addon against ELECTRON's ABI (not the system node's).
COPY binding.gyp ./
COPY native ./native
RUN npx node-gyp rebuild \
      --target=$(node -p "require('electron/package.json').version") \
      --arch=x64 --dist-url=https://electronjs.org/headers \
 && test -f build/Release/ndi_sender.node
COPY src ./src
COPY openapi.yaml ./
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
