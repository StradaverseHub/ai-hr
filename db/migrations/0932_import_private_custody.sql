-- BK48: any-company history visibility is not custody of a whole multi-company file.
-- Keep safe metadata and per-company item policies; private source/plan material is read
-- only by a current principal authorized for EVERY company. No historical rows change.
CREATE FUNCTION app.import_attempt_private(wanted uuid) RETURNS SETOF public.import_attempt
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT a.* FROM public.import_attempt a
 WHERE a.id=wanted AND a.tenant_id=app.current_tenant_id()
  AND app.import_attempt_access(a.id,'view',true)
$$;
REVOKE ALL ON FUNCTION app.import_attempt_private(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_attempt_private(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.import_attempt_history_plan(wanted uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.import_attempt_access(a.id,'view',true) THEN a.plan ELSE
  jsonb_build_object('version',a.plan->'version','previewHash',a.plan->'previewHash','counts',a.plan->'counts',
   'issues',CASE WHEN (CASE WHEN jsonb_typeof(a.plan->'issues')='array' THEN jsonb_array_length(a.plan->'issues')>0 ELSE false END)
    THEN jsonb_build_array(jsonb_build_object('rowNum',0,'reason','Some validation details require access to every company in this file.')) ELSE '[]'::jsonb END) END
 FROM public.import_attempt a WHERE a.id=wanted AND a.tenant_id=app.current_tenant_id()
  AND app.import_attempt_access(a.id,'view',false)
  AND (a.kind<>'information_correction' OR app.import_attempt_access(a.id,'view',true))
$$;
REVOKE ALL ON FUNCTION app.import_attempt_history_plan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_attempt_history_plan(uuid) TO ai_hr_app;
--> statement-breakpoint
REVOKE SELECT ON public.import_attempt FROM PUBLIC,ai_hr_app;
REVOKE SELECT(source_content,plan) ON public.import_attempt FROM PUBLIC,ai_hr_app;
GRANT SELECT(id,tenant_id,kind,created_by,operation_key,source_name,mime_type,source_hash,company_ids,created_at)
 ON public.import_attempt TO ai_hr_app;

--> statement-breakpoint
-- Failed reverts retain private item labels/blockers; successful reverts retain free-text
-- reasons. Protect BOTH immutable ledgers, including bodies recorded before this append.
CREATE FUNCTION app.import_attempt_event_body(wanted uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.import_attempt_access(e.attempt_id,'view',true)
  THEN jsonb_build_object('reason',e.reason,'detail',e.detail)
  ELSE jsonb_build_object('reason',NULL,'detail',jsonb_strip_nulls(jsonb_build_object(
   'succeeded',CASE WHEN jsonb_typeof(e.detail->'succeeded')='number' THEN e.detail->'succeeded' END,
   'failed',CASE WHEN jsonb_typeof(e.detail->'failed')='number' THEN e.detail->'failed' END,
   'restored',CASE WHEN jsonb_typeof(e.detail->'restored')='number' THEN e.detail->'restored' END,
   'counts',CASE WHEN jsonb_typeof(e.detail->'counts')='object' THEN jsonb_strip_nulls(jsonb_build_object(
    'total',CASE WHEN jsonb_typeof(e.detail->'counts'->'total')='number' THEN e.detail->'counts'->'total' END,
    'valid',CASE WHEN jsonb_typeof(e.detail->'counts'->'valid')='number' THEN e.detail->'counts'->'valid' END,
    'invalid',CASE WHEN jsonb_typeof(e.detail->'counts'->'invalid')='number' THEN e.detail->'counts'->'invalid' END)) END,
   'message',CASE WHEN e.kind IN('failed','revert_failed') THEN 'Some event details require access to every company in this file.' END))) END
 FROM public.import_attempt_event e WHERE e.id=wanted AND e.tenant_id=app.current_tenant_id()
  AND app.import_attempt_access(e.attempt_id,'view',false)
  AND app.information_import_history_access(e.attempt_id)
$$;
REVOKE ALL ON FUNCTION app.import_attempt_event_body(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_attempt_event_body(uuid) TO ai_hr_app;
--> statement-breakpoint
REVOKE SELECT ON public.import_attempt_event FROM PUBLIC,ai_hr_app;
REVOKE SELECT(reason,detail) ON public.import_attempt_event FROM PUBLIC,ai_hr_app;
GRANT SELECT(id,tenant_id,attempt_id,kind,actor_id,created_at) ON public.import_attempt_event TO ai_hr_app;
--> statement-breakpoint
-- Central audit selects full payloads. It must use whole-file custody, not coarse admin
-- status or any-company history visibility. Scoped metadata remains in import history.
CREATE POLICY import_attempt_private_audit_read ON public.domain_event AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING (aggregate_type<>'import-attempt' OR app.import_attempt_access(aggregate_id,'view',true));
