-- 0349 — leave_type.carry_forward_percent: carry forward a SHARE of the year-end balance (7cd914b1).
--
-- Carry Forward Policy offered None or a flat Fixed Maximum, so "carry up to half of what is left" could
-- not be expressed. This column is the third option. 0..100, NULL ⇒ not configured, which is every
-- existing row — so nothing carries differently until someone changes a setting.
--
-- PERCENT AND MAX ARE A CLAMP, NOT A CHOICE. When both are set the percentage resolves first and
-- carry_forward_max is a CEILING on it (carryAllowanceFrom in core/leave-compute.ts). There is
-- deliberately no mode column: two independent settings that can disagree is the shape 9816a5ad
-- consolidated away, and min() cannot produce a figure neither setting authorised.
--
-- ADDITIVE. No backfill: a NULL percentage is read as "no percentage", so every leave type keeps exactly
-- today's carry behaviour, ANNUAL included.
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS carry_forward_percent numeric(5, 2);

-- Refuse a value that cannot mean anything. The service validator rejects these first with a readable
-- message; this is the backstop that keeps a hand-written UPDATE from handing an employee back five times
-- the balance they held. The resolver clamps to 0..100 as well — three layers, because the failure is
-- silent and lands in the ledger.
ALTER TABLE leave_type DROP CONSTRAINT IF EXISTS leave_type_carry_forward_percent_check;
ALTER TABLE leave_type
  ADD CONSTRAINT leave_type_carry_forward_percent_check
  CHECK (carry_forward_percent IS NULL OR (carry_forward_percent >= 0 AND carry_forward_percent <= 100));
