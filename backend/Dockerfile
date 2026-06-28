# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
RUN npm install

COPY tsconfig*.json ./
COPY src ./src/
RUN npm run build && npx prisma generate

# ── Stage 2: Run ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY prisma ./prisma/
# Runtime asset: the proposal generator reads this at /app/ROOT_CAUSE_PROMPT_TEMPLATE.md
COPY ROOT_CAUSE_PROMPT_TEMPLATE.md ./

# Persistent volume mount point for SQLite file
RUN mkdir -p /data && chown app:app /data

USER app
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Push schema (idempotent — safe to run every startup), then start
CMD ["sh", "-c", "node_modules/.bin/prisma db push --skip-generate && node dist/server.js"]
