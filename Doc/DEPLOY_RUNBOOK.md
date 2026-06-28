# Deploy & CI Runbook — Backend (Fly.io)

Operational runbook for shipping the backend to production. For first-time
provisioning (account, volume, secrets) see [DEPLOYMENT.md](DEPLOYMENT.md); this
doc is for **day-to-day deploys, verification, and incident recovery**.

- **App:** `expensify-backend-dusky-summit-570` (Fly.io, region `bom`)
- **URL:** https://expensify-backend-dusky-summit-570.fly.dev
- **Source of truth for the app name:** [`backend/fly.toml`](../backend/fly.toml) (`app = …`).
  Note `backend/package.json`'s `name` field is unrelated to the deploy target.

---

## How a deploy happens

Pushing to `master` is the deploy trigger. There is **one** workflow,
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), with two jobs:

```
push to master (paths: backend/**, ci.yml, .npmrc, package-lock.json)
        │
        ▼
  job: ci  ── npm ci → prisma generate → typecheck → lint → build
        │  (must pass)
        ▼
  job: deploy  ── flyctl deploy --remote-only --wait-timeout 120s
        │         (only on push/dispatch to master; never on PRs)
        ▼
  Fly builds the Docker image remotely, releases a new version,
  the machine runs `prisma db push` on startup, then serves.
        │
        ▼
  Health check: curl -f $PROD_API_URL/health
```

The schema is applied at container start via `prisma db push --skip-generate`
(see [`backend/Dockerfile`](../backend/Dockerfile) `CMD`) — additive columns with
defaults are applied automatically on every boot.

### Required GitHub Actions secrets
Repo → Settings → Secrets and variables → Actions:

| Secret | Used for | How to (re)create |
|---|---|---|
| `FLY_API_TOKEN` | authenticates `flyctl deploy` | `fly tokens create deploy -a expensify-backend-dusky-summit-570 -x 8760h` → paste the full `FlyV1 …` value |
| `PROD_API_URL` | post-deploy health check curl | the app base URL, e.g. `https://expensify-backend-dusky-summit-570.fly.dev` |

The `FLY_API_TOKEN` value starts with `FlyV1 ` — paste it **whole**, no quotes.
Use an **app-scoped deploy token** (above), not an org token.

---

## Standard deploy (CI path)

```bash
# from the repo, on master with your changes committed
git push origin master
```

Then watch it:

```bash
# requires gh; otherwise open the Actions tab in the browser
gh run watch                       # or: gh run list --branch master
```

CI builds and the deploy job ships it. Confirm with [Verification](#verifying-a-deploy) below.

---

## Manual deploy (fallback)

Use when CI is broken or you need to ship immediately. Requires a locally
authenticated `flyctl` (`fly auth login`).

```bash
cd backend
fly deploy --remote-only --wait-timeout 120s
```

This rebuilds from your **working tree** and releases a new version. It is the
same command CI runs. A manual deploy does **not** fix CI — the `FLY_API_TOKEN`
secret must still be valid for future pushes to auto-deploy.

---

## Verifying a deploy

```bash
# 1. A new release should appear, STATUS=complete
fly releases --app expensify-backend-dusky-summit-570 | head -3

# 2. Machine healthy on the new version
fly status --app expensify-backend-dusky-summit-570

# 3. App responds
curl -s https://expensify-backend-dusky-summit-570.fly.dev/health
```

**Confirm the *code* actually shipped** (not just a re-release of the old image).
The config response includes every `Config` field except the secrets — check for
fields you expect from your change:

```bash
curl -s https://expensify-backend-dusky-summit-570.fly.dev/api/config \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(Object.keys(JSON.parse(d).config)))"
# expect 16 fields incl. myGithubUsername, autoProposal, lastRestartAt
```

> There is no `/version` endpoint, so the API shape is the most reliable
> signal that the running build matches current `master`.

---

## Troubleshooting — failure modes seen in practice

### 1. Deploy step fails instantly (0 seconds), no new release
**Symptom:** the `Deploy` step's `started_at` == `completed_at`, exit code 1,
`fly releases` shows no new version.
**Cause:** `flyctl` can't authenticate — `FLY_API_TOKEN` is **missing, empty, or
expired**.
**Fix:** recreate the token and update the secret (see table above), then re-run
the job or push an empty commit:
```bash
git commit --allow-empty -m "ci: re-trigger deploy" && git push origin master
```

### 2. Deploy step fails on the `--wait-timeout` flag
**Symptom:** instant failure mentioning an invalid duration / argument.
**Cause:** recent `flyctl` (installed via `setup-flyctl@master`) requires
`--wait-timeout` to be a **duration string** (`120s`, `2m`) — a bare integer
(`120`) is rejected. `setup-flyctl@master` always pulls the latest CLI, so flag
changes can break CI without a code change.
**Fix:** already applied in `ci.yml` (`--wait-timeout 120s`). If a future flag
changes, pin the CLI: `superfly/flyctl-actions/setup-flyctl@v1` with a `version:`.

### 3. New release deployed but the API shows old behavior
**Symptom:** `fly releases` shows a new version, but `/api/config` is missing
fields your code adds.
**Cause:** the release **reused an existing image** (a restart/redeploy without a
rebuild) instead of building current source. Confirm by comparing image tags:
```bash
fly image show --app expensify-backend-dusky-summit-570   # note the TAG (deployment-…)
```
If the tag matches the previous release, no new build happened.
**Fix:** run a real build: `cd backend && fly deploy --remote-only --wait-timeout 120s`.

### 4. CI is red but build is fine
Check **which** job failed — `ci` (typecheck/lint/build) vs `deploy`:
```bash
gh run view <run-id>     # or the Actions UI
```
A green `ci` + red `deploy` is almost always #1 or #2 above.

---

## Rollback

Two reliable options — there is no `fly releases rollback` subcommand for this
(machines) app.

**A. Revert the source and redeploy (preferred — keeps git and prod in sync):**
```bash
git revert <bad-commit> && git push origin master   # CI redeploys, or deploy manually
```

**B. Redeploy a previous image directly (fastest):**
```bash
# find the image tag of the version you want to restore
fly releases --image --app expensify-backend-dusky-summit-570
fly deploy --image registry.fly.io/expensify-backend-dusky-summit-570:<tag> \
  --app expensify-backend-dusky-summit-570
```

Data is safe across rollbacks — SQLite lives on the `notifier_data` volume
mounted at `/data`, independent of the app image.

---

## Quick reference

| Task | Command |
|---|---|
| Deploy via CI | `git push origin master` |
| Manual deploy | `cd backend && fly deploy --remote-only --wait-timeout 120s` |
| Build only (no release) | `cd backend && fly deploy --remote-only --build-only` |
| List releases | `fly releases --app expensify-backend-dusky-summit-570` |
| Machine status | `fly status --app expensify-backend-dusky-summit-570` |
| Live logs | `fly logs --app expensify-backend-dusky-summit-570` |
| Create deploy token | `fly tokens create deploy -a expensify-backend-dusky-summit-570 -x 8760h` |
| Health | `curl -s $URL/health` |
