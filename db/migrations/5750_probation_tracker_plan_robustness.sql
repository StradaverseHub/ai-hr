-- Probation tracker: holder resolution that keeps its speed before the tables have statistics.
-- Tag 5750 / idx 5150 / when 1793330005450 (lane E, Probation Confirmation build).
--
-- 5746's app.probation_holders_set ended in four LEFT JOINs between materialised CTEs (user per employee, Line Manager
-- and Head of Department, and a non-materialised PBP join). With no statistics yet (a fresh install, a large import
-- before autovacuum runs) the planner estimated one row everywhere, chose nested loops and re-evaluated the PBP join
-- for every employment: CI run 43749535180 logged 6.6 s for 1,080 employments, which fell to 36 ms once autovacuum had
-- analysed the tables. The rule is unchanged; only its evaluation shape changes so that no step joins two
-- unanalysed sets: logins, users per employment and the PBP pick are each one jsonb map built once, and every
-- employment looks its four holders up by key. Membership tests take arrays (index or linear scan), and the most
-- specific BP rule is chosen with a window instead of a self-join.
-- Same output for the same input (test/probation-tracker-scale.test.ts compares every viewer with the 0949 rule).
-- No table, row, grant or purpose-owned object changes.
CREATE OR REPLACE FUNCTION app.probation_holders_set(p_employments uuid[]) RETURNS TABLE(employment_id uuid,company_id uuid,department_id uuid,business_unit_id uuid,employee uuid,lm uuid,hod uuid,pbp uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
#variable_conflict use_column
DECLARE t uuid:=app.current_tenant_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;rules_ok boolean:=true;
BEGIN
 IF t IS NULL OR coalesce(cardinality(p_employments),0)=0 THEN RETURN;END IF;
 SELECT coalesce(bool_and(jsonb_typeof(v.data->'bpRules') IS NULL OR jsonb_typeof(v.data->'bpRules')='array'),true) INTO rules_ok FROM public.lc_v9_config v WHERE v.tenant_id=t;
 IF rules_ok THEN
  SELECT coalesce(bool_and((r->'rules' IS NULL OR jsonb_typeof(r->'rules')='object')
   AND (r->'rules'->'company' IS NULL OR jsonb_typeof(r->'rules'->'company')='array')
   AND (r->'rules'->'businessGroup' IS NULL OR jsonb_typeof(r->'rules'->'businessGroup')='array')
   AND (r->'rules'->'department' IS NULL OR jsonb_typeof(r->'rules'->'department')='array')),true) INTO rules_ok
  FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'bpRules','[]'::jsonb)) r WHERE v.tenant_id=t;
 END IF;
 RETURN QUERY
 WITH emp AS MATERIALIZED (
  SELECT e.id,e.person_id,e.company_id,x.department_id,x.business_unit_id,
   (SELECT r.manager_employment_id FROM public.reporting_line r WHERE r.tenant_id=t AND r.subordinate_employment_id=e.id AND r.line_type='administrative'
     AND r.valid_from<=current_date AND (r.valid_to IS NULL OR r.valid_to>current_date) AND r.superseded_at IS NULL LIMIT 1) AS manager_id,
   (SELECT d.head_employment_id FROM public.department d WHERE d.id=x.department_id AND d.tenant_id=e.tenant_id) AS head_id
  FROM public.employment e
  LEFT JOIN LATERAL (SELECT a.department_id,a.business_unit_id FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL
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
 rules AS MATERIALIZED (SELECT r.value AS r FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'bpRules','[]'::jsonb)) r WHERE v.tenant_id=t AND rules_ok),
 bp AS MATERIALIZED (
  SELECT emp.id,emp.company_id,emp.department_id,emp.business_unit_id,rules.r->>'userId' AS user_id,
   (CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) AS score
  FROM emp CROSS JOIN rules
  WHERE (coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)=0 OR rules.r->'rules'->'company' ? emp.company_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)=0 OR rules.r->'rules'->'businessGroup' ? emp.business_unit_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)=0 OR rules.r->'rules'->'department' ? emp.department_id::text)
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(coalesce(rules.r->'rules','{}'::jsonb)) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)),
 -- The most specific matching rule wins only when it names one user (same as 5746's top-score self-join).
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
 pbp AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(bp_user.id::text,bp_user.user_id),'{}'::jsonb) AS m FROM bp_user
  WHERE EXISTS(SELECT 1 FROM pbp_maps m JOIN anc ON anc.ancestor_id=m.company_id
   WHERE anc.company_id=bp_user.company_id AND m.user_id=bp_user.user_id AND (m.department_id IS NULL OR m.department_id=bp_user.department_id) AND (m.business_unit_id IS NULL OR m.business_unit_id=bp_user.business_unit_id)))
 SELECT emp.id,emp.company_id,emp.department_id,emp.business_unit_id,
  (user_for.m->>(emp.id::text))::uuid,(user_for.m->>(emp.manager_id::text))::uuid,(user_for.m->>(emp.head_id::text))::uuid,(pbp.m->>(emp.id::text))::uuid
 FROM emp CROSS JOIN user_for CROSS JOIN pbp;
END $$;
