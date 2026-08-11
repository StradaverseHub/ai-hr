-- 2aed39d4 — Fixed Transaction: no two LIVE rows for the same employee + pay item may cover the same day.
--
-- ⚠️ RUN THE DATA REPAIR FIRST. `scripts/repair-fixed-transaction-overlaps.ts --apply` MUST have run
-- against this database before this migration. Two separate failure modes are waiting otherwise, and
-- neither is a conflict message:
--   1. any live row with valid_to < valid_from aborts the ALTER outright with
--      `ERROR: range lower bound must be less than or equal to range upper bound` — the daterange
--      CONSTRUCTOR raises before the exclusion operator is ever consulted. Production carries exactly one
--      such row (EMP-0001 ALLOWANCE 200.00, valid_from 2026-01-31, valid_to 2026-01-06, written
--      2026-06-29 before the 34cc8137 guard existed). The repair clears it first, deliberately;
--   2. the 10 overlapping pairs measured on production 2026-08-11 each raise
--      `conflicting key value violates exclusion constraint`.
-- Both were reproduced locally against PostgreSQL 16.14 before this file was written.
--
-- WHY '[]' AND NOT '[)' — THE ONE LINE NOT TO COPY FROM THE PRECEDENTS. `compensation_no_overlap`
-- (0004) and `employee_cp38_no_overlap` (0117) are the same shape with HALF-OPEN bounds, because
-- `compensation.valid_to` is EXCLUSIVE. `employment_pay_component.valid_to` is INCLUSIVE: the payroll
-- kernel selects `valid_from <= periodEnd AND (valid_to IS NULL OR valid_to >= periodStart)` and pays
-- each returned row its FULL amount for that period, so a row ending 2026-07-01 and a row starting
-- 2026-07-01 BOTH pay in July. Half-open bounds would call that pair legal — it is the exact pair that
-- reached issued payslips before 34cc8137, and it is what this constraint exists to make impossible.
-- The asymmetry is documented at core/pay-components.ts (the supersession-close note). Verified:
--   daterange('2026-01-01','2026-07-01','[]') && daterange('2026-07-01','9999-12-31','[]') -> true
--   daterange('2026-01-01','2026-07-01','[)') && daterange('2026-07-01','9999-12-31','[)') -> false
--
-- WHY COALESCE AND NOT A NULL UPPER BOUND. A NULL upper bound makes daterange UNBOUNDED-above, which is
-- what we want semantically (an open row runs forever) — but `daterange(valid_from, NULL, '[]')` is an
-- error in Postgres ('[]' cannot be applied to an infinite bound). The sentinel gives the same meaning
-- with a bound the '[]' constructor accepts; it canonicalises to [.., 10000-01-01), well inside `date`
-- range. Two open rows for the same item therefore conflict, which is correct and is tested.
--
-- WHY run_type (Payroll Cycle) IS NOT IN THE KEY. The reporting ticket asked for employee + pay item +
-- period + Payroll Cycle. The kernel never reads run_type — it selects on employment, component and the
-- date window only, and pays every returned row in full — so two rows differing only by cycle both pay,
-- in every run. Including it would have LEGALISED 2 of the 10 clashes measured on production. Stated
-- above the dashed line in the approved plan with a reject-and-say-so escape; the reporter approved it.
--
-- Keyed on employment + component and NOT on tenant: employment_id already implies the tenant (FK), and
-- two DIFFERENT pay items with identical windows must stay legal — that is a normal employee.
--
-- No GRANT here: this adds a constraint to an existing table and creates no new object to grant on.
-- btree_gist (needed for the two uuid `WITH =` columns) is installed by 0001.
ALTER TABLE employment_pay_component ADD CONSTRAINT employment_pay_component_no_overlap
  EXCLUDE USING gist (
    employment_id WITH =,
    component_id WITH =,
    daterange(valid_from, COALESCE(valid_to, DATE '9999-12-31'), '[]') WITH &&
  ) WHERE (superseded_at IS NULL);
