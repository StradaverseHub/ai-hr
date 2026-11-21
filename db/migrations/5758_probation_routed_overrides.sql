-- PBP route overrides and per-part delegation for routed form approver steps (lane H of the Probation Confirmation
-- build; ADR docs/adr/2026-11-15-probation-shared-automation.md decision 7; closes the gaps lane G left in 5756).
-- Tag 5758 / idx 5158 / when 1793330005458, assigned by the build coordinator.
--
-- 5756 lets a form version's approval row route to the Direct Superior ('superior'), a shared routing ('routing:<id>'),
-- an assignment group ('group:<id>') or named people ('people'); the step's person is frozen at the Line Manager's
-- submission as a probation_delegate row of kind missing_holder. Two PBP/GBS commands still assumed Head of Department
-- and PBP steps only:
--  1. app.probation_route_override (0949 body): a PBP may now override an unsubmitted Part route that contains routed
--     approver steps. Same authority (the case's current PBP), revision check, reason, probation_revision snapshot,
--     routeOverride flag and route_changed audit, in one transaction. A route with no routed step takes the 0949 path
--     byte for byte. A route with one is checked by app.probation_validate_form_route (5756) and the Part's signing
--     guardrails; each routed step must keep the id and routing of a row of the case's pinned form version for this
--     Part (so the step is filled from that row when the Line Manager submits, and the "a Part keeps the routing it
--     opened with" rule bends only through this explicit, audited override). The display label and "meant for" note
--     stay server-owned (label from the routing or group name; "meant for" carried from the Part's current step). The
--     duplicate-role policy the step was frozen with is kept: a Part without one takes its form version's policy.
--  2. app.probation_delegate_add (0949 body): a 'delegation' may now be recorded for a routed step. The represented
--     holder is the step's current person on the Part (the latest current missing_holder / holder_changed row, or the
--     person a current delegation already covers); a Direct Superior step represents the case's Line Manager holder,
--     as a Line Manager step does. The checks are those of a Head of Department or PBP step (current PBP/GBS, reason,
--     dates, active existing login and signer candidate, no completed signature, no employee acknowledgement step);
--     the duplicate-role policy applies when the route resolves, as for any per-part delegation. In addition, the
--     case's employee can never be recorded as the person for a routed approver step (any replacement kind).
-- Head of Department, PBP, GBS, Line Manager and letter steps behave exactly as before. No table, row, grant or
-- purpose-owned object changes; both functions keep their signatures, owners and grants.
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
 PERFORM app.probation_assert_case_runtime(c.id);
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision,p.data,app.current_user_id(),p_reason);
 UPDATE probation_part SET data=data||jsonb_build_object('route',route,'routeOverride',true,'routeReason',p_reason)||policy_patch,revision=revision+1,content_revision=content_revision+1 WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'route_changed',p_reason);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_delegate_add(p_part uuid,p_step text,p_holder uuid,p_kind text,p_from date,p_to date,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;h jsonb;represented uuid;step_role text;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR length(btrim(coalesce(p_reason,'')))<3 OR p_kind NOT IN('delegation','holder_changed','missing_holder') OR p_from IS NULL OR p_to<p_from THEN RAISE EXCEPTION 'A current PBP/GBS must record the replacement and reason';END IF;
 IF app.probation_signer_candidate(c.id,p_holder) IS NOT TRUE THEN RAISE EXCEPTION 'Choose an active existing signer within this case legitimate company or canonical role scope';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_holder AND tenant_id=p.tenant_id AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RAISE EXCEPTION 'Choose an active existing login';END IF;
 SELECT (app.probation_holders(c.employment_id)->>(s->>'role'))::uuid INTO represented FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step;
 IF NOT FOUND THEN RAISE EXCEPTION 'Signing step unavailable';END IF;IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step AND s->>'role'='employee') THEN RAISE EXCEPTION 'Employee acknowledgement belongs to the employee; use the reasoned refusal route when necessary';END IF;
 -- 5758: a routed approver step (Direct Superior, routing, group, named people; 5756).
 SELECT s->>'role' INTO step_role FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step LIMIT 1;
 IF step_role NOT IN('lm','employee','hod','pbp','gbs') AND app.probation_form_approver_role(step_role) THEN
  -- The employee never reviews or approves their own probation.
  IF EXISTS(SELECT 1 FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.id=p_holder AND u.tenant_id=p.tenant_id AND e.id=c.employment_id) THEN
   RAISE EXCEPTION 'The employee cannot review or approve their own probation';
  END IF;
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
