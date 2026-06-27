# ADR-0054 — Location master data (attendance state input)

## Status
Accepted

## Context
The reported feedback asks for a "Location Management" control linked to a business group,
an attendance rule group and a public-holiday mapping, effective-dated, RBAC-gated, feeding
attendance. The platform already ships the substrate this needs:

- **Business group** = `company` (the legal-entity / group tree, ADR-0009).
- **Attendance rule group** = `attendance_policy`, which is **one-row-per-company**
  (`attendance_policy_company_uq`). A same-company location can only ever point at that one
  default, so the rule-group link is satisfied transitively (location → company → its policy).
- **Public-holiday mapping** = `holiday`, keyed by `country` + nullable `state`. `core/leave.ts`
  already resolves `effState = holiday_group → work_state → company.default_work_state` and filters
  `holiday.state` with `(state IS NULL OR state = ANY(states))` (migration `0100_holiday_groups`).

Attendance, however, was **state-blind**: `core/attendance.ts` filtered holidays by `country`
only. So leave and attendance could disagree on a state-specific holiday. The location feature's
only behavioural value is to feed a `state` into attendance; the master-data record is the thing
an admin overrides from.

## Decision
A `location` is **company-scoped master data**: a thin overlay that (a) names a physical site and
(b) supplies an optional `state` override for holiday resolution. Three decisions are recorded:

1. **No new effective-dated table.** The employee↔location link is a nullable `location_id`
   column on the existing effective-dated `assignment` row, versioned by the existing
   CLOSE+INSERT in `core/org.ts:transferEmployee`. History is preserved for free; we do **not**
   add a second bitemporal `employment_location` table.

2. **State resolution is unified across leave and attendance** as
   `location.state ?? employment.workState ?? company.defaultWorkState` (layered on top of the
   already-working `holiday_group → work_state → default` precedence), applied identically in
   `core/leave.ts` and `core/attendance.ts`, so the two engines can never disagree on a holiday.
   `country` continues to come from `company.country` — a location does **not** override country.

3. **Non-goals:** `attendancePolicyId`-on-location (inert under one-policy-per-company),
   geofencing / GPS / `timezone` / `address` / lat-long columns, realtime push / websockets,
   and a native mobile client. A location whose `country` differs from its company is captured
   for display only; the engine continues to use `company.country`.

## Consequences
- Existing employees resolve `location = null`, so the null path is byte-identical to today's
  behaviour (guarded by a golden compat test).
- A `location` carries `archived_at` for soft-disable (the "disable" requirement); we never
  hard-delete so the audit trail survives.
- RLS gates `location` reads **and** writes by `app.is_admin_for(company_id)` so a different-company
  admin can neither see nor edit out-of-scope locations.
