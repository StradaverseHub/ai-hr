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

## Implementation contract and pending evidence

Common maintenance consumes database-admin-scoped reads directly, without resolving the company-switcher cookie. Each list has a5,000-row bound and refuses oversized results rather than truncating or counting hidden companies. Workbook organization rows use the same maintenance predicate before bounds; only administered companies or provenance/criteria metadata of visible labels enter company references. Tenant-wide Profile options, grades and grade groups remain separate catalogues.

`setLabelCriteriaBatch` owns complete authorization, loss-of-availability/in-use checks, all final company-set writes, collision validation and audit. A single Criteria save delegates to that owner. Bulk label saves and workbook updates combine text and Criteria within one transaction, with final assertions after the selected batch. Workbook preview compares proposed final scopes, including disjoint-company swaps; it does not add an option that bypasses validation. Origin-company uniqueness remains the existing identifier rule; overlapping availability adds a second collision check.

Recorded assignment company is used for the in-use guard when present, preserving the legacy current-company fallback only for rows without that recorded value. Direct business-unit assignment references are included. Assignment label-reference changes touch the same derived coordination revision and have a deferred company/label tenancy and Criteria check, closing concurrent-reference/removal gaps. The constraint does not rewrite assignment history or infer an effective company from dates. Label ID/tenant/creation company and junction identity cannot be retargeted.

Source regression cases cover explicit origin exclusion, future-company Global visibility, scoped maintenance, complete text/Criteria changes and swaps, nonempty/cross-tenant/refused scope, archived restore, recorded-company in-use references, ordinary competing writers and pinned repeatable-read restart. Existing Excel tests retain actor-bound export history, stale review, blank retention, optional CLEAR, no-op import and row selection; previous Scope/Shared Companies headers convert only in the current bounded compatibility generation. UI tests cover draft prepend/focus/preserved input, staged Criteria, Escape/focus return and refusal without changing saved scope.

Execution remains pending: no test, TypeScript check, migration, application render or browser journey was run during the shared release hold. The required journey is group admin and company admin common workspace → Add Row → Criteria Apply → Save → reopen → export current data → edit Criteria/text → preview → apply → reopen. Include readonly origin rows, empty/no-admin-company state, rejected conflicts, revocation after preview, keyboard, narrow/light/dark and all six locales, then fresh and live-baseline migration rehearsals and the required security/data release gate. Migration0550's journal entry is centrally owned and intentionally not appended by this branch.

New draft ownership defaults are part of the common workspace: a scoped draft follows its first selected administered active company at first Save; a Global draft uses the deterministic active administered-company default. The persisted creation owner never moves with later Criteria changes. Changing a draft owner clears an incompatible draft head selection, and the server independently checks administered active creation ownership and every selected company. Regression sources include a B-only draft payload and subsequent successful B-admin maintenance/refused A-admin edit.

Migration preflight refuses legacy invalid creation tenancy, orphan/cross-tenant polymorphic criteria and overlapping active codes after the explicit-origin backfill. It does not choose a repair, delete or rename records, or silently promote company-specific codes. The exact preflight SQL is exercised by disposable legacy fixtures in source; live legacy state is still UNKNOWN until rehearsal. A refusal requires owner reconciliation before migration, preserving the business decision instead of ignoring a newly visible ambiguity.

Lock ordering is part of the canonical owner contract. `lockLabelCriteriaTx(tx, tenantId)` acquires department, position, cost_center and business_unit epochs in that order before any explicit label row share/update locks. Employee activation must use the seam before locking selected references. Bulk/Criteria/workbook owners use the same seam. Workbook import does not table-lock Criteria/reference/company/employment tables after the epochs: normal INSERT takes a RowExclusive table lock before its BEFORE trigger, which would otherwise invert that order. Non-Criteria Profile/grade/group catalogue locks remain separate. Retained heads outside scoped employee options display “Assigned head — details unavailable”; their identity stays retained without widening employee readership or calling it None. Runtime concurrency evidence remains pending.

Unchanged semantic Criteria is a no-op, including Global rows with retained legacy junctions and company-specific rows whose existing set includes companies outside the origin administrator's grants. Origin-admin text/archive edits therefore retain their existing authority; they neither mutate Criteria nor bypass a change check. New or actually changed Global Criteria still requires group administration, and changed company sets still validate every selected/removing company. Regression sources exercise the owner and workbook paths.
