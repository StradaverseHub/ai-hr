-- Explicit HR admission; one target is reviewed/adopted per leased checkpoint.
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
VALUES('lifecycle_personnel_completion_preview',NULL,'tenant','{"token":"string"}'::jsonb,4096,false),
 ('lifecycle_personnel_completion_recovery',NULL,'tenant','{"token":"string"}'::jsonb,4096,false);
