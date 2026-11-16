-- Case workspace metadata. A single case-level capability gates bounded, set-based slices; no document body,
-- signing policy, recipient identity map, current Payroll amount or arbitrary run payload is exposed.
CREATE FUNCTION app.contract_shared_workspace(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE THEN RAISE EXCEPTION 'This Contract case is unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object(
 'approvals',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a."createdAt",a.id) FROM (
  SELECT a.id,a.decision_revision AS "decisionRevision",a.created_at::text AS "createdAt",
   CASE WHEN app.document_signing_returned(d.data) THEN 'rejected' WHEN NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(d.data)) THEN 'approved'
   WHEN NOT app.contract_shared_decision_current(a.case_id,a.decision_revision) THEN 'cancelled' ELSE 'pending' END AS status,
   coalesce(v.definition->>'name','Workflow') AS "workflowName",a.workflow_step_id AS "stepId"
  FROM public.contract_shared_approval a JOIN public.document_signing_document d ON d.tenant_id=a.tenant_id AND d.id=a.signing_document_id
  LEFT JOIN public.automation_run r ON r.tenant_id=a.tenant_id AND r.id=a.workflow_run_id
  LEFT JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision
  WHERE a.tenant_id=app.current_tenant_id() AND a.case_id=p_case ORDER BY a.created_at DESC,a.id LIMIT 50
 ) a),'[]'::jsonb),
 'letters',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l."generatedOn",l.id) FROM (
  SELECT l.id,l.decision_revision AS "decisionRevision",l.data->'definition'->>'name' AS name,l.data->>'state' AS state,
   l.data->>'generatedOn' AS "generatedOn",l.data->>'releasedAt' AS "releasedAt",l.data->'templateVersion' AS "templateVersion",
   l.data->'valuesFixed'='true'::jsonb AS "valuesFixed",app.document_signing_returned(d.data) AS returned
  FROM public.contract_shared_letter l JOIN public.document_signing_document d ON d.tenant_id=l.tenant_id AND d.id=l.signing_document_id
  WHERE l.tenant_id=app.current_tenant_id() AND l.case_id=p_case ORDER BY l.updated_at DESC,l.id LIMIT 50
 ) l),'[]'::jsonb),
 'runs',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r."startedAt",r.id) FROM (
  SELECT r.id,v.definition->>'name' AS name,r.workflow_revision AS revision,r.trigger_event AS trigger,r.status,r.step_cursor AS cursor,
   r.waiting_for AS "waitingFor",r.started_at::text AS "startedAt",r.updated_at::text AS "updatedAt",
   coalesce((SELECT jsonb_agg(jsonb_build_object('id',s->>'id','type',s->>'type','name',coalesce(s->>'name',s->>'type')) ORDER BY n)
    FROM jsonb_array_elements(v.definition->'steps') WITH ORDINALITY x(s,n)),'[]'::jsonb) AS steps,
   coalesce((SELECT jsonb_agg(jsonb_build_object('at',e->>'at','kind',e->>'kind','stepId',e->>'stepId','type',e->>'type') ORDER BY n)
    FROM jsonb_array_elements(r.log) WITH ORDINALITY x(e,n)),'[]'::jsonb) AS log
  FROM public.automation_run r JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision
  WHERE r.tenant_id=app.current_tenant_id() AND r.module='contract_staff' AND r.subject_id=p_case ORDER BY r.started_at DESC,r.id LIMIT 50
 ) r),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_workspace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_workspace(uuid) TO ai_hr_app;
