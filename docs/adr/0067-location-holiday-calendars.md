# ADR-0067 — Configurable Public-Holiday Calendars by Location/Subsidiary

Status: Accepted
Date: 2026-06-29
Feedback: "Configurable Public Holiday (PH) Calendars by Location/Subsidiary"

## Context

Different work locations follow different public-holiday rules: a Sabah site keeps Sabah's holidays, a head
office may add company celebration days, a project site may run a fully hand-managed list that ignores some
national holidays. The system could already vary holidays by **state** (wave 2C), by **company subtree**
(ADR-0055 single-winner org override), and HR could already add/edit individual holidays incl.
editable/tentative ones (ADR-0063). Location master data and a per-employee Work Location field already
existed (ADR-0054). What was missing: a way to **name** a holiday set, label its **kind**, and point a
location at one in a single dropdown.

This is a **thin naming-and-mapping layer over the existing machinery** — NOT a new holiday system. An earlier
draft proposed a new `holiday_calendar` table + a `holiday.calendar_id` scope axis; that was **cut** as
duplicative (it would have rewritten `holiday_uq` and the `holiday_scope_excl` CHECK against seeded gazette
data) and the existing `holiday_group` + company-subtree machinery reused instead.

## Decisions

### (a) A holiday_group with an `archetype` IS a calendar (no new table)
Add `holiday_group.archetype ∈ {standard, extended, custom}` (migration 0135, default `standard` =
backfill-safe). Ad-hoc/custom holiday date rows continue to hang off the existing `holiday.company_id` axis —
zero churn to the `holiday` table, its unique index, or its CHECK.

### (b) Location → calendar mapping
Add `location.holiday_group_id` (`ON DELETE SET NULL`, mirroring `employment.holiday_group_id`). Every
employee whose OPEN assignment points at a mapped location follows that calendar automatically — nothing
per-employee.

### (c) Resolver precedence (the one load-bearing change, `core/holidays.ts holidayDatesFor`)
The employment SELECT additionally fetches the open assignment's `location.holiday_group_id` + that calendar's
archetype/states (a strictly 1:1 join chain — no fan-out). A clean pre-check runs ONLY when the location maps
to a calendar:

```
location.holiday_group_id present?
  ├─ custom   → ONLY the location-calendar's company-scoped ad-hoc rows (NO gazette). A national date the
  │             custom calendar omits is a normal working day for that location's staff.
  ├─ extended → ad-hoc rows ∪ gazette(national ∪ calendar.states)
  └─ standard → fall through (no distinct branch) — calendar.states[] feed the existing Step-2 gazette.
absent (NULL) → existing path, BYTE-IDENTICAL to today.
```

Unmapped locations behave EXACTLY as today (the short-circuit literally does not run). For Standard, a
company that already carries company-scoped ad-hoc holiday rows still triggers the pre-existing ADR-0055
Step-1 single-winner override — that is unchanged behaviour, not introduced here.

### (d) State ↔ calendar conflict — the calendar wins
When a location has BOTH a `state` and a mapped calendar, the calendar's `states[]` are the gazette state
source and `location.state` is ignored (the named calendar is the explicit override). `effectiveHolidayState`
agrees, so attendance and the s.60D completeness guard never disagree.

### (e) s.60D completeness guard stays QUIET for Custom
`effectiveHolidayState` returns `skipCompleteness: true` when the location-calendar archetype is `custom`; a
hand-managed calendar deliberately ignores the public gazette, so the "<11 gazetted holidays" warning would be
false noise on every leave request. Standard/Extended still warn (the gazette still applies). No new
completeness math or event is added — the required behaviour is suppression, not a new warning.

### (f) Delete guard covers location refs
`deleteHolidayGroup` already blocked deletion when an employment referenced a group; it now ALSO blocks (with a
`FOR UPDATE` lock) when a location maps to it. The `ON DELETE SET NULL` FK remains the DB backstop for lost
races only.

## Consequences

- **Frozen attendance is NOT retroactively reclassified** (accepted decision): attendance `dayType` rows are
  frozen at check-in and drive the OT premium class = money. Changing a location's calendar reclassifies only
  FRESH dates; historical frozen rows are accepted as historical. No re-freeze job is built (out of scope).

## Explicitly out of scope (flagged, not built)
- **Leave-policy auto-assignment by location** — a separate, larger mapping; this work is holiday calendars only.
- A per-`companyId` "two ad-hoc sets on the same company distinguished by calendar" axis — speculative; a
  custom/extended calendar draws its ad-hoc rows from the employee's company chain (existing semantics).
