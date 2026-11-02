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
   'issues',CASE WHEN jsonb_array_length(coalesce(a.plan->'issues','[]'::jsonb))>0
    THEN jsonb_build_array(jsonb_build_object('rowNum',0,'reason','Some validation details require access to every company in this file.')) ELSE '[]'::jsonb END) END
 FROM public.import_attempt a WHERE a.id=wanted AND a.tenant_id=app.current_tenant_id()
  AND app.import_attempt_access(a.id,'view',false)
  AND (a.kind<>'information_correction' OR app.import_attempt_access(a.id,'view',true))
$$;
REVOKE ALL ON FUNCTION app.import_attempt_history_plan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_attempt_history_plan(uuid) TO ai_hr_app;
--> statement-breakpoint
REVOKE SELECT ON public.import_attempt FROM ai_hr_app;
GRANT SELECT(id,tenant_id,kind,created_by,operation_key,source_name,mime_type,source_hash,company_ids,created_at)
 ON public.import_attempt TO ai_hr_app;
