-- Case View receives fixed, classified recovery explanations, not raw run messages or transport payloads.
-- Actual fallback counts retain per-step provenance; the separately labelled group is current configuration.
-- Case workspace metadata. A single case-level capability gates bounded, set-based slices; no document body,
-- signing policy, recipient identity map, current Payroll amount or arbitrary run payload is exposed.
CREATE OR REPLACE FUNCTION app.contract_shared_workspace(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;current_flow jsonb;current_decision boolean;
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE THEN RAISE EXCEPTION 'This Contract case is unavailable' USING ERRCODE='42501';END IF;
 SELECT data INTO current_flow FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;
 current_decision:=app.contract_shared_decision_current(p_case,coalesce((current_flow->'decision'->>'revision')::integer,0));
 SELECT jsonb_build_object(
 'configuredFallbackGroup',(SELECT g->>'name' FROM public.contract_shared_settings settings
  JOIN public.contract_case c ON c.tenant_id=settings.tenant_id AND c.company_id=settings.company_id
  JOIN public.lc_v9_config config ON config.tenant_id=settings.tenant_id
  CROSS JOIN LATERAL jsonb_array_elements(config.data->'groups') g
  WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case AND g->>'id'=settings.fallback_group_id LIMIT 1),
 'approvals',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a."createdAt",a.id) FROM (
  SELECT a.id,a.decision_revision AS "decisionRevision",a.created_at::text AS "createdAt",
   CASE WHEN app.document_signing_returned(d.data) THEN 'rejected' WHEN NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(d.data)) THEN 'approved'
   WHEN NOT current_decision OR a.decision_revision IS DISTINCT FROM (current_flow->'decision'->>'revision')::integer THEN 'cancelled' ELSE 'pending' END AS status,
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
   coalesce((SELECT jsonb_agg(jsonb_build_object('at',e->>'at','kind',e->>'kind','stepId',e->>'stepId','type',e->>'type',
     'message',CASE
      WHEN e->>'kind' IN('stepFailed','failed') AND e->>'message' ILIKE '%retired%' THEN 'The document template was retired. Nothing after this step ran; People Ops must review the template in HR Automation.'
      WHEN e->>'kind' IN('stepFailed','failed') AND e->>'type'='generateDocument' THEN 'The document template or signing route cannot run. People Ops must check publication and eligible routed accounts in HR Automation.'
      WHEN e->>'kind' IN('stepFailed','failed') AND e->>'type'='requestApproval' THEN 'The approval step cannot run. People Ops must check the configured approver routing and fallback group.'
      WHEN e->>'kind' IN('stepFailed','failed') AND e->>'type'='sendEmail' THEN 'The email step is held. People Ops must check template publication, required files and recipient routing before starting a live manual workflow.'
      WHEN e->>'kind' IN('stepFailed','failed') AND e->>'type'='createPosting' THEN 'The Personnel posting step stopped. People Ops must check that its type matches the accepted decision and current Personnel source.'
      WHEN e->>'kind' IN('stepFailed','failed') AND e->>'type'='startOffboarding' THEN 'The Offboarding handoff stopped. People Ops must check the ending reason, last day and native Offboarding readiness.'
      WHEN e->>'kind' IN('stepFailed','failed') THEN 'This workflow stopped. People Ops must review the accepted decision and its pinned workflow before starting a live manual workflow.'
      WHEN e->>'kind'='waiting' THEN 'Waiting for the current document routing. Open its retained letter or approval to see the assigned person.'
      WHEN e->>'kind'='stepSkipped' THEN 'This step did not apply to the case or its referenced email template was not live. No effect was created by this step.'
      ELSE NULL END,
     'fallbackCount',CASE WHEN jsonb_typeof(e->'unresolved')='array' THEN jsonb_array_length(e->'unresolved') ELSE 0 END) ORDER BY n)
    FROM jsonb_array_elements(r.log) WITH ORDINALITY x(e,n)),'[]'::jsonb) AS log
  FROM public.automation_run r JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision
  WHERE r.tenant_id=app.current_tenant_id() AND r.module='contract_staff' AND r.subject_id=p_case ORDER BY r.started_at DESC,r.id LIMIT 50
 ) r),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END $$;
