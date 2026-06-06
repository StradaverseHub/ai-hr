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

See also: [Malaysia localization — spec mapping & gap closure](../architecture/my-localization.md).
