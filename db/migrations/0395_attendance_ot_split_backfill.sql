-- 7c834696 STAGE 1 — backfill the new per-rate overtime columns for history.
--
-- ── WHAT THIS WRITES, AND WHAT IT REFUSES TO TOUCH ───────────────────────────────────────────────────
-- It writes SIX columns, all of them added by 0394 and read by nothing before this release:
--   ot_flat_minutes, ot00_minutes, ot10_minutes, ot15_minutes, ot20_minutes, ot30_minutes
-- It does NOT write worked_minutes, does NOT write ot_minutes, does NOT write status, day_type, punches
-- or any deduction column. `ot_minutes` remains the canonical total that payroll, the overtime report and
-- the TOIL register read; this migration only says HOW that same total is split, and the split it writes
-- always sums back to it.
--
-- ── WHY THE SPLIT IT WRITES IS PROVABLY A NO-OP ON WHAT ANYONE SEES ──────────────────────────────────
-- Before this release the two Records screens split a day at READ time, in core/attendance-derive.ts
-- otByRate: the whole day's ot_minutes was routed by the FROZEN day_type — workday to the 1.5 column,
-- rest_day to 2.0, holiday to 3.0 — with normal-within-schedule shown in the 1.0 column. The CASE
-- expression below is that same routing, expressed in SQL. So for every historical row the stored split
-- equals the number the screen was already showing, and the release cannot change a single displayed
-- figure. (`ot10_minutes` is 0 here on purpose: the 1.0 column on screen is NORMAL hours, which is
-- derived from worked_minutes − ot_minutes and is not stored. Stored buckets are OVERTIME only.)
--
-- What this migration deliberately does NOT attempt: re-deriving history through the configured OT BANDS
-- of tenants that have them. That is a genuine re-derivation, it needs the resolved shift and rule per
-- (employee, date) — which SQL cannot resolve — and it MOVES minutes between rate columns for real people.
-- It is held until the production count of banded rules and affected days has been reported. Leaving it
-- out is the conservative choice: banded tenants keep the split they see today until someone decides
-- otherwise, and new days from this release forward use the configured bands.
--
-- ── LATENESS / EARLY-OUT / UNDER-HOURS ARE NOT BACKFILLED, AND THAT IS THE POINT ─────────────────────
-- late_minutes, early_out_minutes and under_minutes need the shift that was in force on the day (start
-- time, end time, grace, the paired rule), none of which is reachable from a single UPDATE. They stay
-- NULL for history and are rendered as "—" rather than as a confident 0. The two DEDUCTION columns are
-- not backfilled either, and never will be: a deduction invented for a closed period takes money off
-- someone retroactively. Deductions only ever exist for days on/after a rule's deductions_effective_from.
--
-- ── RE-RUNNABLE ──────────────────────────────────────────────────────────────────────────────────────
-- The WHERE clause only fills rows where every one of the six columns is still NULL, so running this
-- again is a no-op and it can never overwrite a figure the engine has since computed for a live day.
-- Rows with a NULL ot_minutes (an open day with no clock-out) are skipped: there is no total to split.
--
-- No GRANT / no RLS change: this is a data statement against an existing, already-granted, already-policied
-- table.

UPDATE "attendance" SET
  "ot_flat_minutes" = 0,
  "ot00_minutes"    = 0,
  "ot10_minutes"    = 0,
  "ot15_minutes"    = CASE WHEN "day_type" = 'rest_day' OR "day_type" = 'holiday' THEN 0 ELSE "ot_minutes" END,
  "ot20_minutes"    = CASE WHEN "day_type" = 'rest_day' THEN "ot_minutes" ELSE 0 END,
  "ot30_minutes"    = CASE WHEN "day_type" = 'holiday'  THEN "ot_minutes" ELSE 0 END
WHERE "ot_minutes" IS NOT NULL
  AND "ot_flat_minutes" IS NULL
  AND "ot00_minutes"    IS NULL
  AND "ot10_minutes"    IS NULL
  AND "ot15_minutes"    IS NULL
  AND "ot20_minutes"    IS NULL
  AND "ot30_minutes"    IS NULL;
