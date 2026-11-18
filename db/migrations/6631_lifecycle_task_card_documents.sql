-- Approved a9778c3b: native task-card links do not depend on the independently paged document list.
-- Exact server-derived references bound the result. Read private document arrays once per requested case.
CREATE FUNCTION app.lifecycle_task_card_documents(p_companies uuid[],p_refs jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_companies IS NULL OR cardinality(p_companies)>500 OR jsonb_typeof(p_refs) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid document task references'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_refs) r WHERE jsonb_typeof(r) IS DISTINCT FROM 'object' OR jsonb_typeof(r->'caseId') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'taskId') IS DISTINCT FROM 'string' OR length(r->>'taskId') NOT BETWEEN 1 AND 120) THEN RAISE EXCEPTION 'Invalid document task references'; END IF;
 WITH requested AS MATERIALIZED (
  SELECT DISTINCT "caseId" AS case_id,"taskId" AS task_id FROM jsonb_to_recordset(p_refs) AS r("caseId" uuid,"taskId" text)
 ), requested_cases AS MATERIALIZED (SELECT DISTINCT case_id FROM requested), principal AS MATERIALIZED (
  SELECT u.id,u.person_id FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 ), owned AS MATERIALIZED (
  SELECT c.id,c.revision,c.data->>'number' AS number,c.data->'tasks' AS tasks,
   coalesce(c.data->'confirmedChecklist'->>'name','Onboarding checklist') AS checklist,
   CASE WHEN c.data->'confirmedChecklist'->>'name' IS NULL THEN 'onboardingChecklist' END AS source_fallback,
   p.data->'lifecycleV9'->'documents' AS documents,u.id AS uid
  FROM requested_cases r JOIN public.lc_onboarding_case c ON c.id=r.case_id AND c.tenant_id=app.current_tenant_id()
  JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id AND e.person_id::text=c.data->>'personId'
  JOIN principal u ON u.person_id=e.person_id
  LEFT JOIN public.lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
  WHERE c.company_id=ANY(p_companies)
   AND (NOT(coalesce(p.data,'{}'::jsonb) ? 'lifecycleV9') OR (p.data->'lifecycleV9Subject'->>'employmentId'=e.id::text AND p.data->'lifecycleV9Subject'->>'personId'=e.person_id::text))
 ), task_candidates AS MATERIALIZED (
  SELECT o.id,o.revision,o.number,o.checklist,o.source_fallback,t,count(*) OVER(PARTITION BY o.id,t->>'id') AS matches
  FROM owned o CROSS JOIN LATERAL jsonb_array_elements(coalesce(o.tasks,'[]'::jsonb)) t
  JOIN requested r ON r.case_id=o.id AND r.task_id=t->>'id'
  WHERE t->>'documentTemplate' IS NOT NULL AND (t->>'assignee'=o.uid::text OR t->>'by' IN ('joiner','employee'))
 ), tasks AS MATERIALIZED (SELECT * FROM task_candidates WHERE matches=1), needed AS MATERIALIZED (
  SELECT DISTINCT id,t->>'documentTemplate' AS template FROM tasks
 ), document_rows AS MATERIALIZED (
  SELECT o.id,d FROM owned o CROSS JOIN LATERAL jsonb_array_elements(coalesce(o.documents,'[]'::jsonb)) d
 ), template_documents AS MATERIALIZED (
  SELECT n.id,n.template,jsonb_agg(d.d) AS documents FROM needed n JOIN document_rows d ON d.id=n.id AND d.d->>'templateId'=n.template GROUP BY n.id,n.template
 ), choices AS MATERIALIZED (
  SELECT n.id,n.template,app.lifecycle_task_document(coalesce(d.documents,'[]'::jsonb),n.template) AS choice
  FROM needed n LEFT JOIN template_documents d ON d.id=n.id AND d.template=n.template
 ) SELECT coalesce(jsonb_agg(jsonb_build_object(
   'caseId',t.id,'caseNumber',t.number,'module','onb','revision',t.revision,'taskId',t.t->>'id','taskName',t.t->>'name','taskStatus',t.t->>'status','dueOn',t.t->>'dueOn','action',coalesce(t.t->>'documentAction','completed'),
   'sourceName',t.checklist,'sourceFallback',t.source_fallback,'sourceKind','checklist','state',c.choice->>'state','documentId',c.choice->>'documentId','documentName',coalesce(c.choice->>'documentName',t.t->>'name','Document'),'documentStatus',c.choice->>'documentStatus'
  ) ORDER BY t.id,t.t->>'id'),'[]'::jsonb) INTO result
  FROM tasks t JOIN choices c ON c.id=t.id AND c.template=t.t->>'documentTemplate';
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_task_card_documents(uuid[],jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_task_card_documents(uuid[],jsonb) TO ai_hr_app;

--> statement-breakpoint
-- One row per case/template choice, with every linked task retained separately. SQL owns distinct counts/pages.
-- Explicit fallback provenance permits translated labels without translating real configured names.
CREATE OR REPLACE FUNCTION app.lifecycle_task_documents(p_companies uuid[],p_offset integer DEFAULT 0,p_limit integer DEFAULT 50,p_case uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_companies IS NULL OR cardinality(p_companies)>500 OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000 OR p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'Invalid document list'; END IF;
 WITH principal AS MATERIALIZED (
  SELECT u.id,u.person_id FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 ), owned AS MATERIALIZED (
  SELECT c.id,c.revision,c.data->>'number' AS number,'onb'::text AS module,c.data->>'state' AS state,c.data->'tasks' AS tasks,
   coalesce(c.data->'confirmedChecklist'->>'name','Onboarding checklist') AS checklist,CASE WHEN c.data->'confirmedChecklist'->>'name' IS NULL THEN 'onboardingChecklist' END AS source_fallback,p.data->'lifecycleV9'->'documents' AS documents,u.id AS uid
  FROM public.lc_onboarding_case c LEFT JOIN public.lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
  JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id AND e.person_id::text=c.data->>'personId'
  JOIN principal u ON u.person_id=e.person_id
  WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=ANY(p_companies) AND (p_case IS NULL OR c.id=p_case)
   AND (NOT(coalesce(p.data,'{}'::jsonb) ? 'lifecycleV9') OR (p.data->'lifecycleV9Subject'->>'employmentId'=e.id::text AND p.data->'lifecycleV9Subject'->>'personId'=e.person_id::text))
  UNION ALL
  SELECT c.id,c.revision,c.number,c.module,c.data->>'state',c.data->'tasks',coalesce(c.data->>'checklistName','Offboarding checklist'),CASE WHEN c.data->>'checklistName' IS NULL THEN 'offboardingChecklist' END,c.data->'documents',u.id
  FROM public.lc_v9_case c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id JOIN principal u ON u.person_id=e.person_id
  WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=ANY(p_companies) AND (p_case IS NULL OR c.id=p_case)
 ), task_rows AS MATERIALIZED (
  SELECT o.id,t,o.checklist,o.source_fallback FROM owned o CROSS JOIN LATERAL jsonb_array_elements(coalesce(o.tasks,'[]'::jsonb)) t
  WHERE t->>'documentTemplate' IS NOT NULL AND (t->>'assignee'=o.uid::text OR t->>'by' IN ('joiner','employee'))
 ), document_rows AS MATERIALIZED (
  SELECT o.id,d FROM owned o CROSS JOIN LATERAL jsonb_array_elements(coalesce(o.documents,'[]'::jsonb)) d
 ), needed AS MATERIALIZED (
  SELECT id,t->>'documentTemplate' AS template FROM task_rows
  UNION
  SELECT id,d->>'templateId' FROM document_rows WHERE d->>'status' NOT IN ('withdrawn','superseded','draft','hrsigned')
 ), template_documents AS MATERIALIZED (
  SELECT n.id,n.template,jsonb_agg(d.d) AS documents FROM needed n JOIN document_rows d ON d.id=n.id AND d.d->>'templateId'=n.template GROUP BY n.id,n.template
 ), task_metadata AS MATERIALIZED (
  SELECT id,t->>'documentTemplate' AS template,min(t->>'dueOn') AS due_on,
   jsonb_agg(jsonb_build_object('taskId',t->>'id','taskName',t->>'name','taskStatus',t->>'status','dueOn',t->>'dueOn','action',coalesce(t->>'documentAction','completed'),
    'sourceName',checklist,'sourceKind','checklist','sourceFallback',source_fallback) ORDER BY t->>'dueOn' NULLS LAST,t->>'id') AS tasks
  FROM task_rows GROUP BY id,t->>'documentTemplate'
 ), choices AS MATERIALIZED (
  SELECT n.id,n.template,app.lifecycle_task_document(coalesce(d.documents,'[]'::jsonb),n.template) AS choice
  FROM needed n LEFT JOIN template_documents d ON d.id=n.id AND d.template=n.template
 ), projected AS MATERIALIZED (
  SELECT o.id,c.template,c.choice->>'documentId' AS document_id,t.due_on,jsonb_build_object(
   'caseId',o.id,'caseNumber',o.number,'module',o.module,'revision',o.revision,
   'taskId',NULL,'taskName',NULL,'taskStatus',NULL,'dueOn',t.due_on,'action',NULL,
   'sourceName',CASE WHEN t.tasks IS NULL THEN 'Documents from HR' ELSE o.checklist END,
   'sourceKind',CASE WHEN t.tasks IS NULL THEN 'document' ELSE 'checklist' END,
   'sourceFallback',CASE WHEN t.tasks IS NULL THEN 'documentsFromHr' ELSE o.source_fallback END,
   'linkedTasks',coalesce(t.tasks,'[]'::jsonb),'state',c.choice->>'state','documentId',c.choice->>'documentId',
   'documentName',coalesce(c.choice->>'documentName','Document'),
   'documentStatus',c.choice->>'documentStatus') AS item
  FROM choices c JOIN owned o ON o.id=c.id LEFT JOIN task_metadata t ON t.id=c.id AND t.template=c.template
 ), page AS (
  SELECT * FROM projected ORDER BY due_on NULLS LAST,id,template,document_id NULLS LAST OFFSET p_offset LIMIT p_limit
 ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(item ORDER BY due_on NULLS LAST,id,template,document_id NULLS LAST) FROM page),'[]'::jsonb),
  'total',(SELECT count(*) FROM projected),'offset',p_offset,'limit',p_limit) INTO result;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_task_documents(uuid[],integer,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_task_documents(uuid[],integer,integer,uuid) TO ai_hr_app;
