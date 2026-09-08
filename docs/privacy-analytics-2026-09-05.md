# Privacy-first analytics plan (2026-09-05)

Decision + implementation notes for **labthrift.com** and **plan.labthrift.com**.

## Hard rules (unchanged)

- No IP addresses stored in DBs / product logs we control
- No email capture for analytics
- No fingerprinting for ads; no third-party ad trackers / pixels
- Bot vs human is best-effort only (free-tier CF)
- Cloudflare Free–friendly only

## Decision

| Property | Approach | Why |
|----------|----------|-----|
| **labthrift.com** (main) | **First-party Worker + D1 aggregates** *and* optional **Cloudflare Web Analytics** (dashboard) | We control path+day human/bot counts with no IP. CF Web Analytics is privacy-oriented (no cookies / no fingerprinting for analytics display) and lives in CF’s dashboard — we do **not** store that data ourselves. No site token existed in repo/env, so the JS beacon was **not** embedded. |
| **plan.labthrift.com** | **First-party D1 daily counters** only | Product metrics (load / save / register) must be first-party aggregates. No third-party beacon on the planner. |

**Rejected:** Google Analytics, Plausible cloud with PII, fingerprint SDKs, logging raw UA/IP to D1, public stats pages.

**AXE → SHIP:** “Third-party analytics” stays axed. **Privacy-first first-party aggregates + optional CF Web Analytics** moved to SHIP (see triage).

## What shipped (code)

### Planner (`/workspace/labthrift-plan`)

- Migration `migrations/0003_privacy_metrics.sql` → table `metric_daily (day, metric, count)`
- Worker increments (never writes IP/UA/user id into this table):
  - `GET /api/lab` → `page_view_human` or `page_view_bot`
  - `PUT /api/lab` → `lab_save_human` or `lab_save_bot`
  - successful `POST /auth/register/verify` → `register_human` or `register_bot`
- Bot detection: `cf.botManagement.verifiedBot === true`, bot score `1–29` when present, else coarse UA regex. **Free plan:** `botManagement` may be dummy — UA heuristics still apply. We never persist IP or raw UA.

### Main site (`/workspace/labthrift`)

- New D1 database `labthrift-metrics` (`8135e54a-4463-412a-9d33-a0a41bfc29ae`), binding `METRICS`
- Migration `migrations/0001_pageviews.sql` → `pageview_daily (day, path, kind, count)`
- Worker counts successful HTML (and content-negotiated) page GETs only — not assets / md twins / wp probes
- Same bot heuristics; `kind` is `human` or `bot`; path is normalized (no query string)

### Not shipped

- CF Web Analytics JS snippet (no token in env/docs)
- Public stats UI / password gate (use wrangler SQL for now)
- Enterprise Bot Management scores as a hard dependency

## How Ender reads the numbers

### Planner product metrics

```bash
cd /workspace/labthrift-plan

# Last 14 days, all metrics
npx wrangler d1 execute lab-plan --remote --command \
  "SELECT day, metric, count FROM metric_daily WHERE day >= date('now','-14 day') ORDER BY day DESC, metric"

# Human saves vs views (rough engagement)
npx wrangler d1 execute lab-plan --remote --command \
  "SELECT day,
     SUM(CASE WHEN metric='page_view_human' THEN count ELSE 0 END) AS views,
     SUM(CASE WHEN metric='lab_save_human' THEN count ELSE 0 END) AS saves,
     SUM(CASE WHEN metric='register_human' THEN count ELSE 0 END) AS registers
   FROM metric_daily WHERE day >= date('now','-30 day') GROUP BY day ORDER BY day DESC"
```

### Main site traffic (first-party)

```bash
cd /workspace/labthrift

# Daily human vs bot totals
npx wrangler d1 execute labthrift-metrics --remote --command \
  "SELECT day, kind, SUM(count) AS hits FROM pageview_daily
   WHERE day >= date('now','-14 day') GROUP BY day, kind ORDER BY day DESC, kind"

# Top human paths
npx wrangler d1 execute labthrift-metrics --remote --command \
  "SELECT path, SUM(count) AS hits FROM pageview_daily
   WHERE kind='human' AND day >= date('now','-14 day')
   GROUP BY path ORDER BY hits DESC LIMIT 30"
```

### Zone / CF dashboard (already on account)

- **Traffic / zone analytics:** Cloudflare dashboard → zone `labthrift.com` → Analytics. Edge request totals (CF-side; not our D1). Account already has `#analytics:read`.
- **Workers Observability:** already enabled on both Workers for ops/errors — not a product funnel.

## Dashboard steps only Ender can click (CF Web Analytics)

No RUM site token was present in the repo or Worker vars, and the OAuth token used for deploy lacks RUM site management. To enable **Cloudflare Web Analytics** (optional, recommended for main site page performance + visit overview without us storing IPs):

1. Log into [Cloudflare dashboard](https://dash.cloudflare.com) → account **Enders Account**.
2. Go to **Web Analytics** (account-level) or **Analytics & Logs → Web Analytics**.
3. **Add a site** → hostname `labthrift.com` (and optionally `www.labthrift.com`).
4. Because the origin is already proxied via the Labthrift Worker:
   - Prefer **Automatic setup** (edge injection) if available on Free and not blocked by `Cache-Control: public, no-transform` (our Worker does **not** set `no-transform`, so injection should work).
   - Or **Enable with JS Snippet** → copy the beacon token.
5. If using the snippet path: paste before `</body>` in `index.html` / guide templates, or set Worker var `CF_WEB_ANALYTICS_TOKEN` and have the Worker inject — **do not commit the token in git if treat as secret**; a public beacon token is typically site-scoped and non-secret, but still keep it out of casual scrapes if preferred.
6. Confirm the site appears under Web Analytics and that EU exclusion options match your preference.
7. Optional: repeat for `plan.labthrift.com` only if you want RUM there; product metrics already cover planner usage without a beacon.

After automatic setup, **no code change required**. After manual snippet, ask an agent to embed the token once.

## Privacy checklist

| Data | Stored by us? |
|------|----------------|
| IP | **No** |
| Raw User-Agent | **No** (classified in-memory only) |
| Email / fingerprint / ad IDs | **No** |
| Username in metrics table | **No** |
| Day + metric/path + count | **Yes** (aggregates) |

## Free-tier notes

- D1 writes: one upsert per counted request (planner: lab GET/PUT/register; main: HTML pages). Fine for Free write budgets at current scale.
- `request.cf.botManagement` full accuracy needs Bot Management (Enterprise). On Free we treat `verifiedBot===true` and score≤29 as bot when present, plus UA class — **best-effort**.

## Deploy IDs (this ship)

| Worker | Version ID | Notes |
|--------|------------|-------|
| `lab-plan` | `ec7ad97a-c8e5-4d0d-a596-9aaab2ddbd93` | metrics migration + increments |
| `labthrift` | `f24709ab-b759-4365-a25c-3e3d08f4c348` | METRICS D1 + pageview aggregates; `/migrations`/`/docs` 404 |

Smoke: `GET /about` wrote `pageview_daily` row `{day:2026-09-05, path:/about, kind:human, count:1}`.
