# ADR-0001: Bitemporal effective dating on the organizational core

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** Founder (solo) + Claude (acting architect)

## Context

HR data is almost entirely *effective-dated*. An employee's department, manager,
position, and status all change over time, and the system must answer two distinct
questions:

1. **Valid time** — "What was true on date *X*?" (e.g. who reported to whom on 1 Jan)
2. **Transaction time** — "What did we *believe* was true on date *X*, as of when we
   looked?" (e.g. a salary correction back-dated to last month → retroactive payroll)

Mutable, current-state-only rows make both questions unanswerable and destroy audit
history. This cannot be retrofitted: once history is overwritten, it is gone.

## Decision

1. Model the organizational core as **effective-dated versions** (valid time), not
   mutable rows. Temporal entities carry `valid_from` / `valid_to` (a half-open range;
   `valid_to = NULL` means "open / current"). A change closes the current version and
   inserts a new one — we never `UPDATE`-in-place the business attributes.
2. Satisfy **transaction time** in Slice 0 via the append-only domain-event log
   ([ADR-0006](0006-event-and-audit-substrate.md)) plus a `recorded_at` / `superseded_at`
   stamp on each version, rather than full SQL:2011 system-versioned tables.
3. **Adopt full bitemporal system-versioning when the payroll slice lands** — retroactive
   payroll is the feature that truly requires range-vs-range bitemporal queries, and
   payroll is deferred.

> The unretrofittable part (valid-time history) is in from commit #1. The expensive part
> (full system-versioning) is added exactly when a feature needs it. This is a scope
> decision, not corner-cutting.

## Consequences

- (+) Any past org/assignment state is reconstructable ("as-of" reads).
- (+) Future-dated changes are natural (insert a version with a future `valid_from`).
- (+) Audit and corrections have a basis.
- (−) Every read of "current" state must filter by the valid range — queries are more
  complex, and we need helper views / query builders. Drizzle ([ADR-0005](0005-tech-stack.md))
  is chosen partly to keep this honest.
- (−) Developers must internalize "close + insert," never "update." Enforced by code
  review and by `UPDATE` being restricted to the temporal-bookkeeping columns.

## Alternatives considered

- **Mutable current-state + a generic audit table.** Rejected: cannot do future-dated
  changes or correct as-of queries; audit tables drift from the real schema.
- **Full bitemporal (both axes as ranges) from day one.** Rejected for Slice 0 as
  premature: significant query/maintenance cost for a feature (retro payroll) that is
  deferred. Direction is preserved (see decision #3).
