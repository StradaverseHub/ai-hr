-- Probation delegation (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 7). Tag 5749 / idx 5149 /
-- when 1793330005449.
--
-- The general delegation (reporting_line line_type 'delegate' with reporting_line_scope rows, lib/delegation-scope.ts)
-- gains a Probation module with three tasks: probation.review, probation.approve and probation.letter_sign. Unlike
-- every other module, a whole-scope delegation (no scope rows) does NOT include Probation: only a delegation with a
-- Probation scope row moves anything. While such a delegation is active and covers the case's employee (the existing
-- app.delegation_line_covers rules: dates, live employments, usable login, company / unit / department scope, never the
-- employee themself), a Head of Department, PBP or GBS Review, Approve or letter Sign step held by the delegator
-- resolves to the delegate with representedId = the holder ("on behalf of"), so the delegate sees and acts on it and
-- every signing check (holder, represented id, duplicate-role policy) applies unchanged. Line Manager and employee steps
-- never move. probation_delegate (per-case replacement) keeps priority. The delegate of a Head of Department or PBP
-- holder also sees the case (app.probation_visible_among). No table, row, grant or purpose-owned object changes.
CREATE FUNCTION app.probation_general_delegate(p_holder uuid,p_subject_employment uuid,p_task text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT du.id FROM public.app_user hu
 JOIN public.employment he ON he.person_id=hu.person_id AND he.tenant_id=hu.tenant_id
 JOIN public.reporting_line d ON d.subordinate_employment_id=he.id AND d.tenant_id=hu.tenant_id AND d.line_type::text='delegate' AND d.superseded_at IS NULL
 JOIN public.employment de ON de.id=d.manager_employment_id AND de.tenant_id=d.tenant_id
 JOIN public.app_user du ON du.person_id=de.person_id AND du.tenant_id=de.tenant_id AND du.archived_at IS NULL AND NOT app.login_blocked(du.id)
 WHERE hu.id=p_holder AND hu.tenant_id=app.current_tenant_id() AND p_task IN('probation.review','probation.approve','probation.letter_sign')
  AND EXISTS(SELECT 1 FROM public.reporting_line_scope s WHERE s.reporting_line_id=d.id AND s.tenant_id=d.tenant_id AND s.module='probation' AND (s.task_type IS NULL OR s.task_type=p_task))
  AND app.delegation_line_covers(d.id,p_subject_employment,'probation',p_task)
 ORDER BY d.valid_from DESC,d.id,du.id LIMIT 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_general_delegate(uuid,uuid,text) FROM PUBLIC, ai_hr_app;
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
 SELECT data->'duplicateRolePolicy' INTO policy FROM probation_configuration WHERE id=c.route_id AND tenant_id=c.tenant_id;
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
   WHERE d.tenant_id=t AND d.holder_id=me AND d.valid_from<=day AND (d.valid_to IS NULL OR d.valid_to>=day))
  SELECT live.id FROM live WHERE NOT live.current_company AND live.person_id=my_person
  UNION
  SELECT live.id FROM live WHERE live.current_company AND (live.employment_id IN(SELECT held.employment_id FROM held) OR live.id IN(SELECT delegated.case_id FROM delegated))
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
