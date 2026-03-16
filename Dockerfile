FROM node:20-bookworm-slim

# Build tools required for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    DOWNLOAD_DIR=/downloads \
    DB_PATH=/app/data/go-shelf.db

# Data dir for SQLite DB and auth tokens
VOLUME ["/app/data", "/downloads"]

CMD ["node", "src/server.js"]
