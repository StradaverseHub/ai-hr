# Architecture Decision Records

Each ADR records one load-bearing decision: its context, the decision, consequences,
and the alternatives we rejected. ADRs are immutable once *Accepted* — to change a
decision, add a new ADR that supersedes the old one.

| # | Decision | Status |
|---|---|---|
| [0001](0001-bitemporal-effective-dating.md) | Bitemporal effective dating on the org core | Accepted |
| [0002](0002-multitenancy-rls.md) | Multi-tenancy via `tenant_id` + Row-Level Security | Accepted |
| [0003](0003-organizational-model.md) | Org/identity model + typed reporting graph | Accepted |
| [0004](0004-authorization.md) | Authorization: RBAC + ABAC enforced in the DB | Accepted |
| [0005](0005-tech-stack.md) | Tech stack: Postgres, Drizzle, Next.js monolith, WorkOS | Accepted |
| [0006](0006-event-and-audit-substrate.md) | Append-only domain-event & audit substrate | Accepted |
| [0007](0007-ai-native-architecture.md) | AI-native architecture & the self-improvement loop | Accepted (deferred impl) |
| [0008](0008-localization-packs.md) | Localization via installable country packs (MY first) | Accepted (pack built incrementally) |
| [0009](0009-multi-company-group-model.md) | Multi-company group model (nested entities, scoped authz, consolidation) | Accepted (built in slices A–D) |
| [0010](0010-statutory-compliance-reporting.md) | Statutory & compliance reporting (per-company filings, two output layers) | Proposed |
| [0011](0011-attendance-time-tracking.md) | Attendance time engine (work schedules, day-type classification, OT, corrections) | Accepted (Phase A + B) |
| [0012](0012-employee-self-service.md) | Employee self-service: read-write profile with an approval gate | Accepted (Phase 1 + 2) |
| [0013](0013-performance-talent-management.md) | Performance & talent management: cycle-anchored, closes the loop into pay | Proposed (design only) |
| [0014](0014-pcb-accumulators.md) | PCB accumulators derived from payslip history + TP3 opening balances | Accepted |
| [0015](0015-domain-event-subject-scoping.md) | Subject-scoped reads on the domain-event log (close tenant-wide leak) | Accepted |
| [0016](0016-ui-internationalization.md) | UI internationalization: cookie-scoped next-intl, English fallback, export/import matrix | Accepted (full extraction, 6 langs) |
| [0017](0017-knowledge-base.md) | Knowledge Base: tenant-shared doc repository (articles + files) + seeded module guides | Accepted |
| [0018](0018-system-user-onboarding.md) | System-user onboarding: first-login spotlight tour, role-aware, replayable | Accepted |

See also: [Malaysia localization — spec mapping & gap closure](../architecture/my-localization.md).
