-- 711adcd2 — a pay item gets TWO INDEPENDENT ORP TICK BOXES, so which items feed the overtime and the
-- unpaid-leave ordinary-rate-of-pay base stops being decided by the item's KIND.
--
-- ⚠️ THIS MIGRATION IS THE SAFETY PROPERTY OF THE WHOLE CHANGE. The approved plan's promise is that
-- "nobody's overtime or unpaid leave changes because we installed the switch". That promise is kept here
-- and nowhere else: the columns are backfilled to exactly what the code decided on the day this ran, so
-- the first payroll after the switch is byte-identical and the operator then changes what they choose to
-- change, deliberately. A wrong backfill would silently re-price overtime that has already been paid,
-- which is the same standard core/pay-rule.ts's own header holds a fold's evaluation order to.
--
-- ── WHAT ACTUALLY FEEDS OVERTIME TODAY. MEASURED, and it is NOT one path but two. ────────────────────
--
--  (A) THE STATUTORY ENGINE — core/payroll.ts prefillOvertimeFromAttendance feeds
--      localization/my/payroll.ts overtimePay a `monthlyWages` of
--      `compensation.basic_salary + compensation.monthly_allowance`. Those are COLUMNS on the Personnel
--      compensation record. NO pay item takes any part in it, and this migration does not touch it. Any
--      backfill that tried to reproduce it out of pay items would be reproducing a different store —
--      the two can and do diverge (backfillEmploymentComponentsFromCompensation only MIRRORS one into
--      the other, on demand) — and that is precisely how a switch installed "to change nothing" would
--      have changed live overtime pay.
--
--  (B) A TENANT'S OWN OVERTIME FORMULA — a `formula` pay rule reading the `fixed_allowances` operand,
--      e.g. production's OT1_5: (basic + fixed_allowances) / 26 / 8 * 1.5 * hours. THIS is the path the
--      plan describes, this is the one where "the type decides", and this is the one orp_overtime makes
--      configurable. The operand's membership test is core/pay-rule.ts isFixedAllowanceComponent.
--
-- ── WHAT FEEDS UNPAID LEAVE TODAY: BASIC SALARY, ALONE. ──────────────────────────────────────────────
-- core/payroll.ts computes the deduction as `basicRaw / unpaidDivisor x unpaidDays` — the UNFACTORED
-- monthly basic over a policy-configured divisor. There is no allowance term and no pay item anywhere in
-- that expression, and `fixed_allowances` never reaches it. So the honest backfill for orp_unpaid_leave
-- is FALSE ON EVERY ROW. Ticking any item true here would have RAISED that employee's unpaid-leave
-- deduction on release day, and because the deduction is PRE-statutory (it reduces wagesExOt and
-- hrdfBase) it would have moved EPF, SOCSO, EIS and PCB with it.

ALTER TABLE pay_component ADD COLUMN IF NOT EXISTS orp_overtime      boolean NOT NULL DEFAULT false;
ALTER TABLE pay_component ADD COLUMN IF NOT EXISTS orp_unpaid_leave  boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pay_component.orp_overtime IS
  '711adcd2 - does this pay item count towards the fixed_allowances operand a tenant overtime formula '
  'reads? Replaces ONLY the kind=allowance half of core/pay-rule.ts isFixedAllowanceComponent; the '
  'structural clauses (never BASIC, never statutory, rule null-or-fixed) stay in code because the last of '
  'them is what keeps the aggregate acyclic. Does NOT reach the statutory overtime engine, which is fed '
  'compensation.basic_salary + compensation.monthly_allowance.';
COMMENT ON COLUMN pay_component.orp_unpaid_leave IS
  '711adcd2 - does this pay item join basic salary in the base the unpaid-leave (and equal-by-definition '
  'absence) daily rate is struck from? Backfilled false on every row: today that base is basicRaw alone.';

-- ── BACKFILL (A): orp_overtime = the POLICY half of isFixedAllowanceComponent, exactly. ──────────────
-- kind = 'allowance', minus the two rows the predicate refuses on identity rather than on policy:
--   * BASIC — seeded with kind 'allowance' and no rule, so it satisfies every other clause. Counting it
--     would add basic salary twice to the reporter's own `basic + fixed_allowances` formula. The kernel
--     already treats the BASIC component as inert for the same reason.
--   * a statutory line — kind 'contribution', or one of the reserved codes. Reading a legislated figure
--     into pay through an aggregate is what validatePayRuleAgainstCatalog refuses for a named operand.
-- The THIRD clause of the predicate — rule IS NULL OR rule->>'kind' = 'fixed' — is deliberately NOT
-- written into the flag. It is a structural acyclicity guarantee, not an operator's choice: an item with
-- no dependencies cannot depend on the item that reads the sum. Leaving it in code means an item whose
-- rule is changed fixed -> formula -> fixed behaves exactly as it does today, in both directions, instead
-- of having its membership frozen by whatever its rule happened to be the day this migration ran.
UPDATE pay_component
   SET orp_overtime = true
 WHERE kind = 'allowance'
   AND upper(btrim(code)) <> 'BASIC'
   AND upper(btrim(code)) NOT IN (
     'EPF','EPF_EMPLOYEE','EPF_EMPLOYER','KWSP',
     'SOCSO','SOCSO_EMPLOYEE','SOCSO_EMPLOYER','PERKESO',
     'EIS','EIS_EMPLOYEE','EIS_EMPLOYER','SIP',
     'PCB','MTD','CP38',
     'HRDF','HRDF_LEVY','HRDC',
     'ZAKAT'
   );

-- ── BACKFILL (B): orp_unpaid_leave stays false everywhere. ───────────────────────────────────────────
-- Stated as an explicit no-op statement rather than left to the column default, so the intent is on the
-- record: this is a MEASURED false, not an omission. See the header.
UPDATE pay_component SET orp_unpaid_leave = false WHERE orp_unpaid_leave IS DISTINCT FROM false;

-- REPORT, so the release note can state what was ticked rather than assert that it was right.
DO $$
DECLARE total int; ot int; ul int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE orp_overtime), count(*) FILTER (WHERE orp_unpaid_leave)
    INTO total, ot, ul FROM pay_component;
  RAISE NOTICE '0456 pay_component ORP flags: % rows, % ticked for overtime ORP (= the kind test the fixed_allowances aggregate used before this), % ticked for unpaid-leave ORP (expected 0 — unpaid leave is struck from basic salary alone today)',
    total, ot, ul;
END $$;

-- ── PAYROLL CATEGORY gains "Benefit in Kind (BIK)". ──────────────────────────────────────────────────
-- The reporter's own pairing is Category = Non-Payable with Payroll Category = Benefit in Kind, so the
-- closed vocabulary 0393 wrote has to accept one more word or the selection would be silently coerced to
-- NULL and look exactly like the setting had been ignored — the complaint 0393 itself exists to answer.
-- 0393's constraint is REPLACED rather than added to, because a CHECK cannot be widened in place. This
-- classifies nothing: no row is set to 'bik' here. An operator chooses it, item by item, on the screen.
ALTER TABLE pay_component DROP CONSTRAINT IF EXISTS pay_component_display_category_check;
ALTER TABLE pay_component ADD CONSTRAINT pay_component_display_category_check
  CHECK (display_category IS NULL OR display_category IN
    ('basic','overtime','bonus','allowance','claim','deduction','bik'));
