-- Statutory follow-ups (owner decision, 14 November 2026): tick EPF Bonus 2012 on the default BONUS pay item.
--
-- From this release only the EPF Bonus 2012 tick puts money on the EPF bonus (additional-remuneration) stream
-- (core/payroll.ts earningsOf). The default BONUS row seeded by localization/my/pay-components.ts was seeded
-- EPF yes, SOCSO/EIS no, no PCB remuneration type and EPF Bonus 2012 false, so the kernel's legacy
-- `epf && !socso` inference used to charge it on the EPF bonus stream. Ticking EPF Bonus 2012 on that row keeps
-- every ordinary bonus on the stream it is charged on today (KWSP Third Schedule, EPF Bonus 2012 rule) and out of
-- SOCSO/EIS/SKBBK, so the payroll figures of these rows do not move. New tenants get the tick from the seed.
--
-- Only rows still in the seeded shape are ticked. A BONUS row an operator changed (any of the flags below, a
-- declared PCB remuneration type or an exemption code) is left exactly as it is, and HR reviews it with the other
-- legacy items before release. The tick passes the pay item validation (epfBonusRequiresEpf: included_in_epf is
-- true here; a NULL remuneration type is the legacy, unsupplied classification).
--
-- Applies as the restricted owner: pay_component is owner-owned and not FORCE ROW LEVEL SECURITY, no purpose-owned
-- object is replaced, no trigger fires on epf_bonus_2012 (the 0800 and 3700 triggers are on `rule` and
-- `applied_company_ids`), and the UPDATE touches at most one row per tenant. Like the 0393 and 0456 pay item
-- backfills, it writes no domain event; the row count is reported for the release record.
UPDATE public.pay_component
   SET epf_bonus_2012 = true
 WHERE code = 'BONUS'
   AND kind = 'allowance'
   AND included_in_epf = true
   AND included_in_socso_eis = false
   AND included_in_pcb = true
   AND is_non_payable = false
   AND pcb_remuneration_type IS NULL
   AND pcb_exemption_code IS NULL
   AND epf_bonus_2012 = false;--> statement-breakpoint
DO $$
DECLARE ticked int;
BEGIN
  SELECT count(*) INTO ticked FROM public.pay_component WHERE code = 'BONUS' AND epf_bonus_2012;
  RAISE NOTICE '5660: BONUS pay items carrying EPF Bonus 2012 after this migration: %', ticked;
END $$;
