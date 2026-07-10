-- 61d77e82 (Payroll Policies wizard redesign) — Policy Code.
-- Additive, nullable metadata column. NULL = today's exact behaviour (no code). Never read by the payroll
-- kernel; used only for the admin catalog (display + search) and the Step-1 wizard identity field.
ALTER TABLE payroll_policy ADD COLUMN IF NOT EXISTS code text;
