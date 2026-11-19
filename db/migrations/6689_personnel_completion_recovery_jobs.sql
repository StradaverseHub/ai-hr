-- Explicit HR admission; one target is reviewed/adopted per leased checkpoint.
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
VALUES('lifecycle_personnel_completion_preview',NULL,'tenant','{"token":"string"}'::jsonb,4096,false),
 ('lifecycle_personnel_completion_recovery',NULL,'tenant','{"token":"string"}'::jsonb,4096,false);
--> statement-breakpoint
-- The kernel clears ephemeral steps at terminal cleanup; only its worker-sealed metadata plan
-- can authorize a later explicit selection. This boolean reveals no seal or capability material.
CREATE FUNCTION app.personnel_completion_preview_retained(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.bulk_job j JOIN app.bulk_job_seal s ON s.job_id=j.id
  WHERE j.id=p_job AND j.tenant_id=app.current_tenant_id() AND j.created_by=app.current_user_id()
   AND j.kind='lifecycle_personnel_completion_preview' AND j.state='completed' AND app.bulk_job_access(j.id)
   AND s.plan_digest=app.bulk_job_value_digest(j.plan) AND s.input_digest=app.bulk_job_value_digest(j.input)
   AND CASE WHEN j.plan->'completionPreview'->>'version'='1' AND jsonb_typeof(j.plan->'completionPreview'->'items')='array'
    THEN jsonb_array_length(j.plan->'completionPreview'->'items')=j.steps_total AND j.steps_total BETWEEN 1 AND 1000 ELSE false END);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_completion_preview_retained(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_completion_preview_retained(uuid) TO ai_hr_app;
