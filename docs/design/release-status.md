# Release and evidence status

Baseline authored 2026-10-03. These design documents are source-grounded records and requirements, not proof of deployment.

- ByteRush Runs merge: deployed and live feed/sync verified. Runs D1, checkout and local state removed; Worker/domain/DNS already absent. GitHub deletion is awaiting the CLI delete_repo authorization.
- Plan: independent existing notebook; no runtime change required by the merge. Current design includes a known read/check/update save race; an atomic CAS improvement is proposed separately.
- Main website: independent editorial site and metrics backend. Source guide and surviving link checks remain part of the merge release gate.
- No old Runs user data is imported. Its permanent deletion occurs only after replacement deployment and live sync acceptance.

## Evidence log

See ByteRush’s `docs/design/release-status.md` for the authoritative merge release receipt. Product-specific source baselines are identified in each repository’s documents. Open questions: no formal SLA, quantitative adoption target, or future cross-product SSO design has been approved.

## Preservation check — 2026-10-03

Live Labthrift HTML and first-SSH Markdown returned 200. Plan HTML returned 200 and its unauthenticated lab API returned 401. Local previews on ports 8801 and 8803 returned 200. This repository received documentation changes only; its runtime was not redeployed. The Runs-to-ByteRush retirement did not modify this product’s database, account records or domain.
