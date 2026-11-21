-- Approver choices on Probation form approval rows (lane G1 of the Probation Confirmation build; handoff B3; owner mockup
-- screen 10; ADR docs/adr/2026-11-15-probation-shared-automation.md decisions 2 and 7). Tag 5756 / idx 5156 / when
-- 1793330005456, assigned by the build coordinator.
--
-- A form version's approval row may now name, besides the Head of Department ('hod') and the PBP ('pbp'), the employee's
-- Direct Superior ('superior'), a shared routing ('routing:<id>'), an assignment group ('group:<id>') or named people
-- ('people' with `userIds`), with the action Review, Approve or Approve and sign.
--  1. app.probation_form_approver_role(role) (owner only): the one helper that recognises an approver role. The functions
--     that assumed Head of Department / PBP now ask it: app.probation_commands, app.probation_signing_access,
--     app.probation_actor_just_signed, app.probation_part_command (a return recorded by the actor at an approver step),
--     app.probation_resolve_route_unchecked (a Direct Superior step resolves to the case's Line Manager holder; a routed
--     step's assigned person chains to their general Probation delegate exactly as an assigned GBS step does (5751 E4);
--     a Direct Superior step never moves, as on letters).
--  2. app.probation_validate_form_route (owner only) checks a route frozen from form rows: the 0949 rules for core steps
--     plus approver roles, Review or Approve kinds, `signature: false` only on Approve, an optional display `label`.
--     app.probation_validate_evaluation_route (route configurations, PBP route overrides) is unchanged.
--  3. app.probation_prepare_signing (5751 body): rows become steps by kind (Review → review; Approve → approve with
--     `signature: false`; Approve and sign → approve, as before) and routed steps carry the routing or group name as
--     `label`. Head of Department and PBP rows freeze exactly as before (id = role).
--  4. app.probation_form_routing_context(part) and app.probation_form_freeze_approvers(part, choices) (granted to
--     ai_hr_app, authorized for the submitting Line Manager): the facts the V9 assignment owner needs (lib/
--     routed-step-assignment.ts) and the freeze of one chosen person per routed step as a probation_delegate row of
--     kind missing_holder (so visibility, task lists and delegation chaining work unchanged). The database checks that
--     the person is named by the step (group member, named person, a person or group member of the routing) or, when
--     nobody could take it, a member of the case's fallback group; the fallback is recorded on the Part
--     (`approverUnresolved`, the step's `meantFor`) and as the case event probation.form_routing_fallback.
--  5. app.document_signing_act (5747 body): an Approve step marked `signature: false` records `approved` without a
--     signature on a document without template routing; app.probation_signatures_complete (5752 body) counts that
--     decision as the independent approval. app.probation_task_list (5751 body) also lists a general Probation
--     delegate's work on a step assigned to the person they cover.
-- Existing parts, default rows and Head of Department / PBP rows behave exactly as before. No table, row, grant or
-- purpose-owned object changes; replaced functions keep their signatures, owners and grants.
CREATE FUNCTION app.probation_form_approver_role(p_role text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p_role IN('hod','pbp','superior','people') OR p_role ~ '^(routing|group):[A-Za-z0-9_-]{1,80}$',false)
$$;
--> statement-breakpoint
CREATE FUNCTION app.probation_v9_group_member(p_group text,p_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p_group IS NOT NULL AND p_user IS NOT NULL AND EXISTS(SELECT 1 FROM public.lc_v9_config v
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.data->'groups')='array' THEN v.data->'groups' ELSE '[]'::jsonb END) g
  WHERE v.tenant_id=app.current_tenant_id() AND g->>'id'=p_group AND CASE WHEN jsonb_typeof(g->'members')='array' THEN g->'members' ELSE '[]'::jsonb END ? p_user::text),false)
$$;
--> statement-breakpoint
CREATE FUNCTION app.probation_form_approver_label(p_who text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE
  WHEN p_who LIKE 'routing:%' THEN (SELECT left(v.name,200) FROM public.automation_routing_version v WHERE v.tenant_id=app.current_tenant_id() AND v.routing_id::text=substr(p_who,9) ORDER BY v.revision DESC LIMIT 1)
  WHEN p_who LIKE 'group:%' THEN (SELECT left(coalesce(nullif(g->>'name',''),g->>'id'),200) FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.data->'groups')='array' THEN v.data->'groups' ELSE '[]'::jsonb END) g WHERE v.tenant_id=app.current_tenant_id() AND g->>'id'=substr(p_who,7) LIMIT 1)
 END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_form_approver_role(text),app.probation_v9_group_member(text,uuid),app.probation_form_approver_label(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_validate_form_route(p_route jsonb,p_type integer) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE manager_stage integer;employee_stage integer;step jsonb;
BEGIN
 IF p_type IS NULL OR p_type NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'Choose an evaluation Part from 1 to 3';END IF;
 IF jsonb_typeof(p_route->'steps') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid signing route';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s?'coveredStepIds' OR s?'coveredByStepId') THEN
  RAISE EXCEPTION 'Signing role coverage is resolved from the active policy and actual holders';
 END IF;
 PERFORM app.document_signing_validate(jsonb_build_object('route',p_route,'actions','[]'::jsonb),jsonb_build_object('requiredRoles','["lm","employee"]'::jsonb)||CASE WHEN p_type=3 THEN jsonb_build_object('independentApprovalFromRole','lm') ELSE '{}'::jsonb END);
 IF (SELECT count(*) FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='lm')<>1 OR (SELECT count(*) FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='employee')<>1 THEN RAISE EXCEPTION 'Evaluation routes use one manager signature, one employee acknowledgement and form approvers';END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(p_route->'steps') LOOP
  IF step->>'holderId' IS NOT NULL OR step->>'representedId' IS NOT NULL OR step->>'role'='lm' AND step->>'kind'<>'sign' OR step->>'role'='employee' AND step->>'kind'<>'acknowledge' THEN RAISE EXCEPTION 'Evaluation routes use one manager signature, one employee acknowledgement and form approvers';END IF;
  IF step->>'role' NOT IN('lm','employee') THEN
   IF NOT app.probation_form_approver_role(step->>'role') OR step->>'kind' NOT IN('review','approve') THEN RAISE EXCEPTION 'A form approval step reviews or approves for a Head of Department, PBP, Direct Superior, routing, group or named people';END IF;
  END IF;
  IF step ? 'signature' THEN
   IF step->'signature' IS DISTINCT FROM 'false'::jsonb OR step->>'kind'<>'approve' THEN RAISE EXCEPTION 'Only an Approve step can record a decision without a signature';END IF;
  END IF;
  IF step ? 'label' THEN
   IF jsonb_typeof(step->'label') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid approval step label';END IF;
   IF length(step->>'label')>200 THEN RAISE EXCEPTION 'Invalid approval step label';END IF;
  END IF;
 END LOOP;
 SELECT (s->>'stage')::integer INTO manager_stage FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='lm';SELECT (s->>'stage')::integer INTO employee_stage FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='employee';
 IF employee_stage<=manager_stage OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role' NOT IN('lm','employee') AND (s->>'stage')::integer<=manager_stage) THEN RAISE EXCEPTION 'Manager signing must precede acknowledgement and later approvals';END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_validate_form_route(jsonb,integer) FROM PUBLIC,ai_hr_app;
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
    -- 5756: Review rows are review steps, Approve rows approve without a signature, Approve and sign rows approve with
    -- one (as before). Head of Department and PBP rows keep their role as the step id; routed steps carry a display label.
    ||coalesce((SELECT jsonb_agg(jsonb_build_object('id',CASE WHEN x.r->>'who' IN('hod','pbp') THEN x.r->>'who' ELSE x.r->>'id' END,'role',x.r->>'who','kind',CASE WHEN x.r->>'action'='review' THEN 'review' ELSE 'approve' END,'stage',1+x.rank,'required',true)
      ||CASE WHEN x.r->>'action'='approve' THEN jsonb_build_object('signature',false) ELSE '{}'::jsonb END
      ||jsonb_strip_nulls(jsonb_build_object('label',app.probation_form_approver_label(x.r->>'who'))) ORDER BY x.rank)
     FROM (SELECT r,row_number() OVER(ORDER BY (r->>'order')::integer,n) AS rank FROM jsonb_array_elements(form_rows) WITH ORDINALITY rows(r,n)) x),'[]'::jsonb));
   PERFORM app.probation_validate_form_route(form_route,(p.data->>'type')::integer);
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
  IF step->>'kind'='approve' AND step->>'required'='true' AND identity=ANY(seen) THEN
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
 IF pending_role='employee' AND is_employee THEN commands:=array_append(commands,'acknowledge');ELSIF app.probation_form_approver_role(pending_role) THEN commands:=array_append(commands,'approve');END IF;
 IF pending_role='employee' OR app.probation_form_approver_role(pending_role) THEN commands:=array_append(commands,'return');END IF;
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
CREATE OR REPLACE FUNCTION app.probation_signing_access(p_subject uuid,p_operation text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;step jsonb;
BEGIN
 IF coalesce(p_operation,'') NOT IN('create','read','sign','revise','reroute','decline') THEN RETURN false;END IF;
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_active_user() OR NOT app.probation_case_access(p.case_id) THEN RETURN false;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p_operation='read' THEN RETURN app.probation_part_access(p.id);END IF;
 IF app.probation_case_company_current(c.id) IS NOT TRUE OR app.probation_owns_legacy(c.employment_id) IS NOT TRUE OR NOT app.probation_company_entitled(c.company_id) OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled','not_issued','release_requested') THEN RETURN false;END IF;
 IF p.data->>'documentKind'='letter' THEN
 -- 5752: a routed letter. Its steps are held by the people its routing froze, not by Probation roles. A holder named on the
 -- current route acts at their step; after a send-back only the owner may send it round again; the owner or the pending
 -- reviewer may revise (app.document_signing_store enforces the edit lock).
 IF jsonb_typeof(p.data->'letterRouting')='array' THEN
  SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
  IF p_operation='revise' AND d.id IS NOT NULL THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR app.document_signing_can_edit(d.data,app.current_user_id());END IF;
  IF p_operation='sign' THEN RETURN d.id IS NOT NULL AND app.probation_letter_source_current(p.id) AND (CASE WHEN app.document_signing_returned(d.data) THEN app.document_signing_owner(d.data)=app.current_user_id() ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') st WHERE st->>'holderId'=app.current_user_id()::text) END) IS TRUE;END IF;
 END IF;
 IF p_operation IN('create','revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs');END IF;
 IF p_operation='sign' THEN RETURN p.data->>'state'<>'returned' AND app.probation_letter_source_current(p.id) AND EXISTS(SELECT 1 FROM document_signing_document doc CROSS JOIN LATERAL jsonb_array_elements(doc.data->'route'->'steps') st WHERE doc.tenant_id=p.tenant_id AND doc.subject_type='probation' AND doc.subject_id=p.id AND st->>'holderId'=app.current_user_id()::text AND (app.probation_role(c.employment_id,st->>'role') OR EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') cur WHERE cur->>'id'=st->>'id' AND cur->>'holderId'=app.current_user_id()::text AND cur->>'representedId' IS NOT NULL) OR EXISTS(SELECT 1 FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=st->>'id' AND x.holder_id=app.current_user_id() AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))));END IF;RETURN false;END IF;
 IF p_operation='create' THEN RETURN app.probation_part_role(p.id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation IN('revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR p.data->>'managerSubmittedAt' IS NULL AND app.probation_part_role(p.id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation='decline' THEN RETURN p.data->>'managerSubmittedAt' IS NOT NULL AND p.data->>'acknowledgedAt' IS NULL AND (app.probation_part_role(p.id,'lm') OR app.probation_role(c.employment_id,'pbp') AND EXISTS(SELECT 1 FROM probation_followup WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='refusal_request' AND content_revision=p.content_revision));END IF;
 IF p_operation<>'sign' THEN RETURN false;END IF;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 FOR step IN SELECT value FROM jsonb_array_elements(d.data->'route'->'steps') LOOP
 IF step->>'holderId'=app.current_user_id()::text AND (app.probation_form_approver_role(step->>'role') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='employee' AND app.probation_role(c.employment_id,'employee') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='lm' AND app.probation_part_role(p.id,'lm') AND p.data->>'managerSubmittedAt' IS NULL AND app.probation_submission_ready(p.id,'lm')) THEN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') current_step WHERE current_step->>'id'=step->>'id' AND current_step->>'holderId'=app.current_user_id()::text) THEN RETURN true;END IF;
 END IF;END LOOP;RETURN false;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_signatures_complete(p_part uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;manager_person text;required jsonb;step jsonb;
BEGIN
 SELECT * INTO d FROM document_signing_document WHERE subject_type='probation' AND subject_id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN false;END IF;
 IF d.data->>'contentHash'<>encode(sha256(convert_to(app.probation_content(p_part)::text,'UTF8')),'hex') THEN RETURN false;END IF;
 IF app.document_signing_returned(d.data) THEN RETURN false;END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(d.data->'route'->'steps') WHERE value->>'required'='true' LOOP
 IF NOT app.document_signing_step_fulfilled(d.data,step) THEN RETURN false;END IF;
 END LOOP;
 IF d.guardrails->>'independentApprovalFromRole' IS NOT NULL THEN
 SELECT a->>'actorPersonId' INTO manager_person FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'=d.guardrails->>'independentApprovalFromRole' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash';
 IF manager_person IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a JOIN jsonb_array_elements(d.data->'route'->'steps') s ON s->>'id'=a->>'stepId' WHERE s->>'kind'='approve' AND a->>'action' IN('signed','approved') AND a->>'actorPersonId'<>manager_person AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN RETURN false;END IF;
 END IF;RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_actor_just_signed(p_part uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_active_user() AND EXISTS(
  SELECT 1 FROM document_signing_document d
   JOIN document_signing_revision r ON r.document_id=d.id AND r.tenant_id=d.tenant_id AND r.revision=d.revision
   CROSS JOIN LATERAL (SELECT (r.data->'actions')->(-1) AS action) latest
  WHERE d.tenant_id=app.current_tenant_id() AND d.subject_type='probation' AND d.subject_id=p_part
   AND r.actor_kind='user' AND r.actor_user_id=app.current_user_id() AND r.reason='Recorded signing action'
   AND r.xmin::text::bigint=mod(pg_current_xact_id_if_assigned()::text::bigint,4294967296)
   AND latest.action->>'actorId'=app.current_user_id()::text AND app.probation_form_approver_role(latest.action->>'role')
   AND latest.action->>'action' IN('signed','returned','reviewed','approved') AND latest.action->>'contentHash'=d.data->>'contentHash'
   AND latest.action->>'contentRevision'=d.data->>'contentRevision')
$$;
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
 IF p.data->>'type'='1' AND NOT app.probation_role(c.employment_id,'employee') OR p.data->>'type'<>'1' AND NOT(app.probation_part_role(p.id,'employee') OR app.probation_part_role(p.id,'hod') OR app.probation_part_role(p.id,'pbp') OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') ra JOIN jsonb_array_elements(d.data->'route'->'steps') rs ON rs->>'id'=ra->>'stepId' WHERE ra->>'action'='returned' AND ra->>'actorId'=actor::text AND ra->>'contentRevision'=d.data->>'contentRevision' AND ra->>'contentHash'=d.data->>'contentHash' AND app.probation_form_approver_role(rs->>'role'))) THEN RAISE EXCEPTION 'Only a current reviewer may return this part';END IF;
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
CREATE OR REPLACE FUNCTION app.probation_task_list(p_category text,p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
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
     -- 5756: a step assigned on the Part to a person whose Probation work moves to me (general delegation).
     OR EXISTS(SELECT 1 FROM public.probation_delegate x WHERE x.tenant_id=t AND x.part_id=parts.id AND x.kind IN('missing_holder','holder_changed') AND x.holder_id IN(SELECT general.holder_id FROM general) AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day))
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
CREATE OR REPLACE FUNCTION app.document_signing_act(p_id uuid,p_action jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;step jsonb;prior jsonb;stage integer;v_action jsonb;v_name text;v_person uuid;new_data jsonb;content jsonb;route_allowed boolean;coverage jsonb;routed boolean;v_kind text;v_owner uuid;
BEGIN
 -- All subject writers lock the source part before the signing document.
 SELECT * INTO d FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR to_regprocedure('app.probation_signing_content(uuid)') IS NULL OR to_regprocedure('app.probation_signing_route_allowed(uuid,jsonb)') IS NULL THEN RAISE EXCEPTION 'Signing subject unavailable'; END IF;
 EXECUTE 'SELECT app.probation_signing_content($1)' INTO content USING d.subject_id;
 SELECT * INTO d FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.document_signing_subject_access(d.subject_type,d.subject_id,CASE WHEN p_action->>'action'='declined' THEN 'decline' ELSE 'sign' END) THEN RAISE EXCEPTION 'Signing action not permitted'; END IF;
 IF jsonb_typeof(p_action) IS DISTINCT FROM 'object' OR jsonb_typeof(p_action->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(p_action->'stepId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_action->'contentRevision') IS DISTINCT FROM 'number' OR coalesce(p_action->>'id','')='' OR coalesce(p_action->>'stepId','')='' OR length(p_action->>'id')>200 OR jsonb_typeof(p_action->'comment') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid signing action shape'; END IF;
 IF content IS NULL OR content->>'companyId' IS DISTINCT FROM d.company_id::text OR content->>'employmentId' IS DISTINCT FROM d.employment_id::text OR content->>'contentHash' IS DISTINCT FROM d.data->>'contentHash' OR content->>'contentRevision' IS DISTINCT FROM d.data->>'contentRevision' THEN RAISE EXCEPTION 'Signing content changed'; END IF;
 EXECUTE 'SELECT app.probation_signing_route_allowed($1,$2)' INTO route_allowed USING d.subject_id,d.data->'route';
 IF route_allowed IS NOT TRUE THEN RAISE EXCEPTION 'Current signing holders changed'; END IF;
 SELECT person_id INTO v_person FROM app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id();
 IF v_person IS NULL OR p_action->>'actorPersonId' IS DISTINCT FROM v_person::text THEN RAISE EXCEPTION 'Verified signer person changed'; END IF;
 IF p_action->>'actorId' IS DISTINCT FROM app.current_user_id()::text OR p_action->>'contentHash' IS DISTINCT FROM d.data->>'contentHash' OR p_action->'contentRevision' IS DISTINCT FROM d.data->'contentRevision' THEN RAISE EXCEPTION 'Signer or document revision changed'; END IF;
 SELECT a INTO prior FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'id'=p_action->>'id';
 IF prior IS NOT NULL THEN
  IF (prior-'at'-'actorName')=(p_action-'at'-'actorName') THEN RETURN d.data; END IF;
  RAISE EXCEPTION 'Signing action reference already used';
 END IF;
 routed:=coalesce(jsonb_typeof(d.data->'routing')='object',false);
 v_kind:=coalesce(p_action->>'action','');
 IF v_kind='resent' THEN
  -- The owner sends a returned template-routing document round again unchanged.
  v_owner:=app.document_signing_owner(d.data);
  IF NOT routed OR NOT app.document_signing_returned(d.data) THEN RAISE EXCEPTION 'Only a document that was sent back can be sent round again'; END IF;
  IF v_owner IS NULL OR v_owner<>app.current_user_id() THEN RAISE EXCEPTION 'Only the owner of the document can send it round again'; END IF;
  IF p_action->>'role' IS DISTINCT FROM 'owner' OR p_action->>'representedId' IS DISTINCT FROM app.current_user_id()::text OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb OR p_action ? 'coveredStepIds'
  OR p_action->>'stepId' IS DISTINCT FROM coalesce(app.document_signing_owner_step(d.data)->>'id','owner')
  THEN RAISE EXCEPTION 'Invalid re-send'; END IF;
  coverage:='[]'::jsonb;
  step:=jsonb_build_object('id',p_action->>'stepId');
 ELSE
  IF app.document_signing_returned(d.data) THEN RAISE EXCEPTION 'The document was sent back to its owner'; END IF;
  SELECT min((s->>'stage')::integer) INTO stage FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND NOT app.document_signing_step_fulfilled(d.data,s);
  SELECT s INTO step FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'id'=p_action->>'stepId' AND (s->>'stage')::integer=stage AND s->>'coveredByStepId' IS NULL;
  IF step IS NULL OR (v_kind<>'declined' AND step->>'holderId' IS DISTINCT FROM app.current_user_id()::text) OR p_action->>'role' IS DISTINCT FROM step->>'role' OR p_action->>'representedId' IS DISTINCT FROM coalesce(step->>'representedId',step->>'holderId') THEN RAISE EXCEPTION 'Only the assigned pending signer may act'; END IF;
  IF app.document_signing_step_fulfilled(d.data,step) THEN RAISE EXCEPTION 'Signature already recorded'; END IF;
  coverage:=CASE WHEN v_kind='signed' THEN coalesce(step->'coveredStepIds','[]') ELSE '[]'::jsonb END;
  IF coalesce(p_action->'coveredStepIds','[]') IS DISTINCT FROM coverage THEN RAISE EXCEPTION 'The signature role coverage differs from the authoritative pending route';END IF;
  IF v_kind='declined' THEN
   IF step->>'kind'<>'acknowledge' OR step->>'holderPersonId'=v_person::text OR btrim(coalesce(p_action->>'comment',''))='' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'An independent recorded refusal confirmation is required'; END IF;
  ELSIF v_kind='returned' THEN
   IF btrim(coalesce(p_action->>'comment',''))='' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'A return reason is required'; END IF;
  ELSIF v_kind IN ('reviewed','approved') THEN
   -- Review, and Approve on a template-routing document, are decisions without a signature.
   IF p_action->'signature' IS DISTINCT FROM 'null'::jsonb OR v_kind='reviewed' AND step->>'kind'<>'review' OR v_kind='approved' AND (step->>'kind'<>'approve' OR NOT (routed OR step->'signature' IS NOT DISTINCT FROM 'false'::jsonb)) THEN RAISE EXCEPTION 'This step takes a different action'; END IF;
  ELSIF v_kind='signed' THEN
   IF step->>'kind'='review' OR (routed OR step->'signature' IS NOT DISTINCT FROM 'false'::jsonb) AND step->>'kind'='approve' THEN RAISE EXCEPTION 'This step takes a different action'; END IF;
   IF app.document_signature_valid(p_action->'signature') IS NOT TRUE THEN RAISE EXCEPTION 'A valid signature and consent are required';END IF;
  ELSE RAISE EXCEPTION 'Invalid signing action'; END IF;
  IF v_kind IN ('signed','approved') AND step->>'kind'='approve' AND d.guardrails->>'independentApprovalFromRole' IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'=d.guardrails->>'independentApprovalFromRole' AND a->>'action'='signed' AND a->>'actorPersonId'=v_person::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') other_step WHERE other_step->>'kind'='approve' AND other_step->>'required'='true' AND other_step->>'holderPersonId'<>v_person::text) THEN RAISE EXCEPTION 'A distinct approving person is required'; END IF;
 END IF;
 -- A subject owner must validate action payloads as well as the shared route and actor.
 -- In particular, an employee acknowledgement cannot replace the saved review comment.
 IF d.subject_type='probation' THEN
  IF to_regprocedure('app.probation_signing_action_allowed(uuid,jsonb)') IS NULL THEN RAISE EXCEPTION 'Signing subject action policy unavailable';END IF;
  EXECUTE 'SELECT app.probation_signing_action_allowed($1,$2)' INTO route_allowed USING d.subject_id,p_action;
  IF route_allowed IS NOT TRUE THEN RAISE EXCEPTION 'The current subject does not permit this signing action';END IF;
 END IF;
 SELECT p.full_name INTO v_name FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id();
 IF v_name IS NULL THEN RAISE EXCEPTION 'Verified signer name is missing'; END IF;
 v_action:=(p_action-'coveredStepIds')||CASE WHEN jsonb_array_length(coverage)>0 THEN jsonb_build_object('coveredStepIds',coverage) ELSE '{}'::jsonb END||jsonb_build_object('actorName',v_name,'actorPersonId',v_person,'at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 new_data:=jsonb_set(d.data,'{actions}',(d.data->'actions')||jsonb_build_array(v_action));
 UPDATE document_signing_document SET data=new_data,revision=revision+1,updated_at=now() WHERE id=d.id;
 INSERT INTO document_signing_revision(document_id,tenant_id,revision,data,actor_user_id,reason) VALUES(d.id,d.tenant_id,d.revision+1,new_data,app.current_user_id(),CASE v_kind WHEN 'resent' THEN 'Sent the document round again' ELSE 'Recorded signing action' END);
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(d.tenant_id,'document-signing',d.id,CASE v_kind WHEN 'signed' THEN 'document-signing.signed' WHEN 'declined' THEN 'document-signing.acknowledgement-declined' WHEN 'reviewed' THEN 'document-signing.reviewed' WHEN 'approved' THEN 'document-signing.approved' WHEN 'resent' THEN 'document-signing.resent' ELSE 'document-signing.returned' END,'user',app.current_user_id(),d.employment_id,jsonb_build_object('documentId',d.id,'revision',d.revision+1,'stepId',step->>'id'));
 RETURN new_data;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_form_routing_context(p_part uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();p probation_part;c probation_case;h jsonb;form_rows jsonb;pending jsonb;fallback text;routing_ids uuid[];group_ids text[];result jsonb;title text;bg uuid;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=t;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR coalesce(p.data->>'documentKind','review')<>'review' OR p.data->>'managerSubmittedAt' IS NOT NULL OR app.probation_part_role(p.id,'lm') IS NOT TRUE THEN RAISE EXCEPTION 'The submitting Line Manager is required' USING ERRCODE='42501';END IF;
 SELECT f.data->'approvals'->(p.data->>'type') INTO form_rows FROM probation_configuration f WHERE f.id=c.form_id AND f.tenant_id=c.tenant_id AND f.kind='form';
 IF jsonb_typeof(form_rows) IS DISTINCT FROM 'array' THEN form_rows:='[]'::jsonb;END IF;
 -- The routed steps of this Part's frozen route that nobody holds on the Part yet, with their rows.
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s->>'id','who',r->>'who','pick',coalesce(r->>'pick','any'),'userIds',CASE WHEN jsonb_typeof(r->'userIds')='array' THEN r->'userIds' ELSE '[]'::jsonb END) ORDER BY (s->>'stage')::integer,s->>'id'),'[]'::jsonb) INTO pending
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.data->'route'->'steps')='array' THEN p.data->'route'->'steps' ELSE '[]'::jsonb END) s
 JOIN jsonb_array_elements(form_rows) r ON r->>'id'=s->>'id' AND r->>'who'=s->>'role'
 WHERE (s->>'role'='people' OR s->>'role' ~ '^(routing|group):')
  AND NOT EXISTS(SELECT 1 FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=s->>'id' AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day));
 h:=app.probation_holders(c.employment_id);
 fallback:=coalesce(nullif(c.data->'config'->>'fallbackGroupId',''),(SELECT v.data->>'peopleOpsGroup' FROM lc_v9_config v WHERE v.tenant_id=t));
 SELECT pos.title INTO title FROM assignment a JOIN position pos ON pos.id=a.position_id AND pos.tenant_id=a.tenant_id
  WHERE a.employment_id=c.employment_id AND a.tenant_id=t AND a.superseded_at IS NULL AND a.valid_from<=day AND (a.valid_to IS NULL OR a.valid_to>day) ORDER BY a.valid_from DESC,a.id LIMIT 1;
 SELECT coalesce(co.parent_company_id,co.id) INTO bg FROM company co WHERE co.id=c.company_id AND co.tenant_id=t;
 SELECT coalesce(array_agg(DISTINCT substr(x->>'who',9)::uuid),'{}') INTO routing_ids FROM jsonb_array_elements(pending) x
  WHERE x->>'who' ~ '^routing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
 WITH r AS MATERIALIZED (
  SELECT DISTINCT ON (v.routing_id) v.routing_id,v.routing_rows,v.retired FROM automation_routing_version v
  WHERE v.tenant_id=t AND v.routing_id=ANY(routing_ids) ORDER BY v.routing_id,v.revision DESC)
 SELECT array_agg(DISTINCT g) INTO group_ids FROM (
  SELECT substr(x->>'who',7) AS g FROM jsonb_array_elements(pending) x WHERE x->>'who' LIKE 'group:%'
  UNION ALL SELECT row->'assignTo'->>'groupId' FROM r CROSS JOIN LATERAL jsonb_array_elements(r.routing_rows) row WHERE NOT r.retired AND row->'assignTo'->>'kind'='group'
  UNION ALL SELECT fallback) x WHERE g IS NOT NULL;
 SELECT jsonb_build_object(
  'steps',pending,'employeeUserId',h->>'employee','directSuperiorUserId',h->>'lm','fallbackGroupId',fallback,
  'facts',jsonb_build_object('businessGroup',h->>'businessUnitId','businessGroupCompany',bg,'company',c.company_id,'department',h->>'departmentId','jobTitle',title),
  'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.routing_id,'name',r.name,'rows',r.routing_rows)) FROM (
    SELECT DISTINCT ON (v.routing_id) v.routing_id,v.name,v.routing_rows,v.retired FROM automation_routing_version v
    WHERE v.tenant_id=t AND v.routing_id=ANY(routing_ids) ORDER BY v.routing_id,v.revision DESC) r WHERE NOT r.retired),'[]'::jsonb),
  'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g->>'id','name',coalesce(nullif(g->>'name',''),g->>'id'),'members',coalesce((
    SELECT jsonb_agg(u.id ORDER BY m.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members')='array' THEN g->'members' ELSE '[]'::jsonb END) WITH ORDINALITY m(id,n)
    JOIN app_user u ON u.id::text=m.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE m.n<=500),'[]'::jsonb)))
   FROM lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.data->'groups')='array' THEN v.data->'groups' ELSE '[]'::jsonb END) g
   WHERE v.tenant_id=t AND g->>'id'=ANY(coalesce(group_ids,'{}'))),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_form_freeze_approvers(p_part uuid,p_choices jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
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
REVOKE ALL ON FUNCTION app.probation_form_routing_context(uuid),app.probation_form_freeze_approvers(uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_form_routing_context(uuid),app.probation_form_freeze_approvers(uuid,jsonb) TO ai_hr_app;
