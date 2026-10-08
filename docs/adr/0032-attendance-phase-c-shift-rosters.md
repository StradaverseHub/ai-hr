# ADR-0032 — Native attendance depth (Phase C): shift definitions & rosters

- **Status:** Proposed
- **Date:** 2026-06-21
- **Supersedes nothing; extends** ADR-0011 (attendance time engine, Phase A/B)
- **Context tags:** attendance, scheduling, deskless, Chin Hin anchor, payroll integration

## 1. Context

Phase A + B (ADR-0011) are shipped: a deterministic time engine (`core/attendance.ts`) classifies each
day (workday / rest_day / holiday), derives worked + OT minutes, supports correction requests, and feeds
**exact MY statutory OT** into payroll (`prefillOvertimeFromAttendance`, EA 1955 §60/§60A/§60D rates via
`localization/my/payroll.ts`). Compliance flags exist (>104h OT/month, >45h/week).

But the schedule is **one company-wide policy** (`attendance_policy`: workStart/workEnd/break/workingDays,
Mon–Fri 09–18). ADR-0011 explicitly deferred **Phase C: per-employee shift/roster schedules; kiosk/biometric
clocks; timesheet cycles.**

The anchor is **Chin Hin Group — ~4,498 deskless-industrial staff across ~60 entities**, who work **shifts**
(morning/afternoon/night, rotating), not a fixed Mon–Fri office day. Without rosters, the time engine can't
know an individual's expected hours, rest days, or shift, so it can't classify their OT, flag a no-show, or
pay a shift differential. **The shift roster is the foundational gap — it is the per-employee "expected"
schedule the existing time engine must consume.** Everything else (roster-vs-actual, differential pay,
biometric import) builds on it.

## 2. Decision

### 2.1 Data model — shift templates + per-date roster assignments

Two new entities (JSONB extension points per the platform convention):

- **`shift`** — a reusable named shift template (tenant- or company-scoped): `name` (e.g. "Night A"),
  `startTime`, `endTime`, `breakMinutes`, `crossesMidnight` (bool), and an optional **`differential` JSONB**
  (`{ kind: 'percent' | 'flat_hourly' | 'flat_per_shift', value }`) — see §2.4.
- **`roster_assignment`** — the concrete schedule: one row per **(employmentId, shiftDate)** pointing at a
  `shiftId`, OR marked as an explicit **rest day** (`shiftId NULL, isRestDay true`). This is the *expected*
  baseline. A roster is per-date (concrete), not a recurring rule; recurring **patterns** that *generate*
  assignments over a range are a later helper (§3), not a first-class entity in v1.

The roster makes **rest days per-employee** (a date with no assignment / an explicit rest-day row), which
subsumes the hardcoded company-wide Mon–Fri rest-day gap.

### 2.2 Time-engine integration (the core change) — backward-compatible

`deriveAttendance` / check-in / check-out / OT classification will resolve the employee's schedule for a
date in this precedence:

1. **Public holiday** (company holiday calendar) → `day_type = holiday` (overlays — a worked holiday is
   still holiday-OT).
2. **Rostered shift** for that date → `day_type = workday`; scheduled net minutes = shift (end−start−break),
   handling `crossesMidnight`; OT = worked beyond the shift.
3. **Explicit rest day** (roster) or **no assignment on a non-working day** → `day_type = rest_day` (all
   worked minutes are rest-day OT, existing logic).
4. **No roster at all for the tenant** → **fall back to the company `attendance_policy`** (today's exact
   behaviour). So a tenant that never creates a roster is byte-identical to now — the entire change is
   additive and opt-in.

This is the keystone: the roster *replaces the company policy as the per-day schedule input* to the
already-correct OT math, without changing the OT math itself.

### 2.3 Cross-midnight shifts (key design point)

A night shift (e.g. 22:00 → 06:00) spans two calendar dates, but `attendance` is PK'd `(employmentId,
attendance_date)`. **Rule: the attendance row + the roster assignment are keyed to the shift's START date
("business day").** `check_out_at` is a full timestamp that may fall on the next calendar day; worked/OT
minutes are computed across midnight from the timestamps. One row per shift instance. This must be explicit
because the current model implicitly assumes same-day check-in/out.

### 2.4 Shift-differential pay — CONFIGURABLE, NOT statutory

**Statutory boundary (governance: source statutory, never guess):**
- **OT rates are statutory** (EA 1955) and already implemented — Phase C does **not** touch them.
- **Shift / night-shift differentials are contractual employer policy in Malaysia — EA 1955 mandates no
  shift premium.** So a differential is **fully employer-configured** (the `shift.differential` JSONB), never
  a sourced statutory constant. When the roster shows an employee worked a differential shift, payroll
  **prefills a typed pay-component** (the ADR-0025 pay-component system) — exactly mirroring the OT prefill
  pattern. Gated by the existing `TYPED_PAY_COMPONENTS_ENABLED` path.
- **EA 1955 §60C shift-work hours *averaging*** (averaging hours over up to 3 weeks before OT triggers)
  **exists but is NOT implemented in v1** — the per-day OT calc is safe and employee-favourable. If ever
  built, it must be **sourced from the official EA text first** and flagged.
- **EA 1955 §59 one-rest-day-per-week** is a real obligation: the roster builder will **validate** that no
  employee is scheduled with fewer than one rest day in any 7-day window and **flag** violations (a
  compliance warning, not a hard block — managers may have legitimate exceptions to record). The §59
  one-rest-day rule is well-established; the exact rest-day-grouping nuances will be re-checked against the
  EA before the validation ships.

### 2.5 Roster-vs-actual

With the roster as "expected" and `attendance` as "actual", a variance read surfaces: **scheduled-but-absent**
(no-show), **unscheduled-but-present**, **late-vs-shift-start**, **short-hours-vs-shift**. This is the
real-time operational view deskless supervisors need (today the day view shows only actuals).

### 2.6 Biometric / terminal import

Chin Hin's existing biometric terminals export punch logs (CSV). A bridge: an **`attendance_import_batch`**
+ raw-punch ingest → **reconcile** to attendance rows (match by a per-employee terminal/biometric id →
upsert check-in = first punch, check-out = last punch of the shift, respecting cross-midnight). Dry-run +
commit, mirroring the CSV employee importer (#107). This unblocks the first real pay runs before native
clock-in adoption.

## 3. Slice sequence

| Slice | Scope | Depends on |
|---|---|---|
| **C1** | `shift` + `roster_assignment` schema (migration + RLS) + `core/roster.ts` service (shift CRUD, assign/clear roster, rest-day, reads) + substrate events + tests | — |
| **C2** | Time-engine integration — `deriveAttendance`/check-in/out/OT read the rostered shift with company-policy fallback; cross-midnight; **byte-identical when no roster** (compat test) | C1 |
| **C3** | Roster scheduling UI — assign shifts across a date range (roster grid), §59 rest-day warning | C1 |
| **C4** | Roster-vs-actual variance read + view (no-show / late / short) | C2 |
| **C5** | Shift-differential pay — prefill a typed pay-component from differential shifts (mirrors OT prefill); gated | C2, ADR-0025 |
| **C6** | Biometric/terminal CSV import — `attendance_import_batch` + reconcile (dry-run + commit). *Amended by ADR-0096 (r424): file structure mappings; an import adds clockings and never replaces a day; every import is logged.* | C2 |
| **C7** | Attendance-policy admin UI (the existing-but-unexposed policy) + per-employee rest-day surfaced | — |

C1+C2 are the spine (roster drives the engine). C3 makes it usable. C4–C7 are independent depth on top.

## 4. Consequences / risks

- **Scale:** ~4,500 staff × ~30 days = ~135k `roster_assignment` rows/month. Index on `(tenant_id,
  employment_id, shift_date)` + `(tenant_id, shift_date)`; roster reads are date-windowed.
- **Backward-compat is non-negotiable:** no roster ⇒ company-policy fallback ⇒ byte-identical payroll. C2
  ships with a compat test asserting this, like the multi-cycle / typed-component slices.
- **Cross-midnight** touches worked/OT-minute math — the riskiest correctness point; golden-tested in C2.
- **Differential pay rides the gated typed-pay-component path** — off ⇒ no behaviour change.
- **Statutory discipline:** only OT is statutory and untouched; differentials are configured, not sourced;
  §60C averaging deferred + flagged; §59 rest-day is a warning, re-verified before shipping.
- **Substrate:** every shift/roster/import mutation appends a `DomainEvent` (module `attendance`).

## 5. Sources

EA 1955 §59 (rest day), §60/§60A (hours, OT), §60C (shift work), §60D (holidays) — the OT figures are
already sourced in `docs/architecture/STATUTORY-SOURCES.md` §6. Phase C adds **no new statutory rate**;
shift differentials are contractual. Any §60C averaging or §59 grouping nuance must be re-sourced from the
official EA text before implementation.
