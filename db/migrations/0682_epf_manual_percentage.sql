-- 5e204d56: distinct manual percentages; legacy top-up records are not converted.
-- Draft migration: parent coordinator allocates journal position/timestamp before release.
ALTER TYPE public.epf_mode ADD VALUE IF NOT EXISTS 'manual_percentage';
--> statement-breakpoint
ALTER TABLE employee_statutory_my ADD CONSTRAINT employee_statutory_my_manual_percentage_rates
CHECK (epf_mode::text <> 'manual_percentage' OR (
  epf_employee_rate IS NOT NULL AND epf_employer_rate IS NOT NULL
  AND epf_employee_rate BETWEEN 0.01 AND 1 AND epf_employer_rate BETWEEN 0.01 AND 1
));
