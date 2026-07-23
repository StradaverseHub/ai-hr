-- Item 55865c32 — Identity Information (Profile > Personal Details): every employee, whatever their
-- nationality, may now maintain BOTH an Identity No (NRIC) and Passport Information. The passport block
-- (0214) already covers number / issue date / expiry date / remark; the one schema gap is the passport's
-- Issuing Country. Purely ADDITIVE: nullable text, existing rows are untouched (no backfill, no RLS change —
-- employee_statutory_my keeps its existing tenant policies).
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "passport_issuing_country" text;
