-- 1058ced1: Manual (by percentage) EPF rates accept 0%-100% inclusive on each side; both remain required.
-- Loosens 0682's 1% floor only, so every existing row already satisfies the replacement constraint.
ALTER TABLE employee_statutory_my DROP CONSTRAINT employee_statutory_my_manual_percentage_rates;
--> statement-breakpoint
ALTER TABLE employee_statutory_my ADD CONSTRAINT employee_statutory_my_manual_percentage_rates
CHECK (epf_mode::text <> 'manual_percentage' OR (
  epf_employee_rate IS NOT NULL AND epf_employer_rate IS NOT NULL
  AND epf_employee_rate BETWEEN 0 AND 1 AND epf_employer_rate BETWEEN 0 AND 1
));
