-- Probation work queues (lane E, Probation Confirmation build). Tag 5751 / idx 5151 / when 1793330005451.
--
-- 1. app.probation_task_list(category, limit): the caller's current Probation work, bounded and set-based, for My
--    Action Centre (Approval Items and My Tasks), Today › Needs you and the bell. The visible set is decided once
--    (app.probation_visible_among); holders once (app.probation_holders_set); candidate parts are then chosen in one
--    statement from the same records the case view reads (part state, stored signing steps and their holders,
--    per-part delegates, general Probation delegations and GBS coverage). Each candidate is confirmed by the case
--    view's own command owner, app.probation_commands(part) (which resolves the route, delegation included), so a
--    listed task is exactly a command the case view offers. At most 200 candidates are confirmed per read, in due
--    order; `capped` says more exist (the screens then link to the tracker filtered to the caller's work).
--    Category 'approval' is an Approve step (Head of Department or PBP, including a delegate acting on behalf);
--    'task' is everything else (employee, Line Manager, PBP and GBS tasks, letter Sign steps). NULL is both.
-- 2. app.probation_inbox() keeps its shape ({count, items} of at most 20) and now answers from (1); before, it
--    checked case access and commands for every case of the tenant.
-- 3. Form approval routing (handoff B3): app.probation_prepare_signing builds a Part's route from the approval rows of the
--    case's pinned form version (core steps, then rows by order, rows sharing an order in listed order) when that version
--    has them; versions saved before this, and Parts already frozen, keep the published route configuration. The form
--    version's duplicate-role policy (when set) is frozen on the Part as routePolicy, and
--    app.probation_resolve_route_unchecked reads it before the route configuration's. Both are the previous bodies
--    (2111 and 5749) with only these additions.
-- 4. A GBS step held by the GBS group (E4): once someone is assigned to it on a Part, that person's general Probation
--    delegation moves it to the delegate (app.probation_resolve_route_unchecked), the delegate sees the case
--    (app.probation_visible_among, 5749 body plus the assigned set) and may sign a letter step that the current
--    resolution names them on (app.probation_signing_access, 5746 body plus that clause). While nobody is assigned,
--    the step has no holder and the GBS People Ops task to assign a signer stays as it is.
-- No table, row, grant or purpose-owned object changes.
CREATE FUNCTION app.probation_task_list(p_category text,p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();me uuid:=app.current_user_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 my_person uuid;usable boolean:=false;ops boolean:=false;visible uuid[];lim integer:=least(greatest(coalesce(p_limit,20),1),200);result jsonb;
BEGIN
 IF p_category IS NOT NULL AND p_category NOT IN('approval','task') THEN RAISE EXCEPTION 'Unknown Probation task category';END IF;
 IF t IS NULL OR me IS NULL OR app.probation_active_user() IS NOT TRUE THEN RETURN jsonb_build_object('count',0,'capped',false,'items','[]'::jsonb);END IF;
 SELECT u.person_id,(u.archived_at IS NULL AND NOT app.login_blocked(u.id)) INTO my_person,usable FROM public.app_user u WHERE u.id=me AND u.tenant_id=t;
 IF EXISTS(SELECT 1 FROM public.probation_access m WHERE m.tenant_id=t AND m.user_id=me AND m.role='gbs') THEN
  ops:=coalesce(usable,false) AND coalesce(app.lifecycle_canonical_people_ops_member((SELECT co.id FROM public.company co WHERE co.tenant_id=t ORDER BY co.id LIMIT 1),me),false);
 END IF;
 visible:=ARRAY(SELECT app.probation_visible_among(NULL));
 WITH cs AS MATERIALIZED (
  SELECT c.id,c.employment_id,c.company_id,c.data FROM public.probation_case c
  WHERE c.tenant_id=t AND c.id=ANY(visible)
   AND EXISTS(SELECT 1 FROM public.probation_activation a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled)
   AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id)
   AND c.data->>'sourceCompanyMoved' IS DISTINCT FROM 'true'),
 h AS MATERIALIZED (SELECT * FROM app.probation_holders_set(ARRAY(SELECT cs.employment_id FROM cs))),
 gbs AS MATERIALIZED (SELECT m.* FROM public.probation_access m WHERE ops AND m.tenant_id=t AND m.user_id=me AND m.role='gbs' AND m.valid_from<=day AND (m.valid_to IS NULL OR m.valid_to>=day)),
 anc AS MATERIALIZED (SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT h.company_id FROM h WHERE EXISTS(SELECT 1 FROM gbs)))),
 gbs_cover AS MATERIALIZED (SELECT DISTINCT anc.company_id,m.department_id,m.business_unit_id FROM gbs m JOIN anc ON anc.ancestor_id=m.company_id),
 -- Holders whose Head of Department / PBP / GBS steps move to me under a general delegation with Probation ticked.
 general AS MATERIALIZED (
  SELECT DISTINCT hu.id AS holder_id FROM public.reporting_line d
  JOIN public.employment de ON de.id=d.manager_employment_id AND de.tenant_id=d.tenant_id AND de.person_id=my_person
  JOIN public.employment he ON he.id=d.subordinate_employment_id AND he.tenant_id=d.tenant_id
  JOIN public.app_user hu ON hu.person_id=he.person_id AND hu.tenant_id=d.tenant_id
  WHERE d.tenant_id=t AND d.line_type::text='delegate' AND d.superseded_at IS NULL AND d.valid_from<=current_date AND (d.valid_to IS NULL OR d.valid_to>current_date)
   AND EXISTS(SELECT 1 FROM public.reporting_line_scope s WHERE s.reporting_line_id=d.id AND s.tenant_id=d.tenant_id AND s.module='probation')),
 parts AS MATERIALIZED (
  SELECT p.id,p.case_id,p.data,p.updated_at,cs.data AS case_data,h.employee,h.lm,h.hod,h.pbp,
   EXISTS(SELECT 1 FROM gbs_cover g WHERE g.company_id=h.company_id AND (g.department_id IS NULL OR g.department_id=h.department_id) AND (g.business_unit_id IS NULL OR g.business_unit_id=h.business_unit_id)) AS gbs,
   d.data AS doc
  FROM cs JOIN public.probation_part p ON p.case_id=cs.id AND p.tenant_id=t AND coalesce(p.data->>'documentKind','review')='review'
  LEFT JOIN h ON h.employment_id=cs.employment_id
  LEFT JOIN public.document_signing_document d ON d.tenant_id=t AND d.subject_type='probation' AND d.subject_id=p.id
  WHERE cs.data->>'state' NOT IN('withdrawn','confirmed','not_confirmed') AND p.data->>'state'<>'cancelled'),
 -- A superset of the parts on which app.probation_commands can offer me a queue command; cheap tests only.
 candidates AS MATERIALIZED (
  SELECT parts.id,parts.case_id,parts.updated_at,coalesce(nullif(parts.data->>'dueOn','')::date,nullif(parts.case_data->>'endOn','')::date) AS due_on FROM parts
  WHERE
   -- Employee, Line Manager and route steps (Head of Department, PBP, GBS, a delegate or escalated signer) on an open part.
   (parts.data->>'state' NOT IN('not_issued','locked','recorded','completed_offline') AND (
     me=parts.employee OR me=parts.lm OR me=parts.hod OR me=parts.pbp
     OR parts.hod IN(SELECT general.holder_id FROM general) OR parts.pbp IN(SELECT general.holder_id FROM general)
     OR EXISTS(SELECT 1 FROM public.probation_delegate x WHERE x.tenant_id=t AND x.part_id=parts.id AND x.holder_id=me AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day))
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(parts.doc->'route'->'steps','[]'::jsonb)) s WHERE s->>'holderId'=me::text AND NOT app.document_signing_step_fulfilled(parts.doc,s))))
   -- PBP tasks that do not depend on an open route step: KPI exception, employee wait exception, extension and refusal confirmations.
   OR me=parts.pbp AND (
     parts.data->>'state'='not_issued' AND parts.data->>'type'<>'1' AND parts.data->>'kpiException' IS NULL AND parts.case_data->>'kpiAcknowledged' IS DISTINCT FROM 'true' AND parts.case_data->'config'->>'kpiGate'='block'
     OR parts.data->>'state' IN('issued','returned') AND parts.data->>'type'<>'1' AND parts.data->>'staffSubmittedAt' IS NULL AND parts.data->>'employeeWaitException' IS NULL AND parts.data->>'managerSubmittedAt' IS NULL AND parts.case_data->'config'->>'lmWaitsForEmployee'='true'
     OR parts.data->>'managerSubmittedAt' IS NOT NULL AND (EXISTS(SELECT 1 FROM public.probation_rater_draft r WHERE r.part_id=parts.id AND r.rater='lm' AND r.data->>'outcome'='extend')
      OR EXISTS(SELECT 1 FROM public.probation_followup f WHERE f.tenant_id=t AND f.part_id=parts.id AND f.kind='refusal_request')))
   -- GBS People Ops: recording a completed signature set or an offline final.
   OR parts.gbs AND (parts.data->>'state'='pending_approval' OR parts.data->>'state'='completed_offline' AND parts.data->>'type'='3')),
 bounded AS MATERIALIZED (SELECT * FROM candidates ORDER BY due_on,case_id,id LIMIT 201),
 review AS MATERIALIZED (
  SELECT b.case_id,b.id AS part_id,b.due_on,b.updated_at,k.kind,CASE WHEN k.kind='approve' THEN 'approval' ELSE 'task' END AS category,
   '/lifecycle/probation/'||b.case_id::text||'/'||b.id::text AS href
  FROM (SELECT * FROM bounded ORDER BY due_on,case_id,id LIMIT 200) b
  CROSS JOIN LATERAL (SELECT value AS kind FROM unnest(app.probation_commands(b.id)) value
   WHERE value IN('submit_employee','submit_manager','acknowledge','approve','record','confirm_extension','confirm_refusal','kpi_exception','employee_wait_exception') LIMIT 1) k),
 -- Letter Sign / revise / release: only cases with a letter that is not yet released.
 letter_cases AS MATERIALIZED (
  SELECT DISTINCT cs.id FROM cs JOIN public.probation_part l ON l.case_id=cs.id AND l.tenant_id=t AND l.data->>'documentKind'='letter'
  WHERE p_category IS DISTINCT FROM 'approval'
   AND NOT EXISTS(SELECT 1 FROM public.probation_outcome o WHERE o.tenant_id=t AND o.letter_part_id=l.id AND o.released_at IS NOT NULL)),
 letters AS MATERIALIZED (
  SELECT c.id AS case_id,lt."partId" AS part_id,(c.data->>'endOn')::date AS due_on,lp.updated_at,
   CASE WHEN lt.state='awaiting_revision' THEN 'letter_revise' WHEN lt.state='awaiting_release' THEN 'letter_release' ELSE 'letter_sign' END AS kind,'task' AS category,
   '/lifecycle/probation/'||c.id::text||'/letters/'||lt."partId"::text AS href
  FROM letter_cases lc JOIN public.probation_case c ON c.id=lc.id AND c.tenant_id=t CROSS JOIN LATERAL app.probation_letter_tasks(c.id) lt
  JOIN public.probation_part lp ON lp.id=lt."partId" AND lp.tenant_id=t
  WHERE (EXISTS(SELECT 1 FROM app.probation_pending_signers(lt."partId") signer WHERE signer.user_id=me)
   OR lt.state IN('awaiting_revision','awaiting_release') AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')))),
 tasks AS MATERIALIZED (
  SELECT * FROM review WHERE p_category IS NULL OR review.category=p_category
  UNION ALL SELECT * FROM letters),
 named AS (
  SELECT tasks.*,person.full_name AS employee_name,c.company_id,(SELECT p.data->>'type' FROM public.probation_part p WHERE p.id=tasks.part_id AND p.tenant_id=t) AS part_type FROM tasks JOIN public.probation_case c ON c.id=tasks.case_id AND c.tenant_id=t
  JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id JOIN public.person person ON person.id=e.person_id AND person.tenant_id=e.tenant_id)
 SELECT jsonb_build_object('count',(SELECT count(*) FROM tasks),'capped',(SELECT count(*) FROM bounded)>200,
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object('caseId',x.case_id,'partId',x.part_id,'employeeName',x.employee_name,'kind',x.kind,'category',x.category,'href',x.href,'dueOn',x.due_on,'updatedAt',x.updated_at,'companyId',x.company_id,'partType',x.part_type) ORDER BY x.due_on,x.case_id,x.part_id)
   FROM (SELECT * FROM named ORDER BY due_on,case_id,part_id LIMIT lim) x),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_task_list(text,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_task_list(text,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_inbox() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('count',x->'count','items',x->'items') FROM app.probation_task_list(NULL,20) x;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_prepare_signing(p_part uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;kpis jsonb;source jsonb;policy jsonb;scoped_route jsonb;manager jsonb;form_rows jsonb;form_policy jsonb;form_route jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF app.probation_part_role(p.id,'lm') IS NOT TRUE OR p.data->>'managerSubmittedAt' IS NOT NULL OR app.probation_submission_ready(p.id,'lm') IS NOT TRUE THEN RAISE EXCEPTION 'Only the ready current manager submission may freeze content';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF p.data?'signingFacts' THEN RETURN;END IF;
 source:=app.probation_personnel_source(c.employment_id);IF source->>'startOn' IS DISTINCT FROM c.data->>'startOn' OR source->>'endOn' IS NOT NULL AND source->>'endOn' IS DISTINCT FROM c.data->>'endOn' THEN RAISE EXCEPTION 'Reconcile changed canonical Personnel dates before this submission';END IF;
 IF coalesce(p.data->>'routeOverride','false')<>'true' THEN
 SELECT data INTO policy FROM probation_configuration WHERE id=c.route_id AND tenant_id=c.tenant_id;SELECT data INTO manager FROM probation_rater_draft WHERE part_id=p.id AND rater='lm' AND tenant_id=p.tenant_id;
 SELECT r->'route' INTO scoped_route FROM jsonb_array_elements(coalesce(policy->'rules','[]')) WITH ORDINALITY rules(r,n) WHERE r->>'part'=p.data->>'type' AND (r->>'businessGroupId' IS NULL OR r->>'businessGroupId'=(app.probation_organisation_facts(source,policy))->>'businessGroupId') AND (r->>'businessUnitId' IS NULL OR r->>'businessUnitId'=(app.probation_organisation_facts(source,policy))->>'businessUnitId') AND (r->>'grade' IS NULL OR r->>'grade'=c.data->>'gradeAtStart') AND (r->>'outcome' IS NULL OR r->>'outcome'=manager->>'outcome') ORDER BY num_nonnulls(r->>'businessGroupId',r->>'businessUnitId',r->>'grade',r->>'outcome') DESC,n DESC LIMIT 1;
  -- Form approval routing (5751): when the case's pinned form version carries approval rows, they decide this Part's
  -- route after the core steps (Line Manager signs, employee acknowledges); rows run by order, then as listed.
  SELECT f.data->'approvals'->(p.data->>'type'),f.data->'duplicateRolePolicy' INTO form_rows,form_policy FROM probation_configuration f WHERE f.id=c.form_id AND f.tenant_id=c.tenant_id AND f.kind='form';
  IF jsonb_typeof(form_rows)='array' THEN
   form_route:=jsonb_build_object('version',1,'steps',jsonb_build_array(
     jsonb_build_object('id','lm','role','lm','kind','sign','stage',0,'required',true),
     jsonb_build_object('id','employee','role','employee','kind','acknowledge','stage',1,'required',true))
    ||coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.r->>'who','role',x.r->>'who','kind','approve','stage',1+x.rank,'required',true) ORDER BY x.rank)
     FROM (SELECT r,row_number() OVER(ORDER BY (r->>'order')::integer,n) AS rank FROM jsonb_array_elements(form_rows) WITH ORDINALITY rows(r,n)) x),'[]'::jsonb));
   PERFORM app.probation_validate_evaluation_route(form_route,(p.data->>'type')::integer);
  END IF;
  UPDATE probation_part SET data=jsonb_set(data,'{route}',coalesce(form_route,scoped_route,policy->'parts'->(p.data->>'type')))
   ||CASE WHEN form_route IS NOT NULL AND jsonb_typeof(form_policy)='object' THEN jsonb_build_object('routePolicy',form_policy) ELSE '{}'::jsonb END WHERE id=p.id;END IF;
 SELECT d.data->'kpis' INTO kpis FROM probation_part k JOIN probation_rater_draft d ON d.part_id=k.id AND d.tenant_id=k.tenant_id AND d.rater='lm' WHERE k.case_id=c.id AND k.tenant_id=c.tenant_id AND k.data->>'type'='1' AND k.data->>'state' IN('locked','completed_offline') ORDER BY k.created_at DESC LIMIT 1;
 UPDATE probation_part SET data=data||jsonb_build_object('signingFacts',source,'signingPeriod',jsonb_build_object('startOn',c.data->>'startOn','endOn',c.data->>'endOn','gradeAtStart',c.data->>'gradeAtStart'),'signingKpis',coalesce(kpis,'[]')) WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'content_frozen');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_resolve_route_unchecked(p_part uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE general uuid;p probation_part;c probation_case;holders jsonb;route jsonb;steps jsonb:='[]';step jsonb;delegated probation_delegate;
 holder uuid;identity uuid;seen uuid[]:='{}';represented uuid;alternate uuid;policy jsonb;mode text;covering jsonb;
 day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;stored document_signing_document;historic jsonb;frozen_hash text;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF app.probation_case_company_current(c.id) IS NOT TRUE THEN RETURN p.data->'route';END IF;
 holders:=app.probation_holders(c.employment_id);route:=p.data->'route';
 -- 5751: a route frozen from form approval rows carries the form version's policy; otherwise the route configuration's.
 policy:=p.data->'routePolicy';
 IF jsonb_typeof(policy) IS DISTINCT FROM 'object' THEN SELECT data->'duplicateRolePolicy' INTO policy FROM probation_configuration WHERE id=c.route_id AND tenant_id=c.tenant_id;END IF;
 mode:=coalesce(policy->>'mode','escalate');
 SELECT * INTO stored FROM document_signing_document WHERE subject_id=p.id AND subject_type='probation' AND tenant_id=p.tenant_id;
 IF stored.id IS NOT NULL THEN frozen_hash:=encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex');END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(route->'steps') WITH ORDINALITY AS authored(value,ordinal) ORDER BY (value->>'stage')::integer,ordinal LOOP
  step:=step-ARRAY['coveredStepIds','coveredByStepId','holderPersonId','representedId'];general:=NULL;
  SELECT original INTO historic FROM jsonb_array_elements(stored.data->'route'->'steps') original
   WHERE original->>'id'=step->>'id' AND stored.data->>'contentHash'=frozen_hash AND app.document_signing_step_fulfilled(stored.data,original);
  IF historic IS NOT NULL THEN
   steps:=steps||jsonb_build_array(historic);
   IF historic->>'required'='true' AND historic->>'holderPersonId' IS NOT NULL THEN seen:=array_append(seen,(historic->>'holderPersonId')::uuid);END IF;
   CONTINUE;
  END IF;
  holder:=(holders->>(step->>'role'))::uuid;
  SELECT * INTO delegated FROM probation_delegate WHERE tenant_id=p.tenant_id AND part_id=p.id AND step_id=step->>'id' AND valid_from<=day AND (valid_to IS NULL OR valid_to>=day)
   AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=probation_delegate.holder_id AND u.tenant_id=probation_delegate.tenant_id AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
   ORDER BY created_at DESC,id DESC LIMIT 1;
  IF delegated.id IS NOT NULL THEN holder:=delegated.holder_id;step:=step||jsonb_build_object('representedId',delegated.represented_id);
   -- 5751 (E4): a step held by a group (GBS People Ops) has no holder until someone is assigned to it on this Part
   -- (missing_holder / holder_changed). Once assigned, that person's general Probation delegation applies exactly as it
   -- does to a Head of Department or PBP holder. An explicit per-part delegation (kind 'delegation') never chains.
   IF delegated.kind IN('missing_holder','holder_changed') AND step->>'role' IN('hod','pbp','gbs') AND step->>'kind' IN('approve','review','sign') THEN
    general:=app.probation_general_delegate(holder,c.employment_id,CASE WHEN step->>'kind'='review' THEN 'probation.review' WHEN p.data->>'documentKind'='letter' THEN 'probation.letter_sign' ELSE 'probation.approve' END);
    IF general IS NOT NULL THEN step:=step||jsonb_build_object('representedId',holder);holder:=general;END IF;
   END IF;
  -- Decision 7: a general delegation with Probation ticked moves a Head of Department, PBP or GBS Review, Approve or
  -- letter Sign step to the delegate, on behalf of the holder. Line Manager and employee steps never move.
  ELSIF holder IS NOT NULL AND step->>'role' IN('hod','pbp','gbs') AND step->>'kind' IN('approve','review','sign') THEN
   general:=app.probation_general_delegate(holder,c.employment_id,CASE WHEN step->>'kind'='review' THEN 'probation.review' WHEN p.data->>'documentKind'='letter' THEN 'probation.letter_sign' ELSE 'probation.approve' END);
   IF general IS NOT NULL THEN step:=step||jsonb_build_object('representedId',holder);holder:=general;END IF;
  END IF;
  SELECT u.person_id INTO identity FROM app_user u WHERE u.id=holder AND u.tenant_id=c.tenant_id;
  IF step->>'kind'='approve' AND step->>'required'='true' AND identity=ANY(seen) THEN
   covering:=NULL;
   IF mode='sign_once' AND delegated.id IS NULL AND general IS NULL THEN
    SELECT previous INTO covering FROM jsonb_array_elements(steps) previous WHERE previous->>'kind'='approve' AND previous->>'required'='true' AND previous->>'holderId'=holder::text
     AND previous->>'role'<>step->>'role' AND previous->>'coveredByStepId' IS NULL AND previous->'coveredStepIds' IS NULL
     AND (previous->>'stage')::integer<(step->>'stage')::integer
     AND (stored.id IS NULL OR NOT app.document_signing_step_fulfilled(stored.data,previous))
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') intervening WHERE intervening->>'required'='true'
      AND intervening->>'id' NOT IN(previous->>'id',step->>'id') AND (intervening->>'stage')::integer BETWEEN (previous->>'stage')::integer AND (step->>'stage')::integer)
     ORDER BY (previous->>'stage')::integer DESC LIMIT 1;
   END IF;
   IF covering IS NOT NULL THEN
    SELECT jsonb_agg(CASE WHEN previous->>'id'=covering->>'id' THEN previous||jsonb_build_object('coveredStepIds',jsonb_build_array(step->>'id')) ELSE previous END ORDER BY ordinal)
    INTO steps FROM jsonb_array_elements(steps) WITH ORDINALITY AS emitted(previous,ordinal);
    step:=step||jsonb_build_object('coveredByStepId',covering->>'id');
   ELSE
    represented:=holder;
    IF mode='named_alternate' THEN
     alternate:=(policy->>'alternateUserId')::uuid;
     SELECT u.person_id INTO identity FROM app_user u WHERE u.id=alternate AND u.tenant_id=c.tenant_id;
     holder:=CASE WHEN identity IS NOT NULL AND NOT(identity=ANY(seen)) AND app.probation_signer_candidate(c.id,alternate) THEN alternate ELSE NULL END;
    ELSE
     holder:=app.probation_escalated_signer(c.id,holder,seen);
    END IF;
    SELECT u.person_id INTO identity FROM app_user u WHERE u.id=holder AND u.tenant_id=c.tenant_id;
    step:=step||jsonb_build_object('representedId',represented);
   END IF;
  END IF;
  steps:=steps||jsonb_build_array(step||jsonb_build_object('holderId',holder));
  IF step->>'required'='true' AND identity IS NOT NULL THEN seen:=array_append(seen,identity);END IF;
 END LOOP;
 RETURN jsonb_set(route,'{steps}',steps);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_visible_among(p_cases uuid[]) RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
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
   SELECT h.employment_id FROM h WHERE me IN(h.employee,h.lm,h.hod,h.pbp)
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
   JOIN public.probation_part p ON p.id=x.part_id AND p.tenant_id=x.tenant_id)
  SELECT live.id FROM live WHERE NOT live.current_company AND live.person_id=my_person
  UNION
  SELECT live.id FROM live WHERE live.current_company AND (live.employment_id IN(SELECT held.employment_id FROM held) OR live.id IN(SELECT delegated.case_id FROM delegated)
   OR EXISTS(SELECT 1 FROM assigned a JOIN public.reporting_line_scope s ON s.reporting_line_id=a.line_id AND s.tenant_id=t AND s.module='probation'
    WHERE a.case_id=live.id AND app.delegation_line_covers(a.line_id,live.employment_id,'probation',coalesce(s.task_type,'probation.approve'))))
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
 IF p_operation='sign' THEN RETURN p.data->>'state'<>'returned' AND app.probation_letter_source_current(p.id) AND EXISTS(SELECT 1 FROM document_signing_document doc CROSS JOIN LATERAL jsonb_array_elements(doc.data->'route'->'steps') st WHERE doc.tenant_id=p.tenant_id AND doc.subject_type='probation' AND doc.subject_id=p.id AND st->>'holderId'=app.current_user_id()::text AND (app.probation_role(c.employment_id,st->>'role') OR EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') cur WHERE cur->>'id'=st->>'id' AND cur->>'holderId'=app.current_user_id()::text AND cur->>'representedId' IS NOT NULL) OR EXISTS(SELECT 1 FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=st->>'id' AND x.holder_id=app.current_user_id() AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))));END IF;RETURN false;END IF;
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
