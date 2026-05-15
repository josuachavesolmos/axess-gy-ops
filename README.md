# Axess GY Dashboard · v5

Single-file BI dashboard for Axess Group Guyana — work orders, personnel scheduling, equipment calibration, quote pipeline and leads tracking. Self-hosted on GitHub Pages with JWT-based authentication via Cloudflare Workers.

## Live URL

- Production: <https://axess.olmoraia.com>
- Mirror: <https://josuachavesolmos.github.io/axess-gy-ops/>

## Architecture

```
Browser
  ↓
GitHub Pages (static)
  ├── index.html       ← login page
  ├── dashboard.html   ← v5 dashboard (gated)
  └── auth.js          ← JWT client (login / verify / logout)
  ↓ POST /auth/login + GET /auth/verify
Cloudflare Worker (axess-gy-auth)
  └── KV namespace USERS  (PBKDF2-SHA256 hashed credentials)
```

## Modules

| Tab | Source workbook | Pill |
|----|----|----|
| Order Backlog & Revenue | `QuoteLog_*.xlsx` | Quote Log |
| Personnel & Scheduling | `Axess_Unified_Workbook.xlsx` (sheet *Planner*) | Operations |
| Equipment & Calibration | `Axess_Unified_Workbook.xlsx` (sheets *Equipment planner* + *Lists*) | Operations |
| Work Orders & Billing | `Axess_Unified_Workbook.xlsx` (sheet *Master Projects*) | Operations |
| Leads Log | `Leads 2.xlsx` | Leads |

## Stack

- **Frontend:** vanilla HTML + CSS + JS, ApexCharts 4.3, SheetJS 0.18 (CDN-pinned).
- **Auth:** Cloudflare Worker with PBKDF2 + JWT HS256 (24h / 30d remember-me).
- **Storage:** Cloudflare KV (`USERS` namespace).
- **Hosting:** GitHub Pages (public) + Cloudflare Workers (free tier).

## Deployment

See [`DEPLOY.md`](DEPLOY.md) for step-by-step instructions. Quick recap:

```bash
# 1. Auth Worker
cd cloudflare-worker
npm install
npx wrangler login
npx wrangler kv namespace create USERS    # paste id into wrangler.toml
npx wrangler secret put JWT_SECRET        # any 48-byte random
npx wrangler deploy                       # → Worker URL

# 2. Wire URL into the dashboard
#    Edit index.html + dashboard.html → replace REPLACE.workers.dev with Worker URL

# 3. Seed users
cp users.example.json users.json
# edit users.json with real users
node seed-users.js
# paste the printed `wrangler kv key put ...` commands
rm users.json

# 4. Push to GitHub
cd ..
git add .
git commit -m "Deploy v5"
git push

# 5. Enable Pages: Settings → Pages → main / root
```

## Project context

- [`CONTEXT_DASHBOARD_V5.md`](CONTEXT_DASHBOARD_V5.md) — full architectural reference (state model, render lifecycle, gotchas, license system, schema by tab).
- [`DEPLOY.md`](DEPLOY.md) — deployment + recurring operations playbook.
- [`archive/legacy/`](archive/legacy/) — previous Supabase-backed prototype kept for reference.

## License

Proprietary build for Axess Group Guyana. Per-client license expiration enforced
inside `dashboard.html` (`LICENSE` config block). Issuer: Olmoraia
(<contact@olmoraia.com>).
