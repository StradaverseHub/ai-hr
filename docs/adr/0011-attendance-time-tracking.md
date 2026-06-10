# ADR-0011 — Attendance & time tracking: from punch-clock to a time engine

Status: **Accepted** (Phase A + Phase B implemented) · Date: 2026-06-10

## Context

Our attendance module was deliberately minimal (Slice 3): a per-company policy with two
thresholds (`late_after`, `half_day_before`), one row per employee per day with check-in/out
times and a 4-state status (`present | late | half_day | absent`), an admin day view, and
self check-in on `/me`. Every mutation already appends a domain event (ADR-0006).

The user asked for a deep comparison against Workday-class systems. Capability map of
mature time-and-attendance products (Workday Time Tracking, BambooHR, Deputy):

| Capability | Workday-class | Ours (before) |
| --- | --- | --- |
| Work schedules (expected pattern: hours, breaks, working days; shifts/rosters) | ✅ | ❌ two thresholds only |
| Time entry (web/mobile/kiosk, geofencing, photo) | web + mobile + kiosk | web only |
| Calculation engine (worked hours, break deduction, OT classification, real time) | ✅ | ❌ none |
| Compliance rules + alerts (max hours, OT caps) | ✅ rule engine | ❌ none |
| Approvals (timesheet submit/approve, correction requests) | ✅ routed approvals | ⚠️ correction requests (Phase B); timesheet cycle is Phase C |
| Absence integration (leave/holiday-aware attendance) | ✅ unified "time & absence" | ❌ leave days look "absent" |
| Summaries & payroll feed | ✅ | ❌ OT typed into payroll by hand |

## Malaysian statutory anchors (EA 1955, post-2022 amendment)

- **Normal hours**: max **8 h/day, 45 h/week** (s.60A, reduced from 48 h effective 1 Jan 2023).
- **Overtime multipliers** (s.60A(3), s.60(3), s.60D): **1.5×** hourly rate on a normal
  workday; rest-day work ≤ normal hours pays ½–1 day's wages (monthly-rated) and OT beyond
  normal hours on a rest day pays **2×**; public-holiday work pays an extra ~2 days' wages
  with OT at **3×**.
- **OT cap**: **104 hours/month** (Employment (Limitation of Overtime Work) Regulations 1980).
- Hourly rate derives from the **ordinary rate of pay** (ORP) = monthly wages / 26 / normal
  daily hours.

Sources: the Act text (JTKSM official PDF), Zul Rafique 2022-amendment infographic,
CentralHR / PayrollPanda working-hours guides (fetched 2026-06-10; figures cross-checked
across three sources). Monetization of OT is *not* implemented in this phase — see below.

## Decision — phased, data-first

**Phase A (this ADR, implemented).** Make attendance *compute* instead of just record:

1. **Work schedule on `attendance_policy`**: `work_start` (09:00), `work_end` (18:00),
   `break_minutes` (60), `working_days` (ISO weekday array, default Mon–Fri). One pattern
   per company — shifts/rosters are explicitly out of scope (Phase C).
2. **Day-type classification** at check-in: `workday | rest_day | holiday`, from the policy's
   working days + the holiday calendar (matched on the employing company's country). Stored
   on the row so later policy edits don't rewrite history.
3. **Derived minutes at check-out**: `worked_minutes` (span − full break when the span ≥ 6 h,
   else no deduction — deterministic and explainable) and `ot_minutes` (workday: time beyond
   the scheduled net day; rest day/holiday: *all* worked minutes are OT-class). Stored, and
   carried on the `attendance.checked-out` event.
4. **Leave/holiday-aware day view**: employees without a row show *On leave / Holiday /
   Rest day* (in that precedence) instead of a misleading *Absent*; the view also gains
   Hours and OT columns and a real date navigator (the hardcoded demo date is gone).
5. **Monthly summary** per employee: present/late/half-day/absent counts (absent = elapsed
   working days minus holidays, approved leave, and recorded days — only from the hire
   date), total worked hours, OT hours split by day type, and two compliance flags:
   **OT > 104 h/month** (statutory, red) and **any week > 45 h worked** (indicative, amber —
   the 45 h limit technically binds *normal* hours, so this is a review prompt, not a verdict).

**Phase B (implemented).** Two halves, both shipped:

6. **Correction requests** (`attendance_correction` table). An employee files a proposed
   check-in/out for a day on `/me` ("Fix a missed punch"); an admin or the employee's
   **administrative** manager approves or rejects it from the `/attendance` inbox. Approval is
   not a blind overwrite — the proposed punches run back through the *same* `deriveAttendance`
   rule the live clock uses (day-type classification + worked/OT minutes), then upsert the day
   (`onConflictDoUpdate` on `employment_id, attendance_date`) marked `Corrected`, so a fixed
   punch yields correctly-classified OT that flows to payroll. Self-approval is barred by the
   shared `assertCanDecide` guard (`core/approvals.ts`, extracted so leave and attendance
   enforce one rule); RLS confines the inbox to what the viewer may see. Every step is evented
   (`attendance-correction.requested|approved|rejected`, plus `attendance.amended`).
7. **OT monetization** into payroll: classified OT minutes convert to RM at ORP-based rates
   (ORP = wages / 26; 1.5×/2×/3× by day type; RM4,000 First Schedule gate; EPF excludes OT
   while SOCSO/EIS/PCB include it), exposed as a "pull from attendance" prefill on the batch
   input. Payroll keeps the manual override. Sourced in `STATUTORY-SOURCES.md` §6.

**Phase C (later).** Shift/roster schedules per employee; mobile/kiosk clocks with
geofencing (Expo app phase); timesheet submit/approve cycles.

## Consequences

- Attendance becomes the system of record for *hours*, payroll stays the system of record
  for *money*; the seam between them is explicit (classified OT minutes).
- `attendance_policy` is still company-level — an employee-level schedule override table is
  the obvious Phase C extension and nothing in Phase A blocks it.
- The 6-hour break rule and the week flag are policy simplifications, documented in-code;
  both are conservative (they under-claim OT rather than over-claim).
