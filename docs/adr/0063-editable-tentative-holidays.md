# ADR-0063 — Editable + tentative state holidays

Status: Accepted
Date: 2026-06-28
Supersedes / extends: ADR-0038 (state-specific holidays, 2C), ADR-0055 (org-based holiday hierarchy)

## Context

Malaysian state public holidays often shift year to year (ruler birthdays, state lunar observances) and are
gazetted only days ahead. Until this change the holiday calendar supported only `createHoliday` and
`deleteHoliday` — there was **no `updateHoliday`**. To correct a date HR had to delete and re-add, losing the
row's identity (and any audit linkage). There was also no way to load a *provisional* date early: if HR waited
for the gazette, leave/payroll working-day counts for the affected window were silently short until the row
landed (and the #15 completeness guard would warn that the state had fewer than the s.60D minimum loaded).

## Decision

1. **Add `holiday.tentative boolean NOT NULL DEFAULT false`** (migration 0126, additive + backfill-safe;
   existing rows = confirmed). A tentative holiday is HR's best-estimate date for a not-yet-gazetted holiday.
   It **STILL counts as a holiday everywhere** — `holidayDatesFor` (the single resolver behind leave,
   rest-day counting, attendance and payroll) selects only on `holiday_date`, so a tentative row is included
   exactly like a confirmed one. Excluding it would under-count and re-introduce the bug the operator
   reported. The flag is purely a **visible "confirm me" marker** for HR.

2. **Add `updateHoliday(ctx, { id, holidayDate?, name?, tentative? })`** — the missing CRUD op. It validates
   the date format (the same `YYYY-MM-DD` guard as create), cleans the name, loads the before-row (throws if
   missing), updates only the supplied fields, and maps the unique-violation of a moved date colliding with an
   existing one to `DuplicateError` with the same scope-aware message as create. **Scope (country/state/
   companyId) is immutable here** — a scope change remains delete + recreate, to avoid churning the
   single-axis `holiday_scope_excl` CHECK. It appends a `holiday.updated` DomainEvent with `{ before, after }`,
   carrying date + name + tentative + the unchanged scope (mirroring create's scope-in-audit, ADR-0055).

3. `createHoliday` gains an optional `tentative?: boolean` (default false) so HR can add a provisional date
   directly, and `listHolidays` returns `tentative` so the UI can render a badge.

4. **UI** (`app/admin/holidays`): each row gets an inline **Edit** form (date + name + a Tentative toggle)
   wired to a new `updateHolidayAction` (actor passed through from the session); the create form gains a
   Tentative checkbox; tentative rows show a muted **Tentative** badge. This composes with the #15
   completeness guard: HR loads tentative state dates early (clearing the warning) and finalises them when the
   gazette lands.

## Consequences

- No new RLS policy: the holiday table's existing `tenant_isolation FOR ALL` policy (migration 0006, admin
  `WITH CHECK`) already governs UPDATE on the new column.
- Tentative is intentionally NOT a resolver input — leave/payroll behaviour is unchanged for both states of
  the flag. If a future requirement needs "exclude unconfirmed dates from payroll", that is a separate ADR.
- Editing keeps scope fixed; a genuine scope change is still delete + recreate (its own create/delete events).

## Amended 2026-09-11 (def44f29)

Decision 2's "scope is immutable here" and the last consequence above are **reversed for the state axis
only**. The reporter's complaint was exactly the delete-and-recreate this ADR prescribed: the Holidays
screen offered no way to set National / State when adding, and no way to change it afterwards. Now:

- `createHoliday` and `updateHoliday` both take `state` (`undefined` on update = unchanged; `null` or `''`
  = national; a label = that state). A label is validated against the row's country pack
  (`statesForCountries([country])`), on create and on update alike, so a dormant row for a state nobody
  can resolve to cannot be written.
- A row scoped to a business group (`companyId`) or a holiday group (`holidayGroupId`) is **refused** a
  state with a plain sentence. The single-axis `holiday_scope_excl` CHECK is what made immutability cheap,
  and it is kept by narrowing the change to the one axis the screen edits; for those rows, and for a change
  of `country`, delete + recreate still applies (the dialog shows their scope fixed and Country read-only).
- The `holiday.updated` payload's `after.state` is the NEW state (it copied `before.state` until now), so a
  national ↔ state move is readable from the ledger. A move that collides with an existing row is a
  `DuplicateError` naming the target scope.
- UI: the inline row forms of Decision 4 are gone. Add and Edit open one dialog over the list
  (`app/admin/holidays/holiday-dialog.tsx`) with National / State as a dropdown fed from the country pack's
  state list; `createHolidayAction` / `updateHolidayAction` became the value-returning `saveHolidayAction`.
