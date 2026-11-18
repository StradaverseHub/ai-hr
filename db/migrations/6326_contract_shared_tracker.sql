-- Resolve the real Contract view/decision authority as sets, before reading tracker rows.
-- This is the same scoped role, native People Ops/PBP and administrative reporting ownership as
-- contract_shared_permitted, without calling a subject SECURITY DEFINER function for each employment.
CREATE FUNCTION app.contract_shared_tracker_subjects() RETURNS TABLE(employment_id uuid,can_view boolean,can_decide boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 actor AS MATERIALIZED(SELECT u.id,u.person_id,app.contract_verified_human(u.id) AS verified FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()),
 companies AS MATERIALIZED(SELECT c.* FROM public.company c JOIN public.tenant t ON t.id=c.tenant_id
  WHERE c.tenant_id=app.current_tenant_id() AND t.status IN('active','trial') AND EXISTS(SELECT 1 FROM public.tenant_module m WHERE m.tenant_id=c.tenant_id AND m.module_code='lifecycle' AND m.status IN('active','trial') AND (m.expires_at IS NULL OR m.expires_at>now()) AND (m.company_id IS NULL OR m.company_id=c.id))),
 hierarchy AS(SELECT id AS child,id AS ancestor FROM public.company WHERE tenant_id=app.current_tenant_id()
  UNION SELECT h.child,c.parent_company_id FROM hierarchy h JOIN public.company c ON c.id=h.ancestor AND c.tenant_id=app.current_tenant_id() WHERE c.parent_company_id IS NOT NULL),
 hr AS MATERIALIZED(SELECT DISTINCT c.id FROM companies c JOIN public.role_assignment r ON r.tenant_id=c.tenant_id AND r.app_user_id=app.current_user_id() AND r.role::text IN('hr_admin','super_admin')
  WHERE r.company_id IS NULL OR EXISTS(SELECT 1 FROM hierarchy h WHERE h.child=c.id AND h.ancestor=r.company_id)),
 legacy_roles AS MATERIALIZED(SELECT r.* FROM public.contract_role_assignment r CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.revoked_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>=today)),
 people_ops AS MATERIALIZED(SELECT 1 FROM public.lc_v9_config v JOIN public.lc_onboarding_config shared ON shared.tenant_id=v.tenant_id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(shared.data->'groups','[]'::jsonb)) g WHERE v.tenant_id=app.current_tenant_id() AND g->>'id'=v.data->>'peopleOpsGroup' AND g->'members' ? app.current_user_id()::text LIMIT 1),
 config_companies AS MATERIALIZED(SELECT c.id FROM companies c WHERE c.archived_at IS NULL AND EXISTS(SELECT 1 FROM legacy_roles r WHERE r.company_id=c.id AND r.business_unit_id IS NULL AND r.role='gbs') AND EXISTS(SELECT 1 FROM people_ops)),
 named AS MATERIALIZED(SELECT m.company_id,m.business_group_id,r.permissions FROM public.contract_access_member m JOIN public.contract_access_role r ON r.tenant_id=m.tenant_id AND r.id=m.role_id CROSS JOIN clock
  WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND m.revoked_at IS NULL AND m.valid_from<=today AND (m.valid_to IS NULL OR m.valid_to>=today)),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.employment_id,a.business_unit_id,a.department_id FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 bp_rules AS MATERIALIZED(SELECT r->>'userId' AS user_id,coalesce(r->'rules','{}'::jsonb) AS rules,
  (CASE WHEN coalesce(jsonb_array_length(r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) AS score
  FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'bpRules','[]'::jsonb)) r WHERE v.tenant_id=app.current_tenant_id()),
 bp_matches AS MATERIALIZED(SELECT e.id,r.user_id,r.score,max(r.score) OVER(PARTITION BY e.id) AS top_score FROM public.employment e LEFT JOIN placement a ON a.employment_id=e.id JOIN bp_rules r ON
  (coalesce(jsonb_array_length(r.rules->'company'),0)=0 OR r.rules->'company' ? e.company_id::text)
  AND (coalesce(jsonb_array_length(r.rules->'businessGroup'),0)=0 OR r.rules->'businessGroup' ? a.business_unit_id::text)
  AND (coalesce(jsonb_array_length(r.rules->'department'),0)=0 OR r.rules->'department' ? a.department_id::text)
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(r.rules) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)
  WHERE e.tenant_id=app.current_tenant_id()),
 pbp AS MATERIALIZED(SELECT id FROM bp_matches WHERE score=top_score GROUP BY id HAVING count(DISTINCT user_id)=1 AND min(user_id)=app.current_user_id()::text),
 manager_employments AS MATERIALIZED(SELECT e.id FROM public.employment e CROSS JOIN actor u CROSS JOIN clock WHERE e.tenant_id=app.current_tenant_id() AND e.person_id=u.person_id AND e.voided_at IS NULL AND e.blacklisted_at IS NULL AND e.hired_on<=today
  AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>today)
  AND 1=(SELECT count(*) FROM public.app_user account WHERE account.tenant_id=e.tenant_id AND account.person_id=e.person_id AND account.archived_at IS NULL AND NOT app.login_blocked(account.id))),
 managed AS MATERIALIZED(SELECT DISTINCT r.subordinate_employment_id AS id FROM public.reporting_line r JOIN manager_employments m ON m.id=r.manager_employment_id CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.line_type='administrative' AND r.subordinate_employment_id<>r.manager_employment_id AND r.superseded_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>today)),
 rights AS MATERIALIZED(SELECT e.id,
  EXISTS(SELECT 1 FROM hr WHERE id=c.id) OR EXISTS(SELECT 1 FROM config_companies WHERE id=c.id) AS admin,
  EXISTS(SELECT 1 FROM named n WHERE (n.company_id IS NULL OR n.company_id=c.id) AND (n.business_group_id IS NULL OR n.business_group_id=coalesce(c.parent_company_id,c.id)) AND 'view'=ANY(n.permissions)) AS named_view,
  EXISTS(SELECT 1 FROM named n WHERE (n.company_id IS NULL OR n.company_id=c.id) AND (n.business_group_id IS NULL OR n.business_group_id=coalesce(c.parent_company_id,c.id)) AND 'decide'=ANY(n.permissions)) AS named_decide,
  EXISTS(SELECT 1 FROM managed WHERE id=e.id) AND coalesce(s.superior_enabled,true) AS superior,
  coalesce(s.superior_permissions,ARRAY['view','decide']::text[]) AS superior_permissions,
  EXISTS(SELECT 1 FROM pbp WHERE id=e.id) AND e.person_id IS DISTINCT FROM u.person_id AND EXISTS(SELECT 1 FROM legacy_roles r WHERE r.company_id=c.id AND r.role='pbp' AND (r.business_unit_id IS NULL OR r.business_unit_id=a.business_unit_id)) AS bp
  FROM public.employment e JOIN companies c ON c.id=e.company_id CROSS JOIN actor u LEFT JOIN placement a ON a.employment_id=e.id LEFT JOIN public.contract_shared_settings s ON s.tenant_id=e.tenant_id AND s.company_id=c.id
  WHERE e.tenant_id=app.current_tenant_id() AND u.verified)
 SELECT id,admin OR named_view OR superior AND 'view'=ANY(superior_permissions) OR bp,
  admin OR named_decide OR superior AND 'decide'=ANY(superior_permissions) OR bp FROM rights
$$;
REVOKE ALL ON FUNCTION app.contract_shared_tracker_subjects() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_tracker(p_search text DEFAULT '',p_company uuid DEFAULT NULL,p_status text DEFAULT 'all',p_limit integer DEFAULT 50,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 rights AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_subjects() WHERE can_view),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.* FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 managers AS MATERIALIZED(SELECT DISTINCT ON(r.subordinate_employment_id) r.subordinate_employment_id,p.full_name FROM public.reporting_line r JOIN public.employment e ON e.tenant_id=r.tenant_id AND e.id=r.manager_employment_id JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.line_type='administrative' AND r.superseded_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>today) ORDER BY r.subordinate_employment_id,r.valid_from DESC,r.id),
 current_cases AS MATERIALIZED(SELECT DISTINCT ON(c.employment_id) c.* FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id
  WHERE c.tenant_id=app.current_tenant_id() AND c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text ORDER BY c.employment_id,c.created_at DESC,c.id),
 pending_pay AS MATERIALIZED(SELECT DISTINCT c.employment_id FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id WHERE f.tenant_id=app.current_tenant_id() AND f.data->>'stage'='pay'),
 visible AS MATERIALIZED(SELECT e.id,e.id AS "employmentId",c.id AS "caseId",c.number AS "caseNumber",e.company_id AS "companyId",p.full_name AS "employeeName",e.employee_code AS "employeeCode",co.legal_name AS company,bg.legal_name AS "businessGroup",coalesce(dep.name,'') AS department,coalesce(pos.title,'') AS position,coalesce(manager.full_name,'') AS manager,
  e.contract_start_date::text AS "startOn",e.contract_end_date::text AS "endOn",e.contract_number AS "contractNumber",
  encode(sha256(convert_to(jsonb_build_array(e.id,e.person_id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,a.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex') AS "sourceRevision",
  f.data->>'stage' AS stage,c.data->>'state' AS "legacyState",f.revision AS "sharedRevision",coalesce(f.data->'flags','[]'::jsonb) AS flags,f.updated_at::text AS "lastActivityAt",
  coalesce((f.data->'decision'->>'payChanges')::boolean,false) AS "payChanges",f.data->'payConfirmation' IS NOT NULL AND f.data->'payConfirmation'<>'null'::jsonb AS "payConfirmed",
  pending.employment_id IS NOT NULL AND coalesce(f.data->>'stage','')<>'pay' AS "previousPayPending",
  rights.can_decide AND e.contract_number IS NOT NULL AND e.contract_start_date IS NOT NULL AND e.contract_end_date IS NOT NULL AND e.contract_end_date>=e.contract_start_date AS "canOpen",
  CASE WHEN e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL OR e.contract_end_date<e.contract_start_date THEN 'verify_period'
   WHEN c.id IS NOT NULL AND f.case_id IS NULL AND (c.data->>'state' NOT IN('upcoming','decision_pending') OR c.data->'decision' IS DISTINCT FROM 'null'::jsonb OR coalesce(c.data->'decisionDraft','null'::jsonb)<>'null'::jsonb) THEN 'legacy_in_progress' END AS "sourceIssue"
  FROM rights JOIN public.employment e ON e.id=rights.employment_id AND e.tenant_id=app.current_tenant_id() JOIN placement a ON a.employment_id=e.id JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id JOIN public.company bg ON bg.id=coalesce(co.parent_company_id,co.id) AND bg.tenant_id=co.tenant_id
  LEFT JOIN public.department dep ON dep.id=a.department_id AND dep.tenant_id=e.tenant_id LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id LEFT JOIN managers manager ON manager.subordinate_employment_id=e.id LEFT JOIN current_cases c ON c.employment_id=e.id LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id LEFT JOIN pending_pay pending ON pending.employment_id=e.id CROSS JOIN clock
  WHERE a.employment_type='contract' AND e.hired_on<=today AND e.voided_at IS NULL AND e.blacklisted_at IS NULL AND co.archived_at IS NULL
  AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>today)
  AND (p_company IS NULL OR e.company_id=p_company)
  AND (coalesce(p_search,'')='' OR concat_ws(' ',p.full_name,e.employee_code,c.number,co.legal_name,bg.legal_name,dep.name,pos.title) ILIKE '%'||left(p_search,100)||'%')
 ), filtered AS MATERIALIZED(SELECT * FROM visible WHERE coalesce(p_status,'all')='all'
  OR p_status='attention' AND (jsonb_array_length(flags)>0 OR "sourceIssue" IS NOT NULL OR "previousPayPending")
  OR p_status='decision' AND (stage IS NULL OR stage='open')
  OR p_status='progress' AND stage IN('approval','workflow','document','posting','pay')
  OR p_status='closed' AND stage IN('renewed','converted','offboarding','superseded')),
 page AS(SELECT * FROM filtered ORDER BY "endOn" NULLS LAST,"employeeName",id LIMIT least(greatest(coalesce(p_limit,50),1),100) OFFSET least(greatest(coalesce(p_offset,0),0),100000))
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "endOn" NULLS LAST,"employeeName",id) FROM page),'[]'::jsonb),'total',(SELECT count(*) FROM filtered))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_tracker(text,uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_tracker(text,uuid,text,integer,integer) TO ai_hr_app;
