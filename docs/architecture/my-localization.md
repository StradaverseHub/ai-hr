# Malaysia localization — spec mapping & gap closure

Maps the single-company Malaysia HRMS requirements spec onto the platform as an installable
**country pack** ([ADR-0008](../adr/0008-localization-packs.md)). **Additive only** — nothing
in the existing plan is removed.

## Generic core vs. Malaysia pack — the boundary

| Capability | Generic core (jurisdiction-neutral) | 🇲🇾 Malaysia pack |
|---|---|---|
| Employee identity | Person / Employment / Assignment / Position; employment type; dates; designation *(have)* | **Statutory profile**: IC (unique), EPF#, SOCSO#, Tax#, EIS-eligible + validation |
| Compensation | Effective-dated salary + allowances **(new, generic)** | — (amounts are tenant data) |
| Employee code | Per-tenant sequence generator **(new, generic)** | — |
| Attendance | Check-in/out, daily record, status states, thresholds (config), lock-after-payroll **(new, generic)** | Public-holiday calendar (data) |
| Leave | Types + entitlement as **data-driven rules**; request/approve/ledger *(have)*; weekend/holiday exclusion **(new)** | Leave catalog + **EA-1955** entitlement rules + MC/attachment rules |
| Payroll | Batch + payslip + calc pipeline + proration + draft→processed→closed **(new, generic kernel)** | **EPF / SOCSO / EIS / PCB / OT** calculators (code) + rate tables (data) |
| Holiday calendar | Calendar mechanism **(new, generic)** | MY public holidays (data) |

## Spec → schema mapping

**Employee Master** → `person` + `employment` + `assignment` (+ new: comp record, MY
statutory profile, employee-code sequence).
- "Employment Type: permanent/contract/probation/part-time" → our `employment_type`
  (full_time/part_time/contract) **+** `assignment.status='probation'`. *Permanent* = a
  confirmed employment; *probation* is a status, not a type.
- "Confirmation Date" → an **effective-dated** status change `probation → active` (bitemporal),
  not a flat column.
- "Resignation Date / Status=resigned" → `employment.terminatedOn` + status.
- "Basic Salary" → **effective-dated comp record** (new), not a field on the employee.
- IC / EPF# / SOCSO# / Tax# / EIS-eligible / bank details → **`employee_statutory_my`**
  (pack-owned, typed, IC unique).

**Attendance Record** → **new generic attendance module** (`attendance`): one row/employee/day,
check-in/out, status (present/late/half-day/absent) from configurable thresholds, immutable
once the period's payroll batch is processed. MY pack supplies the public-holiday calendar.

**Leave Application + Entitlement** → our leave model + new **data-driven** leave-type catalog
and entitlement rules; MY pack supplies EA-1955 rules (annual 8/12/16 by service; sick 14/60;
maternity 98; paternity 7), MC-required-for-2+-days, and weekend/holiday exclusion in the
day-count.

**Payroll Batch + Payslip** → **new generic payroll kernel** (batch, payslip, gross→net
pipeline, proration, batch lifecycle) that calls the MY pack's statutory calculators for every
contribution line.

**The 4 APIs** (check-in, check-out, leave-balance query, generate-payslips) → service methods
+ server actions over the above (each appends a domain event, per [ADR-0006](../adr/0006-event-and-audit-substrate.md)).

## Retained platform capabilities (beyond this spec)

The spec is single-company and excludes these; **we keep them** — they are the platform, and
they are what make the pack model and the multi-country path work:
multi-tenant, multi-company, **bitemporal history**, matrix reporting + org chart, the
event/audit substrate, RLS, and the AI-native roadmap.

## Malaysia pack contents (`localization/my`)

- **Statutory profile**: schema + validators (IC unique, EPF#, SOCSO#, Tax#, EIS-eligible).
- **Leave**: type catalog + EA-1955 entitlement resolver + MC rules.
- **Holiday calendar**: MY federal + state public holidays (effective-dated data).
- **Payroll calculators**: EPF (employee 11%, employer 12–13% by bracket), SOCSO (PERKESO
  bands), EIS (0.2% / 0.2%), **PCB/MTD** (LHDN schedule), overtime (1.5× / 2× / 3×; hourly =
  basic ÷ 26 ÷ 8).
- **Defaults**: late + half-day thresholds.

## Build sequence (additive slices)

1. **Comp + statutory profile** — effective-dated salary (generic) + `employee_statutory_my`
   + employee-code generator; extend the People UI.
2. **Leave upgrade** — data-driven leave types + EA-1955 entitlement pack + holiday calendar;
   weekend/holiday-aware day-count.
3. **Attendance** — generic attendance module + MY holidays.
4. **Payroll** — generic kernel + MY statutory calculators. Do EPF/SOCSO/EIS first; **PCB/MTD
   last and carefully** (authoritative LHDN tables + human verification — compliance liability,
   per [ADR-0007](../adr/0007-ai-native-architecture.md)).

## Risks

- **PCB/MTD & SOCSO bands**: need current, authoritative LHDN/PERKESO tables; treat as
  compliance-critical (provenance + human verification). Rates change yearly → effective-dated.
- **Attendance ↔ payroll lock**: the "records immutable after payroll processed" rule couples
  the two modules; model the period-lock explicitly.
