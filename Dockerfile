# inkling in a container. `docker compose up -d` runs it (see docker-compose.yml and the README's Hosting section).
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
# Everything private (the WhatsApp session, people, history, tokens) lives on the /data volume.
ENV INKLING_HOST=0.0.0.0 INKLING_DATA_DIR=/data PORT=8787
EXPOSE 8787
VOLUME /data
CMD ["npm", "start"]
