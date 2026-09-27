FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
WORKDIR /opt/browser-tools
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && node node_modules/playwright/cli.js install --with-deps chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg-query -W > /opt/browser-tools/os-packages.txt
WORKDIR /work
