# Labthrift Plan — Software Requirements Specification

> Baseline: 2026-10-03. Product: Labthrift Plan. Repository: `zemdregon/labthrift-plan`. Source-grounded design baseline; deployment and acceptance evidence is tracked separately in [release status](release-status.md).

## Verifiable requirements
| ID | Requirement | Check |
|---|---|---|
| SR-P1 | A session shall authorize only its user’s notebook | Cross-account API test |
| SR-P2 | Lab writes shall sanitize strings, arrays and numeric bounds | Boundary fixtures |
| SR-P3 | Exports shall declare schema version 2 | Inspect download |
| SR-P4 | Imports shall accept legacy, v1 and v2 and reject unknown versions | Import fixtures |
| SR-P5 | Explicitly stale save versions shall produce conflict feedback | Two-client sequential edit |
| SR-P6 | Passkey verification shall check configured RP/origin | Auth integration checks |
| SR-P7 | Metrics shall store only day/metric/count aggregates | Migration/schema review |
| SR-P8 | Runs retirement shall leave Plan resources untouched | Resource inventory + live smoke |
| SR-P9 | Offline UI shall not claim authentication or persistence succeeded | Network failure check |
| SR-P10 | Two simultaneous ordinary saves from one version shall not both succeed; the loser shall receive a 409 conflict with the current notebook, and every successful write shall get a new, later version | Concurrent save fixtures (`tests/api/concurrency.test.mjs`) |

## Interfaces and dependencies
Static vanilla JavaScript/CSS/HTML is served with a Hono Worker. D1 is required for accounts and notebook persistence. Browser WebAuthn and the SimpleWebAuthn libraries support passkeys. Configured RP/origin lists include production and preview cases; their presence is not an account-sharing implementation.

## Constraints and limitations
One lab row per user is enforced by the schema. `MAX_ITEMS=100` limits each collection; string and capacity bounds are implemented by sanitizers. Sessions expire after 30 days. The in-memory session bucket is a soft per-isolate control, not a global distributed rate limit. The deployed conflict check is not an atomic write predicate; simultaneous saves can still race until the SR-P10 change (ADR-P006) is deployed.

There is no approved SLA, recovery-time objective or offline editing guarantee in this baseline. Do not infer those from installation as a PWA. New reliability goals require explicit implementation and validation.

## Traceability
BR-P1/P4 → PR-P8 → FR-P3/integration boundary → SR-P1/P8. BR-P2 → PR-P2/P4 → FR-P4/P5 → SR-P2/P5/P10. BR-P3 → PR-P5 → FR-P6/P7 → SR-P3/P4.
