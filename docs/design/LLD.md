# Labthrift Plan — Low-Level Design

> Baseline: 2026-10-03. Product: Labthrift Plan. Repository: `zemdregon/labthrift-plan`. Source-grounded design baseline; deployment and acceptance evidence is tracked separately in [release status](release-status.md).

## Notebook representation
`labs` contains an ID, unique `user_id`, title, JSON strings for inventory/checklist/closet/hosts/bom/services/capacity and `updated_at`. Reading parses JSON and combines checklist defaults with stored flags. Capacity fields expose `upsVa` and `powerNote` when present.

| Field group | Sanitization |
|---|---|
| Title | At most 80 characters |
| Inventory | Up to 100; name 120, note 240; bounded CPU/RAM/storage/watts |
| Services | Up to 100; optional host reference, RAM/CPU estimates, notes and URL |
| Closet | 1–42 units; slots clamped inside height; bounded names and port labels |
| Hosts | Bounded hostname, IP text and note |
| BOM | Guide slug normalized; status consider/bought/skip |
| Capacity | UPS VA bounded 0–100000; power note at most 240 characters |

## Save sequence
1. Resolve session user; reject a body that is not a JSON object with 400; clamp the notebook.
2. Read that user’s current version (`updated_at`); return 404 if no lab.
3. If a supplied version (`updated_at` in the body, else `If-Match`) differs and force is false, return 409 with the current lab. A save without a version is based on the version just read.
4. Compute the next version: now, or one millisecond after the current version if that is not earlier.
5. `UPDATE … WHERE user_id = ? AND updated_at = <expected>`. Zero changed rows means another write landed first: return 409 with the current lab (404 if it vanished).
6. Schedule the aggregate save metric without adding user data to metric rows.

Force saves and imports skip the version comparison but still run steps 4–5 against the latest version, retrying up to five times and returning 503 `busy` if every attempt loses a race. This is the ADR-P006 design; before it is deployed, production performs steps 2–3 and an unconditional update.

## Import and account lifecycle
Import requires a JSON object, accepts wrapper `.lab` or a direct legacy object, checks schema version, and replaces sanitized fields as an explicit replacement (see the save sequence). Export produces a JSON attachment. Account deletion removes related records; passkey deletion checks the account’s remaining keys. Enrollment tokens are hashed and time limited in their own table.

## Merge invariant
Runs retirement has no DML against any Plan table. ByteRush gear statuses have no automatic mapping into notebook inventory, services, rack slots or completion flags.
