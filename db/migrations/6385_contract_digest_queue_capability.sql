-- Explicitly approved exact Contract digest queue boundary; no new kinds, app grants or HR outcomes.
CREATE FUNCTION app.contract_shared_digest_held(p_case uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_system_job_held(nullif(current_setting('app.bulk_job',true),'')::uuid) AND EXISTS(
 SELECT 1 FROM app.contract_system_digest digest JOIN public.bulk_job job ON job.id=digest.job_id AND job.tenant_id=digest.tenant_id AND job.kind='contract_schedule' AND job.created_by IS NULL
 WHERE digest.tenant_id=app.current_tenant_id() AND digest.case_id=p_case AND digest.job_id::text=current_setting('app.bulk_job',true)
 AND digest.mail_key=current_setting('app.contract_digest',true))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_digest_held(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $repair$
DECLARE definition text:=pg_get_functiondef('app.automation_can_run(text,uuid)'::regprocedure);
 before text:=$before$ WHEN 'contract_staff' THEN EXISTS(SELECT 1 FROM public.contract_shared_event e WHERE e.tenant_id=app.current_tenant_id() AND e.case_id=p_subject AND e.id::text=current_setting('app.contract_event',true)
 AND app.contract_shared_worker_event_held(e.case_id,e.decision_revision))$before$;
 after text:=$after$ WHEN 'contract_staff' THEN (app.contract_shared_digest_held(p_subject) OR EXISTS(SELECT 1 FROM public.contract_shared_event e WHERE e.tenant_id=app.current_tenant_id() AND e.case_id=p_subject AND e.id::text=current_setting('app.contract_event',true)
 AND app.contract_shared_worker_event_held(e.case_id,e.decision_revision)))$after$;
BEGIN
 IF strpos(definition,before)=0 THEN RAISE EXCEPTION 'Unreviewed shared Contract runner guard preimage';END IF;
 EXECUTE replace(definition,before,after);
END $repair$;
