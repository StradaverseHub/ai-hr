-- INACTIVE FORWARD REVIEW PROPOSAL. Immutable6016 is preserved; no registration/activation implied.
-- Same existing function signature/OID/ACL. Exact original5807 hash and native8s scale proof remain required.
DO $source_guard$
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.contract_shared_setup_revision(uuid)'::regprocedure) IS DISTINCT FROM '017cf4f9e26e82b27b2918f137f8fc76c34a258c00aaaecf672faf67f68fbbaa' THEN RAISE EXCEPTION 'Expected immutable6016 setup source';END IF;
END;
$source_guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_setup_revision(p_case uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH clock AS MATERIALIZED(SELECT app.current_tenant_id() AS tenant_id,current_date AS login_day,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS contract_day),
 -- Read-only projection of0950 verified/active identity and2105 login_blocked_on predicates; parity proof required.
 tenant_accounts AS MATERIALIZED(
  SELECT u.id,u.person_id,u.archived_at,p.full_name FROM public.app_user u CROSS JOIN clock
  LEFT JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id WHERE u.tenant_id=clock.tenant_id
 ),
 employment_login AS MATERIALIZED(
  -- Canonical login_blocked_on is person-wide; deliberately do not add an employment tenant filter here.
  SELECT e.person_id,bool_or(e.blacklisted_at IS NULL AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR clock.login_day<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on))) AS has_open
  FROM public.employment e CROSS JOIN clock
  WHERE e.person_id IN(SELECT DISTINCT person_id FROM tenant_accounts WHERE person_id IS NOT NULL) GROUP BY e.person_id
 ),
 account_activity AS MATERIALIZED(
  SELECT u.*,u.archived_at IS NULL AND (u.person_id IS NULL OR login.person_id IS NULL OR login.has_open) AS active
  FROM tenant_accounts u LEFT JOIN employment_login login ON login.person_id=u.person_id
 ),
 account_identity AS MATERIALIZED(
  SELECT u.*,u.active AND coalesce(length(btrim(u.full_name))>0,false) AS verified FROM account_activity u
 ),
 active_account_counts AS MATERIALIZED(
  SELECT person_id,count(*) FILTER(WHERE active) AS active_count FROM account_identity WHERE person_id IS NOT NULL GROUP BY person_id
 ),
 selected_case AS MATERIALIZED(SELECT c.employment_id FROM public.contract_case c CROSS JOIN clock WHERE c.tenant_id=clock.tenant_id AND c.id=p_case),
 participant_employments AS MATERIALIZED(
  SELECT employment_id AS id FROM selected_case
  UNION SELECT r.manager_employment_id FROM public.reporting_line r JOIN selected_case c ON c.employment_id=r.subordinate_employment_id CROSS JOIN clock
   WHERE r.tenant_id=clock.tenant_id AND r.line_type='administrative' AND r.manager_employment_id<>r.subordinate_employment_id AND r.superseded_at IS NULL
   AND r.valid_from<=clock.contract_day AND (r.valid_to IS NULL OR r.valid_to>clock.contract_day)
 ),
 participant_accounts AS MATERIALIZED(
  SELECT DISTINCT u.id FROM participant_employments wanted JOIN public.employment e ON e.id=wanted.id CROSS JOIN clock
  JOIN account_identity u ON u.person_id=e.person_id JOIN active_account_counts counts ON counts.person_id=e.person_id AND counts.active_count=1
  WHERE e.tenant_id=clock.tenant_id AND e.voided_at IS NULL AND e.blacklisted_at IS NULL AND e.hired_on<=clock.contract_day
   AND (LEAST(e.terminated_on,e.last_working_date,e.resignation_date) IS NULL OR LEAST(e.terminated_on,e.last_working_date,e.resignation_date)>clock.contract_day) AND u.verified
 ),
 workflows AS MATERIALIZED(SELECT DISTINCT ON(workflow_id) workflow_id,revision,status,definition FROM public.automation_workflow_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' ORDER BY workflow_id,revision DESC),
 routings AS MATERIALIZED(SELECT DISTINCT ON(routing_id) routing_id,revision,retired,routing_rows FROM public.automation_routing_version WHERE tenant_id=app.current_tenant_id() ORDER BY routing_id,revision DESC),
 documents AS MATERIALIZED(SELECT h.id,h.live_version,h.retired,v.definition FROM public.automation_document_template h LEFT JOIN public.automation_document_template_version v ON v.tenant_id=h.tenant_id AND v.template_id=h.id AND v.version=h.live_version WHERE h.tenant_id=app.current_tenant_id() AND h.module='contract_staff'),
 members AS MATERIALIZED(
  SELECT jsonb_array_elements_text(coalesce(g->'members','[]'::jsonb)) AS id FROM public.lc_v9_config c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'groups','[]'::jsonb)) g WHERE c.tenant_id=app.current_tenant_id()
  UNION SELECT x#>>'{}' FROM workflows w CROSS JOIN LATERAL jsonb_path_query(w.definition,'$.**.userId') x
  UNION SELECT x#>>'{}' FROM routings r CROSS JOIN LATERAL jsonb_path_query(r.routing_rows,'$[*].assignTo.userIds[*]') x
  UNION SELECT x#>>'{}' FROM documents d CROSS JOIN LATERAL jsonb_path_query(d.definition,'$.routing[*].who.userIds[*]') x
  UNION SELECT u.id::text FROM participant_accounts u
 ),
 -- Fold independent account and membership contributions by UID. There is no rescan-prone membership join.
 people_contributions AS MATERIALIZED(
  SELECT u.id,jsonb_build_array(u.id,u.person_id,u.verified) AS payload,true AS is_account,false AS is_member FROM account_identity u
  UNION ALL SELECT id::uuid,NULL::jsonb,false,true FROM members WHERE id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 ),
 setup_people AS MATERIALIZED(
  SELECT id,(jsonb_agg(payload) FILTER(WHERE is_account))->0 AS payload FROM people_contributions GROUP BY id
  HAVING bool_or(is_account) AND bool_or(is_member)
 )
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'source',(SELECT app.contract_source(c.employment_id) FROM public.contract_case c WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case),
  'settings',(SELECT to_jsonb(s)-'updated_at' FROM public.contract_shared_settings s JOIN public.contract_case c ON c.tenant_id=s.tenant_id AND c.company_id=s.company_id WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id()),
  'configuration',(SELECT jsonb_build_object('groups',data->'groups','fallback',data->'peopleOpsGroup') FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()),
  'workflows',(SELECT jsonb_agg(jsonb_build_array(workflow_id,revision) ORDER BY workflow_id) FROM workflows),
  'routings',(SELECT jsonb_agg(jsonb_build_array(routing_id,revision) ORDER BY routing_id) FROM routings),
  'documents',(SELECT jsonb_agg(jsonb_build_array(id,live_version,retired) ORDER BY id) FROM documents),
  'emails',(SELECT jsonb_agg(jsonb_build_array(template_id,revision) ORDER BY template_id) FROM(SELECT DISTINCT ON(template_id) template_id,revision FROM public.automation_email_template_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' ORDER BY template_id,revision DESC) latest),
  'people',(SELECT jsonb_agg(payload ORDER BY id) FROM setup_people),
  'reasons',(SELECT jsonb_agg(jsonb_build_array(code,is_active) ORDER BY code) FROM public.termination_reason WHERE tenant_id=app.current_tenant_id())
 )::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION app.contract_shared_setup_revision(uuid) FROM PUBLIC,ai_hr_app;
