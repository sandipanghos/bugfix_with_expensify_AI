# GitHub Issue Notifier & Auto-Proposer

Monitors any GitHub repository for new issues matching a configured label and emails you within ~10 seconds of the label being added. Also emails you on every update to a watched issue, and **automatically generates + posts a contributor proposal comment** via Claude (`claude-opus-4-8`) in parallel with the first email.

No webhooks needed. No Redis. No Docker required for local dev. No auth. SQLite + SMTP (+ optional Anthropic API for auto-proposals) only.

---

## How It Works

```
GitHub Issues REST API  ◄── Fast Poller (every 5s)
         │
         ▼  new issue with watched label? created ≤ 7 days ago? under daily limit?
    NotificationRecord saved (PENDING) + issue data cached in memory
         │
         ▼  fires both in parallel, immediately
    ┌────┴──────────────────────────────────────┐
    │                                           │
    ▼                                           ▼
Email sent                              Auto-Proposal (if enabled)
 ~8–12s from label detected              Claude claude-opus-4-8
 3-email cap if no proposal posted       ~15–25s from label detected
 by myGithubUsername yet                 Posts comment to GitHub issue
    │
    ▼  Issue updated later?
GitHub Events API  ◄── Events Poller (~60s, ETag-cached, dynamic interval)
    → hasPendingUpdate = true → update email sent next cycle
```

**Key properties:**
- Email and proposal fire simultaneously — neither waits for the other
- Fast Poller (5s REST) handles initial detection; Events Poller (~60s) handles updates
- 7-day guard on both pollers — issues older than 7 days are never selected
- Proposal guards prevent duplicates before calling the LLM

---

## Prerequisites

| Tool     | Version | Install |
|----------|---------|---------|
| Node.js  | v22+    | https://nodejs.org |
| npm      | v10+    | Bundled with Node |

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

Edit `.env`:
```env
DATABASE_URL="file:./dev.db"
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx

# Required for auto-proposals (POST /api/proposals and autoProposal: true)
ANTHROPIC_API_KEY=sk-ant-...
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
# Set what to watch, where to email, and your GitHub identity
curl -X PUT http://localhost:3001/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "notificationEmail": "you@example.com",
    "watchedRepo": "Expensify/App",
    "watchedLabel": "Help Wanted",
    "issueLimit": 4,
    "githubToken": "ghp_...",
    "myGithubUsername": "your-github-username",
    "autoProposal": true
  }'

# Start monitoring
curl -X POST http://localhost:3001/api/config/start

# Check it's running
curl http://localhost:3001/api/config/status
```

> `myGithubUsername` is required for `autoProposal: true`. It gates the 3-email cap and is used to check if you already posted a proposal on an issue.

---

## Environment Variables

### Required (5 values)

```env
DATABASE_URL="file:./dev.db"

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
```

### Optional

```env
# Required only for auto-proposals (autoProposal: true or POST /api/proposals)
ANTHROPIC_API_KEY=sk-ant-...
```

Without `ANTHROPIC_API_KEY`, all email notification features work normally. Auto-proposal is silently skipped; `POST /api/proposals` returns 500 if called.

### Getting Gmail App Password
1. Enable 2FA on your Gmail account
2. Google Account → Security → App Passwords → create one named "Notifier"
3. Use the 16-character code (with spaces) as `SMTP_PASS`

### Getting a GitHub PAT (optional but strongly recommended)
| Auth state | Rate limit |
|---|---|
| Unauthenticated | 60 req/hour |
| PAT (`public_repo` scope) | 5,000 req/hour |

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Scope: `public_repo` is sufficient for public repos
3. Set via `PUT /api/config` with `"githubToken": "ghp_..."`

---

## Time Performance

| Stage | Typical time | Notes |
|---|---|---|
| Label added → detected | **0–5s** | Fast Poller fires every 5s |
| Detection → email in inbox | **+1–2s** | SMTP pooled connection (no handshake delay) |
| **Label → email total** | **~6–12s** | Well under 1 minute |
| Issue data (cache hit) | **+0ms** | Pre-cached during Fast Poller detection |
| Issue data (cache miss) | **+400–1200ms** | Live GET /issues (Events Poller detections) |
| GitHub comments fetch | **+200–600ms** | 1 API call per issue |
| Claude `claude-opus-4-8` generation | **+8–20s** | Root cause + proposal writing |
| Post GitHub comment | **+200–500ms** | 1 API call |
| **Label → proposal posted total** | **~10–25s** | Runs in parallel with email |

Email and proposal are independent — the faster one (email ~10s) is not delayed by the slower one (proposal ~20s).

---

## Project Structure

```
backend/
├── src/
│   ├── api/
│   │   ├── config.routes.ts              GET/PUT config, start/stop
│   │   ├── notifications.routes.ts       list/delete/track/trigger-update records
│   │   ├── proposals.routes.ts           manual generate + list proposals
│   │   └── health.routes.ts              health checks
│   ├── services/
│   │   ├── events-poller.service.ts      GitHub Events API + ETag polling;
│   │   │                                 exports issueDataCache for auto-proposal
│   │   ├── notification-sender.service.ts  drain PENDING records, send emails
│   │   ├── auto-proposal.service.ts      auto-generate + post proposals via Claude;
│   │   │                                 runs in parallel with email after every poll
│   │   ├── proposal-generator.service.ts  LLM call (Anthropic SDK, claude-opus-4-8)
│   │   ├── proposal-guards.service.ts    guards gating proposal creation
│   │   └── email.service.ts              Nodemailer wrapper (pooled SMTP connection)
│   ├── jobs/
│   │   └── schedulers.ts                 two schedulers: Events Poller (dynamic ~60s)
│   │                                     + Fast Poller (5s); both fire email + proposal
│   ├── middleware/
│   │   ├── error.middleware.ts
│   │   └── not-found.middleware.ts
│   ├── db/
│   │   └── client.ts                     Prisma singleton
│   ├── utils/
│   │   ├── env.ts                        Zod-validated env
│   │   ├── logger.ts                     Pino logger
│   │   └── octokit.ts                    Octokit factory
│   ├── app.ts                            Express setup
│   └── server.ts                         Entry point
├── prisma/
│   └── schema.prisma                     Config + NotificationRecord + ProposalRecord
├── ROOT_CAUSE_PROMPT_TEMPLATE.md         Prompt template used by proposal generator
├── Dockerfile
├── fly.toml                              Production deploy config
└── .env.example
```

---

## API Reference

### Config

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/config` | View current settings (token hidden) |
| `PUT` | `/api/config` | Update email, repo, label, limit, token, username, autoProposal |
| `GET` | `/api/config/status` | Quick status + daily counts + notify window |
| `POST` | `/api/config/start` | Start monitoring |
| `POST` | `/api/config/stop` | Pause monitoring |

### Notifications (Issues)

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/notifications` | List records (`?status=SENT&page=1&limit=20`) |
| `GET` | `/api/notifications/:id` | Single record |
| `POST` | `/api/notifications/track` | Manually track an issue by number |
| `POST` | `/api/notifications/:id/trigger-update` | Manually flag for an update email |
| `DELETE` | `/api/notifications/:id` | Soft delete |
| `DELETE` | `/api/notifications/:id/hard` | Hard delete |
| `POST` | `/api/notifications/:id/restore` | Restore soft-deleted |

### Proposals

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/proposals` | Manually generate (LLM) + post a proposal for any issue. No age restriction. Requires `ANTHROPIC_API_KEY`. |
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
| `notificationEmail` | `""` (required to start) | Where to send emails |
| `watchedRepo` | `Expensify/App` | GitHub repo in `owner/repo` format |
| `watchedLabel` | `Help Wanted` | Label to filter on |
| `issueLimit` | `4` | Max new issues selected per day |
| `githubToken` | `null` | Optional PAT (strongly recommended) |
| `myGithubUsername` | `""` | Your GitHub username — required for `autoProposal` and the 3-email cap |
| `autoProposal` | `false` | Auto-generate and post proposals when new issues are detected |
| `notifyStartTime` | `""` | Notify window start, `HH:MM` 24h. Empty = always notify |
| `notifyEndTime` | `""` | Notify window end, `HH:MM` 24h. Empty = always notify |
| `notifyTimezone` | `"UTC"` | IANA timezone for the notify window (e.g. `Asia/Kolkata`) |

### Email cap behavior

When `myGithubUsername` is set, emails for a given issue are capped at **3 total** (1 initial + 2 updates) if you have not posted a proposal on it. Once you post a proposal (manually via `POST /api/proposals` or automatically via `autoProposal: true`), the cap lifts and update emails resume normally.

---

## Available Scripts

```bash
npm run dev          # Start with hot-reload (ts-node-dev)
npm run build        # Compile TypeScript → dist/
npm run start        # Start compiled app (requires npm run build first)
npm run db:push      # Apply schema changes to SQLite (dev)
npm run db:studio    # Open Prisma Studio (visual DB browser)
npm run typecheck    # TypeScript type check (no emit)
npm run lint         # ESLint
npm run test         # Run tests (Vitest)
```

---

## Deployment (Production)

See [DEPLOYMENT.md](DEPLOYMENT.md) for full instructions.

**Recommended: Fly.io (~$2.10/month)**

```bash
cd backend
flyctl launch --name github-issue-notifier --no-deploy
flyctl volumes create notifier_data --size 1 --region ams
flyctl secrets set \
  SMTP_HOST=smtp.gmail.com \
  SMTP_PORT=587 \
  SMTP_USER=you@gmail.com \
  "SMTP_PASS=xxxx xxxx xxxx xxxx" \
  ANTHROPIC_API_KEY=sk-ant-...
flyctl deploy --remote-only
```

**Zero cost: Oracle Cloud Always Free** — see [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Troubleshooting

**No emails arriving:**
- Check `GET /api/config/status` — is `isRunning: true`?
- Check `GET /api/notifications` — any records with `status: PENDING`?
- Verify SMTP credentials: Gmail requires App Password, not account password
- Check notify window: `isInNotifyWindow: false` in status means emails are held until the window opens

**Issues not being detected:**
- Set a `githubToken` — unauthenticated limit is 60 req/hour; Fast Poller alone uses ~720 req/hour
- Check logs for 403 errors (rate limit)
- Verify `watchedRepo` format: must be `owner/repo` (e.g. `Expensify/App`)
- Issues must be ≤ 7 days old to be selected

**Auto-proposal not posting:**
- Check `autoProposal: true` and `myGithubUsername` is set in `GET /api/config/status`
- Verify `ANTHROPIC_API_KEY` is set in `.env`
- Verify `githubToken` is set — needed to post comments
- Check server logs for `Auto-proposal guard blocked` messages (means a proposal already exists)

**GitHub rate limit (403):**
- Set a PAT via `PUT /api/config` with `"githubToken": "ghp_..."`
- System automatically backs off to 120s poll interval on 403

**Prisma / database issues:**
```bash
cd backend
npm run db:push      # re-apply schema (safe to re-run)
npm run db:studio    # inspect data visually
```
