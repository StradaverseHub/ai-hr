-- Attendance v3: immutable participant evidence and request-bound final-effect authority (ADR-0121).
CREATE TABLE public.attendance_workflow_participant_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 request_id uuid NOT NULL REFERENCES public.attendance_workflow_request(id), employment_id uuid NOT NULL REFERENCES public.employment(id),
 stage_index integer NOT NULL CHECK(stage_index BETWEEN 0 AND 9), participant_slot text NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','rejected')), assigned jsonb NOT NULL,
 actual_user_id uuid NOT NULL REFERENCES public.app_user(id), actual_person_id uuid NOT NULL REFERENCES public.person(id),
 actual_employment_id uuid REFERENCES public.employment(id), actual_actor_name text NOT NULL,
 acting_mode text NOT NULL CHECK(acting_mode IN ('assigned','delegate','administrator')), remarks text,
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT attendance_workflow_participant_slot UNIQUE(request_id,stage_index,participant_slot),
 CHECK(participant_slot ~ '^[0-9]:([0-9]|1[0-9]|hr)$'), CHECK(remarks IS NULL OR length(remarks)<=1000)
);
--> statement-breakpoint
CREATE TABLE public.attendance_workflow_participant_reassignment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 request_id uuid NOT NULL REFERENCES public.attendance_workflow_request(id), stage_index integer NOT NULL CHECK(stage_index BETWEEN 0 AND 9),
 participant_slot text NOT NULL, previous_assigned jsonb NOT NULL, assigned jsonb NOT NULL, reason text NOT NULL,
 actual_user_id uuid NOT NULL REFERENCES public.app_user(id), actual_person_id uuid NOT NULL REFERENCES public.person(id),
 actual_actor_name text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(participant_slot ~ '^[0-9]:([0-9]|1[0-9])$'), CHECK(length(btrim(reason)) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE INDEX attendance_workflow_participant_reassignment_history ON public.attendance_workflow_participant_reassignment(request_id,stage_index,participant_slot,occurred_at,id);
--> statement-breakpoint
ALTER TABLE public.attendance_workflow_participant_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_workflow_participant_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_workflow_participant_reassignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_workflow_participant_reassignment FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON public.attendance_workflow_participant_decision,public.attendance_workflow_participant_reassignment TO ai_hr_app;
REVOKE UPDATE,DELETE,TRUNCATE ON public.attendance_workflow_participant_decision,public.attendance_workflow_participant_reassignment FROM ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v3_effective(wanted_request uuid,wanted_stage integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(coalesce((SELECT r.assigned FROM public.attendance_workflow_participant_reassignment r
  WHERE r.tenant_id=w.tenant_id AND r.request_id=w.id AND r.stage_index=wanted_stage AND r.participant_slot=a.actor->>'slot'
  ORDER BY r.occurred_at DESC,r.id DESC LIMIT 1),a.actor) ORDER BY a.ordinality),'[]')
 FROM public.attendance_workflow_request w
 CROSS JOIN LATERAL jsonb_array_elements(w.stages->wanted_stage->'approvers') WITH ORDINALITY a(actor,ordinality)
 WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id() AND w.routing_version=3;
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_effective(uuid,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- This lookup preserves the original request shape; an HR alternative is explicitly configured.
CREATE FUNCTION app.attendance_workflow_v3_actor(wanted_request uuid,wanted_stage integer,wanted_slot text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN wanted_slot=wanted_stage::text||':hr' AND w.stages->wanted_stage->>'hrAlternative'='true'
  AND w.stages->wanted_stage->'source'->>'kind'='direct_manager'
  THEN jsonb_build_object('slot',wanted_slot,'kind','hr_admin','employmentId',NULL,'name','HR administrators')
  ELSE (SELECT a FROM jsonb_array_elements(app.attendance_workflow_v3_effective(w.id,wanted_stage)) a WHERE a->>'slot'=wanted_slot) END
 FROM public.attendance_workflow_request w WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id()
  AND w.routing_version=3 AND wanted_stage BETWEEN 0 AND jsonb_array_length(w.stages)-1;
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_actor(uuid,integer,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Assignment is a request capability, never a generic Personnel/manager grant. This predicate is also
-- used for completion/effect proof after the last participant was recorded, so pending-ness is separate.
CREATE FUNCTION app.attendance_workflow_v3_assigned_allowed(wanted_request uuid,wanted_stage integer,wanted_slot text,acting text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; caller public.app_user; actor jsonb; subject_person uuid;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.id=wanted_request AND r.tenant_id=app.current_tenant_id() AND r.routing_version=3;
 IF NOT FOUND THEN RETURN false; END IF;
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
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_assigned_allowed(uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_v3_assigned_allowed(uuid,integer,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v3_outstanding(wanted_request uuid,wanted_stage integer,wanted_slot text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; first_slot text;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.id=wanted_request AND r.tenant_id=app.current_tenant_id() AND r.routing_version=3;
 IF NOT FOUND OR w.current_stage<>wanted_stage OR wanted_stage>=jsonb_array_length(w.stages)
  OR NOT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.status='pending')
  OR app.attendance_workflow_v3_actor(w.id,wanted_stage,wanted_slot) IS NULL
  OR EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage)
  OR EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage
   AND (d.participant_slot=wanted_slot OR d.decision='rejected' OR d.participant_slot=wanted_stage::text||':hr' OR w.stages->wanted_stage->>'mode'='any_one')) THEN RETURN false; END IF;
 IF wanted_slot=wanted_stage::text||':hr' THEN RETURN true; END IF;
 IF w.stages->wanted_stage->>'mode'='any_one' THEN RETURN true; END IF;
 SELECT a->>'slot' INTO first_slot FROM jsonb_array_elements(app.attendance_workflow_v3_effective(w.id,wanted_stage)) WITH ORDINALITY x(a,ordinality)
  WHERE NOT EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage AND d.participant_slot=a->>'slot')
  ORDER BY ordinality LIMIT 1;
 RETURN first_slot=wanted_slot;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_outstanding(uuid,integer,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v3_participant_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; actor public.app_user;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Participant decision history is immutable'; END IF;
 SELECT r.* INTO STRICT w FROM public.attendance_workflow_request r WHERE r.id=NEW.request_id AND r.tenant_id=app.current_tenant_id() AND r.routing_version=3;
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
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_participant_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_workflow_v3_participant_authority BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_workflow_participant_decision FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_v3_participant_guard();
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v3_problem(code text,level_index integer,participant_index integer DEFAULT NULL) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('ok',false,'problem',jsonb_build_object('code',code,'levelIndex',level_index)||(CASE WHEN participant_index IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('participantIndex',participant_index) END));
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_problem(text,integer,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_resolve_v3(subject_id uuid,configured jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.employment; employee public.employment; caller public.app_user; actor jsonb; stage jsonb; source jsonb;
 resolved jsonb:='[]'; actors jsonb; selected jsonb; h record; i integer; j integer; depth integer; total integer:=0;
 failure text; login_id uuid; login_count integer; actor_name text; employee_id uuid; hr_ok boolean; alternative boolean;
 seen_employments uuid[]; seen_people uuid[]; seen_users uuid[]; applicant_user uuid;
BEGIN
 SELECT e.* INTO subject FROM public.employment e WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id();
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF subject.id IS NULL OR caller.id IS NULL OR NOT app.can_see_employment(subject_id) THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',NULL); END IF;
 IF jsonb_typeof(configured) IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 IF jsonb_array_length(configured) NOT BETWEEN 1 AND 10 THEN RETURN app.attendance_workflow_v3_problem('level_count',NULL); END IF;
 seen_employments:=ARRAY[subject.id]; seen_people:=ARRAY[subject.person_id];
 SELECT coalesce(array_agg(u.id),'{}') INTO seen_users FROM public.app_user u WHERE u.tenant_id=subject.tenant_id AND u.person_id=subject.person_id;
 hr_ok:=app.attendance_workflow_has_hr(subject_id);
 FOR i IN 0..jsonb_array_length(configured)-1 LOOP
  stage:=configured->i; source:=stage->'source'; actors:='[]'; alternative:=false;
  IF jsonb_typeof(stage) IS DISTINCT FROM 'object' OR NOT stage ?& ARRAY['name','mode','source','hrAlternative']
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(stage) k WHERE k NOT IN ('name','mode','source','hrAlternative'))
   OR jsonb_typeof(stage->'name') IS DISTINCT FROM 'string' OR length(stage->>'name')>100 OR jsonb_typeof(stage->'hrAlternative') IS DISTINCT FROM 'boolean'
   THEN RETURN app.attendance_workflow_v3_problem('invalid_level',i); END IF;
  IF coalesce(stage->>'mode','') NOT IN ('sequential','any_one') THEN RETURN app.attendance_workflow_v3_problem('invalid_mode',i); END IF;
  IF jsonb_typeof(source) IS DISTINCT FROM 'object' THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
  IF source->>'kind'='direct_manager' THEN
   IF NOT source ?& ARRAY['kind','depth'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN ('kind','depth')) THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
   IF jsonb_typeof(source->'depth') IS DISTINCT FROM 'number' OR coalesce(source->>'depth','') !~ '^[1-5]$' THEN RETURN app.attendance_workflow_v3_problem('invalid_depth',i); END IF;
   depth:=(source->>'depth')::integer; total:=total+1;
   SELECT * INTO h FROM app.attendance_workflow_hierarchy(subject_id,depth) x WHERE x.level_number=depth;
   IF NOT FOUND OR h.problem IS NOT NULL OR h.employment_id IS NULL THEN
    IF stage->>'hrAlternative'='true' AND hr_ok THEN alternative:=true;
    ELSE RETURN app.attendance_workflow_v3_problem(coalesce(h.problem,'missing_superior'),i,0); END IF;
   ELSE
    actors:=jsonb_build_array(jsonb_build_object('kind','direct_manager','slot',i::text||':0','employmentId',h.employment_id,'personId',h.person_id,'userId',h.user_id,'hierarchyDepth',depth,'name',h.full_name));
   END IF;
   alternative:=(stage->>'hrAlternative'='true' AND hr_ok);
  ELSIF source->>'kind'='specific_employee' THEN
   IF NOT source ?& ARRAY['kind','employmentIds'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN ('kind','employmentIds')) OR stage->>'hrAlternative'<>'false'
    THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
   selected:=source->'employmentIds';
   IF jsonb_typeof(selected) IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('selection_required',i); END IF;
   IF jsonb_array_length(selected)=0 THEN RETURN app.attendance_workflow_v3_problem('selection_required',i); END IF;
   IF jsonb_array_length(selected)>20 THEN RETURN app.attendance_workflow_v3_problem('too_many_participants',i); END IF;
   total:=total+jsonb_array_length(selected);
   FOR j IN 0..jsonb_array_length(selected)-1 LOOP
    IF jsonb_typeof(selected->j) IS DISTINCT FROM 'string' OR coalesce(selected->>j,'') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN app.attendance_workflow_v3_problem('invalid_employee',i,j); END IF;
    employee_id:=(selected->>j)::uuid;
    SELECT e.* INTO employee FROM public.employment e WHERE e.id=employee_id AND e.tenant_id=subject.tenant_id;
    IF NOT FOUND OR employee.blacklisted_at IS NOT NULL OR employee.hired_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
     OR (employee.terminated_on IS NOT NULL AND employee.terminated_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
     OR NOT app.is_company_descendant(subject.company_id,employee.company_id) THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',i,j); END IF;
    SELECT count(*)::integer,min(u.id::text)::uuid INTO login_count,login_id FROM public.app_user u WHERE u.person_id=employee.person_id AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
     AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=subject.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin')
      AND (r.company_id IS NULL OR r.company_id=subject.company_id OR app.is_company_descendant(subject.company_id,r.company_id)));
    IF login_count<>1 THEN RETURN app.attendance_workflow_v3_problem('missing_or_ambiguous_login',i,j); END IF;
    SELECT p.full_name INTO actor_name FROM public.person p WHERE p.id=employee.person_id AND p.tenant_id=subject.tenant_id;
    IF NOT FOUND THEN RETURN app.attendance_workflow_v3_problem('missing_person',i,j); END IF;
    actors:=actors||jsonb_build_array(jsonb_build_object('kind','specific_employee','slot',i::text||':'||j::text,'employmentId',employee.id,'personId',employee.person_id,'userId',login_id,'name',actor_name));
   END LOOP;
  ELSE RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
  IF total>100 THEN RETURN app.attendance_workflow_v3_problem('too_many_participants',i); END IF;
  FOR actor IN SELECT value FROM jsonb_array_elements(actors) LOOP
   IF (actor->>'employmentId')::uuid=subject.id OR (actor->>'personId')::uuid=subject.person_id THEN RETURN app.attendance_workflow_v3_problem('self_approval',i,(split_part(actor->>'slot',':',2))::integer); END IF;
   IF (actor->>'employmentId')::uuid=ANY(seen_employments) THEN RETURN app.attendance_workflow_v3_problem('duplicate_employment',i,(split_part(actor->>'slot',':',2))::integer); END IF;
   IF (actor->>'personId')::uuid=ANY(seen_people) THEN RETURN app.attendance_workflow_v3_problem('duplicate_person',i,(split_part(actor->>'slot',':',2))::integer); END IF;
   IF (actor->>'userId')::uuid=ANY(seen_users) THEN RETURN app.attendance_workflow_v3_problem('duplicate_login',i,(split_part(actor->>'slot',':',2))::integer); END IF;
   seen_employments:=seen_employments||(actor->>'employmentId')::uuid; seen_people:=seen_people||(actor->>'personId')::uuid; seen_users:=seen_users||(actor->>'userId')::uuid;
  END LOOP;
  resolved:=resolved||jsonb_build_array(jsonb_build_object('name','Level '||(i+1)::text,'mode',stage->>'mode','source',source,'approvers',actors,'hrAlternative',alternative));
 END LOOP;
 RETURN jsonb_build_object('ok',true,'stages',resolved);
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_resolve_v3(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_resolve_v3(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v3_read(correction uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; i integer; a jsonb;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.correction_id=correction AND r.tenant_id=app.current_tenant_id() AND r.routing_version=3;
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
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_v3_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v3_decision_slot(correction uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; a jsonb; slot text; actor_person uuid;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.correction_id=correction AND r.tenant_id=app.current_tenant_id() AND r.routing_version=3;
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
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_decision_slot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_v3_decision_slot(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Fulfillment is computed from immutable participant evidence; stage-completion uniqueness stays intact.
CREATE FUNCTION app.attendance_workflow_v3_completed(wanted_request uuid,wanted_stage integer) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; count_approved integer; count_all integer; needed integer;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.id=wanted_request AND r.tenant_id=app.current_tenant_id() AND r.routing_version=3;
 IF NOT FOUND OR NOT app.attendance_workflow_v3_read(w.correction_id) OR wanted_stage NOT BETWEEN 0 AND jsonb_array_length(w.stages)-1 THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage AND d.decision='rejected') THEN RETURN 'rejected'; END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage AND d.participant_slot=wanted_stage::text||':hr' AND d.decision='approved') THEN RETURN 'approved'; END IF;
 SELECT count(*)::integer,count(*) FILTER(WHERE d.decision='approved')::integer INTO count_all,count_approved FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=wanted_stage;
 IF w.stages->wanted_stage->>'mode'='any_one' AND count_all=1 AND count_approved=1 THEN RETURN 'approved'; END IF;
 needed:=jsonb_array_length(app.attendance_workflow_v3_effective(w.id,wanted_stage));
 IF w.stages->wanted_stage->>'mode'='sequential' AND needed>0 AND count_all=needed AND count_approved=needed THEN RETURN 'approved'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_completed(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_v3_completed(uuid,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v3_completion_write(wanted_request uuid,wanted_stage integer,wanted_decision text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_request w JOIN public.attendance_workflow_participant_decision p ON p.request_id=w.id AND p.tenant_id=w.tenant_id
  WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id() AND w.routing_version=3 AND p.stage_index=wanted_stage
   AND p.actual_user_id=app.current_user_id() AND app.attendance_workflow_active_write(p.xmin)
   AND app.attendance_workflow_v3_completed(w.id,wanted_stage)=wanted_decision AND p.decision=wanted_decision
   AND app.attendance_workflow_v3_assigned_allowed(w.id,wanted_stage,p.participant_slot,p.acting_mode));
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_completion_write(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_v3_completion_write(uuid,integer,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v3_advance(wanted_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_request w JOIN public.attendance_workflow_decision d ON d.request_id=w.id AND d.tenant_id=w.tenant_id
  WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id() AND w.routing_version=3 AND d.actual_user_id=app.current_user_id()::text
   AND app.attendance_workflow_active_write(d.xmin) AND app.attendance_workflow_v3_completion_write(w.id,d.stage_index,d.decision)
   AND (w.current_stage=d.stage_index OR w.current_stage=d.stage_index+1 OR (d.decision='rejected' AND w.current_stage=jsonb_array_length(w.stages))));
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_advance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_v3_advance(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY attendance_workflow_v3_participant_read ON public.attendance_workflow_participant_decision FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.tenant_id=app.current_tenant_id() AND app.attendance_workflow_v3_read(w.correction_id)));
CREATE POLICY attendance_workflow_v3_participant_insert ON public.attendance_workflow_participant_decision FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND actual_user_id=app.current_user_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.tenant_id=app.current_tenant_id() AND app.attendance_workflow_v3_decision_slot(w.correction_id) IS NOT NULL));
CREATE POLICY attendance_workflow_v3_correction_read ON public.attendance_correction FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND app.attendance_workflow_v3_read(id));
CREATE POLICY attendance_workflow_v3_correction_decide ON public.attendance_correction FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND (app.attendance_workflow_v3_decision_slot(id) IS NOT NULL OR EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.correction_id=attendance_correction.id AND w.tenant_id=app.current_tenant_id() AND app.attendance_workflow_v3_advance(w.id))))
 WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.correction_id=attendance_correction.id AND w.tenant_id=app.current_tenant_id() AND app.attendance_workflow_v3_advance(w.id)));
CREATE POLICY attendance_workflow_v3_request_read ON public.attendance_workflow_request FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND routing_version=3 AND app.attendance_workflow_v3_read(correction_id));
CREATE POLICY attendance_workflow_v3_request_advance ON public.attendance_workflow_request FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND routing_version=3 AND (app.attendance_workflow_v3_decision_slot(correction_id) IS NOT NULL OR app.attendance_workflow_v3_advance(id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND routing_version=3 AND app.attendance_workflow_v3_advance(id));
CREATE POLICY attendance_workflow_v3_completion_read ON public.attendance_workflow_decision FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.tenant_id=app.current_tenant_id() AND app.attendance_workflow_v3_read(w.correction_id)));
CREATE POLICY attendance_workflow_v3_completion_insert ON public.attendance_workflow_decision FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND actual_user_id=app.current_user_id()::text AND app.attendance_workflow_v3_completion_write(request_id,stage_index,decision));
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v3_reassignment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; caller public.app_user; subject_person uuid; prior jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Participant reassignment history is immutable'; END IF;
 SELECT r.* INTO STRICT w FROM public.attendance_workflow_request r WHERE r.id=NEW.request_id AND r.tenant_id=app.current_tenant_id() AND r.routing_version=3;
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
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_reassignment_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_workflow_v3_reassignment_authority BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_workflow_participant_reassignment FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_v3_reassignment_guard();
CREATE POLICY attendance_workflow_v3_reassignment_read ON public.attendance_workflow_participant_reassignment FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.tenant_id=app.current_tenant_id() AND app.attendance_workflow_v3_read(w.correction_id)));
CREATE POLICY attendance_workflow_v3_reassignment_insert ON public.attendance_workflow_participant_reassignment FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND actual_user_id=app.current_user_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.tenant_id=app.current_tenant_id() AND w.routing_version=3 AND app.is_admin_for(w.company_id)));

--> statement-breakpoint
-- Preserve v1/v2 decision semantics verbatim; v3 completion is backed by participant evidence.
CREATE OR REPLACE FUNCTION app.attendance_workflow_decision_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; assigned_person uuid; actual_person uuid; subject_company uuid;
BEGIN
 SELECT * INTO STRICT w FROM public.attendance_workflow_request WHERE id=NEW.request_id AND tenant_id=NEW.tenant_id;
 IF w.routing_version=3 THEN
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
CREATE FUNCTION app.attendance_workflow_v3_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.routing_version=3 AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d
  WHERE d.request_id=OLD.id AND d.tenant_id=OLD.tenant_id AND d.stage_index=OLD.current_stage
   AND d.actual_user_id=app.current_user_id()::text AND app.attendance_workflow_active_write(d.xmin)
   AND app.attendance_workflow_v3_completion_write(OLD.id,d.stage_index,d.decision)
   AND ((d.decision='approved' AND NEW.current_stage=OLD.current_stage+1) OR (d.decision='rejected' AND NEW.current_stage=jsonb_array_length(OLD.stages))))
  THEN RAISE EXCEPTION 'A fulfilled same-active-write participant level completion is required'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_request_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_workflow_v3_request_authority BEFORE UPDATE ON public.attendance_workflow_request FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_v3_request_guard();

--> statement-breakpoint
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
  WHERE w.tenant_id=app.current_tenant_id() AND w.routing_version=3 AND w.employment_id=subject_id
   AND w.correction_id::text=current_setting('app.attendance_workflow_effect',true)
   AND (c.status='pending' OR (c.status='approved' AND app.attendance_workflow_active_write(c.xmin)))
   AND (wanted_date IS NULL OR wanted_date=c.attendance_date)
   AND w.current_stage=jsonb_array_length(w.stages) AND d.stage_index=jsonb_array_length(w.stages)-1
   AND d.decision='approved' AND d.resulting_status='approved' AND d.actual_user_id=app.current_user_id()::text
   AND app.attendance_workflow_active_write(d.xmin)
   AND app.attendance_workflow_v3_completion_write(w.id,d.stage_index,d.decision));
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_workflow_begin_effect(p_correction_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject_id uuid; old_hint text:=current_setting('app.attendance_workflow_effect',true);
BEGIN
 SELECT w.employment_id INTO subject_id FROM public.attendance_workflow_request w WHERE w.correction_id=p_correction_id AND w.tenant_id=app.current_tenant_id() AND w.routing_version=3;
 IF FOUND THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':'||subject_id::text,0));
  PERFORM 1 FROM public.attendance_correction c WHERE c.id=p_correction_id AND c.tenant_id=app.current_tenant_id() FOR UPDATE;
  PERFORM 1 FROM public.attendance_workflow_request w WHERE w.correction_id=p_correction_id AND w.tenant_id=app.current_tenant_id() AND w.routing_version=3 AND app.attendance_workflow_v3_advance(w.id) FOR UPDATE;
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
CREATE FUNCTION app.attendance_workflow_v3_correction_guard() RETURNS trigger
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
 SELECT f.* INTO w FROM public.attendance_workflow_request f WHERE f.correction_id=OLD.id AND f.tenant_id=OLD.tenant_id AND f.routing_version=3;
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
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_correction_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_workflow_v3_correction_authority BEFORE UPDATE ON public.attendance_correction FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_v3_correction_guard();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_workflow_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME IN ('attendance_workflow_template','attendance_workflow_setting','attendance_workflow_request') THEN
  IF NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=NEW.company_id AND c.tenant_id=NEW.tenant_id)
   THEN RAISE EXCEPTION 'Invalid workflow company'; END IF;
 END IF;
 IF TG_TABLE_NAME='attendance_workflow_request' THEN
  IF NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.attendance_correction c ON c.employment_id=e.id AND c.tenant_id=e.tenant_id
   JOIN public.attendance_workflow_template t ON t.id=NEW.template_id AND t.tenant_id=e.tenant_id
   WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND e.company_id=NEW.company_id AND c.id=NEW.correction_id
    AND t.company_id=NEW.company_id AND t.application_type=NEW.application_type AND t.version=NEW.template_version AND t.routing_version=NEW.routing_version)
   THEN RAISE EXCEPTION 'Invalid workflow application links'; END IF;
  IF NEW.routing_version=2 AND NEW.stages IS DISTINCT FROM app.attendance_workflow_resolve_v2(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))
   THEN RAISE EXCEPTION 'The submitted hierarchy must match the configured version and live root-authorized resolution'; END IF;
  IF NEW.routing_version=3 AND NEW.stages IS DISTINCT FROM (app.attendance_workflow_resolve_v3(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))->'stages')
   THEN RAISE EXCEPTION 'The v3 route must match the canonical root-authorized resolution'; END IF;
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
CREATE OR REPLACE FUNCTION app.attendance_application_subject(correction uuid)
RETURNS TABLE(person_id uuid,employee text,employee_code text,company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.person_id,p.full_name,e.employee_code,e.company_id
 FROM public.attendance_correction c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE c.id=correction AND c.tenant_id=app.current_tenant_id()
  AND (app.can_see_employment(e.id) OR app.attendance_workflow_delegate_request(c.id) OR app.attendance_workflow_v2_read(c.id) OR app.attendance_workflow_v3_read(c.id));
$$;

--> statement-breakpoint
ALTER TABLE public.attendance_workflow_template DROP CONSTRAINT attendance_workflow_template_routing_version_check;
ALTER TABLE public.attendance_workflow_template ADD CONSTRAINT attendance_workflow_template_routing_version_check CHECK(routing_version IN (1,2,3));
ALTER TABLE public.attendance_workflow_request DROP CONSTRAINT attendance_workflow_request_routing_version_check;
ALTER TABLE public.attendance_workflow_request ADD CONSTRAINT attendance_workflow_request_routing_version_check CHECK(routing_version IN (1,2,3));
ALTER TABLE public.attendance_workflow_decision DROP CONSTRAINT attendance_workflow_decision_assigned_kind_check;
ALTER TABLE public.attendance_workflow_decision ADD CONSTRAINT attendance_workflow_decision_assigned_kind_check CHECK(assigned_kind IN ('direct_manager','hr_admin','specific_employee'));
--> statement-breakpoint
-- Configuration chooser: company HR sees only the identity projection of permitted active principals.
-- This is distinct from the subject criteria employee catalogue and grants no Personnel row access.
CREATE FUNCTION app.attendance_workflow_v3_approver_options(wanted_companies uuid[])
RETURNS TABLE(id uuid,name text,employee_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT DISTINCT e.id,p.full_name,e.employee_code FROM public.employment e
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND EXISTS(SELECT 1 FROM public.app_user caller WHERE caller.id=app.current_user_id() AND caller.tenant_id=e.tenant_id AND caller.archived_at IS NULL AND NOT app.login_blocked(caller.id))
  AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=ANY(wanted_companies) AND c.tenant_id=e.tenant_id AND app.is_admin_for(c.id)
   AND app.is_company_descendant(c.id,e.company_id)
   AND 1=(SELECT count(*) FROM public.app_user u WHERE u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=e.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin')
     AND (r.company_id IS NULL OR r.company_id=c.id OR app.is_company_descendant(c.id,r.company_id)))))
 ORDER BY p.full_name,e.employee_code,e.id;
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v3_approver_options(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_v3_approver_options(uuid[]) TO ai_hr_app;

--> statement-breakpoint
-- Legacy identity/delegation seams cannot authorize new participant routes.
CREATE OR REPLACE FUNCTION app.attendance_workflow_delegate_request(correction uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.attendance_workflow_request w
  JOIN public.attendance_correction c ON c.id=w.correction_id AND c.employment_id=w.employment_id AND c.tenant_id=w.tenant_id
  CROSS JOIN LATERAL jsonb_array_elements(w.stages) stage
  CROSS JOIN LATERAL jsonb_array_elements(stage->'approvers') approver
  WHERE c.id=correction AND w.tenant_id=app.current_tenant_id() AND w.routing_version IN (1,2)
   AND EXISTS(SELECT 1 FROM public.app_user caller WHERE caller.id=app.current_user_id() AND caller.tenant_id=w.tenant_id AND caller.archived_at IS NULL AND NOT app.login_blocked(caller.id))
   AND approver->>'kind'='direct_manager'
   AND app.can_decide_via_delegation(w.employment_id,'attendance','attendance.correction')
   AND app.can_decide_via_delegation_from((approver->>'employmentId')::uuid,w.employment_id,'attendance','attendance.correction')
 );
$$;

--> statement-breakpoint
-- Legacy identity/delegation seams cannot authorize new participant routes.
CREATE OR REPLACE FUNCTION app.attendance_workflow_effect_identity(correction uuid, stage integer)
RETURNS TABLE(user_id uuid,roles text,grants jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT u.id,string_agg(DISTINCT r.role::text,',' ORDER BY r.role::text),
        jsonb_agg(jsonb_build_object('role',r.role::text,'companyId',r.company_id) ORDER BY r.role::text,r.company_id)
 FROM public.attendance_workflow_request w
 JOIN public.attendance_correction c ON c.id=w.correction_id AND c.employment_id=w.employment_id AND c.tenant_id=w.tenant_id
 JOIN public.attendance_workflow_decision d ON d.request_id=w.id AND d.employment_id=w.employment_id AND d.tenant_id=w.tenant_id
 JOIN public.employment subject ON subject.id=w.employment_id AND subject.tenant_id=w.tenant_id
 JOIN public.employment m ON m.id=d.assigned_employment_id AND m.tenant_id=w.tenant_id
 JOIN public.reporting_line l ON l.manager_employment_id=m.id AND l.subordinate_employment_id=w.employment_id AND l.tenant_id=w.tenant_id
 JOIN public.app_user u ON u.person_id=m.person_id AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=w.tenant_id
 WHERE w.correction_id=correction AND w.tenant_id=app.current_tenant_id() AND w.routing_version IN (1,2)
  AND w.current_stage=jsonb_array_length(w.stages) AND stage=jsonb_array_length(w.stages)-1
  AND d.stage_index=stage AND d.actual_user_id=app.current_user_id()::text
  AND d.assigned_kind='direct_manager' AND d.acting_mode='delegate' AND d.decision='approved' AND d.resulting_status='approved'
  AND (w.stages->stage->'approvers') @> jsonb_build_array(jsonb_build_object('kind','direct_manager','employmentId',m.id::text))
  AND EXISTS(SELECT 1 FROM public.app_user caller WHERE caller.id=app.current_user_id() AND caller.tenant_id=w.tenant_id AND caller.archived_at IS NULL AND NOT app.login_blocked(caller.id))
  AND c.status='pending' AND m.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND l.line_type='administrative' AND l.superseded_at IS NULL
  AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND app.can_decide_via_delegation_from(m.id,w.employment_id,'attendance','attendance.correction')
  AND r.role::text IN ('employee','manager') AND (r.company_id IS NULL OR r.company_id=subject.company_id OR app.is_company_descendant(subject.company_id,r.company_id))
 GROUP BY u.id,u.created_at
 ORDER BY u.created_at,u.id LIMIT 1;
$$;
