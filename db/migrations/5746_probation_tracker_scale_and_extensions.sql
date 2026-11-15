-- Probation tracker at real-group scale and a configurable maximum number of extensions.
-- Tag 5746 / idx 5146 / when 1793330005446 (lane C, Probation Confirmation build).
--
-- Row security on probation_case and probation_part calls app.probation_case_access per row, and again for every part a
-- tile counts, so the tracker evaluated the full holder resolution thousands of times per read (72 companies and 1,080
-- cases timed out at 180 s). The access rule now has one owner, app.probation_visible_among(cases), set-based and backed
-- by one set-based holder resolution (app.probation_holders_set, which app.probation_holders now answers from);
-- app.probation_case_access(case) is membership of that set for one case, so row security keeps working unchanged in
-- shape, and the tracker asks for the whole set once per read and for one page of details in one statement.
--
-- The maximum number of extensions becomes a setting (0-2, default 2). The seven owner-owned functions that compared
-- extensionCount with the literal 2 (submission readiness, part commands and their command list, recorded effect,
-- Personnel intent, offline final adjudication, and the company settings publish check) are re-created unchanged
-- except that they read the case's pinned data.config.maxExtensions; cases started before this keep 2.
-- Declined signature (owner decision 16 Nov 2026, handoff B3): the Line Manager records "Declined to sign" with a reason
-- (request_refusal); that fulfils the employee acknowledgement and moves the part on at once. The PBP's confirm task
-- (confirm_refusal) no longer gates the part; confirming records refusal_confirmed and is audited. A part that was
-- already waiting for PBP confirmation when this ships still advances through confirm_refusal (the previous order),
-- or through the Line Manager recording the decline again. The employee never records it.
-- No table, row, grant or purpose-owned object changes.
-- 1. Company ancestry for many companies at once (same walk as app.company_org_descendant_for_tenant, which the
--    access rules otherwise call once per company and mapping pair). Internal.
CREATE FUNCTION app.probation_company_ancestors(p_companies uuid[]) RETURNS TABLE(company_id uuid,ancestor_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE up(company_id,id,path) AS (
  SELECT c.id,c.id,ARRAY[c.id] FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND c.id=ANY(p_companies)
  UNION ALL
  SELECT up.company_id,p.id,up.path||p.id FROM up CROSS JOIN LATERAL (SELECT app.company_org_parent_for_tenant(app.current_tenant_id(),up.id) AS parent_id) x
   JOIN public.company p ON p.id=x.parent_id AND p.tenant_id=app.current_tenant_id() WHERE NOT p.id=ANY(up.path))
 SELECT company_id,id FROM up;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_company_ancestors(uuid[]) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- 2. Holders, set-based. This is now the one owner of the employee / Line Manager / Head of Department / PBP
--    resolution; app.probation_holders(employment) below answers from it for one employment. Same rules as before:
--    a holder is the person's only usable login; the Line Manager comes from the current administrative reporting line;
--    the Head of Department from the current assignment's department; the PBP from the canonical BP rules (most
--    specific unique rule; none when a rule is malformed) with a named login and a current PBP opt-in mapping.
CREATE FUNCTION app.probation_holders_set(p_employments uuid[]) RETURNS TABLE(employment_id uuid,company_id uuid,department_id uuid,business_unit_id uuid,employee uuid,lm uuid,hod uuid,pbp uuid)
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
 linked AS MATERIALIZED (SELECT l.id,l.person_id FROM public.employment l WHERE l.tenant_id=t AND l.id IN(SELECT emp.id FROM emp UNION SELECT emp.manager_id FROM emp UNION SELECT emp.head_id FROM emp)),
 logins AS MATERIALIZED (
  SELECT u.person_id,CASE WHEN count(*)=1 THEN (array_agg(u.id))[1] END AS user_id FROM public.app_user u
  WHERE u.tenant_id=t AND u.person_id IN(SELECT linked.person_id FROM linked) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) GROUP BY u.person_id),
 user_for AS MATERIALIZED (SELECT linked.id,logins.user_id FROM linked JOIN logins ON logins.person_id=linked.person_id),
 rules AS MATERIALIZED (SELECT r.value AS r FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'bpRules','[]'::jsonb)) r WHERE v.tenant_id=t AND rules_ok),
 bp AS MATERIALIZED (
  SELECT emp.id,rules.r->>'userId' AS user_id,
   (CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)>0 THEN 4 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)>0 THEN 2 ELSE 0 END+CASE WHEN coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)>0 THEN 1 ELSE 0 END) AS score
  FROM emp CROSS JOIN rules
  WHERE (coalesce(jsonb_array_length(rules.r->'rules'->'company'),0)=0 OR rules.r->'rules'->'company' ? emp.company_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'businessGroup'),0)=0 OR rules.r->'rules'->'businessGroup' ? emp.business_unit_id::text)
   AND (coalesce(jsonb_array_length(rules.r->'rules'->'department'),0)=0 OR rules.r->'rules'->'department' ? emp.department_id::text)
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(coalesce(rules.r->'rules','{}'::jsonb)) extra WHERE extra.key NOT IN('company','businessGroup','department') AND extra.value<>'[]'::jsonb)),
 bp_top AS (SELECT bp.id,max(bp.score) AS score FROM bp GROUP BY bp.id),
 bp_pick AS (SELECT bp.id,min(bp.user_id) AS user_id FROM bp JOIN bp_top ON bp_top.id=bp.id AND bp_top.score=bp.score GROUP BY bp.id HAVING count(DISTINCT coalesce(bp.user_id,chr(1)))=1),
 bp_user AS MATERIALIZED (
  SELECT bp_pick.id,u.id AS user_id FROM bp_pick JOIN public.app_user u ON u.id=CASE WHEN bp_pick.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN bp_pick.user_id::uuid END
   AND u.tenant_id=t AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id AND length(btrim(n.full_name))>0),
 pbp_maps AS MATERIALIZED (SELECT m.* FROM public.probation_access m WHERE m.tenant_id=t AND m.role='pbp' AND m.user_id IN(SELECT bp_user.user_id FROM bp_user) AND m.valid_from<=day AND (m.valid_to IS NULL OR m.valid_to>=day)),
 anc AS MATERIALIZED (SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT emp.company_id FROM emp JOIN bp_user ON bp_user.id=emp.id))),
 pbp AS (
  SELECT bp_user.id,bp_user.user_id FROM bp_user JOIN emp ON emp.id=bp_user.id
  WHERE EXISTS(SELECT 1 FROM pbp_maps m JOIN anc ON anc.company_id=emp.company_id AND anc.ancestor_id=m.company_id
   WHERE m.user_id=bp_user.user_id AND (m.department_id IS NULL OR m.department_id=emp.department_id) AND (m.business_unit_id IS NULL OR m.business_unit_id=emp.business_unit_id)))
 SELECT emp.id,emp.company_id,emp.department_id,emp.business_unit_id,ue.user_id,ul.user_id,uh.user_id,pbp.user_id
 FROM emp LEFT JOIN user_for ue ON ue.id=emp.id LEFT JOIN user_for ul ON ul.id=emp.manager_id LEFT JOIN user_for uh ON uh.id=emp.head_id LEFT JOIN pbp ON pbp.id=emp.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_holders_set(uuid[]) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_holders(p_employment uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h record;
BEGIN
 SELECT * INTO h FROM app.probation_holders_set(ARRAY[p_employment]);
 IF NOT FOUND THEN RETURN '{}'::jsonb;END IF;
 RETURN jsonb_build_object('employee',h.employee,'lm',h.lm,'hod',h.hod,'pbp',h.pbp,'pbpAmbiguous',false,'companyId',h.company_id,'departmentId',h.department_id,'businessUnitId',h.business_unit_id);
END $$;
--> statement-breakpoint
-- 3. The case access rule, decided for a set of cases (NULL = every case in the tenant). It is the one owner of the
--    rule: app.probation_case_access(case) is membership of this set for one case, row security keeps calling that,
--    and the tracker asks for the whole set once. Storage runner sees all; otherwise only an active user, on an
--    entitled company: on a case whose employment moved company, only the employee themself; on a current case, the
--    employee, Line Manager, Head of Department or PBP holder, a GBS People Ops member with a covering GBS mapping, an
--    active delegate, or (evaluated per case, only where nothing else applies) the escalated approver.
CREATE FUNCTION app.probation_visible_among(p_cases uuid[]) RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();me uuid:=app.current_user_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 my_person uuid;usable boolean:=false;ops boolean:=false;visible uuid[];
BEGIN
 IF t IS NULL THEN RETURN;END IF;
 IF app.probation_storage_runner() THEN RETURN QUERY SELECT c.id FROM public.probation_case c WHERE c.tenant_id=t AND (p_cases IS NULL OR c.id=ANY(p_cases));RETURN;END IF;
 IF coalesce(app.probation_active_user(),false) IS NOT TRUE THEN RETURN;END IF;
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
  h AS MATERIALIZED (SELECT * FROM app.probation_holders_set(ARRAY(SELECT live.employment_id FROM live WHERE live.current_company))),
  gbs AS MATERIALIZED (SELECT m.* FROM public.probation_access m WHERE ops AND m.tenant_id=t AND m.user_id=me AND m.role='gbs' AND m.valid_from<=day AND (m.valid_to IS NULL OR m.valid_to>=day)),
  anc AS MATERIALIZED (SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT h.company_id FROM h WHERE EXISTS(SELECT 1 FROM gbs))))
  SELECT live.id FROM live WHERE NOT live.current_company AND live.person_id=my_person
  UNION
  SELECT live.id FROM live JOIN h ON h.employment_id=live.employment_id WHERE live.current_company AND (
   me IN(h.employee,h.lm,h.hod,h.pbp)
   OR EXISTS(SELECT 1 FROM gbs m JOIN anc ON anc.company_id=h.company_id AND anc.ancestor_id=m.company_id
    WHERE (m.department_id IS NULL OR m.department_id=h.department_id) AND (m.business_unit_id IS NULL OR m.business_unit_id=h.business_unit_id)))
  UNION
  SELECT live.id FROM live WHERE live.current_company AND EXISTS(SELECT 1 FROM public.probation_delegate d JOIN public.probation_part p ON p.id=d.part_id AND p.tenant_id=d.tenant_id
   WHERE p.case_id=live.id AND d.tenant_id=t AND d.holder_id=me AND d.valid_from<=day AND (d.valid_to IS NULL OR d.valid_to>=day))
 ) x;
 RETURN QUERY SELECT unnest(visible);
 RETURN QUERY WITH candidates AS MATERIALIZED (
  SELECT c.id FROM public.probation_case c
  WHERE c.tenant_id=t AND (p_cases IS NULL OR c.id=ANY(p_cases)) AND NOT c.id=ANY(visible) AND app.probation_company_entitled(c.company_id)
   AND EXISTS(SELECT 1 FROM public.probation_part p JOIN public.document_signing_document d ON d.tenant_id=p.tenant_id AND d.subject_type='probation' AND d.subject_id=p.id
    WHERE p.case_id=c.id AND p.tenant_id=c.tenant_id AND p.data->>'state'='pending_approval'))
 SELECT candidates.id FROM candidates WHERE app.probation_current_escalated_actor(candidates.id);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_visible_among(uuid[]) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_case_access(p_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_case IS NOT NULL AND EXISTS(SELECT 1 FROM app.probation_visible_among(ARRAY[p_case]));
$$;
--> statement-breakpoint
CREATE FUNCTION app.probation_visible_case_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_visible_among(NULL);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_visible_case_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_visible_case_ids() TO ai_hr_app;
--> statement-breakpoint
-- 4. Tracker readers. probation_tracker_cases: the visible cases with their review parts (letter parts never carry a
--    due date, band, KPI or override, so no tile reads them). probation_tracker_page: for one page of visible cases,
--    the parts with who is waiting, the letter waiting, and holder names, all set-based.
CREATE FUNCTION app.probation_tracker_cases() RETURNS TABLE(id uuid,tenant_id uuid,company_id uuid,employment_id uuid,revision integer,data jsonb,review_parts jsonb,pbp_name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH v AS MATERIALIZED (SELECT app.probation_visible_case_ids() AS id),
 parts AS MATERIALIZED (SELECT p.case_id,jsonb_agg(p.data ORDER BY p.id) AS parts FROM public.probation_part p
  WHERE p.tenant_id=app.current_tenant_id() AND p.case_id IN(SELECT v.id FROM v) AND coalesce(p.data->>'documentKind','review')='review' GROUP BY p.case_id)
 SELECT c.id,c.tenant_id,c.company_id,c.employment_id,c.revision,c.data,coalesce(parts.parts,'[]'::jsonb),n.full_name
 FROM public.probation_case c LEFT JOIN parts ON parts.case_id=c.id
 LEFT JOIN public.app_user u ON u.id=CASE WHEN c.data->'facts'->'holders'->>'pbp' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c.data->'facts'->'holders'->>'pbp')::uuid END AND u.tenant_id=c.tenant_id
 LEFT JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id
 WHERE c.tenant_id=app.current_tenant_id() AND c.id IN(SELECT v.id FROM v);
$$;
--> statement-breakpoint
CREATE FUNCTION app.probation_tracker_page(p_cases uuid[]) RETURNS TABLE(case_id uuid,parts jsonb,letter jsonb,names jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
#variable_conflict use_column
DECLARE t uuid:=app.current_tenant_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;allowed uuid[];
BEGIN
 IF t IS NULL OR coalesce(cardinality(p_cases),0) NOT BETWEEN 1 AND 200 THEN RETURN;END IF;
 allowed:=ARRAY(SELECT app.probation_visible_among(p_cases));
 RETURN QUERY
 WITH c AS MATERIALIZED (SELECT pc.id,pc.employment_id,pc.company_id,pc.tenant_id,pc.data FROM public.probation_case pc WHERE pc.tenant_id=t AND pc.id=ANY(allowed)),
 cur AS MATERIALIZED (SELECT c.id,c.employment_id FROM c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id WHERE c.data->>'sourceCompanyMoved' IS DISTINCT FROM 'true'),
 h AS MATERIALIZED (SELECT * FROM app.probation_holders_set(ARRAY(SELECT cur.employment_id FROM cur))),
 parts AS (
  SELECT p.case_id,jsonb_agg(jsonb_build_object('id',p.id,'type',(p.data->>'type')::integer,'cycle',(p.data->>'cycle')::integer,'state',p.data->>'state','dueOn',p.data->>'dueOn','managerSubmittedAt',p.data->>'managerSubmittedAt','staffSubmittedAt',p.data->>'staffSubmittedAt','acknowledgedAt',p.data->>'acknowledgedAt','scoreBand',(p.data->>'scoreBand')::integer,'override',coalesce((p.data->>'override')::boolean,false),
   'waitingRole',CASE WHEN p.data->>'state' IN('locked','completed_offline','cancelled','not_issued') THEN NULL WHEN p.data->>'type'<>'1' AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'employeeWaitException' IS NULL THEN 'employee' WHEN p.data->>'managerSubmittedAt' IS NULL THEN 'lm' WHEN p.data->>'acknowledgedAt' IS NULL THEN 'employee'
    ELSE coalesce((SELECT s->>'role' FROM public.document_signing_document d CROSS JOIN LATERAL jsonb_array_elements(d.data->'route'->'steps') s WHERE d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id AND NOT app.document_signing_step_fulfilled(d.data,s) AND s->>'coveredByStepId' IS NULL ORDER BY (s->>'stage')::integer,s->>'id' LIMIT 1),'gbs') END,
   'waitingName',NULL) ORDER BY (p.data->>'cycle')::integer,(p.data->>'type')::integer,p.id) AS parts
  FROM public.probation_part p WHERE p.tenant_id=t AND p.case_id=ANY(allowed) AND coalesce(p.data->>'documentKind','review')='review' GROUP BY p.case_id),
 names AS (
  SELECT x.case_id,jsonb_agg(DISTINCT jsonb_build_object('role',x.role,'name',x.name)) AS names FROM (
   SELECT cur.id AS case_id,r.role,n.full_name AS name FROM cur JOIN h ON h.employment_id=cur.employment_id
    CROSS JOIN LATERAL (VALUES('employee',h.employee),('lm',h.lm),('hod',h.hod),('pbp',h.pbp)) r(role,user_id)
    JOIN public.app_user u ON u.id=r.user_id AND u.tenant_id=t JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id
   UNION ALL
   SELECT cur.id,x.step_id,n.full_name FROM cur JOIN public.probation_part r ON r.case_id=cur.id AND r.tenant_id=t
    JOIN public.probation_delegate x ON x.part_id=r.id AND x.tenant_id=t AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day)
    JOIN public.app_user u ON u.id=x.holder_id AND u.tenant_id=t JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id
   UNION ALL
   -- Escalated holders, only for parts that can be waiting on someone (the tracker names no one on settled parts).
   SELECT cur.id,s->>'role',n.full_name FROM cur JOIN public.probation_part part ON part.case_id=cur.id AND part.tenant_id=t
    AND part.data->>'state' NOT IN('locked','completed_offline','cancelled','not_issued')
    CROSS JOIN LATERAL jsonb_array_elements(app.probation_resolve_route_unchecked(part.id)->'steps') s
    JOIN public.app_user u ON u.id=(s->>'holderId')::uuid AND u.tenant_id=part.tenant_id JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id
    WHERE s->>'representedId' IS NOT NULL
  ) x GROUP BY x.case_id)
 SELECT c.id,coalesce(parts.parts,'[]'::jsonb),
  CASE WHEN EXISTS(SELECT 1 FROM public.probation_part l WHERE l.case_id=c.id AND l.tenant_id=t AND l.data->>'documentKind'='letter') THEN (SELECT to_jsonb(lt) FROM app.probation_letter_tasks(c.id) lt LIMIT 1) END,
  coalesce(names.names,'[]'::jsonb)
 FROM c LEFT JOIN parts ON parts.case_id=c.id LEFT JOIN names ON names.case_id=c.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_tracker_cases(),app.probation_tracker_page(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_tracker_cases(),app.probation_tracker_page(uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- 5. Maximum extensions is a setting (0 to 2, default 2). Every rule that counted against the literal 2 reads the value
--    the case pinned in data.config when it started; running cases keep their pinned value.
CREATE FUNCTION app.probation_max_extensions(p_case_data jsonb) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_case_data->'config'->'maxExtensions')='number' AND (p_case_data->'config'->>'maxExtensions') IN('0','1','2') THEN (p_case_data->'config'->>'maxExtensions')::integer ELSE 2 END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_max_extensions(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_max_extensions(jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_submission_ready(p_part uuid,p_role text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;form jsonb;v jsonb;k jsonb;score integer;band integer;suggestion text;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;SELECT data INTO form FROM probation_configuration WHERE id=c.form_id AND tenant_id=c.tenant_id;
 SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=p.tenant_id AND rater=p_role;
 IF p_role='employee' THEN RETURN (p.data->>'type')::integer<>1 AND app.probation_assessment_ready(form,v->'employee',false);END IF;
 IF p_role<>'lm' OR v IS NULL THEN RETURN false;END IF;
 IF p.data->>'type'='1' THEN
 IF jsonb_typeof(v->'kpis')<>'array' OR jsonb_array_length(v->'kpis') NOT BETWEEN 1 AND 5 THEN RETURN false;END IF;
 FOR k IN SELECT value FROM jsonb_array_elements(v->'kpis') LOOP IF length(btrim(coalesce(k->>'accountability','')))=0 OR length(btrim(coalesce(k->>'measure','')))=0 OR length(btrim(coalesce(k->>'target','')))=0 OR k->>'targetDate' !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN false;END IF;PERFORM (k->>'targetDate')::date;END LOOP;
 RETURN length(btrim(coalesce(v->'support'->>'coaching','')))>0 AND length(btrim(coalesce(v->'support'->>'access','')))>0 AND length(btrim(coalesce(v->'support'->>'checkins','')))>0 AND length(btrim(coalesce(v->'support'->>'other','')))>0;
 END IF;
 IF NOT app.probation_assessment_ready(form,v->'manager',c.data->>'kpiAcknowledged'<>'true' AND c.data->'config'->>'kpiGate'='warn') OR coalesce(p.data->>'reviewOn','') !~ '^\d{4}-\d{2}-\d{2}$' OR p.data->>'conductedBy' IS NULL THEN RETURN false;END IF;
 PERFORM (p.data->>'reviewOn')::date;
 IF c.data->'config'->>'lmWaitsForEmployee'='true' AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'employeeWaitException' IS NULL THEN RETURN false;END IF;
 score:=app.probation_score(form,v->'manager');SELECT (b->>'band')::integer INTO band FROM jsonb_array_elements(form->'bands') b WHERE score>=(b->>'min')::integer ORDER BY (b->>'min')::integer DESC LIMIT 1;
 IF p.data->>'type'='2' THEN
 IF length(btrim(coalesce(v->>'strengths','')))=0 OR length(btrim(coalesce(v->>'development','')))=0 OR length(btrim(coalesce(v->>'managerComments','')))=0 OR coalesce(v->>'midpointStatus','') NOT IN('satisfactory','development','at_risk') THEN RETURN false;END IF;
 suggestion:=CASE WHEN band>=3 THEN 'satisfactory' WHEN band=2 THEN 'development' ELSE 'at_risk' END;
 RETURN v->>'midpointStatus'=suggestion OR length(btrim(coalesce(v->>'justification','')))>0;
 END IF;
 IF coalesce(v->>'outcome','') NOT IN('confirm','extend','not_confirm','other') OR length(btrim(coalesce(v->>'justification','')))=0 THEN RETURN false;END IF;
 IF v->>'outcome'='extend' AND ((c.data->>'extensionCount')::integer>=app.probation_max_extensions(c.data) OR coalesce(v->>'extensionMonths','') NOT IN('3','6')) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_config_write_legacy_organisation(p_company uuid,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n integer;v_id uuid;route jsonb;part integer;rule jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_config_admin(p_company) OR p_kind NOT IN('settings','form','route') OR jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Named probation administrator required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||p_company::text||p_kind,0));
 IF p_expected IS NULL OR p_expected<>(SELECT coalesce(max(version),0) FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind=p_kind) THEN RAISE EXCEPTION 'Probation configuration changed; reload before saving';END IF;
 IF p_publish AND p_kind='form' THEN
 IF p_data?'targetGrades' AND (jsonb_typeof(p_data->'targetGrades')<>'array' OR jsonb_array_length(p_data->'targetGrades')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_data->'targetGrades') g WHERE g NOT IN('12','13','14','15','16','17','18','19','20','21','22','23','H'))) THEN RAISE EXCEPTION 'Choose explicit supported form grades';END IF;
 IF EXISTS(SELECT 1 FROM probation_configuration f WHERE f.tenant_id=app.current_tenant_id() AND f.company_id=p_company AND f.kind='form' AND f.state='published' AND app.probation_is_current_publication('form',f.id) AND coalesce(f.data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]')<>coalesce(p_data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]') AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(f.data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]')) g WHERE coalesce(p_data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]')?g)) THEN RAISE EXCEPTION 'Form grade variants must be disjoint; revise the same grade set or publish a distinct H form';END IF;
 IF jsonb_typeof(p_data->'criteria') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'criteria') NOT BETWEEN 1 AND 30 OR jsonb_typeof(p_data->'ratingLabels') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'ratingLabels') IS DISTINCT FROM 5 OR jsonb_typeof(p_data->'bands') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'bands') IS DISTINCT FROM 5 THEN RAISE EXCEPTION 'Complete the form criteria, rating labels and bands';END IF;
 IF (SELECT sum((c->>'weight')::integer) FROM jsonb_array_elements(p_data->'criteria') c) IS DISTINCT FROM 100 OR (SELECT sum((c->>'weight')::integer) FROM jsonb_array_elements(p_data->'criteria') c WHERE c->>'section'='role') IS DISTINCT FROM 50 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'criteria') c WHERE c->>'section' NOT IN('role','principles') OR coalesce(c->>'weight','') !~ '^[0-9]+$' OR c->>'id' !~ '^[a-z][a-z0-9_]{0,39}$' OR (c->>'weight')::integer NOT BETWEEN 1 AND 100 OR length(btrim(coalesce(c->>'title','')))=0 OR length(btrim(coalesce(c->>'standard','')))=0 OR length(btrim(coalesce(c->>'prompt','')))=0) OR (SELECT count(DISTINCT c->>'id') FROM jsonb_array_elements(p_data->'criteria') c)<>jsonb_array_length(p_data->'criteria') THEN RAISE EXCEPTION 'Form weights, identities and guidance are invalid';END IF;
 END IF;
 IF p_kind='settings' THEN
  p_data:=p_data||jsonb_build_object('gradeHFormPublished',EXISTS(SELECT 1 FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='form' AND state='published' AND app.probation_is_current_publication('form',id) AND data->'targetGrades'?'H'));
 END IF;
 IF p_publish AND p_kind='settings' THEN
 IF jsonb_typeof(p_data->'eligibleGrades') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'eligibleGrades')=0
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_data->'eligibleGrades') AS grade(code) WHERE grade.code !~ '^(1[2-9]|2[0-3])$')
 OR (SELECT count(DISTINCT grade.code) FROM jsonb_array_elements_text(p_data->'eligibleGrades') AS grade(code))<>jsonb_array_length(p_data->'eligibleGrades') THEN RAISE EXCEPTION 'Choose distinct eligible grades 12 through 23; Grade H requires its separate published-form switch';END IF;
 IF coalesce(p_data->>'kpiGate','') NOT IN('block','warn','off') OR coalesce(p_data->>'maxExtensions','') NOT IN('0','1','2') OR p_data->'extensionMonths' IS DISTINCT FROM '[3,6]'::jsonb OR p_data->>'gradeHEnabled'='true' AND NOT EXISTS(SELECT 1 FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='form' AND state='published' AND app.probation_is_current_publication('form',id) AND data->'targetGrades'?'H') THEN RAISE EXCEPTION 'Check probation settings and Grade H form readiness';END IF;
 END IF;
 IF p_publish AND p_kind='route' THEN
 IF p_data?'duplicateRolePolicy' AND (jsonb_typeof(p_data->'duplicateRolePolicy') IS DISTINCT FROM 'object'
  OR coalesce(p_data->'duplicateRolePolicy'->>'mode','') NOT IN('escalate','sign_once','named_alternate')
  OR p_data->'duplicateRolePolicy'->>'mode'='named_alternate' AND NOT EXISTS(
   SELECT 1 FROM app_user alternate JOIN employment employment_scope ON employment_scope.tenant_id=alternate.tenant_id AND employment_scope.person_id=alternate.person_id
   WHERE alternate.id=(p_data->'duplicateRolePolicy'->>'alternateUserId')::uuid AND alternate.tenant_id=app.current_tenant_id()
    AND employment_scope.company_id=p_company AND employment_scope.terminated_on IS NULL AND alternate.archived_at IS NULL AND NOT app.login_blocked(alternate.id))) THEN
  RAISE EXCEPTION 'Select a supported duplicate-role policy and an active scoped alternate when required';
 END IF;
 FOR part IN 1..3 LOOP route:=p_data->'parts'->part::text;PERFORM app.probation_validate_evaluation_route(route,part);IF (SELECT count(*) FROM jsonb_array_elements(route->'steps') s WHERE s->>'role'='lm' AND s->>'kind'='sign')<>1 OR (SELECT count(*) FROM jsonb_array_elements(route->'steps') s WHERE s->>'role'='employee' AND s->>'kind'='acknowledge')<>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') s WHERE s->>'role'='employee' AND (s->>'stage')::integer<=(SELECT (m->>'stage')::integer FROM jsonb_array_elements(route->'steps') m WHERE m->>'role'='lm')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') s WHERE s->>'role' NOT IN('lm','employee') AND (s->>'stage')::integer<=(SELECT (m->>'stage')::integer FROM jsonb_array_elements(route->'steps') m WHERE m->>'role'='lm')) THEN RAISE EXCEPTION 'Probation routes must sign as manager before employee acknowledgement and later approvers';END IF;PERFORM app.document_signing_validate(jsonb_build_object('route',route,'actions','[]'::jsonb),jsonb_build_object('requiredRoles',jsonb_build_array('lm','employee'))||CASE WHEN part=3 THEN jsonb_build_object('independentApprovalFromRole','lm') ELSE '{}'::jsonb END);END LOOP;
 FOR rule IN SELECT value FROM jsonb_array_elements(coalesce(p_data->'rules','[]')) LOOP PERFORM app.probation_validate_evaluation_route(rule->'route',(rule->>'part')::integer);END LOOP;
 END IF;
 SELECT coalesce(max(version),0)+1 INTO n FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind=p_kind;
 INSERT INTO probation_configuration(tenant_id,company_id,kind,version,state,data,created_by,published_by,published_at) VALUES(app.current_tenant_id(),p_company,p_kind,n,CASE WHEN p_publish THEN 'published' ELSE 'draft' END,jsonb_set(p_data,'{version}',to_jsonb(n)),app.current_user_id(),CASE WHEN p_publish THEN app.current_user_id() END,CASE WHEN p_publish THEN now() END) RETURNING probation_configuration.id INTO v_id;
 RETURN v_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_part_command(p_part uuid,p_expected integer,p_command text,p_args jsonb DEFAULT '{}') RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;v jsonb;meta jsonb;reason text:=btrim(coalesce(p_args->>'reason',''));signed jsonb;form jsonb;score integer;band integer;suggestion text;actor uuid:=app.current_user_id();changed_content boolean:=false;old_letter uuid;paper record;paper_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RAISE EXCEPTION 'Probation review unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id FOR UPDATE;PERFORM app.probation_assert_case_runtime(c.id);
 IF p.revision IS DISTINCT FROM p_expected OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN RAISE EXCEPTION 'This probation revision changed or is closed';END IF;
 IF p.data->>'state' IN('locked','recorded','completed_offline','cancelled') AND NOT(p_command='unlock' AND p.data->>'state'<>'cancelled' OR p_command='record' AND p.data->>'state'='completed_offline') THEN RAISE EXCEPTION 'This historical review can only be reopened through its authorised route';END IF;
 meta:=p.data;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 IF p_command='submit_employee' THEN
 IF NOT app.probation_role(c.employment_id,'employee') OR p.data->>'state' NOT IN('issued','returned') OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'managerSubmittedAt' IS NOT NULL OR app.probation_submission_ready(p.id,'employee') IS NOT TRUE THEN RAISE EXCEPTION 'Complete and submit your own self-assessment first';END IF;
 meta:=meta||jsonb_build_object('staffSubmittedAt',now(),'state','staff_submitted');
 ELSIF p_command='submit_manager' THEN
 IF app.probation_part_role(p.id,'lm') IS NOT TRUE OR p.data->>'state' IN('not_issued','locked','recorded','completed_offline','cancelled') OR p.data->>'managerSubmittedAt' IS NOT NULL OR app.probation_submission_ready(p.id,'lm') IS NOT TRUE THEN RAISE EXCEPTION 'Complete the manager fields before signing and submitting';END IF;
 IF d.id IS NULL OR d.data->>'contentHash'<>encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'='lm' AND a->>'actorId'=actor::text AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN RAISE EXCEPTION 'The current manager signature is required';END IF;
 meta:=meta||jsonb_build_object('managerSubmittedAt',now(),'state','pending_ack');
 IF p.data->>'type'<>'1' THEN SELECT data INTO form FROM probation_configuration WHERE id=c.form_id;SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND rater='lm';score:=app.probation_score(form,v->'manager');SELECT (b->>'band')::integer INTO band FROM jsonb_array_elements(form->'bands') b WHERE score>=(b->>'min')::integer ORDER BY (b->>'min')::integer DESC LIMIT 1;suggestion:=CASE WHEN p.data->>'type'='2' THEN CASE WHEN band>=3 THEN 'satisfactory' WHEN band=2 THEN 'development' ELSE 'at_risk' END ELSE CASE WHEN band>=3 THEN 'confirm' WHEN band=2 THEN 'extend' ELSE 'not_confirm' END END;meta:=meta||jsonb_build_object('scoreBand',band,'scoreHundredths',score,'override',coalesce(v->>'midpointStatus',v->>'outcome')<>suggestion);END IF;
 UPDATE probation_case SET data=data||jsonb_build_object('state','pending_approval'),revision=revision+1 WHERE id=c.id;
 ELSIF p_command='confirm_refusal' AND p.data->>'acknowledgedAt' IS NOT NULL THEN
 -- Owner decision 16 Nov 2026 (handoff B3): the declined signature already moved the part on; the PBP confirms it.
 IF app.probation_role(c.employment_id,'pbp') IS NOT TRUE OR length(reason)<3 OR NOT EXISTS(SELECT 1 FROM probation_followup WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='refusal_request' AND content_revision=p.content_revision)
  OR EXISTS(SELECT 1 FROM probation_followup WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='refusal_confirmed' AND content_revision=p.content_revision) THEN RAISE EXCEPTION 'Only the current PBP confirms a recorded declined signature once';END IF;
 INSERT INTO probation_followup(tenant_id,case_id,part_id,actor_user_id,kind,note,content_revision) VALUES(p.tenant_id,c.id,p.id,actor,'refusal_confirmed',reason,p.content_revision);
 ELSIF p_command IN('acknowledge','confirm_refusal') THEN
 IF p.data->>'managerSubmittedAt' IS NULL OR p.data->>'acknowledgedAt' IS NOT NULL THEN RAISE EXCEPTION 'Manager submission is required before acknowledgement';END IF;
 IF p_command='acknowledge' AND NOT app.probation_role(c.employment_id,'employee') OR p_command='confirm_refusal' AND NOT app.probation_role(c.employment_id,'pbp') THEN RAISE EXCEPTION 'Acknowledgement authority required';END IF;
 SELECT a INTO signed FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'='employee' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash' AND (p_command='acknowledge' AND a->>'action'='signed' AND a->>'actorId'=actor::text OR p_command='confirm_refusal' AND a->>'action'='declined') ORDER BY a->>'at' DESC LIMIT 1;
 IF signed IS NULL OR d.data->>'contentHash'<>encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'The current signed acknowledgement or recorded refusal is required';END IF;
 IF p_command='acknowledge' THEN SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=p.tenant_id AND rater='employee';SELECT data INTO form FROM probation_configuration WHERE id=c.form_id AND tenant_id=c.tenant_id;IF coalesce(signed->>'comment','') IS DISTINCT FROM coalesce(v->>'employeeComments','') OR p.data->>'type'<>'1' AND form->>'employeeCommentsRequired'='true' AND length(btrim(coalesce(v->>'employeeComments','')))=0 THEN RAISE EXCEPTION 'Acknowledge the exact saved employee comment and complete every required contribution';END IF;END IF;
 meta:=meta||jsonb_build_object('acknowledgedAt',now(),'state',CASE WHEN p.data->>'type'='1' THEN 'locked' ELSE 'pending_approval' END,'pdfPending',p.data->>'type'='1');
 IF p.data->>'type'='1' THEN UPDATE probation_case SET data=data||jsonb_build_object('kpiAcknowledged',true,'state','in_review'),revision=revision+1 WHERE id=c.id;END IF;
 ELSIF p_command='return' THEN
 IF length(reason)<3 OR p.data->>'managerSubmittedAt' IS NULL THEN RAISE EXCEPTION 'A return needs comments and a submitted review';END IF;
 IF p.data->>'type'='1' AND NOT app.probation_role(c.employment_id,'employee') OR p.data->>'type'<>'1' AND NOT(app.probation_part_role(p.id,'employee') OR app.probation_part_role(p.id,'hod') OR app.probation_part_role(p.id,'pbp')) THEN RAISE EXCEPTION 'Only a current reviewer may return this part';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'action'='returned' AND a->>'actorId'=actor::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN RAISE EXCEPTION 'The current signing step must record this return';END IF;
 meta:=(meta-ARRAY['scoreBand','scoreHundredths','override','signingFacts','signingPeriod','signingKpis'])||jsonb_build_object('state','returned','managerSubmittedAt',NULL,'acknowledgedAt',NULL);changed_content:=true;
 ELSIF p_command='record' THEN
 IF p.data->>'state'='completed_offline' THEN
  IF app.probation_role(c.employment_id,'gbs') IS NOT TRUE OR app.probation_offline_record_ready(p.id) IS NOT TRUE THEN RAISE EXCEPTION 'Current GBS may record only the exact filed, PBP-attested original final decision';END IF;
  SELECT * INTO paper FROM probation_offline_final_proposal WHERE part_id=p.id AND tenant_id=p.tenant_id AND superseded_at IS NULL AND accepted_at IS NULL FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM app_user gbs JOIN app_user pbp ON pbp.id=paper.proposed_by AND pbp.tenant_id=gbs.tenant_id WHERE gbs.id=actor AND gbs.tenant_id=p.tenant_id AND gbs.person_id IS NOT NULL AND pbp.person_id IS NOT NULL AND (gbs.person_id IS DISTINCT FROM (SELECT person_id FROM app_user WHERE id=(app.probation_holders(c.employment_id)->>'lm')::uuid) OR pbp.person_id IS DISTINCT FROM (SELECT person_id FROM app_user WHERE id=(app.probation_holders(c.employment_id)->>'lm')::uuid))) THEN RAISE EXCEPTION 'A verified actual HR recorder and an independent approving person are required for paper evidence';END IF;
  UPDATE probation_offline_final_proposal SET accepted_by=actor,accepted_at=now() WHERE id=paper.id;paper_id:=paper.id;v:=jsonb_build_object('outcome',paper.outcome,'extensionMonths',paper.extension_months,'justification',paper.reason);meta:=meta||jsonb_build_object('recordedAt',now(),'recordedBy',actor,'offlineProposalId',paper_id,'pbpExtensionConfirmed',paper.outcome='extend','pdfPending',false);
 ELSE
 IF NOT app.probation_role(c.employment_id,'gbs') OR p.data->>'state'<>'pending_approval' OR NOT app.probation_signatures_complete(p.id) THEN RAISE EXCEPTION 'GBS may record only a fully signed current review';END IF;
 SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND rater='lm';
 IF p.data->>'type'='3' AND (p.data->'signingPeriod'->>'endOn' IS DISTINCT FROM c.data->>'endOn' OR p.data->'signingPeriod'->>'startOn' IS DISTINCT FROM c.data->>'startOn') THEN RAISE EXCEPTION 'A changed final review period requires reasoned PBP unlock and fresh signatures';END IF;
 IF p.data->>'type'='3' AND v->>'outcome'='extend' AND p.data->>'pbpExtensionConfirmed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PBP must confirm the extension length';END IF;
 meta:=meta||jsonb_build_object('state','locked','recordedAt',now(),'recordedBy',actor,'pdfPending',true);END IF;
 IF p.data->>'type'='3' THEN
 UPDATE probation_case SET data=data||jsonb_build_object('state','outcome_pending','pendingOutcome',v->>'outcome'),revision=revision+1 WHERE id=c.id;
 INSERT INTO probation_outcome(case_id,tenant_id,part_id,outcome,revision,state,source_key,offline_proposal_id) VALUES(c.id,c.tenant_id,p.id,v->>'outcome',(p.data->>'cycle')::integer+1,'pending','probation:'||c.id::text||':'||p.id::text,paper_id) ON CONFLICT(part_id) DO UPDATE SET outcome=excluded.outcome,offline_proposal_id=excluded.offline_proposal_id,revision=probation_outcome.revision+1,state='pending',template_id=NULL,template_version=NULL,merge_data=NULL,letter_file_id=NULL,letter_part_id=NULL,failure=NULL,updated_at=now() WHERE probation_outcome.released_at IS NULL AND probation_outcome.movement_ref IS NULL AND probation_outcome.handoff_ref IS NULL;
 ELSE UPDATE probation_case SET data=data||jsonb_build_object('state','in_review'),revision=revision+1 WHERE id=c.id;END IF;
 ELSIF p_command='kpi_exception' THEN
 IF NOT app.probation_role(c.employment_id,'pbp') OR length(reason)<3 OR p.data->>'type'='1' OR p.data->>'state'<>'not_issued' OR c.data->>'kpiAcknowledged'='true' OR c.data->'config'->>'kpiGate' IS DISTINCT FROM 'block' THEN RAISE EXCEPTION 'A current blocked KPI gate and PBP reason are required';END IF;meta:=meta||jsonb_build_object('kpiException',reason);
 ELSIF p_command='employee_wait_exception' THEN
 IF NOT app.probation_role(c.employment_id,'pbp') OR length(reason)<3 OR (p.data->>'dueOn')::date>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'managerSubmittedAt' IS NOT NULL OR p.data->>'type'='1' OR p.data->>'state' NOT IN('issued','returned') OR c.data->'config'->>'lmWaitsForEmployee' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Only PBP may release an overdue employee step with a reason';END IF;meta:=meta||jsonb_build_object('employeeWaitException',reason);
 ELSIF p_command='confirm_extension' THEN
 IF NOT app.probation_role(c.employment_id,'pbp') OR coalesce(p_args->>'months','') NOT IN('3','6') OR (c.data->>'extensionCount')::integer>=app.probation_max_extensions(c.data) OR p.data->>'managerSubmittedAt' IS NULL THEN RAISE EXCEPTION 'PBP may confirm only a submitted valid extension';END IF;
 SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND rater='lm' FOR UPDATE;IF v->>'outcome'<>'extend' THEN RAISE EXCEPTION 'The manager has not recommended an extension';END IF;
 IF v->>'extensionMonths'<>p_args->>'months' THEN
 IF length(reason)<3 THEN RAISE EXCEPTION 'Explain the changed extension length';END IF;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'lm',p.revision,v,actor,reason);
 UPDATE probation_rater_draft SET data=jsonb_set(data,'{extensionMonths}',p_args->'months') WHERE part_id=p.id AND rater='lm';
 meta:=(meta-ARRAY['scoreBand','scoreHundredths','override','signingFacts','signingPeriod','signingKpis'])||jsonb_build_object('state','returned','managerSubmittedAt',NULL,'acknowledgedAt',NULL);changed_content:=true;
 END IF;meta:=meta||jsonb_build_object('pbpExtensionConfirmed',true,'pbpExtensionConfirmedBy',actor);
 ELSIF p_command='unlock' THEN
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR length(reason)<3 OR coalesce(p_args->>'owner','') NOT IN('employee','lm') THEN RAISE EXCEPTION 'A field owner and PBP/GBS unlock reason are required';END IF;
 IF EXISTS(SELECT 1 FROM probation_outcome WHERE tenant_id=p.tenant_id AND part_id=p.id AND (released_at IS NOT NULL OR movement_ref IS NOT NULL OR handoff_ref IS NOT NULL)) THEN RAISE EXCEPTION 'This outcome has been acted on; use the authorised employment correction process';END IF;
 SELECT letter_part_id INTO old_letter FROM probation_outcome WHERE tenant_id=p.tenant_id AND part_id=p.id;IF old_letter IS NOT NULL THEN PERFORM 1 FROM probation_part WHERE id=old_letter AND tenant_id=p.tenant_id FOR UPDATE;IF EXISTS(SELECT 1 FROM probation_outcome WHERE part_id=p.id AND tenant_id=p.tenant_id AND released_at IS NOT NULL) THEN RAISE EXCEPTION 'The letter was released; use the authorised employment correction process';END IF;UPDATE probation_part SET data=jsonb_set(data,'{state}','"cancelled"'),revision=revision+1 WHERE id=old_letter;END IF;
 UPDATE probation_outcome SET state='pending',offline_proposal_id=NULL,letter_part_id=NULL,letter_file_id=NULL,template_id=NULL,template_version=NULL,merge_data=NULL,failure='The evaluation was reopened; a new approved letter generation is required.',revision=revision+1,updated_at=now() WHERE part_id=p.id AND tenant_id=p.tenant_id AND released_at IS NULL;
 IF p_args->>'owner'='lm' AND p.data?'signingPeriod' AND (p.data->'signingPeriod'->>'endOn' IS DISTINCT FROM c.data->>'endOn' OR p.data->'signingPeriod'->>'startOn' IS DISTINCT FROM c.data->>'startOn') THEN RAISE EXCEPTION 'Reopen the employee field owner first when the review period changed';END IF;
 meta:=(meta-ARRAY['scoreBand','scoreHundredths','override','signingFacts','signingPeriod','signingKpis'])||jsonb_build_object('state','returned','managerSubmittedAt',NULL,'acknowledgedAt',NULL,'unlockOwner',p_args->>'owner');IF p_args->>'owner'='employee' THEN meta:=jsonb_set(meta,'{staffSubmittedAt}','null'::jsonb);END IF;changed_content:=true;
 IF p.data->>'type'='1' THEN UPDATE probation_case SET data=jsonb_set(data,'{kpiAcknowledged}','false'::jsonb),revision=revision+1 WHERE id=c.id;END IF;
 ELSIF p_command='request_refusal' THEN
 IF app.probation_part_role(p.id,'lm') IS NOT TRUE OR length(reason)<3 OR p.data->>'managerSubmittedAt' IS NULL OR p.data->>'acknowledgedAt' IS NOT NULL THEN RAISE EXCEPTION 'The current manager must explain the employee refusal';END IF;
 -- The Line Manager's recorded "Declined to sign" fulfils the employee acknowledgement and moves the part on at once.
 SELECT a INTO signed FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'='employee' AND a->>'action'='declined' AND a->>'actorId'=actor::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash' ORDER BY a->>'at' DESC LIMIT 1;
 IF signed IS NULL OR d.data->>'contentHash'<>encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'Record the declined signature on the current review first';END IF;
 INSERT INTO probation_followup(tenant_id,case_id,part_id,actor_user_id,kind,note,content_revision) VALUES(p.tenant_id,c.id,p.id,actor,'refusal_request',reason,p.content_revision);
 meta:=meta||jsonb_build_object('acknowledgedAt',now(),'state',CASE WHEN p.data->>'type'='1' THEN 'locked' ELSE 'pending_approval' END,'pdfPending',p.data->>'type'='1');
 IF p.data->>'type'='1' THEN UPDATE probation_case SET data=data||jsonb_build_object('kpiAcknowledged',true,'state','in_review'),revision=revision+1 WHERE id=c.id;END IF;
 ELSE RAISE EXCEPTION 'Unknown probation command';END IF;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision,p.data,actor,coalesce(nullif(reason,''),p_command));
 UPDATE probation_part SET data=meta,revision=revision+1,content_revision=content_revision+CASE WHEN changed_content THEN 1 ELSE 0 END,updated_at=now() WHERE id=p.id;
 IF meta->>'state'='locked' THEN PERFORM app.probation_enqueue_review_pdf(p.id,'Completed authenticated probation review');END IF;
 PERFORM app.probation_audit(c.id,p.id,p_command,reason);RETURN p.revision+1;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_record_effect(p_outcome uuid,p_movement text,p_handoff uuid,p_next jsonb,p_new_part jsonb DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;e employment;part jsonb;pid uuid;form jsonb;route jsonb;start_day date;end_day date;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id FOR UPDATE;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id;
 IF NOT(app.probation_role(e.id,'gbs') OR app.probation_storage_runner()) OR NOT EXISTS(SELECT 1 FROM probation_file f JOIN employee_document doc ON doc.id=f.employee_document_id AND doc.tenant_id=f.tenant_id WHERE f.id=o.letter_file_id AND f.tenant_id=o.tenant_id AND doc.employment_id=e.id) OR o.released_at IS NULL OR o.outcome NOT IN('confirm','extend','not_confirm') THEN RAISE EXCEPTION 'GBS may apply only a released approved outcome';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF o.state='completed' THEN RETURN;END IF;
 IF o.outcome='confirm' AND e.confirmation_date::text IS DISTINCT FROM c.data->>'endOn' THEN RAISE EXCEPTION 'The canonical confirmation movement has not completed';END IF;
 IF o.outcome='extend' AND (e.extended_confirmation_date::text IS DISTINCT FROM p_next->>'endOn' OR (c.data->>'extensionCount')::integer>=app.probation_max_extensions(c.data) OR p_new_part IS NULL) THEN RAISE EXCEPTION 'The canonical extension movement has not completed';END IF;
 IF o.outcome='not_confirm' AND (p_handoff IS NULL OR NOT EXISTS(SELECT 1 FROM lc_v9_case x WHERE x.id=p_handoff AND x.tenant_id=c.tenant_id AND x.employment_id=e.id AND x.module='off' AND x.data->'facts'->>'caseType'='Non-confirmation' AND x.data->'facts'->>'lastDay'=c.data->>'endOn' AND x.data->>'probationSourceCaseId'=c.id::text)) THEN RAISE EXCEPTION 'The canonical company-initiated offboarding handoff has not completed';END IF;
 IF o.outcome IN('confirm','extend') AND NOT EXISTS(SELECT 1 FROM domain_event ev WHERE ev.tenant_id=c.tenant_id AND ev.aggregate_id=e.id AND ev.event_type='employment.info.updated' AND ev.actor_id IS NOT DISTINCT FROM app.current_user_id() AND ev.xmin::text::bigint=mod(txid_current(),4294967296) AND ev.payload->'movement'->>'remarks'=o.source_key AND ev.payload->'movement'->>'type'=CASE WHEN o.outcome='confirm' THEN 'confirmation' ELSE 'probationExtension' END AND CASE WHEN o.outcome='confirm' THEN ev.payload->'after'->>'confirmationDate'=c.data->>'endOn' ELSE ev.payload->'after'->>'extendedConfirmationDate'=p_next->>'endOn' END) THEN RAISE EXCEPTION 'Canonical Personnel movement receipt required in the same transaction';END IF;
 IF o.outcome IN('confirm','extend') THEN SELECT ev.id::text INTO p_movement FROM domain_event ev WHERE ev.tenant_id=c.tenant_id AND ev.aggregate_id=e.id AND ev.event_type='employment.info.updated' AND ev.xmin::text::bigint=mod(txid_current(),4294967296) AND ev.payload->'movement'->>'remarks'=o.source_key ORDER BY ev.occurred_at,ev.id LIMIT 1;END IF;
 UPDATE probation_personnel_tx_intent SET consumed=true WHERE tenant_id=c.tenant_id AND transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND employment_id=e.id AND source_id=o.id;
 UPDATE probation_outcome SET state='completed',movement_ref=p_movement,handoff_ref=p_handoff,failure=NULL,updated_at=now() WHERE id=o.id;
 IF o.outcome='extend' THEN
 part:=p_new_part;pid:=(part->>'id')::uuid;SELECT data INTO form FROM probation_configuration WHERE id=c.form_id;SELECT data INTO route FROM probation_configuration WHERE id=c.route_id;
 IF part->>'type'<>'3' OR (part->>'cycle')::integer<>(c.data->>'extensionCount')::integer+1 THEN RAISE EXCEPTION 'An extension schedules only the next final review';END IF;
 INSERT INTO probation_part(id,tenant_id,case_id,data) VALUES(pid,c.tenant_id,c.id,(part-ARRAY['employee','manager','employeeComments','kpis','support','strengths','development','managerComments','outcome','midpointStatus','justification','extensionMonths'])||jsonb_build_object('state','not_issued','route',route->'parts'->'3'));
 INSERT INTO probation_rater_draft(part_id,tenant_id,rater,data) VALUES(pid,c.tenant_id,'employee',jsonb_build_object('employee',app.probation_blank_assessment(form),'employeeComments','')),(pid,c.tenant_id,'lm',jsonb_build_object('manager',app.probation_blank_assessment(form),'kpis','[]'::jsonb,'support',jsonb_build_object('coaching','','access','','checkins','','other',''),'strengths','','development','','managerComments','','outcome',NULL,'midpointStatus',NULL,'justification','','extensionMonths',NULL));
 UPDATE probation_case SET data=data||jsonb_build_object('state','extended','endOn',p_next->>'endOn','extensionCount',(data->>'extensionCount')::integer+1,'pendingOutcome',NULL),revision=revision+1 WHERE id=c.id;
 ELSE UPDATE probation_case SET data=data||jsonb_build_object('state',CASE WHEN o.outcome='confirm' THEN 'confirmed' ELSE 'not_confirmed' END,'pendingOutcome',NULL),revision=revision+1 WHERE id=c.id;END IF;
 PERFORM app.probation_audit(c.id,o.part_id,'outcome_applied');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_commands(p_part uuid) RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;v jsonb;commands text[]:='{}';is_employee boolean;is_lm boolean;is_pbp boolean;is_gbs boolean;open boolean;pending_role text;current_holder uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RETURN commands;END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF app.probation_case_company_current(c.id) IS NOT TRUE OR app.probation_owns_legacy(c.employment_id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN RETURN commands;END IF;
 is_employee:=app.probation_part_role(p.id,'employee');is_lm:=app.probation_part_role(p.id,'lm');is_pbp:=app.probation_role(c.employment_id,'pbp');is_gbs:=app.probation_role(c.employment_id,'gbs');open:=p.data->>'state' NOT IN('not_issued','locked','recorded','completed_offline','cancelled');
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 SELECT s->>'role',(s->>'holderId')::uuid INTO pending_role,current_holder FROM jsonb_array_elements(app.probation_resolved_route(p.id)->'steps') s WHERE s->>'required'='true' AND NOT app.document_signing_step_fulfilled(d.data,s) AND s->>'coveredByStepId' IS NULL ORDER BY (s->>'stage')::integer,s->>'id' LIMIT 1;
 IF open AND is_employee AND p.data->>'type'<>'1' AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'managerSubmittedAt' IS NULL THEN commands:=array_append(commands,'submit_employee');END IF;
 IF open AND is_lm AND p.data->>'managerSubmittedAt' IS NULL AND (p.data->>'type'='1' OR c.data->'config'->>'lmWaitsForEmployee' IS DISTINCT FROM 'true' OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'employeeWaitException' IS NOT NULL) THEN commands:=array_append(commands,'submit_manager');END IF;
 IF open AND p.data->>'managerSubmittedAt' IS NOT NULL AND current_holder=app.current_user_id() THEN
 IF pending_role='employee' AND is_employee THEN commands:=array_append(commands,'acknowledge');ELSIF pending_role IN('hod','pbp') THEN commands:=array_append(commands,'approve');END IF;
 IF pending_role IN('employee','hod','pbp') THEN commands:=array_append(commands,'return');END IF;
 END IF;
 IF is_gbs AND app.probation_offline_record_ready(p.id) THEN commands:=array_append(commands,'record');END IF;
 IF is_gbs AND p.data->>'state'='pending_approval' AND app.probation_signatures_complete(p.id) THEN
 SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND rater='lm';
 IF v->>'outcome' IS DISTINCT FROM 'extend' OR p.data->>'pbpExtensionConfirmed'='true' THEN commands:=array_append(commands,'record');END IF;END IF;
 IF (is_pbp OR is_gbs) AND (p.data->>'state' IN('locked','recorded','completed_offline') OR p.data->>'managerSubmittedAt' IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM probation_outcome WHERE part_id=p.id AND tenant_id=p.tenant_id AND (released_at IS NOT NULL OR movement_ref IS NOT NULL OR handoff_ref IS NOT NULL)) THEN commands:=array_append(commands,'unlock');END IF;
 IF is_pbp AND p.data->>'type'<>'1' AND p.data->>'state'='not_issued' AND c.data->>'kpiAcknowledged'<>'true' AND p.data->>'kpiException' IS NULL AND c.data->'config'->>'kpiGate'='block' THEN commands:=array_append(commands,'kpi_exception');END IF;
 IF is_pbp AND p.data->>'type'<>'1' AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'employeeWaitException' IS NULL AND p.data->>'managerSubmittedAt' IS NULL AND p.data->>'state' IN('issued','returned') AND c.data->'config'->>'lmWaitsForEmployee'='true' AND (p.data->>'dueOn')::date<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN commands:=array_append(commands,'employee_wait_exception');END IF;
 IF is_pbp AND p.data->>'managerSubmittedAt' IS NOT NULL AND (c.data->>'extensionCount')::integer<app.probation_max_extensions(c.data) AND EXISTS(SELECT 1 FROM probation_rater_draft WHERE part_id=p.id AND rater='lm' AND data->>'outcome'='extend') THEN commands:=array_append(commands,'confirm_extension');END IF;
 IF is_lm AND p.data->>'managerSubmittedAt' IS NOT NULL AND p.data->>'acknowledgedAt' IS NULL AND pending_role='employee' THEN commands:=array_append(commands,'request_refusal');END IF;
 IF is_pbp AND p.data->>'managerSubmittedAt' IS NOT NULL AND EXISTS(SELECT 1 FROM probation_followup WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='refusal_request' AND content_revision=p.content_revision) AND NOT EXISTS(SELECT 1 FROM probation_followup WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='refusal_confirmed' AND content_revision=p.content_revision) THEN commands:=array_append(commands,'confirm_refusal');END IF;
 RETURN commands;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_personnel_intent(p_outcome uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;v jsonb;months integer;new_end date;e employment;
BEGIN
 PERFORM app.probation_write_lock();
 PERFORM app.access_workforce_write_lock();SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Released outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR UPDATE;
 IF NOT(app.probation_role(e.id,'gbs') OR app.probation_storage_runner()) OR NOT EXISTS(SELECT 1 FROM probation_file f JOIN employee_document doc ON doc.id=f.employee_document_id AND doc.tenant_id=f.tenant_id WHERE f.id=o.letter_file_id AND f.tenant_id=o.tenant_id AND doc.employment_id=e.id) OR o.released_at IS NULL OR o.outcome NOT IN('confirm','extend') OR NOT app.probation_review_complete(o.part_id) THEN RAISE EXCEPTION 'Released signed GBS outcome authority required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 v:=app.probation_evaluation_decision(o.part_id);
 IF coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on)::text IS DISTINCT FROM c.data->>'endOn' OR v->>'outcome' IS DISTINCT FROM o.outcome OR e.terminated_on IS NOT NULL OR e.resignation_date IS NOT NULL THEN RAISE EXCEPTION 'Personnel outcome source changed';END IF;
 IF o.outcome='extend' THEN months:=(v->>'extensionMonths')::integer;IF months NOT IN(3,6) OR (c.data->>'extensionCount')::integer>=app.probation_max_extensions(c.data) OR NOT EXISTS(SELECT 1 FROM probation_part WHERE id=o.part_id AND data->>'pbpExtensionConfirmed'='true') THEN RAISE EXCEPTION 'Current PBP confirmed extension required';END IF;new_end:=((c.data->>'endOn')::date+interval '1 day'+(months::text||' months')::interval-interval '1 day')::date;END IF;
 IF o.state<>'completed' THEN PERFORM app.probation_mint_personnel_intent(e.id,o.id,'outcome',CASE WHEN o.outcome='confirm' THEN (c.data->>'endOn')::date ELSE new_end END,o.outcome='extend');END IF;
 RETURN jsonb_build_object('outcomeId',o.id,'employmentId',e.id,'kind',CASE WHEN o.outcome='confirm' THEN 'confirmation' ELSE 'probationExtension' END,'effectiveDate',CASE WHEN o.outcome='confirm' THEN c.data->>'endOn' ELSE (o.released_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text END,'endDate',new_end,'sourceKey',o.source_key,'completed',o.state='completed');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_adjudicate_offline_final(p_case uuid,p_part uuid,p_expected integer,p_outcome text,p_months integer,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;f probation_offline_final_proposal;proposal uuid;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id FOR UPDATE;PERFORM app.probation_assert_case_runtime(c.id);
 SELECT * INTO f FROM probation_offline_final_proposal WHERE part_id=p.id AND tenant_id=p.tenant_id AND superseded_at IS NULL AND accepted_at IS NOT NULL FOR UPDATE;
 IF f.id IS NULL OR app.probation_can_adjudicate_offline_final(p.id) IS NOT TRUE OR p.revision IS DISTINCT FROM p_expected OR coalesce(p_outcome,'') NOT IN('confirm','extend','not_confirm') OR length(btrim(coalesce(p_reason,'')))<3 OR (p_outcome='extend' AND (coalesce(p_months,0) NOT IN(3,6) OR (c.data->>'extensionCount')::integer>=app.probation_max_extensions(c.data))) OR (p_outcome<>'extend' AND p_months IS NOT NULL) OR EXISTS(SELECT 1 FROM probation_outcome WHERE part_id=p.id AND tenant_id=p.tenant_id AND (released_at IS NOT NULL OR movement_ref IS NOT NULL OR handoff_ref IS NOT NULL)) THEN RAISE EXCEPTION 'Only the current PBP may adjudicate a recorded unresolved paper decision, with an actual reason';END IF;
 UPDATE probation_offline_final_proposal SET superseded_at=now() WHERE id=f.id;
 INSERT INTO probation_offline_final_proposal(tenant_id,company_id,employment_id,entry_id,entry_revision,evidence_id,source_digest,case_id,part_id,file_id,period_start,period_end,outcome,extension_months,reason,proposed_by) VALUES(f.tenant_id,f.company_id,f.employment_id,f.entry_id,f.entry_revision,f.evidence_id,f.source_digest,c.id,p.id,f.file_id,f.period_start,f.period_end,p_outcome,p_months,p_reason,app.current_user_id()) RETURNING id INTO proposal;
 UPDATE probation_part SET revision=revision+1 WHERE id=p.id;UPDATE probation_case SET revision=revision+1 WHERE id=c.id;PERFORM app.probation_audit(c.id,p.id,'offline_final_adjudicated',p_reason);RETURN proposal;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_signing_access(p_subject uuid,p_operation text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;step jsonb;
BEGIN
 IF coalesce(p_operation,'') NOT IN('create','read','sign','revise','reroute','decline') THEN RETURN false;END IF;
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_active_user() OR NOT app.probation_case_access(p.case_id) THEN RETURN false;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p_operation='read' THEN RETURN app.probation_part_access(p.id);END IF;
 IF app.probation_case_company_current(c.id) IS NOT TRUE OR app.probation_owns_legacy(c.employment_id) IS NOT TRUE OR NOT app.probation_company_entitled(c.company_id) OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled','not_issued','release_requested') THEN RETURN false;END IF;
 IF p.data->>'documentKind'='letter' THEN
 IF p_operation IN('create','revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs');END IF;
 IF p_operation='sign' THEN RETURN p.data->>'state'<>'returned' AND app.probation_letter_source_current(p.id) AND EXISTS(SELECT 1 FROM document_signing_document doc CROSS JOIN LATERAL jsonb_array_elements(doc.data->'route'->'steps') st WHERE doc.tenant_id=p.tenant_id AND doc.subject_type='probation' AND doc.subject_id=p.id AND st->>'holderId'=app.current_user_id()::text AND (app.probation_role(c.employment_id,st->>'role') OR EXISTS(SELECT 1 FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=st->>'id' AND x.holder_id=app.current_user_id() AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))));END IF;RETURN false;END IF;
 IF p_operation='create' THEN RETURN app.probation_part_role(p.id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation IN('revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR p.data->>'managerSubmittedAt' IS NULL AND app.probation_part_role(p.id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation='decline' THEN RETURN p.data->>'managerSubmittedAt' IS NOT NULL AND p.data->>'acknowledgedAt' IS NULL AND (app.probation_part_role(p.id,'lm') OR app.probation_role(c.employment_id,'pbp') AND EXISTS(SELECT 1 FROM probation_followup WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='refusal_request' AND content_revision=p.content_revision));END IF;
 IF p_operation<>'sign' THEN RETURN false;END IF;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 FOR step IN SELECT value FROM jsonb_array_elements(d.data->'route'->'steps') LOOP
 IF step->>'holderId'=app.current_user_id()::text AND (step->>'role' IN('hod','pbp') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='employee' AND app.probation_role(c.employment_id,'employee') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='lm' AND app.probation_part_role(p.id,'lm') AND p.data->>'managerSubmittedAt' IS NULL AND app.probation_submission_ready(p.id,'lm')) THEN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') current_step WHERE current_step->>'id'=step->>'id' AND current_step->>'holderId'=app.current_user_id()::text) THEN RETURN true;END IF;
 END IF;END LOOP;RETURN false;
END $$;
