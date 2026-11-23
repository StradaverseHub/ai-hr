-- Board a16382b4: group one recalculation run's employee-group batches per company on the Recalculation history page.
-- Nullable and without a default: every existing batch keeps NULL and remains its own run. The only writer is the
-- grouped confirmation worker step, which stamps its payroll_tax_basis_group bulk-job id. Batches stay immutable;
-- the existing table-level INSERT grant and row policies cover the new column.
ALTER TABLE public.payroll_tax_basis_batch ADD COLUMN run_id uuid;
--> statement-breakpoint
-- The history page's queued-company check looks up a run's batches by run_id; older batches are not indexed.
CREATE INDEX payroll_tax_basis_batch_run ON public.payroll_tax_basis_batch(tenant_id,run_id,company_id) WHERE run_id IS NOT NULL;
