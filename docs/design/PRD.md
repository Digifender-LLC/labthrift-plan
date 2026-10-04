# Labthrift Plan — Product Requirements Document

> Baseline: 2026-10-03. Product: Labthrift Plan. Repository: `zemdregon/labthrift-plan`. Source-grounded design baseline; deployment and acceptance evidence is tracked separately in [release status](release-status.md) and the [October 4 verification](verification-2026-10-04.md); remaining work is tracked in the [universal completion roadmap](https://github.com/zemdregon/tech-dose/blob/main/docs/ROADMAP.md).

## Product scope
Plan is a personal lab notebook at configured host `plan.labthrift.com`. It is distinct from ByteRush’s learning feed and the editorial website. Users identify themselves with a username and passkey; email recovery is not part of the current experience. Passkeys use the shared `labthrift.com` RP ID, so a device may offer a Plan passkey on other Labthrift apps, but Plan accounts, sessions and notebooks live only in Plan’s database and are not signed in elsewhere.

## Product requirements
| ID | Requirement |
|---|---|
| PR-P1 | Maintain one private lab per user |
| PR-P2 | Edit equipment, services, checklist, rack slots, ports, hosts and purchase notes |
| PR-P3 | Show resource/power estimates as user-entered planning data |
| PR-P4 | Autosave with visible save/error/conflict states |
| PR-P5 | Import/export versioned JSON |
| PR-P6 | Manage passkeys and enroll another device using existing flows |
| PR-P7 | Show an honest offline state without inventing a session |
| PR-P8 | Preserve independent data ownership during the Runs merge |

## Journeys
The owner signs in, names the lab, records an old PC and its resources, associates services, sketches rack placement, and exports a portable copy. A second device loads the account notebook; a stale save should show a conflict for user resolution. A beginner arriving from ByteRush’s Plan walkthrough sees instructions explicitly labeled for Plan and starts or signs into Plan separately.

## Exclusions
No lesson feed, XP, project reward migration, automatic server provisioning, real power telemetry, or automatic inventory discovery is included. Service URLs and capacity numbers are notes, not verified health. The Runs retirement must not delete Plan’s Worker, D1, domains, passkeys or notebook contents.

## Acceptance
Check notebook loading/saving, export/import validation, last-passkey protection, conflict messaging and offline fallback using disposable test data when testing changes. The current merge calls for preservation smoke checks, not claims that every Plan feature was newly retested.
