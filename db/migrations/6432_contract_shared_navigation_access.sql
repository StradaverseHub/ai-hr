-- INACTIVE 6012 proposal. Not journaled; no authority until independent review and normal migration admission.
-- Navigation only: existing page/command/definition gates are unchanged.
CREATE FUNCTION app.contract_shared_configuration_company_scope() RETURNS TABLE(id uuid,name text,group_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ WITH RECURSIVE clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 actor AS MATERIALIZED(SELECT app.contract_verified_human(app.current_user_id()) AS verified),
 hierarchy AS(SELECT id AS child,id AS ancestor FROM public.company WHERE tenant_id=app.current_tenant_id()
  UNION SELECT h.child,c.parent_company_id FROM hierarchy h JOIN public.company c ON c.id=h.ancestor AND c.tenant_id=app.current_tenant_id() WHERE c.parent_company_id IS NOT NULL),
 hr AS MATERIALIZED(SELECT DISTINCT h.child AS id FROM hierarchy h JOIN public.role_assignment r ON r.tenant_id=app.current_tenant_id() AND r.app_user_id=app.current_user_id() AND r.role::text IN('super_admin','hr_admin') AND (r.company_id IS NULL OR r.company_id=h.ancestor)),
 named AS MATERIALIZED(SELECT m.company_id,m.business_group_id FROM public.contract_access_member m JOIN public.contract_access_role r ON r.tenant_id=m.tenant_id AND r.id=m.role_id CROSS JOIN clock
  WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND m.revoked_at IS NULL AND m.valid_from<=today AND (m.valid_to IS NULL OR m.valid_to>=today) AND 'access'=ANY(r.permissions)),
 ops AS MATERIALIZED(SELECT 1 FROM public.lc_v9_config v JOIN public.lc_onboarding_config shared ON shared.tenant_id=v.tenant_id CROSS JOIN LATERAL jsonb_array_elements(shared.data->'groups') g WHERE v.tenant_id=app.current_tenant_id() AND g->>'id'=v.data->>'peopleOpsGroup' AND g->'members' ? app.current_user_id()::text),
 legacy AS MATERIALIZED(SELECT r.company_id FROM public.contract_role_assignment r CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.role='gbs' AND r.business_unit_id IS NULL AND r.revoked_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>=today) AND EXISTS(SELECT 1 FROM ops)),
 eligible_companies AS MATERIALIZED(SELECT c.id,c.legal_name AS name,coalesce(c.parent_company_id,c.id) AS group_id FROM public.company c JOIN public.tenant t ON t.id=c.tenant_id CROSS JOIN actor a
  WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND t.status IN('active','trial') AND a.verified
  AND EXISTS(SELECT 1 FROM public.tenant_module m WHERE m.tenant_id=c.tenant_id AND m.module_code='lifecycle' AND m.status IN('active','trial') AND (m.expires_at IS NULL OR m.expires_at>now()) AND (m.company_id IS NULL OR m.company_id=c.id))
  AND (EXISTS(SELECT 1 FROM hr WHERE id=c.id) OR EXISTS(SELECT 1 FROM legacy WHERE company_id=c.id) OR EXISTS(SELECT 1 FROM named n WHERE (n.company_id IS NULL OR n.company_id=c.id) AND (n.business_group_id IS NULL OR n.business_group_id=coalesce(c.parent_company_id,c.id)))))
 SELECT id,name,group_id FROM eligible_companies
$$;
REVOKE ALL ON FUNCTION app.contract_shared_configuration_company_scope() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Fail closed if the exact canonical admission being extracted changed in another forward migration.
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.contract_shared_configuration_choices()'::regprocedure)
 IS DISTINCT FROM '633d7f631e74c853325d1ade7ae02c8e19d524064b29f1cc1c2f441b6b6b6f3e' THEN
  RAISE EXCEPTION 'Expected unchanged 5820 Contract configuration choices before 6012 extraction';
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_configuration_choices() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH actor AS MATERIALIZED(SELECT app.contract_shared_access_admin() AS access_admin,app.contract_verified_human(app.current_user_id()) AS verified),
 groups AS MATERIALIZED(SELECT g->>'id' AS id,g->>'name' AS name,g->'members' AS members FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()),
 eligible_companies AS MATERIALIZED(SELECT * FROM app.contract_shared_configuration_company_scope()),
 people AS MATERIALIZED(SELECT u.id,p.full_name AS name FROM public.app_user u JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id CROSS JOIN actor a
  WHERE a.access_admin AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND length(btrim(p.full_name))>0 ORDER BY p.full_name,u.id LIMIT 50)
 SELECT jsonb_build_object('accessAdmin',a.access_admin,
 'companies',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id) FROM eligible_companies),'[]'::jsonb),
 'scopes',CASE WHEN a.access_admin THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',legal_name,'parentId',parent_company_id) ORDER BY legal_name,id) FROM public.company WHERE tenant_id=app.current_tenant_id() AND archived_at IS NULL),'[]'::jsonb) ELSE '[]'::jsonb END,
 'people',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY name,id) FROM people p),'[]'::jsonb),
 'groups',CASE WHEN a.access_admin OR EXISTS(SELECT 1 FROM eligible_companies) THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id) FROM groups),'[]'::jsonb) ELSE '[]'::jsonb END) FROM actor a
$$;
--> statement-breakpoint
-- Preserve the canonical tracker identity and fail closed if another source changed the owner being extracted.
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.contract_shared_tracker_subjects()'::regprocedure)
 IS DISTINCT FROM '2205d31871034e13ef046ed9f22922a1bbc26a2f54b42e3a634a4bb5643d53f6' THEN
  RAISE EXCEPTION 'Expected unchanged 5818 Contract tracker subject owner before 6012 extraction';
 END IF;
END $$;
--> statement-breakpoint
-- 6012 private extraction of the canonical 5818 explicit company capabilities.
CREATE FUNCTION app.contract_shared_tracker_company_scope() RETURNS TABLE(company_id uuid,is_admin boolean,named_view boolean,named_decide boolean)
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
 explicit_rights AS(SELECT c.id,
  EXISTS(SELECT 1 FROM hr WHERE id=c.id) OR EXISTS(SELECT 1 FROM config_companies WHERE id=c.id) AS is_admin,
  EXISTS(SELECT 1 FROM named n WHERE (n.company_id IS NULL OR n.company_id=c.id) AND (n.business_group_id IS NULL OR n.business_group_id=coalesce(c.parent_company_id,c.id)) AND 'view'=ANY(n.permissions)) AS named_view,
  EXISTS(SELECT 1 FROM named n WHERE (n.company_id IS NULL OR n.company_id=c.id) AND (n.business_group_id IS NULL OR n.business_group_id=coalesce(c.parent_company_id,c.id)) AND 'decide'=ANY(n.permissions)) AS named_decide
  FROM companies c CROSS JOIN actor u WHERE u.verified)
 SELECT id,is_admin,named_view,named_decide FROM explicit_rights
$$;
REVOKE ALL ON FUNCTION app.contract_shared_tracker_company_scope() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Same actor/account/reporting-line owner, bounded to the actor's own manager employments and reports.
CREATE FUNCTION app.contract_shared_tracker_managed_subjects() RETURNS TABLE(employment_id uuid,can_view boolean,can_decide boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 actor AS MATERIALIZED(SELECT u.id,u.person_id,app.contract_verified_human(u.id) AS verified FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()),
 manager_employments AS MATERIALIZED(SELECT e.id FROM public.employment e CROSS JOIN actor u CROSS JOIN clock WHERE e.tenant_id=app.current_tenant_id() AND e.person_id=u.person_id AND e.voided_at IS NULL AND e.blacklisted_at IS NULL AND e.hired_on<=today
  AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>today)
  AND 1=(SELECT count(*) FROM public.app_user account WHERE account.tenant_id=e.tenant_id AND account.person_id=e.person_id AND account.archived_at IS NULL AND NOT app.login_blocked(account.id))),
 managed AS MATERIALIZED(SELECT DISTINCT r.subordinate_employment_id AS id FROM public.reporting_line r JOIN manager_employments m ON m.id=r.manager_employment_id CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.line_type='administrative' AND r.subordinate_employment_id<>r.manager_employment_id AND r.superseded_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>today)),
 report_rights AS(SELECT e.id,coalesce(s.superior_enabled,true) AS enabled,
  coalesce(s.superior_permissions,ARRAY['view','decide']::text[]) AS permissions
  FROM managed m JOIN public.employment e ON e.id=m.id AND e.tenant_id=app.current_tenant_id()
  LEFT JOIN public.contract_shared_settings s ON s.tenant_id=e.tenant_id AND s.company_id=e.company_id CROSS JOIN actor u WHERE u.verified)
 SELECT id,enabled AND 'view'=ANY(permissions),enabled AND 'decide'=ANY(permissions) FROM report_rights
$$;
REVOKE ALL ON FUNCTION app.contract_shared_tracker_managed_subjects() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_tracker_subjects() RETURNS TABLE(employment_id uuid,can_view boolean,can_decide boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 actor AS MATERIALIZED(SELECT u.id,u.person_id,app.contract_verified_human(u.id) AS verified FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()),
 companies AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_company_scope()),
 legacy_roles AS MATERIALIZED(SELECT r.* FROM public.contract_role_assignment r CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.revoked_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>=today)),
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
 managed AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_managed_subjects()),
 rights AS MATERIALIZED(SELECT e.id,c.is_admin AS admin,c.named_view,c.named_decide,
  CASE WHEN managed.employment_id IS NOT NULL THEN managed.can_view ELSE false END AS superior_view,CASE WHEN managed.employment_id IS NOT NULL THEN managed.can_decide ELSE false END AS superior_decide,
  EXISTS(SELECT 1 FROM pbp WHERE id=e.id) AND e.person_id IS DISTINCT FROM u.person_id AND EXISTS(SELECT 1 FROM legacy_roles r WHERE r.company_id=c.company_id AND r.role='pbp' AND (r.business_unit_id IS NULL OR r.business_unit_id=a.business_unit_id)) AS bp
  FROM public.employment e JOIN companies c ON c.company_id=e.company_id CROSS JOIN actor u LEFT JOIN placement a ON a.employment_id=e.id
  LEFT JOIN managed ON managed.employment_id=e.id
  WHERE e.tenant_id=app.current_tenant_id() AND u.verified)
 SELECT id,admin OR named_view OR superior_view OR bp,admin OR named_decide OR superior_decide OR bp FROM rights
$$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_navigation_access() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 -- The legacy configure/intake expressions are copied exactly, retaining their native capability owners.
 -- Do not call the old JSON projection: it eagerly evaluates an unused per-case page fallback.
 -- Retain the exact legacy named-role clause from 0950; do not inherit its generic
 -- case_access fallback, which also admits task-only approvers and employee recipients.
 WITH legacy AS MATERIALIZED(SELECT jsonb_build_object('intake',EXISTS(SELECT 1 FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND co.archived_at IS NULL AND app.contract_company_entitled(co.id) AND (app.contract_gbs_company_scope(co.id) OR EXISTS(SELECT 1 FROM public.contract_role_assignment a WHERE a.company_id=co.id AND a.tenant_id=co.tenant_id AND a.user_id=app.current_user_id() AND app.contract_verified_human(a.user_id) AND a.revoked_at IS NULL AND a.role='pbp' AND app.contract_canonical_role(co.id,a.business_unit_id,a.user_id,'pbp') AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)))),'configure',EXISTS(SELECT 1 FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND app.contract_configure(co.id))) AS facts),
 legacy_role AS MATERIALIZED(SELECT app.contract_active_user(app.current_user_id()) AND EXISTS(
  SELECT 1 FROM public.contract_role_assignment a WHERE a.tenant_id=app.current_tenant_id()
  AND a.user_id=app.current_user_id() AND app.contract_verified_human(a.user_id)
  AND a.role IN('pbp','gbs','legal','template_approver') AND a.revoked_at IS NULL
  AND (a.role NOT IN('pbp','gbs') OR app.contract_canonical_role(a.company_id,a.business_unit_id,a.user_id,a.role))
  AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND app.contract_company_entitled(a.company_id)) AS page),
 clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 company_rights AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_company_scope()),
 managed_rights AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_managed_subjects() WHERE can_view),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.employment_id,a.employment_type
  FROM public.assignment a JOIN managed_rights r ON r.employment_id=a.employment_id CROSS JOIN clock
  WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today
  AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 shared AS MATERIALIZED(SELECT
  app.contract_shared_access_admin() OR EXISTS(SELECT 1 FROM app.contract_shared_configuration_company_scope()) AS configure,
  app.automation_can_configure('contract_staff') AS automation,
  EXISTS(SELECT 1 FROM app.contract_shared_posting_scope()) AS postings)
 SELECT facts||jsonb_build_object('page',CASE
  WHEN coalesce((facts->>'configure')::boolean,false) OR coalesce((facts->>'intake')::boolean,false) OR legacy_role.page OR shared.configure THEN true
  WHEN EXISTS(SELECT 1 FROM company_rights WHERE is_admin OR named_view) THEN true
  ELSE EXISTS(SELECT 1 FROM managed_rights r JOIN public.employment e ON e.tenant_id=app.current_tenant_id() AND e.id=r.employment_id
   JOIN company_rights allowed_company ON allowed_company.company_id=e.company_id
   JOIN public.company co ON co.tenant_id=e.tenant_id AND co.id=e.company_id
   LEFT JOIN placement a ON a.employment_id=e.id CROSS JOIN clock
   WHERE coalesce(a.employment_type='contract' AND e.hired_on<=today AND e.voided_at IS NULL AND e.blacklisted_at IS NULL
    AND co.archived_at IS NULL AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL
     OR least(e.terminated_on,e.resignation_date,e.last_working_date)>today),false)
    OR EXISTS(SELECT 1 FROM public.contract_case c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id)) END,
  'configure',coalesce((facts->>'configure')::boolean,false) OR shared.configure,
  'automation',coalesce(shared.automation,false),'postings',shared.postings) FROM legacy CROSS JOIN legacy_role CROSS JOIN shared
$$;
REVOKE ALL ON FUNCTION app.contract_shared_navigation_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_navigation_access() TO ai_hr_app;
