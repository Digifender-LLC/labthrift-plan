# Labthrift Plan — Architecture Decision Records

> Baseline: 2026-10-03. Product: Labthrift Plan. Repository: `zemdregon/labthrift-plan`. Source-grounded design baseline; deployment and acceptance evidence is tracked separately in [release status](release-status.md).

## ADR-P001 — Keep Plan as a separate notebook
**Status:** accepted. **Context:** Plan and Runs have overlapping beginner language but different data models. **Decision:** retain Plan; move guided learning into ByteRush. **Alternatives:** delete Plan or combine notebook editing into the feed. **Consequences:** three clear products remain; links explain transitions.

## ADR-P002 — Independent identities and persistence
**Status:** existing architecture retained. **Decision:** keep Plan users/passkeys/sessions/labs in its D1 database. **Alternative:** infer shared accounts from parent RP ID or import Runs identities. **Consequences:** sign-in is product-specific; shared SSO requires a later explicit design.

## ADR-P003 — Versioned portable notebook
**Status:** existing architecture retained. **Decision:** support JSON exports and v1/v2 import sanitization. **Alternative:** opaque server-only state. **Consequences:** users can keep portable copies; importing replaces notebook state and does not import authentication credentials.

## ADR-P004 — Record concurrency limitation accurately
**Status:** documented limitation; improvement proposed, not implemented here. **Decision:** describe current save checks as read/check/update, not CAS. **Alternative:** claim `If-Match` alone proves atomicity. **Consequences:** racing writes remain a risk; a future conditional SQL update and concurrency tests should address it.

## ADR-P005 — No telemetry inferred from planning data
**Status:** accepted product boundary. **Decision:** capacity and service health details remain user-entered estimates/notes. **Alternative:** present sketches as measured infrastructure state. **Consequences:** no agent provisioning, network scanning or monitoring is implied by this merge. Aggregate metrics remain separate from notebook contents.
