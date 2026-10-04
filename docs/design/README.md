# Labthrift Plan design documents

Separate documents cover business intent, product behavior, requirements, and implementation. TDD means **technical design document** here. SDD means **software design description**; ADR is a numbered decision register.

- [BRD — Business Requirements Document](BRD.md)
- [PRD — Product Requirements Document](PRD.md)
- [FRD — Functional Requirements Document](FRD.md)
- [SRS — Software Requirements Specification](SRS.md)
- [TDD — Technical Design Document](TDD.md)
- [SDD — Software Design Description](SDD.md)
- [HLD — High-Level Design](HLD.md)
- [LLD — Low-Level Design](LLD.md)
- [ADR — Architecture Decision Records](ADR.md)

Read BRD → PRD → FRD/SRS for scope; HLD → SDD → TDD/LLD for implementation. ADR records why the boundaries were chosen. Changes to requirements must update their IDs, affected designs, tests, and release evidence together.

The Runs-to-ByteRush merge does not migrate this product’s accounts or database. See [release status](release-status.md) and the [October 4 verification](verification-2026-10-04.md) of roadmap items P01–P05.

[Universal completion roadmap](https://github.com/zemdregon/tech-dose/blob/main/docs/ROADMAP.md) sequences work across all three products, with dependencies, acceptance criteria, and coverage of all 100 numbered requirements.
