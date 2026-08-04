-- 3c473773 — pay_component gets a PAYROLL CATEGORY, so which box a pay item prints in stops being
-- inferred from its tax treatment.
--
-- THE DEFECT, REPRODUCED ON PRODUCTION. Employee X000001's July payslip shows Overtime RM0.00 and Bonus
-- RM10.00 for an amount entered against the Overtime 1.5 pay code. The pay code is NOT misconfigured: it
-- declares pcb_remuneration_type = 'additional', which is correct — overtime paid in arrears IS additional
-- remuneration for LHDN. core/payroll.ts earningsOf had no separate notion of a display box, so it derived
-- one from the PCB stream: 'normal' printed as wages/allowance, 'additional' printed as Bonus. A tax
-- question was answering a presentation question.
--
-- WHAT THIS COLUMN IS, AND EMPHATICALLY IS NOT. It decides where an amount is DISPLAYED. It does not
-- decide, influence or reach any statutory base. The kernel's cash buckets (wage / ot / bonus / reimburse /
-- deduct) still drive EPF, SOCSO, EIS, PCB and HRDF exactly as before; the stored payslip columns
-- (basic_salary, allowance, overtime_pay, bonus) are unchanged; and the EA / CP39 / KWSP / PERKESO readers
-- deliberately do NOT read this column, because those groupings are defined in law rather than by an
-- operator's preference. Re-routing the kernel bucket instead would have moved money between statutory
-- bases and changed what is filed — i.e. corrupted payroll that is currently correct.
--
-- THE BACKFILL IS VISUALLY BYTE-IDENTICAL, ON PURPOSE. Every existing row is set to the box it prints in
-- TODAY, reproducing core/payroll.ts earningsOf's own precedence, in order:
--
--   1. kind = 'deduction'                        -> deduction   (earningsOf's first branch)
--   2. is_non_payable / kind = 'non_payable'     -> LEFT NULL   (record-only line; it has no cash box)
--   3. code = 'BASIC'                            -> basic       (inert in the engine; the Basic line)
--   4. pcb_remuneration_type = 'optional_deduction' -> allowance (paid untaxed via the reimburse bucket,
--                                                                 which prints on the Allowances line)
--   5. epf_bonus_2012 OR pcb_remuneration_type = 'additional' -> bonus
--   6. pcb_remuneration_type = 'normal'          -> allowance   (wage bucket -> Allowances line)
--   7. else the legacy flag-pair inference:  EPF+SOCSO -> allowance
--                                            SOCSO only -> overtime
--                                            EPF only   -> bonus
--                                            neither    -> allowance  (reimburse -> Allowances line)
--
-- Note 'claim' is never produced by the backfill. It is a NEW box, available from the Pay Items screen
-- onward; if the backfill emitted it, every receipted/untaxed earning would jump off the Allowances line on
-- release day, which is exactly the movement the approved plan ruled out.
--
-- THE SINGLE DELIBERATE EXCEPTION is the reporter's own pay code, OT1_5, which is set to 'overtime'. That
-- is the correction that was asked for. It is a no-op anywhere the code does not exist (the seeded catalog,
-- every test database, any other tenant), which is why the rest of the world sees no movement at all.
--
-- NULL KEEPS TODAY'S BEHAVIOUR. core/payroll.ts falls back to the same inference for an unclassified row,
-- so a row this backfill declines to classify (the record-only lines above) is not degraded.
--
-- NO payslip, batch, transaction or ledger row is read or written by this migration. Nothing is
-- recalculated: a payslip already generated keeps its stored figures, and a month only picks the new box up
-- when it is recalculated — the release note says so.

ALTER TABLE pay_component ADD COLUMN IF NOT EXISTS display_category text;

-- Values are closed. A typo'd category would silently fall back to the inference and look like the setting
-- had been ignored — the very complaint this item exists to answer — so the database refuses it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pay_component_display_category_check') THEN
    ALTER TABLE pay_component ADD CONSTRAINT pay_component_display_category_check
      CHECK (display_category IS NULL OR display_category IN
        ('basic','overtime','bonus','allowance','claim','deduction'));
  END IF;
END $$;

COMMENT ON COLUMN pay_component.display_category IS
  '3c473773 — which box on the payslip this pay item prints in. PRESENTATION ONLY: it never reaches a '
  'statutory base and is never read by the EA/CP39/KWSP/PERKESO forms. NULL = unclassified, which keeps '
  'the pre-0393 inference from the EPF/SOCSO flags and pcb_remuneration_type.';

-- The backfill. One statement, precedence expressed top-to-bottom, mirroring earningsOf's branch order.
UPDATE pay_component
   SET display_category = CASE
     WHEN kind = 'deduction' THEN 'deduction'
     WHEN is_non_payable OR kind = 'non_payable' THEN NULL
     WHEN upper(btrim(code)) = 'BASIC' THEN 'basic'
     WHEN pcb_remuneration_type = 'optional_deduction' THEN 'allowance'
     WHEN epf_bonus_2012 OR pcb_remuneration_type = 'additional' THEN 'bonus'
     WHEN pcb_remuneration_type = 'normal' THEN 'allowance'
     WHEN included_in_epf AND included_in_socso_eis THEN 'allowance'
     WHEN included_in_socso_eis THEN 'overtime'
     WHEN included_in_epf THEN 'bonus'
     ELSE 'allowance'
   END
 WHERE display_category IS NULL;

-- The one deliberate re-classification: the reporter's Overtime 1.5 code moves from Bonus to Overtime.
UPDATE pay_component
   SET display_category = 'overtime'
 WHERE upper(btrim(code)) = 'OT1_5';

-- REPORT, so the release note can state what moved rather than assert that nothing did.
DO $$
DECLARE classified int; unclassified int; moved int;
BEGIN
  SELECT count(*) FILTER (WHERE display_category IS NOT NULL),
         count(*) FILTER (WHERE display_category IS NULL)
    INTO classified, unclassified FROM pay_component;
  SELECT count(*) INTO moved FROM pay_component WHERE upper(btrim(code)) = 'OT1_5';
  RAISE NOTICE '0393 pay_component.display_category: % classified, % left NULL (record-only lines keep the inference); % OT1_5 row(s) set to overtime — the only row whose box changes',
    classified, unclassified, moved;
END $$;
