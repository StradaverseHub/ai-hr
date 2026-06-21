-- ADR-0033 slice 33-4: freeze each accrual's expiry action at accrual time. For a First-Schedule-eligible
-- employee this is always 'convert_to_pay' (the statutory floor protection), else the company policy's
-- on_expiry — captured here so a later policy/wage change can't retroactively let a statutory entitlement
-- lapse. No rows exist yet (gated/fresh), so the default is only for the ALTER itself.
ALTER TABLE "toil_accrual" ADD COLUMN "expiry_action" "toil_expiry_action" DEFAULT 'convert_to_pay' NOT NULL;
