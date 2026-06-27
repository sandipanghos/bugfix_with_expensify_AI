# Architecture — GitHub Issue Notifier & Auto-Proposer

## 1. System Overview

Monitors any GitHub repository for new issues matching a configured label, sends email notifications within ~10 seconds, and automatically generates + posts contributor proposal comments via Claude in parallel. Also sends update emails when watched issues change.

**Single user. No auth. No Redis. No job queues. SQLite + SMTP (+ optional Anthropic API for auto-proposals) only.**

> A `frontend/` Next.js scaffold exists in this repo (npm workspace member) but is **disconnected** from this backend — it calls `/api/auth/login`, which does not exist here. It has no CI job and is not part of the deployed system. This document describes the backend only.

---

## 2. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                       Express.js API Server                        │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                         API Layer                            │  │
│  │  GET/PUT /api/config        POST /api/config/start|stop      │  │
│  │  GET /api/notifications     DELETE /api/notifications        │  │
│  │  POST /api/notifications/:id/trigger-update                  │  │
│  │  POST/GET /api/proposals    GET /api/proposals/:id           │  │
│  │  GET /health                GET /health/ready                │  │
│  └──────────────────────┬───────────────────────────────────────┘  │
│                         │                                           │
│  ┌──────────────────────▼───────────────────────────────────────┐  │
│  │                      Service Layer                           │  │
│  │                                                               │  │
│  │  ┌──────────────────────────┐  ┌──────────────────────────┐  │  │
│  │  │  EventsPollerService     │  │  Fast Poller             │  │  │
│  │  │  (~60s, ETag-cached,     │  │  (5s REST Issues API,    │  │  │
│  │  │  dynamic X-Poll-Interval)│  │  detects in 0–5s;        │  │  │
│  │  │  handles updates /       │  │  populates issueDataCache)│  │  │
│  │  │  Events API              │  └────────────┬─────────────┘  │  │
│  │  └────────────┬─────────────┘               │                │  │
│  │               │         both fire after each successful poll  │  │
│  │               └──────────────────┬──────────┘                │  │
│  │                                  │                            │  │
│  │           ┌──────────────────────┴──────────────────────┐    │  │
│  │           │  (parallel, fully independent)               │    │  │
│  │    ┌──────┴──────────────┐   ┌──────────────────────┐   │    │  │
│  │    │ NotificationSender  │   │ AutoProposalService   │   │    │  │
│  │    │ Service             │   │ (reads issueDataCache;│   │    │  │
│  │    │ (isRunning lock,    │   │ generates via LLM +   │   │    │  │
│  │    │ 3-email cap logic,  │   │ posts GitHub comment; │   │    │  │
│  │    │ notify window gate) │   │ isRunning lock)       │   │    │  │
│  │    └─────────────────────┘   └──────────────────────┘   │    │  │
│  │           └──────────────────────────────────────────────┘    │  │
│  │                                                               │  │
│  │  ┌────────────────────────┐  ┌────────────────────────────┐  │  │
│  │  │ ProposalGeneratorSvc   │  │ ProposalGuardsService      │  │  │
│  │  │ (Anthropic SDK,        │  │ (assertNoExistingProposal, │  │  │
│  │  │  claude-opus-4-8)      │  │  assertProposalIsDifferent)│  │  │
│  │  └────────────────────────┘  └────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                         │                                           │
│  ┌──────────────────────▼───────────────────────────────────────┐  │
│  │             SQLite Database (Prisma ORM)                      │  │
│  │   Config (singleton)  |  NotificationRecord  |  ProposalRecord│  │
│  └──────────────────────────────────────────────────────────────┘  │
└──────────────────────┬─────────────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────────┐
        │              │                  │
  ┌─────▼──────┐ ┌─────▼──────┐    ┌──────▼──────┐
  │ GitHub API │ │ Anthropic  │    │ Gmail SMTP  │
  │ Events +   │ │ API        │    │ (Nodemailer,│
  │ REST Issues│ │ (claude-   │    │ pooled      │
  │ + Octokit  │ │ opus-4-8)  │    │ connection) │
  └────────────┘ └────────────┘    └─────────────┘
```

---

## 3. Two Schedulers, Parallel Reactive Services

`backend/src/jobs/schedulers.ts` starts two independent timers. After each successful detection cycle, **both** `NotificationSenderService` and `AutoProposalService` are fired in parallel using fire-and-forget `.catch()` — neither blocks the other or the poller.

### Fast Poller (5s REST)

Detects new issues within 0–5 seconds of label addition.

```
startup (after 4s stagger)
    │
    ▼  every 5 seconds
EventsPollerService.fastPoll()
    ├─ read Config from DB
    ├─ if !isRunning → return false
    ├─ GET /repos/{owner}/{repo}/issues?labels=...&state=open&sort=created&per_page=20
    │   for each issue:
    │   ├─ skip if created_at > 7 days ago  (isRecentlyCreated guard)
    │   ├─ skip if already in DB (upsert with skipDuplicates)
    │   └─ CREATE NotificationRecord (PENDING) + write to issueDataCache
    │       (issueDataCache: Map<issueNumber, {title, body, cachedAt}>)
    │
    ├─ returns hasNew: boolean
    │
    └─ if hasNew:
        ├─ NotificationSenderService.send()   ← parallel, fire-and-forget
        └─ AutoProposalService.run()          ← parallel, fire-and-forget
```

### Events Poller (~60s, dynamic)

Handles updates to watched issues and catches any detections the Fast Poller missed.

```
startup (after 2s)
    │
    ▼
EventsPollerService.poll()
    ├─ read Config from DB
    ├─ if !isRunning → return {pollInterval: 60, hasChanges: false}
    ├─ daily reset check (dailySelectedCount → 0 at midnight)
    ├─ GET /repos/{owner}/{repo}/events?per_page=20
    │   Header: If-None-Match: {lastEtag}
    │
    ├─ 200 OK → save new ETag + X-Poll-Interval, then process events:
    │   ├─ IssuesEvent (opened/labeled):
    │   │   ├─ skip if created_at > 7 days ago
    │   │   ├─ not already in DB + under daily limit
    │   │   │   → CREATE NotificationRecord (PENDING) + increment dailySelectedCount
    │   │   └─ already-tracked (PENDING or SENT): SET hasPendingUpdate=true
    │   ├─ IssuesEvent (edited): sync title/body
    │   └─ IssueCommentEvent on tracked issue: SET hasPendingUpdate=true
    │
    ├─ 304 Not Modified → save interval, skip event processing
    ├─ 403 rate limited → back off to 120s
    │
    ├─ Direct REST sync (every cycle except 403):
    │   for each active PENDING/SENT record:
    │   GET /repos/{owner}/{repo}/issues/{n}
    │     → any field changed → SET hasPendingUpdate=true, sync fields
    │
    ├─ NotificationSenderService.send()   ← parallel, fire-and-forget
    ├─ AutoProposalService.run()          ← parallel, fire-and-forget
    │
    └─ return pollInterval
           │
           ▼
    setTimeout(poll, pollInterval * 1000)   ← reschedules itself
```

### NotificationSenderService

```
isRunning lock? → skip (prevents overlap)
isWithinNotifyWindow()? NO → hold (emails wait in DB until window opens)

PASS 1: all PENDING records (deletedAt=null)
    ├─ 3-email cap check:
    │   if myGithubUsername set AND updateEmailCount >= 2 AND no ProposalRecord exists
    │   → skip (cap reached, no proposal posted yet)
    ├─ sendMail() success → status=SENT, notifiedAt=now, labelDetectedAt measured for lag log
    └─ sendMail() fail   → attempts++, stays PENDING (retried next cycle)

PASS 2: all SENT records where hasPendingUpdate=true (deletedAt=null)
    ├─ same 3-email cap check (updateEmailCount >= 2, no proposal)
    ├─ sendMail() success → hasPendingUpdate=false, updateEmailCount++
    └─ sendMail() fail   → stays true (retried next cycle)
```

### AutoProposalService

```
isRunning lock? → skip (prevents overlap)
config.autoProposal? config.myGithubUsername? ANTHROPIC_API_KEY? githubToken? → abort if any missing

Batch-check ProposalRecords for myGithubUsername across all pending issues
→ filter to toPropose (issues with no existing proposal)

Promise.allSettled(toPropose.map(issue => {
    cache hit → use issueDataCache (skip GET /issues)
    cache miss → GET /repos/{owner}/{repo}/issues/{n}

    listIssueComments()
    assertNoExistingProposal()   ← guard: proposal already exists in GitHub comments?
    generateProposal()           ← LLM call (claude-opus-4-8)
    assertProposalIsDifferent()  ← guard: root cause too similar to existing comment?
    POST /repos/{owner}/{repo}/issues/{n}/comments
    CREATE ProposalRecord
}))
```

---

## 4. Database Schema

### Config (always exactly one row, id = "singleton")

```
id                   "singleton"
notificationEmail    email to send to
watchedRepo          "owner/repo"
watchedLabel         "Help Wanted"
issueLimit           4  (max new issues per day)
githubToken          optional PAT
lastEtag             saved ETag from last Events API response
pollIntervalSeconds  60 (updated from X-Poll-Interval header)
dailySelectedCount   0..N (how many new issues selected today)
dailyResetDate       "YYYY-MM-DD" (when count was last reset)
isRunning            true/false (master switch)
notifyStartTime      "HH:MM" or "" (notify window start)
notifyEndTime        "HH:MM" or "" (notify window end)
notifyTimezone       IANA timezone (default: "UTC")
myGithubUsername     your GitHub username (for 3-email cap + auto-proposal attribution)
autoProposal         true/false (auto-generate proposals on new issue detection)
updatedAt
```

### NotificationRecord (one per selected GitHub issue)

```
id                   cuid
githubIssueNumber    unique — prevents duplicate selection
title                issue title (synced on edits)
body                 issue body (synced on edits)
commentCount         GitHub comment count, used by REST sync to detect new comments
githubUpdatedAt      GitHub's issue.updated_at, used by REST sync to detect any change
url                  GitHub issue URL
repoFullName         "owner/repo"
matchedLabel         label that triggered selection
status               PENDING | SENT | FAILED
attempts             count of email send attempts
lastAttemptAt        last attempt timestamp
notifiedAt           when initial email was successfully sent
hasPendingUpdate     true when an update email is queued
updateEmailCount     total update emails sent (used by 3-email cap)
lastUpdateEmailAt    when last update email was sent
labelDetectedAt      when the issue was first detected (used to measure label→email lag)
deletedAt            soft delete timestamp (null = active)
createdAt / updatedAt
```

### ProposalRecord (one per contributor per issue)

```
id                   cuid
githubIssueNumber    GitHub issue number
repoFullName         "owner/repo"
contributorUsername  GitHub username the proposal is attributed to
rootCause            LLM-generated root cause (text hypothesis, not source-verified)
proposedChange       LLM-generated proposed fix (plain English, no code diffs)
alternatives         LLM-generated alternatives (optional)
commentBody          full formatted comment body as posted to GitHub
commentUrl           URL of the posted GitHub comment
commentId            GitHub comment ID
createdAt

@@unique([githubIssueNumber, repoFullName, contributorUsername])
```

---

## 5. Key Design Decisions

### Fast Poller for sub-10s email latency
The Events API has a dynamic poll interval (minimum 60s enforced by `X-Poll-Interval`). A separate 5s REST Issues API poller was added to achieve ~8–12s label-to-email latency. The Fast Poller queries the Issues API directly (not the Events API, which has the 60s floor) to detect new issues within the 5s window. Both pollers enforce the same 7-day `isRecentlyCreated` guard.

### Parallel email + proposal
Both `NotificationSenderService.send()` and `AutoProposalService.run()` are fired after every detection cycle using `Promise.catch()` without `await` — neither blocks the scheduler or each other. The proposal (~20s) does not delay the email (~10s). Each service has its own `isRunning` static flag to prevent overlapping concurrent invocations.

### In-memory issue data cache
The Fast Poller populates an in-memory `Map<issueNumber, {title, body, cachedAt}>` during detection. `AutoProposalService` reads from this cache first, saving one `GET /repos/.../issues/{n}` call per issue (~400–1200ms). Cache TTL is 2 minutes; entries are evicted on read.

### 3-email cap when no proposal posted
If `myGithubUsername` is set and no `ProposalRecord` exists for that user on an issue, emails are capped at 3 total (1 initial + 2 updates). The cap lifts automatically once any proposal is posted (either by `autoProposal` or manually via `POST /api/proposals`). This prevents inbox spam while the auto-proposer is still running.

### No Redis / BullMQ
The `NotificationRecord` table serves as the job queue. `status=PENDING` = queued. The send is triggered reactively after every poller cycle — not on its own fixed timer.

**Benefits:** No infrastructure dependency, queue state visible in Prisma Studio, retries are automatic (failed send = stays PENDING until next cycle).

### Proposals: cheap guards first, LLM call last
`AutoProposalService` runs both cheap guards before calling the LLM:
1. Batch DB check (no ProposalRecord for this user+issue)
2. `assertNoExistingProposal` (no matching comment already on GitHub)

Only after both pass does it call `generateProposal()` (the expensive LLM call). The third guard (`assertProposalIsDifferent`) runs after generation since it depends on the generated root cause text. This ensures failed proposals never waste a generation.

The LLM only sees the issue title/body/comments — it has no access to repository source code — so the generated root cause is explicitly framed as a text-based hypothesis.

### ETag-based polling (not timestamp-based)
The Events API is polled with `If-None-Match: {lastEtag}`. GitHub returns 304 if nothing changed, which does not count against rate limits and avoids re-processing the same events. The `X-Poll-Interval` header is respected and saved to the DB.

### DB-backed Config (not env vars)
All runtime settings live in the `Config` table, editable via `PUT /api/config` without a server restart. Only SMTP credentials, `DATABASE_URL`, and `ANTHROPIC_API_KEY` are in env vars (they require a restart to change).

### isRunning flag
`Config.isRunning` is the master switch. Both schedulers check it on every cycle. `POST /api/config/start|stop` toggle it in the DB.

### 7-day recently-created filter
Both pollers only select issues created within the last 7 days. This prevents stale events (an old issue re-labeled) from consuming the daily issue limit and ensures the proposal content is relevant.

---

## 6. API Endpoints

### Config
| Method | Path | Description |
|---|---|---|
| GET | /api/config | View settings (githubToken hidden) |
| PUT | /api/config | Update settings |
| GET | /api/config/status | isRunning, daily counts, notify window state |
| POST | /api/config/start | Start monitoring (requires notificationEmail) |
| POST | /api/config/stop | Stop monitoring |

### Notifications
| Method | Path | Description |
|---|---|---|
| GET | /api/notifications | List records (paginated, filterable by status) |
| GET | /api/notifications/:id | Single record |
| POST | /api/notifications/track | Manually track an issue by number |
| POST | /api/notifications/:id/trigger-update | Manually flag hasPendingUpdate=true |
| DELETE | /api/notifications/:id | Soft delete |
| DELETE | /api/notifications/:id/hard | Hard delete |
| POST | /api/notifications/:id/restore | Restore soft-deleted |

### Proposals
| Method | Path | Description |
|---|---|---|
| POST | /api/proposals | Generate (LLM) and immediately post a proposal. No age restriction. Requires ANTHROPIC_API_KEY. |
| GET | /api/proposals | List records (paginated, filterable) |
| GET | /api/proposals/:id | Single record |

### Health
| Method | Path | Description |
|---|---|---|
| GET | /health | Uptime |
| GET | /health/ready | DB connectivity |

---

## 7. Security

- **Helmet.js** — HTTP security headers on all responses
- **CORS** — restricted to configured origin
- **Rate limiting** — 200 req per 15 min on all `/api` routes
- **Zod validation** — all request bodies validated before DB access
- **githubToken never exposed** — stripped from all GET /api/config responses
- **No SQL injection** — all DB access via Prisma parameterised queries
- **No auth tokens to steal** — single-user tool with no login, designed for local/private use

---

## 8. Production Deployment

```
Internet ──HTTPS──► Fly.io Machine (shared-cpu-1x, 256MB RAM)
                         │
                    Express API + Schedulers
                         │
                    /data/prod.db (SQLite)
                         │
                    Fly.io Persistent Volume (1GB)
```

**Cost: ~$2.10/month** (machine + volume)

See [DEPLOYMENT.md](DEPLOYMENT.md) for step-by-step instructions.

---

## 9. Technology Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 22 | What CI/Docker actually pin |
| Language | TypeScript | Type safety, Prisma type generation |
| API framework | Express.js v5 | Minimal, well-understood, stable |
| ORM | Prisma | Type-safe queries, schema-first, SQLite support |
| Database | SQLite | Zero infrastructure, persistent volumes on Fly.io |
| Job queue | DB-backed (NotificationRecord) | No Redis needed, simpler, visible in Prisma Studio |
| Detection strategy | 5s Fast Poller (REST) + ~60s Events Poller (ETag) | Fast Poller for latency; Events Poller for updates and rate-efficient polling |
| Email | Nodemailer (pooled SMTP, `pool: true, maxConnections: 1`) | Persistent connection saves ~1–2s per email |
| LLM (proposals) | Anthropic SDK `claude-opus-4-8` | Best reasoning quality for root cause analysis; async so latency (~20s) doesn't block email |
| Validation | Zod | Runtime + compile-time type safety |
| Logging | Pino | Fast structured JSON logs |
| Testing | Vitest + Supertest | Fast, Jest-compatible, good ESM support |
| Deployment | Fly.io + Docker | Simple, persistent volumes, ~$2/month |
| CI/CD | GitHub Actions | Free, integrated with repo |
