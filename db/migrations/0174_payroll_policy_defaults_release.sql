-- Payroll Policies Configuration Enhancement (feedback f3148da1).
-- Additive, forward-only, idempotent. NULL on every new column = today's exact behaviour.
--   • company_payroll_config.default_payroll_policy_id — the company-DEFAULT payroll policy applied to any
--     employee with no policy assigned on their employment (Step 1). NULL = unassigned ⇒ monthly default.
--   • company_payroll_config.payslip_release            — payslip release config jsonb (Step 6). NULL = immediate.
--   • payroll_batch.closed_at                           — close timestamp driving the ESS payslip-release gate
--     (Step 6). NULL for legacy batches = already released (historical payslips stay visible).

ALTER TABLE "company_payroll_config"
  ADD COLUMN IF NOT EXISTS "default_payroll_policy_id" uuid REFERENCES "payroll_policy"("id");--> statement-breakpoint

ALTER TABLE "company_payroll_config"
  ADD COLUMN IF NOT EXISTS "payslip_release" jsonb;--> statement-breakpoint

ALTER TABLE "payroll_batch"
  ADD COLUMN IF NOT EXISTS "closed_at" timestamptz;--> statement-breakpoint

ALTER TABLE "payroll_batch"
  ADD COLUMN IF NOT EXISTS "released_at" timestamptz;--> statement-breakpoint

-- Backfill: existing CLOSED batches are already visible to employees today. Stamp closed_at + released_at =
-- created_at so the ESS payslip-release gate (released_at <= now) treats them as long-released. The gate is
-- computed at CLOSE TIME going forward (closeBatch, admin session — the ESS employee session cannot read the
-- company release config, so it must not be re-read at read time). Draft/processed batches stay NULL.
UPDATE "payroll_batch" SET "closed_at" = "created_at" WHERE "status" = 'closed' AND "closed_at" IS NULL;
UPDATE "payroll_batch" SET "released_at" = "created_at" WHERE "status" = 'closed' AND "released_at" IS NULL;
