FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=false \
    PUPPETEER_CACHE_DIR=/opt/puppeteer \
    BROWSER_NO_SANDBOX=true \
    HOST=0.0.0.0 \
    PORT=3085

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg fonts-liberation build-essential python3 \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
    libdrm2 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 \
    libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxrender1 \
    libxshmfence1 libxss1 libxtst6 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir -p /opt/puppeteer && chown -R node:node /opt/puppeteer
COPY package*.json ./
RUN npm install --omit=dev && chown -R node:node /opt/puppeteer
COPY --chown=node:node . .
RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs
USER node
EXPOSE 3085
CMD ["node", "src/server.js"]
