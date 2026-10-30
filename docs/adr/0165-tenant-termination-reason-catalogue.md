# ADR-0165 — Tenant-owned termination reasons and event-type descriptions

- Date: 2026-10-30
- Status: implementation candidate for approved feedback 1d58019a (Movement Settings Enhancement), Step 1; not release acceptance.

## Context

The exit reasons offered by the Termination event were a fixed TypeScript constant (`core/termination-reason.ts`, ae9350f2), each mapped to the `termination_type` enum that drives the Terminations and Turnover analytics. Its header already named the movement event-type catalogue (476f23ed) as the reasons' eventual owner, and migration 0338 kept `employment.termination_reason_code` as plain text so the list could be repointed without type surgery. The reporter asked for HR to add, rename, switch off and (when unused) delete reasons, under the same three groups, and for an optional description per event type.

## Decision

1. **Owner.** The thirteen shipped reasons stay the starting list in `core/termination-reason.ts`, which remains a pure module for client and workbook code. A tenant overlay table `termination_reason` (migration 0713) records only what a tenant changed: a renamed or switched-off built-in reason, or a reason of its own. `core/termination-reason-catalog.ts` is the single reader and writer. It mirrors `movement_event_type` (0340): a tenant with no rows behaves exactly as before, nothing is seeded, and nothing must be topped up when the shipped list grows. It is a separate module, not part of `core/movement-type.ts`, because the termination writer in `core/org.ts` resolves reasons and `core/movement-type.ts` imports `core/movement`, which imports `core/org`.
2. **Groups are fixed.** Voluntary, Involuntary and Other. They feed the turnover and termination reports; a new group would silently drop those exits. A reason's group is chosen when it is added and is never re-pointed.
3. **Classification has one owner and is derived, never stored.** A built-in reason keeps its shipped mapping however it is renamed (retirement → retired, contract_expiry → contract_end, death → death). A custom reason derives its classification from its group. The table has no `termination_type` column that could disagree.
4. **History keeps its code.** `employment.termination_reason_code` stays text without a foreign key. A switched-off reason still resolves, so history renders and a pending termination still applies. Only a new termination is refused (`assertTerminationReasonOfferedTx`, at the single new-termination call site in `core/movement.ts`). Built-in reasons cannot be deleted. A custom reason that appears in the employment column or the movement ledger cannot be deleted. Catalogue writes take an exclusive per-tenant advisory lock. A movement write resolving a reason takes the shared form, so a delete cannot race a termination that uses the same code.
5. **Permissions.** Viewing the Movement Settings pages and every catalogue write require `super_admin` or `hr_admin` in the service, in addition to `requireAdmin()` on each page. Table RLS lets every tenant member read and only an admin insert, update or delete, with DELETE gated too. Resolving a reason inside a movement write needs no admin role. Every write appends `termination-reason.saved` or `termination-reason.deleted`. `movement-event-type.saved` now carries `description`.
6. **Event-type description.** A nullable `movement_event_type.description` (≤ 1000 characters) is shown under the type on the New Event form. Built-ins get it through their overlay row.
7. **Event-type classification** (Termination or Non-Termination) is derived from the behaviour kind and is read-only in Step 1. Allowing a tenant's own type to carry the Termination behaviour amends 476f23ed's exclusion. That is Step 2 and requires its own owner sign-off.

## Consequences

- Turnover reporting is unchanged: it reads `employment.termination_type`, which is still written at termination time.
- The movement import workbook's reference sheet still lists the built-in reason codes with their shipped labels. A custom code typed into an import row is accepted by the writer, and a switched-off reason is refused there. Listing tenant reasons in the workbook is left to Step 2, alongside the import changes of board item 646355e5.
- Per-event-type reason lists, custom Termination classification, field controls and supporting documents are Step 2.
