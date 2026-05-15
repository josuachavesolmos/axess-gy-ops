# Axess GY Dashboard · Deployment Guide

End-to-end guide to deploy the v5 dashboard with authentication. Total time: **~45 minutes** the first time.

```
┌────────────────────────────────────────────────────────────────┐
│  Client → https://<subdomain>.olmoraia.com   (GitHub Pages)    │
│         ├── index.html        (login page)                     │
│         ├── dashboard.html    (the dashboard, gated)           │
│         └── auth.js                                            │
│                  │                                             │
│                  │  POST /auth/login + GET /auth/verify        │
│                  ▼                                             │
│  Cloudflare Worker · axess-gy-auth.workers.dev                 │
│         └── reads/writes KV namespace USERS                    │
└────────────────────────────────────────────────────────────────┘
```

---

## 0. Prerequisites

- **Node.js 18+** (for `wrangler` and `seed-users.js`).
- A **GitHub** account with permission to create a public repo.
- A **Cloudflare** account (free tier is enough). Sign up at https://dash.cloudflare.com/sign-up — no credit card required.
- (Optional) The DNS panel of your `olmoraia.com` (e.g. Cloudflare DNS, Namecheap, GoDaddy) if you want a custom subdomain.

---

## 1. Deploy the Cloudflare Worker

All commands below run from `cloudflare-worker/`.

### 1.1 Install wrangler

```bash
cd cloudflare-worker
npm install
```

### 1.2 Login

```bash
npx wrangler login
```

A browser tab opens — approve the wrangler permissions for your Cloudflare account.

### 1.3 Create the KV namespace

```bash
npx wrangler kv namespace create USERS
```

Output looks like:
```
✨  Success! Add the following to your configuration file:
[[kv_namespaces]]
binding = "USERS"
id = "a1b2c3d4e5..."
```

Copy the `id` value and paste it into `wrangler.toml` replacing `REPLACE_WITH_KV_NAMESPACE_ID`:

```toml
[[kv_namespaces]]
binding = "USERS"
id = "a1b2c3d4e5..."        # ← paste here
```

### 1.4 Set the JWT signing secret

Generate a strong random secret:

```bash
openssl rand -base64 48
# → e.g.  k9F+...lots of chars...==
```

Push it to the Worker as a secret (it never gets committed to the repo):

```bash
npx wrangler secret put JWT_SECRET
# Paste the value when prompted, press Enter.
```

### 1.5 Adjust ALLOWED_ORIGIN

Edit `wrangler.toml` and set `ALLOWED_ORIGIN` to the URL(s) where the dashboard will live. Comma-separated for multiple values:

```toml
[vars]
ALLOWED_ORIGIN = "https://axess.olmoraia.com,https://<your-gh-user>.github.io"
```

Tip: include the `https://<your-gh-user>.github.io` fallback while you're testing — once the custom domain is live you can remove it.

### 1.6 Deploy

```bash
npx wrangler deploy
```

You'll get a URL like `https://axess-gy-auth.<your-cf-account>.workers.dev`. **Copy this URL** — you'll paste it into the dashboard meta tags next.

Quick health check:

```bash
curl https://axess-gy-auth.<your-cf-account>.workers.dev/health
# → {"status":"ok"}
```

---

## 2. Seed initial users

Still inside `cloudflare-worker/`:

```bash
cp users.example.json users.json
# Edit users.json with your real users (username, name, email, role)
node seed-users.js
```

The script prints two blocks:

1. A table of generated passwords — distribute one row per user via secure channel (1Password, signed email).
2. A list of `wrangler kv key put` commands — paste them into the terminal to load each user into KV.

After running the commands, **delete `users.json`** (it isn't in git but contains plaintext metadata):

```bash
rm users.json
```

Verify users are in KV:

```bash
npx wrangler kv key list --binding USERS
```

---

## 3. Deploy the GitHub Pages site

### 3.1 Wire the Worker URL into the dashboard

Inside `github-pages/`:

- Open **`index.html`** and **`dashboard.html`**. Find the line:
  ```html
  <meta name="axess-auth-worker" content="https://axess-gy-auth.REPLACE.workers.dev">
  ```
- Replace with the Worker URL from step 1.6:
  ```html
  <meta name="axess-auth-worker" content="https://axess-gy-auth.<your-cf-account>.workers.dev">
  ```

### 3.2 Push to your GitHub repo

Assuming the repo doesn't exist yet:

```bash
cd ..                                          # back to project root
git init
git add github-pages/ cloudflare-worker/ DEPLOY.md CONTEXT_DASHBOARD_V5.md
echo "node_modules/" > .gitignore
git commit -m "Initial deploy: dashboard v5 + auth worker"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

If you have an existing repo, just place the contents of `github-pages/` at the root of the branch you serve from Pages.

### 3.3 Enable GitHub Pages

1. Open your repo → **Settings** → **Pages**.
2. **Source**: Deploy from a branch.
3. **Branch**: `main` · **Folder**: `/github-pages` (or `/(root)` if you moved the files there).
4. Save.
5. Wait ~1 min — the URL `https://<owner>.github.io/<repo>/` becomes live.

### 3.4 (Optional) Custom domain · axess.olmoraia.com

1. In your DNS panel, add a **CNAME** record:
   ```
   Name:  axess
   Type:  CNAME
   Value: <owner>.github.io
   ```
2. In **Settings → Pages → Custom domain**: type `axess.olmoraia.com` and save. GitHub verifies and provisions HTTPS automatically (~10 min).
3. Add a `CNAME` file inside `github-pages/`:
   ```bash
   echo "axess.olmoraia.com" > github-pages/CNAME
   git add github-pages/CNAME
   git commit -m "Add custom domain"
   git push
   ```

### 3.5 Final CORS update

Once the live URL is known, double-check `cloudflare-worker/wrangler.toml`:

```toml
ALLOWED_ORIGIN = "https://axess.olmoraia.com"
```

Then redeploy:

```bash
cd cloudflare-worker && npx wrangler deploy
```

---

## 4. End-to-end test

1. Open `https://axess.olmoraia.com/` (or `https://<owner>.github.io/<repo>/`).
2. You should see the login page.
3. Enter credentials of one of the seeded users.
4. On success, you land in `dashboard.html` with the user chip showing the name and a logout button.
5. Click logout — you go back to the login page, token cleared.
6. Refresh: still logged out. Sign in again → works.

If something fails, check:
- Browser DevTools → Network → `auth/login` returns 200 with `{token, user, exp}`.
- Browser DevTools → Application → Local Storage → `axess.auth.token` present after login.
- Cloudflare → Workers → `axess-gy-auth` → Logs (`npx wrangler tail`).

---

## 5. Recurring operations

### Add a new user

```bash
cd cloudflare-worker
cp users.example.json users.json
# Edit users.json to add only the new user(s)
node seed-users.js
# Run the printed wrangler commands
rm users.json
```

### Reset a user's password

Same flow as "Add a new user". The script regenerates the entry — anyone with the same `username` gets replaced.

### Remove a user

```bash
npx wrangler kv key delete --binding USERS <username>
```

### Renew the per-client license (badge expiration)

Edit `github-pages/dashboard.html`, find the `LICENSE = {...}` block, update `expiresAt`, commit + push:

```js
const LICENSE = {
  client: 'Axess GY',
  expiresAt: '2026-09-15',   // ← new date
  ...
};
```

GitHub Pages auto-rebuilds in ~1 min.

### Rotate the JWT secret (kicks every user out)

```bash
npx wrangler secret put JWT_SECRET
# enter a new value
npx wrangler deploy
```

All existing tokens become invalid immediately; users have to log in again.

---

## 6. Cost ceiling

| Service | Free tier | When you'd hit it |
|---|---|---|
| GitHub Pages (public repo) | Unlimited bandwidth (~100GB/mo soft cap) | Tens of thousands of users |
| Cloudflare Workers | 100,000 requests/day | ~3000 logins/day from same user base |
| Cloudflare KV | 100,000 reads/day, 1000 writes/day, 1GB storage | Same as above |

Total cost for this client: **$0/month**.

---

## 7. Files reference

```
project root/
├── Axess_GY_Dashboard_v5.html      ← standalone offline copy (email fallback)
├── CONTEXT_DASHBOARD_V5.md          ← project context (architecture, gotchas)
├── DEPLOY.md                        ← this file
├── github-pages/                    ← deploy to GitHub Pages
│   ├── index.html                   ← login page
│   ├── dashboard.html               ← dashboard with auth gate
│   ├── auth.js                      ← shared JWT client
│   └── CNAME                        ← (after step 3.4) custom domain
└── cloudflare-worker/               ← deploy to Cloudflare Workers
    ├── src/index.js                 ← Worker code (PBKDF2 + JWT)
    ├── wrangler.toml                ← config + KV binding + CORS origins
    ├── package.json
    ├── seed-users.js                ← creates KV entries with hashed passwords
    ├── users.example.json           ← template for seed
    └── .gitignore                   ← excludes node_modules, users.json
```
