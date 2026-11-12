SELECT online_migration.index_or_defer('public.claim_request','claim_request_payroll_batch_idx',
 'ON public.claim_request (payroll_batch_id) WHERE payroll_batch_id IS NOT NULL');
--> statement-breakpoint
SELECT online_migration.index_or_defer('public.claim_request','claim_request_employment_incurred_idx','ON public.claim_request (employment_id, incurred_on)');
