# Labthrift Plan — Business Requirements Document

> Baseline: 2026-10-03. Product: Labthrift Plan. Repository: `zemdregon/labthrift-plan`. Source-grounded design baseline; deployment and acceptance evidence is tracked separately in [release status](release-status.md).

## Purpose
Provide a durable personal notebook for a small home lab: equipment, services, rack layout, local hosts, purchase notes and practical checklists. The value is remembering what exists and what needs attention across devices, rather than running infrastructure for the user.

## Business requirements
| ID | Requirement | Observable success |
|---|---|---|
| BR-P1 | Preserve the independent Plan product | Existing notebook and accounts remain accessible |
| BR-P2 | Record equipment and service context | Saved lab reflects inventory, links and notes |
| BR-P3 | Support data portability | Versioned JSON export and compatible import |
| BR-P4 | Keep learning separate from factual lab state | ByteRush completion does not alter Plan |
| BR-P5 | Use aggregate product metrics | Metrics table excludes user IDs, raw IP and UA |

The Runs merge removes a parallel learning product, not this notebook. A ByteRush project may explain Plan and link to it, but does not import Runs data, register a Plan account, or mark Plan’s checklist complete.

## Stakeholders and constraints
The owner needs reliable save/conflict feedback, passkey access and an escape path through exports. The maintainer operates an existing Worker and D1 database with no new infrastructure required by the merge. No subscription, commercial SLA, purchasing integration or automatic equipment discovery is assumed.

## Risks and acceptance
Passkey loss and confusing account boundaries can lock users out. The current save conflict check detects stale submitted versions but is not a fully atomic CAS; document this as a known limitation rather than claiming concurrency safety. Preservation acceptance requires the existing app shell, authentication boundary and lab API to remain healthy after Runs retirement. No change to Plan storage or authentication is authorized as a necessary part of the learning merge.
