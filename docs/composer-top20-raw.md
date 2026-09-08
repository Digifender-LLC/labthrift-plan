Audit based on the repo (`src/client/main.ts`, worker auth/lab routes, `src/shared/lab.ts`, `index.html`) and the live host (Cloudflare challenge page only — UI review is from the shipped client code). Ranked by **impact × feasibility** for a privacy-first username+passkey homelab planner.

---

### 1. Import lab JSON (restore from export)
- **Why:** Export exists but there is no import path, so backup is one-way despite “no recovery email.”
- **What:** Add “Import lab JSON” on Account with replace vs merge confirm; `POST /api/lab/import` or guarded `PUT` merge in `src/worker/lab.ts`, `src/client/api.ts`, `accountPane()` in `src/client/main.ts`; reuse `sanitizeLab()`.
- **Effort:** M
- **Risk:** med (bad merge or accidental overwrite)
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 2. First-session onboarding + second-passkey nudge
- **Why:** New users can miss the five panes and the “lose every passkey = gone” rule until it is too late.
- **What:** After first `register`/`loadLab`, show a one-screen tour (Stuff → Weekend → Closet → Hosts → Later buys) plus a persistent banner when `passkey_count === 1` until “Add another passkey” succeeds; `src/client/main.ts` (`boot`, `accountPane`).
- **Effort:** M
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 3. Discoverable / conditional passkey sign-in
- **Why:** Passkeys use `residentKey: "required"` but sign-in still requires typing a username first (`landing()`, `loginOptions()` always binds username).
- **What:** Add conditional UI (`mediation: 'conditional'`) on the sign-in username field; optional username-less path when the platform offers a resident key; `src/client/api.ts`, `src/worker/auth.ts` (`loginOptions` / `loginVerify`).
- **Effort:** M
- **Risk:** med (browser/WebAuthn edge cases)
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 4. Save conflict detection across tabs/devices
- **Why:** `PUT /api/lab` is last-write-wins; `labs.updated_at` exists in D1 but is not used for concurrency.
- **What:** Return `updated_at` on `GET /api/lab`; client sends `If-Match` / body version; `409` shows “open elsewhere — reload or force save”; `src/worker/db.ts`, `src/worker/lab.ts`, `persist()` in `src/client/main.ts`.
- **Effort:** M
- **Risk:** med
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 5. `noindex` + baseline security headers
- **Why:** Private notebooks should not be indexed; the worker serves API + SPA with no CSP/frame policy today (`index.html`, `src/worker/index.ts`).
- **What:** `<meta name="robots" content="noindex, nofollow">` in `index.html`; Hono middleware for `Content-Security-Policy` (self + labthrift.com links), `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- **Effort:** S
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 6. Unsaved-work guard when save fails
- **Why:** On network error, `persist()` sets `dirty = true` but there is no `beforeunload` / `visibilitychange` retry if the user leaves mid-failure.
- **What:** `beforeunload` when `dirty || error`; `visibilitychange` flush + retry; clearer “Couldn’t save — retry” in the save bar; `src/client/main.ts`.
- **Effort:** S
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 7. Remember active pane (URL hash or sessionStorage)
- **Why:** Every reload returns to “Stuff I have” (`tab` defaults to `"inventory"`); deep-linking to Closet is useful in the rack.
- **What:** Persist `tab` in `sessionStorage` and/or `#closet` hash; read on `boot()` / tab click; `src/client/main.ts`.
- **Effort:** S
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 8. Weekend path progress summary
- **Why:** Eleven checklist rows with no sense of progress; weak motivation on return visits.
- **What:** Header like “4 of 11 done” and optional “Hide completed”; `weekendPane()` in `src/client/main.ts`.
- **Effort:** S
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 9. Rack keyboard accessibility
- **Why:** Rack rows use `role="button"` but no `tabindex` or keyboard handlers (`rackGrid()`), so keyboard-only users cannot place/edit gear.
- **What:** `tabindex="0"`, Enter/Space handlers, visible focus ring; `src/client/main.ts`, `src/client/styles.css`.
- **Effort:** S
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 10. Closet rack shrink safety
- **Why:** Lowering `rackUnits` does not warn or clamp slots that extend past the new height; slots can become invisible in the grid.
- **What:** On rack height change, block with a message or auto-clamp/remove out-of-range slots; `closetPane()`, optionally `sanitizeLab()` in `src/shared/lab.ts`.
- **Effort:** S
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 11. Link closet slots to Stuff I have
- **Why:** Inventory and rack labels are separate silos; users re-type “Old OptiPlex” on the rack.
- **What:** Optional “Link from inventory” picker when placing/editing a slot; store `inventoryId` or denormalized name on `ClosetSlot`; `src/shared/lab.ts`, rack editor in `main.ts`.
- **Effort:** M
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 12. Revoke individual passkeys (when ≥ 2)
- **Why:** Account shows passkey count and truncated ids but only supports add, not remove — bad for device rotation.
- **What:** `DELETE /auth/passkeys/:id` with guard `passkey_count > 1`; list with friendlier labels (e.g. “Added 5 Sep 2026”); `src/worker/auth.ts`, `db.ts`, `accountPane()`.
- **Effort:** M
- **Risk:** med (accidental lockout if down to one)
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 13. Offline / flaky-network banner
- **Why:** Autosave debounces at 500ms with no `online`/`offline` handling; failures only appear in the save hint.
- **What:** Listen to `navigator.onLine` + failed `fetch`; show a top banner “Offline — edits stay on this device until you're back”; disable save spam; `src/client/main.ts`.
- **Effort:** S
- **Risk:** low
- **Depends on:** #6 (retry semantics)
- **Suggested disposition for parent:** ship

### 14. Proper tablist ARIA for the five panes
- **Why:** Nav uses buttons with `aria-selected` but not `role="tablist"` / `role="tab"` / `role="tabpanel"` / `aria-controls` (`appShell()`).
- **What:** Refactor tab markup and wire `id`/`aria-labelledby`; optional arrow-key nav; `src/client/main.ts`, `styles.css`.
- **Effort:** S
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 15. Theme picker in Account (not cryptic header cycle)
- **Why:** Theme cycles light → dark → system via a small header button (`setTheme`); easy to miss and hard to discover.
- **What:** Radio group “Light / Dark / Match system” in Account; keep or simplify header control; `accountPane()`, `styles.css`.
- **Effort:** S
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 16. Export schema version for forward-compatible import
- **Why:** `exportLab()` adds `exported_at` and `username` but no `schema_version`; future checklist keys or closet shape changes will break silent imports.
- **What:** Add `schema_version: 1` to export payload; import rejects or migrates unknown versions; `src/worker/lab.ts`, `src/shared/lab.ts`.
- **Effort:** S
- **Risk:** low
- **Depends on:** #1
- **Suggested disposition for parent:** ship

### 17. Later buys status at a glance
- **Why:** BOM status is a plain `<select>` (`bomRow()`); hard to scan a long list.
- **What:** Copper/cream chips for consider / skip / bought; optional filter tabs; `bomPane()`, `styles.css`.
- **Effort:** S
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

### 18. Reduce full-app re-renders on structural edits
- **Why:** `render()` calls `root.replaceChildren()` for the whole shell; `mutate()` triggers full rebuild on closet/inventory add-remove, risking focus loss and mobile jank.
- **What:** Pane-scoped updates or keyed subtrees; only re-mount the active pane; `src/client/main.ts`.
- **Effort:** L
- **Risk:** med (regression risk in a 1k-line UI file)
- **Depends on:** none
- **Suggested disposition for parent:** escalate

### 19. Contextual link from labthrift.com guides → Plan
- **Why:** Landing links out to labthrift.com but discoverability into Plan from guides is a one-way gap for the product.
- **What:** Short inline CTA on homelab guides (“Sketch your rack in Lab plan”) linking to `https://plan.labthrift.com` — **labthrift.com CMS**, not this repo.
- **Effort:** S (for Labthrift site); M if coordinated copy/design
- **Risk:** low
- **Depends on:** labthrift.com editorial
- **Suggested disposition for parent:** escalate

### 20. Per-session API rate limits (not IP-only)
- **Why:** `allowApi()` keys only on client IP (`src/worker/rate-limit.ts`); shared NAT or aggressive autosave can hit 120/min unfairly or be abused across accounts on one IP.
- **What:** Secondary bucket `api:user:{sessionId}` after `requireUser`; keep IP cap as backstop.
- **Effort:** S
- **Risk:** low
- **Depends on:** none
- **Suggested disposition for parent:** ship

---

## Top 5 ship first

1. **Import lab JSON** — closes the backup loop with no recovery email  
2. **Onboarding + second-passkey nudge** — prevents the main account-loss failure mode  
3. **Discoverable / conditional passkey sign-in** — matches `residentKey: required` and speeds return visits  
4. **Save conflict detection (`updated_at` / `If-Match`)** — protects multi-tab and multi-device users  
5. **`noindex` + security headers** — cheap, correct privacy posture for a signed-in notebook

---

**Not recommended (axe):** email/OAuth/password recovery, public `security.txt`, third-party analytics, affiliate-heavy BOM copy, or a service-worker+PWA stack unless offline read becomes a stated product goal (higher complexity on Workers free tier for marginal gain vs. import/export + offline banner).