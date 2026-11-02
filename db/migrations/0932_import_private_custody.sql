-- BK48: any-company history visibility is not custody of a whole multi-company file.
-- Keep safe metadata through fixed views and per-company item policies; whole rows are read
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
-- Tuple-local proof also admits INSERT RETURNING: a STABLE table-reading helper cannot
-- see its own new row in that command. Empty/unreadable attempts remain creator-only.
CREATE POLICY import_attempt_whole_file_read ON public.import_attempt AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
  AND CASE WHEN cardinality(company_ids)=0 THEN created_by=app.current_user_id()
   ELSE NOT EXISTS(SELECT 1 FROM unnest(company_ids) c WHERE NOT app.import_company_access(kind,c,'view')) END);
-- The immutable archived worker reads the whole physical row. Its privilege is safe ONLY
-- together with the restrictive full-custody row policy above, never by a grant alone.
REVOKE SELECT ON public.import_attempt FROM PUBLIC;
REVOKE SELECT(source_content,plan) ON public.import_attempt FROM PUBLIC;
GRANT SELECT ON public.import_attempt TO ai_hr_app;
--> statement-breakpoint
-- Definer view: do not set security_invoker. The owner reads the physical relation, while
-- this fixed fresh-principal/any-company guard and safe projection own partial metadata.
CREATE VIEW app.import_attempt_history WITH (security_barrier=true) AS
 SELECT a.id,a.tenant_id,a.kind,a.created_by,a.operation_key,a.source_name,a.mime_type,
  a.source_hash,a.company_ids,app.import_attempt_history_plan(a.id) AS plan,a.created_at
 FROM public.import_attempt a
 WHERE a.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
  AND app.import_attempt_access(a.id,'view',false)
  AND app.information_import_history_access(a.id);
REVOKE ALL ON app.import_attempt_history FROM PUBLIC;
GRANT SELECT ON app.import_attempt_history TO ai_hr_app;

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
CREATE POLICY import_attempt_event_whole_file_read ON public.import_attempt_event AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
  AND app.import_attempt_access(attempt_id,'view',true));
REVOKE SELECT ON public.import_attempt_event FROM PUBLIC;
REVOKE SELECT(reason,detail) ON public.import_attempt_event FROM PUBLIC;
GRANT SELECT ON public.import_attempt_event TO ai_hr_app;
--> statement-breakpoint
CREATE VIEW app.import_attempt_event_history WITH (security_barrier=true) AS
 SELECT e.id,e.tenant_id,e.attempt_id,e.kind,e.actor_id,e.created_at,
  app.import_attempt_event_body(e.id)->>'reason' AS reason,
  app.import_attempt_event_body(e.id)->'detail' AS detail
 FROM public.import_attempt_event e
 WHERE e.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
  AND app.import_attempt_access(e.attempt_id,'view',false)
  AND app.information_import_history_access(e.attempt_id);
REVOKE ALL ON app.import_attempt_event_history FROM PUBLIC;
GRANT SELECT ON app.import_attempt_event_history TO ai_hr_app;
--> statement-breakpoint
-- Central audit selects full payloads. It must use whole-file custody, not coarse admin
-- status or any-company history visibility. Scoped metadata remains in import history.
CREATE POLICY import_attempt_private_audit_read ON public.domain_event AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING (aggregate_type<>'import-attempt' OR app.import_attempt_access(aggregate_id,'view',true));
