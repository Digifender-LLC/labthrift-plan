# Labthrift Plan — Functional Requirements Document

> Baseline: 2026-10-03. Product: Labthrift Plan. Repository: `zemdregon/labthrift-plan`. Source-grounded design baseline; deployment and acceptance evidence is tracked separately in [release status](release-status.md).

## Functional requirements
| ID | Action | Expected behavior |
|---|---|---|
| FR-P1 | Register/login | WebAuthn ceremony creates/validates account session |
| FR-P2 | GET `/auth/me` | Return authenticated identity; reject absent/expired session |
| FR-P3 | GET `/api/lab` | Return only current user’s notebook |
| FR-P4 | PUT `/api/lab` | Sanitize/clamp fields; persist lab; return updated timestamp |
| FR-P5 | Save with stale `updated_at` / `If-Match` | Return 409 with latest lab unless explicit force |
| FR-P6 | POST `/api/lab/import` | Accept legacy/v1/v2 exports; reject unknown schema |
| FR-P7 | GET `/api/lab/export` | Download versioned JSON with timestamp and lab |
| FR-P8 | Passkey management/enrollment | Add/list/revoke through existing authenticated/enrollment flows |
| FR-P9 | DELETE `/auth/me` | Delete that account’s related records and session |
| FR-P10 | Offline navigation/API failure | Show fallback/unavailable state; do not fabricate saved status |

The editable model includes title, inventory, services, checklist flags, closet units/slots/ports, hosts, bill of materials and UPS/power notes. Arrays are capped at 100 items; rack height is clamped to 1–42 units. Known checklist labels/links come from server defaults, with user completion flags applied.

## Runs integration contract
ByteRush may link to Plan and explain its passkeys. It must not PUT to `/api/lab`, import old Runs records, transfer credentials, or infer Plan checklist completion from learning progress. The main website remains the reference guide source for checklist and purchasing links.

## Exceptions
A missing notebook returns 404. Unsupported import schema returns 400. Soft in-isolate session rate limiting returns 429. Offline and authentication failures must remain distinguishable from a successful save. Conflict detection is current read/check/update behavior, not proof against simultaneously racing writes.
