# Labthrift Plan — Technical Design Document

> Baseline: 2026-10-03. Product: Labthrift Plan. Repository: `zemdregon/labthrift-plan`. Source-grounded design baseline; deployment and acceptance evidence is tracked separately in [release status](release-status.md).

## Scope of the current change
Document and preserve Plan while Runs learning moves into ByteRush. No Plan schema migration, account import or inventory synchronization is part of this merge. The existing notebook remains the authority for its user-entered lab data.

## Current technical design
Hono middleware adds security headers and applies a soft session bucket. Auth routes perform WebAuthn registration/login, session management, enrollment and passkey operations. `requireUser` resolves a valid session to a user; lab routes operate on that user ID. `clampLab` applies defaults and field sanitizers before writes.

Lab save concurrency uses a supplied `updated_at` field or `If-Match` header. A mismatched version returns 409 unless the request explicitly sets force. The deployed implementation reads the version before a separate unconditional user-bound update, leaving a race between concurrent writers. Roadmap P05 converts this to a conditional update with strictly increasing versions (ADR-P006, LLD save sequence); it is a separate reliability change that takes effect only when that branch is merged and deployed.

## Import/export
Export wraps the notebook with schema version 2, timestamp and username. Import accepts absent legacy version or versions 1–2, sanitizes the body and replaces the current notebook. Unknown future versions are rejected to avoid silent loss. Imports are explicit replacement operations and require clear UI semantics.

## Proposed integration rule
Use ordinary links from learning content and keep authentication language product-specific. Do not copy Runs passkeys into Plan or treat the parent RP domain as SSO. Any future connection would require ownership mapping, consent, conflict semantics and failure recovery.

## Validation and rollout
Contract checks live in `tests/` and run with `npm test` against a disposable local D1 (see the README). The [October 4 verification](verification-2026-10-04.md) records P01–P05 results and the defects they found. A release that changes runtime code needs those checks green, a deploy without migrations, and a live smoke with a disposable account. Do not deploy unchanged Plan code solely to document it. Record known reliability limits and distinguish existing behavior from future proposals.
