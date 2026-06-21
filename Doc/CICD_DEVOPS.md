# CI/CD & DevOps Guide — Expensify Issue Notifier & Auto-Proposer

## Overview

There is **one** GitHub Actions workflow for CI and **one** for deployment. Both only concern the backend — there is no frontend CI job.

```
Push or PR to `master`, touching backend/** or ci.yml
        │
        ▼
┌───────────────────────────────────────┐
│  GitHub Actions: CI (ci.yml)           │
│  job "ci" — single job, no matrix      │
│                                       │
│  1. npm ci            (working-directory: backend)
│  2. npx prisma generate
│  3. npm run typecheck
│  4. npm run lint
│  5. npm run build
└───────────────────────────────────────┘
        │
        │ workflow_run trigger: fires when the CI workflow
        │ completes on master, regardless of which event
        │ triggered that CI run (push or PR)
        ▼
┌───────────────────────────────────────┐
│  GitHub Actions: Deploy (deploy.yml)  │
│  if: workflow_run.conclusion=='success'│
│                                       │
│  1. flyctl deploy --remote-only        │
│     --wait-timeout 120                │
│  2. sleep 10; curl -f $PROD_API_URL/health │
└───────────────────────────────────────┘
```

No lint/build/test job exists for `frontend/` anywhere in `.github/workflows/`. No Redis service container, no Postgres, no E2E/Playwright job, no separate unit/integration/coverage steps — `ci.yml` runs exactly the 5 steps shown above in one job.

> **Suspected bug, unconfirmed (not yet executed):** this repo is an npm-workspaces monorepo (`"workspaces": ["backend", "frontend"]` in the root `package.json`), and the lockfile lives only at the repo root — there is no `backend/package-lock.json`. `ci.yml`'s `npm ci` step runs with `working-directory: backend`, which would normally fail (`npm ci` requires a lockfile in the directory it runs from) unless npm's workspace-aware resolution handles this differently than expected. This has not been verified by actually running the workflow — flagging it here as a known risk, not a confirmed failure.

> **Node version inconsistency:** `backend/package.json`'s `engines.node` field says `>=24.0.0`, but `ci.yml` and `Dockerfile` both pin Node **22**. Not enforced (no `engine-strict`), so this doesn't currently break anything, but the two declarations disagree.

---

## GitHub Actions Workflows

### CI Workflow (`.github/workflows/ci.yml`)

```yaml
name: CI

on:
  push:
    branches: [master]
    paths:
      - 'backend/**'
      - '.github/workflows/ci.yml'
  pull_request:
    branches: [master]
    paths:
      - 'backend/**'
      - '.github/workflows/ci.yml'

jobs:
  ci:
    name: Type Check, Lint & Build
    runs-on: ubuntu-latest
    timeout-minutes: 10
    defaults:
      run:
        working-directory: backend

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Generate Prisma client
        run: npx prisma generate

      - name: Type check
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Build
        run: npm run build
```

Note `cache-dependency-path: package-lock.json` is relative to `working-directory: backend` — i.e. it points at a `backend/package-lock.json` that does not exist in this monorepo layout. This is the same lockfile-location concern flagged above.

### Deploy Workflow (`.github/workflows/deploy.yml`)

```yaml
name: Deploy to Fly.io

on:
  workflow_run:
    workflows: [CI]
    branches: [master]
    types: [completed]

jobs:
  deploy:
    name: Deploy Backend
    runs-on: ubuntu-latest
    timeout-minutes: 15
    if: ${{ github.event.workflow_run.conclusion == 'success' }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup flyctl
        uses: superfly/flyctl-actions/setup-flyctl@master

      - name: Deploy
        working-directory: backend
        run: flyctl deploy --remote-only --wait-timeout 120
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}

      - name: Health check
        run: |
          sleep 10
          curl -f "${{ secrets.PROD_API_URL }}/health" || exit 1
```

There is no separate frontend deploy job — the deployed system is the backend only. The `frontend/` Next.js scaffold (an npm workspace member, calls a non-existent `/api/auth/login`) has no CI or deploy workflow at all.

---

## Required GitHub Secrets

Configure these in your repository: **Settings → Secrets and variables → Actions**

| Secret Name      | Description                                          |
|-------------------|-------------------------------------------------------|
| `FLY_API_TOKEN`   | Output of `flyctl tokens create deploy`                |
| `PROD_API_URL`    | Production backend URL, e.g. `https://expensify-backend-dusky-summit-570.fly.dev` |

That's the entire set — no Render, Vercel, or Redis secrets exist because none of those services are used.

---

## Docker Setup

### `backend/Dockerfile`

```dockerfile
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

# Persistent volume mount point for SQLite file
RUN mkdir -p /data && chown app:app /data

USER app
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Push schema (idempotent — safe to run every startup), then start
CMD ["sh", "-c", "node_modules/.bin/prisma db push --skip-generate && node dist/server.js"]
```

Note this stage-1 `RUN npm install` (not `npm ci`) operates inside a build context scoped to `backend/` (Fly.io builds with `backend/` as the Docker build context per `fly.toml`), so it does not hit the workspace-lockfile issue that affects `ci.yml`.

### `docker-compose.yml` (repo root and `backend/`, identical, no services)

```yaml
version: '3.9'

# No services required — app uses SQLite only.
# Run locally with: cd backend && npm run dev
```

There is no Redis, Postgres, or any other service in either `docker-compose.yml` — both files are effectively placeholders documenting that none are needed.

---

## Branch Strategy

The only branch referenced anywhere in the workflows is `master` (both `ci.yml` and `deploy.yml` trigger off it; there is no `develop` branch or `feat/`/`fix/` convention enforced anywhere in the repo). Whether `master` has GitHub branch-protection rules (required reviews, required status checks, etc.) configured is a repository setting on GitHub, not something visible in these files — not documented here because it cannot be verified from source.

---

## Dependabot

`.github/dependabot.yml` (real, present in the repo):

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/backend"
    schedule:
      interval: "weekly"
      day: "monday"
    groups:
      backend-deps:
        update-types: ["minor", "patch"]

  - package-ecosystem: "npm"
    directory: "/frontend"
    schedule:
      interval: "weekly"
      day: "monday"
    groups:
      frontend-deps:
        update-types: ["minor", "patch"]

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "monthly"
```

Dependabot does track `frontend/` dependency updates even though no frontend CI job runs against them — those PRs would only get type/build verification if someone manually runs `npm run build` inside `frontend/`.

---

## Monitoring & Observability

### Structured Logging (Pino)

All logs are structured JSON in production (`NODE_ENV=production`), pretty-printed in development. `flyctl logs` streams these directly — there is no separate log aggregation service configured.

### Health Endpoints

```
GET /health       → 200 {"status":"ok","uptime":12345}
GET /health/ready → 200 {"status":"ready","db":"connected"}
              or → 503 {"status":"not ready","db":"disconnected"}
```

`fly.toml` configures an HTTP health check against `GET /health` (`interval=30s`, `timeout=10s`, `grace_period=15s`) — this is what Fly.io uses to decide whether to restart the machine.

### Uptime alerting

No alerting service is configured in this repo. `Doc/DEPLOYMENT.md` suggests UptimeRobot as a free option for external uptime monitoring, but no UptimeRobot config or webhook exists in source.

---

## Cost Breakdown (Production)

Per `backend/fly.toml`: app `expensify-backend-dusky-summit-570`, region `bom`, a single `shared-cpu-1x` 256MB machine with a 1GB persistent volume.

| Service    | Tier               | Cost/month | Notes                          |
|------------|---------------------|-----------|----------------------------------|
| Fly.io machine | shared-cpu-1x, 256MB | ~$1.94    | Always-on (`min_machines_running = 1`) |
| Fly.io volume  | 1GB persistent       | ~$0.15    | SQLite file storage             |
| GitHub Actions | Free                 | $0        | 2,000 min/month free for private repos |
| **Total**      |                      | **~$2.10/mo** |                              |

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full deployment walkthrough.
