# Lab plan — improvement triage brief (2026-09-05)

Context only. Do not implement from this doc alone.

## What exists today

**Stack:** Cloudflare Worker (Hono) + D1 + static assets from `public/`. Custom domain `plan.labthrift.com` (Cloudflare bot check on fetch); also `lab-plan.lmao.workers.dev`. WebAuthn via `@simplewebauthn/*` (RP IDs/origins for both hosts).

**Auth model (hard constraint):** Username (3–32, `[a-zA-Z0-9_-]`, no `@`) + passkey only. No email, phone, password, or contact channel. Session cookie `lab_plan_session` (httpOnly, Secure, SameSite=Lax, 30 days). Account recovery = second passkey on this device, or one-time enroll code for another device. Lose all passkeys → account gone. Export JSON + hard delete account exist.

**Gate (signed out):** Create with passkey / Sign in; separate “Enroll this device” (username + 8-char code). Query `?enroll=1&user=&code=` prefills enroll fields.

**App panes (tab nav):**

| Pane | Purpose |
|------|---------|
| Stuff I have | Inventory: `{ name, note }[]` |
| Weekend path | Fixed Labthrift guide checklist (done flags only) |
| Closet map | Rack U sketch + switch port labels |
| House names | Hosts `{ hostname, ip, note }` + hosts-file snippet copy |
| Later buys | BOM pins `{ slug, status: consider\|skip\|bought, note }` |
| Settings | Add passkey, mint enroll code, delete account |

Theme toggle (auto/light/dark) in header. Debounced autosave (~450ms) + manual Save + Export JSON.

**Closet JSON (canonical):**

```json
{
  "units": 12,
  "slots": [{ "start": 1, "height": 2, "name": "Switch" }],
  "ports": [{ "port": "1", "label": "NAS" }]
}
```

- Front-of-rack UI: U1 at bottom. Place/edit via side panel (click empty U or gear).
- Client migrates legacy `{ u, name }` → `{ start: u, height: 1, name }` and `startU` alias.
- Server `clampLab` keeps units 1–42 and slices arrays to 100; does not normalize slot shapes on write.
- New account inserts `closet_json = '{}'` — client `ensureCloset()` fills defaults on load.

**Enroll flow (present, end-to-end):**

- Signed-in: `POST /auth/enroll/create` → 8-char code (ambiguous chars avoided), SHA-256 stored, 15 min, single use; prior unused tokens for user deleted; returns code + deep link.
- Signed-out: `POST /auth/enroll/options` then `/auth/enroll/verify` → new passkey + session.
- Also: `POST /auth/passkeys/options|verify` while signed in (same device).

**API surface:** `/auth/*` (register, login, logout, me DELETE, enroll, passkeys), `/api/lab` GET/PUT, `/api/lab/export`.

## Known gaps from code (not product research)

1. **`title` unused in UI** — lab has `title` (default “My lab”); never shown or edited.
2. **No passkey inventory** — can add passkeys; cannot list, rename, or revoke them.
3. **Checklist is frozen** — server `CHECKLIST_DEFAULT` keys only; user cannot add/reorder/remove steps; new guides require a code deploy to appear (merge preserves `done`).
4. **Closet edit limits** — editing a slot cannot change `start` U (only name/height); no drag-reorder; tall racks (e.g. 42U × 40px) are long vertical scrolls on phone.
5. **List UIs are bare** — inventory/hosts/BOM are dashed boxes of inputs; no empty states, search, sort, or bulk actions.
6. **Import missing** — export exists; no import/restore of exported JSON.
7. **Autosave feedback only** — no offline queue, conflict handling, or “unsaved” when save fails mid-edit (failed save leaves stale server copy; local `lab` stays dirty until next success).
8. **Mobile friction** — tab bar `flex-wrap: nowrap` + horizontal scroll (six tabs); gate/app header rows wrap but Settings enroll UI is dense; port grid 4 cols &lt;700px (chips truncated); closet editor stacks under rack below 700px (good) but rack min 40px/U still tall.
9. **Recovery UX copy vs capability** — gate warns “lose every passkey and the account is gone” but Settings does not show how many passkeys exist or nudge for a second key after first login.
10. **No rate limits / abuse controls visible** in worker (username enumeration on login options returns `unknown_user` 404; enroll/create unbounded per session aside from replacing unused tokens).
11. **a11y** — tabs are buttons without `aria-selected` / tablist pattern; some errors only in `#gateErr` / `#setErr`.
12. **Ops** — `plan.labthrift.com` serves Cloudflare interstitial to non-browser fetchers; triage against workers.dev or authenticated browser if scraping HTML.

## Constraints for any improvement

- **Username + passkey only** — no email, SMS, magic link, OAuth, or support contact capture.
- Recovery must stay passkey- or enroll-code-based (short-lived, single-use).
- Keep data minimization: plan JSON only; notes/guides stay on labthrift.com.
- Prefer progressive UX on existing panes over new auth surface area.
- D1 + Worker size/latency; clamp sizes already at 100 items / 42U.

## Suggested triage themes (for later prioritization)

- Passkey hygiene (list/count/revoke + post-create “add a second key”).
- Closet polish (move start U, empty states, mobile rack density).
- Import + title field + checklist extensibility policy.
- Mobile tabs (overflow menu or icons) and touch targets consistency.
- Soft hardening (generic auth errors, enroll mint cooldown) without collecting contact info.

## Sources

- Repo: `/workspace/labthrift-plan` (`public/index.html`, `public/app.js`, `public/styles.css`, `src/worker/index.ts`, `migrations/*`, `wrangler.jsonc`)
- Live shell text: `https://lab-plan.lmao.workers.dev` (2026-09-05). Custom domain fetch hit Cloudflare bot challenge.
