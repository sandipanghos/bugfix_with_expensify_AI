# Technology Stack — Expensify Issue Notifier & Auto-Proposer

> This document covers the **backend** (the only deployed, working system) and the **`frontend/`** scaffold separately. The frontend is a real npm-workspace member with its own dependencies, but it is **disconnected** — its login page posts to `/api/auth/login`, an endpoint that does not exist in the backend (which has no auth layer at all). It has no CI job and is not deployed anywhere. Treat the Frontend table below as "what's installed in that scaffold," not "what's running in production."

## Backend Stack Summary

Versions below are taken directly from `backend/package.json`.

| Layer         | Technology         | Version     | Purpose                               |
|---------------|--------------------|-------------|----------------------------------------|
| Runtime       | Node.js            | 22 (CI/Docker) — see note below | Server runtime |
| Language      | TypeScript          | ^5.6.0      | Type-safe JavaScript                  |
| API Framework | Express.js          | ^5.0.0      | HTTP server & routing                 |
| ORM           | Prisma              | ^6.0.0      | Database access (`@prisma/client` ^6.0.0) |
| Database      | SQLite              | —           | Only database used, dev and prod alike |
| GitHub Client | @octokit/rest       | ^21.0.0     | GitHub Events/REST API integration    |
| LLM (proposals) | @anthropic-ai/sdk | ^0.32.0     | Generates proposal text for `POST /api/proposals`; optional |
| Email         | Nodemailer          | ^8.0.0      | SMTP email delivery (Gmail in practice) |
| SQLite replication | @flydotio/litestream | ^1.0.1 | Fly.io volume backup/replication for the SQLite file |
| Validation    | Zod                 | ^3.23.0     | Runtime schema validation             |
| Logging       | Pino + pino-pretty   | ^9.0.0 / ^13.0.0 | Structured JSON logs (pretty in dev) |
| Security      | Helmet + cors        | ^8.0.0 / ^2.8.6  | HTTP security headers + CORS      |
| Rate Limiting | express-rate-limit   | ^7.0.0      | 200 req / 15 min on `/api/*`          |

There is **no** Redis, BullMQ, PostgreSQL, JWT/jsonwebtoken, or node-cron anywhere in `backend/package.json` — these appeared in earlier drafts of this document but were never implemented.

## Frontend Stack (disconnected scaffold — see caveat above)

Versions from `frontend/package.json`:

| Layer       | Technology          | Version    | Purpose                              |
|-------------|----------------------|------------|---------------------------------------|
| Framework   | Next.js               | 15.5.19    | React full-stack framework            |
| UI          | (foundational libs only) | class-variance-authority ^0.7.0, clsx ^2.1.0, tailwind-merge ^2.4.0 | These are the libs shadcn/ui is built on, but no `@radix-ui/*` packages or actual shadcn components are installed yet |
| Styling     | Tailwind CSS           | ^4.0.0     | Utility-first CSS                     |
| State       | Zustand                | ^5.0.0     | Lightweight global state              |
| Data fetch  | TanStack Query         | ^5.0.0     | Server state, caching, invalidation   |
| Forms       | React Hook Form + @hookform/resolvers | ^7.52.0 / ^3.6.0 | Form management + Zod resolver |
| Validation  | Zod                    | ^3.23.0    | Shared schema library with backend    |
| Icons       | lucide-react           | ^0.400.0   | Icon library                          |
| React       | React + React DOM      | ^19.0.0    | UI library                            |

## Testing

### Backend (`backend/tests/`)

| Type            | Tool                          | Purpose                              |
|-----------------|--------------------------------|----------------------------------------|
| Unit + integration | Vitest ^2.0.0 + Supertest ^7.0.0 | All current tests — unit and API integration |
| External mocking | Plain `vi.mock()` / `vi.fn()`   | Mocks `@octokit/rest`'s `Octokit` class and the Prisma client directly — **not** MSW or nock (neither package is a dependency anywhere in this repo) |
| Coverage        | @vitest/coverage-v8 ^2.0.0      | Code coverage reporting (not `c8` as a separate package) |
| Code quality    | ESLint ^9.0.0                   | Linting (`npm run lint`, `--max-warnings 0`) |

No proposal-feature tests or `issue-syncer.service.ts` tests exist yet. No Husky or lint-staged anywhere in the repo — there are no pre-commit hooks.

### Frontend (`frontend/`, scaffold only — not exercised by CI)

| Type            | Tool                          | Purpose                              |
|-----------------|--------------------------------|----------------------------------------|
| Unit/component   | Vitest ^2.0.0 + Testing Library (`@testing-library/react` ^16.0.0) | Component tests |
| E2E              | Playwright ^1.45.0              | Browser-level end-to-end tests (would need a working backend auth endpoint to actually pass) |

## DevOps / CI/CD

| Tool              | Purpose                                  |
|-------------------|--------------------------------------------|
| GitHub Actions    | One CI workflow (typecheck/lint/build, backend only) + one deploy workflow — see [CICD_DEVOPS.md](CICD_DEVOPS.md) |
| Docker            | Multi-stage build for the backend, deployed via Fly.io |
| Docker Compose    | Present at repo root and in `backend/`, but defines **no services** — SQLite needs none |
| Fly.io            | Production hosting for the backend (`expensify-backend-dusky-summit-570`, region `bom`) |
| Dependabot        | Tracks `backend/`, `frontend/`, and GitHub Actions dependency updates |

There is **no** Render.com, Vercel, Neon, Upstash, CodeClimate, or SonarCloud anywhere in this repo's configuration.

---

## Why Each Choice (backend)

### TypeScript (not plain JS)
- Catches bugs at compile time (null checks, wrong prop types)
- Prisma generates fully-typed query results
- Zod schemas can be inferred as TypeScript types (single source of truth)

### Express.js v5 (not Fastify/Hono)
- Most familiar, best documentation, largest ecosystem
- v5 stable: native promise/async error handling
- Sufficient for a single-user tool — no need for higher raw throughput

### Prisma (not Drizzle/TypeORM)
- Best-in-class DX: auto-generated types, visual DB browser (`prisma studio`)
- Schema-first: migrations are explicit and reviewable

### SQLite only, no Postgres
- Zero infrastructure: no separate DB server to provision, back up, or pay for
- A Fly.io persistent volume is sufficient for a single-user tool's data volume
- `@flydotio/litestream` handles continuous replication of the SQLite file so a volume loss isn't a total data loss

### DB-backed queue, no Redis/BullMQ
- `NotificationRecord.status` IS the queue. No separate infrastructure, queue state is just rows visible in Prisma Studio, retries are automatic (failed sends just stay `PENDING`)

### Vitest (not Jest)
- Faster than Jest for ESM projects
- Jest-compatible API
- Native TypeScript support without Babel

### Fly.io (not Render/Railway)
- Persistent volumes work well with SQLite
- ~$2.10/month all-in for an always-on machine + volume — no free-tier sleep behavior that would kill the 24/7 poller

---

## Package Manager

**npm**, using npm workspaces (`"workspaces": ["backend", "frontend"]` declared in the repo-root `package.json`). The lockfile lives only at the repo root — there is no `backend/package-lock.json` or `frontend/package-lock.json`. See [CICD_DEVOPS.md](CICD_DEVOPS.md) for a suspected (unconfirmed) issue this causes for `ci.yml`'s `npm ci` step.

---

## Node.js Version

There is an unreconciled inconsistency in the current source:
- `backend/package.json` and `frontend/package.json` both declare `engines.node: ">=24.0.0"`
- `.github/workflows/ci.yml` and `backend/Dockerfile` both actually pin Node **22**

Neither `package.json` sets `engine-strict`, so this mismatch is not currently enforced — Node 22 is what CI and the production Docker image actually run.

---

## Environment Requirements

| Environment | Database                 | Email                                   |
|-------------|---------------------------|-------------------------------------------|
| Development | SQLite (`file:./dev.db`)  | Real Gmail SMTP via `.env` credentials      |
| Test        | SQLite (`tests/helpers/db.ts`) | Mocked via `vi.mock()` — no real or fake SMTP server involved |
| Production  | SQLite on a Fly.io persistent volume (`/data/prod.db`) | Real Gmail SMTP via Fly secrets |

There is no Redis or PostgreSQL row in this table because neither is used in any environment.
