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
| [0049](0049-job-function-partner-roles.md) | Job-function partner roles: additive `payroll_partner` + `performance_comp_partner` beside `hr_admin`, company-scopable, RLS+service gated | Accepted |
| [0051](0051-feedback-loop-closure.md) | Feedback v2: post-deploy refute (deployed → contested, `reopened_count`) closes the loop; bulk review; in-app status dashboard | Accepted |
| [0052](0052-hierarchy-visibility-and-delegation.md) | Hierarchy visibility (recursive manager + HOD) + delegate approver-routing; see≠decide asymmetry | Accepted |
| [0053](0053-employment-review-workflow.md) | Automated probation/contract/internship review: employment_review aggregate, manager→HR state machine, sweep + PDF letter | Accepted |
| [0054](0054-location-master-data.md) | Location master-data + unified state resolver (location.state ?? work_state ?? company default) for leave + attendance | Accepted |
| [0055](0055-org-holiday-hierarchy.md) | Organization-based public-holiday hierarchy: National / State / Business-group scope, group→state→country resolution | Accepted |
| [0056](0056-individual-payroll-transaction.md) | Individual (one-off) payroll transactions: dated, batch-scoped ledger (5 kinds), draft-gated, RLS | Accepted |
| [0062](0062-maternity-allowance-s37.md) | Maternity: separate the unconditional 98-day leave from the conditional paid allowance (EA s.37 qualifying-service + 5th-child); per-request override drives unpaid | Accepted |
| [0070](0070-clocking-locations-geofencing.md) | Clocking locations & geofencing: separate `clocking_location` catalog, tenant-catalog RLS, blocked attempts as domain events (not attendance rows) | Accepted |
| [0079](0079-operator-console-tenant-provisioning.md) | Operator console: request-queue tenant provisioning (owner-role runner), `operator` tier, reveal-once activation link | Accepted |
| [0081](0081-tp1-2026-full-form.md) | LHDN TP1 (1/2026) as a complete e-form: C1–C17 catalogue in the country pack, per-month records, employer consent gating the payroll feed (with backfill), drawn PDF | Accepted |
| [0082](0082-ai-assistant-access-scoped-tool-calling.md) | The AI Assistant (north-star Phase B): read-only tool calling over the governed read layer inside the caller's own session — RLS is the retrieval filter, not a vector store | Proposed |
| [0083](0083-hr-operations-control-plane.md) | HR operations as a control plane: closed-loop automation with graduated per-action agent autonomy; supersedes 0074's operating model (keeps its invariant) | Proposed |

See also: [Malaysia localization — spec mapping & gap closure](../architecture/my-localization.md).
