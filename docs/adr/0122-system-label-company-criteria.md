# ADR-0122: One Criteria owner for System Labels availability

**Status:** Accepted direction — approved board item6d26c915,2026-10-15. Implementation and verification pending.
**Date:** 2026-10-15
**Deciders:** Reporter-approved plan; implementation owned by the board integration task.

## Context

Company sharing flags, implicit origin access and explicit per-code Criteria currently compete. The approved request removes sharing switches and the page company dropdown, makes Global available in future companies automatically, and preserves scoped codes and administrator boundaries. A UI-only deletion would leave runtime pickers and write validation inconsistent.

## Decision

A label owns either Global availability or a nonempty explicit company set. Creation company remains provenance and the existing write-ownership boundary. It grants no implicit availability after migration0550. Existing scoped rows receive explicit origin assignment before switching consumers. Global is evaluated directly, independent of legacy company flags; adding a company requires no backfill. Existing company flag data stays intact for compatibility but is not a capability or configuration owner.

SQL readers, canonical writers and client narrowing consume this same rule. Client rows carry explicit assigned company IDs; they never reconstruct availability from origin. Maintenance uses administered companies rather than the current company switcher. Company administrators cannot create Global criteria, alter a Global scope, assign inaccessible companies or remove another company's scope. Domain owners refuse removal of in-use criteria. The database validates polymorphic label/company tenancy, nonempty scoped criteria and active code/name collisions in overlapping availability.

A complete Criteria change is atomic. UI edits are staged until Apply, including Global toggling, so a failed company change cannot leave a partially changed scope. New rows default to Global only for group administrators; other administrators receive an explicit allowed company. Add Row prepends and focuses its first field, independently of current filtering and sorting, while preserving unsaved rows.

All criteria/code writes touch one derived tenant/kind coordination revision inside the same transaction. This row contains no business facts or permissions. It serializes ordinary writers and makes a stale repeatable-read writer fail rather than validate overlaps against an old snapshot. Deferred constraints validate final transaction state, allowing a complete company-set replacement without a transient empty-set failure. It is not an application-writable proof of authorization; ordinary RLS and group/owner checks remain necessary.

## Options considered

| Option | Complexity | Consequence |
| --- | --- | --- |
| Hide controls and retain sharing flags | Low | Rejected: hidden configuration still changes runtime behavior. |
| Keep origin as implicit availability | Moderate | Rejected: Criteria cannot independently exclude creation company. |
| Explicit Criteria with a derived concurrency revision | Moderate | Selected: one availability rule and serialized overlap validation. |
| Advisory locks alone | Low | Rejected for the database backstop: they serialize timing without refreshing an already pinned repeatable-read snapshot. |

PostgreSQL documents that a repeatable-read transaction cannot update a row changed since its snapshot and must retry after serialization failure. That is the basis of the coordination revision, not a claim that a source review proves runtime correctness. [PostgreSQL16 transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html). Deferred constraint trigger behavior follows [PostgreSQL16 CREATE TRIGGER](https://www.postgresql.org/docs/16/sql-createtrigger.html).

## Consequences and required verification

Existing global and scoped values/history remain; a changed overlapping code is refused rather than merged or overwritten. Global availability may reveal preexisting naming conflicts that previously depended on flags; preserve records and expose a safe correction requirement rather than deleting or renaming them automatically. Legacy sharing mutation entry points are retired. Scoped removal from a creation company becomes possible only after explicit criteria and in-use checks pass.

Verify old flag states, existing implicit origin/junction/global rows, future companies, explicit exclusion of origin, empty sets, stale edits, concurrent ordinary/repeatable-read writes, collisions, archived restore and cross-tenant polymorphic links. Compare maintenance, hire, Personnel/import, delegations, Attendance/Allowance and Payroll pickers against the same rule. The System Labels Excel workflow must preserve complete criteria, actor/scope/staleness checks, blank retention and no-op behavior. Walk actual save/reopen and Excel round trips, including company/group/employee roles, six locales, keyboard/mobile/light/dark and runtime logs. Fresh/live-baseline migrations and the classifier-required security/data gate remain prerequisites; no execution evidence is claimed by this ADR.
