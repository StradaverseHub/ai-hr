-- Case workspace metadata. A single case-level capability gates bounded, set-based slices; no document body,
-- signing policy, recipient identity map, current Payroll amount or arbitrary run payload is exposed.
CREATE FUNCTION app.contract_shared_workspace(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;current_flow jsonb;current_decision boolean;
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE THEN RAISE EXCEPTION 'This Contract case is unavailable' USING ERRCODE='42501';END IF;
 SELECT data INTO current_flow FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;
 current_decision:=app.contract_shared_decision_current(p_case,coalesce((current_flow->'decision'->>'revision')::integer,0));
 SELECT jsonb_build_object(
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
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_configuration_choices() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 actor AS MATERIALIZED(SELECT app.contract_shared_access_admin() AS access_admin,app.contract_verified_human(app.current_user_id()) AS verified),
 hierarchy AS(SELECT id AS child,id AS ancestor FROM public.company WHERE tenant_id=app.current_tenant_id()
  UNION SELECT h.child,c.parent_company_id FROM hierarchy h JOIN public.company c ON c.id=h.ancestor AND c.tenant_id=app.current_tenant_id() WHERE c.parent_company_id IS NOT NULL),
 hr AS MATERIALIZED(SELECT DISTINCT h.child AS id FROM hierarchy h JOIN public.role_assignment r ON r.tenant_id=app.current_tenant_id() AND r.app_user_id=app.current_user_id() AND r.role::text IN('super_admin','hr_admin') AND (r.company_id IS NULL OR r.company_id=h.ancestor)),
 named AS MATERIALIZED(SELECT m.company_id,m.business_group_id FROM public.contract_access_member m JOIN public.contract_access_role r ON r.tenant_id=m.tenant_id AND r.id=m.role_id CROSS JOIN clock
  WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND m.revoked_at IS NULL AND m.valid_from<=today AND (m.valid_to IS NULL OR m.valid_to>=today) AND 'access'=ANY(r.permissions)),
 groups AS MATERIALIZED(SELECT g->>'id' AS id,g->>'name' AS name,g->'members' AS members FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()),
 ops AS MATERIALIZED(SELECT 1 FROM public.lc_v9_config v JOIN public.lc_onboarding_config shared ON shared.tenant_id=v.tenant_id CROSS JOIN LATERAL jsonb_array_elements(shared.data->'groups') g WHERE v.tenant_id=app.current_tenant_id() AND g->>'id'=v.data->>'peopleOpsGroup' AND g->'members' ? app.current_user_id()::text),
 legacy AS MATERIALIZED(SELECT r.company_id FROM public.contract_role_assignment r CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.role='gbs' AND r.business_unit_id IS NULL AND r.revoked_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>=today) AND EXISTS(SELECT 1 FROM ops)),
 eligible_companies AS MATERIALIZED(SELECT c.id,c.legal_name AS name,coalesce(c.parent_company_id,c.id) AS group_id FROM public.company c JOIN public.tenant t ON t.id=c.tenant_id CROSS JOIN actor a
  WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND t.status IN('active','trial') AND a.verified
  AND EXISTS(SELECT 1 FROM public.tenant_module m WHERE m.tenant_id=c.tenant_id AND m.module_code='lifecycle' AND m.status IN('active','trial') AND (m.expires_at IS NULL OR m.expires_at>now()) AND (m.company_id IS NULL OR m.company_id=c.id))
  AND (EXISTS(SELECT 1 FROM hr WHERE id=c.id) OR EXISTS(SELECT 1 FROM legacy WHERE company_id=c.id) OR EXISTS(SELECT 1 FROM named n WHERE (n.company_id IS NULL OR n.company_id=c.id) AND (n.business_group_id IS NULL OR n.business_group_id=coalesce(c.parent_company_id,c.id))))),
 people AS MATERIALIZED(SELECT u.id,p.full_name AS name FROM public.app_user u JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id CROSS JOIN actor a
  WHERE a.access_admin AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND length(btrim(p.full_name))>0 ORDER BY p.full_name,u.id LIMIT 50)
 SELECT jsonb_build_object('accessAdmin',a.access_admin,
 'companies',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id) FROM eligible_companies),'[]'::jsonb),
 'scopes',CASE WHEN a.access_admin THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',legal_name,'parentId',parent_company_id) ORDER BY legal_name,id) FROM public.company WHERE tenant_id=app.current_tenant_id() AND archived_at IS NULL),'[]'::jsonb) ELSE '[]'::jsonb END,
 'people',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY name,id) FROM people p),'[]'::jsonb),
 'groups',CASE WHEN a.access_admin OR EXISTS(SELECT 1 FROM eligible_companies) THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id) FROM groups),'[]'::jsonb) ELSE '[]'::jsonb END) FROM actor a
$$;
REVOKE ALL ON FUNCTION app.contract_shared_configuration_choices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_configuration_choices() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_access_people(p_search text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.contract_shared_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Contract access administration is unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(found) ORDER BY name,id),'[]'::jsonb) INTO result FROM(
  SELECT u.id,p.full_name AS name FROM public.app_user u JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id
  WHERE u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND length(btrim(p.full_name))>0
   AND (coalesce(p_search,'')='' OR p.full_name ILIKE '%'||left(p_search,100)||'%') ORDER BY p.full_name,u.id LIMIT 50
 ) found;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_access_people(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_access_people(text) TO ai_hr_app;
