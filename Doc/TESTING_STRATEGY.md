# Testing Strategy — Expensify Issue Notifier & Auto-Proposer

> This document describes the **backend's** real, existing tests (`backend/tests/`, 14 files). There is no auth layer, no E2E suite, and no frontend test job in this project — the `frontend/` Next.js scaffold has its own `vitest`/`@testing-library/react`/Playwright dependencies installed, but they are not exercised by CI and nothing here describes them as if they run today.

## Testing Philosophy

- **Test behaviour, not implementation** — tests verify what the code does, not how
- **Fast feedback loop** — unit tests mock everything external and run in milliseconds
- **Real DB for integration tests** — API tests run against a real SQLite test database, not a mock
- **Deterministic** — no test ever makes a real network call to GitHub, Anthropic, or SMTP; everything external is mocked with `vi.mock()`

---

## What Actually Exists

```
backend/tests/
  fixtures/github-events.ts                       shared fixtures: DEFAULT_CONFIG, REAL_ISSUES, makeNotificationRecord()
  global-setup.ts                                  vitest globalSetup — runs once before the whole suite
  setup.ts                                          vitest setupFiles — runs before each test file
  helpers/db.ts                                     cleanDatabase(), seedConfig() against the real test SQLite DB
  integration/api/config.test.ts                   GET/PUT /api/config, start/stop, status
  integration/api/health.test.ts                    /health, /health/ready
  integration/api/notifications.test.ts             notifications CRUD + track + trigger-update
  performance/email-performance.test.ts             timing/throughput checks on the email send path
  regression/README.md                              naming convention + template for future regression tests (no test files yet)
  unit/api/health.unit.test.ts                      health route handler in isolation
  unit/db/client.test.ts                            Prisma client singleton behaviour
  unit/middleware/error.middleware.test.ts          Zod validation error formatting, generic 500 handler
  unit/services/email.service.test.ts               Nodemailer wrapper
  unit/services/events-poller.service.test.ts       Events API + ETag + window + daily-limit logic
  unit/services/notification-sender.service.test.ts send()'s early-return guards + both send passes
```

There are no proposal-feature tests yet (`proposal-generator.service.ts`, `proposal-guards.service.ts`, `proposals.routes.ts` are untested), and no test for `issue-syncer.service.ts` (expected — it's dead code, see [ARCHITECTURE.md](ARCHITECTURE.md)).

---

## Test Types

### 1. Unit Tests

**Tool:** Vitest
**Location:** `backend/tests/unit/`
**Mocking:** `vi.mock()` on the module boundary — Prisma client, `@octokit/rest`'s `Octokit` class, the email service, and the logger are all mocked directly. There is no MSW, no nock, and no `vitest-mock-extended` anywhere in `backend/package.json`.

**Real example** (`tests/unit/services/notification-sender.service.test.ts`, abridged):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG, REAL_ISSUES, makeNotificationRecord } from '../../fixtures/github-events.js';

const mockPrisma = vi.hoisted(() => ({
  config: { findUnique: vi.fn() },
  notificationRecord: { findMany: vi.fn(), update: vi.fn() },
}));
vi.mock('../../../src/db/client.js', () => ({ prisma: mockPrisma }));

const mockSendIssueNotification = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../src/services/email.service.js', () => ({
  sendIssueNotification: mockSendIssueNotification,
}));

import { NotificationSenderService } from '../../../src/services/notification-sender.service.js';

describe('NotificationSenderService.send()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.config.findUnique.mockResolvedValue({ ...DEFAULT_CONFIG, isRunning: true, notificationEmail: 'you@example.com' });
    mockPrisma.notificationRecord.findMany.mockResolvedValue([]);
  });

  it('returns early when isRunning is false', async () => {
    mockPrisma.config.findUnique.mockResolvedValue({ ...DEFAULT_CONFIG, isRunning: false });
    await NotificationSenderService.send();
    expect(mockSendIssueNotification).not.toHaveBeenCalled();
  });
});
```

---

### 2. API / Integration Tests

**Tool:** Vitest + Supertest
**Location:** `backend/tests/integration/api/`
**Database:** a real SQLite test database, reset via `cleanDatabase()` (`tests/helpers/db.ts`) in `beforeEach`. Nothing here is mocked at the HTTP level — there's no GitHub or SMTP traffic in these tests at all because the routes under test (`config`, `health`, `notifications`) don't call out to either.

**Real example** (`tests/integration/api/config.test.ts`, abridged):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { cleanDatabase, seedConfig } from '../../helpers/db.js';

const app = createApp();

beforeEach(async () => {
  await cleanDatabase();
});

describe('GET /api/config', () => {
  it('never exposes githubToken in the response', async () => {
    await seedConfig({ githubToken: 'ghp_secret_token_12345' });
    const res = await request(app).get('/api/config');
    expect(res.body.config.githubToken).toBeUndefined();
    expect(res.body.hasGithubToken).toBe(true);
  });
});
```

There is no `Authorization` header anywhere in these tests — the API has no auth layer.

---

### 3. Performance Tests

**Tool:** Vitest
**Location:** `backend/tests/performance/email-performance.test.ts`
**Run via:** `npm run test:performance` (separate script, not part of the default `npm run test`/`test:unit` runs)

Checks timing/throughput characteristics of the email-sending path (e.g. parallel `Promise.all` sends completing within an expected bound), not correctness per se.

---

### 4. Regression Tests

**Location:** `backend/tests/regression/`
**Current state:** only a `README.md` describing the convention exists — no regression test files have been added yet.

**Convention** (from the README):

```
backend/tests/regression/issue-NNN-short-description.test.ts
```

Where `NNN` is the GitHub issue number of the bug being guarded against.

```typescript
import { describe, it, expect } from 'vitest';

describe('Regression: [brief description of original bug]', () => {
  it('[what should happen that previously did not]', async () => {
    // 1. Reproduce the exact conditions that caused the bug
    // 2. Assert the correct behaviour
  });
});
```

---

### 5. Code Quality (Static Analysis)

**ESLint** (flat config — `backend/eslint.config.js`, not `.eslintrc.json`):

```js
// backend/eslint.config.js (real, abridged)
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    rules: {
      'no-console': 'error',                 // use Pino's logger instead
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      'prefer-const': 'error',
    },
  }
);
```

Run via `npm run lint` (`--max-warnings 0` in CI — see [CICD_DEVOPS.md](CICD_DEVOPS.md)).

There is **no Prettier and no Husky/lint-staged** anywhere in this repo — no pre-commit hooks exist. Formatting is whatever ESLint's `prefer-const`/style rules enforce; nothing auto-formats on commit.

---

### 6. Coverage Requirements

Real thresholds, from `backend/vitest.config.ts`:

| Metric | Threshold |
|---|---|
| Statements | 80% |
| Branches | 75% |
| Functions | 80% |
| Lines | 80% |

Coverage provider is `@vitest/coverage-v8` (not a separate `c8` package). `src/server.ts` and `src/jobs/schedulers.ts` are excluded from coverage (entry points / the timer loop itself). Run via `npm run test:coverage`. These thresholds are configured in `vitest.config.ts` but are **not** enforced as a separate CI gate step in `ci.yml` — `ci.yml` runs `typecheck`/`lint`/`build` only, not `test` or `test:coverage` (see [CICD_DEVOPS.md](CICD_DEVOPS.md) for the exact CI step list).

---

## Test Scripts

Real scripts from `backend/package.json`:

```bash
npm run test              # vitest run --fileParallelism=false (all tests, serialized — shared SQLite test DB)
npm run test:unit         # vitest run tests/unit
npm run test:api          # vitest run --fileParallelism=false tests/integration
npm run test:performance  # vitest run tests/performance
npm run test:watch        # vitest (watch mode)
npm run test:coverage     # vitest run --fileParallelism=false --coverage
```

`--fileParallelism=false` is used for the full run and the API run because integration tests share one real SQLite test database — running test files in parallel would race on `cleanDatabase()`.

There is no `test:e2e` script in `backend/package.json`, and no E2E test suite exists anywhere in this repo.

---

## Test Data Strategy

- **Unit tests:** fixtures from `tests/fixtures/github-events.ts` (`DEFAULT_CONFIG`, `REAL_ISSUES`, `makeNotificationRecord()`); everything external is a `vi.mock()`, no real data store involved
- **Integration tests:** a real SQLite test database, cleaned via `cleanDatabase()` before each test; `seedConfig()` seeds a `Config` row when a test needs one
- **Sensitive data:** no real GitHub tokens, SMTP credentials, or Anthropic keys are used in any test — fixtures use placeholder values (e.g. `ghp_secret_token_12345`)

---

## What CI Actually Runs

Per `.github/workflows/ci.yml` (see [CICD_DEVOPS.md](CICD_DEVOPS.md) for the full file): `npm ci` → `npx prisma generate` → `npm run typecheck` → `npm run lint` → `npm run build`. **No test step runs in CI today** — `npm run test`/`test:unit`/`test:api`/`test:coverage` are available locally but none of them are invoked by `ci.yml`. This is a gap worth flagging, not something to silently paper over.

---

## Manual Verification Checklist

A checklist for manually verifying core behavior before a release, scoped to what's actually implemented:

```
□ PUT /api/config accepts valid input, rejects invalid watchedRepo/email/issueLimit
□ POST /api/config/start fails with 400 when notificationEmail is unset
□ GET /api/config never returns githubToken (only hasGithubToken boolean)
□ Poller cycle creates a PENDING NotificationRecord for a new matching-label issue
□ Daily issueLimit blocks new selections once reached (update emails still unlimited)
□ Issues older than 7 days are skipped for new selection
□ Notify window (notifyStartTime/notifyEndTime/notifyTimezone) holds emails until window opens
□ NotificationSenderService sends PENDING records and marks them SENT
□ A failed send leaves the record PENDING for retry on the next poller cycle
□ An edited issue event updates the stored title/body and sets hasPendingUpdate
□ POST /api/notifications/track creates a PENDING record for a manually-specified issue
□ POST /api/notifications/:id/trigger-update sets hasPendingUpdate=true
□ DELETE /api/notifications/:id soft-deletes; POST .../restore un-deletes
□ POST /api/proposals runs guards before calling the LLM; a disqualifying guard prevents generation
□ GET /health and /health/ready return correct status codes when DB is up/down
```
