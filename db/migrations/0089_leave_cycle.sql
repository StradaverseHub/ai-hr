-- ADR-0040 2D-2: per-company earned-accrual cycle. 'calendar' (default, = the 2D-1 behavior: the
-- 1 Jan–31 Dec leave year) or 'anniversary' (each employee accrues relative to their hire-month
-- anniversary). Additive + defaulted, so every existing company keeps the calendar cycle and nothing
-- regresses. Only earned (earned_monthly / earned_quarterly) policies read it; lump-sum is unaffected.
ALTER TABLE company ADD COLUMN leave_cycle text NOT NULL DEFAULT 'calendar';
