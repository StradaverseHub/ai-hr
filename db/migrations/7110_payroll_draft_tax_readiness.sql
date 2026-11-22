-- The draft tax check reads payroll history and writes only its ordinary bulk-job progress.
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
VALUES('payroll_draft_tax_readiness',NULL,'none','{"batchId":"string"}'::jsonb,128,false);
