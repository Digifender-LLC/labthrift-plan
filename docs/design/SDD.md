# Labthrift Plan — Software Design Description

> Baseline: 2026-10-03. Product: Labthrift Plan. Repository: `zemdregon/labthrift-plan`. Source-grounded design baseline; deployment and acceptance evidence is tracked separately in [release status](release-status.md) and the [October 4 verification](verification-2026-10-04.md); remaining work is tracked in the [universal completion roadmap](https://github.com/zemdregon/tech-dose/blob/main/docs/ROADMAP.md).

## Modules
| Module | Responsibility |
|---|---|
| `public/index.html` | Notebook shell, controls and dialogs |
| `public/app.js` | Client model, rendering, autosave, conflict and auth interactions |
| `public/styles.css` | Responsive notebook presentation |
| `public/sw.js` | Static caching (cache version `lab-plan-static-v5`) and honest offline fallback |
| `public/retention-controls.js` | Recovered retention toolbar (see [source recovery](source-recovery-2026-10-03.md)) |
| `src/worker/index.ts` | Hono routes, auth, validation, persistence and metrics |
| `migrations/0001_init.sql` | Users, passkeys, sessions, labs and challenges |
| `0002_enroll_tokens.sql` | Device enrollment tokens |
| `0003_privacy_metrics.sql` | Aggregate daily metrics |
| `0004_capacity.sql` | Services and capacity JSON fields |
| `tests/` | `npm test`: API contract checks with software passkeys and browser checks with a virtual authenticator, against a disposable local D1 |
| `.github/workflows/test.yml` | Runs both suites on every pull request |

## Behavioral design
The server produces a default notebook containing known checklist entries and a 12-unit closet. Client edits are serialized into the lab payload. The server clamps accepted fields before persistence. Saves return an updated timestamp; stale supplied versions produce a conflict response containing the current lab for resolution.

The single Worker module currently combines routing and domain logic. This is an observed implementation, not a proposed rewrite. The contract checks exercise it over HTTP, so extraction was not needed for testing or for the ADR-P006 conditional write (roadmap X02 “Plan module extraction”: not required).

## Authentication and persistence
Passkeys and sessions use Plan’s own tables. Adding a second device uses enrollment/passkey routes. Labs store collections as JSON columns and one user-bound row. Service references and capacity sketches are planning information, not live monitoring.

## Boundary invariant
No ByteRush action writes this model. The `lab-plan-passkeys` project copied into ByteRush retains its instructions for this application, with a visible Plan label. Removing Runs must not change these module contracts or remove Plan data.
