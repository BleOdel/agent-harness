# Explicit toolchain build; execution pins the resulting immutable image ID.
FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth unzip libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2 \
    libdrm2 libxkbcommon0 libcups2 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/desktop-tools
COPY package.json package-lock.json runtime.json download.mjs ./
RUN npm ci --ignore-scripts --no-audit --no-fund && node download.mjs \
    && mkdir /opt/electron && unzip -q /tmp/electron.zip -d /opt/electron \
    && rm /tmp/electron.zip && npm cache clean --force \
    && dpkg-query -W > /opt/desktop-tools/os-packages.txt
WORKDIR /work
