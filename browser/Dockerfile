# Chromium and its system libraries come with Microsoft's Playwright image (versions must match package.json).
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs live.html ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER pwuser
CMD ["node", "server.mjs"]
