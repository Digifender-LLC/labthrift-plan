# Labthrift Plan — Architecture Decision Records

> Baseline: 2026-10-03. Product: Labthrift Plan. Repository: `zemdregon/labthrift-plan`. Source-grounded design baseline; deployment and acceptance evidence is tracked separately in [release status](release-status.md) and the [October 4 verification](verification-2026-10-04.md); remaining work is tracked in the [universal completion roadmap](https://github.com/zemdregon/tech-dose/blob/main/docs/ROADMAP.md).

## ADR-P001 — Keep Plan as a separate notebook
**Status:** accepted. **Context:** Plan and Runs have overlapping beginner language but different data models. **Decision:** retain Plan; move guided learning into ByteRush. **Alternatives:** delete Plan or combine notebook editing into the feed. **Consequences:** three clear products remain; links explain transitions.

## ADR-P002 — Independent identities and persistence
**Status:** existing architecture retained. **Decision:** keep Plan users/passkeys/sessions/labs in its D1 database. **Alternative:** infer shared accounts from parent RP ID or import Runs identities. **Consequences:** sign-in is product-specific; shared SSO requires a later explicit design.

## ADR-P003 — Versioned portable notebook
**Status:** existing architecture retained. **Decision:** support JSON exports and v1/v2 import sanitization. **Alternative:** opaque server-only state. **Consequences:** users can keep portable copies; importing replaces notebook state and does not import authentication credentials.

## ADR-P004 — Record concurrency limitation accurately
**Status:** superseded by ADR-P006 once that change is merged and deployed; until then the limitation below still describes production. **Decision:** describe current save checks as read/check/update, not CAS. **Alternative:** claim `If-Match` alone proves atomicity. **Consequences:** racing writes remain a risk; a future conditional SQL update and concurrency tests should address it.

## ADR-P006 — Conditional lab writes (roadmap P05)
**Status:** adopted October 4, 2026 in [labthrift-plan#4](https://github.com/zemdregon/labthrift-plan/pull/4); effective in production only once deployed. **Context:** two saves from one version both succeeded and could receive the same new timestamp, so one silently replaced the other ([verification](verification-2026-10-04.md#p05-atomic-save--adopted-and-merged-not-yet-deployed)). **Decision:** put the expected version in the `UPDATE` predicate and treat zero changed rows as a 409 conflict carrying the current notebook; make each new version strictly later than the previous one; treat force saves and imports as explicit replacements that still write conditionally against the latest version. **Alternatives:** a separate integer revision column (needs a migration and client change for no extra guarantee); deferring with the race documented. **Consequences:** SR-P10 becomes verifiable; `updated_at` stays the version token, so existing clients work unchanged; under sustained contention a force save or import can return 503 `busy` instead of writing.

## ADR-P005 — No telemetry inferred from planning data
**Status:** accepted product boundary. **Decision:** capacity and service health details remain user-entered estimates/notes. **Alternative:** present sketches as measured infrastructure state. **Consequences:** no agent provisioning, network scanning or monitoring is implied by this merge. Aggregate metrics remain separate from notebook contents.
