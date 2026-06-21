# GitHub Issue Notifier & Auto-Proposer

Monitors any GitHub repository for new issues matching a configured label and emails you immediately. Also emails you on every update to a watched issue, and can generate + post a contributor proposal comment via an LLM (`POST /api/proposals`).

No webhooks needed. No Redis. No Docker required for local dev. No auth. SQLite + SMTP (+ optional Anthropic API for proposals) only.

---

## How It Works

```
GitHub Events API (polls every ~60s with ETag, dynamic interval, single scheduler)
         │
         ▼  new issue with watched label?
    Select it (max N per day, default 4)
         │
         ▼
   NotificationRecord saved (status: PENDING)
         │
         ▼  Email send is triggered reactively, right after this same poll cycle
    Send email → status: SENT          (not on a separate 20s timer — see ARCHITECTURE.md)
         │
         ▼  Issue updated later? (Events API OR direct REST sync, run every cycle)
    hasPendingUpdate = true → update email sent next cycle
```

---

## Prerequisites

| Tool     | Version | Install |
|----------|---------|---------|
| Node.js  | v22+    | https://nodejs.org |
| npm      | v10+    | Bundled with Node |

> `backend/package.json`'s `engines.node` field says `>=24.0.0`, but `.github/workflows/ci.yml` and `backend/Dockerfile` both actually pin Node **22**. This is an unreconciled inconsistency in the current source, not enforced (no `engine-strict`) — Node 22 is what CI/Docker actually run.

No Docker, no Redis, no database server required.

---

## Quick Start

### 1. Clone and install
```bash
git clone https://github.com/<your-username>/github-issue-notifier.git
cd github-issue-notifier/backend
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Edit `.env` — only 5 values needed:
```env
DATABASE_URL="file:./dev.db"
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
```

### 3. Set up database
```bash
npm run db:push
```

### 4. Start server
```bash
npm run dev
# Server runs at http://localhost:3001
```

### 5. Configure and start notifier
```bash
# Set what to watch and where to email
curl -X PUT http://localhost:3001/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "notificationEmail": "you@example.com",
    "watchedRepo": "Expensify/App",
    "watchedLabel": "Help Wanted",
    "issueLimit": 4,
    "githubToken": "ghp_..."
  }'

# Start monitoring
curl -X POST http://localhost:3001/api/config/start

# Check it's running
curl http://localhost:3001/api/config/status
```

---

## Environment Variables

Only these 5 are required. Everything else is configured via the API at runtime.

```env
DATABASE_URL="file:./dev.db"

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
```

Optional — only needed if you want to use `POST /api/proposals`:
```env
ANTHROPIC_API_KEY=
```
Without it, the rest of the system (notifications) works normally; the proposals route returns 500 if called.

### Getting Gmail App Password
1. Enable 2FA on your Gmail account
2. Google Account → Security → App Passwords → create one
3. Use the 16-character code as `SMTP_PASS`

### Getting a GitHub PAT (optional but recommended)
Unauthenticated: 60 API requests/hour
Authenticated PAT: 5,000 requests/hour

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Scopes: `public_repo` is enough for public repos
3. Set via `PUT /api/config` with `"githubToken": "ghp_..."`

---

## Project Structure

```
backend/
├── src/
│   ├── api/
│   │   ├── config.routes.ts         GET/PUT config, start/stop
│   │   ├── notifications.routes.ts  list/delete/track/trigger-update notification records
│   │   ├── proposals.routes.ts      generate (LLM) + post + list contributor proposals
│   │   └── health.routes.ts         health checks
│   ├── services/
│   │   ├── events-poller.service.ts GitHub Events API + ETag polling; also runs the direct
│   │   │                            REST sync and calls the email sender inline, every cycle
│   │   ├── notification-sender.service.ts  drain pending, send emails (called reactively,
│   │   │                            not on its own timer — isSending lock prevents overlap)
│   │   ├── issue-syncer.service.ts  standalone REST-sync class — DEAD CODE, never imported
│   │   ├── proposal-generator.service.ts  LLM call (Anthropic SDK) that drafts a proposal
│   │   ├── proposal-guards.service.ts     the 3 guards gating proposal creation
│   │   └── email.service.ts         Nodemailer wrapper
│   ├── jobs/
│   │   └── schedulers.ts            one scheduler (Events Poller, dynamic interval);
│   │                                email send is triggered reactively inside it
│   ├── middleware/
│   │   ├── error.middleware.ts
│   │   └── not-found.middleware.ts
│   ├── db/
│   │   └── client.ts                Prisma singleton
│   ├── utils/
│   │   ├── env.ts                   Zod-validated env
│   │   ├── logger.ts                Pino logger
│   │   └── octokit.ts              Octokit factory
│   ├── app.ts                       Express setup
│   └── server.ts                    Entry point
├── prisma/
│   └── schema.prisma                Config + NotificationRecord + ProposalRecord models
├── Dockerfile
├── fly.toml                         Production deploy config
└── .env.example
```

---

## API Reference

### Config

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/config` | View current settings |
| `PUT` | `/api/config` | Update email, repo, label, limit, token |
| `GET` | `/api/config/status` | Quick status + daily counts |
| `POST` | `/api/config/start` | Start monitoring |
| `POST` | `/api/config/stop` | Pause monitoring |

### Notifications (Issues)

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/notifications` | List records (`?status=SENT&page=1&limit=20`) |
| `GET` | `/api/notifications/:id` | Single record |
| `POST` | `/api/notifications/track` | Manually track an issue by number |
| `POST` | `/api/notifications/:id/trigger-update` | Manually flag for an update email (sent next poller cycle) |
| `DELETE` | `/api/notifications/:id` | Soft delete |
| `DELETE` | `/api/notifications/:id/hard` | Hard delete |
| `POST` | `/api/notifications/:id/restore` | Restore soft-deleted |

### Proposals

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/proposals` | Generate (LLM) and immediately post a contributor proposal comment. Requires `ANTHROPIC_API_KEY`. |
| `GET` | `/api/proposals` | List records (`?contributorUsername=...&githubIssueNumber=...`) |
| `GET` | `/api/proposals/:id` | Single record |

### Health

| Method | Route | Description |
|---|---|---|
| `GET` | `/health` | Uptime |
| `GET` | `/health/ready` | DB connectivity |

---

## Runtime Config Options

All set via `PUT /api/config`:

| Field | Default | Description |
|---|---|---|
| `notificationEmail` | (required) | Where to send emails |
| `watchedRepo` | `Expensify/App` | GitHub repo (`owner/repo`) |
| `watchedLabel` | `Help Wanted` | Label to filter on |
| `issueLimit` | `4` | Max new issues selected per day |
| `githubToken` | `null` | Optional PAT for higher rate limit |
| `notifyStartTime` | `""` | Notify window start, `HH:MM` 24h. Empty = no filter |
| `notifyEndTime` | `""` | Notify window end, `HH:MM` 24h. Empty = no filter |
| `notifyTimezone` | `"UTC"` | IANA timezone for the notify window |

---

## Available Scripts

```bash
npm run dev          # Start with hot-reload
npm run build        # Compile TypeScript
npm run start        # Start compiled app
npm run db:push      # Apply schema to SQLite
npm run db:studio    # Open Prisma Studio (DB browser)
npm run typecheck    # TypeScript type check
npm run lint         # ESLint
npm run test         # Run tests
```

---

## Deployment (Production)

See [DEPLOYMENT.md](DEPLOYMENT.md) for full instructions.

**Recommended: Fly.io (~$2.10/month)**

```bash
cd backend
flyctl launch --name github-issue-notifier --no-deploy
flyctl volumes create notifier_data --size 1 --region ams
flyctl secrets set SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_USER=you@gmail.com SMTP_PASS="xxxx xxxx xxxx xxxx"
flyctl deploy --remote-only
```

**Zero cost: Oracle Cloud Always Free** — see [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Troubleshooting

**No emails arriving:**
- Check `GET /api/config/status` — is `isRunning: true`?
- Check `GET /api/notifications` — any records with `status: PENDING`?
- Verify SMTP credentials: Gmail requires App Password, not account password

**Issues not being detected:**
- Confirm `githubToken` is set — unauthenticated rate limit is 60 req/hour
- Check logs for rate limit errors (403 from GitHub)
- Verify `watchedRepo` format: must be `owner/repo` (e.g. `Expensify/App`)
- Issue must be ≤7 days old to be selected (recently-created filter)

**GitHub rate limit (403):**
- Set a PAT via `PUT /api/config` with `"githubToken": "ghp_..."`
- System automatically backs off to 120s on 403

**Database issues:**
```bash
cd backend
npm run db:push      # re-apply schema
npm run db:studio    # inspect data visually
```
