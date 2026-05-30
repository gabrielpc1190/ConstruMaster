# syntax=docker/dockerfile:1.7
#
# ConstruMaster v2 — production image.
# Multi-stage: deps -> build -> runtime. Single Node process serves both the
# Vite-built SPA (from dist/) and the Express API on port 3001.

# ---------- Stage 1: base ----------
# Pinned to node:22-alpine so the image stays small (~150 MB before deps).
FROM node:22-alpine AS base
WORKDIR /app
# dumb-init reaps zombies and forwards SIGTERM cleanly to Node — needed because
# Express does not install signal handlers by default and we want graceful
# shutdown when docker compose down sends SIGTERM.
RUN apk add --no-cache dumb-init

# ---------- Stage 2: deps ----------
# Install ALL deps (incl. dev) so the build stage has TypeScript, Vite, tailwind, etc.
# Prisma client is generated here so the .prisma/ output is cached with node_modules.
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund
RUN npx prisma generate

# ---------- Stage 3: build ----------
# Compile TS + bundle the frontend with Vite. Output goes to /app/dist.
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY vite.config.ts index.html eslint.config.js ./
COPY src ./src
COPY prisma ./prisma
COPY server ./server
RUN npm run build

# ---------- Stage 4: prod-deps ----------
# Reinstall only production deps against a clean tree so devDeps (vite, ts, eslint,
# nodemon, concurrently, @types/*, tailwindcss) are excluded from the runtime image.
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx prisma generate \
 && npm cache clean --force

# ---------- Stage 5: runtime ----------
# Lean image: only runtime deps, generated Prisma client, compiled assets, server code.
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3001

# Drop privileges. node:22-alpine ships a non-root `node` user (uid 1000).
COPY --chown=node:node package.json package-lock.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node server ./server
COPY --from=build --chown=node:node /app/dist ./dist

# uploads/ is mounted as a volume at runtime; create the mountpoint so a missing
# bind-mount does not crash multer when it tries to mkdirSync on first write.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

USER node
EXPOSE 3001

# Container-local healthcheck — docker-compose layer can re-declare if needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/index.js"]
