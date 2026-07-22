-- Feedback 09b554e9: Payroll Items — PCB configuration per the LHDN Spesifikasi Pengiraan PCB 2026
-- Menggunakan Pengiraan Berkomputer. Three ADDITIVE columns on pay_component:
--   • epf_bonus_2012        — the pay code is a bonus payment for EPF purposes (EPF Bonus 2012 rules);
--                             the kernel routes it down the additional-remuneration EPF path.
--   • pcb_remuneration_type — normal | additional | optional_deduction (app-side constrained vocabulary,
--                             core/pay-components.ts PCB_REMUNERATION_TYPES). NULL = legacy row: the kernel
--                             keeps inferring the stream from the EPF/SOCSO flags exactly as today.
--   • pcb_exemption_code    — the LHDN exemption (PCB_*) / optional-deduction (LP_*) code; the annual caps
--                             live in the versioned statutory tables (localization/my/statutory-tables.ts).
-- Existing rows stay NULL/false ⇒ byte-identical legacy behaviour; no backfill, no RLS change (pay_component
-- policies already cover the whole row).
ALTER TABLE pay_component ADD COLUMN IF NOT EXISTS epf_bonus_2012 boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE pay_component ADD COLUMN IF NOT EXISTS pcb_remuneration_type text;--> statement-breakpoint
ALTER TABLE pay_component ADD COLUMN IF NOT EXISTS pcb_exemption_code text;
