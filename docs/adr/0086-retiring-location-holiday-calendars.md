# ADR-0086 — Retiring the work-site register, and with it ADR-0067's location→calendar mapping

- **Status:** Accepted (supersedes [ADR-0067](0067-location-holiday-calendars.md) in part)
- **Date:** 2026-09-23
- **Supersedes:** ADR-0067 §(b) and §(c) — the `location.holiday_group_id` mapping and the resolver
  precedence built on it. ADR-0067 §(a) — `holiday_group.archetype` — is **kept and unaffected**.
- **Raised by:** item `0fe1ca2e` (Redesign Clocking Location Workflow), approved 2026-09-23.
- **Deliberately not:** a removal of holiday groups, of per-company holiday overrides, or of
  `clocking_location`. Those survive untouched; see §4.

---

## 1. Why this document exists

ADR-0067 is **Accepted**, dated 2026-06-29, and it is a real capability: a work site can carry its own
public-holiday calendar, so a Sabah site keeps Sabah's holidays without anyone editing an employee.

Item `0fe1ca2e` asks for the work-site register to be removed. **That request revokes ADR-0067 §(b) and
§(c).** CLAUDE.md §1 says to challenge exactly this shape, and §12 says a decision that binds future work
is an ADR — so reversing one inside a UI ticket, silently, is not available. This document is the
reversal, made explicitly and with the measurement that justifies it.

## 2. What was measured, on production, before agreeing

Two read-only reports shipped in r328 and r330 and were run against production on 2026-09-22 and
2026-09-23. Every figure below is from them, not from reasoning:

- **8 `location` rows. All 8 carry a state override. NONE maps a holiday calendar.** So ADR-0067 §(b) —
  the one decision being reversed — is exercised by **zero** rows.
- **1 open assignment** still points at a work site (an earlier plan predicted 2). That employee's
  `employment.work_state` **already** carries the site's state, so their 2026 calendar is identical
  before and after: 12 days, Federal Territory Day included. `NOTHING MOVES 1`, `holidays MOVE 0`.
- Every failure shape the report can name is 0: blocked-by-holiday-group, named-calendar, no-state,
  ambiguous, archived-site. ⚠️ And `EMPTY calendar both sides = 0`, so this is a real all-clear rather
  than the missing-data illusion that guard exists to catch.
- The work-site **criteria axis** is used by nothing: 0 of 10 entitlement rules, 0 of 1 notice, 0 of 20
  generation runs. 0 records to review.

**Unused is not unwanted**, which is why this went back to the reporter as a capability question rather
than a code deletion. They approved the retirement.

## 3. The decision

**The work-site register is removed, and a work site stops being an input to holiday resolution.** The
employee's own `employment.work_state` does that job — it already does, today, for the one employee
concerned.

Concretely, superseding ADR-0067:
- §(b) `location.holiday_group_id` is retired. Nothing maps a calendar through a site any more.
- §(c) the resolver precedence that reads the open assignment's location is removed from
  **both** readers — `holidayDatesFor` AND `effectiveHolidayState`. ⚠️ They move **together**: the second
  feeds the s.60D completeness guard, and `test/holiday-calendar-resolution.test.ts` already asserts the
  two agree on a location-mapped employment. That guard is what makes "together" enforceable rather than
  remembered.
- §(a) `holiday_group.archetype` is **untouched**. Holiday groups remain, and an employment can still be
  assigned one directly via `employment.holiday_group_id`. Only the *site* door closes.

## 4. What deliberately survives

- **`clocking_location` and `employee_clocking_location`.** A different concept (ADR-0070) that merely
  happens to link to a site.
- **The `location` TABLE**, as a bare FK target for `clocking_location.location_id`. The site
  **register** — the screen and its form — is what goes. Dropping the table would force a change to the
  Clocking Location form and its guard (`test/clocking-location-page.test.ts`, `CLOCKING_FIELDS`), which
  r322 settled and which this item has no mandate to reopen.
- **Per-company and per-state holiday resolution**, and ADR-0055's org override. Untouched.
- **History.** `core/movement.ts` records `locationId` in from/to deltas and historical events already
  carry it. Removing the *renderer* would destroy that history, so the renderer stays.

## 5. Consequences

**Good.** One fewer way to answer "which holidays does this person follow", on an axis nobody used. The
`work_state` rung is simpler to keep correct and is already the one in force.

**Costs, stated.** A tenant that later wants per-site calendars must ask for it back, and this document is
what they would be reversing. The capability is not deleted from the product's history — it is retired on
the customer's say-so, recorded here with the measurement that showed it unused.

⚠️ **A silent consequence that must not be silent.** `ASSIGNABLE_ELIGIBILITY_AXES`
(`core/leave-approval-template.ts:504`) is `{companyIds, employmentTypes, gradeIds}` and does **not**
include `locationIds`, so a rule narrowing by work site is REFUSED for approval-template assignment
today. Removing the axis withdraws that refusal. Measured count of affected rules: **0** — but the
withdrawal is real and belongs in the round entry, not in a diff nobody reads.

## 6. Build order

1. The two read-only reports, already shipped and already run (r328, r330).
2. This ADR. Nothing below starts before it is recorded.
3. The resolver change: `holidayDatesFor` and `effectiveHolidayState` **in one commit**, with
   `test/holiday-calendar-resolution.test.ts` and `test/holiday-calendar-coverage.test.ts` **updated with
   the reason** — never deleted (CLAUDE.md §8: a guard pinning a decision you are reversing is updated).
4. The screens: the site register half of `app/admin/locations`. The clocking half stays;
   `admin.locations` is 95 keys × 6 locales and the split must keep the survivors.
   ⚠️ **Addendum 2026-09-24 (639bf4a5, r336) — step 4 WAS INCOMPLETE, and the miss was a live false
   statement.** `admin.locations.stateNote` was deleted as planned, but `admin.locations.pageDescription`
   said the same thing in its own words — *"A location can set a state that overrides the public-holiday
   calendar used by leave and attendance"* — in all six locales, and went on rendering for a fortnight.
   The guard written for this ADR could not have caught it twice over: it matched `stateNote`'s exact
   phrases, and it ran under a translator mocked to echo key names, so no English sentence was on the
   markup it searched. Removed at r336, with the six retired strings quoted in
   `test/work-location-organization-relocation.test.ts` so they cannot return. The screen itself moved in
   the same round — it is `/admin/work-locations` now — and nothing about this ADR's decision changed.
5. The criteria axis, with the approval-template withdrawal recorded.
6. **The migration last**, allocated at the moment of writing from `max(idx)`. ⚠️ Earlier plans
   "reserved" 0477/0478; those numbers are now UNUSABLE —
   `test/migration-journal-ordering.test.ts` asserts a strictly ascending `idx` with no grandfathering.
