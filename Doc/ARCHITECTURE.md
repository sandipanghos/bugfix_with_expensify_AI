# Architecture — GitHub Issue Notifier & Auto-Proposer

## 1. System Overview

Monitors any GitHub repository for new issues matching a configured label and sends email notifications immediately. Also sends update emails when a watched issue changes, and can generate + post a contributor proposal comment to a tracked issue via an LLM (`POST /api/proposals`).

**Single user. No auth. No Redis. No job queues. SQLite + SMTP (+ optional Anthropic API for proposals) only.**

> A `frontend/` Next.js scaffold exists in this repo (npm workspace member) but is **disconnected** from this backend — it calls `/api/auth/login`, which does not exist here. It has no CI job and is not part of the deployed system. This document describes the backend only.

---

## 2. High-Level Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                    Express.js API Server                      │
│                                                                 │
│  ┌───────────────────────────────────────────────────────┐   │
│  │                      API Layer                        │   │
│  │  GET/PUT /api/config      POST /api/config/start|stop │   │
│  │  GET /api/notifications   DELETE /api/notifications   │   │
│  │  POST /api/notifications/:id/trigger-update           │   │
│  │  POST/GET /api/proposals  GET /api/proposals/:id       │   │
│  │  GET /health               GET /health/ready          │   │
│  └────────────────────┬──────────────────────────────────┘   │
│                       │                                       │
│  ┌────────────────────▼──────────────────────────────────┐   │
│  │                   Service Layer                        │   │
│  │                                                         │   │
│  │  ┌────────────────────────────────────────────────┐   │   │
│  │  │  EventsPollerService (runs on setTimeout, the   │   │   │
│  │  │  only independently-timed loop)                 │   │   │
│  │  │  → also runs direct REST sync inline, every      │   │   │
│  │  │    cycle, then calls NotificationSenderService   │   │   │
│  │  │    reactively (no separate 20s timer)            │   │   │
│  │  └──────────────────────┬─────────────────────────┘   │   │
│  │                         │                               │   │
│  │  ┌──────────────────────▼─────────────┐                │   │
│  │  │  NotificationSenderService          │                │   │
│  │  │  (called inline after each poll;    │                │   │
│  │  │   isSending lock prevents overlap)  │                │   │
│  │  └──────────────────────────────────────┘                │   │
│  │                                                         │   │
│  │  ┌────────────────────┐  ┌─────────────────────────┐   │   │
│  │  │ ProposalGenerator   │  │ ProposalGuardsService    │   │   │
│  │  │ Service (LLM call,  │  │ (3 guards: dup, similar, │   │   │
│  │  │ called from route)  │  │ assigned-work-pending)   │   │   │
│  │  └────────────────────┘  └─────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                       │                                       │
│  ┌────────────────────▼──────────────────────────────────┐   │
│  │              SQLite Database (Prisma ORM)              │   │
│  │   Config (singleton) | NotificationRecord | ProposalRecord │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────┬────────────────────────────────────────────┘
                     │
      ┌──────────────┼──────────────────┐
      │              │                  │
┌─────▼──────┐ ┌─────▼──────┐    ┌──────▼──────┐
│ GitHub API │ │ Anthropic  │    │ Gmail SMTP  │
│ Events +   │ │ API (LLM,  │    │ (Nodemailer)│
│ REST API   │ │ proposals  │    └─────────────┘
│ + Octokit  │ │ only)      │
└────────────┘ └────────────┘
```

> `backend/src/services/issue-syncer.service.ts` defines a standalone `IssueSyncerService` with REST-sync logic equivalent to what the poller now runs inline. It is **dead code** — not imported or called anywhere. See [Section 3](#3-one-scheduler-reactive-email-send).

---

## 3. One Scheduler, Reactive Email Send

CLAUDE.md documents this in more detail; this section summarizes the same reality. Only `EventsPollerService` runs on its own timer. Email sending and the direct REST sync both happen **inline, reactively, inside that same cycle** — there is no independent 20s or 1-minute timer anywhere in the running code.

```
startup (after 2s delay)
    │
    ▼
EventsPollerService.poll()
    │
    ├─ read Config from DB
    ├─ if !isRunning → return immediately
    ├─ daily reset check (dailySelectedCount → 0 at midnight)
    ├─ GET /repos/{owner}/{repo}/events?per_page=20
    │   Header: If-None-Match: {lastEtag}
    │
    ├─ 200 OK → save new ETag + X-Poll-Interval to DB, then process events:
    │   ├─ for each IssuesEvent:
    │   │   ├─ skip new-selection if issue.created_at > 7 days ago
    │   │   ├─ action=opened|labeled + has watched label + not in DB + under limit
    │   │   │   → CREATE NotificationRecord (PENDING) + increment dailySelectedCount
    │   │   └─ any action, already-tracked issue (PENDING or SENT)
    │   │       → SET hasPendingUpdate=true; action=edited also syncs title/body
    │   └─ for each IssueCommentEvent on an already-tracked issue
    │       → SET hasPendingUpdate=true
    │   (isWithinNotifyWindow() gates new-record creation only — syncs/updates always happen)
    │
    ├─ 304 Not Modified → save interval, skip event processing
    ├─ 403 rate limited → back off to 120s, skip REST sync this cycle
    │
    ├─ Direct REST sync (runs every cycle, 200/304/error alike — skipped only on 403):
    │   for each tracked PENDING/SENT record:
    │   GET /repos/{owner}/{repo}/issues/{n}
    │     → titleChanged / bodyChanged / commentCountChanged / githubUpdatedAt changed
    │       → SET hasPendingUpdate=true, sync changed fields
    │   (catches activity the Events API missed or that arrived during a 304 cycle)
    │
    ├─ NotificationSenderService.send()   ← called inline, right here, every cycle
    │   ├─ isSending lock? → skip (prevents overlap)
    │   ├─ isWithinNotifyWindow()? NO → skip (emails held in DB until window opens)
    │   ├─ PASS 1: all PENDING records (deletedAt=null)
    │   │   ├─ sendMail() success → status=SENT, notifiedAt=now, attempts++
    │   │   └─ sendMail() fail   → attempts++, lastAttemptAt=now (stays PENDING → retried next cycle)
    │   └─ PASS 2: all SENT records where hasPendingUpdate=true (deletedAt=null)
    │       ├─ sendMail() success → hasPendingUpdate=false, updateEmailCount++
    │       └─ sendMail() fail   → log error (stays true → retried next cycle)
    │
    └─ return pollIntervalSeconds (from X-Poll-Interval, or 120 on 403)
           │
           ▼
    setTimeout(poll, pollIntervalSeconds * 1000)   ← reschedules itself
```

`POST /api/notifications/:id/trigger-update` sets `hasPendingUpdate=true` on demand from the API layer; the actual send still waits for the next poller cycle, same as any other update.

`backend/src/jobs/schedulers.ts` only calls `startEventsPoller()`. There is no `setInterval(20_000, ...)` or `setInterval(60_000, ...)` anywhere in the codebase. The standalone `IssueSyncerService` class (`backend/src/services/issue-syncer.service.ts`) is unused dead code; it duplicates the REST-sync logic shown above but is never imported.

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
```

### NotificationRecord (one per selected GitHub issue)

```
id                   cuid
githubIssueNumber    unique — prevents duplicate selection
title                issue title (kept current; synced on edited events / REST sync)
body                 issue body (synced same as title)
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
updateEmailCount     total update emails sent
lastUpdateEmailAt    when last update email was sent
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
alternatives         LLM-generated alternatives considered (optional content)
commentBody          full formatted comment body as posted to GitHub
commentUrl           URL of the posted GitHub comment
commentId            GitHub comment ID
createdAt / updatedAt

@@unique([githubIssueNumber, repoFullName, contributorUsername])
```

---

## 5. Key Design Decisions

### No Redis / BullMQ
The `NotificationRecord` table serves as the job queue. `status=PENDING` = queued. The send is triggered reactively, once, immediately after every poller cycle — not on its own fixed timer.

**Benefits:** No infrastructure dependency, queue state visible in Prisma Studio, retries are automatic (failed = stays PENDING).

### One scheduler, not multiple
Only `EventsPollerService` runs on its own timer (dynamic interval, starts at 60s). Email sending and the direct REST issue sync both run inline inside that same cycle, reactively — see [Section 3](#3-one-scheduler-reactive-email-send). This is a deliberate documentation choice: an earlier design called for three independent schedulers (poller / 20s email sender / 1min issue syncer), but the code that shipped consolidated all three into one loop. These docs describe the code as it actually runs.

### Proposals: cheap guards first, LLM hypothesis is explicit
`POST /api/proposals` runs its two cheap guards (no duplicate proposal, no pending assigned work) before calling the LLM, so a disqualified request never wastes a generation. The third guard (similarity to existing proposals) runs after generation since it depends on the generated text. The LLM only sees the issue title/body/comments — it has no access to the actual repository source — so the generated root cause is explicitly framed as a text-based hypothesis. There is no draft/approve step: a passing request posts the comment to GitHub immediately.

### ETag-based polling (not timestamp-based)
Previous design used `since: lastPolledAt` which used GitHub's `updated_at` field. Issues that weren't recently updated would disappear from results permanently.

ETag approach: GitHub tells us exactly when the response changes. We never miss events.

### DB-backed Config (not env vars)
All runtime settings (email, repo, label, limit) live in the Config table, editable via API without a server restart. Only SMTP credentials and DATABASE_URL are in env vars.

### isRunning flag
The `Config.isRunning` boolean is the master switch. Both schedulers check it on every cycle. `POST /api/config/start` and `stop` toggle it in the DB.

### Daily issue limit (not daily email limit)
`dailySelectedCount` tracks distinct issues *selected*, not emails sent. Once an issue is selected, all its future update emails are unlimited. The limit prevents being flooded with new issues on busy days.

### Recently-created filter (7 days)
Only issues created within the last 7 days are selected. This prevents stale events (an old issue getting a new comment) from consuming your daily limit.

---

## 6. API Endpoints

### Config
| Method | Path | Description |
|---|---|---|
| GET | /api/config | View settings (githubToken hidden) |
| PUT | /api/config | Update settings |
| GET | /api/config/status | isRunning, daily counts, poll interval |
| POST | /api/config/start | Start monitoring (requires notificationEmail) |
| POST | /api/config/stop | Stop monitoring |

### Notifications
| Method | Path | Description |
|---|---|---|
| GET | /api/notifications | List records (paginated, filterable by status) |
| GET | /api/notifications/:id | Single record |
| POST | /api/notifications/track | Manually track an issue by number |
| POST | /api/notifications/:id/trigger-update | Manually flag hasPendingUpdate=true (sent next poller cycle) |
| DELETE | /api/notifications/:id | Soft delete (sets deletedAt) |
| DELETE | /api/notifications/:id/hard | Hard delete (permanent) |
| POST | /api/notifications/:id/restore | Restore soft-deleted |

### Proposals
| Method | Path | Description |
|---|---|---|
| POST | /api/proposals | Generate (LLM) and immediately post a contributor proposal comment |
| GET | /api/proposals | List records (paginated, filterable by contributor/issue) |
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
| Runtime | Node.js 22 | what CI/Docker actually pin; `package.json`'s `engines.node` field says `>=24.0.0` — an unreconciled inconsistency, not enforced |
| Language | TypeScript | Type safety, Prisma type generation |
| API framework | Express.js v5 | Minimal, well-understood, stable |
| ORM | Prisma | Type-safe queries, schema-first, SQLite support |
| Database | SQLite | Zero infrastructure, persistent volumes on Fly.io |
| Job queue | DB-backed (NotificationRecord) | No Redis needed, simpler, visible |
| Polling strategy | Events API + ETag | Efficient, no missed events, respects rate limits |
| Email | Nodemailer | Industry standard, works with any SMTP |
| LLM (proposals) | Anthropic SDK (`@anthropic-ai/sdk`) | Used only by `POST /api/proposals`; optional at startup |
| Validation | Zod | Runtime + compile-time type safety |
| Logging | Pino | Fast structured JSON logs |
| Testing | Vitest + Supertest, plain `vi.mock()` for Octokit/Prisma | Fast, Jest-compatible, good ESM support; no MSW/nock in this codebase |
| Deployment | Fly.io + Docker | Simple, persistent volumes, ~$2/month |
| CI/CD | GitHub Actions | Free, integrated with repo |
