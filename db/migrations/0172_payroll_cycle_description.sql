-- R17 1f6b536b: Payroll Cycle "Processing Behaviour" free-text field.
-- The reporter asked for a free-text Processing Behaviour description that serves as documentation /
-- business reference for payroll administrators (NOT engine logic — run_type still gates statutory math).
-- Nullable, so it is backfill-safe against every existing row. No RLS change: the existing
-- payroll_cycle_rls policy (tenant read / can_admin_payroll_for write) already covers the new column
-- and the copy-to-companies inserts.
ALTER TABLE "payroll_cycle" ADD COLUMN IF NOT EXISTS "description" text;
