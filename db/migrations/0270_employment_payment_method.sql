-- Payroll tab — Payment Method (R46 79eb7151).
--
-- HOW an employee is paid (bank transfer / cheque / cash). Genuinely new: an exhaustive grep for
-- payment_method / pay_mode / payment_term across db|core|app returned ZERO per-employee hits before this
-- migration. The only pre-existing payment settings were COMPANY-level (disbursement_bank,
-- company_bank_profile) — which corporate account emits the bulk file, not how an individual is paid — plus
-- the employee's own bank name / account number on employee_statutory_my.
--
-- Deliberately NOT added here: per-employee pay_mode / payment_term columns. Those already exist as
-- payroll_policy.policy_type and PayrollPolicyConfig.frequency; duplicating them onto the employment row
-- would create two sources of truth for the same kernel input and force a precedence rule into
-- core/payroll.ts. They are SURFACED read-only on the Payroll tab instead (see ADR-0064).
--
-- Additive and backfill-safe: the column is NULLABLE with no default, so every existing employment row is
-- unaffected and reads as "not specified" (the payment-summary export emits an empty cell, exactly as it did
-- before this column existed). IF NOT EXISTS keeps a re-run on a partially-migrated DB idempotent.
--
-- No RLS change: `employment` already carries the can_see / can_admin policies that every other scalar
-- master-data column on the table inherits (same precedent as migrations 0184 and 0240).
DO $$ BEGIN
  CREATE TYPE "payment_method" AS ENUM ('bank_transfer', 'cheque', 'cash');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "payment_method" "payment_method";
