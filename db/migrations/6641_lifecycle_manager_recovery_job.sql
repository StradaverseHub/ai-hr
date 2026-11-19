-- Approved 989bdb77: explicit HR-admitted recovery, one leased checkpoint per case.
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
 VALUES('lifecycle_manager_recovery',NULL,'tenant','{"token":"string"}'::jsonb,4096,false);
