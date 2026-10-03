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
1. Resolve session user; parse request and clamp the notebook.
2. Read that user’s existing timestamp; return 404 if no lab.
3. If a supplied version is stale and force is false, return 409 with the current lab.
4. Serialize fields and update the user-bound row; return new timestamp.
5. Schedule aggregate save metric without adding user data to metric rows.

This sequence is not atomic compare-and-swap. An explicit future fix would add the old version to the UPDATE predicate and handle zero updated rows.

## Import and account lifecycle
Import accepts wrapper `.lab` or a direct legacy object, checks schema version, and replaces sanitized fields. Export produces a JSON attachment. Account deletion removes related records; passkey deletion checks the account’s remaining keys. Enrollment tokens are hashed and time limited in their own table.

## Merge invariant
Runs retirement has no DML against any Plan table. ByteRush gear statuses have no automatic mapping into notebook inventory, services, rack slots or completion flags.
