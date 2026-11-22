-- Unallocated migration draft. Admit later files while the existing worker keeps one import running per tenant.
DO $guard$
BEGIN
 UPDATE public.bulk_job_kind
 SET exclusive='tenant_queue'
 WHERE kind='clocking_import'
   AND exclusive='tenant'
   AND scope_kind IS NULL
   AND NOT finalize_owner
   AND input_shape='{"mappingId":"string","fileName":"string","fileBytes":"number","companyId":"string?"}'::jsonb;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Unexpected Clocking Import job registration' USING ERRCODE='55000';
 END IF;
END;
$guard$;
