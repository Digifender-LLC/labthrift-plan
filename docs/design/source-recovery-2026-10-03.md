# Deployed source recovery — October 3, 2026

Before adding portfolio links, the repository was compared with active Cloudflare deployment `5c6fa591-57dd-4302-84b3-147f8c57a2e1`.

This recovery restores the deployed retention toolbar and its `retention-controls.js`, plus the existing deployed authentication source differences: ArrayBuffer-backed WebAuthn byte arrays and uniform invalid-credential responses in the login flow. The recovered source bundles to exactly the deployed Worker (789,342 bytes; SHA-256 `1a4ec59359f0e3ad2aff178db2935cb024bd398042f502272cf98a9dc9b86b62`). These are existing production behaviors, not newly introduced authentication changes.

All 73 known public assets, including the recovered script, were read back. After CRLF normalization and removal of Cloudflare-injected challenge markup, only the restored HTML and previously absent control script differed from the original import. All 21 TypeScript declaration-file differences were line endings. No request-specific Cloudflare markup was copied into source.

Cloudflare readback matched the existing D1 binding, WebAuthn variables, compatibility date/flags and static-asset routing mode. No database migration or account operation was performed. Evidence is in the oversight task's `outputs/labthrift-source-recovery-2026-10-03/`, including exact deployed/rebuilt Worker bundles and public asset inventories.
