-- b6dbadc5: Top-up (existing percentage election) becomes an ADDITIVE top-up, persisted as its own mode.
-- The rates are per-side INCREMENTS added to the statutory rate (blank side = nothing added); the
-- combined-rate cap (statutory + top-up <= 100%) is enforced by the MY pack's resolveEpfElection.
-- Existing voluntary_excess rows are NOT converted here: that is the separate, audited operator script
-- scripts/convert-epf-topup-percentage.ts.
ALTER TYPE public.epf_mode ADD VALUE IF NOT EXISTS 'topup_percentage';
--> statement-breakpoint
ALTER TABLE employee_statutory_my ADD CONSTRAINT employee_statutory_my_topup_percentage_rates
CHECK (epf_mode::text <> 'topup_percentage' OR (
  (epf_employee_rate IS NULL OR epf_employee_rate BETWEEN 0 AND 1)
  AND (epf_employer_rate IS NULL OR epf_employer_rate BETWEEN 0 AND 1)
  AND epf_employee_amount IS NULL AND epf_employer_amount IS NULL
));
