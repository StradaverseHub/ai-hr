ALTER TABLE public.bank_import_job ADD COLUMN source_worksheet text
  CHECK (source_worksheet IS NULL OR char_length(source_worksheet) BETWEEN 1 AND 31);
--> statement-breakpoint
ALTER TABLE public.payroll_individual_import_job ADD COLUMN source_worksheet text
  CHECK (source_worksheet IS NULL OR char_length(source_worksheet) BETWEEN 1 AND 31);
--> statement-breakpoint
GRANT INSERT (source_worksheet) ON public.payroll_individual_import_job TO ai_hr_app;
