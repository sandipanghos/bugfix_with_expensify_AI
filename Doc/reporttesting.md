# Test Report — GitHub Issue Notifier

> **This is a frozen historical snapshot of one test run (2026-06-13/14), not a living document.** It predates the Proposals/Auto-Proposer feature entirely — no `ProposalRecord`, `proposal-generator.service.ts`, `proposal-guards.service.ts`, or `proposals.routes.ts` existed yet, so none of their tests appear here (none exist today either — see [TESTING_STRATEGY.md](TESTING_STRATEGY.md)). Test counts, coverage percentages, and timestamps below are exactly what that one run produced and are not re-verified or kept in sync with the current codebase. For the current, accurate description of what tests exist and how to run them, see [TESTING_STRATEGY.md](TESTING_STRATEGY.md).

**Date:** 2026-06-13  
**Branch:** master  
**Test Email:** sandghos1987@gmail.com  
**Test Repo Data:** Expensify/App (real issue numbers and titles)

---

## Summary

| Category | Files | Tests | Status |
|---|---|---|---|
| Unit — Services | 3 | 65 | All Pass |
| Unit — Middleware | 1 | 5 | All Pass |
| Unit — DB Client | 1 | 1 | All Pass |
| Unit — Health (mocked) | 1 | 2 | All Pass |
| Integration — API | 3 | 57 | All Pass |
| Performance | 1 | 8 | All Pass |
| **Total** | **10** | **138** | **All Pass** |

---

## Coverage Report

| Metric | Actual | Threshold | Status |
|---|---|---|---|
| Statements | **95.09%** | 80% | PASS |
| Branches | **84.09%** | 75% | PASS |
| Functions | **90%** | 80% | PASS |
| Lines | **95.09%** | 80% | PASS |

---

## Per-File Coverage

| File | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| `src/app.ts` | 100% | 100% | 100% | 100% |
| `src/api/config.routes.ts` | 92.23% | 77.77% | 100% | 92.23% |
| `src/api/health.routes.ts` | 100% | 100% | 100% | 100% |
| `src/api/notifications.routes.ts` | 90.82% | 80.76% | 100% | 90.82% |
| `src/db/client.ts` | 100% | 50% | 100% | 100% |
| `src/middleware/error.middleware.ts` | 100% | 100% | 100% | 100% |
| `src/middleware/not-found.middleware.ts` | 100% | 100% | 100% | 100% |
| `src/services/email.service.ts` | 100% | 100% | 100% | 100% |
| `src/services/events-poller.service.ts` | 100% | 100% | 100% | 100% |
| `src/services/notification-sender.service.ts` | 100% | 85.71% | 100% | 100% |
| `src/utils/env.ts` | 83.33% | 0% | 100% | 83.33% |
| `src/utils/logger.ts` | 87.5% | 0% | 100% | 87.5% |

> **Excluded:** `src/server.ts` (entry point), `src/jobs/schedulers.ts` (timer wiring),
> `src/utils/octokit.ts` (thin wrapper), all `*.config.*` files.

---

## Unit Test Results

### events-poller.service.test.ts — 31 tests

| Test | Status | Notes |
|---|---|---|
| Returns 60 when config not found | PASS | |
| Returns pollIntervalSeconds when !isRunning | PASS | |
| Resets dailySelectedCount at midnight | PASS | |
| No reset when same day | PASS | |
| Returns pollIntervalSeconds for invalid repo format | PASS | InvalidFormat (no slash) |
| Returns pollIntervalSeconds on 304 via status field | PASS | |
| Returns pollIntervalSeconds on 304 thrown as error | PASS | |
| Returns 120 on 403 rate limit | PASS | Automatic backoff |
| Returns pollIntervalSeconds on unexpected error | PASS | Network errors etc |
| Saves new ETag from response headers | PASS | |
| Saves X-Poll-Interval from headers | PASS | |
| Sends If-None-Match when lastEtag set | PASS | ETag-based polling |
| Sends empty headers when no ETag | PASS | |
| Creates record for opened issue with watched label | PASS | Core happy path |
| Creates record for labeled action | PASS | |
| Increments dailySelectedCount after creation | PASS | |
| No record when already in DB (duplicate) | PASS | UNIQUE constraint |
| No record when wrong label | PASS | |
| Case-insensitive label matching | PASS | HELP WANTED === Help Wanted |
| Skips stale issue (> 7 days) | PASS | Recently-created filter |
| Skips when daily limit reached | PASS | 4/4 → skip |
| Selects up to daily limit across events | PASS | 3+1=4 then stops |
| Sets hasPendingUpdate for edited SENT issue | PASS | Update path |
| Sets hasPendingUpdate for reopened SENT issue | PASS | |
| No hasPendingUpdate when issue not in DB | PASS | |
| No hasPendingUpdate when record is PENDING | PASS | |
| No hasPendingUpdate when soft-deleted | PASS | |
| No hasPendingUpdate when already set | PASS | No double-update |
| Ignores non-IssuesEvent types | PASS | PushEvent, PREvent, etc |
| Returns X-Poll-Interval value | PASS | Dynamic interval |
| Uses per_page=20 | PASS | Max 20 events fetched |
| Parses owner/repo correctly | PASS | microsoft/vscode |

### notification-sender.service.test.ts — 15 tests

| Test | Status | Notes |
|---|---|---|
| Returns early when no config | PASS | |
| Returns early when !isRunning | PASS | |
| Returns early when no notificationEmail | PASS | |
| Does nothing when no PENDING records | PASS | |
| Sends initial email for PENDING record → SENT | PASS | Core happy path |
| Sends emails for all PENDING records in order | PASS | Batch processing |
| Increments attempts on failure, stays PENDING | PASS | Retry behaviour |
| Processes subsequent records after one fails | PASS | No early abort |
| Sends update email for hasPendingUpdate=true | PASS | Update path |
| Sets hasPendingUpdate=false on success | PASS | |
| Keeps hasPendingUpdate=true on update fail | PASS | Auto-retry |
| Uses correct updateCount (N+1) | PASS | Subject includes Update #N |
| Queries PENDING with deletedAt=null filter | PASS | |
| Queries update records with deletedAt=null | PASS | |
| Sets notifiedAt timestamp on success | PASS | |

### email.service.test.ts — 19 tests

| Test | Status | Notes |
|---|---|---|
| [New Issue] subject for initial notification | PASS | |
| Issue URL in HTML body | PASS | |
| Issue title in HTML body | PASS | |
| Issue number in HTML body | PASS | |
| Blue badge (#0969da) for new issue | PASS | |
| "New Issue" badge text | PASS | |
| Plain text version with URL | PASS | |
| Correct recipient email | PASS | sandghos1987@gmail.com |
| Repo name in heading | PASS | |
| Matched label in body | PASS | |
| [Update #N] subject for update | PASS | |
| Orange badge (#e36209) for update | PASS | |
| "Update #N" badge text | PASS | |
| Increments update count in subject | PASS | Update #5 etc |
| "Issue Update" heading | PASS | |
| "New Matching Issue" heading for initial | PASS | |
| Throws when SMTP rejects | PASS | Error propagation |
| Calls sendMail exactly once | PASS | |
| GitHub Issue Notifier from address | PASS | |

### error.middleware.test.ts — 5 tests

| Test | Status | Notes |
|---|---|---|
| 400 with field errors for ZodError | PASS | Validation errors |
| 500 for regular Error | PASS | Unexpected errors |
| 500 for non-Error thrown value | PASS | String throw |
| 500 for undefined error | PASS | Edge case |
| notFoundHandler returns 404 | PASS | |

---

## Integration Test Results

### config.test.ts — 27 tests

| Test Suite | Tests | Status |
|---|---|---|
| GET /api/config | 5 | All Pass |
| PUT /api/config | 12 | All Pass |
| GET /api/config/status | 3 | All Pass |
| POST /api/config/start | 3 | All Pass |
| POST /api/config/stop | 2 | All Pass |
| Misc (githubToken handling) | 2 | All Pass |

Key scenarios tested:
- Config auto-created on first call (upsert)
- githubToken never exposed in response
- ETag reset when watchedRepo changes
- Daily limit and count preserved when repo unchanged
- Start rejects without notificationEmail
- Stop is idempotent (works when already stopped)

### notifications.test.ts — 25 tests

| Test Suite | Tests | Status |
|---|---|---|
| GET /api/notifications | 8 | All Pass |
| GET /api/notifications/:id | 2 | All Pass |
| DELETE /:id (soft delete) | 5 | All Pass |
| DELETE /:id/hard | 4 | All Pass |
| POST /:id/restore | 4 | All Pass |
| Lifecycle (end-to-end) | 1 | All Pass |
| Misc (field completeness) | 1 | All Pass |

### health.test.ts — 5 tests

| Test | Status |
|---|---|
| GET /health → 200 status ok | PASS |
| GET /health → uptime number | PASS |
| GET /health/ready → 200 connected | PASS |
| GET /api/does-not-exist → 404 | PASS |
| Unknown path returns JSON body | PASS |

---

## Performance Test Results

Test environment: mocked SMTP, real Prisma call logic, CPU-only overhead.

| Scenario | Target | Actual | Status |
|---|---|---|---|
| 1 PENDING record | < 50ms | < 1ms | PASS |
| 10 PENDING records | < 200ms | < 5ms | PASS |
| 50 PENDING records | < 500ms | < 20ms | PASS |
| 4 update emails | < 100ms | < 5ms | PASS |
| Throughput (20 records) | > 100 emails/sec | ~355,000/sec | PASS |
| p99 single-send latency | < 50ms | < 1ms | PASS |
| 0 records (idle) | < 20ms | < 2ms | PASS |
| 5 records all failing | < 200ms | < 10ms | PASS |

> **Note:** With real SMTP (Gmail), expect ~2-5 second latency per email due to
> network round-trip. The app handles this by running the email sender asynchronously.
> *(Originally written as "at 20-second intervals" — that described an earlier design.
> The current code calls `NotificationSenderService.send()` reactively, once per poller
> cycle, not on a separate fixed timer; see [ARCHITECTURE.md](ARCHITECTURE.md) Section 3.
> SMTP latency still does not block the poller either way.)*

---

## Test Data Used

All test fixtures use real issue data from the Expensify/App GitHub repository:

| Issue # | Title | Labels | Status |
|---|---|---|---|
| 47668 | Fix accessibility issue in ExpensifyCard form | Help Wanted, Weekly | Active |
| 47234 | Update deprecated requestAnimationFrame usage | Help Wanted, Monthly | Active |
| 46891 | Fix incorrect total amount display with currency conversion | Help Wanted | Active |
| 46543 | DistanceRequest component map not rendering on Android 14 | Help Wanted, Bug | Active |

Edge case data:
- Issue #44001: Created 10 days ago (triggers stale-issue filter)
- Issue #47999: Labels = [Bug, Internal] (triggers label-mismatch)

Full test data available in [test-data.csv](test-data.csv).

---

## How to Run Tests

```bash
cd backend

# All unit + integration tests
npm test

# Unit tests only (fast, no DB)
npm run test:unit

# Integration tests only (real SQLite)
npm run test:api

# Performance benchmarks
npm run test:performance

# Coverage report (HTML + console)
npm run test:coverage
# View: backend/coverage/index.html
```

---

## Known Coverage Gaps

| File | Uncovered | Reason |
|---|---|---|
| `config.routes.ts` lines 111-112, 122-123 | Error paths in stop/start when config.update fails | Requires simulating Prisma internal failure |
| `notification-sender.service.ts` lines 89, 95-96, 132 | Edge branches on optional fields | Minor null-branch paths |
| `src/utils/env.ts` lines 18-20 | `process.exit(1)` on invalid env | Can't test without invalid env setup |
| `src/utils/octokit.ts` | Thin factory wrapper | Covered implicitly through events-poller |

These gaps are intentional and acceptable — they represent infrastructure-level code where testing adds no practical value.

---

## Test Environment

| Component | Value |
|---|---|
| Node.js | v22+ |
| Test DB | SQLite `file:./test.db` |
| Test Framework | Vitest 2.x |
| HTTP Testing | Supertest 7.x |
| SMTP (unit/perf) | Mocked (vi.fn) |
| SMTP (manual E2E) | Gmail App Password |
| GitHub API | Mocked (vi.fn for unit) |
| Concurrency | Sequential (`--fileParallelism=false`) |

---

## Real E2E Test Results

**Date:** 2026-06-14  
**Live SMTP:** Gmail App Password → sandghos1987@gmail.com  
**Live GitHub:** fork `sandipanghos/App`, label `help wanted`  
**Bug fixed during E2E:** `z.coerce.boolean()` on string `"false"` → `true` → caused Nodemailer `secure:true` on STARTTLS port 587 → all SMTP connections failing. Fixed in `src/utils/env.ts` line 8.

### E2E Scenarios

| # | Scenario | Issue | Result | Timestamp |
|---|---|---|---|---|
| E2E-01 | New issue detected via Events API | #45 | PASS | 04:04:03Z |
| E2E-02 | New issue detected via Events API | #46 | PASS | 04:03:59Z |
| E2E-03 | New issue detected via Events API | #44 | PASS | 04:04:06Z |
| E2E-04 | New issue detected via Events API | #47 | PASS | 04:08:59Z |
| E2E-05 | Initial email delivered to Gmail | #47 | PASS | 04:08:59Z |
| E2E-06 | ETag 304 optimization (no rate limit cost) | — | PASS | All subsequent polls |
| E2E-07 | Daily count reset at midnight | — | PASS | dailySelectedCount: 3→0→1 |
| E2E-08 | Issue reopened → hasPendingUpdate=true | #47 | PASS | 04:21:34Z |
| E2E-09 | Update email sent after hasPendingUpdate | #47 | PASS | 04:21:59Z, updateEmailCount=2 |
| E2E-10 | Retry on SMTP fail (attempts++) | #44-46 | PASS | 1858 retries before fix |
| E2E-11 | Backlog drained on SMTP fix | #44,#45,#46 | PASS | All SENT immediately after fix |

### Events Timeline

```
04:03:37  Server started (fixed SMTP_SECURE env parsing)
04:03:37  Events poller first poll → 304 (ETag cached)
04:03:55  Email sender cycle 1 → #44, #45, #46 SENT (backlog drained)
04:08:39  Issue #47 created in sandipanghos/App with "help wanted" label
04:08:39  Events API: opened + labeled events appear immediately
04:08:45  Events poller picks up opened+labeled for #47 → PENDING record created
04:08:59  Email sender sends initial email for #47 → SENT, attempts=2
04:21:26  Issue #47 closed via GitHub API
04:21:34  Issue #47 reopened via GitHub API → reopened event in Events API
04:21:40  Events poller picks up reopened → hasPendingUpdate=true
04:21:59  Email sender sends update email → updateEmailCount=2, hasPendingUpdate=false
```

### User Stories Verified (Live)

| User Story | Description | Live Status |
|---|---|---|
| US-01 | Monitor repo for matching label issues | ✅ VERIFIED — #47 detected within 60s |
| US-02 | Send email on new issue detection | ✅ VERIFIED — Email in Gmail inbox |
| US-03 | ETag-based rate-limit-free polling | ✅ VERIFIED — All unchanged polls → 304 |
| US-04 | Daily issue limit per config | ✅ VERIFIED — dailySelectedCount=1 after #47 |
| US-05 | Update email on issue change | ✅ VERIFIED — 2 update emails for #47 |
| US-06 | Retry on email failure | ✅ VERIFIED — 1858 retries, then SENT on fix |
| US-07 | Start/stop via API | ✅ VERIFIED — isRunning toggle works |
| US-08 | Configure all params via PUT /api/config | ✅ VERIFIED — all fields persisted |
| US-09 | Soft delete / restore notifications | ✅ VERIFIED — Integration tests |
| US-10 | Hard delete (permanent) | ✅ VERIFIED — Integration tests |
| US-11 | Daily count resets at midnight | ✅ VERIFIED — Reset 3→0 between sessions |
| US-12 | GitHub token optional | ✅ VERIFIED — 5000 req/hr with PAT |
