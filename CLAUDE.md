# GitHub Issue Notifier — Backend

## What This System Does

Monitors any GitHub repository for new issues matching a configured label and sends email notifications immediately. Also sends update emails when a watched issue is modified.

No webhooks, no Redis, no job queues. Runs on SQLite + SMTP only.

---

## Architecture

### Three Schedulers (always running)

| Scheduler | Interval | Purpose |
|---|---|---|
| Events Poller | Dynamic (from GitHub `X-Poll-Interval`, starts at 60s; first tick at 2s after startup) | Detects new/updated issues via GitHub Events API + ETag |
| Email Sender | Fixed 20s | Drains PENDING notification records, sends emails, retries failures |
| Issue Syncer | Fixed 1min (first run 30s after startup) | Directly polls REST API for each tracked issue; detects title/body changes the Events API delayed or missed |

### Event Detection Flow

```
GitHub Events API (GET /repos/{owner}/{repo}/events)
  + ETag (If-None-Match header)  →  304 = nothing changed (free, no rate-limit cost)
                                 →  200 = new events
                                       Save ETag + pollInterval to DB first
                                       ↓
                                       Always (window does NOT gate record creation):
                                               IssuesEvent action=opened|labeled
                                                 + has watched label
                                                 + issue created within 7 days
                                                 + daily limit not reached
                                                 → create NotificationRecord (PENDING)
                                                 → increment dailySelectedCount
                                               Any IssuesEvent (any action)
                                                 + already-selected issue
                                                 + action=edited → sync changed title/body fields
                                                 → set hasPendingUpdate=true
                                               Any IssueCommentEvent (any action)
                                                 + already-selected issue
                                                 → set hasPendingUpdate=true
                                       isWithinNotifyWindow()?
                                         NO  → emails held in DB until window opens (sender gates sending)
  403 (rate limited)             →  back off to 120s
```

### Email Sending Flow

```
Every 20 seconds (and immediately after any poller cycle that made DB changes):
  Already sending? → skip (concurrency lock prevents duplicate sends)
  isWithinNotifyWindow()? NO → skip (poller may have set hasPendingUpdate outside window;
                                      email held until window opens)

  Fetch PENDING records + SENT+hasPendingUpdate records in one parallel DB query

  Send all emails in parallel (Promise.all):

  For each PENDING record:
    → try sendMail → success: status=SENT, notifiedAt=now, attempts++
                   → fail:   attempts++, lastAttemptAt=now, retry next 20s (indefinite)

  For each SENT+hasPendingUpdate record:
    → try sendMail (update email) → success: hasPendingUpdate=false, updateEmailCount++, lastUpdateEmailAt=now
                                  → fail:   retry next 20s (indefinite)
```

### Notification Window

- Configured via `notifyStartTime`, `notifyEndTime` (HH:MM, 24h), and `notifyTimezone` (IANA)
- Both must be set for the filter to activate; empty strings = always notify
- Checked in the **poller** (after ETag save): new record creation is skipped outside the window, but field syncs and `hasPendingUpdate` for existing records still happen so no update is lost
- Checked in the **sender**: emails are held until the window opens (regardless of when hasPendingUpdate was set)
- Supports overnight windows (e.g. `22:00`–`06:00`)

### Daily Issue Limit

- `Config.dailySelectedCount` tracks how many new issues were selected today
- Compared against `Config.dailyResetDate` (YYYY-MM-DD) on every poller cycle; resets to 0 on new day
- Update emails for already-selected issues are NOT counted against the limit
- Default limit: 4 new issues per day (configurable 1–100)
- Issues created more than 7 days ago are skipped (staleness filter, new selections only)

---

## Environment Variables

Set in `backend/.env` (copy from `backend/.env.example`).

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` \| `test` \| `production` |
| `PORT` | No | `3001` | HTTP server port |
| `DATABASE_URL` | Yes | — | SQLite path, e.g. `file:./dev.db` |
| `SMTP_HOST` | Yes | — | SMTP server hostname (e.g. `smtp.gmail.com`) |
| `SMTP_PORT` | No | `587` | SMTP server port |
| `SMTP_SECURE` | No | `false` | `true` for port 465 / SSL |
| `SMTP_USER` | Yes | — | SMTP auth email (also used as sender address) |
| `SMTP_PASS` | Yes | — | SMTP auth password / app password |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origin(s) |

> **Runtime config** (repo, label, email, notify window, etc.) is managed via `PUT /api/config` — not env vars.

---

## Database Models

### Config (singleton row, id = "singleton")

| Field | Type | Default | Description |
|---|---|---|---|
| id | String PK | `"singleton"` | Always one row |
| notificationEmail | String | `""` | Email address to notify |
| watchedRepo | String | `"Expensify/App"` | GitHub repo (`owner/repo`) |
| watchedLabel | String | `"Help Wanted"` | Label to watch for |
| issueLimit | Int | `4` | Max new issues selected per day (1–100) |
| githubToken | String? | `null` | Optional PAT (5 000 req/hr vs 60) |
| lastEtag | String? | `null` | Last ETag from Events API |
| pollIntervalSeconds | Int | `60` | Updated dynamically from `X-Poll-Interval` |
| dailySelectedCount | Int | `0` | New issues selected today |
| dailyResetDate | String | `""` | YYYY-MM-DD of last daily reset |
| isRunning | Boolean | `false` | Master on/off switch |
| notifyStartTime | String | `""` | Window start in `HH:MM` (24h). Empty = no filter |
| notifyEndTime | String | `""` | Window end in `HH:MM` (24h). Empty = no filter |
| notifyTimezone | String | `"UTC"` | IANA timezone for the notify window |
| updatedAt | DateTime | auto | Last update timestamp |

### NotificationRecord (one per selected issue)

| Field | Type | Default | Description |
|---|---|---|---|
| id | String PK (CUID) | auto | Unique record ID |
| githubIssueNumber | Int (unique) | — | GitHub issue number |
| title | String | — | Issue title (kept current; updated on `edited` events) |
| url | String | — | Issue URL |
| repoFullName | String | — | `owner/repo` |
| matchedLabel | String | — | Label that triggered selection |
| status | Enum | `PENDING` | `PENDING` → `SENT` (failures stay `PENDING` and retry) |
| attempts | Int | `0` | Total send attempts |
| lastAttemptAt | DateTime? | `null` | Timestamp of last send attempt |
| notifiedAt | DateTime? | `null` | When initial email was successfully sent |
| hasPendingUpdate | Boolean | `false` | True when an update email needs sending |
| updateEmailCount | Int | `0` | Total update emails sent |
| lastUpdateEmailAt | DateTime? | `null` | Timestamp of last update email |
| deletedAt | DateTime? | `null` | Soft-delete timestamp (`null` = active) |
| createdAt | DateTime | `now()` | Record creation time |
| updatedAt | DateTime | auto | Last update time |

### Enum: NotifStatus
- `PENDING` — not yet sent; retried every 20s within the notify window
- `SENT` — initial email delivered successfully
- `FAILED` — defined in schema; currently records stay `PENDING` and retry indefinitely

---

## API Endpoints

All `/api/*` routes are rate-limited to **200 requests per 15 minutes**. Request body size limit is **10 KB**.

### Health

| Method | Route | Description |
|---|---|---|
| GET | `/health` | Returns uptime; no rate limit |
| GET | `/health/ready` | DB connectivity check; 503 if DB unreachable |

### Config

| Method | Route | Description |
|---|---|---|
| GET | `/api/config` | Current config (token hidden, `hasGithubToken` bool returned) |
| PUT | `/api/config` | Partial update of config fields |
| GET | `/api/config/status` | Quick status snapshot including window state |
| POST | `/api/config/start` | Enable notification service (400 if no `notificationEmail`) |
| POST | `/api/config/stop` | Disable notification service |

### Notifications

| Method | Route | Description |
|---|---|---|
| GET | `/api/notifications` | Paginated list; filterable by status |
| GET | `/api/notifications/:id` | Single record by CUID |
| POST | `/api/notifications/track` | Manually track an issue by number (fetches from GitHub, creates PENDING record) |
| DELETE | `/api/notifications/:id` | Soft delete (sets `deletedAt`); 409 if already deleted |
| DELETE | `/api/notifications/:id/hard` | Permanent delete |
| POST | `/api/notifications/:id/restore` | Un-soft-delete; 409 if not deleted |

---

## Request & Response Shapes

### GET /health
```json
{ "status": "ok", "uptime": 123.456 }
```

### GET /health/ready
```json
{ "status": "ready",     "db": "connected"    }
{ "status": "not ready", "db": "disconnected" }
```

### GET /api/config
```json
{
  "config": {
    "id": "singleton",
    "notificationEmail": "you@example.com",
    "watchedRepo": "Expensify/App",
    "watchedLabel": "Help Wanted",
    "issueLimit": 4,
    "pollIntervalSeconds": 60,
    "dailySelectedCount": 2,
    "dailyResetDate": "2025-02-15",
    "isRunning": true,
    "notifyStartTime": "09:00",
    "notifyEndTime": "18:00",
    "notifyTimezone": "Asia/Kolkata",
    "updatedAt": "2025-02-15T09:00:00.000Z"
  },
  "hasGithubToken": true
}
```

### PUT /api/config
**Request body** (all fields optional):
```json
{
  "notificationEmail": "you@example.com",
  "watchedRepo": "owner/repo",
  "watchedLabel": "Help Wanted",
  "issueLimit": 4,
  "githubToken": "ghp_...",
  "notifyStartTime": "09:00",
  "notifyEndTime": "18:00",
  "notifyTimezone": "Asia/Kolkata"
}
```

**Validation rules:**

| Field | Rule |
|---|---|
| `notificationEmail` | Valid email |
| `watchedRepo` | Must match `^[^/]+\/[^/]+$` |
| `watchedLabel` | Non-empty string |
| `issueLimit` | Integer 1–100 |
| `githubToken` | Non-empty string or `null` |
| `notifyStartTime` | `HH:MM` (00:00–23:59) or `""` (clears filter) |
| `notifyEndTime` | `HH:MM` (00:00–23:59) or `""` (clears filter) |
| `notifyTimezone` | Valid IANA timezone string |

**Side effects:**
- Changing `watchedRepo` resets `lastEtag`, `dailySelectedCount`, `dailyResetDate`
- Setting `notifyStartTime` or `notifyEndTime` to `""` disables the window filter

**Response:** same shape as `GET /api/config`.

### GET /api/config/status
```json
{
  "isRunning": true,
  "watchedRepo": "Expensify/App",
  "watchedLabel": "Help Wanted",
  "issueLimit": 4,
  "notificationEmail": "you@example.com",
  "dailySelectedCount": 2,
  "isNewDay": false,
  "pollIntervalSeconds": 60,
  "hasGithubToken": true,
  "notifyStartTime": "09:00",
  "notifyEndTime": "18:00",
  "notifyTimezone": "Asia/Kolkata",
  "isInNotifyWindow": true
}
```

- `isNewDay` — `true` when today's date differs from `dailyResetDate`
- `isInNotifyWindow` — `true` when current time (in `notifyTimezone`) is inside the configured window, or when no window is set

### POST /api/config/start
```json
{ "status": "running", "message": "Notification service started" }   // 200
{ "error": "notificationEmail must be set before starting" }          // 400
```

### POST /api/config/stop
```json
{ "status": "stopped", "message": "Notification service stopped" }
```

### GET /api/notifications
**Query params** (all optional):

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | Page number |
| `limit` | integer 1–100 | `20` | Records per page |
| `status` | `PENDING` \| `SENT` \| `FAILED` | — | Filter by status |
| `includeDeleted` | boolean | `false` | Include soft-deleted records |

```json
{
  "data": [
    {
      "id": "cma1b2c3d4",
      "githubIssueNumber": 42,
      "title": "Fix login flow",
      "url": "https://github.com/Expensify/App/issues/42",
      "repoFullName": "Expensify/App",
      "matchedLabel": "Help Wanted",
      "status": "SENT",
      "attempts": 1,
      "lastAttemptAt": "2025-02-15T10:30:00.000Z",
      "notifiedAt": "2025-02-15T10:30:00.000Z",
      "hasPendingUpdate": false,
      "updateEmailCount": 0,
      "lastUpdateEmailAt": null,
      "deletedAt": null,
      "createdAt": "2025-02-15T10:00:00.000Z",
      "updatedAt": "2025-02-15T10:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "pages": 3
  }
}
```

### GET /api/notifications/:id
```json
{ "data": { /* NotificationRecord */ } }      // 200
{ "error": "Notification record not found" }  // 404
```

### DELETE /api/notifications/:id
```json
{ "data": { /* updated record */ }, "message": "Record soft-deleted" }  // 200
{ "error": "Record is already soft-deleted" }                            // 409
{ "error": "Notification record not found" }                             // 404
```

### DELETE /api/notifications/:id/hard
```json
{ "message": "Record permanently deleted" }   // 200
{ "error": "Notification record not found" }  // 404
```

### POST /api/notifications/:id/restore
```json
{ "data": { /* restored record */ }, "message": "Record restored" }  // 200
{ "error": "Record is not soft-deleted" }                             // 409
{ "error": "Notification record not found" }                          // 404
```

### POST /api/notifications/track
**Request body:**
```json
{ "issueNumber": 42 }
```
**Response:**
```json
{ "data": { /* NotificationRecord with status=PENDING */ }, "message": "Issue #42 is now being tracked" }  // 201
{ "error": "Issue #42 is already being tracked" }                                                          // 409
{ "error": "Issue #42 not found in Expensify/App" }                                                        // 404
{ "error": "watchedRepo is not configured (expected owner/repo)" }                                         // 400
```
If the issue was previously soft-deleted, it is restored and re-queued as PENDING.

### Error responses (global)
```json
{ "error": "Validation error", "details": { "field": "message" } }  // 400
{ "error": "Not found" }                                             // 404
{ "error": "Internal server error" }                                 // 500
```

---

## Local Development

### 1. Install dependencies
```bash
cd backend && npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in DATABASE_URL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
```

### 3. Set up database
```bash
npm run db:push
```

### 4. Start
```bash
npm run dev
```

### 5. Configure via API
```bash
curl -X PUT http://localhost:3001/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "notificationEmail": "you@example.com",
    "watchedRepo": "Expensify/App",
    "watchedLabel": "Help Wanted",
    "issueLimit": 4,
    "githubToken": "ghp_...",
    "notifyStartTime": "09:00",
    "notifyEndTime": "18:00",
    "notifyTimezone": "Asia/Kolkata"
  }'

curl -X POST http://localhost:3001/api/config/start

# Check current window status
curl http://localhost:3001/api/config/status
```

---

## Production Deployment

### Cost Comparison

| Platform | Cost | Notes |
|---|---|---|
| **Fly.io** (recommended) | ~$2.10/month | Easiest DX, persistent volume |
| **Oracle Cloud Free Tier** | $0/month forever | More setup, true zero cost |
| **Railway** | ~$2–3/month | $5 credit given on signup |
| **Render** | $7/month | Paid tier required (free tier sleeps) |

> **The poller must run 24/7.** Any platform that "sleeps" idle instances (Render free, Vercel, Netlify) will NOT work.

---

### Option A — Fly.io (~$2.10/month) ✅ Recommended

```bash
# 1. Install flyctl
# macOS:  brew install flyctl
# Windows: winget install flyctl
# Linux:  curl -L https://fly.io/install.sh | sh

# 2. Log in
flyctl auth login

# 3. Create the app (run from backend/)
cd backend
flyctl launch --name github-issue-notifier --no-deploy

# 4. Create persistent volume for SQLite (1 GB = $0.15/month)
flyctl volumes create notifier_data --size 1 --region ams

# 5. Set secrets (never commit these)
flyctl secrets set \
  SMTP_HOST=smtp.gmail.com \
  SMTP_PORT=587 \
  SMTP_SECURE=false \
  SMTP_USER=your@gmail.com \
  SMTP_PASS="xxxx xxxx xxxx xxxx"

# 6. Deploy
flyctl deploy --remote-only
```

After deploy:
```bash
flyctl info   # get your app URL

curl -X PUT https://github-issue-notifier.fly.dev/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "notificationEmail": "you@example.com",
    "watchedRepo": "Expensify/App",
    "watchedLabel": "Help Wanted",
    "issueLimit": 4,
    "githubToken": "ghp_...",
    "notifyStartTime": "09:00",
    "notifyEndTime": "18:00",
    "notifyTimezone": "UTC"
  }'

curl -X POST https://github-issue-notifier.fly.dev/api/config/start
```

Useful commands:
```bash
flyctl status          # machine status
flyctl logs            # live logs
flyctl ssh console     # SSH into the machine
flyctl deploy          # redeploy after code changes
flyctl secrets list    # view secret names (not values)
```

---

### Option B — Oracle Cloud Always Free ($0/month forever)

```bash
# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git

# Clone your repo
git clone https://github.com/YOUR/REPO.git
cd REPO/backend

# Install deps and build
npm ci && npm run build && npx prisma generate

# Set env vars
cp .env.example .env
nano .env   # fill in SMTP_* values, DATABASE_URL=file:./prod.db

# Push DB schema
npm run db:push

# Install PM2
sudo npm install -g pm2

# Start with PM2
pm2 start dist/server.js --name notifier
pm2 save
pm2 startup   # run the printed command to auto-start on reboot

curl -X PUT http://localhost:3001/api/config \
  -H "Content-Type: application/json" \
  -d '{"notificationEmail":"you@example.com","watchedRepo":"Expensify/App","watchedLabel":"Help Wanted","issueLimit":4}'

curl -X POST http://localhost:3001/api/config/start
```

---

### CI/CD — Auto-deploy on Git Push (Fly.io)

Already configured in [.github/workflows/deploy.yml](.github/workflows/deploy.yml).

| Secret | Value |
|---|---|
| `FLY_API_TOKEN` | Output of `flyctl tokens create deploy` |
| `PROD_API_URL` | `https://github-issue-notifier.fly.dev` |

Every push to `master` that touches `backend/` will auto-deploy.

---

### Infrastructure Files

| File | Purpose |
|---|---|
| [backend/Dockerfile](backend/Dockerfile) | Multi-stage build: compile TS → minimal runner image |
| [backend/.dockerignore](backend/.dockerignore) | Excludes node_modules, .env, *.db from image |
| [backend/fly.toml](backend/fly.toml) | Fly.io app config: region, volume mount, health check |
| [.github/workflows/deploy.yml](.github/workflows/deploy.yml) | Auto-deploy to Fly.io on push to master |

---

## Key Design Decisions

- **No Redis / BullMQ**: `NotificationRecord` table IS the queue. Status field drives the send loop.
- **No auth**: Single-user tool. Add an `API_KEY` env check if making public-facing.
- **Dynamic poll interval**: Reads `X-Poll-Interval` from GitHub response header each cycle. Starts at 60s.
- **ETag**: Sends `If-None-Match` on every poll. GitHub returns 304 (no rate-limit cost) when nothing changed.
- **Notify window gates email sending only**: The poller always creates records and syncs field changes regardless of `notifyStartTime`/`notifyEndTime`. The sender's window check is the sole gate on when emails are delivered. Issues labeled during off-hours are tracked immediately and emailed when the window opens — nothing is permanently lost due to timing.
- **Same-batch update folding**: If a newly-selected issue also triggers update detection in the same poll cycle (e.g. opened + commented within the same 60-second window), the update is folded directly into the `createMany` entry so `hasPendingUpdate=true` is set atomically on creation, avoiding a `createMany`/`updateMany` parallel-write race.
- **ETag saved before window check**: Ensures events are not replayed when the window opens.
- **Sender concurrency lock**: `NotificationSenderService.isSending` flag prevents two concurrent sender runs (e.g. the immediate post-poller send and the 20s interval overlapping), which would send duplicate update emails.
- **Overnight windows supported**: e.g. `notifyStartTime=22:00`, `notifyEndTime=06:00`.
- **Indefinite email retry**: No max attempt cap. Failures stay `PENDING` and are retried every 20s (within the window).
- **Staleness filter**: Issues created more than 7 days ago are silently skipped for new selection only. Already-selected issues always receive update notifications.
- **Update triggers**: Any `IssuesEvent` or `IssueCommentEvent` on an already-selected issue queues an update email. No action allow-list — every current and future GitHub action is automatically covered. `edited` events additionally sync the title and body fields so emails always show current content.
- **Title sync on edit**: When an `edited` event carries a changed title, the stored title is updated immediately (regardless of `hasPendingUpdate` state) so the update email always shows the current title.
- **Update while PENDING**: `hasPendingUpdate` is set even on `PENDING` records. The update email follows the initial one automatically once it is delivered.
- **Batch DB writes**: New records use `createMany`. `hasPendingUpdate` flags use `updateMany`. Title changes use individual parallel `update` calls. `dailySelectedCount` is written once after the loop — all flushed in a single `Promise.all`.
- **Parallel email sending**: Initial and update emails are sent concurrently via `Promise.all`. One failure does not block others.
- **Per-poll DB reads**: A single `findMany` fetches all existing records for the issue numbers seen in a poll batch, replacing per-event queries.
- **Issue limit is for new selections only**: Update emails on already-selected issues are unlimited.
- **Rate limit handling**: On 403 from GitHub, backs off to 120s automatically.
- **Token hidden from API**: `GET /api/config` never returns `githubToken`; only a `hasGithubToken` boolean.

---

## File Structure

```
backend/src/
  api/
    config.routes.ts                GET/PUT config, start/stop, isWithinNotifyWindow helper
    notifications.routes.ts         CRUD for notification records
    health.routes.ts                /health and /health/ready
  services/
    events-poller.service.ts        GitHub Events API + ETag logic, window filter, title sync
    notification-sender.service.ts  Drain PENDING records + send emails, window safety net
    issue-syncer.service.ts         REST API poll for each tracked issue every 1min; catches missed Events API changes
    email.service.ts                Nodemailer wrapper (HTML + plaintext emails)
  jobs/
    schedulers.ts                   Two loops: poller (dynamic interval) + sender (20s)
  middleware/
    error.middleware.ts             Zod validation + generic 500 handler
    not-found.middleware.ts         404 handler
  db/
    client.ts                       Prisma client singleton
  utils/
    env.ts                          Zod-validated env loader (exits on bad config)
    logger.ts                       Pino logger (pretty in dev, JSON in prod)
    octokit.ts                      Octokit factory helper
  app.ts                            Express app: middleware stack + routers
  server.ts                         Entry point: DB connect → HTTP listen → schedulers
prisma/
  schema.prisma                     Config + NotificationRecord models + NotifStatus enum
```
