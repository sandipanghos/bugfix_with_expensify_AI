# Deployment Guide — GitHub Issue Notifier & Auto-Proposer

> This project's actual deployed instance: Fly app `expensify-backend-dusky-summit-570`, region `bom` (Mumbai) — see [backend/fly.toml](../backend/fly.toml). The steps below are a generic walkthrough for deploying your own copy under your own app name/region; substitute as needed.

## Options at a Glance

| Platform | Cost | Effort | Notes |
|---|---|---|---|
| **Fly.io** (recommended) | ~$2.10/month | Low — 6 commands | Best DX, persistent volume |
| **Oracle Cloud Free** | $0 forever | Medium — manual VM | True zero cost |
| **Railway** | ~$2–3/month | Low | $5 credit on signup |
| Render free | $0 | Low | ❌ Sleeps — kills poller |
| Vercel / Netlify | $0 | — | ❌ Serverless — poller won't run |

> **Critical:** The poller must run 24/7. Any platform that sleeps idle instances will break the notification service.

---

## Option A — Fly.io (~$2.10/month) ✅ Recommended

**Cost breakdown:**
- `shared-cpu-1x` 256MB machine: ~$1.94/month (24/7)
- 1GB persistent volume: $0.15/month
- **Total: ~$2.10/month**

### Prerequisites

Install flyctl:
```bash
# macOS
brew install flyctl

# Windows
winget install flyctl

# Linux
curl -L https://fly.io/install.sh | sh
```

### Step 1 — Create account and app

```bash
flyctl auth login

cd backend
flyctl launch --name github-issue-notifier --no-deploy
# When asked "Would you like to copy its configuration to the new app?" → Yes
# Region: pick closest to you (ams=Europe, sjc=US West, iad=US East, sin/bom=Asia)
```

### Step 2 — Create persistent volume

```bash
# SQLite file lives here, survives redeploys
flyctl volumes create notifier_data --size 1 --region ams
```

### Step 3 — Set secrets

```bash
flyctl secrets set \
  SMTP_HOST=smtp.gmail.com \
  SMTP_PORT=587 \
  SMTP_SECURE=false \
  SMTP_USER=your-gmail@gmail.com \
  "SMTP_PASS=xxxx xxxx xxxx xxxx"

# Optional — only needed for POST /api/proposals (LLM-generated proposals)
flyctl secrets set ANTHROPIC_API_KEY=sk-ant-...
```

> `fly.toml` already sets `NODE_ENV`, `PORT`, `DATABASE_URL`, and `CORS_ORIGIN`.
> Never put SMTP credentials or the Anthropic key in `fly.toml` — that file is committed to git.

### Step 4 — Deploy

```bash
flyctl deploy --remote-only
# Fly.io builds the Docker image on their servers (no local Docker needed)
```

### Step 5 — Configure the notifier

```bash
# Get your app URL
flyctl info

# Configure (replace URL with your app's URL)
curl -X PUT https://github-issue-notifier.fly.dev/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "notificationEmail": "you@example.com",
    "watchedRepo": "Expensify/App",
    "watchedLabel": "Help Wanted",
    "issueLimit": 4,
    "githubToken": "ghp_..."
  }'

# Start monitoring
curl -X POST https://github-issue-notifier.fly.dev/api/config/start

# Verify it's running
curl https://github-issue-notifier.fly.dev/api/config/status
```

### Useful Commands

```bash
flyctl status              # machine health
flyctl logs                # live log stream (Ctrl+C to stop)
flyctl logs --tail 100     # last 100 log lines
flyctl ssh console         # SSH into running machine
flyctl deploy --remote-only  # redeploy after code changes
flyctl secrets list        # list secret names (not values)
flyctl secrets set KEY=VAL # add/update a secret
flyctl volumes list        # check volume
flyctl scale memory 512    # upgrade to 512MB if needed
```

### Updating the app

```bash
git push origin master     # triggers GitHub Actions auto-deploy

# Or manually:
cd backend && flyctl deploy --remote-only
```

---

## Option B — Oracle Cloud Always Free ($0/month forever)

Oracle gives 2 AMD VMs (1 OCPU, 1GB RAM) that are permanently free — no credit card charges after signup.

### Step 1 — Sign up

1. Go to [cloud.oracle.com](https://cloud.oracle.com)
2. Sign up for Always Free (credit card required for identity verification, never charged for free resources)
3. Select a home region close to you

### Step 2 — Create Always Free VM

1. Compute → Instances → Create Instance
2. Shape: `VM.Standard.E2.1.Micro` (Always Free)
3. Image: Ubuntu 22.04
4. Add your SSH public key
5. Create

### Step 3 — Open port 3001

1. Networking → Virtual Cloud Networks → your VCN → Security Lists → Default
2. Add Ingress Rule: Protocol=TCP, Source=0.0.0.0/0, Port=3001

### Step 4 — Install and run

```bash
# SSH in
ssh ubuntu@<your-vm-ip>

# Install Node.js 22 (matches CI/Docker; package.json's engines field says >=24.0.0,
# an unreconciled inconsistency in the current source — not enforced, Node 22 works)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git

# Clone repo
git clone https://github.com/YOUR_USERNAME/github-issue-notifier.git
cd github-issue-notifier/backend

# Install and build
npm ci && npm run build && npx prisma generate

# Configure env
cp .env.example .env
nano .env
# Set: DATABASE_URL=file:./prod.db, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS

# Push DB schema
npm run db:push

# Install PM2 (keeps app running after SSH disconnect)
sudo npm install -g pm2

# Start
pm2 start dist/server.js --name notifier
pm2 save
pm2 startup   # copy and run the command it prints
```

### Step 5 — Configure notifier

```bash
curl -X PUT http://<your-vm-ip>:3001/api/config \
  -H "Content-Type: application/json" \
  -d '{"notificationEmail":"you@example.com","watchedRepo":"Expensify/App","watchedLabel":"Help Wanted","issueLimit":4}'

curl -X POST http://<your-vm-ip>:3001/api/config/start
```

### Updating on Oracle VM

```bash
ssh ubuntu@<your-vm-ip>
cd github-issue-notifier/backend
git pull
npm ci && npm run build
pm2 restart notifier
```

---

## CI/CD — Auto-Deploy on Git Push (Fly.io)

The [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) file auto-deploys when you push to `master` and `backend/` files changed.

### Setup

Add these secrets in GitHub → Settings → Secrets → Actions:

| Secret | Value |
|---|---|
| `FLY_API_TOKEN` | Run `flyctl tokens create deploy` and paste output |
| `PROD_API_URL` | `https://github-issue-notifier.fly.dev` |

### What happens on push

```
git push origin master
    → GitHub Actions starts
    → flyctl deploy --remote-only (Fly.io builds Docker image)
    → health check: GET /health
    → done (~2-3 minutes total)
```

---

## Verifying Production Deployment

```bash
# Health check
curl https://your-app.fly.dev/health
# Expected: {"status":"ok","uptime":123.4}

# DB connectivity
curl https://your-app.fly.dev/health/ready
# Expected: {"status":"ready","db":"connected"}

# Notifier status
curl https://your-app.fly.dev/api/config/status
# Expected: {"isRunning":true,"watchedRepo":"Expensify/App",...}

# Recent notifications
curl https://your-app.fly.dev/api/notifications?limit=5
```

---

## Rollback (Fly.io)

```bash
# List recent deployments
flyctl releases list

# Roll back to a specific version
flyctl deploy --image registry.fly.io/github-issue-notifier:<version>
```

---

## Monitoring

### Free uptime monitoring — UptimeRobot

1. Sign up at [uptimerobot.com](https://uptimerobot.com)
2. Add monitor → HTTP(s) → URL: `https://your-app.fly.dev/health`
3. Interval: 5 minutes
4. Alert: email on downtime > 5 minutes

### Logs

```bash
flyctl logs              # Fly.io live logs
pm2 logs notifier        # Oracle VM logs
pm2 logs notifier --lines 200  # last 200 lines
```

---

## Environment Variables Reference

Only 5 required. Everything else configured via `PUT /api/config` at runtime.

| Variable | Required | Example |
|---|---|---|
| `DATABASE_URL` | Yes | `file:/data/prod.db` |
| `SMTP_HOST` | Yes | `smtp.gmail.com` |
| `SMTP_PORT` | Yes | `587` |
| `SMTP_USER` | Yes | `you@gmail.com` |
| `SMTP_PASS` | Yes | `xxxx xxxx xxxx xxxx` |
| `NODE_ENV` | No | `production` (set by fly.toml) |
| `PORT` | No | `3001` (set by fly.toml) |
| `CORS_ORIGIN` | No | `*` (set by fly.toml) |
| `ANTHROPIC_API_KEY` | No | `sk-ant-...` — only needed for `POST /api/proposals`; route returns 500 if missing when called |
