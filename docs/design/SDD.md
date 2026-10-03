# Labthrift Plan — Software Design Description

> Baseline: 2026-10-03. Product: Labthrift Plan. Repository: `zemdregon/labthrift-plan`. Source-grounded design baseline; deployment and acceptance evidence is tracked separately in [release status](release-status.md).

## Modules
| Module | Responsibility |
|---|---|
| `public/index.html` | Notebook shell, controls and dialogs |
| `public/app.js` | Client model, rendering, autosave, conflict and auth interactions |
| `public/styles.css` | Responsive notebook presentation |
| `public/sw.js` | Static caching and honest offline fallback |
| `src/worker/index.ts` | Hono routes, auth, validation, persistence and metrics |
| `migrations/0001_init.sql` | Users, passkeys, sessions, labs and challenges |
| `0002_enroll_tokens.sql` | Device enrollment tokens |
| `0003_privacy_metrics.sql` | Aggregate daily metrics |
| `0004_capacity.sql` | Services and capacity JSON fields |

## Behavioral design
The server produces a default notebook containing known checklist entries and a 12-unit closet. Client edits are serialized into the lab payload. The server clamps accepted fields before persistence. Saves return an updated timestamp; stale supplied versions produce a conflict response containing the current lab for resolution.

The single Worker module currently combines routing and domain logic. This is an observed implementation, not a proposed rewrite. A future extraction of sanitizers/storage could improve test isolation but is outside the Runs merge.

## Authentication and persistence
Passkeys and sessions use Plan’s own tables. Adding a second device uses enrollment/passkey routes. Labs store collections as JSON columns and one user-bound row. Service references and capacity sketches are planning information, not live monitoring.

## Boundary invariant
No ByteRush action writes this model. The `lab-plan-passkeys` project copied into ByteRush retains its instructions for this application, with a visible Plan label. Removing Runs must not change these module contracts or remove Plan data.
