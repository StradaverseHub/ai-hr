-- Versioned Attendance hierarchy and frozen request-bound authority (ADR-0121).
ALTER TABLE public.attendance_workflow_template ADD COLUMN routing_version integer NOT NULL DEFAULT 1 CHECK(routing_version IN (1,2));
--> statement-breakpoint
ALTER TABLE public.attendance_workflow_request ADD COLUMN routing_version integer NOT NULL DEFAULT 1 CHECK(routing_version IN (1,2));
--> statement-breakpoint
-- The fixed pipeline keeps the writing transaction/savepoint active through its proof checks.
-- RELEASE SAVEPOINT removes its subxid lock: a released child's write is intentionally refused.
-- This is an active-write proof, not a general same-top-transaction predicate (PG16 xact.c).
CREATE FUNCTION app.attendance_workflow_active_write(written_xid xid) RETURNS boolean
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype='transactionid'
  AND l.transactionid=written_xid AND l.pid=pg_catalog.pg_backend_pid() AND l.mode='ExclusiveLock' AND l.granted);
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_active_write(xid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Root-authorized, name/identity-only traversal. No Personnel policies are changed.
CREATE FUNCTION app.attendance_workflow_hierarchy(subject_id uuid, wanted_depth integer)
RETURNS TABLE(level_number integer, employment_id uuid, person_id uuid, user_id uuid, full_name text, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.employment; manager public.employment; cursor_id uuid; next_id uuid; manager_name text; login_id uuid;
        seen_employments uuid[]; seen_people uuid[]; seen_users uuid[] := '{}'; edge_count integer; login_count integer; failure text; n integer;
BEGIN
 IF wanted_depth NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Configure one to ten hierarchy levels'; END IF;
 SELECT e.* INTO subject FROM public.employment e WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.can_see_employment(subject_id)
  OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  THEN RAISE EXCEPTION 'Authorized attendance subject required'; END IF;
 cursor_id:=subject.id; seen_employments:=ARRAY[subject.id]; seen_people:=ARRAY[subject.person_id];
 -- Check the reachable path, including a cycle above the last configured level.
 IF EXISTS(WITH RECURSIVE chain(id,path,cycle) AS (
  SELECT subject.id,ARRAY[subject.id],false UNION ALL
  SELECT l.manager_employment_id,c.path||l.manager_employment_id,l.manager_employment_id=ANY(c.path)
   FROM chain c JOIN public.reporting_line l ON l.subordinate_employment_id=c.id AND l.tenant_id=subject.tenant_id
   WHERE NOT c.cycle AND l.line_type='administrative' AND l.superseded_at IS NULL
    AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 ) SELECT 1 FROM chain WHERE cycle) THEN failure:='cycle'; END IF;
 FOR n IN 1..wanted_depth LOOP
  IF failure IS NULL THEN
   SELECT count(*)::integer,min(l.manager_employment_id::text)::uuid INTO edge_count,next_id FROM public.reporting_line l
    WHERE l.subordinate_employment_id=cursor_id AND l.tenant_id=subject.tenant_id AND l.line_type='administrative'
     AND l.superseded_at IS NULL AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
     AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
   IF edge_count=0 THEN failure:='missing_superior'; ELSIF edge_count<>1 THEN failure:='ambiguous_superior';
   ELSIF next_id=ANY(seen_employments) THEN failure:='cycle'; END IF;
  END IF;
  IF failure IS NULL THEN
   SELECT e.* INTO manager FROM public.employment e WHERE e.id=next_id AND e.tenant_id=subject.tenant_id;
   IF NOT FOUND THEN failure:='missing_superior';
   ELSIF manager.person_id=ANY(seen_people) THEN failure:='duplicate_person';
   ELSIF manager.hired_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR manager.blacklisted_at IS NOT NULL
     OR (manager.terminated_on IS NOT NULL AND manager.terminated_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) THEN failure:='inactive_superior';
   ELSIF NOT app.is_company_descendant(subject.company_id,manager.company_id) THEN failure:='outside_company_scope'; END IF;
  END IF;
  IF failure IS NULL THEN
   SELECT count(*)::integer,min(u.id::text)::uuid INTO login_count,login_id FROM public.app_user u
    WHERE u.person_id=manager.person_id AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=u.tenant_id
     AND r.role::text IN ('employee','manager','hr_admin','super_admin')
     AND (r.company_id IS NULL OR r.company_id=subject.company_id OR app.is_company_descendant(subject.company_id,r.company_id)));
   IF login_count<>1 THEN failure:='missing_or_ambiguous_login'; ELSIF login_id=ANY(seen_users) THEN failure:='duplicate_login'; END IF;
  END IF;
  IF failure IS NULL THEN
   SELECT p.full_name INTO manager_name FROM public.person p WHERE p.id=manager.person_id AND p.tenant_id=subject.tenant_id;
   IF NOT FOUND THEN failure:='missing_person'; END IF;
  END IF;
  IF failure IS NOT NULL THEN RETURN QUERY SELECT n,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,failure;
  ELSE
   RETURN QUERY SELECT n,manager.id,manager.person_id,login_id,manager_name,NULL::text;
   seen_employments:=seen_employments||manager.id; seen_people:=seen_people||manager.person_id; seen_users:=seen_users||login_id; cursor_id:=manager.id;
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_workflow_hierarchy(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_hierarchy(uuid,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_resolve_v2(subject_id uuid, configured jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE resolved jsonb:='[]'; stage jsonb; actors jsonb; actor jsonb; manager record; hierarchy jsonb; i integer; hr_ok boolean;
BEGIN
 IF jsonb_typeof(configured)<>'array' OR jsonb_array_length(configured) NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Configure one to ten approval levels'; END IF;
 -- The traversal performs its own root ACL and validates employment/person/login independently.
 SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.level_number),'[]') INTO hierarchy FROM app.attendance_workflow_hierarchy(subject_id,jsonb_array_length(configured)) h;
 hr_ok:=app.attendance_workflow_has_hr(subject_id);
 FOR i IN 0..jsonb_array_length(configured)-1 LOOP
  stage:=configured->i; actors:='[]';
  FOR actor IN SELECT data FROM (SELECT 0 AS ordinal,stage->'level' AS data UNION ALL SELECT ordinality::integer,value FROM jsonb_array_elements(coalesce(stage->'level'->'alternates','[]')) WITH ORDINALITY) a ORDER BY ordinal LOOP
   IF actor->>'kind' NOT IN ('direct_manager','hr_admin') OR actor->>'kind' IS NULL OR actor->>'employmentId' IS NOT NULL THEN RAISE EXCEPTION 'Unsupported Attendance approver'; END IF;
   IF actor->>'kind'='hr_admin' THEN
    IF hr_ok THEN actors:=actors||jsonb_build_array(jsonb_build_object('kind','hr_admin','employmentId',NULL,'name','HR administrators')); END IF;
   ELSE
    SELECT * INTO manager FROM jsonb_to_record(hierarchy->i) AS h(level_number integer,employment_id uuid,person_id uuid,user_id uuid,full_name text,problem text);
    IF manager.problem IS NULL AND manager.employment_id IS NOT NULL THEN actors:=actors||jsonb_build_array(jsonb_build_object('kind','direct_manager','employmentId',manager.employment_id,'personId',manager.person_id,'userId',manager.user_id,'hierarchyDepth',i+1,'name',manager.full_name)); END IF;
   END IF;
  END LOOP;
  IF jsonb_array_length(actors)=0 THEN RAISE EXCEPTION 'Approval Level % cannot resolve a valid superior (%). Contact HR to correct the reporting relationship or explicitly configure an HR alternative.',i+1,coalesce(hierarchy->i->>'problem','missing_approver'); END IF;
  resolved:=resolved||jsonb_build_array(jsonb_build_object('name','Level '||(i+1)::text,'approvers',actors));
 END LOOP;
 RETURN resolved;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_workflow_resolve_v2(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_resolve_v2(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE public.attendance_workflow_reassignment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 request_id uuid NOT NULL REFERENCES public.attendance_workflow_request(id), stage_index integer NOT NULL CHECK(stage_index BETWEEN 0 AND 9),
 previous_approvers jsonb NOT NULL, approvers jsonb NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500), actual_user_id uuid NOT NULL REFERENCES public.app_user(id),
 actual_person_id uuid REFERENCES public.person(id), actual_actor_name text NOT NULL DEFAULT '', occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE INDEX attendance_workflow_reassignment_stage ON public.attendance_workflow_reassignment(request_id,stage_index,occurred_at,id);
GRANT SELECT,INSERT ON public.attendance_workflow_reassignment TO ai_hr_app;
ALTER TABLE public.attendance_workflow_reassignment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Internal projection, never a client-callable directory/history reader.
CREATE FUNCTION app.attendance_workflow_effective_approvers(wanted_request uuid,wanted_stage integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT r.approvers FROM public.attendance_workflow_reassignment r WHERE r.request_id=w.id AND r.tenant_id=w.tenant_id AND r.stage_index=wanted_stage ORDER BY r.occurred_at DESC,r.id DESC LIMIT 1), w.stages->wanted_stage->'approvers')
 FROM public.attendance_workflow_request w WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id();
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_effective_approvers(uuid,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v2_assigned_allowed(p_correction_id uuid,wanted_stage integer,assigned_kind text,assigned_emp uuid,acting_mode text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; caller public.app_user; subject_person uuid; assigned jsonb; hr_authorized boolean;
BEGIN
 SELECT f.* INTO w FROM public.attendance_workflow_request f WHERE f.correction_id=p_correction_id AND f.tenant_id=app.current_tenant_id() AND f.routing_version=2;
 IF NOT FOUND OR wanted_stage<0 OR wanted_stage>=jsonb_array_length(w.stages) THEN RETURN false; END IF;
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT e.person_id INTO subject_person FROM public.employment e WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 IF caller.person_id IS NOT NULL AND caller.person_id=subject_person THEN RETURN false; END IF;
 SELECT a INTO assigned FROM jsonb_array_elements(app.attendance_workflow_effective_approvers(w.id,wanted_stage)) a
  WHERE a->>'kind'=assigned_kind AND (a->>'employmentId')::uuid IS NOT DISTINCT FROM assigned_emp LIMIT 1;
 IF assigned IS NULL THEN RETURN false; END IF;
 SELECT app.is_admin_for(w.company_id) AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=caller.id AND r.tenant_id=w.tenant_id AND r.role::text IN ('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id))) INTO hr_authorized;
 IF acting_mode='administrator' THEN RETURN hr_authorized; END IF;
 IF assigned_kind='hr_admin' THEN RETURN acting_mode='assigned' AND hr_authorized; END IF;
 IF assigned_kind<>'direct_manager' OR assigned_emp IS NULL OR acting_mode NOT IN ('assigned','delegate') THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employment m JOIN public.app_user u ON u.person_id=m.person_id AND u.tenant_id=m.tenant_id
  WHERE m.id=assigned_emp AND m.tenant_id=w.tenant_id AND m.person_id=(assigned->>'personId')::uuid AND u.id=(assigned->>'userId')::uuid
   AND m.person_id<>subject_person AND app.is_company_descendant(w.company_id,m.company_id) AND m.blacklisted_at IS NULL AND m.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=w.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin')
     AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))) THEN RETURN false; END IF;
 IF acting_mode='assigned' THEN RETURN caller.id=(assigned->>'userId')::uuid AND caller.person_id=(assigned->>'personId')::uuid; END IF;
 RETURN app.can_decide_via_delegation_from(assigned_emp,w.employment_id,'attendance','attendance.correction');
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v2_assigned_allowed(uuid,integer,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_v2_assigned_allowed(uuid,integer,text,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v2_read(p_correction_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; a jsonb; i integer;
BEGIN
 SELECT f.* INTO w FROM public.attendance_workflow_request f WHERE f.correction_id=p_correction_id AND f.tenant_id=app.current_tenant_id() AND f.routing_version=2;
 IF NOT FOUND THEN RETURN false; END IF;
 FOR i IN 0..jsonb_array_length(w.stages)-1 LOOP
  FOR a IN SELECT value FROM jsonb_array_elements(app.attendance_workflow_effective_approvers(w.id,i)) LOOP
   IF app.attendance_workflow_v2_assigned_allowed(p_correction_id,i,a->>'kind',(a->>'employmentId')::uuid,'assigned')
    OR app.attendance_workflow_v2_assigned_allowed(p_correction_id,i,a->>'kind',(a->>'employmentId')::uuid,'delegate')
    OR app.attendance_workflow_v2_assigned_allowed(p_correction_id,i,a->>'kind',(a->>'employmentId')::uuid,'administrator') THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v2_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_v2_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v2_decide(p_correction_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; a jsonb;
BEGIN
 SELECT f.* INTO w FROM public.attendance_workflow_request f WHERE f.correction_id=p_correction_id AND f.tenant_id=app.current_tenant_id() AND f.routing_version=2;
 IF NOT FOUND THEN RETURN false; END IF;
 IF w.current_stage>=jsonb_array_length(w.stages) THEN
  RETURN EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.actual_user_id=app.current_user_id()::text
   AND app.attendance_workflow_active_write(d.xmin) AND d.resulting_status IN ('approved','rejected')
   AND app.attendance_workflow_v2_assigned_allowed(p_correction_id,d.stage_index,d.assigned_kind,d.assigned_employment_id,d.acting_mode));
 END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_decision d JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=w.tenant_id
  WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id::text OR (u.person_id IS NOT NULL AND d.actual_person_id=u.person_id))) THEN RETURN false; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(app.attendance_workflow_effective_approvers(w.id,w.current_stage)) LOOP
  IF app.attendance_workflow_v2_assigned_allowed(p_correction_id,w.current_stage,a->>'kind',(a->>'employmentId')::uuid,'assigned')
   OR app.attendance_workflow_v2_assigned_allowed(p_correction_id,w.current_stage,a->>'kind',(a->>'employmentId')::uuid,'delegate')
   OR app.attendance_workflow_v2_assigned_allowed(p_correction_id,w.current_stage,a->>'kind',(a->>'employmentId')::uuid,'administrator') THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v2_decide(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_v2_decide(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The GUC is only an untrusted hint. A previous/committed decision cannot prove an effect transaction.
CREATE FUNCTION app.attendance_workflow_effect_scope(subject_id uuid,wanted_date date DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_request w
  JOIN public.attendance_correction c ON c.id=w.correction_id AND c.employment_id=w.employment_id AND c.tenant_id=w.tenant_id
  JOIN public.attendance_workflow_decision d ON d.request_id=w.id AND d.tenant_id=w.tenant_id
  WHERE w.tenant_id=app.current_tenant_id() AND w.routing_version=2 AND w.employment_id=subject_id
   AND w.correction_id::text=current_setting('app.attendance_workflow_effect',true)
   AND c.status='pending' AND (wanted_date IS NULL OR wanted_date=c.attendance_date)
   AND w.current_stage=jsonb_array_length(w.stages) AND d.stage_index=jsonb_array_length(w.stages)-1
   AND d.decision='approved' AND d.resulting_status='approved' AND d.actual_user_id=app.current_user_id()::text
   AND app.attendance_workflow_active_write(d.xmin)
   AND app.attendance_workflow_v2_assigned_allowed(c.id,d.stage_index,d.assigned_kind,d.assigned_employment_id,d.acting_mode));
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_effect_scope(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_effect_scope(uuid,date) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_begin_effect(p_correction_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject_id uuid; old_hint text:=current_setting('app.attendance_workflow_effect',true);
BEGIN
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
REVOKE ALL ON FUNCTION app.attendance_workflow_begin_effect(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_begin_effect(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_v2_advance(wanted_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_request w JOIN public.attendance_workflow_decision d ON d.request_id=w.id AND d.tenant_id=w.tenant_id
  JOIN public.attendance_correction c ON c.id=w.correction_id AND c.tenant_id=w.tenant_id
  WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id() AND w.routing_version=2 AND c.status='pending'
   AND d.actual_user_id=app.current_user_id()::text AND app.attendance_workflow_active_write(d.xmin)
   AND (w.current_stage=d.stage_index OR w.current_stage=d.stage_index+1 OR (d.decision='rejected' AND w.current_stage=jsonb_array_length(w.stages)))
   AND app.attendance_workflow_v2_assigned_allowed(c.id,d.stage_index,d.assigned_kind,d.assigned_employment_id,d.acting_mode));
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_v2_advance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_v2_advance(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY attendance_workflow_v2_correction_read ON public.attendance_correction FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND app.attendance_workflow_v2_read(id));
CREATE POLICY attendance_workflow_v2_correction_decide ON public.attendance_correction FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND app.attendance_workflow_v2_decide(id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.attendance_workflow_v2_decide(id));
CREATE POLICY attendance_workflow_v2_request_read ON public.attendance_workflow_request FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND routing_version=2 AND app.attendance_workflow_v2_read(correction_id));
CREATE POLICY attendance_workflow_v2_request_advance ON public.attendance_workflow_request FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND routing_version=2 AND (app.attendance_workflow_v2_decide(correction_id) OR app.attendance_workflow_v2_advance(id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND routing_version=2 AND app.attendance_workflow_v2_advance(id));
CREATE POLICY attendance_workflow_v2_decision_read ON public.attendance_workflow_decision FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND app.attendance_workflow_v2_read(w.correction_id)));
CREATE POLICY attendance_workflow_v2_decision_insert ON public.attendance_workflow_decision FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND actual_user_id=app.current_user_id()::text AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.routing_version=2 AND app.attendance_workflow_v2_decide(w.correction_id)));
CREATE POLICY attendance_workflow_reassignment_read ON public.attendance_workflow_reassignment FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND (app.can_see_employment(w.employment_id) OR app.attendance_workflow_v2_read(w.correction_id))));
CREATE POLICY attendance_workflow_reassignment_insert ON public.attendance_workflow_reassignment FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND actual_user_id=app.current_user_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND app.is_admin_for(w.company_id)));
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_reassignment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; actor_person uuid; subject_person uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Approval reassignment history is immutable'; END IF;
 SELECT f.* INTO STRICT w FROM public.attendance_workflow_request f WHERE f.id=NEW.request_id AND f.tenant_id=NEW.tenant_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(w.tenant_id::text||':'||w.employment_id::text,0));
 PERFORM 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id FOR UPDATE;
 SELECT f.* INTO STRICT w FROM public.attendance_workflow_request f WHERE f.id=NEW.request_id AND f.tenant_id=NEW.tenant_id FOR UPDATE;
 SELECT u.person_id INTO actor_person FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT FOUND THEN RAISE EXCEPTION 'A live authenticated administrator is required'; END IF;
 SELECT e.person_id INTO subject_person FROM public.employment e WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 IF w.routing_version<>2 OR NOT app.is_admin_for(w.company_id)
  OR NOT EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=app.current_user_id() AND r.tenant_id=w.tenant_id AND r.role::text IN ('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))
  OR NEW.actual_user_id<>app.current_user_id() OR NEW.actual_person_id IS DISTINCT FROM actor_person
  OR (actor_person IS NOT NULL AND actor_person=subject_person) OR w.current_stage<>NEW.stage_index OR w.current_stage>=jsonb_array_length(w.stages)
  OR NOT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.status='pending')
  OR NOT app.attendance_workflow_has_hr(w.employment_id)
  OR NEW.previous_approvers IS DISTINCT FROM app.attendance_workflow_effective_approvers(w.id,w.current_stage)
  OR NEW.approvers IS DISTINCT FROM '[{"kind":"hr_admin","employmentId":null,"name":"HR administrators"}]'::jsonb
  OR length(btrim(NEW.reason)) NOT BETWEEN 1 AND 500
  THEN RAISE EXCEPTION 'A reasoned scoped HR reassignment of the current pending level is required'; END IF;
 SELECT coalesce(p.full_name,u.id::text) INTO NEW.actual_actor_name FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id;
 NEW.occurred_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER attendance_workflow_reassignment_authority BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_workflow_reassignment FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_reassignment_guard();
--> statement-breakpoint
-- Exact-day mutation containment applies only while the v2 effect window is installed.
-- An invalid hint can restrict its caller, but cannot add authority. SELECT policies are untouched.
DO $policies$
DECLARE entry record; date_column text;
BEGIN
 FOR entry IN SELECT * FROM (VALUES ('attendance','attendance_date'),('attendance_punch','attendance_date'),('toil_accrual','worked_date'),('leave_ledger','effective_on')) x(table_name,date_column) LOOP
  EXECUTE format('CREATE POLICY attendance_workflow_effect_insert ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(current_setting(''app.attendance_workflow_effect'',true),'''')='''' OR (tenant_id=app.current_tenant_id() AND app.attendance_workflow_effect_scope(employment_id,%I)))',entry.table_name,entry.date_column);
  EXECUTE format('CREATE POLICY attendance_workflow_effect_update ON public.%I AS RESTRICTIVE FOR UPDATE USING (coalesce(current_setting(''app.attendance_workflow_effect'',true),'''')='''' OR (tenant_id=app.current_tenant_id() AND app.attendance_workflow_effect_scope(employment_id,%I))) WITH CHECK (coalesce(current_setting(''app.attendance_workflow_effect'',true),'''')='''' OR (tenant_id=app.current_tenant_id() AND app.attendance_workflow_effect_scope(employment_id,%I)))',entry.table_name,entry.date_column,entry.date_column);
  EXECUTE format('CREATE POLICY attendance_workflow_effect_delete ON public.%I AS RESTRICTIVE FOR DELETE USING (coalesce(current_setting(''app.attendance_workflow_effect'',true),'''')='''' OR (tenant_id=app.current_tenant_id() AND app.attendance_workflow_effect_scope(employment_id,%I)))',entry.table_name,entry.date_column);
 END LOOP;
END $policies$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_correct_attendance(subject_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.attendance_workflow_effect_scope(subject_id,NULL) OR EXISTS (
  SELECT 1 FROM employment subject
  WHERE subject.id=subject_id AND subject.tenant_id=app.current_tenant_id()
    AND (
     app.is_admin_for(subject.company_id)
     OR EXISTS (
      SELECT 1 FROM app_user caller
      WHERE caller.id=app.current_user_id() AND caller.tenant_id=subject.tenant_id
        AND caller.person_id IS NOT NULL AND caller.person_id<>subject.person_id
        AND (
         EXISTS (
          SELECT 1 FROM reporting_line line JOIN employment manager ON manager.id=line.manager_employment_id
          WHERE line.subordinate_employment_id=subject.id AND manager.person_id=caller.person_id
            AND line.line_type='administrative' AND line.superseded_at IS NULL
            AND line.valid_from<=current_date AND (line.valid_to IS NULL OR line.valid_to>current_date)
         ) OR app.can_decide_via_delegation(subject.id,'attendance','attendance.correction')
        )
     )
    )
 );
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_workflow_decision_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; assigned_person uuid; actual_person uuid; subject_company uuid;
BEGIN
 SELECT * INTO STRICT w FROM public.attendance_workflow_request WHERE id=NEW.request_id AND tenant_id=NEW.tenant_id;
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
  AND (app.can_see_employment(e.id) OR app.attendance_workflow_delegate_request(c.id) OR app.attendance_workflow_v2_read(c.id));
$$;
--> statement-breakpoint
-- A v2 application cannot be finalized by updating its status around the frozen decision pipeline.
CREATE FUNCTION app.attendance_workflow_v2_correction_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; allowed text[]:=ARRAY['status','reject_reason','decided_by_employment_id','decided_at','approved_ot_minutes','ot_approval_method','applied_at','cancelled_at','cancelled_by_user_id','cancellation_kind','cancellation_reason','admin_amendment'];
BEGIN
 IF coalesce(current_setting('app.attendance_workflow_effect',true),'')<>'' AND current_setting('app.attendance_workflow_effect',true)<>OLD.id::text THEN
  -- Existing approved OT plans may land as a derived consequence of this exact day's clock correction.
  -- No new approval or formula is introduced. Claim and value stamp are separate canonical writes.
  IF OLD.status='approved' AND OLD.requested_ot_minutes IS NOT NULL AND OLD.proposed_check_in IS NULL AND OLD.proposed_check_out IS NULL AND OLD.clock_changes IS NULL
   AND app.attendance_workflow_effect_scope(OLD.employment_id,OLD.attendance_date)
   AND (to_jsonb(OLD)-ARRAY['applied_at','approved_ot_minutes']) IS NOT DISTINCT FROM (to_jsonb(NEW)-ARRAY['applied_at','approved_ot_minutes']) THEN
   IF OLD.applied_at IS NULL AND NEW.applied_at=transaction_timestamp() AND NEW.approved_ot_minutes IS NOT DISTINCT FROM OLD.approved_ot_minutes THEN RETURN NEW; END IF;
   IF OLD.applied_at IS NOT NULL AND NEW.applied_at=OLD.applied_at
    AND EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=OLD.id AND c.tenant_id=OLD.tenant_id AND app.attendance_workflow_active_write(c.xmin))
    AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.tenant_id=OLD.tenant_id AND a.employment_id=OLD.employment_id AND a.attendance_date=OLD.attendance_date
      AND app.attendance_workflow_active_write(a.xmin) AND a.calc_trace->'overtime'->'approvedMinutes'=to_jsonb(NEW.approved_ot_minutes)) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'A request effect cannot mutate another attendance application except the canonical same-day approved plan landing';
 END IF;
 SELECT f.* INTO w FROM public.attendance_workflow_request f WHERE f.correction_id=OLD.id AND f.tenant_id=OLD.tenant_id AND f.routing_version=2;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status='cancelled' AND NOT app.is_admin_for(w.company_id)
  AND NOT EXISTS(SELECT 1 FROM public.app_user u JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND e.id=w.employment_id)
  THEN RAISE EXCEPTION 'Only the applicant or scoped HR may cancel this application'; END IF;
 IF OLD.status='pending' AND (to_jsonb(OLD)-allowed) IS DISTINCT FROM (to_jsonb(NEW)-allowed)
  THEN RAISE EXCEPTION 'Submitted Attendance application inputs are frozen; withdraw and submit a new application'; END IF;
 IF OLD.status='pending' AND (NEW.approved_ot_minutes,NEW.ot_approval_method,NEW.applied_at) IS DISTINCT FROM (OLD.approved_ot_minutes,OLD.ot_approval_method,OLD.applied_at)
  AND NOT app.attendance_workflow_effect_scope(OLD.employment_id,OLD.attendance_date)
  THEN RAISE EXCEPTION 'Only the verified final request effect may stamp approved overtime'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved','rejected') THEN
  IF OLD.status<>'pending' OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id
   AND d.actual_user_id=app.current_user_id()::text AND d.resulting_status=NEW.status::text AND app.attendance_workflow_active_write(d.xmin)
   AND w.current_stage=jsonb_array_length(w.stages) AND (NEW.status='rejected' OR d.stage_index=jsonb_array_length(w.stages)-1)
   AND app.attendance_workflow_v2_assigned_allowed(OLD.id,d.stage_index,d.assigned_kind,d.assigned_employment_id,d.acting_mode))
   THEN RAISE EXCEPTION 'A same-transaction final frozen workflow decision is required'; END IF;
  IF NEW.status='approved' AND NOT (OLD.requested_ot_minutes IS NOT NULL AND OLD.proposed_check_in IS NULL AND OLD.proposed_check_out IS NULL AND OLD.clock_changes IS NULL AND OLD.attendance_date>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND NOT EXISTS(SELECT 1 FROM public.domain_event ev WHERE ev.tenant_id=OLD.tenant_id AND ev.aggregate_id=OLD.id AND ev.subject_employment_id=OLD.employment_id AND ev.actor_id=app.current_user_id() AND ev.event_type='attendance-correction.effect.recorded')
   THEN RAISE EXCEPTION 'The canonical attendance effect must be recorded before approval'; END IF;
 END IF;
 IF coalesce(current_setting('app.attendance_workflow_effect',true),'')<>'' AND current_setting('app.attendance_workflow_effect',true)<>OLD.id::text
  THEN RAISE EXCEPTION 'A request effect cannot mutate another attendance application'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_workflow_v2_correction_authority BEFORE UPDATE ON public.attendance_correction FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_v2_correction_guard();

--> statement-breakpoint
-- The existing immutable trigger retains the exact one-level transition rule. V2 also requires
-- its proof to belong to this transaction; a committed decision cannot be replayed.
CREATE FUNCTION app.attendance_workflow_v2_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.routing_version=2 AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d
  WHERE d.request_id=OLD.id AND d.tenant_id=OLD.tenant_id AND d.stage_index=OLD.current_stage
   AND d.actual_user_id=app.current_user_id()::text AND app.attendance_workflow_active_write(d.xmin)
   AND ((d.decision='approved' AND NEW.current_stage=OLD.current_stage+1) OR (d.decision='rejected' AND NEW.current_stage=jsonb_array_length(OLD.stages)))
   AND app.attendance_workflow_v2_assigned_allowed(OLD.correction_id,d.stage_index,d.assigned_kind,d.assigned_employment_id,d.acting_mode))
  THEN RAISE EXCEPTION 'A same-transaction frozen current-level decision is required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_workflow_v2_request_authority BEFORE UPDATE ON public.attendance_workflow_request FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_v2_request_guard();

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_workflow_reassignment_guard() FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.attendance_workflow_v2_correction_guard() FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.attendance_workflow_v2_request_guard() FROM PUBLIC,ai_hr_app;
