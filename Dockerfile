# BUZZKILL Colyseus server. Host-agnostic: Railway, Fly.io and Render all run
# this unchanged. Node pinned to 20 per the build brief's stack table.
FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --workspace @buzzkill/server --omit=dev

COPY shared ./shared
COPY server ./server

ENV NODE_ENV=production
EXPOSE 2567
WORKDIR /app/server
CMD ["npx", "tsx", "src/index.ts"]
