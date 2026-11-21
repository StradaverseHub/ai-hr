-- Register the existing bulk worker's grouped tax-basis workflow.
-- The worker rechecks every company's view and recalculation grants.
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
VALUES('payroll_tax_basis_group',NULL,'none','{"selections":"array?","previewJobId":"string?"}'::jsonb,1048576,false);
