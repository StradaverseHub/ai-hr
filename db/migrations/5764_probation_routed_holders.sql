-- One owner for a Probation case's PBP and Head of Department: the shared routings (lane K2 of the Probation
-- Confirmation build; handoff A3, B2, B5 "HOD by business group and department" / "BP by business group").
-- Tag 5764 / idx 5164 / when 1793330005464, assigned by the build coordinator.
--
-- app.probation_routed_holders(employments) is the single resolver of a case's holders. Its PBP and Head of Department
-- come from the shared routings the Probation defaults install with fixed ids (app/automation/probation-defaults.ts):
-- "BP by business group" a0700000-0000-4000-8000-000000001001 and "HOD by business group and department"
-- a0700000-0000-4000-8000-000000001002, evaluated with the shared routing rule (lib/automation/routing.ts):
--  - a row matches when each dimension it names (business group = business unit or group company, company, department,
--    job title) contains the employee's value; the most specific row wins (business group 8, company 4, department 2,
--    job title 1); equally specific rows keep list order;
--  - a row naming exactly one active person makes that person the holder; a group or several people make each active
--    member a holder ("any member may act"); no matching row, or nobody active, goes to the fallback group (the case
--    company's published settings fallbackGroupId, else the On/Off Boarding People Ops group), and the case says so.
-- Until a routing has rows (the defaults install it empty), its existing source keeps answering exactly as today, as
-- the routing's adapter: the V9 bpRules list (most specific rule, a tie between different people resolves to nobody,
-- and the person must hold a current Probation PBP mapping, as 5750 does) and the department's head.
-- Holders resolve when asked (today's rule): a routing edit moves the unsigned PBP and HOD steps of open cases as a
-- department-head or bpRules change does today; a signed step keeps its recorded signer; the tracker shows the holder
-- recorded when the case started; a part keeps the route rows it opened with.
-- app.probation_holders_set keeps its signature and answers from this resolver (the duplicate bpRules resolver it held
-- is removed); app.probation_role ('pbp', 'hod') and app.probation_visible_among also accept the routed members.
-- No table, row, grant, policy or purpose-owned object changes; the new function is owner only.
-- The shared routing rule's two pieces (lib/automation/routing.ts routingRowMatches / routingRowSpecificity): a dimension
-- with no values matches everyone; with values it matches when one equals one of the employee's values.
CREATE FUNCTION app.probation_routing_dimension(p_values jsonb,p_facts text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_values IS NULL OR jsonb_typeof(p_values)='null' THEN true WHEN jsonb_typeof(p_values)<>'array' THEN false
  WHEN jsonb_array_length(p_values)=0 THEN true ELSE p_values ?| array_remove(coalesce(p_facts,'{}'::text[]),NULL) END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.probation_routing_weight(p_values jsonb,p_weight integer) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_values)='array' THEN CASE WHEN jsonb_array_length(p_values)>0 THEN p_weight ELSE 0 END ELSE 0 END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.probation_routed_holders(p_employments uuid[]) RETURNS TABLE(employment_id uuid,company_id uuid,department_id uuid,business_unit_id uuid,employee uuid,lm uuid,
 hod uuid,hod_users uuid[],hod_group text,hod_source text,pbp uuid,pbp_users uuid[],pbp_group text,pbp_source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
#variable_conflict use_column
DECLARE t uuid:=app.current_tenant_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;rules_ok boolean:=true;v9 jsonb;bp_rows jsonb;hod_rows jsonb;bp_retired boolean;hod_retired boolean;
BEGIN
 IF t IS NULL OR coalesce(cardinality(p_employments),0)=0 THEN RETURN;END IF;
 SELECT v.data INTO v9 FROM public.lc_v9_config v WHERE v.tenant_id=t LIMIT 1;
 SELECT v.routing_rows,v.retired INTO bp_rows,bp_retired FROM public.automation_routing_version v WHERE v.tenant_id=t AND v.routing_id='a0700000-0000-4000-8000-000000001001'::uuid ORDER BY v.revision DESC LIMIT 1;
 SELECT v.routing_rows,v.retired INTO hod_rows,hod_retired FROM public.automation_routing_version v WHERE v.tenant_id=t AND v.routing_id='a0700000-0000-4000-8000-000000001002'::uuid ORDER BY v.revision DESC LIMIT 1;
 -- A routing answers once it has rows and is not retired; until then its adapter does.
 IF bp_retired IS NOT FALSE OR jsonb_typeof(bp_rows) IS DISTINCT FROM 'array' THEN bp_rows:=NULL;ELSIF jsonb_array_length(bp_rows)=0 THEN bp_rows:=NULL;END IF;
 IF hod_retired IS NOT FALSE OR jsonb_typeof(hod_rows) IS DISTINCT FROM 'array' THEN hod_rows:=NULL;ELSIF jsonb_array_length(hod_rows)=0 THEN hod_rows:=NULL;END IF;
 IF bp_rows IS NULL THEN
  IF jsonb_typeof(v9->'bpRules') IS NOT NULL AND jsonb_typeof(v9->'bpRules')<>'array' THEN rules_ok:=false;END IF;
  IF rules_ok THEN
   SELECT coalesce(bool_and((r->'rules' IS NULL OR jsonb_typeof(r->'rules')='object')
    AND (r->'rules'->'company' IS NULL OR jsonb_typeof(r->'rules'->'company')='array')
    AND (r->'rules'->'businessGroup' IS NULL OR jsonb_typeof(r->'rules'->'businessGroup')='array')
    AND (r->'rules'->'department' IS NULL OR jsonb_typeof(r->'rules'->'department')='array')),true) INTO rules_ok
   FROM jsonb_array_elements(coalesce(v9->'bpRules','[]'::jsonb)) r;
  END IF;
 END IF;
 RETURN QUERY
 WITH emp AS MATERIALIZED (
  SELECT e.id,e.person_id,e.company_id,x.department_id,x.business_unit_id,x.title,coalesce(co.parent_company_id,co.id) AS group_company,
   (SELECT r.manager_employment_id FROM public.reporting_line r WHERE r.tenant_id=t AND r.subordinate_employment_id=e.id AND r.line_type='administrative'
     AND r.valid_from<=current_date AND (r.valid_to IS NULL OR r.valid_to>current_date) AND r.superseded_at IS NULL LIMIT 1) AS manager_id,
   (SELECT d.head_employment_id FROM public.department d WHERE d.id=x.department_id AND d.tenant_id=e.tenant_id) AS head_id
  FROM public.employment e
  LEFT JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
  LEFT JOIN LATERAL (SELECT a.department_id,a.business_unit_id,btrim(pos.title) AS title FROM public.assignment a
   LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=a.tenant_id
   WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL
   AND a.valid_from<=day AND (a.valid_to IS NULL OR a.valid_to>day) ORDER BY a.valid_from DESC,a.id LIMIT 1) x ON true
  WHERE e.tenant_id=t AND e.id=ANY(p_employments)),
 linked AS MATERIALIZED (
  SELECT l.id,l.person_id FROM public.employment l
  WHERE l.tenant_id=t AND l.id=ANY(ARRAY(SELECT emp.id FROM emp UNION SELECT emp.manager_id FROM emp WHERE emp.manager_id IS NOT NULL UNION SELECT emp.head_id FROM emp WHERE emp.head_id IS NOT NULL))),
 -- A holder is the person's only usable login: person -> login, or JSON null when the person has more than one.
 logins AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(x.person_id::text,x.user_id),'{}'::jsonb) AS m FROM (
   SELECT u.person_id,CASE WHEN count(*)=1 THEN (array_agg(u.id))[1] END AS user_id FROM public.app_user u
   WHERE u.tenant_id=t AND u.person_id=ANY(ARRAY(SELECT DISTINCT linked.person_id FROM linked WHERE linked.person_id IS NOT NULL)) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   GROUP BY u.person_id) x),
 user_for AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(linked.id::text,logins.m->(linked.person_id::text)) FILTER(WHERE logins.m ? linked.person_id::text),'{}'::jsonb) AS m
  FROM linked CROSS JOIN logins),
 -- The V9 bpRules adapter, exactly as 5750 resolved the PBP (only while the BP routing has no rows).
 rules AS MATERIALIZED (SELECT r.value AS r FROM jsonb_array_elements(CASE WHEN bp_rows IS NULL AND rules_ok THEN coalesce(v9->'bpRules','[]'::jsonb) ELSE '[]'::jsonb END) r),
 bp AS MATERIALIZED (
  SELECT emp.id,emp.company_id,emp.department_id,emp.business_unit_id,rules.r->>'userId' AS user_id,
   (CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) AS score
  FROM emp CROSS JOIN rules
  WHERE (coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)=0 OR rules.r->'rules'->'company' ? emp.company_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)=0 OR rules.r->'rules'->'businessGroup' ? emp.business_unit_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)=0 OR rules.r->'rules'->'department' ? emp.department_id::text)
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(coalesce(rules.r->'rules','{}'::jsonb)) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)),
 bp_pick AS MATERIALIZED (
  SELECT ranked.id,ranked.company_id,ranked.department_id,ranked.business_unit_id,min(ranked.user_id) AS user_id
  FROM (SELECT bp.*,max(bp.score) OVER(PARTITION BY bp.id) AS top FROM bp) ranked WHERE ranked.score=ranked.top
  GROUP BY ranked.id,ranked.company_id,ranked.department_id,ranked.business_unit_id HAVING count(DISTINCT coalesce(ranked.user_id,chr(1)))=1),
 bp_user AS MATERIALIZED (
  SELECT bp_pick.id,bp_pick.company_id,bp_pick.department_id,bp_pick.business_unit_id,u.id AS user_id FROM bp_pick
  JOIN public.app_user u ON u.id=CASE WHEN bp_pick.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN bp_pick.user_id::uuid END
   AND u.tenant_id=t AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id AND length(btrim(n.full_name))>0),
 pbp_maps AS MATERIALIZED (SELECT m.* FROM public.probation_access m WHERE m.tenant_id=t AND m.role='pbp' AND m.user_id=ANY(ARRAY(SELECT DISTINCT bp_user.user_id FROM bp_user)) AND m.valid_from<=day AND (m.valid_to IS NULL OR m.valid_to>=day)),
 anc AS MATERIALIZED (SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT bp_user.company_id FROM bp_user))),
 adapter_pbp AS MATERIALIZED (
  SELECT bp_user.id,bp_user.user_id FROM bp_user
  WHERE EXISTS(SELECT 1 FROM pbp_maps m JOIN anc ON anc.ancestor_id=m.company_id
   WHERE anc.company_id=bp_user.company_id AND m.user_id=bp_user.user_id AND (m.department_id IS NULL OR m.department_id=bp_user.department_id) AND (m.business_unit_id IS NULL OR m.business_unit_id=bp_user.business_unit_id))),
 -- The shared routing rule for the routings that have rows: one winning row per employee and routing.
rrows AS MATERIALIZED (
  SELECT 'pbp'::text AS kind,r.value AS rrow,r.ord FROM jsonb_array_elements(coalesce(bp_rows,'[]'::jsonb)) WITH ORDINALITY r(value,ord)
  UNION ALL SELECT 'hod',r.value,r.ord FROM jsonb_array_elements(coalesce(hod_rows,'[]'::jsonb)) WITH ORDINALITY r(value,ord)),
 scored AS MATERIALIZED (
  SELECT emp.id,rrows.kind,rrows.rrow,rrows.ord,
   app.probation_routing_weight(rrows.rrow->'match'->'businessGroup',8)+app.probation_routing_weight(rrows.rrow->'match'->'company',4)
    +app.probation_routing_weight(rrows.rrow->'match'->'department',2)+app.probation_routing_weight(rrows.rrow->'match'->'jobTitle',1) AS score
  FROM emp CROSS JOIN rrows
  WHERE app.probation_routing_dimension(rrows.rrow->'match'->'businessGroup',ARRAY[emp.business_unit_id::text,emp.group_company::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'company',ARRAY[emp.company_id::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'department',ARRAY[emp.department_id::text])
   AND app.probation_routing_dimension(rrows.rrow->'match'->'jobTitle',ARRAY[coalesce(emp.title,'')])),
 winner AS MATERIALIZED (SELECT DISTINCT ON (scored.id,scored.kind) scored.id,scored.kind,scored.rrow FROM scored ORDER BY scored.id,scored.kind,scored.score DESC,scored.ord),
 groups AS MATERIALIZED (
  SELECT g->>'id' AS id,coalesce((SELECT array_agg(u.id ORDER BY m.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members')='array' THEN g->'members' ELSE '[]'::jsonb END) WITH ORDINALITY m(id,n)
    JOIN public.app_user u ON u.id::text=m.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE m.n<=500),'{}'::uuid[]) AS members
  FROM jsonb_array_elements(CASE WHEN (bp_rows IS NOT NULL OR hod_rows IS NOT NULL) AND jsonb_typeof(v9->'groups')='array' THEN v9->'groups' ELSE '[]'::jsonb END) g),
 chosen AS MATERIALIZED (
  SELECT winner.id,winner.kind,CASE WHEN winner.rrow->'assignTo'->>'kind'='group' THEN winner.rrow->'assignTo'->>'groupId' END AS group_id,
   CASE WHEN winner.rrow->'assignTo'->>'kind'='group' THEN coalesce((SELECT groups.members FROM groups WHERE groups.id=winner.rrow->'assignTo'->>'groupId' LIMIT 1),'{}'::uuid[])
    ELSE coalesce((SELECT array_agg(u.id ORDER BY p.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(winner.rrow->'assignTo'->'userIds')='array' THEN winner.rrow->'assignTo'->'userIds' ELSE '[]'::jsonb END) WITH ORDINALITY p(id,n)
     JOIN public.app_user u ON u.id::text=p.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE p.n<=50),'{}'::uuid[]) END AS users
  FROM winner),
 -- The fallback group for an employee no row matches (or whose row reaches nobody active), per company.
 fallback AS MATERIALIZED (
  SELECT co.company_id,coalesce(nullif((SELECT s.data->>'fallbackGroupId' FROM public.probation_configuration s WHERE s.tenant_id=t AND s.company_id=co.company_id AND s.kind='settings' AND s.state='published' ORDER BY s.version DESC LIMIT 1),''),nullif(v9->>'peopleOpsGroup','')) AS group_id
  FROM (SELECT DISTINCT emp.company_id FROM emp WHERE bp_rows IS NOT NULL OR hod_rows IS NOT NULL) co),
 fallback_members AS MATERIALIZED (
  SELECT fallback.company_id,fallback.group_id,coalesce((SELECT groups.members FROM groups WHERE groups.id=fallback.group_id LIMIT 1),'{}'::uuid[]) AS users FROM fallback),
 resolved AS MATERIALIZED (
  SELECT emp.id,k.kind,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN chosen.group_id ELSE fm.group_id END AS group_id,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN chosen.users ELSE coalesce(fm.users,'{}'::uuid[]) END AS users,
   CASE WHEN chosen.id IS NOT NULL AND cardinality(chosen.users)>0 THEN 'routing' ELSE 'fallback' END AS source
  FROM emp CROSS JOIN (SELECT 'pbp'::text AS kind WHERE bp_rows IS NOT NULL UNION ALL SELECT 'hod' WHERE hod_rows IS NOT NULL) k
  LEFT JOIN chosen ON chosen.id=emp.id AND chosen.kind=k.kind
  LEFT JOIN fallback_members fm ON fm.company_id=emp.company_id)
 SELECT emp.id,emp.company_id,emp.department_id,emp.business_unit_id,
  (user_for.m->>(emp.id::text))::uuid,(user_for.m->>(emp.manager_id::text))::uuid,
  -- Head of Department
  CASE WHEN hod_rows IS NULL THEN (user_for.m->>(emp.head_id::text))::uuid WHEN rh.group_id IS NULL AND cardinality(rh.users)=1 THEN rh.users[1] END,
  CASE WHEN hod_rows IS NULL THEN array_remove(ARRAY[(user_for.m->>(emp.head_id::text))::uuid],NULL) ELSE coalesce(rh.users,'{}'::uuid[]) END,
  CASE WHEN hod_rows IS NULL THEN NULL ELSE rh.group_id END,
  CASE WHEN hod_rows IS NULL THEN 'department' ELSE rh.source END,
  -- People Business Partner
  CASE WHEN bp_rows IS NULL THEN ap.user_id WHEN rp.group_id IS NULL AND rp.source='routing' AND cardinality(rp.users)=1 THEN rp.users[1] END,
  CASE WHEN bp_rows IS NULL THEN array_remove(ARRAY[ap.user_id],NULL) ELSE coalesce(rp.users,'{}'::uuid[]) END,
  CASE WHEN bp_rows IS NULL THEN NULL ELSE rp.group_id END,
  CASE WHEN bp_rows IS NULL THEN 'bpRules' ELSE rp.source END
 FROM emp CROSS JOIN user_for
 LEFT JOIN adapter_pbp ap ON ap.id=emp.id
 LEFT JOIN resolved rp ON rp.id=emp.id AND rp.kind='pbp'
 LEFT JOIN resolved rh ON rh.id=emp.id AND rh.kind='hod';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_routing_dimension(jsonb,text[]),app.probation_routing_weight(jsonb,integer),app.probation_routed_holders(uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The one resolver answers the existing holder set (same signature and grants); the bpRules resolver it held moved
-- into app.probation_routed_holders as the BP routing's adapter.
CREATE OR REPLACE FUNCTION app.probation_holders_set(p_employments uuid[]) RETURNS TABLE(employment_id uuid,company_id uuid,department_id uuid,business_unit_id uuid,employee uuid,lm uuid,hod uuid,pbp uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN QUERY SELECT r.employment_id,r.company_id,r.department_id,r.business_unit_id,r.employee,r.lm,r.hod,r.pbp FROM app.probation_routed_holders(p_employments) r;
END $$;
--> statement-breakpoint
-- The PBP and Head of Department roles are held by everyone the routing names for the employee (one person, the members
-- of a group, or the fallback group), or by today's single holder while the routing has no rows.
CREATE OR REPLACE FUNCTION app.probation_role(p_employment uuid,p_role text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h jsonb;co uuid;r record;
BEGIN
 IF NOT app.probation_active_user() THEN RETURN false;END IF;
 IF p_role IN('hod','pbp') THEN
  SELECT * INTO r FROM app.probation_routed_holders(ARRAY[p_employment]);
  IF r.company_id IS NULL OR NOT app.probation_company_entitled(r.company_id) THEN RETURN false;END IF;
  RETURN coalesce(app.current_user_id()=ANY(CASE WHEN p_role='pbp' THEN r.pbp_users ELSE r.hod_users END),false);
 END IF;
 h:=app.probation_holders(p_employment);co:=(h->>'companyId')::uuid;IF co IS NULL OR NOT app.probation_company_entitled(co) THEN RETURN false;END IF;
 IF p_role='lm' AND coalesce((SELECT x.enabled FROM app.probation_superior_rule() x),true) IS NOT TRUE THEN RETURN false;END IF;
 IF p_role IN('employee','lm') THEN RETURN coalesce(h->>p_role=app.current_user_id()::text,false);END IF;
 IF p_role='gbs' THEN RETURN app.probation_gbs_user(p_employment,app.current_user_id());END IF;
 RETURN false;
END $$;
--> statement-breakpoint
-- The visible set reads holders from the one resolver and accepts every routed PBP and Head of Department (body from 5763).
CREATE OR REPLACE FUNCTION app.probation_visible_among(p_cases uuid[]) RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();me uuid:=app.current_user_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 my_person uuid;usable boolean:=false;ops boolean:=false;visible uuid[];superior_view boolean:=true;view_companies uuid[]:='{}'::uuid[];
BEGIN
 IF t IS NULL THEN RETURN;END IF;
 IF app.probation_storage_runner() THEN RETURN QUERY SELECT c.id FROM public.probation_case c WHERE c.tenant_id=t AND (p_cases IS NULL OR c.id=ANY(p_cases));RETURN;END IF;
 IF coalesce(app.probation_active_user(),false) IS NOT TRUE THEN RETURN;END IF;
 -- 5763: the Direct Superiors rule and the companies this viewer's roles cover (one read each).
 SELECT r.can_view INTO superior_view FROM app.probation_superior_rule() r;
 SELECT coalesce(array_agg(x.company_id),'{}'::uuid[]) INTO view_companies FROM app.probation_permitted_companies(me,ARRAY['cases.view','cases.letters','cases.low_result','cases.route']) x;
 SELECT u.person_id,(u.archived_at IS NULL AND NOT app.login_blocked(u.id)) INTO my_person,usable FROM public.app_user u WHERE u.id=me AND u.tenant_id=t;
 IF EXISTS(SELECT 1 FROM public.probation_access m WHERE m.tenant_id=t AND m.user_id=me AND m.role='gbs') THEN
  ops:=coalesce(usable,false) AND coalesce(app.lifecycle_canonical_people_ops_member((SELECT co.id FROM public.company co WHERE co.tenant_id=t ORDER BY co.id LIMIT 1),me),false);
 END IF;
 SELECT coalesce(array_agg(x.id),'{}'::uuid[]) INTO visible FROM (
  WITH cs AS MATERIALIZED (
   SELECT c.id,c.employment_id,c.company_id,e.person_id,coalesce(e.company_id=c.company_id AND c.data->>'sourceCompanyMoved' IS DISTINCT FROM 'true',false) AS current_company
   FROM public.probation_case c LEFT JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
   WHERE c.tenant_id=t AND (p_cases IS NULL OR c.id=ANY(p_cases))),
  ent AS MATERIALIZED (SELECT co.id FROM public.company co WHERE co.tenant_id=t AND co.id IN(SELECT DISTINCT cs.company_id FROM cs) AND app.probation_company_entitled(co.id)),
  live AS MATERIALIZED (SELECT cs.* FROM cs JOIN ent ON ent.id=cs.company_id),
  h AS MATERIALIZED (SELECT * FROM app.probation_routed_holders(ARRAY(SELECT live.employment_id FROM live WHERE live.current_company))),
  gbs AS MATERIALIZED (SELECT m.* FROM public.probation_access m WHERE ops AND m.tenant_id=t AND m.user_id=me AND m.role='gbs' AND m.valid_from<=day AND (m.valid_to IS NULL OR m.valid_to>=day)),
  anc AS MATERIALIZED (SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT h.company_id FROM h WHERE EXISTS(SELECT 1 FROM gbs)))),
  -- Each GBS mapping covers the companies below it, optionally narrowed to a department or unit: decided per company once.
  gbs_cover AS MATERIALIZED (SELECT DISTINCT anc.company_id,m.department_id,m.business_unit_id FROM gbs m JOIN anc ON anc.ancestor_id=m.company_id),
  -- Decision 7: lines on which I am the delegate of a Head of Department or PBP holder, with Probation explicitly ticked.
  general AS MATERIALIZED (
   SELECT d.id AS line_id,hu.id AS holder_id FROM public.reporting_line d
   JOIN public.employment de ON de.id=d.manager_employment_id AND de.tenant_id=d.tenant_id AND de.person_id=my_person
   JOIN public.employment he ON he.id=d.subordinate_employment_id AND he.tenant_id=d.tenant_id
   JOIN public.app_user hu ON hu.person_id=he.person_id AND hu.tenant_id=d.tenant_id
   WHERE d.tenant_id=t AND d.line_type::text='delegate' AND d.superseded_at IS NULL AND d.valid_from<=current_date AND (d.valid_to IS NULL OR d.valid_to>current_date)
    AND EXISTS(SELECT 1 FROM public.reporting_line_scope s WHERE s.reporting_line_id=d.id AND s.tenant_id=d.tenant_id AND s.module='probation')),
  held AS MATERIALIZED (
   SELECT h.employment_id FROM h WHERE me IN(h.employee,h.hod,h.pbp) OR superior_view AND me=h.lm OR me=ANY(h.pbp_users) OR me=ANY(h.hod_users)
    OR EXISTS(SELECT 1 FROM general g JOIN public.reporting_line_scope s ON s.reporting_line_id=g.line_id AND s.tenant_id=t AND s.module='probation'
     WHERE g.holder_id IN(h.hod,h.pbp) AND app.delegation_line_covers(g.line_id,h.employment_id,'probation',coalesce(s.task_type,'probation.approve')))
    OR EXISTS(SELECT 1 FROM gbs_cover g WHERE g.company_id=h.company_id AND (g.department_id IS NULL OR g.department_id=h.department_id) AND (g.business_unit_id IS NULL OR g.business_unit_id=h.business_unit_id))),
  delegated AS MATERIALIZED (
   SELECT DISTINCT p.case_id FROM public.probation_delegate d JOIN public.probation_part p ON p.id=d.part_id AND p.tenant_id=d.tenant_id
   WHERE d.tenant_id=t AND d.holder_id=me AND d.valid_from<=day AND (d.valid_to IS NULL OR d.valid_to>=day)),
  -- 5751 (E4): steps assigned on a Part to a person I am a general Probation delegate for (a group-held GBS step resolves
  -- to its assigned person); the delegation must cover this employee, as for Head of Department and PBP holders.
  assigned AS MATERIALIZED (
   SELECT DISTINCT p.case_id,g.line_id FROM general g
   JOIN public.probation_delegate x ON x.tenant_id=t AND x.holder_id=g.holder_id AND x.kind IN('missing_holder','holder_changed') AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day)
   JOIN public.probation_part p ON p.id=x.part_id AND p.tenant_id=x.tenant_id),
  -- 5755 (decision 7): routed letter steps held by a person I am a general Probation delegate for (open letters only).
  routed AS MATERIALIZED (
   SELECT DISTINCT p.case_id,g.line_id FROM general g
   JOIN public.document_signing_document doc ON doc.tenant_id=t AND doc.subject_type='probation' AND jsonb_typeof(doc.data->'routing')='object'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(doc.data->'route'->'steps')='array' THEN doc.data->'route'->'steps' ELSE '[]'::jsonb END) st WHERE st->>'holderId'=g.holder_id::text)
   JOIN public.probation_part p ON p.id=doc.subject_id AND p.tenant_id=doc.tenant_id AND p.data->>'state' IN('pending_approval','returned'))
  SELECT live.id FROM live WHERE live.current_company AND live.company_id=ANY(view_companies)
  UNION
  SELECT live.id FROM live WHERE NOT live.current_company AND live.person_id=my_person
  UNION
  SELECT live.id FROM live WHERE live.current_company AND (live.employment_id IN(SELECT held.employment_id FROM held) OR live.id IN(SELECT delegated.case_id FROM delegated)
   OR EXISTS(SELECT 1 FROM assigned a JOIN public.reporting_line_scope s ON s.reporting_line_id=a.line_id AND s.tenant_id=t AND s.module='probation'
    WHERE a.case_id=live.id AND app.delegation_line_covers(a.line_id,live.employment_id,'probation',coalesce(s.task_type,'probation.approve')))
   OR EXISTS(SELECT 1 FROM routed r JOIN public.reporting_line_scope s ON s.reporting_line_id=r.line_id AND s.tenant_id=t AND s.module='probation'
    WHERE r.case_id=live.id AND app.delegation_line_covers(r.line_id,live.employment_id,'probation',coalesce(s.task_type,'probation.letter_sign'))))
 ) x;
 RETURN QUERY SELECT unnest(visible);
 -- Residual: an escalated approver on a case that is otherwise invisible to them. Candidates are found as one set (cases
 -- with a part waiting for approval that has a signing document), then checked per candidate.
 RETURN QUERY WITH waiting AS MATERIALIZED (
  SELECT DISTINCT p.case_id FROM public.probation_part p JOIN public.document_signing_document d ON d.tenant_id=p.tenant_id AND d.subject_type='probation' AND d.subject_id=p.id
  WHERE p.tenant_id=t AND p.data->>'state'='pending_approval' AND (p_cases IS NULL OR p.case_id=ANY(p_cases))),
 candidates AS MATERIALIZED (
  SELECT c.id FROM public.probation_case c JOIN waiting w ON w.case_id=c.id
  WHERE c.tenant_id=t AND NOT c.id=ANY(visible) AND app.probation_company_entitled(c.company_id))
 SELECT candidates.id FROM candidates WHERE app.probation_current_escalated_actor(candidates.id);
END $$;
