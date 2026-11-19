-- Register the persistent Fixed Transaction import on the existing shared worker.
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
VALUES ('fixed_transaction_import',NULL,'creator','{"validationOnly":"boolean?"}'::jsonb,128,false);
