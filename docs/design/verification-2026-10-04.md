# Plan verification — October 4, 2026

Roadmap items P01–P05 from the [universal completion roadmap](https://github.com/zemdregon/tech-dose/blob/main/docs/ROADMAP.md). This is **local** evidence: the checks ran against the repository source under `wrangler dev --local` with a disposable D1 directory, software passkeys (API) and a Chromium virtual authenticator (browser). Nothing here was deployed, and no production account, database row or domain was touched.

| | |
|---|---|
| Environment | Linux, Node 22.22, wrangler 4.129.0 (`--local`), Chromium 141 via playwright-core 1.56.1 |
| Commands | `npm run test:api` (62 checks, `tests/api/`), `npm run test:browser` (17 checks, `tests/browser/`) |
| Result | 79 of 79 pass on the merged code ([labthrift-plan#4](https://github.com/zemdregon/labthrift-plan/pull/4)). On the unchanged `main` source, 7 API checks and 8 browser checks fail; each failure is listed below with its fix. |
| Deployed | No. Live Plan is still Worker version `f30c1b10-7b13-4c08-ae6c-5c2a1a336295`, which has the defects below until `main` is deployed. |

## Results by roadmap item

### P01 Notebook ownership and editing contracts — locally verified

`tests/api/notebook.test.mjs`, `tests/browser/app.test.mjs` (autosave, conflicts).

- One default lab per account; every lab route requires a session; client-supplied `id`, `user_id`, `userId` or `username` never select another user's row (SR-P1).
- Full round trip of title, inventory specs and attention flags, services and host links, checklist flags, rack units/slots/ports, hosts, BOM and UPS/power notes.
- Boundaries: 100-item caps on every collection, documented string lengths, numeric clamps, 1–42 rack units with slots kept inside, server-owned checklist labels/links, BOM status and slug normalization (SR-P2).
- Observed contracts recorded as tests rather than changed: rack units of `0` or non-numeric fall back to the 12U default; service `hostId` and slot `inventoryId` are bounded strings that are not checked against existing items (the client treats unknown ids as unassigned).
- Stale `updated_at`/`If-Match` saves get 409 with the current notebook; explicit force overwrites; a missing notebook returns 404 and is not recreated (SR-P5).
- Browser: Saving…/Saved feedback, reload persistence, conflict bar with Reload and Force save, network and server failures shown as unsaved.
- Planning numbers stay estimates (ADR-P005): the API has no measured-health fields and the Headroom pane says "Not live metrics".

**Fixed:** a non-object or malformed `PUT /api/lab` body reset the whole notebook to defaults (now 400). Overlapping autosaves on a slow connection made the app report "Conflict — open elsewhere" against its own previous save (saves are now serialized and always record the server's latest version).

### P02 Portable imports and exports — locally verified

`tests/api/portability.test.mjs`, browser import tests.

- Export is `schema_version` 2 with `exported_at`, `username` and `lab`, served as an attachment, with no credential, session or user identifiers (SR-P3).
- An exported file restores every supported field exactly; files move between accounts without moving ownership.
- Legacy bare objects, legacy wrappers, v1, v2 and `"2"` are accepted; 3, 0, −1, 1.5, `"v2"`, `"abc"` and 99 are rejected with no change (SR-P4). v1 files without services/capacity import with those fields empty.
- Import replaces rather than merges and runs the same sanitizers as saves. Forged `passkeys`, `sessions`, `user_id` or `username` fields create nothing.
- Browser: the file picker warns "Replace your current lab plan… cannot be undone" before upload, cancel changes nothing, and unsupported versions are refused client-side.

**Fixed:** a JSON array or other non-object import body replaced the notebook with an empty one (now 400); importing into a missing notebook returned 200 with `lab: null` (now 404). Imported text could run script: an inventory `role` such as `<img src=x onerror=…>` was inserted into the Headroom pane as HTML, and the CSP allows inline handlers. Role and option values are now escaped.

### P03 Passkeys and account lifecycle — locally verified with software authenticators

`tests/api/auth.test.mjs`, browser sign-in tests.

- Register, sign in on a second device, `/auth/me`, logout of one device only, 30-day `HttpOnly; Secure; SameSite=Lax` cookie, expired sessions rejected and deleted.
- Wrong origin, wrong RP ID, unregistered key, another user's key, tampered signature, reused/expired/foreign challenges all fail with the same `invalid_credentials` (SR-P6).
- Enrollment codes: signed-in only, hashed at rest, 15-minute expiry, one use, revoked by minting a new one, bound to the account.
- Passkeys: list, add, revoke, revoked keys stop working, last-passkey protection, and no route touches another account's keys or completes another account's ceremony.
- Account deletion removes users, passkeys, sessions, labs, enrollment tokens and challenges for that account only, signs out other devices and frees the username.
- The 120-requests-per-minute bucket is per isolate; production runs many isolates, so it is not a global limit.
- There is no email or other account recovery. Losing every passkey loses the account; the app's nudge to add a second passkey is the only mitigation.

**Fixed:** a failed sign-in showed the raw code `invalid_credentials`; it now shows a readable message.

**Still needs a person:** one ceremony each on a physical platform authenticator (phone and laptop) at `https://plan.labthrift.com`, plus a second-device enrollment between them, using a disposable account that is deleted afterwards.

### P04 Offline behavior and aggregate metrics — locally verified

`tests/api/metrics.test.mjs`, browser offline tests.

- `metric_daily` has exactly `day`, `metric`, `count`; rows never contain usernames, user or session ids, IP addresses or user agents; only `page_view`, `lab_save` and `register` × `human`/`bot` are written; conflicts, failed saves, rejected imports and sign-ins write nothing (SR-P7).
- Browser offline: edits show "Offline — will retry when back", never "Saved", and save on reconnect. A server outage shows "Couldn't save" and recovers on the next edit. With the service worker installed, an offline reload shows the offline page with no username, and session checks return 503 rather than a cached identity (SR-P9).

**Fixed:** the service worker never registered, because `app.js` is loaded with a dynamic import that usually runs after the `load` event it waited for, so the offline page was not installed. A single failed request left the app permanently "offline" until the browser itself went offline and back, so later edits were never attempted. The service worker's 503 offline reply was treated as being back online. The offline banner promised "edits stay on this device", but unsaved edits live only in the open tab; it now says changes are not saved until you're back online. The static cache version moves from v4 to v5 so installed clients pick up the new script.

No offline editing guarantee is added. Edits made offline survive only while the tab stays open, and the existing leave-page warning covers unsaved changes.

### P05 Atomic save — adopted and merged, not yet deployed

`tests/api/concurrency.test.mjs`, ADR-P006, SR-P10.

On `main`, two saves from the same version both returned 200, and in the reproduced case both received the identical new `updated_at` (`2026-10-03T23:41:42.530Z`). The second silently replaced the first, and a stale client holding that timestamp could no longer be detected.

The change moves the version check into the `UPDATE … WHERE user_id = ? AND updated_at = ?` predicate and treats zero changed rows as a conflict carrying the current notebook. New versions are always strictly later than the previous one. Force saves and imports are explicit replacements that still write conditionally against the latest version, retrying a few times and returning 503 `busy` only under sustained contention. Locally, 25 two-way and 10 five-way races each produced exactly one winner, and the losers got recoverable conflicts. No schema migration is needed.

Adopted by merging under the owner’s standing merge authority. Still open: deploy the Plan release and verify it live.

## Remaining before P01–P05 close

1. Deploy Plan (`npm run deploy`; no migration) and record the Worker version.
2. Live smoke on `https://plan.labthrift.com` with a disposable account: create, edit, export/import, a second device, force a conflict, go offline, delete the account.
3. Physical-passkey ceremonies listed under P03.
