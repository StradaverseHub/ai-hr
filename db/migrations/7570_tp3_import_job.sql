-- Board 5084d02e: Form TP3 Excel import (Payroll > Transaction Entry > Form TP3) on the shared bulk-job kernel.
--
-- 1. The kind. One kind for both halves of check-then-confirm (core/tp3-import-job.ts): a CHECK job (input
--    {"mode":"check"}) validates every row and stores row outcomes only, and a SAVE job (input
--    {"mode":"save","checkJobId":…}) started by Confirm saves the ready rows one per step. One active job per creator.
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
VALUES ('tp3_import',NULL,'creator','{"mode":"string","checkJobId":"string?"}'::jsonb,128,false);
--> statement-breakpoint
-- 2. The Import Log's order. Partial: only this kind's rows, so no other kind's writes pay for it.
CREATE INDEX bulk_job_tp3_import_log ON public.bulk_job(tenant_id,created_at DESC,id DESC) WHERE kind='tp3_import';
--> statement-breakpoint
-- 3. The Import Log read. bulk_job row security stays creator-only; this definer lists every TP3 import whose companies
--    the caller administers (app.is_admin_for), so HR sees the imports of the companies they look after whoever ran
--    them. Bounds and disclosure:
--    * a current principal of the session's tenant, an administrator, and 1 to 1000 companies asked for;
--    * the caller's administered companies are computed ONCE from the companies asked for; a job is returned only when
--      every one of its companies is among them (a job always has at least one);
--    * the list (p_job NULL) pages by (created_at, id), at most 101 rows, and hides a check job that was confirmed (its
--      save job, found by the save job's derived operation key, carries the same rows); totals only, no plan;
--    * one job (p_job) also returns its plan (row, Employee ID, year, reason, column; never an amount), its refused
--      rows and its result (notes per row). No uploaded file, input or step payload is ever returned;
--    * the uploader's name only.
CREATE FUNCTION app.tp3_import_log(p_scope uuid[],p_job uuid,p_before_at timestamptz,p_before_id uuid,p_limit integer)
RETURNS TABLE(id uuid,created_by_me boolean,uploaded_by text,mode text,state text,source_name text,company_ids uuid[],
 steps_total integer,steps_done integer,counters jsonb,error text,errors jsonb,plan jsonb,result jsonb,
 created_at timestamptz,finished_at timestamptz,saved_as uuid,cursor_at text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH viewer AS MATERIALIZED (
  SELECT app.current_tenant_id() AS tenant_id,app.current_user_id() AS user_id,
   ARRAY(SELECT DISTINCT c.id FROM unnest(p_scope) c(id) WHERE c.id IS NOT NULL AND app.is_admin_for(c.id)) AS companies
  WHERE app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NOT NULL
   AND coalesce(cardinality(p_scope),0) BETWEEN 1 AND 1000 AND app.is_admin() AND app.principal_snapshot_current()
 ), jobs AS MATERIALIZED (
  SELECT j.id,j.tenant_id,j.created_by,j.state,j.source_name,j.company_ids,j.steps_total,j.steps_done,j.counters,j.error,
   j.errors,j.plan,j.result,j.input,j.created_at,j.finished_at,s.id AS saved_as
  FROM viewer v
  JOIN public.bulk_job j ON j.tenant_id=v.tenant_id AND j.kind='tp3_import'
  LEFT JOIN public.bulk_job s ON s.tenant_id=j.tenant_id AND s.created_by=j.created_by AND s.kind='tp3_import'
   AND s.operation_key=md5('tp3-import-save:'||j.id::text)::uuid
  WHERE cardinality(j.company_ids)>0 AND j.company_ids<@v.companies
   AND (p_job IS NULL OR j.id=p_job)
   AND (p_job IS NOT NULL OR s.id IS NULL)
   AND (p_job IS NOT NULL OR p_before_at IS NULL OR p_before_id IS NULL OR (j.created_at,j.id)<(p_before_at,p_before_id))
  ORDER BY j.created_at DESC,j.id DESC
  LIMIT least(greatest(coalesce(p_limit,1),1),101)
 )
 SELECT j.id,j.created_by=v.user_id,p.full_name,coalesce(j.plan->>'mode',j.input->>'mode'),j.state,j.source_name,j.company_ids,
  j.steps_total,j.steps_done,j.counters,j.error,
  CASE WHEN p_job IS NOT NULL THEN j.errors END,
  CASE WHEN p_job IS NOT NULL THEN j.plan END,
  CASE WHEN p_job IS NOT NULL THEN j.result END,
  j.created_at,j.finished_at,j.saved_as,
  -- The page cursor at the column's full (microsecond) precision, so the next page starts exactly after this row.
  to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
 FROM jobs j CROSS JOIN viewer v
 LEFT JOIN public.app_user u ON u.id=j.created_by AND u.tenant_id=j.tenant_id
 LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=j.tenant_id
 ORDER BY j.created_at DESC,j.id DESC
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.tp3_import_log(uuid[],uuid,timestamptz,uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.tp3_import_log(uuid[],uuid,timestamptz,uuid,integer) TO ai_hr_app;
