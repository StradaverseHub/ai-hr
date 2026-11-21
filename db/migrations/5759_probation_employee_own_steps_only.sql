-- The case's own employee holds only their own Probation steps (lane H2 of the Probation Confirmation build; follows
-- 5756 and 5758). Tag 5759 / idx 5159 / when 1793330005459, assigned by the build coordinator.
--
-- Rule: on their own case the employee may hold only the steps that are theirs (self-assessment / acknowledgement, and
-- "The employee" letter Sign step). They are never the holder, replacement, delegate or chosen member of a Review,
-- Approve, Approve-and-sign or another person's Sign step. Each command keeps authorization, transition and audit in
-- one transaction. Re-created in place, with the same signatures, owners and grants:
--  1. app.probation_signer_candidate (0949): never the case's employee (it is asked only for other people's steps:
--     per-part replacement, the candidate list, escalation and the named alternate).
--  2. app.probation_general_delegate (5749): a general Probation delegate is never the case's employee.
--  3. app.probation_assignment_facts (5755): the case's employee is not an eligible user, so the V9 assignment owner
--     (lib/routed-step-assignment.ts) skips them in a group, routing or named-people step and in the fallback group;
--     the next member takes the step, else the fallback group with "meant for" recorded (form rows and routed letters).
--  4. app.probation_form_freeze_approvers (5756) and app.probation_letter_freeze_route (5752): refuse the employee as
--     the person for any routed step that is not "The employee".
--  5. app.probation_delegate_add and app.probation_route_override (5758): refuse the employee for any step, and a route
--     whose step (not the employee's own) the employee holds today as role holder or current replacement.
--  6. app.probation_resolve_route_unchecked (5756): a step that is not the employee's own and still resolves to the
--     employee (for example the employee heads their own department) moves on exactly as a duplicate signer does
--     (escalate, or the named alternate), whatever its kind.
-- No table, row, grant or purpose-owned object changes; every other behaviour is unchanged.
CREATE OR REPLACE FUNCTION app.probation_signer_candidate(p_case uuid,p_user uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;h jsonb;v_person_id uuid;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();IF c.id IS NULL THEN RETURN false;END IF;
 SELECT u.person_id INTO v_person_id FROM app_user u WHERE u.id=p_user AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);IF v_person_id IS NULL THEN RETURN false;END IF;
 -- 5759: the case's own employee is never a signer candidate for another person's step.
 IF EXISTS(SELECT 1 FROM employment s WHERE s.id=c.employment_id AND s.tenant_id=c.tenant_id AND s.person_id=v_person_id) THEN RETURN false;END IF;h:=app.probation_holders(c.employment_id);
 RETURN coalesce(p_user::text IN(h->>'employee',h->>'lm',h->>'hod',h->>'pbp') OR app.lifecycle_canonical_people_ops_member(c.company_id,p_user) OR EXISTS(SELECT 1 FROM employment e WHERE e.person_id=v_person_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)),false);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_general_delegate(p_holder uuid,p_subject_employment uuid,p_task text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT du.id FROM public.app_user hu
 JOIN public.employment he ON he.person_id=hu.person_id AND he.tenant_id=hu.tenant_id
 JOIN public.reporting_line d ON d.subordinate_employment_id=he.id AND d.tenant_id=hu.tenant_id AND d.line_type::text='delegate' AND d.superseded_at IS NULL
 JOIN public.employment de ON de.id=d.manager_employment_id AND de.tenant_id=d.tenant_id
 JOIN public.app_user du ON du.person_id=de.person_id AND du.tenant_id=de.tenant_id AND du.archived_at IS NULL AND NOT app.login_blocked(du.id)
 WHERE hu.id=p_holder AND hu.tenant_id=app.current_tenant_id() AND p_task IN('probation.review','probation.approve','probation.letter_sign')
  AND EXISTS(SELECT 1 FROM public.reporting_line_scope s WHERE s.reporting_line_id=d.id AND s.tenant_id=d.tenant_id AND s.module='probation' AND (s.task_type IS NULL OR s.task_type=p_task))
  AND app.delegation_line_covers(d.id,p_subject_employment,'probation',p_task)
  -- 5759: never the subject employee of the case.
  AND NOT EXISTS(SELECT 1 FROM public.employment se WHERE se.id=p_subject_employment AND se.tenant_id=hu.tenant_id AND se.person_id=du.person_id)
 ORDER BY d.valid_from DESC,d.id,du.id LIMIT 1;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_assignment_facts(p_case uuid, p_groups text[], p_people uuid[]) RETURNS jsonb
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
    SELECT u.id FROM public.app_user u WHERE u.id = ANY(coalesce(p_people, '{}'::uuid[])) AND u.tenant_id = t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) x
    -- 5759: the case's own employee is never eligible for a routed step.
    WHERE NOT EXISTS(SELECT 1 FROM public.probation_case pc JOIN public.employment pe ON pe.id = pc.employment_id AND pe.tenant_id = pc.tenant_id
      JOIN public.app_user pu ON pu.person_id = pe.person_id AND pu.tenant_id = pe.tenant_id WHERE pc.id = p_case AND pc.tenant_id = t AND pu.id = x.id);
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
CREATE OR REPLACE FUNCTION app.probation_form_freeze_approvers(p_part uuid,p_choices jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();p probation_part;c probation_case;form_rows jsonb;x jsonb;s jsonb;r jsonb;holder uuid;fallback text;unresolved jsonb:='[]'::jsonb;route_steps jsonb;assigned integer:=0;
 day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=t FOR UPDATE;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR coalesce(p.data->>'documentKind','review')<>'review' OR p.data->>'managerSubmittedAt' IS NOT NULL OR NOT p.data ? 'signingFacts' OR app.probation_part_role(p.id,'lm') IS NOT TRUE THEN RAISE EXCEPTION 'The submitting Line Manager is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF jsonb_typeof(p_choices) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid approver choice' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(p_choices)>30 THEN RAISE EXCEPTION 'Invalid approver choice' USING ERRCODE='22023';END IF;
 SELECT f.data->'approvals'->(p.data->>'type') INTO form_rows FROM probation_configuration f WHERE f.id=c.form_id AND f.tenant_id=c.tenant_id AND f.kind='form';
 IF jsonb_typeof(form_rows) IS DISTINCT FROM 'array' THEN form_rows:='[]'::jsonb;END IF;
 fallback:=coalesce(nullif(c.data->'config'->>'fallbackGroupId',''),(SELECT v.data->>'peopleOpsGroup' FROM lc_v9_config v WHERE v.tenant_id=t));
 FOR x IN SELECT value FROM jsonb_array_elements(p_choices) LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid approver choice' USING ERRCODE='22023';END IF;
  s:=NULL;r:=NULL;holder:=NULL;
  SELECT value INTO s FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.data->'route'->'steps')='array' THEN p.data->'route'->'steps' ELSE '[]'::jsonb END) WHERE value->>'id'=x->>'stepId' LIMIT 1;
  SELECT value INTO r FROM jsonb_array_elements(form_rows) WHERE value->>'id'=x->>'stepId' LIMIT 1;
  IF s IS NULL OR r IS NULL OR r->>'who' IS DISTINCT FROM s->>'role' OR NOT(s->>'role'='people' OR s->>'role' ~ '^(routing|group):')
   OR EXISTS(SELECT 1 FROM probation_delegate d WHERE d.tenant_id=t AND d.part_id=p.id AND d.step_id=s->>'id' AND d.valid_from<=day AND (d.valid_to IS NULL OR d.valid_to>=day)) THEN
   RAISE EXCEPTION 'This approval step is not waiting for a person';
  END IF;
  IF x ? 'meantFor' THEN
   IF jsonb_typeof(x->'meantFor') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid approver choice' USING ERRCODE='22023';END IF;
   IF length(x->>'meantFor') NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid approver choice' USING ERRCODE='22023';END IF;
  END IF;
  IF x->>'holderId' IS NOT NULL THEN
   IF x->>'holderId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid approver choice' USING ERRCODE='22023';END IF;
   holder:=(x->>'holderId')::uuid;
   IF NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=holder AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'An approver is unavailable';END IF;
   -- 5759: never the case's own employee.
   IF EXISTS(SELECT 1 FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.id=holder AND u.tenant_id=t AND e.id=c.employment_id) THEN RAISE EXCEPTION 'The employee cannot review or approve their own probation';END IF;
   IF x ? 'meantFor' THEN
    IF NOT app.probation_v9_group_member(fallback,holder) THEN RAISE EXCEPTION 'The fallback approver is not in the fallback group';END IF;
   ELSIF s->>'role'='people' THEN
    IF NOT (CASE WHEN jsonb_typeof(r->'userIds')='array' THEN r->'userIds' ELSE '[]'::jsonb END) ? holder::text THEN RAISE EXCEPTION 'The approval step does not name this person';END IF;
   ELSIF s->>'role' LIKE 'group:%' THEN
    IF NOT app.probation_v9_group_member(substr(s->>'role',7),holder) THEN RAISE EXCEPTION 'The approval step''s group does not include this person';END IF;
   ELSIF NOT EXISTS(SELECT 1 FROM (SELECT DISTINCT ON (v.routing_id) v.routing_rows,v.retired FROM automation_routing_version v WHERE v.tenant_id=t AND v.routing_id::text=substr(s->>'role',9) ORDER BY v.routing_id,v.revision DESC) rv
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(rv.routing_rows)='array' THEN rv.routing_rows ELSE '[]'::jsonb END) rr
     WHERE NOT rv.retired AND (rr->'assignTo'->>'kind'='people' AND CASE WHEN jsonb_typeof(rr->'assignTo'->'userIds')='array' THEN rr->'assignTo'->'userIds' ELSE '[]'::jsonb END ? holder::text
      OR rr->'assignTo'->>'kind'='group' AND app.probation_v9_group_member(rr->'assignTo'->>'groupId',holder))) THEN
    RAISE EXCEPTION 'The approval step''s routing does not name this person';
   END IF;
   INSERT INTO probation_delegate(tenant_id,part_id,step_id,holder_id,represented_id,kind,reason,created_by,valid_from)
   VALUES(t,p.id,s->>'id',holder,NULL,'missing_holder',CASE WHEN x ? 'meantFor' THEN left('Form approval routing: the fallback group took the step meant for '||(x->>'meantFor'),500) ELSE 'Form approval routing' END,app.current_user_id(),day);
   assigned:=assigned+1;
  ELSIF NOT x ? 'meantFor' THEN
   RAISE EXCEPTION 'An approval step nobody could take needs who it was meant for' USING ERRCODE='22023';
  END IF;
  IF x ? 'meantFor' THEN
   unresolved:=unresolved||jsonb_build_array(jsonb_build_object('stepId',s->>'id','meantFor',x->>'meantFor','reason',left(coalesce(x->>'reason',''),300),'fallbackGroupId',fallback,'holderId',holder));
  END IF;
 END LOOP;
 IF jsonb_array_length(unresolved)>0 THEN
  -- Recorded on the Part (who each step was meant for) and on the case, as routed letters do (5752).
  SELECT jsonb_agg(CASE WHEN u.v IS NOT NULL THEN a.st||jsonb_build_object('meantFor',u.v->>'meantFor') ELSE a.st END ORDER BY a.n) INTO route_steps
  FROM jsonb_array_elements(p.data->'route'->'steps') WITH ORDINALITY a(st,n)
  LEFT JOIN LATERAL (SELECT value AS v FROM jsonb_array_elements(unresolved) WHERE value->>'stepId'=a.st->>'id' LIMIT 1) u ON true;
  UPDATE probation_part SET data=jsonb_set(data,'{route,steps}',route_steps)||jsonb_build_object('approverUnresolved',(SELECT coalesce(jsonb_agg(e),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'approverUnresolved')='array' THEN data->'approverUnresolved' ELSE '[]'::jsonb END) e WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(unresolved) n WHERE n->>'stepId'=e->>'stepId'))||unresolved) WHERE id=p.id;
  INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(t,'probation',c.id,'probation.form_routing_fallback','user'::actor_type,app.current_user_id(),c.employment_id,
   jsonb_build_object('caseId',c.id,'partId',p.id,'unresolved',unresolved));
 END IF;
 IF assigned>0 THEN PERFORM app.probation_audit(c.id,p.id,'form_approvers_assigned');END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_letter_freeze_route(p_part uuid,p_route jsonb,p_unresolved jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();p probation_part;c probation_case;h jsonb;s jsonb;r jsonb;expected_role text;cleaned jsonb:='[]'::jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=t FOR UPDATE;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR jsonb_typeof(p.data->'letterRouting') IS DISTINCT FROM 'array' OR p.data->'letterRoutingPending' IS DISTINCT FROM 'true'::jsonb
  OR EXISTS(SELECT 1 FROM document_signing_document d WHERE d.tenant_id=t AND d.subject_type='probation' AND d.subject_id=p.id)
  OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'A just-prepared routed letter and its scoped preparer are required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF jsonb_typeof(p_route) IS DISTINCT FROM 'object' OR p_route->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p_route->'steps') IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_route->'steps')<>jsonb_array_length(p.data->'letterRouting') OR jsonb_typeof(p_unresolved) IS DISTINCT FROM 'array' OR jsonb_array_length(p_unresolved)>30 THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
 h:=app.probation_holders(c.employment_id);
 FOR s IN SELECT value FROM jsonb_array_elements(p_route->'steps') LOOP
  SELECT value INTO r FROM jsonb_array_elements(p.data->'letterRouting') WHERE value->>'id'=s->>'id';
  IF r IS NULL THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
  expected_role:=CASE r->'who'->>'kind' WHEN 'employee' THEN 'employee' WHEN 'directSuperior' THEN 'lm' WHEN 'routing' THEN 'routing:'||(r->'who'->>'routingId') WHEN 'group' THEN 'group:'||(r->'who'->>'groupId') ELSE 'people' END;
  IF s->>'role' IS DISTINCT FROM expected_role OR s->>'kind' IS DISTINCT FROM r->>'action' OR s->'stage' IS DISTINCT FROM r->'order' OR s->'required' IS DISTINCT FROM 'true'::jsonb
   OR coalesce(s->'owner','false'::jsonb) IS DISTINCT FROM r->'owner' OR s ? 'coveredStepIds' OR s ? 'coveredByStepId' OR s ? 'representedId'
   OR s ? 'meantFor' AND (jsonb_typeof(s->'meantFor') IS DISTINCT FROM 'string' OR length(s->>'meantFor')>300) THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
  IF s->>'holderId' IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id::text=s->>'holderId' AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'A routed letter step holder is unavailable';END IF;
   -- 5759: the case's own employee holds only "The employee" step.
   IF r->'who'->>'kind' IS DISTINCT FROM 'employee' THEN
    IF EXISTS(SELECT 1 FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.id::text=s->>'holderId' AND u.tenant_id=t AND e.id=c.employment_id) THEN RAISE EXCEPTION 'The employee cannot review or approve their own probation';END IF;
   END IF;
   IF NOT s ? 'meantFor' AND (r->'who'->>'kind'='employee' AND s->>'holderId' IS DISTINCT FROM h->>'employee' OR r->'who'->>'kind'='directSuperior' AND s->>'holderId' IS DISTINCT FROM h->>'lm'
    OR r->'who'->>'kind'='people' AND NOT (r->'who'->'userIds') ? (s->>'holderId')) THEN RAISE EXCEPTION 'A routed letter step names someone its routing does not';END IF;
  END IF;
  cleaned:=cleaned||jsonb_build_array(s-'holderPersonId');
 END LOOP;
 UPDATE probation_part SET data=(data-'letterRoutingPending')||jsonb_build_object('route',jsonb_build_object('version',1,'steps',cleaned),'letterRoutingUnresolved',p_unresolved),revision=revision+1,updated_at=now() WHERE id=p.id;
 IF jsonb_array_length(p_unresolved)>0 THEN
  INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(t,'probation',c.id,'probation.letter_routing_fallback',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,
   jsonb_build_object('caseId',c.id,'partId',p.id,'unresolved',(SELECT jsonb_agg(jsonb_build_object('stepId',x->>'stepId','meantFor',left(coalesce(x->>'meantFor',''),300),'reason',left(coalesce(x->>'reason',''),300),'fallbackGroupId',x->>'fallbackGroupId','holderId',x->>'holderId')) FROM jsonb_array_elements(p_unresolved) x)));
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_delegate_add(p_part uuid,p_step text,p_holder uuid,p_kind text,p_from date,p_to date,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;h jsonb;represented uuid;step_role text;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR length(btrim(coalesce(p_reason,'')))<3 OR p_kind NOT IN('delegation','holder_changed','missing_holder') OR p_from IS NULL OR p_to<p_from THEN RAISE EXCEPTION 'A current PBP/GBS must record the replacement and reason';END IF;
 -- 5759: the case's own employee is never the replacement or delegate for any step.
 IF EXISTS(SELECT 1 FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.id=p_holder AND u.tenant_id=p.tenant_id AND e.id=c.employment_id) THEN
  RAISE EXCEPTION 'The employee cannot review or approve their own probation';
 END IF;
 IF app.probation_signer_candidate(c.id,p_holder) IS NOT TRUE THEN RAISE EXCEPTION 'Choose an active existing signer within this case legitimate company or canonical role scope';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_holder AND tenant_id=p.tenant_id AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RAISE EXCEPTION 'Choose an active existing login';END IF;
 SELECT (app.probation_holders(c.employment_id)->>(s->>'role'))::uuid INTO represented FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step;
 IF NOT FOUND THEN RAISE EXCEPTION 'Signing step unavailable';END IF;IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step AND s->>'role'='employee') THEN RAISE EXCEPTION 'Employee acknowledgement belongs to the employee; use the reasoned refusal route when necessary';END IF;
 -- 5758: a routed approver step (Direct Superior, routing, group, named people; 5756).
 SELECT s->>'role' INTO step_role FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step LIMIT 1;
 IF step_role NOT IN('lm','employee','hod','pbp','gbs') AND app.probation_form_approver_role(step_role) THEN
  IF p_kind='delegation' THEN
   IF step_role='superior' THEN
    -- A Direct Superior step is held by the case's Line Manager holder (5756), so it represents them as a Line Manager step does.
    represented:=(app.probation_holders(c.employment_id)->>'lm')::uuid;
   ELSE
    -- The step's current person on this Part: the latest current replacement, or whom a current delegation already covers.
    SELECT CASE WHEN x.kind='delegation' THEN x.represented_id ELSE x.holder_id END INTO represented FROM probation_delegate x
    WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=p_step AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day)
     AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=x.holder_id AND u.tenant_id=x.tenant_id AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
    ORDER BY x.created_at DESC,x.id DESC LIMIT 1;
   END IF;
  END IF;
 END IF;
 IF p_kind='delegation' AND represented IS NULL THEN RAISE EXCEPTION 'Use the explicit missing-holder replacement path when there is no current holder';END IF;
 IF EXISTS(SELECT 1 FROM document_signing_document doc CROSS JOIN LATERAL jsonb_array_elements(doc.data->'route'->'steps') step
  WHERE doc.tenant_id=p.tenant_id AND doc.subject_type='probation' AND doc.subject_id=p.id AND step->>'id'=p_step AND app.document_signing_step_fulfilled(doc.data,step))
 THEN RAISE EXCEPTION 'Completed signatures retain their actual historical holder';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 INSERT INTO probation_delegate(tenant_id,part_id,step_id,holder_id,represented_id,kind,reason,created_by,valid_from,valid_to) VALUES(p.tenant_id,p.id,p_step,p_holder,CASE WHEN p_kind='delegation' THEN represented END,p_kind,p_reason,app.current_user_id(),p_from,p_to);
 PERFORM app.probation_audit(c.id,p.id,'signer_replaced',p_reason);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_route_override(p_part uuid,p_route jsonb,p_reason text,p_expected integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;rules jsonb;routed boolean:=false;route jsonb:=p_route;form_rows jsonb;form_policy jsonb;policy_patch jsonb:='{}'::jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.revision IS DISTINCT FROM p_expected OR NOT app.probation_role(c.employment_id,'pbp') OR length(btrim(coalesce(p_reason,'')))<3 OR p.data->>'managerSubmittedAt' IS NOT NULL OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled') THEN RAISE EXCEPTION 'PBP may change only an unsubmitted route with a reason';END IF;
 rules:=app.probation_signing_guardrails(p.id);
 -- 5758: does the proposed evaluation route carry a routed approver step (Direct Superior, routing, group, named people)?
 IF coalesce(p.data->>'documentKind','review')='review' THEN
  IF jsonb_typeof(p_route->'steps')='array' THEN
   routed:=EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role' NOT IN('lm','employee','hod','pbp') AND app.probation_form_approver_role(s->>'role'));
  END IF;
 END IF;
 IF NOT routed THEN
  -- The 0949 path, unchanged.
  IF coalesce(p.data->>'documentKind','review')='review' THEN PERFORM app.probation_validate_evaluation_route(p_route,(p.data->>'type')::integer);END IF;PERFORM app.document_signing_validate(jsonb_build_object('route',p_route,'actions','[]'::jsonb),rules);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role' NOT IN('lm','employee','hod','pbp') OR s->>'holderId' IS NOT NULL OR s->>'representedId' IS NOT NULL) THEN RAISE EXCEPTION 'Routes choose roles; use recorded delegation for named replacements';END IF;
 ELSE
  SELECT f.data->'approvals'->(p.data->>'type'),f.data->'duplicateRolePolicy' INTO form_rows,form_policy FROM probation_configuration f WHERE f.id=c.form_id AND f.tenant_id=c.tenant_id AND f.kind='form';
  IF jsonb_typeof(form_rows) IS DISTINCT FROM 'array' THEN form_rows:='[]'::jsonb;END IF;
  -- Each routed step keeps the id and routing of one of the case's form rows for this Part, so it is filled from that
  -- row (group, named people or routing) when the Line Manager submits. A PBP cannot invent a new routing here.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role' NOT IN('lm','employee','hod','pbp')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(form_rows) r WHERE r->>'id'=s->>'id' AND r->>'who'=s->>'role')) THEN
   RAISE EXCEPTION 'A routed approval step must keep a routing of this case''s form version';
  END IF;
  -- The label and "meant for" note are server-owned: the routing or group name, and the Part's current note for the step.
  SELECT jsonb_set(p_route,'{steps}',coalesce(jsonb_agg(CASE
    WHEN jsonb_typeof(a.s) IS DISTINCT FROM 'object' THEN a.s
    WHEN a.s->>'role' IN('lm','employee','hod','pbp') THEN a.s-ARRAY['label','meantFor']
    ELSE (a.s-ARRAY['label','meantFor'])||jsonb_strip_nulls(jsonb_build_object('label',app.probation_form_approver_label(a.s->>'role'),
     'meantFor',(SELECT o->>'meantFor' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.data->'route'->'steps')='array' THEN p.data->'route'->'steps' ELSE '[]'::jsonb END) o
      WHERE o->>'id'=a.s->>'id' AND o->>'role'=a.s->>'role' AND jsonb_typeof(o->'meantFor')='string' LIMIT 1)))
   END ORDER BY a.n),'[]'::jsonb)) INTO route
  FROM jsonb_array_elements(p_route->'steps') WITH ORDINALITY a(s,n);
  PERFORM app.probation_validate_form_route(route,(p.data->>'type')::integer);
  PERFORM app.document_signing_validate(jsonb_build_object('route',route,'actions','[]'::jsonb),rules);
  -- The duplicate-role policy: the one the Part's route was frozen with, else its form version's (as 5751 freezes it).
  IF jsonb_typeof(p.data->'routePolicy') IS DISTINCT FROM 'object' THEN
   IF jsonb_typeof(form_policy)='object' THEN policy_patch:=jsonb_build_object('routePolicy',form_policy);END IF;
  END IF;
 END IF;
 -- 5759: no step other than the employee's own may be held by the case's employee, as role holder or current replacement.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') s
  JOIN app_user u ON u.tenant_id=p.tenant_id AND (u.id::text=(app.probation_holders(c.employment_id)->>(CASE WHEN s->>'role'='superior' THEN 'lm' ELSE s->>'role' END))
   OR u.id IN(SELECT x.holder_id FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=s->>'id' AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)))
  JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id AND e.id=c.employment_id
  WHERE s->>'role' IS DISTINCT FROM 'employee') THEN RAISE EXCEPTION 'The employee cannot review or approve their own probation';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision,p.data,app.current_user_id(),p_reason);
 UPDATE probation_part SET data=data||jsonb_build_object('route',route,'routeOverride',true,'routeReason',p_reason)||policy_patch,revision=revision+1,content_revision=content_revision+1 WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'route_changed',p_reason);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_resolve_route_unchecked(p_part uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE general uuid;p probation_part;c probation_case;holders jsonb;route jsonb;steps jsonb:='[]';step jsonb;delegated probation_delegate;
 holder uuid;identity uuid;seen uuid[]:='{}';represented uuid;alternate uuid;policy jsonb;mode text;covering jsonb;
 day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;stored document_signing_document;historic jsonb;frozen_hash text;employee_person uuid;
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
 SELECT e.person_id INTO employee_person FROM employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id;
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
  -- 5756: a Direct Superior step is held by the case's Line Manager holder (the employee's Direct Superior).
  holder:=(holders->>(CASE WHEN step->>'role'='superior' THEN 'lm' ELSE step->>'role' END))::uuid;
  SELECT * INTO delegated FROM probation_delegate WHERE tenant_id=p.tenant_id AND part_id=p.id AND step_id=step->>'id' AND valid_from<=day AND (valid_to IS NULL OR valid_to>=day)
   AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=probation_delegate.holder_id AND u.tenant_id=probation_delegate.tenant_id AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
   ORDER BY created_at DESC,id DESC LIMIT 1;
  IF delegated.id IS NOT NULL THEN holder:=delegated.holder_id;step:=step||jsonb_build_object('representedId',delegated.represented_id);
   -- 5751 (E4): a step held by a group (GBS People Ops) has no holder until someone is assigned to it on this Part
   -- (missing_holder / holder_changed). Once assigned, that person's general Probation delegation applies exactly as it
   -- does to a Head of Department or PBP holder. An explicit per-part delegation (kind 'delegation') never chains.
   -- 5756: a routing, group or named-people step's assigned person chains the same way; a Direct Superior step never moves.
   IF delegated.kind IN('missing_holder','holder_changed') AND (step->>'role' IN('hod','pbp','gbs') OR app.probation_form_approver_role(step->>'role') AND step->>'role'<>'superior') AND step->>'kind' IN('approve','review','sign') THEN
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
  -- 5759: the case's own employee never holds another person's step; it moves on like a duplicate signer.
  IF step->>'kind'='approve' AND step->>'required'='true' AND identity=ANY(seen) OR step->>'role'<>'employee' AND identity=employee_person THEN
   covering:=NULL;
   IF mode='sign_once' AND delegated.id IS NULL AND general IS NULL THEN
    SELECT previous INTO covering FROM jsonb_array_elements(steps) previous WHERE previous->>'kind'='approve' AND previous->>'required'='true' AND previous->>'holderId'=holder::text
     AND previous->>'role'<>step->>'role' AND previous->>'coveredByStepId' IS NULL AND previous->'coveredStepIds' IS NULL AND previous->'signature' IS DISTINCT FROM 'false'::jsonb
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
