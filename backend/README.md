# GitHub Issue Notifier — Backend

Monitors a GitHub repository for new issues matching a configured label and sends email notifications instantly. Also sends update emails when a watched issue changes — but only for issues that already have a proposal comment.

**No webhooks. No Redis. No job queues.** Runs on SQLite + SMTP only.

---

## How It Works

A single background poller runs continuously:

```
GitHub Issues REST API — full snapshot every 5s (sorted by created date, newest first)
  → new issue with watched label, created today?  → create NotificationRecord (PENDING)
  → changed watched issue (title/body/comments)?  → set hasPendingUpdate = true
  → open issue no longer in results?              → soft-delete (closed/unlabeled)

Email Sender
  → PENDING records          → sendMail → SENT  (retry on failure)
  → hasPendingUpdate records → sendMail update email → updateEmailCount++
    (skipped unless the issue already has a proposal comment)
```

---

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — fill in SMTP credentials
```

### 3. Push database schema

```bash
npm run db:push
```

### 4. Start dev server

```bash
npm run dev
```

### 5. Configure and start the notifier

```bash
# Set watched repo, label, email, optional GitHub token
curl -X PUT http://localhost:3001/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "notificationEmail": "you@example.com",
    "watchedRepo": "Expensify/App",
    "watchedLabel": "Help Wanted",
    "issueLimit": 4,
    "githubToken": "ghp_..."
  }'

# Start
curl -X POST http://localhost:3001/api/config/start

# Check status
curl http://localhost:3001/api/config/status
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | No | `development` / `production` / `test` (default: `development`) |
| `PORT` | No | HTTP port (default: `3001`) |
| `DATABASE_URL` | Yes | SQLite path — e.g. `file:./dev.db` |
| `SMTP_HOST` | Yes | SMTP server — e.g. `smtp.gmail.com` |
| `SMTP_PORT` | No | SMTP port (default: `587`) |
| `SMTP_SECURE` | No | `true` for SSL/port 465, `false` for STARTTLS/port 587 (default: `false`) |
| `SMTP_USER` | Yes | SMTP username / sender address |
| `SMTP_PASS` | Yes | SMTP password or App Password |
| `CORS_ORIGIN` | No | Allowed CORS origin (default: `*`) |

> **Gmail users:** Enable 2FA → Google Account → Security → App passwords → create one. Use the 16-character App Password (spaces are fine) as `SMTP_PASS`.

All notifier settings (repo, label, email, limit, GitHub token) are managed at runtime via `PUT /api/config` — no restart needed.

---

## API Reference

### Config

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/config` | Get current config (GitHub token hidden) |
| `PUT` | `/api/config` | Update any config field |
| `GET` | `/api/config/status` | Quick status: isRunning, daily counts, poll interval |
| `POST` | `/api/config/start` | Start the notification service |
| `POST` | `/api/config/stop` | Stop the notification service |

### Notifications

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/notifications` | List all records (paginated, `?status=PENDING\|SENT`, `?includeDeleted=true`) |
| `GET` | `/api/notifications/:id` | Single record |
| `DELETE` | `/api/notifications/:id` | Soft delete (sets `deletedAt`) |
| `DELETE` | `/api/notifications/:id/hard` | Permanent delete |
| `POST` | `/api/notifications/:id/restore` | Restore a soft-deleted record |

### Health

| Method | Route | Description |
|---|---|---|
| `GET` | `/health` | Server uptime |
| `GET` | `/health/ready` | Database connectivity check |

---

## Database Models

### Config (singleton)

| Field | Default | Description |
|---|---|---|
| `notificationEmail` | `""` | Where to send emails |
| `watchedRepo` | `"Expensify/App"` | GitHub repo (`owner/repo`) |
| `watchedLabel` | `"Help Wanted"` | Label to watch (case-insensitive) |
| `issueLimit` | `4` | Max new issues selected per day |
| `githubToken` | `null` | Optional PAT (5000 req/hr vs 60) |
| `isRunning` | `false` | Master on/off switch |
| `pollIntervalSeconds` | `60` | Legacy — the poller now runs on a fixed 5s interval |
| `dailySelectedCount` | `0` | New issues selected today (resets at date change) |
| `lastEtag` | `null` | Legacy column — no longer used (poller does not use ETags) |

### NotificationRecord (one per issue)

| Field | Description |
|---|---|
| `githubIssueNumber` | GitHub issue number (unique) |
| `status` | `PENDING` → `SENT` (failures stay `PENDING` and retry) |
| `attempts` | Total send attempts |
| `notifiedAt` | Timestamp of successful initial email |
| `hasPendingUpdate` | `true` when an update email needs to be sent |
| `updateEmailCount` | Number of update emails sent |
| `deletedAt` | Soft-delete timestamp (`null` = active) |

---

## NPM Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start with hot-reload (tsx watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | ESLint (zero warnings) |
| `npm test` | All tests (unit + integration + performance) |
| `npm run test:unit` | Unit tests only (fast, no DB) |
| `npm run test:api` | Integration tests (real SQLite) |
| `npm run test:performance` | Performance benchmarks |
| `npm run test:coverage` | Coverage report (HTML in `coverage/`) |
| `npm run db:push` | Push Prisma schema to DB |
| `npm run db:studio` | Open Prisma Studio (visual DB browser) |

---

## File Structure

```
backend/
├── src/
│   ├── api/
│   │   ├── config.routes.ts          # GET/PUT config, start/stop
│   │   ├── notifications.routes.ts   # CRUD for notification records
│   │   └── health.routes.ts          # /health, /health/ready
│   ├── services/
│   │   ├── issue-poller.service.ts   # 5s full-snapshot Issues REST API scan
│   │   ├── notification-sender.service.ts  # Drain PENDING queue + send emails
│   │   └── email.service.ts          # Nodemailer wrapper (initial + update)
│   ├── jobs/
│   │   └── schedulers.ts             # Two schedulers: poller + email sender
│   ├── middleware/
│   │   ├── error.middleware.ts        # Zod + generic error handler
│   │   └── not-found.middleware.ts    # 404 handler
│   ├── db/
│   │   └── client.ts                 # Prisma client singleton
│   ├── utils/
│   │   ├── env.ts                    # Zod-validated env vars
│   │   ├── logger.ts                 # Pino logger
│   │   └── octokit.ts                # Octokit factory
│   ├── app.ts                        # Express app setup
│   └── server.ts                     # Entry point
├── prisma/
│   └── schema.prisma                 # Config + NotificationRecord models
├── tests/
│   ├── unit/                         # 73 unit tests (mocked deps)
│   ├── integration/                  # 57 integration tests (real SQLite)
│   ├── performance/                  # 8 performance benchmarks
│   ├── fixtures/                     # GitHub event fixtures (real issue data)
│   └── helpers/                      # DB seed/clean utilities
├── Dockerfile                        # Multi-stage build
├── fly.toml                          # Fly.io deployment config
└── .env.example                      # Environment variable template
```

---

## Test Coverage

```
Statements : 95.09%
Branches   : 84.09%
Functions  : 90.00%
Lines      : 95.09%
```

138 tests — all passing in ~5.6s.
root 
---

## Deployment (Fly.io)

```bash
# First time
cd backend
flyctl launch --name expensify-backend-wispy-coastline-4104 --no-deploy
flyctl volumes create notifier_data --size 1 --region ams
flyctl secrets set \
  SMTP_HOST=smtp.gmail.com \
  SMTP_PORT=587 \
  SMTP_SECURE=false \
  SMTP_USER=you@gmail.com \
  SMTP_PASS="xxxx xxxx xxxx xxxx"
flyctl deploy --remote-only

# Subsequent deploys
flyctl deploy --remote-only

# Useful commands
flyctl logs       # live logs
flyctl status     # machine status
flyctl ssh console  # SSH in
```

After deploying, configure via API using your Fly.io app URL.

> Cost: ~$2.10/month (1 shared CPU + 256MB RAM + 1GB volume)

See [CLAUDE.md](../CLAUDE.md) for full deployment options including Oracle Cloud free tier.
