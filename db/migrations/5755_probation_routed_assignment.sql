-- Routed Probation steps: assignment, delegation and form approval choices (lane F2-F4 of the Probation Confirmation
-- build; ADR docs/adr/2026-11-15-probation-shared-automation.md decisions 2 and 7; handoff A2, A3, B3).
-- Tag 5755 / idx 5155 / when 1793330005455, assigned by the build coordinator.
--
-- 1. app.probation_assignment_facts(case, groups, people) (F2): what the V9 assignment owner (lib/lifecycle-v9-model.ts
--    `assign`) needs to choose one person for a routed Review, Approve or Sign step: each named assignment group's
--    name, open-task limit and active members in member order, and for every candidate (group members and named people
--    still active) the open load (unfinished steps they hold on open Probation documents), the last time a routing,
--    group or named-people step was assigned to them, and whether approved leave covers today. Availability only: no
--    leave reason is returned. Authorized by app.automation_can_run('probation', case); bounded (50 groups, 200
--    people, 500 members a group, the latest 2000 Probation documents).
-- 2. app.probation_resolve_route_unchecked (5752 body) (F3, decision 7): on a routed letter, a Review, Approve or Sign
--    step held by the case's Head of Department or PBP, or by a GBS People Ops member covering the case, resolves to the
--    holder's general Probation delegate (explicit Probation scope, covering this employee) with representedId = the
--    holder, as form parts already do. A current per-part replacement keeps priority; employee and Direct Superior steps
--    never move; a step already done keeps its recorded holder.
-- 3. app.probation_visible_among (5751 body) (F3): the delegate of a routed letter step's holder also sees that case while
--    the letter is open, as the delegate of a Head of Department or PBP holder already does.
-- 4. app.probation_part_access (5752 body) (F3): a routed letter is also readable by whoever's turn it is on the current
--    resolution (the delegate acting on behalf of the holder), as an unrouted letter already is.
-- No table, row, grant or purpose-owned object changes; the new function is granted to ai_hr_app and the three replaced
-- functions keep their signatures and grants.
CREATE FUNCTION app.probation_assignment_facts(p_case uuid, p_groups text[], p_people uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); day date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; v_groups jsonb; candidates uuid[]; users jsonb;
BEGIN
  IF app.automation_can_run('probation', p_case) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE = '42501'; END IF;
  IF coalesce(cardinality(p_groups), 0) > 50 OR coalesce(cardinality(p_people), 0) > 200 THEN RAISE EXCEPTION 'Invalid assignment request' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', g->>'id', 'name', coalesce(nullif(g->>'name', ''), g->>'id'),
      'limit', CASE WHEN jsonb_typeof(g->'limit') = 'number' THEN greatest(floor((g->>'limit')::numeric), 0)::integer ELSE 0 END,
      'members', coalesce((
        SELECT jsonb_agg(u.id ORDER BY m.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members') = 'array' THEN g->'members' ELSE '[]'::jsonb END) WITH ORDINALITY m(id, n)
        JOIN public.app_user u ON u.id::text = m.id AND u.tenant_id = t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
        WHERE m.n <= 500), '[]'::jsonb))), '[]'::jsonb)
    INTO v_groups
    FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.data->'groups') = 'array' THEN v.data->'groups' ELSE '[]'::jsonb END) g
    WHERE v.tenant_id = t AND g->>'id' = ANY(coalesce(p_groups, '{}'::text[]));
  SELECT coalesce(array_agg(DISTINCT x.id), '{}'::uuid[]) INTO candidates FROM (
    SELECT (m.id)::uuid AS id FROM jsonb_array_elements(v_groups) g CROSS JOIN LATERAL jsonb_array_elements_text(g->'members') m(id)
    UNION ALL
    SELECT u.id FROM public.app_user u WHERE u.id = ANY(coalesce(p_people, '{}'::uuid[])) AND u.tenant_id = t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) x;
  WITH recent AS MATERIALIZED (
    SELECT d.data, d.created_at, p.data->>'state' AS part_state FROM public.document_signing_document d
    JOIN public.probation_part p ON p.id = d.subject_id AND p.tenant_id = d.tenant_id
    WHERE d.tenant_id = t AND d.subject_type = 'probation' ORDER BY d.created_at DESC, d.id DESC LIMIT 2000
  ), held AS MATERIALIZED (
    SELECT st->>'holderId' AS holder, r.created_at,
      r.part_state IN ('pending_ack','pending_approval','returned') AND NOT app.document_signing_step_fulfilled(r.data, st) AS open,
      (st->>'role' LIKE 'routing:%' OR st->>'role' LIKE 'group:%' OR st->>'role' = 'people') AS routed
    FROM recent r CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.data->'route'->'steps') = 'array' THEN r.data->'route'->'steps' ELSE '[]'::jsonb END) st
    WHERE st->>'holderId' = ANY(candidates::text[])
  ), away AS MATERIALIZED (
    SELECT DISTINCT u.id FROM public.app_user u
    JOIN public.employment e ON e.person_id = u.person_id AND e.tenant_id = u.tenant_id
    JOIN public.leave_request lr ON lr.employment_id = e.id AND lr.tenant_id = e.tenant_id
    WHERE u.id = ANY(candidates) AND u.tenant_id = t AND (
      EXISTS(SELECT 1 FROM public.leave_request_date ld WHERE ld.leave_request_id = lr.id AND ld.leave_date = day AND ld.status = 'approved')
      OR (lr.status = 'approved' AND day BETWEEN lr.start_date AND lr.end_date AND NOT EXISTS(SELECT 1 FROM public.leave_request_date ld WHERE ld.leave_request_id = lr.id)))
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id,
      'load', (SELECT count(*) FROM held h WHERE h.holder = c.id::text AND h.open),
      'lastAssigned', (SELECT max(h.created_at) FROM held h WHERE h.holder = c.id::text AND h.routed),
      'onLeave', EXISTS(SELECT 1 FROM away a WHERE a.id = c.id)) ORDER BY c.id), '[]'::jsonb)
    INTO users FROM unnest(candidates) c(id);
  RETURN jsonb_build_object('today', day, 'groups', v_groups, 'users', users);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_assignment_facts(uuid,text[],uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_assignment_facts(uuid,text[],uuid[]) TO ai_hr_app
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
 -- 5752: a letter generated from a routed template version keeps the route frozen from that version's routing; only a
 -- current per-part replacement (missing holder, holder changed, delegation) moves a step to another person.
 -- 5755 (decision 7): otherwise a Review, Approve or Sign step held by the case's Head of Department or PBP, or by a GBS
 -- People Ops member covering the case, moves to that holder's general Probation delegate, acting on behalf of the holder.
 -- Employee and Direct Superior steps never move; a per-part replacement keeps priority; a step already done stays.
 IF p.data->>'documentKind'='letter' AND jsonb_typeof(p.data->'letterRouting')='array' THEN
  SELECT * INTO stored FROM document_signing_document WHERE subject_id=p.id AND subject_type='probation' AND tenant_id=p.tenant_id;
  holders:=app.probation_holders(c.employment_id);
  RETURN jsonb_set(p.data->'route','{steps}',coalesce((SELECT jsonb_agg(CASE WHEN h.s IS NOT NULL AND app.document_signing_step_fulfilled(stored.data,h.s) THEN h.s WHEN x.holder_id IS NOT NULL THEN a.s||jsonb_build_object('holderId',x.holder_id,'representedId',x.represented_id) WHEN g.delegate IS NOT NULL THEN a.s||jsonb_build_object('holderId',g.delegate,'representedId',a.s->>'holderId') ELSE a.s END ORDER BY a.n)
   FROM jsonb_array_elements(p.data->'route'->'steps') WITH ORDINALITY a(s,n)
   LEFT JOIN LATERAL(SELECT value AS s FROM jsonb_array_elements(stored.data->'route'->'steps') WHERE value->>'id'=a.s->>'id' LIMIT 1) h ON true
   LEFT JOIN LATERAL(SELECT x.holder_id,x.represented_id FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=a.s->>'id' AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day)
    AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=x.holder_id AND u.tenant_id=x.tenant_id AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) ORDER BY x.created_at DESC,x.id DESC LIMIT 1) x ON true
   LEFT JOIN LATERAL(SELECT app.probation_general_delegate((a.s->>'holderId')::uuid,c.employment_id,CASE a.s->>'kind' WHEN 'review' THEN 'probation.review' WHEN 'approve' THEN 'probation.approve' ELSE 'probation.letter_sign' END) AS delegate
    WHERE a.s->>'holderId' IS NOT NULL AND a.s->>'role' NOT IN('employee','lm') AND a.s->>'kind' IN('review','approve','sign')
     AND (a.s->>'holderId' IN(coalesce(holders->>'hod',''),coalesce(holders->>'pbp','')) OR app.probation_gbs_user(c.employment_id,(a.s->>'holderId')::uuid) IS TRUE)) g ON true),'[]'::jsonb));
 END IF;
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
   JOIN public.probation_part p ON p.id=x.part_id AND p.tenant_id=x.tenant_id),
  -- 5755 (decision 7): routed letter steps held by a person I am a general Probation delegate for (open letters only).
  routed AS MATERIALIZED (
   SELECT DISTINCT p.case_id,g.line_id FROM general g
   JOIN public.document_signing_document doc ON doc.tenant_id=t AND doc.subject_type='probation' AND jsonb_typeof(doc.data->'routing')='object'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(doc.data->'route'->'steps')='array' THEN doc.data->'route'->'steps' ELSE '[]'::jsonb END) st WHERE st->>'holderId'=g.holder_id::text)
   JOIN public.probation_part p ON p.id=doc.subject_id AND p.tenant_id=doc.tenant_id AND p.data->>'state' IN('pending_approval','returned'))
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_part_access(p_part uuid,p_rater text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;e uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RETURN false;END IF;
 SELECT employment_id INTO e FROM probation_case WHERE id=p.case_id AND tenant_id=app.current_tenant_id();
 IF app.probation_case_company_current(p.case_id) IS NOT TRUE THEN IF app.probation_storage_runner() THEN RETURN true;END IF;IF p.data->>'documentKind'='letter' THEN RETURN p.data->>'state'='locked';END IF;RETURN p_rater IS NULL OR p_rater='employee' OR p_rater='lm' AND p.data->>'managerSubmittedAt' IS NOT NULL;END IF;
 IF p.data->>'documentKind'='letter' AND jsonb_typeof(p.data->'letterRouting')='array' THEN RETURN app.probation_storage_runner() OR app.probation_role(e,'pbp') OR app.probation_role(e,'gbs') OR EXISTS(SELECT 1 FROM document_signing_document d WHERE d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id AND (app.document_signing_owner(d.data)=app.current_user_id() OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'actorId'=app.current_user_id()::text) OR EXISTS(SELECT 1 FROM app.document_signing_pending_steps(jsonb_set(d.data,'{route}',coalesce(app.probation_resolve_route_unchecked(p.id),d.data->'route'))) st WHERE st->>'holderId'=app.current_user_id()::text)));END IF;
 IF p.data->>'documentKind'='letter' THEN RETURN app.probation_storage_runner() OR app.probation_role(e,'pbp') OR app.probation_role(e,'gbs') OR EXISTS(SELECT 1 FROM document_signing_document d CROSS JOIN LATERAL jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') st WHERE d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id AND st->>'holderId'=app.current_user_id()::text AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') prior WHERE (prior->>'stage')::integer<(st->>'stage')::integer AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=prior->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash')));END IF;
 IF p_rater IS NULL OR app.probation_role(e,'pbp') OR app.probation_role(e,'gbs') THEN RETURN true;END IF;
 IF p_rater='employee' THEN RETURN app.probation_role(e,'employee') OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'acknowledgedAt' IS NOT NULL;END IF;
 IF p_rater='lm' THEN RETURN app.probation_part_role(p.id,'lm') OR p.data->>'managerSubmittedAt' IS NOT NULL;END IF;
 RETURN false;
END $$;
