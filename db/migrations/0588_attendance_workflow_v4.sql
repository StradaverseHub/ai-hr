-- Board 2 reservation: 0588@1791900000068. Draft, not registered or applied.
-- Explicit v4 mixed sources; the immutable participant ledger/final-effect proof stays authoritative.
ALTER TABLE public.attendance_workflow_template DROP CONSTRAINT attendance_workflow_template_routing_version_check;
ALTER TABLE public.attendance_workflow_template ADD CONSTRAINT attendance_workflow_template_routing_version_check CHECK(routing_version IN (1,2,3,4));
ALTER TABLE public.attendance_workflow_request DROP CONSTRAINT attendance_workflow_request_routing_version_check;
ALTER TABLE public.attendance_workflow_request ADD CONSTRAINT attendance_workflow_request_routing_version_check CHECK(routing_version IN (1,2,3,4));
ALTER TABLE public.attendance_workflow_template ADD COLUMN cc jsonb NOT NULL DEFAULT '[]', ADD COLUMN retired_at timestamptz;
ALTER TABLE public.attendance_workflow_request ADD COLUMN cc jsonb NOT NULL DEFAULT '[]';
--> statement-breakpoint
-- Resolution reads only canonical Personnel/login identities. No CC grants application access.
CREATE FUNCTION app.attendance_workflow_resolve_v4(subject_id uuid,configured jsonb,configured_cc jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.employment; stage jsonb; source jsonb; actor jsonb; result jsonb; actors jsonb; resolved jsonb:='[]';
 seen_employments uuid[]:='{}';seen_people uuid[]:='{}';seen_users uuid[]:='{}';total integer:=0;i integer;j integer;alternative boolean;
 recipients jsonb:='[]';addresses text[]:='{}';address text;recipient jsonb;cc_ids uuid[];cc_id uuid;h record;identity record;login_count integer;login_id uuid;
BEGIN
 IF NOT app.principal_snapshot_current() THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',NULL); END IF;
 SELECT e.* INTO subject FROM public.employment e WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.can_see_employment(subject_id) THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',NULL); END IF;
 IF jsonb_typeof(configured) IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 IF jsonb_array_length(configured) NOT BETWEEN 1 AND 10 THEN RETURN app.attendance_workflow_v3_problem('level_count',NULL); END IF;
 FOR i IN 0..jsonb_array_length(configured)-1 LOOP
  stage:=configured->i;actors:='[]';alternative:=false;
  IF jsonb_typeof(stage) IS DISTINCT FROM 'object' OR NOT stage ?& ARRAY['name','mode','sources','hrAlternative'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(stage) k WHERE k NOT IN('name','mode','sources','hrAlternative'))
   OR jsonb_typeof(stage->'name') IS DISTINCT FROM 'string' OR length(stage->>'name')>100 OR jsonb_typeof(stage->'hrAlternative') IS DISTINCT FROM 'boolean' THEN RETURN app.attendance_workflow_v3_problem('invalid_level',i); END IF;
  IF coalesce(stage->>'mode','') NOT IN('any_one','all_required','sequential') THEN RETURN app.attendance_workflow_v3_problem('invalid_mode',i); END IF;
  IF jsonb_typeof(stage->'sources') IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
  IF jsonb_array_length(stage->'sources') NOT BETWEEN 1 AND 20 OR (stage->>'hrAlternative'='true' AND (jsonb_array_length(stage->'sources')<>1 OR stage->'sources'->0->>'kind'<>'direct_manager')) THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
  FOR j IN 0..jsonb_array_length(stage->'sources')-1 LOOP
   source:=stage->'sources'->j;
   result:=app.attendance_workflow_resolve_v3(subject_id,jsonb_build_array(jsonb_build_object('name','Level 1','mode','sequential','source',source,'hrAlternative',stage->'hrAlternative')));
   IF result->>'ok' IS DISTINCT FROM 'true' THEN RETURN jsonb_set(result,'{problem,levelIndex}',to_jsonb(i)); END IF;
   alternative:=alternative OR (result->'stages'->0->>'hrAlternative')::boolean;
   FOR actor IN SELECT value FROM jsonb_array_elements(result->'stages'->0->'approvers') LOOP
    IF (actor->>'employmentId')::uuid=ANY(seen_employments) THEN RETURN app.attendance_workflow_v3_problem('duplicate_employment',i); END IF;
    IF (actor->>'personId')::uuid=ANY(seen_people) THEN RETURN app.attendance_workflow_v3_problem('duplicate_person',i); END IF;
    IF (actor->>'userId')::uuid=ANY(seen_users) THEN RETURN app.attendance_workflow_v3_problem('duplicate_login',i); END IF;
    seen_employments:=seen_employments||(actor->>'employmentId')::uuid;seen_people:=seen_people||(actor->>'personId')::uuid;seen_users:=seen_users||(actor->>'userId')::uuid;
    actor:=actor||jsonb_build_object('slot',i::text||':'||jsonb_array_length(actors)::text,'sourceIndex',j);actors:=actors||jsonb_build_array(actor);total:=total+1;
   END LOOP;
   IF jsonb_array_length(actors)>20 OR total>100 THEN RETURN app.attendance_workflow_v3_problem('too_many_participants',i); END IF;
  END LOOP;
  resolved:=resolved||jsonb_build_array(jsonb_build_object('name','Level '||(i+1)::text,'mode',stage->>'mode','sources',stage->'sources','hrAlternative',alternative,'approvers',actors));
 END LOOP;
 IF jsonb_typeof(configured_cc) IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 IF jsonb_array_length(configured_cc)>20 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(configured_cc) LOOP
  cc_ids:='{}';
  IF source->>'kind'='custom_email' THEN
   IF jsonb_typeof(source) IS DISTINCT FROM 'object' OR NOT source ?& ARRAY['kind','addresses'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN('kind','addresses')) OR jsonb_typeof(source->'addresses') IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   IF jsonb_array_length(source->'addresses') NOT BETWEEN 1 AND 50 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   FOR actor IN SELECT value FROM jsonb_array_elements(source->'addresses') LOOP
    IF jsonb_typeof(actor) IS DISTINCT FROM 'string' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
    address:=lower(actor#>>'{}');
    IF length(address)>320 OR address !~ '^[!-~]+$' OR address !~ '^[^@<>(),:;"\\ ]+@[^@<>(),:;"\\ ]+\.[^@<>(),:;"\\ ]+$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
    IF NOT address=ANY(addresses) THEN addresses:=addresses||address;recipients:=recipients||jsonb_build_array(jsonb_build_object('kind','custom_email','address',address)); END IF;
   END LOOP;
  ELSIF source->>'kind'='direct_manager' THEN
   IF NOT source ?& ARRAY['kind','depth'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN('kind','depth')) OR jsonb_typeof(source->'depth') IS DISTINCT FROM 'number' OR coalesce(source->>'depth','') !~ '^[1-5]$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   SELECT * INTO h FROM app.attendance_workflow_hierarchy(subject_id,(source->>'depth')::integer) x WHERE x.level_number=(source->>'depth')::integer;
   IF NOT FOUND OR h.problem IS NOT NULL OR h.employment_id IS NULL THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   cc_ids:=ARRAY[h.employment_id];
  ELSIF source->>'kind'='specific_employee' THEN
   IF NOT source ?& ARRAY['kind','employmentIds'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN('kind','employmentIds')) OR jsonb_typeof(source->'employmentIds') IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   IF jsonb_array_length(source->'employmentIds') NOT BETWEEN 1 AND 20 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   FOR actor IN SELECT value FROM jsonb_array_elements(source->'employmentIds') LOOP
    IF jsonb_typeof(actor) IS DISTINCT FROM 'string' OR coalesce(actor#>>'{}','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
    cc_ids:=cc_ids||(actor#>>'{}')::uuid;
   END LOOP;
  ELSE RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
  FOREACH cc_id IN ARRAY cc_ids LOOP
   SELECT e.id,e.person_id,p.primary_email INTO identity FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
    WHERE e.id=cc_id AND e.tenant_id=subject.tenant_id AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND app.is_company_descendant(subject.company_id,e.company_id);
   IF NOT FOUND OR identity.primary_email IS NULL THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   SELECT count(*)::integer,min(u.id::text)::uuid INTO login_count,login_id FROM public.app_user u WHERE u.person_id=identity.person_id AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=subject.tenant_id AND r.role::text IN('employee','manager','hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=subject.company_id OR app.is_company_descendant(subject.company_id,r.company_id)));
   IF login_count<>1 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   address:=lower(identity.primary_email);
   IF length(address)>320 OR address !~ '^[!-~]+$' OR address !~ '^[^@<>(),:;"\\ ]+@[^@<>(),:;"\\ ]+\.[^@<>(),:;"\\ ]+$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   recipient:=jsonb_build_object('kind','employee','address',address,'employmentId',cc_id,'personId',identity.person_id,'userId',login_id);
   -- Internal provenance wins over an earlier custom copy of the same address.
   IF address=ANY(addresses) THEN SELECT coalesce(jsonb_agg(CASE WHEN r->>'address'=address THEN recipient ELSE r END),'[]') INTO recipients FROM jsonb_array_elements(recipients) r;
   ELSE addresses:=addresses||address;recipients:=recipients||jsonb_build_array(recipient); END IF;
  END LOOP;
  IF jsonb_array_length(recipients)>50 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'stages',resolved,'cc',recipients);
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_resolve_v4(uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_resolve_v4(uuid,jsonb,jsonb) TO ai_hr_app;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME IN ('attendance_workflow_template','attendance_workflow_setting','attendance_workflow_request') THEN
  IF NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=NEW.company_id AND c.tenant_id=NEW.tenant_id)
   THEN RAISE EXCEPTION 'Invalid workflow company'; END IF;
 END IF;
 IF TG_TABLE_NAME='attendance_workflow_request' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':attendance-workflow:'||NEW.company_id::text||':'||NEW.application_type,0));
  IF NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.attendance_correction c ON c.employment_id=e.id AND c.tenant_id=e.tenant_id
   JOIN public.attendance_workflow_template t ON t.id=NEW.template_id AND t.tenant_id=e.tenant_id
   WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND e.company_id=NEW.company_id AND c.id=NEW.correction_id
    AND t.company_id=NEW.company_id AND t.application_type=NEW.application_type AND t.version=NEW.template_version AND t.routing_version=NEW.routing_version)
   THEN RAISE EXCEPTION 'Invalid workflow application links'; END IF;
  IF NEW.routing_version=2 AND NEW.stages IS DISTINCT FROM app.attendance_workflow_resolve_v2(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))
   THEN RAISE EXCEPTION 'The submitted hierarchy must match the configured version and live root-authorized resolution'; END IF;
  IF NEW.routing_version=3 AND NEW.stages IS DISTINCT FROM (app.attendance_workflow_resolve_v3(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))->'stages')
   THEN RAISE EXCEPTION 'The v3 route must match the canonical root-authorized resolution'; END IF;
  IF NEW.routing_version=4 AND (NEW.stages,NEW.cc) IS DISTINCT FROM ((app.attendance_workflow_resolve_v4(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id),(SELECT t.cc FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))->'stages'),(app.attendance_workflow_resolve_v4(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id),(SELECT t.cc FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))->'cc')) THEN RAISE EXCEPTION 'The v4 route and CC must match canonical resolution'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id AND t.superseded_at IS NULL AND t.retired_at IS NULL AND t.active) THEN RAISE EXCEPTION 'The workflow is no longer available for a new application'; END IF;
 ELSIF TG_TABLE_NAME='attendance_workflow_decision' THEN
  IF NOT EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=NEW.request_id AND w.tenant_id=NEW.tenant_id AND w.employment_id=NEW.employment_id)
   OR (NEW.assigned_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.assigned_employment_id AND e.tenant_id=NEW.tenant_id))
   OR (NEW.actual_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.actual_employment_id AND e.tenant_id=NEW.tenant_id AND e.person_id=NEW.actual_person_id))
   OR (NEW.actual_person_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.person p WHERE p.id=NEW.actual_person_id AND p.tenant_id=NEW.tenant_id))
   THEN RAISE EXCEPTION 'Invalid workflow decision links'; END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_decision_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; assigned_person uuid; actual_person uuid; subject_company uuid;
BEGIN
 SELECT * INTO STRICT w FROM public.attendance_workflow_request WHERE id=NEW.request_id AND tenant_id=NEW.tenant_id;
 IF w.routing_version IN (3,4) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(w.tenant_id::text||':'||w.employment_id::text,0));
  PERFORM 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id FOR UPDATE;
  SELECT r.* INTO STRICT w FROM public.attendance_workflow_request r WHERE r.id=NEW.request_id AND r.tenant_id=app.current_tenant_id() FOR UPDATE;
  IF NEW.tenant_id<>app.current_tenant_id() OR w.current_stage<>NEW.stage_index OR w.current_stage>=jsonb_array_length(w.stages)
   OR NOT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.status='pending')
   OR NOT app.attendance_workflow_v3_completion_write(w.id,NEW.stage_index,NEW.decision)
   OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision p WHERE p.request_id=w.id AND p.tenant_id=w.tenant_id AND p.stage_index=NEW.stage_index
    AND p.actual_user_id=app.current_user_id() AND app.attendance_workflow_active_write(p.xmin)
    AND p.actual_user_id::text=NEW.actual_user_id AND p.actual_person_id IS NOT DISTINCT FROM NEW.actual_person_id
    AND p.actual_employment_id IS NOT DISTINCT FROM NEW.actual_employment_id AND p.acting_mode=NEW.acting_mode
    AND p.assigned->>'kind'=NEW.assigned_kind AND (p.assigned->>'employmentId')::uuid IS NOT DISTINCT FROM NEW.assigned_employment_id
    AND p.remarks IS NOT DISTINCT FROM NEW.remarks AND p.decision=NEW.decision)
   OR NEW.previous_status<>'pending' OR NEW.resulting_status<>(CASE WHEN NEW.decision='rejected' OR NEW.stage_index=jsonb_array_length(w.stages)-1 THEN NEW.decision ELSE 'pending' END)
   OR (coalesce(current_setting('app.attendance_workflow_effect',true),'')<>'' AND current_setting('app.attendance_workflow_effect',true)<>w.correction_id::text)
   THEN RAISE EXCEPTION 'A fulfilled participant level and active final participant write are required for one immutable level completion'; END IF;
  SELECT coalesce(p.full_name,u.id::text) INTO NEW.actual_actor_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id;
  RETURN NEW;
 END IF;

 IF coalesce(current_setting('app.attendance_workflow_effect',true),'')<>'' AND current_setting('app.attendance_workflow_effect',true)<>w.correction_id::text THEN RAISE EXCEPTION 'A request effect cannot decide another attendance application'; END IF;
 IF w.routing_version=2 THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(w.tenant_id::text||':'||w.employment_id::text,0));
  PERFORM 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id FOR UPDATE;
 END IF;
 SELECT * INTO STRICT w FROM public.attendance_workflow_request WHERE id=NEW.request_id AND tenant_id=NEW.tenant_id FOR UPDATE;
 IF w.routing_version=2 THEN
  SELECT u.person_id INTO actual_person FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
  IF NOT FOUND OR NEW.tenant_id<>app.current_tenant_id() OR NEW.actual_user_id<>app.current_user_id()::text OR NEW.actual_person_id IS DISTINCT FROM actual_person
   OR w.current_stage<>NEW.stage_index OR w.current_stage>=jsonb_array_length(w.stages)
   OR NOT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.status='pending')
   OR NOT app.attendance_workflow_v2_assigned_allowed(w.correction_id,NEW.stage_index,NEW.assigned_kind,NEW.assigned_employment_id,NEW.acting_mode)
   OR EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id
      AND (d.actual_user_id=app.current_user_id()::text OR (actual_person IS NOT NULL AND d.actual_person_id=actual_person)))
   OR (NEW.acting_mode='administrator' AND coalesce(length(btrim(NEW.remarks)),0) NOT BETWEEN 1 AND 1000)
   OR NEW.previous_status<>'pending' OR NEW.resulting_status<>(CASE WHEN NEW.decision='rejected' OR NEW.stage_index=jsonb_array_length(w.stages)-1 THEN NEW.decision ELSE 'pending' END)
   THEN RAISE EXCEPTION 'Only the current frozen approver, valid scoped delegate or reasoned HR handoff may decide this level; self and repeated actors are refused'; END IF;
  SELECT coalesce(p.full_name,u.id::text) INTO NEW.actual_actor_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id;
  RETURN NEW;
 END IF;
 SELECT e.company_id INTO STRICT subject_company FROM public.employment e WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 SELECT u.person_id INTO actual_person FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT FOUND THEN RAISE EXCEPTION 'A live authenticated attendance approver is required'; END IF;
 IF NEW.actual_user_id<>coalesce(app.current_user_id()::text,'system') OR NEW.actual_person_id IS DISTINCT FROM actual_person
  OR w.current_stage<>NEW.stage_index OR w.current_stage>=jsonb_array_length(w.stages)
  OR NOT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.status='pending')
  OR EXISTS(SELECT 1 FROM public.employment e WHERE e.id=w.employment_id AND e.person_id=actual_person)
  OR NOT ((w.stages->NEW.stage_index->'approvers') @> jsonb_build_array(jsonb_build_object('kind',NEW.assigned_kind,'employmentId',NEW.assigned_employment_id)))
  THEN RAISE EXCEPTION 'Invalid current-stage actor or assigned approver'; END IF;
 IF (NEW.acting_mode='administrator' OR NEW.assigned_kind='hr_admin') AND NOT EXISTS(
  SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=NEW.tenant_id AND r.app_user_id=app.current_user_id()
   AND r.role::text IN ('hr_admin','super_admin') AND app.has_role_for(r.role::text,subject_company)
   AND (r.company_id IS NULL OR r.company_id=subject_company OR app.is_company_descendant(subject_company,r.company_id)))
  THEN RAISE EXCEPTION 'Live scoped HR authority required'; END IF;
 IF NEW.acting_mode='administrator' THEN
  IF NOT app.is_admin_for(subject_company) THEN RAISE EXCEPTION 'Scoped HR authority required'; END IF;
 ELSIF NEW.assigned_kind='hr_admin' THEN
  IF NEW.acting_mode<>'assigned' OR NOT app.is_admin_for(subject_company) THEN RAISE EXCEPTION 'Scoped HR authority required'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM app.attendance_workflow_manager(w.employment_id) m WHERE m.employment_id=NEW.assigned_employment_id)
   THEN RAISE EXCEPTION 'The frozen manager no longer has live attendance authority; scoped HR handoff required'; END IF;
  SELECT e.person_id INTO assigned_person FROM public.employment e WHERE e.id=NEW.assigned_employment_id AND e.tenant_id=w.tenant_id;
  IF NEW.acting_mode='delegate' THEN
   IF NOT app.can_decide_via_delegation(w.employment_id,'attendance','attendance.correction')
    OR NOT app.can_decide_via_delegation_from(NEW.assigned_employment_id,w.employment_id,'attendance','attendance.correction')
    THEN RAISE EXCEPTION 'Valid assigned-manager delegation required'; END IF;
  ELSIF NEW.acting_mode<>'assigned' OR actual_person IS NULL OR actual_person IS DISTINCT FROM assigned_person OR NOT app.can_correct_attendance(w.employment_id)
   THEN RAISE EXCEPTION 'Assigned manager authority required'; END IF;
 END IF;
 IF NEW.previous_status<>'pending' OR NEW.resulting_status<>(CASE WHEN NEW.decision='rejected' OR NEW.stage_index=jsonb_array_length(w.stages)-1 THEN NEW.decision ELSE 'pending' END)
  THEN RAISE EXCEPTION 'Invalid stage outcome'; END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_effect_scope(subject_id uuid,wanted_date date DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_request w
  JOIN public.attendance_correction c ON c.id=w.correction_id AND c.employment_id=w.employment_id AND c.tenant_id=w.tenant_id
  JOIN public.attendance_workflow_decision d ON d.request_id=w.id AND d.tenant_id=w.tenant_id
  WHERE w.tenant_id=app.current_tenant_id() AND w.routing_version=2 AND w.employment_id=subject_id
   AND w.correction_id::text=current_setting('app.attendance_workflow_effect',true)
   -- Finalization independently verifies the raw effect before changing status. The same active
   -- writing transaction may then record formula OT and bank its approved TOIL. Both correction
   -- and decision must remain fresh; a committed/released-savepoint hint grants no authority.
   AND (c.status='pending' OR (c.status='approved' AND app.attendance_workflow_active_write(c.xmin)))
   AND (wanted_date IS NULL OR wanted_date=c.attendance_date)
   AND w.current_stage=jsonb_array_length(w.stages) AND d.stage_index=jsonb_array_length(w.stages)-1
   AND d.decision='approved' AND d.resulting_status='approved' AND d.actual_user_id=app.current_user_id()::text
   AND app.attendance_workflow_active_write(d.xmin)
   AND app.attendance_workflow_v2_assigned_allowed(c.id,d.stage_index,d.assigned_kind,d.assigned_employment_id,d.acting_mode))
 OR EXISTS(SELECT 1 FROM public.attendance_workflow_request w
  JOIN public.attendance_correction c ON c.id=w.correction_id AND c.employment_id=w.employment_id AND c.tenant_id=w.tenant_id
  JOIN public.attendance_workflow_decision d ON d.request_id=w.id AND d.tenant_id=w.tenant_id
  WHERE w.tenant_id=app.current_tenant_id() AND w.routing_version IN (3,4) AND w.employment_id=subject_id
   AND w.correction_id::text=current_setting('app.attendance_workflow_effect',true)
   AND (c.status='pending' OR (c.status='approved' AND app.attendance_workflow_active_write(c.xmin)))
   AND (wanted_date IS NULL OR wanted_date=c.attendance_date)
   AND w.current_stage=jsonb_array_length(w.stages) AND d.stage_index=jsonb_array_length(w.stages)-1
   AND d.decision='approved' AND d.resulting_status='approved' AND d.actual_user_id=app.current_user_id()::text
   AND app.attendance_workflow_active_write(d.xmin)
   AND app.attendance_workflow_v3_completion_write(w.id,d.stage_index,d.decision));
$$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_begin_effect(p_correction_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject_id uuid; old_hint text:=current_setting('app.attendance_workflow_effect',true);
BEGIN
 SELECT w.employment_id INTO subject_id FROM public.attendance_workflow_request w WHERE w.correction_id=p_correction_id AND w.tenant_id=app.current_tenant_id() AND w.routing_version IN (3,4);
 IF FOUND THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':'||subject_id::text,0));
  PERFORM 1 FROM public.attendance_correction c WHERE c.id=p_correction_id AND c.tenant_id=app.current_tenant_id() FOR UPDATE;
  PERFORM 1 FROM public.attendance_workflow_request w WHERE w.correction_id=p_correction_id AND w.tenant_id=app.current_tenant_id() AND w.routing_version IN (3,4) AND app.attendance_workflow_v3_advance(w.id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'A fulfilled active-write final participant level is required'; END IF;
  PERFORM set_config('app.attendance_workflow_effect',p_correction_id::text,true);
  IF NOT app.attendance_workflow_effect_scope(subject_id,NULL) THEN
   PERFORM set_config('app.attendance_workflow_effect',coalesce(old_hint,''),true);
   RAISE EXCEPTION 'An active-write final participant and completed level by the real actor are required';
  END IF;
  RETURN;
 END IF;
 SELECT w.employment_id INTO subject_id FROM public.attendance_workflow_request w WHERE w.correction_id=p_correction_id AND w.tenant_id=app.current_tenant_id() AND w.routing_version=2;
 IF NOT FOUND THEN RAISE EXCEPTION 'A versioned final Attendance approval is required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':'||subject_id::text,0));
 PERFORM 1 FROM public.attendance_correction c WHERE c.id=p_correction_id AND c.tenant_id=app.current_tenant_id() FOR UPDATE;
 PERFORM 1 FROM public.attendance_workflow_request w WHERE w.correction_id=p_correction_id AND w.tenant_id=app.current_tenant_id() AND w.routing_version=2 AND app.attendance_workflow_v2_decide(w.correction_id) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'A versioned final Attendance approval is required'; END IF;
 PERFORM set_config('app.attendance_workflow_effect',p_correction_id::text,true);
 IF NOT app.attendance_workflow_effect_scope(subject_id,NULL) THEN
  PERFORM set_config('app.attendance_workflow_effect',coalesce(old_hint,''),true);
  RAISE EXCEPTION 'A same-transaction final approval by the frozen assigned actor or authorized delegate is required';
 END IF;
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.guard_overtime_cash_source_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE olddoc jsonb;newdoc jsonb;doc jsonb;tenant_value uuid;emp uuid;on_date date;claim record;batch_status text;request_value uuid;seen text[]:='{}';source_key text;full_source_visibility boolean;requested_minutes integer;
BEGIN
 -- A non-final v3 completion records approval history, not a changed cash input. It may be written
 -- by the exact ordinary participant without granting Personnel/payroll visibility. Every other
 -- trigger (decision authority, links, immutability and RLS) still validates this INSERT.
 IF TG_TABLE_NAME='attendance_workflow_decision' AND TG_OP='INSERT' THEN
  IF NEW.tenant_id=app.current_tenant_id() AND NEW.actual_user_id=app.current_user_id()::text
   AND NEW.decision='approved' AND NEW.previous_status='pending' AND NEW.resulting_status='pending'
   AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w
    JOIN public.attendance_correction c ON c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.employment_id=w.employment_id
    WHERE w.id=NEW.request_id AND w.tenant_id=NEW.tenant_id AND w.routing_version IN (3,4) AND w.employment_id=NEW.employment_id
     AND c.status='pending' AND c.requested_ot_minutes IS NOT NULL AND w.current_stage=NEW.stage_index
     AND NEW.stage_index BETWEEN 0 AND jsonb_array_length(w.stages)-2
     AND app.attendance_workflow_v3_completion_write(w.id,NEW.stage_index,NEW.decision)
     AND EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision p
      WHERE p.request_id=w.id AND p.tenant_id=w.tenant_id AND p.employment_id=w.employment_id AND p.stage_index=NEW.stage_index
       AND p.actual_user_id=app.current_user_id() AND app.attendance_workflow_active_write(p.xmin)
       AND p.actual_user_id::text=NEW.actual_user_id AND p.actual_person_id IS NOT DISTINCT FROM NEW.actual_person_id
       AND p.actual_employment_id IS NOT DISTINCT FROM NEW.actual_employment_id AND p.acting_mode=NEW.acting_mode
       AND p.assigned->>'kind'=NEW.assigned_kind AND (p.assigned->>'employmentId')::uuid IS NOT DISTINCT FROM NEW.assigned_employment_id
       AND p.remarks IS NOT DISTINCT FROM NEW.remarks AND p.decision=NEW.decision))
   THEN RETURN NEW; END IF;
 END IF;
 -- FORCE RLS makes an empty owner read inconclusive unless this EFFECTIVE reader truly bypasses RLS.
 -- This is absence proof only: a protected source still requires its normal context and guards.
 olddoc:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;newdoc:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='attendance' THEN
   -- A referenced canonical day is an immutable source identity, including context-only sources.
   -- Check BEFORE derived-field/no-op shortcuts and before FK/RLS rejection of the new identity.
   IF (NEW.id,NEW.tenant_id,NEW.employment_id,NEW.attendance_date) IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.employment_id,OLD.attendance_date) AND EXISTS(SELECT 1 FROM public.attendance_overtime_source d WHERE d.attendance_id=OLD.id AND d.tenant_id=OLD.tenant_id) THEN RAISE EXCEPTION 'Referenced overtime Attendance identity is immutable' USING ERRCODE='23514';END IF;
  END IF;
  IF TG_TABLE_NAME='attendance' AND (olddoc->'check_in_at',olddoc->'check_out_at',olddoc->'status',olddoc->'absence_reason',olddoc->'day_type',olddoc->'worked_minutes',olddoc->'late_minutes',olddoc->'early_out_minutes',olddoc->'under_minutes',CASE WHEN jsonb_typeof(olddoc->'calc_trace')='object' THEN(olddoc->'calc_trace')-'overtime'-'overtimePattern' ELSE '{}'::jsonb END) IS NOT DISTINCT FROM(newdoc->'check_in_at',newdoc->'check_out_at',newdoc->'status',newdoc->'absence_reason',newdoc->'day_type',newdoc->'worked_minutes',newdoc->'late_minutes',newdoc->'early_out_minutes',newdoc->'under_minutes',CASE WHEN jsonb_typeof(newdoc->'calc_trace')='object' THEN(newdoc->'calc_trace')-'overtime'-'overtimePattern' ELSE '{}'::jsonb END) THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='attendance_punch' AND (olddoc->'employment_id',olddoc->'attendance_date',olddoc->'punch_at',olddoc->'direction',olddoc->'attendance_id',olddoc->'voided_at') IS NOT DISTINCT FROM(newdoc->'employment_id',newdoc->'attendance_date',newdoc->'punch_at',newdoc->'direction',newdoc->'attendance_id',newdoc->'voided_at') THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='attendance_correction' AND (olddoc-'reason'-'remarks') IS NOT DISTINCT FROM(newdoc-'reason'-'remarks') THEN RETURN NEW;END IF;
 END IF;
 SELECT rolsuper OR rolbypassrls INTO full_source_visibility FROM pg_catalog.pg_roles WHERE rolname=current_user;
 FOR doc IN SELECT value FROM jsonb_array_elements(jsonb_build_array(olddoc,newdoc)) WHERE value<>'null'::jsonb LOOP
  tenant_value:=(doc->>'tenant_id')::uuid;
  -- Non-OT requests/decisions are not formula approval inputs. Their actual clock effects still
  -- pass through Attendance/punch guards; OLD and NEW docs retain protection for removed OT inputs.
  IF TG_TABLE_NAME='attendance_correction' AND doc->>'requested_ot_minutes' IS NULL THEN CONTINUE;END IF;
  IF TG_TABLE_NAME='attendance_workflow_decision' THEN
   SELECT c.employment_id,c.attendance_date,c.requested_ot_minutes INTO emp,on_date,requested_minutes FROM public.attendance_workflow_request r JOIN public.attendance_correction c ON c.id=r.correction_id AND c.tenant_id=r.tenant_id WHERE r.id=(doc->>'request_id')::uuid AND r.tenant_id=tenant_value;
   IF FOUND AND requested_minutes IS NULL THEN CONTINUE;END IF;
  ELSE emp:=(doc->>'employment_id')::uuid;on_date:=(doc->>'attendance_date')::date;END IF;
  IF full_source_visibility AND emp IS NOT NULL AND on_date IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.attendance_overtime_source d WHERE d.tenant_id=tenant_value AND d.employment_id=emp AND d.attendance_date=on_date) THEN CONTINUE;END IF;
  IF tenant_value IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'Overtime input tenant mismatch' USING ERRCODE='42501';END IF;
  IF emp IS NULL OR on_date IS NULL THEN CONTINUE;END IF;source_key:=emp::text||':'||on_date::text;IF source_key=ANY(seen) THEN CONTINUE;END IF;seen:=array_append(seen,source_key);
  IF NOT(emp=ANY(app.visible_employment_ids()) OR app.can_admin_payroll_employment(emp)) THEN RAISE EXCEPTION 'Canonical Attendance subject authority is required' USING ERRCODE='42501';END IF;
  -- Raw input is already Attendance-row locked. Serialize source claims BEFORE batch locks; do not
  -- acquire employee advisory here (actual calculation takes employee -> Attendance -> source).
  PERFORM d.id FROM public.attendance_overtime_source d WHERE d.tenant_id=tenant_value AND d.employment_id=emp AND d.attendance_date=on_date ORDER BY d.id FOR UPDATE;
  -- Tenant plus subject authority makes the matching source visible even under FORCE RLS.
  IF NOT FOUND THEN CONTINUE;END IF;
  IF EXISTS(SELECT 1 FROM public.overtime_source_settlement st JOIN public.attendance_overtime_source d ON d.id=st.source_id WHERE st.tenant_id=tenant_value AND d.tenant_id=tenant_value AND d.employment_id=emp AND d.attendance_date=on_date AND st.mode='toil' AND st.released_at IS NULL) THEN RAISE EXCEPTION 'Reverse and release canonical TOIL before changing its overtime source' USING ERRCODE='23514';END IF;
  -- The existing private owner locks every relevant batch in stable ID order, including draft runs.
  PERFORM * FROM app.attendance_payroll_protection_rows(emp);
  FOR claim IN SELECT st.id,st.payroll_batch_id,d.id AS source_id FROM public.overtime_source_settlement st JOIN public.attendance_overtime_source d ON d.id=st.source_id WHERE st.tenant_id=tenant_value AND d.tenant_id=tenant_value AND d.employment_id=emp AND d.attendance_date=on_date AND st.mode='cash' AND st.released_at IS NULL ORDER BY st.payroll_batch_id LOOP
   SELECT status::text INTO batch_status FROM public.payroll_batch WHERE id=claim.payroll_batch_id AND tenant_id=tenant_value FOR UPDATE;
   IF batch_status='closed' THEN RAISE EXCEPTION 'Closed Payroll protects this overtime source; use its controlled adjustment workflow' USING ERRCODE='23514';END IF;
   IF batch_status='processed' THEN
    UPDATE public.payroll_batch SET needs_recalc_at=now(),recalc_employment_ids=(SELECT coalesce(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM jsonb_array_elements(coalesce(recalc_employment_ids,'[]'::jsonb)||jsonb_build_array(emp::text))) WHERE id=claim.payroll_batch_id AND tenant_id=tenant_value AND status='processed';
   END IF;
   -- Append invalidation evidence; do NOT take a source row lock after the batch (cash transfer uses
   -- employee -> source -> batch). Fresh canonical digests remain the settlement/close authority.
   INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(tenant_value,'overtime-pattern',claim.source_id,'overtime.cash-source.invalidated','user',app.current_user_id(),emp,jsonb_build_object('sourceId',claim.source_id,'batchId',claim.payroll_batch_id,'date',on_date,'inputOwner',TG_TABLE_NAME,'operation',TG_OP));
  END LOOP;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_effective(wanted_request uuid,wanted_stage integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(coalesce((SELECT r.assigned FROM public.attendance_workflow_participant_reassignment r
  WHERE r.tenant_id=w.tenant_id AND r.request_id=w.id AND r.stage_index=wanted_stage AND r.participant_slot=a.actor->>'slot'
  ORDER BY r.occurred_at DESC,r.id DESC LIMIT 1),a.actor) ORDER BY a.ordinality),'[]')
 FROM public.attendance_workflow_request w
 CROSS JOIN LATERAL jsonb_array_elements(w.stages->wanted_stage->'approvers') WITH ORDINALITY a(actor,ordinality)
 WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id() AND w.routing_version IN (3,4);
$$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_actor(wanted_request uuid,wanted_stage integer,wanted_slot text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN wanted_slot=wanted_stage::text||':hr' AND w.stages->wanted_stage->>'hrAlternative'='true'
  AND ((w.routing_version=3 AND w.stages->wanted_stage->'source'->>'kind'='direct_manager') OR (w.routing_version=4 AND jsonb_array_length(w.stages->wanted_stage->'sources')=1 AND w.stages->wanted_stage->'sources'->0->>'kind'='direct_manager'))
  THEN jsonb_build_object('slot',wanted_slot,'kind','hr_admin','employmentId',NULL,'name','HR administrators')
  ELSE (SELECT a FROM jsonb_array_elements(app.attendance_workflow_v3_effective(w.id,wanted_stage)) a WHERE a->>'slot'=wanted_slot) END
 FROM public.attendance_workflow_request w WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id()
  AND w.routing_version IN (3,4) AND wanted_stage BETWEEN 0 AND jsonb_array_length(w.stages)-1;
$$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_assigned_allowed(wanted_request uuid,wanted_stage integer,wanted_slot text,acting text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; caller public.app_user; actor jsonb; subject_person uuid;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.id=wanted_request AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND OR NOT app.principal_snapshot_current() THEN RETURN false; END IF;
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT FOUND OR caller.person_id IS NULL THEN RETURN false; END IF;
 SELECT e.person_id INTO subject_person FROM public.employment e WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 IF caller.person_id=subject_person THEN RETURN false; END IF;
 actor:=app.attendance_workflow_v3_actor(w.id,wanted_stage,wanted_slot);
 IF actor IS NULL THEN RETURN false; END IF;
 IF actor->>'kind'='hr_admin' THEN
  RETURN acting='assigned' AND app.is_admin_for(w.company_id) AND EXISTS(SELECT 1 FROM public.role_assignment r
   WHERE r.app_user_id=caller.id AND r.tenant_id=w.tenant_id AND r.role::text IN ('hr_admin','super_admin')
    AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)));
 END IF;
 IF actor->>'kind' NOT IN ('direct_manager','specific_employee') OR acting NOT IN ('assigned','delegate') THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
  WHERE e.id=(actor->>'employmentId')::uuid AND e.person_id=(actor->>'personId')::uuid AND e.tenant_id=w.tenant_id
   AND u.id=(actor->>'userId')::uuid AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND e.person_id<>subject_person AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND app.is_company_descendant(w.company_id,e.company_id)
   AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=w.tenant_id
    AND r.role::text IN ('employee','manager','hr_admin','super_admin')
    AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))) THEN RETURN false; END IF;
 IF acting='assigned' THEN RETURN caller.id=(actor->>'userId')::uuid AND caller.person_id=(actor->>'personId')::uuid; END IF;
 RETURN app.can_decide_via_delegation_from((actor->>'employmentId')::uuid,w.employment_id,'attendance','attendance.correction');
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_outstanding(wanted_request uuid,wanted_stage integer,wanted_slot text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; first_slot text;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.id=wanted_request AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND OR w.current_stage<>wanted_stage OR wanted_stage>=jsonb_array_length(w.stages)
  OR NOT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.status='pending')
  OR app.attendance_workflow_v3_actor(w.id,wanted_stage,wanted_slot) IS NULL
  OR EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage)
  OR EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage
   AND (d.participant_slot=wanted_slot OR d.decision='rejected' OR d.participant_slot=wanted_stage::text||':hr' OR w.stages->wanted_stage->>'mode'='any_one')) THEN RETURN false; END IF;
 IF wanted_slot=wanted_stage::text||':hr' THEN RETURN true; END IF;
 IF w.stages->wanted_stage->>'mode'='any_one' OR (w.routing_version=4 AND w.stages->wanted_stage->>'mode'='all_required') THEN RETURN true; END IF;
 SELECT a->>'slot' INTO first_slot FROM jsonb_array_elements(app.attendance_workflow_v3_effective(w.id,wanted_stage)) WITH ORDINALITY x(a,ordinality)
  WHERE NOT EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage AND d.participant_slot=a->>'slot')
  ORDER BY ordinality LIMIT 1;
 RETURN first_slot=wanted_slot;
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_participant_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; actor public.app_user;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Participant decision history is immutable'; END IF;
 SELECT r.* INTO STRICT w FROM public.attendance_workflow_request r WHERE r.id=NEW.request_id AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 PERFORM pg_advisory_xact_lock(hashtextextended(w.tenant_id::text||':'||w.employment_id::text,0));
 PERFORM 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id FOR UPDATE;
 SELECT r.* INTO STRICT w FROM public.attendance_workflow_request r WHERE r.id=w.id AND r.tenant_id=w.tenant_id FOR UPDATE;
 SELECT u.* INTO actor FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT FOUND OR actor.person_id IS NULL OR NEW.actual_user_id<>actor.id OR NEW.actual_person_id<>actor.person_id OR NEW.tenant_id<>w.tenant_id OR NEW.employment_id<>w.employment_id
  OR NOT app.attendance_workflow_v3_outstanding(w.id,NEW.stage_index,NEW.participant_slot)
  OR NOT app.attendance_workflow_v3_assigned_allowed(w.id,NEW.stage_index,NEW.participant_slot,NEW.acting_mode)
  OR NEW.assigned IS DISTINCT FROM app.attendance_workflow_v3_actor(w.id,NEW.stage_index,NEW.participant_slot)
  OR EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.tenant_id=w.tenant_id AND d.request_id=w.id AND (d.actual_user_id=actor.id OR d.actual_person_id=actor.person_id))
  OR (NEW.actual_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.actual_employment_id AND e.tenant_id=w.tenant_id AND e.person_id=actor.person_id))
  OR (coalesce(current_setting('app.attendance_workflow_effect',true),'')<>'' AND current_setting('app.attendance_workflow_effect',true)<>w.correction_id::text)
  THEN RAISE EXCEPTION 'Only the next distinct authorized frozen participant may decide this pending slot'; END IF;
 SELECT coalesce(p.full_name,actor.id::text) INTO NEW.actual_actor_name FROM public.person p WHERE p.id=actor.person_id AND p.tenant_id=w.tenant_id;
 NEW.decided_at:=clock_timestamp(); RETURN NEW;
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_read(correction uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; i integer; a jsonb;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.correction_id=correction AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND THEN RETURN false; END IF;
 IF app.can_see_employment(w.employment_id) THEN RETURN true; END IF;
 FOR i IN 0..jsonb_array_length(w.stages)-1 LOOP
  FOR a IN SELECT value FROM jsonb_array_elements(app.attendance_workflow_v3_effective(w.id,i)) LOOP
   IF app.attendance_workflow_v3_assigned_allowed(w.id,i,a->>'slot','assigned') OR app.attendance_workflow_v3_assigned_allowed(w.id,i,a->>'slot','delegate') THEN RETURN true; END IF;
  END LOOP;
  IF app.attendance_workflow_v3_assigned_allowed(w.id,i,i::text||':hr','assigned') THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_decision_slot(correction uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; a jsonb; slot text; actor_person uuid;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.correction_id=correction AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND OR w.current_stage>=jsonb_array_length(w.stages) THEN RETURN NULL; END IF;
 SELECT u.person_id INTO actor_person FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT FOUND OR actor_person IS NULL OR EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=app.current_user_id() OR d.actual_person_id=actor_person)) THEN RETURN NULL; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(app.attendance_workflow_v3_effective(w.id,w.current_stage)) LOOP
  slot:=a->>'slot';
  IF app.attendance_workflow_v3_outstanding(w.id,w.current_stage,slot) THEN
   IF app.attendance_workflow_v3_assigned_allowed(w.id,w.current_stage,slot,'assigned') THEN RETURN jsonb_build_object('slot',slot,'assigned',a,'actingMode','assigned'); END IF;
   IF app.attendance_workflow_v3_assigned_allowed(w.id,w.current_stage,slot,'delegate') THEN RETURN jsonb_build_object('slot',slot,'assigned',a,'actingMode','delegate'); END IF;
  END IF;
 END LOOP;
 slot:=w.current_stage::text||':hr';
 IF app.attendance_workflow_v3_outstanding(w.id,w.current_stage,slot) AND app.attendance_workflow_v3_assigned_allowed(w.id,w.current_stage,slot,'assigned')
  THEN RETURN jsonb_build_object('slot',slot,'assigned',app.attendance_workflow_v3_actor(w.id,w.current_stage,slot),'actingMode','assigned'); END IF;
 RETURN NULL;
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_completed(wanted_request uuid,wanted_stage integer) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; count_approved integer; count_all integer; needed integer;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.id=wanted_request AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND OR NOT app.attendance_workflow_v3_read(w.correction_id) OR wanted_stage NOT BETWEEN 0 AND jsonb_array_length(w.stages)-1 THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage AND d.decision='rejected') THEN RETURN 'rejected'; END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage AND d.participant_slot=wanted_stage::text||':hr' AND d.decision='approved') THEN RETURN 'approved'; END IF;
 SELECT count(*)::integer,count(*) FILTER(WHERE d.decision='approved')::integer INTO count_all,count_approved FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage;
 IF w.stages->wanted_stage->>'mode'='any_one' AND count_all=1 AND count_approved=1 THEN RETURN 'approved'; END IF;
 needed:=jsonb_array_length(app.attendance_workflow_v3_effective(w.id,wanted_stage));
 IF (w.stages->wanted_stage->>'mode'='sequential' OR (w.routing_version=4 AND w.stages->wanted_stage->>'mode'='all_required')) AND needed>0 AND count_all=needed AND count_approved=needed THEN RETURN 'approved'; END IF;
 RETURN NULL;
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_completion_write(wanted_request uuid,wanted_stage integer,wanted_decision text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_request w JOIN public.attendance_workflow_participant_decision p ON p.request_id=w.id AND p.tenant_id=w.tenant_id
  WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id() AND w.routing_version IN (3,4) AND p.stage_index=wanted_stage
   AND p.actual_user_id=app.current_user_id() AND app.attendance_workflow_active_write(p.xmin)
   AND app.attendance_workflow_v3_completed(w.id,wanted_stage)=wanted_decision AND p.decision=wanted_decision
   AND app.attendance_workflow_v3_assigned_allowed(w.id,wanted_stage,p.participant_slot,p.acting_mode));
$$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_advance(wanted_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_request w JOIN public.attendance_workflow_decision d ON d.request_id=w.id AND d.tenant_id=w.tenant_id
  WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id() AND w.routing_version IN (3,4) AND d.actual_user_id=app.current_user_id()::text
   AND app.attendance_workflow_active_write(d.xmin) AND app.attendance_workflow_v3_completion_write(w.id,d.stage_index,d.decision)
   AND (w.current_stage=d.stage_index OR w.current_stage=d.stage_index+1 OR (d.decision='rejected' AND w.current_stage=jsonb_array_length(w.stages))));
$$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_reassignment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; caller public.app_user; subject_person uuid; prior jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Participant reassignment history is immutable'; END IF;
 SELECT r.* INTO STRICT w FROM public.attendance_workflow_request r WHERE r.id=NEW.request_id AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 PERFORM pg_advisory_xact_lock(hashtextextended(w.tenant_id::text||':'||w.employment_id::text,0));
 PERFORM 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id FOR UPDATE;
 SELECT r.* INTO STRICT w FROM public.attendance_workflow_request r WHERE r.id=w.id AND r.tenant_id=w.tenant_id FOR UPDATE;
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 SELECT e.person_id INTO subject_person FROM public.employment e WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 prior:=app.attendance_workflow_v3_actor(w.id,NEW.stage_index,NEW.participant_slot);
 IF caller.id IS NULL OR caller.person_id IS NULL OR caller.person_id=subject_person OR NEW.tenant_id<>w.tenant_id
  OR NEW.actual_user_id<>caller.id OR NEW.actual_person_id<>caller.person_id OR NOT app.is_admin_for(w.company_id)
  OR NOT EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=w.tenant_id AND r.app_user_id=caller.id AND r.role::text IN ('hr_admin','super_admin')
   AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))
  OR NEW.stage_index<>w.current_stage OR w.current_stage>=jsonb_array_length(w.stages)
  OR NOT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.status='pending')
  OR prior IS NULL OR NEW.previous_assigned IS DISTINCT FROM prior OR NEW.assigned IS DISTINCT FROM jsonb_build_object('slot',NEW.participant_slot,'kind','hr_admin','employmentId',NULL,'name','HR administrators')
  OR NOT app.attendance_workflow_has_hr(w.employment_id)
  OR EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision p WHERE p.request_id=w.id AND p.tenant_id=w.tenant_id AND p.stage_index=w.current_stage
   AND (p.participant_slot=NEW.participant_slot OR p.decision='rejected' OR p.participant_slot=w.current_stage::text||':hr' OR w.stages->w.current_stage->>'mode'='any_one'))
  OR EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=w.current_stage)
  THEN RAISE EXCEPTION 'A reasoned scoped HR reassignment may replace only an outstanding frozen participant slot'; END IF;
 SELECT coalesce(p.full_name,caller.id::text) INTO NEW.actual_actor_name FROM public.person p WHERE p.id=caller.person_id AND p.tenant_id=w.tenant_id;
 NEW.occurred_at:=clock_timestamp(); RETURN NEW;
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.routing_version IN (3,4) AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d
  WHERE d.request_id=OLD.id AND d.tenant_id=OLD.tenant_id AND d.stage_index=OLD.current_stage
   AND d.actual_user_id=app.current_user_id()::text AND app.attendance_workflow_active_write(d.xmin)
   AND app.attendance_workflow_v3_completion_write(OLD.id,d.stage_index,d.decision)
   AND ((d.decision='approved' AND NEW.current_stage=OLD.current_stage+1) OR (d.decision='rejected' AND NEW.current_stage=jsonb_array_length(OLD.stages))))
  THEN RAISE EXCEPTION 'A fulfilled same-active-write participant level completion is required'; END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- Extend 0570_attendance_participant_approval.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_correction_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; allowed text[]:=ARRAY['status','reject_reason','decided_by_employment_id','decided_at','approved_ot_minutes','ot_approval_method','applied_at','cancelled_at','cancelled_by_user_id','cancellation_kind','cancellation_reason','admin_amendment'];
BEGIN
 IF coalesce(current_setting('app.attendance_workflow_effect',true),'')<>'' AND current_setting('app.attendance_workflow_effect',true)<>OLD.id::text THEN
  -- Existing approved OT plans may land as a derived consequence of this exact day's clock correction.
  -- No new approval or formula is introduced. Claim and value stamp are separate canonical writes.
  IF OLD.status='approved' AND OLD.requested_ot_minutes IS NOT NULL AND OLD.proposed_check_in IS NULL AND OLD.proposed_check_out IS NULL AND OLD.clock_changes IS NULL
   AND app.attendance_workflow_effect_scope(OLD.employment_id,OLD.attendance_date)
   AND (to_jsonb(OLD)-ARRAY['applied_at','approved_ot_minutes']) IS NOT DISTINCT FROM (to_jsonb(NEW)-ARRAY['applied_at','approved_ot_minutes']) THEN
   IF OLD.applied_at IS NULL AND NEW.applied_at=transaction_timestamp() AND NEW.approved_ot_minutes IS NOT DISTINCT FROM OLD.approved_ot_minutes
    AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.tenant_id=OLD.tenant_id AND a.employment_id=OLD.employment_id AND a.attendance_date=OLD.attendance_date AND app.attendance_workflow_active_write(a.xmin)) THEN RETURN NEW; END IF;
   IF OLD.applied_at IS NOT NULL AND NEW.applied_at=OLD.applied_at
    AND EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=OLD.id AND c.tenant_id=OLD.tenant_id AND app.attendance_workflow_active_write(c.xmin))
    AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.tenant_id=OLD.tenant_id AND a.employment_id=OLD.employment_id AND a.attendance_date=OLD.attendance_date
      AND app.attendance_workflow_active_write(a.xmin) AND a.calc_trace->'overtime'->'approvedMinutes'=to_jsonb(NEW.approved_ot_minutes)) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'A request effect cannot mutate another attendance application except the canonical same-day approved plan landing';
 END IF;
 SELECT f.* INTO w FROM public.attendance_workflow_request f WHERE f.correction_id=OLD.id AND f.tenant_id=OLD.tenant_id AND f.routing_version IN (3,4);
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status='cancelled' AND NOT app.is_admin_for(w.company_id)
  AND NOT EXISTS(SELECT 1 FROM public.app_user u JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND e.id=w.employment_id)
  THEN RAISE EXCEPTION 'Only the applicant or scoped HR may cancel this application'; END IF;
 IF (to_jsonb(OLD)-allowed) IS DISTINCT FROM (to_jsonb(NEW)-allowed)
  THEN RAISE EXCEPTION 'Submitted Attendance application inputs are frozen; withdraw and submit a new application'; END IF;
 IF OLD.status<>'pending' AND (NEW.decided_by_employment_id,NEW.decided_at,NEW.reject_reason,NEW.ot_approval_method) IS DISTINCT FROM (OLD.decided_by_employment_id,OLD.decided_at,OLD.reject_reason,OLD.ot_approval_method)
  THEN RAISE EXCEPTION 'Saved approval identity, outcome and overtime method are immutable'; END IF;
 IF OLD.status<>'pending' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status='approved' AND NEW.status='cancelled')
  THEN RAISE EXCEPTION 'A completed Attendance application cannot be reopened or decided again'; END IF;
 IF OLD.status='approved' AND (NEW.approved_ot_minutes,NEW.applied_at) IS DISTINCT FROM (OLD.approved_ot_minutes,OLD.applied_at) THEN
  IF (to_jsonb(OLD)-ARRAY['applied_at','approved_ot_minutes']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['applied_at','approved_ot_minutes']) THEN RAISE EXCEPTION 'Plan landing cannot alter approval status, inputs or identity'; END IF;
  IF OLD.requested_ot_minutes IS NULL OR OLD.proposed_check_in IS NOT NULL OR OLD.proposed_check_out IS NOT NULL OR OLD.clock_changes IS NOT NULL
   OR NOT app.can_see_employment(OLD.employment_id)
   OR NOT EXISTS(SELECT 1 FROM public.attendance a WHERE a.tenant_id=OLD.tenant_id AND a.employment_id=OLD.employment_id AND a.attendance_date=OLD.attendance_date AND app.attendance_workflow_active_write(a.xmin))
   THEN RAISE EXCEPTION 'Only a freshly written canonical same-day attendance result may land an approved overtime plan'; END IF;
  IF OLD.applied_at IS NULL AND NEW.applied_at=transaction_timestamp() AND NEW.approved_ot_minutes IS NOT DISTINCT FROM OLD.approved_ot_minutes THEN RETURN NEW; END IF;
  IF OLD.applied_at IS NOT NULL AND NEW.applied_at=OLD.applied_at
   AND EXISTS(SELECT 1 FROM public.attendance_correction p WHERE p.id=OLD.id AND p.tenant_id=OLD.tenant_id AND app.attendance_workflow_active_write(p.xmin))
   AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.tenant_id=OLD.tenant_id AND a.employment_id=OLD.employment_id AND a.attendance_date=OLD.attendance_date AND app.attendance_workflow_active_write(a.xmin) AND a.calc_trace->'overtime'->'approvedMinutes'=to_jsonb(NEW.approved_ot_minutes)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Approved overtime plan stamps must equal the freshly written canonical amount';
 END IF;
 IF OLD.status='pending' AND (NEW.approved_ot_minutes,NEW.ot_approval_method,NEW.applied_at) IS DISTINCT FROM (OLD.approved_ot_minutes,OLD.ot_approval_method,OLD.applied_at)
  AND NOT app.attendance_workflow_effect_scope(OLD.employment_id,OLD.attendance_date)
  THEN RAISE EXCEPTION 'Only the verified final request effect may stamp approved overtime'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved','rejected') THEN
  IF OLD.status<>'pending' OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id
   AND d.actual_user_id=app.current_user_id()::text AND d.resulting_status=NEW.status::text AND app.attendance_workflow_active_write(d.xmin)
   AND w.current_stage=jsonb_array_length(w.stages) AND (NEW.status='rejected' OR d.stage_index=jsonb_array_length(w.stages)-1)
   AND app.attendance_workflow_v3_completion_write(w.id,d.stage_index,d.decision))
   THEN RAISE EXCEPTION 'A same-transaction final frozen workflow decision is required'; END IF;
  IF NEW.status='approved' AND NOT app.attendance_workflow_final_effect(OLD.id,NEW.approved_ot_minutes)
   THEN RAISE EXCEPTION 'Final approval requires live calculation access and the verified canonical target-day effect, or a genuine future overtime-only deferral'; END IF;
 END IF;
 IF coalesce(current_setting('app.attendance_workflow_effect',true),'')<>'' AND current_setting('app.attendance_workflow_effect',true)<>OLD.id::text
  THEN RAISE EXCEPTION 'A request effect cannot mutate another attendance application'; END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- Extend 0575_attendance_request_participant_review.sql; preserve its existing non-v4 authority/effect rules.
CREATE OR REPLACE FUNCTION app.attendance_workflow_review_participants(p_correction uuid)
RETURNS TABLE(participant_slot text,employment_id uuid,employee_code text,kind text,eligible boolean,acting_mode text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 w public.attendance_workflow_request; request_status text; subject_person uuid;
 actors jsonb; actor jsonb; candidate_emp uuid; candidate_person uuid; candidate_user uuid;
 candidate_slot text; candidate_kind text; candidate_code text; candidate_ok boolean;
 hr_ok boolean; any_eligible boolean:=false; has_actor boolean:=false; ordinal integer:=0;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r
 WHERE r.correction_id=p_correction AND r.tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN; END IF;
 SELECT c.status::text INTO request_status FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id;
 IF request_status IS DISTINCT FROM 'pending' OR w.current_stage>=jsonb_array_length(w.stages) THEN RETURN; END IF;
 IF NOT app.is_admin_for(w.company_id) OR NOT EXISTS(
  SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
  WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND r.role::text IN ('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))
 THEN RETURN; END IF;
 SELECT e.person_id INTO subject_person FROM public.employment e WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 SELECT EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
  WHERE u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND u.person_id IS DISTINCT FROM subject_person AND (w.routing_version NOT IN (3,4) OR u.person_id IS NOT NULL)
   AND r.role::text IN ('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id))
   AND (w.routing_version=1 OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id::text OR d.actual_person_id=u.person_id)))
   AND (w.routing_version NOT IN (3,4) OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id OR d.actual_person_id=u.person_id)))) INTO hr_ok;
 IF w.routing_version IN (3,4) THEN
  actors:=app.attendance_workflow_v3_effective(w.id,w.current_stage);
  actor:=app.attendance_workflow_v3_actor(w.id,w.current_stage,w.current_stage::text||':hr');
  IF actor IS NOT NULL THEN actors:=actors||jsonb_build_array(actor); END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.stage_index=w.current_stage) THEN RETURN; END IF;
  actors:=app.attendance_workflow_effective_approvers(w.id,w.current_stage);
 END IF;
 IF jsonb_typeof(actors) IS DISTINCT FROM 'array' THEN RETURN; END IF;
 FOR actor IN SELECT value FROM jsonb_array_elements(actors) LOOP
  candidate_kind:=actor->>'kind'; candidate_code:=NULL; candidate_emp:=NULL; candidate_person:=NULL; candidate_user:=NULL;
  candidate_slot:=coalesce(actor->>'slot',w.current_stage::text||':'||ordinal::text); ordinal:=ordinal+1;
  IF candidate_kind IS NULL OR candidate_kind NOT IN ('direct_manager','specific_employee','hr_admin') THEN CONTINUE; END IF;
  has_actor:=true;
  IF w.routing_version IN (3,4) AND NOT app.attendance_workflow_v3_outstanding(w.id,w.current_stage,candidate_slot) THEN CONTINUE; END IF;
  IF candidate_kind='hr_admin' THEN
   candidate_ok:=hr_ok;
  ELSE
   IF coalesce(actor->>'employmentId','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN candidate_emp:=(actor->>'employmentId')::uuid; END IF;
   IF coalesce(actor->>'personId','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN candidate_person:=(actor->>'personId')::uuid; END IF;
   IF coalesce(actor->>'userId','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN candidate_user:=(actor->>'userId')::uuid; END IF;
   SELECT e.employee_code INTO candidate_code FROM public.employment e WHERE e.id=candidate_emp AND e.tenant_id=w.tenant_id;
   -- Mirrors the live identity/grant preconditions of frozen v2/v3 assigned authority. The
   -- request's saved user/person are checked directly; additional live logins do not replace them.
   SELECT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
    WHERE e.id=candidate_emp AND e.tenant_id=w.tenant_id AND e.person_id<>subject_person
     AND (w.routing_version=1 OR (e.person_id=candidate_person AND u.id=candidate_user))
     AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
     AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
     AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND app.is_company_descendant(w.company_id,e.company_id)
     AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=w.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin')
      AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))
     AND (w.routing_version=1 OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id::text OR d.actual_person_id=u.person_id)))
     AND (w.routing_version NOT IN (3,4) OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id OR d.actual_person_id=u.person_id)))
     AND (w.routing_version<>1 OR EXISTS(SELECT 1 FROM app.attendance_workflow_manager(w.employment_id) m WHERE m.employment_id=e.id))) INTO candidate_ok;
  END IF;
  any_eligible:=any_eligible OR coalesce(candidate_ok,false);
  RETURN QUERY SELECT candidate_slot,candidate_emp,candidate_code,candidate_kind,coalesce(candidate_ok,false),'assigned'::text;
 END LOOP;
 -- Legacy routes allow a reasoned scoped-HR decision on behalf; do not pretend HR was an
 -- individually frozen assignment. New v3 routes instead require their recorded HR alternative.
 IF w.routing_version IN (1,2) AND has_actor AND NOT any_eligible AND hr_ok THEN
  RETURN QUERY SELECT NULL::text,NULL::uuid,NULL::text,'hr_admin'::text,true,'administrator'::text;
 END IF;
END $$;

--> statement-breakpoint
DROP POLICY attendance_workflow_v3_request_read ON public.attendance_workflow_request;
CREATE POLICY attendance_workflow_v3_request_read ON public.attendance_workflow_request FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND routing_version IN (3,4) AND app.attendance_workflow_v3_read(correction_id));

--> statement-breakpoint
DROP POLICY attendance_workflow_v3_request_advance ON public.attendance_workflow_request;
CREATE POLICY attendance_workflow_v3_request_advance ON public.attendance_workflow_request FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND routing_version IN (3,4) AND (app.attendance_workflow_v3_decision_slot(correction_id) IS NOT NULL OR app.attendance_workflow_v3_advance(id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND routing_version IN (3,4) AND app.attendance_workflow_v3_advance(id));

--> statement-breakpoint
DROP POLICY attendance_workflow_v3_reassignment_insert ON public.attendance_workflow_participant_reassignment;
CREATE POLICY attendance_workflow_v3_reassignment_insert ON public.attendance_workflow_participant_reassignment FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND actual_user_id=app.current_user_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.tenant_id=app.current_tenant_id() AND w.routing_version IN (3,4) AND app.is_admin_for(w.company_id)));

--> statement-breakpoint
-- Retiring configuration shares submission's company/type lock and checks every frozen version.
CREATE FUNCTION app.attendance_workflow_retire(wanted_lineage uuid,expected_version integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_template public.attendance_workflow_template;
BEGIN
 IF NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'A current administrator identity is required'; END IF;
 SELECT t.* INTO current_template FROM public.attendance_workflow_template t WHERE t.lineage_id=wanted_lineage AND t.tenant_id=app.current_tenant_id() AND t.superseded_at IS NULL;
 IF NOT FOUND OR NOT app.is_admin_for(current_template.company_id) THEN RAISE EXCEPTION 'The workflow is no longer available'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(current_template.tenant_id::text||':attendance-workflow:'||current_template.company_id::text||':'||current_template.application_type,0));
 SELECT t.* INTO current_template FROM public.attendance_workflow_template t WHERE t.id=current_template.id AND t.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF current_template.superseded_at IS NOT NULL OR current_template.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'The workflow changed; reload before deleting' USING ERRCODE='P5102'; END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_request w JOIN public.attendance_workflow_template t ON t.id=w.template_id AND t.tenant_id=w.tenant_id JOIN public.attendance_correction c ON c.id=w.correction_id AND c.tenant_id=w.tenant_id WHERE t.lineage_id=wanted_lineage AND w.tenant_id=app.current_tenant_id() AND c.status='pending') THEN RAISE EXCEPTION 'Pending applications still depend on this workflow' USING ERRCODE='P5101'; END IF;
 UPDATE public.attendance_workflow_template SET superseded_at=clock_timestamp(),retired_at=clock_timestamp() WHERE id=current_template.id AND tenant_id=current_template.tenant_id;
 RETURN current_template.id;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_retire(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_retire(uuid,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_retirement_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
  IF OLD.retired_at IS NOT NULL OR OLD.superseded_at IS NOT NULL OR NEW.retired_at IS NULL OR NEW.superseded_at IS NULL OR NOT app.principal_snapshot_current() OR NOT app.is_admin_for(OLD.company_id) THEN RAISE EXCEPTION 'A current workflow and administrator are required to delete configuration'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.tenant_id::text||':attendance-workflow:'||OLD.company_id::text||':'||OLD.application_type,0));
  IF EXISTS(SELECT 1 FROM public.attendance_workflow_request w JOIN public.attendance_workflow_template t ON t.id=w.template_id AND t.tenant_id=w.tenant_id JOIN public.attendance_correction c ON c.id=w.correction_id AND c.tenant_id=w.tenant_id WHERE t.lineage_id=OLD.lineage_id AND w.tenant_id=OLD.tenant_id AND c.status='pending') THEN RAISE EXCEPTION 'Pending applications still depend on this workflow' USING ERRCODE='P5101'; END IF;
 END IF;
 IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN RAISE EXCEPTION 'Retained workflow versions cannot be reopened or rewritten'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_retirement_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_workflow_retirement_authority BEFORE UPDATE ON public.attendance_workflow_template FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_retirement_guard();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_workflow_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Approval routing history is immutable'; END IF;
 IF TG_TABLE_NAME='attendance_workflow_template' THEN
  IF to_jsonb(OLD)-'superseded_at'-'retired_at' IS DISTINCT FROM to_jsonb(NEW)-'superseded_at'-'retired_at' THEN RAISE EXCEPTION 'Workflow versions are immutable'; END IF;
 ELSIF TG_TABLE_NAME='attendance_workflow_request' THEN
  IF to_jsonb(OLD)-'current_stage' IS DISTINCT FROM to_jsonb(NEW)-'current_stage' THEN RAISE EXCEPTION 'Submitted routing is immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=OLD.id
   AND d.tenant_id=OLD.tenant_id AND d.stage_index=OLD.current_stage
   AND d.actual_user_id=coalesce(app.current_user_id()::text,'system')
   AND ((d.decision='approved' AND NEW.current_stage=OLD.current_stage+1)
    OR (d.decision='rejected' AND NEW.current_stage=jsonb_array_length(OLD.stages))))
   THEN RAISE EXCEPTION 'A recorded current-stage decision is required to advance routing'; END IF;
 ELSE RAISE EXCEPTION 'Approval decisions are immutable'; END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- Durable notification-only CC. No address, content or subject is accepted by the private send IPC.
CREATE TABLE public.attendance_workflow_cc_delivery (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),request_id uuid NOT NULL REFERENCES public.attendance_workflow_request(id),
 source_event_id uuid NOT NULL REFERENCES public.domain_event(id),source_sequence bigint NOT NULL,event_key text NOT NULL,template_version integer NOT NULL,
 address text NOT NULL,recipient_kind text NOT NULL CHECK(recipient_kind IN('employee','custom_email')),recipient_employment_id uuid REFERENCES public.employment(id),recipient_user_id uuid REFERENCES public.app_user(id),
 message jsonb NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sent','skipped','failed','uncertain')),attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 last_error text,lease_token uuid,lease_until timestamptz,started_at timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,template_version,event_key,address),CHECK(address=lower(address) AND length(address) BETWEEN 3 AND 320),CHECK((recipient_kind='employee' AND recipient_employment_id IS NOT NULL AND recipient_user_id IS NOT NULL) OR (recipient_kind='custom_email' AND recipient_employment_id IS NULL AND recipient_user_id IS NULL))
);
CREATE INDEX attendance_workflow_cc_due ON public.attendance_workflow_cc_delivery(tenant_id,next_attempt_at,id) WHERE status='pending';
ALTER TABLE public.attendance_workflow_cc_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_workflow_cc_delivery FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.attendance_workflow_cc_delivery TO ai_hr_app;
CREATE POLICY attendance_workflow_cc_admin_read ON public.attendance_workflow_cc_delivery FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.tenant_id=app.current_tenant_id() AND app.is_admin_for(w.company_id)));
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_cc_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request;participant public.attendance_workflow_participant_decision;correction public.attendance_correction;recipient jsonb;applicant_name text;actor_name text;action text;event_key text;at_time timestamptz;level_index integer;message jsonb;
BEGIN
 IF NEW.aggregate_type<>'attendance-correction' OR NEW.event_type NOT IN('attendance-workflow.participant.decided','attendance-workflow.stage.decided','attendance-correction.cancelled') THEN RETURN NEW; END IF;
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.correction_id=NEW.aggregate_id AND r.tenant_id=NEW.tenant_id AND r.routing_version=4;
 IF NOT FOUND OR jsonb_array_length(w.cc)=0 THEN RETURN NEW; END IF;
 IF NEW.event_type='attendance-correction.cancelled' THEN
  SELECT c.* INTO correction FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.status='cancelled' AND c.cancelled_by_user_id=NEW.actor_id::text AND app.attendance_workflow_active_write(c.xmin);
  IF NOT FOUND THEN RETURN NEW; END IF;
  action:=correction.cancellation_kind;at_time:=correction.cancelled_at;level_index:=LEAST(w.current_stage,jsonb_array_length(w.stages)-1);event_key:='cancellation:'||correction.id::text||':'||at_time::text;
  SELECT coalesce(p.full_name,'System') INTO actor_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=NEW.actor_id AND u.tenant_id=w.tenant_id;
 ELSE
  IF coalesce(NEW.payload->>'participantDecisionId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
  SELECT p.* INTO participant FROM public.attendance_workflow_participant_decision p WHERE p.id=(NEW.payload->>'participantDecisionId')::uuid AND p.request_id=w.id AND p.tenant_id=w.tenant_id AND p.actual_user_id=NEW.actor_id AND app.attendance_workflow_active_write(p.xmin);
  IF NOT FOUND THEN RETURN NEW; END IF;
  action:=participant.decision;at_time:=participant.decided_at;level_index:=participant.stage_index;event_key:='participant:'||participant.id::text;actor_name:=participant.actual_actor_name;
 END IF;
 IF action NOT IN('approved','rejected','cancelled','withdrawn') OR at_time IS NULL OR actor_name IS NULL THEN RETURN NEW; END IF;
 SELECT p.full_name INTO applicant_name FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 message:=jsonb_build_object('reference',w.correction_id,'applicant',applicant_name,'level',level_index+1,'action',action,'actor',actor_name,'occurredAt',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 FOR recipient IN SELECT value FROM jsonb_array_elements(w.cc) LOOP
  INSERT INTO public.attendance_workflow_cc_delivery(tenant_id,request_id,source_event_id,source_sequence,event_key,template_version,address,recipient_kind,recipient_employment_id,recipient_user_id,message)
  VALUES(w.tenant_id,w.id,NEW.id,NEW.sequence,event_key,w.template_version,recipient->>'address',recipient->>'kind',CASE WHEN recipient->>'kind'='employee' THEN(recipient->>'employmentId')::uuid END,CASE WHEN recipient->>'kind'='employee' THEN(recipient->>'userId')::uuid END,message) ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_cc_enqueue() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_workflow_cc_committed_event AFTER INSERT ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_cc_enqueue();
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_cc_claim(p_token uuid,p_companies uuid[] DEFAULT NULL) RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.is_admin() OR p_token IS NULL THEN RAISE EXCEPTION 'Notification dispatcher required'; END IF;
 UPDATE public.attendance_workflow_cc_delivery d SET status='uncertain',last_error='uncertain',lease_token=NULL,lease_until=NULL,updated_at=now()
 WHERE d.tenant_id=app.current_tenant_id() AND d.status='pending' AND d.started_at IS NOT NULL AND d.lease_until<now()
 AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=d.request_id AND w.tenant_id=d.tenant_id
  AND app.is_admin_for(w.company_id) AND (p_companies IS NULL OR w.company_id=ANY(p_companies)));
 RETURN QUERY WITH due AS(SELECT d.id FROM public.attendance_workflow_cc_delivery d WHERE d.tenant_id=app.current_tenant_id() AND d.status='pending' AND d.started_at IS NULL AND d.attempts<5 AND d.next_attempt_at<=now() AND (d.lease_until IS NULL OR d.lease_until<now())
 AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=d.request_id AND w.tenant_id=d.tenant_id
  AND app.is_admin_for(w.company_id) AND (p_companies IS NULL OR w.company_id=ANY(p_companies))) ORDER BY d.created_at,d.id LIMIT 50 FOR UPDATE OF d SKIP LOCKED)
 UPDATE public.attendance_workflow_cc_delivery d SET lease_token=p_token,lease_until=now()+interval '60 seconds',updated_at=now() FROM due WHERE d.id=due.id RETURNING d.id;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_cc_claim(uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_cc_claim(uuid,uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION identity_email.attendance_cc_target(p_id uuid,p_token uuid,p_issuer text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.attendance_workflow_cc_delivery;identity_user uuid;identity_subject text;locale text:='en';
BEGIN
 SELECT d.* INTO job FROM public.attendance_workflow_cc_delivery d JOIN public.tenant t ON t.id=d.tenant_id AND t.status IN('active','trial') WHERE d.id=p_id AND d.lease_token=p_token AND d.status='pending' AND d.started_at IS NULL AND d.attempts<5 AND d.lease_until>now() AND EXISTS(SELECT 1 FROM public.notification_email_policy policy WHERE policy.tenant_id=d.tenant_id AND policy.category='attendance' AND policy.enabled AND d.source_sequence>policy.after_sequence);
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF job.recipient_kind='employee' THEN
  SELECT u.id,i.subject,pref.email_locale INTO identity_user,identity_subject,locale
  FROM public.employment e
  JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
  JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
  JOIN public.app_external_identity i ON i.app_user_id=u.id AND i.issuer=p_issuer AND i.revoked_at IS NULL
  JOIN public.notification_pref pref ON pref.tenant_id=e.tenant_id AND pref.recipient_employment_id=e.id
   AND pref.category='attendance' AND pref.channel='email' AND pref.enabled AND pref.email_consent_user_id=u.id
   AND pref.email_after_sequence IS NOT NULL AND job.source_sequence>pref.email_after_sequence
  JOIN public.attendance_workflow_request w ON w.id=job.request_id AND w.tenant_id=e.tenant_id
  WHERE e.id=job.recipient_employment_id AND e.tenant_id=job.tenant_id AND u.id=job.recipient_user_id
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND lower(p.primary_email)=job.address
   AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (LEAST(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR LEAST(e.terminated_on,e.resignation_date,e.last_working_date)>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND app.is_company_descendant(w.company_id,e.company_id)
   AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=w.tenant_id
    AND r.role::text IN('employee','manager','hr_admin','super_admin')
    AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(w.cc) frozen
    WHERE frozen->>'kind'='employee' AND frozen->>'address'=job.address
     AND frozen->>'employmentId'=e.id::text AND frozen->>'personId'=e.person_id::text AND frozen->>'userId'=u.id::text);
  IF NOT FOUND THEN RETURN NULL; END IF;
 ELSE
  -- A custom destination cannot bypass an existing employee's consent/revocation. The configured
  -- employee/superior source supplies internal provenance when both resolve to the same address.
  IF EXISTS(SELECT 1 FROM public.person p WHERE p.tenant_id=job.tenant_id AND lower(p.primary_email)=job.address) THEN RETURN NULL; END IF;
 END IF;
 RETURN jsonb_build_object('kind',job.recipient_kind,'userId',CASE WHEN job.recipient_kind='employee' THEN identity_user END,'subject',CASE WHEN job.recipient_kind='employee' THEN identity_subject END,'email',job.address,'locale',locale,'message',job.message);
END $$;
REVOKE ALL ON FUNCTION identity_email.attendance_cc_target(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION identity_email.start_attendance_cc(p_id uuid,p_token uuid,p_issuer text,p_target jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.attendance_workflow_cc_delivery WHERE id=p_id AND lease_token=p_token AND status='pending' FOR UPDATE;
 IF NOT FOUND OR p_target IS NULL OR p_target IS DISTINCT FROM identity_email.attendance_cc_target(p_id,p_token,p_issuer) THEN RETURN false; END IF;
 UPDATE public.attendance_workflow_cc_delivery SET attempts=attempts+1,started_at=clock_timestamp(),updated_at=now() WHERE id=p_id AND lease_token=p_token;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION identity_email.start_attendance_cc(uuid,uuid,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION identity_email.finish_attendance_cc(p_id uuid,p_token uuid,p_outcome text,p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.attendance_workflow_cc_delivery;
BEGIN
 IF p_outcome NOT IN('sent','retry','failed','skipped','uncertain') OR p_error IS NOT NULL AND p_error NOT IN('relayUnavailable','recipientUnavailable','recipientChanged','notEligible','smtpTemporary','smtpRejected','smtpAuthentication','smtpTls','uncertain') THEN RAISE EXCEPTION 'Invalid delivery outcome'; END IF;
 SELECT d.* INTO job FROM public.attendance_workflow_cc_delivery d WHERE d.id=p_id AND d.lease_token=p_token AND d.status='pending' FOR UPDATE;
 IF NOT FOUND OR (p_outcome='skipped' AND job.started_at IS NOT NULL) OR (p_outcome IN('sent','retry','uncertain') AND job.started_at IS NULL) THEN RETURN false; END IF;
 UPDATE public.attendance_workflow_cc_delivery SET status=CASE WHEN p_outcome='retry' AND job.attempts<5 THEN 'pending' WHEN p_outcome='retry' THEN 'failed' ELSE p_outcome END,last_error=p_error,sent_at=CASE WHEN p_outcome='sent' THEN now() END,next_attempt_at=now()+make_interval(secs=>LEAST(3600,(60*power(2,job.attempts))::integer)),started_at=CASE WHEN p_outcome='retry' AND job.attempts<5 THEN NULL ELSE started_at END,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=p_id AND lease_token=p_token;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION identity_email.finish_attendance_cc(uuid,uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.internal_auth_attendance_cc_target(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT identity_email.attendance_cc_target(d.id,p_token,p_origin||'/auth/'||d.tenant_id::text) FROM public.attendance_workflow_cc_delivery d WHERE d.id=p_id $$;
CREATE FUNCTION app.internal_auth_start_attendance_cc(p_id uuid,p_token uuid,p_origin text,p_target jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT identity_email.start_attendance_cc(d.id,p_token,p_origin||'/auth/'||d.tenant_id::text,p_target) FROM public.attendance_workflow_cc_delivery d WHERE d.id=p_id $$;
CREATE FUNCTION app.internal_auth_finish_attendance_cc(p_id uuid,p_token uuid,p_outcome text,p_error text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT identity_email.finish_attendance_cc(p_id,p_token,p_outcome,p_error) $$;
REVOKE ALL ON FUNCTION app.internal_auth_attendance_cc_target(uuid,uuid,text),app.internal_auth_start_attendance_cc(uuid,uuid,text,jsonb),app.internal_auth_finish_attendance_cc(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.internal_auth_attendance_cc_target(uuid,uuid,text),app.internal_auth_start_attendance_cc(uuid,uuid,text,jsonb),app.internal_auth_finish_attendance_cc(uuid,uuid,text,text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_version_successor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL AND NEW.retired_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_template t WHERE t.tenant_id=NEW.tenant_id AND t.lineage_id=NEW.lineage_id AND t.version>NEW.version) THEN RAISE EXCEPTION 'Superseding a version requires its retained successor; use checked retirement to delete configuration'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_version_successor() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER attendance_workflow_version_has_successor AFTER UPDATE ON public.attendance_workflow_template DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_version_successor();
CREATE POLICY attendance_workflow_v4_template_insert ON public.attendance_workflow_template AS RESTRICTIVE FOR INSERT WITH CHECK(routing_version<>4 OR app.principal_snapshot_current());
CREATE POLICY attendance_workflow_v4_template_update ON public.attendance_workflow_template AS RESTRICTIVE FOR UPDATE USING(routing_version<>4 OR app.principal_snapshot_current()) WITH CHECK(routing_version<>4 OR app.principal_snapshot_current());
CREATE POLICY attendance_workflow_v4_request_insert ON public.attendance_workflow_request AS RESTRICTIVE FOR INSERT WITH CHECK(routing_version<>4 OR app.principal_snapshot_current());
ALTER TABLE public.attendance_workflow_template ADD CONSTRAINT attendance_workflow_legacy_cc_empty CHECK(routing_version=4 OR cc='[]'::jsonb);
ALTER TABLE public.attendance_workflow_request ADD CONSTRAINT attendance_workflow_request_legacy_cc_empty CHECK(routing_version=4 OR cc='[]'::jsonb);

--> statement-breakpoint
-- Explain a genuinely empty catalogue without returning ineligible Personnel records or identities.
CREATE FUNCTION app.attendance_workflow_approver_availability(wanted_company uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id() AND app.is_admin_for(c.id)) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM app.attendance_workflow_v3_approver_options(ARRAY[wanted_company])) THEN RETURN 'available'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND app.is_company_descendant(wanted_company,e.company_id)) THEN RETURN 'noEmployees'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND app.is_company_descendant(wanted_company,e.company_id) AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND(e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN RETURN 'noActiveEmployees'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE e.tenant_id=app.current_tenant_id() AND app.is_company_descendant(wanted_company,e.company_id) AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND(e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN RETURN 'noLinkedLogin'; END IF;
 RETURN 'noEligible';
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_approver_availability(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_approver_availability(uuid) TO ai_hr_app;
