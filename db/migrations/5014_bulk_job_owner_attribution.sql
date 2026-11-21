-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5014_bulk_job_owner_attribution, idx 4414, when 1793330004714.
-- Draft name on its branch: 9006_bulk_job_owner_attribution. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulk-job-kernel-hardening-20261111 (assigned draft range 9005-9009): not a
-- reservation, not an installation allocation. The journal position (idx 9006, when 1793330090006) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when per
-- docs/MIGRATION-ALLOCATION.md. Requires 5013 (bulk-job lease capability).
--
-- Owner-path attribution. A bulk job's work on the queue-owner connection (discard and settle batches, a declared
-- owner finalize, a failure description) runs in one transaction per unit that carries the job transaction-locally:
-- app.bulk_job (the job id) together with that job's lease capability (app.bulk_job_capability). Before, nothing but
-- application_name tied those writes to the job.
--  - app.bulk_job_attribution() returns {id, kind} for the session's job, NULL when none is set, and refuses a job
--    the session does not hold the capability for; any audit trigger can record it.
--  - Every domain event inserted in such a transaction carries payload.bulkJob = {id, kind}, before the audit hash
--    chain seals it (the trigger is named to run first, like a_teras_loop_event_attribution).
-- The worker's app-role chunk transactions run as the creator and are attributed to them (actor) as before.
CREATE FUNCTION app.bulk_job_attribution() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE raw text:=nullif(current_setting('app.bulk_job',true),''); v jsonb;
BEGIN
 IF raw IS NULL THEN RETURN NULL; END IF;
 IF raw!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR NOT app.bulk_job_capability_held(raw::uuid) THEN
  RAISE EXCEPTION 'A bulk job attribution must come from the worker holding that job' USING ERRCODE='42501';
 END IF;
 SELECT jsonb_build_object('id',j.id,'kind',j.kind,'tenantId',j.tenant_id) INTO v FROM public.bulk_job j WHERE j.id=raw::uuid;
 RETURN v;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_attribution() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_attribution() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.bulk_job_event_attribution() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE attr jsonb;
BEGIN
 IF nullif(current_setting('app.bulk_job',true),'') IS NULL THEN RETURN NEW; END IF;
 attr:=app.bulk_job_attribution();
 IF NEW.tenant_id IS DISTINCT FROM (attr->>'tenantId')::uuid THEN
  RAISE EXCEPTION 'A bulk job writes events only in its own tenant' USING ERRCODE='42501';
 END IF;
 IF NEW.payload IS NULL OR jsonb_typeof(NEW.payload)='object' THEN
  NEW.payload:=coalesce(NEW.payload,'{}'::jsonb)||jsonb_build_object('bulkJob',attr-'tenantId');
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_event_attribution() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER a_bulk_job_event_attribution BEFORE INSERT ON public.domain_event
 FOR EACH ROW EXECUTE FUNCTION app.bulk_job_event_attribution();
