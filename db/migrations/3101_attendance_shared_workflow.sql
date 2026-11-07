-- Approved feedback 7f30b571 and af1845cb: one versioned definition with explicit companies.
ALTER TABLE public.attendance_workflow_template ADD CONSTRAINT attendance_workflow_template_tenant_identity UNIQUE(tenant_id,id);
CREATE TABLE public.attendance_workflow_company (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 template_id uuid NOT NULL REFERENCES public.attendance_workflow_template(id),
 company_id uuid NOT NULL REFERENCES public.company(id),
 FOREIGN KEY(tenant_id,template_id) REFERENCES public.attendance_workflow_template(tenant_id,id),
 FOREIGN KEY(tenant_id,company_id) REFERENCES public.company(tenant_id,id),
 PRIMARY KEY(template_id,company_id)
);
INSERT INTO public.attendance_workflow_company(tenant_id,template_id,company_id)
 SELECT tenant_id,id,company_id FROM public.attendance_workflow_template;
ALTER TABLE public.attendance_workflow_company ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON public.attendance_workflow_company TO ai_hr_app;
REVOKE UPDATE,DELETE,TRUNCATE ON public.attendance_workflow_company FROM ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_companies(wanted uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 SELECT coalesce(array_agg(a.company_id ORDER BY a.company_id),'{}'::uuid[]) FROM public.attendance_workflow_company a
 WHERE a.template_id=wanted AND a.tenant_id=app.current_tenant_id()
$$;
CREATE FUNCTION app.attendance_workflow_applies(wanted uuid,wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_company a WHERE a.template_id=wanted AND a.tenant_id=app.current_tenant_id() AND a.company_id=wanted_company)
$$;
CREATE FUNCTION app.attendance_workflow_all_companies_admin(wanted uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.attendance_workflow_company a WHERE a.template_id=wanted AND a.tenant_id=app.current_tenant_id())
 AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_company a WHERE a.template_id=wanted AND a.tenant_id=app.current_tenant_id() AND NOT app.is_admin_for(a.company_id))
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_companies(uuid),app.attendance_workflow_applies(uuid,uuid),app.attendance_workflow_all_companies_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_companies(uuid),app.attendance_workflow_applies(uuid,uuid),app.attendance_workflow_all_companies_admin(uuid) TO ai_hr_app;
CREATE POLICY attendance_workflow_company_read ON public.attendance_workflow_company FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY attendance_workflow_company_insert ON public.attendance_workflow_company FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_company_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE t public.attendance_workflow_template;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND rolsuper) THEN RETURN NEW; END IF;
 SELECT v.* INTO t FROM public.attendance_workflow_template v WHERE v.id=NEW.template_id AND v.tenant_id=NEW.tenant_id;
 IF NOT FOUND OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current()
  OR NOT app.is_admin_for(NEW.company_id) OR NOT app.is_admin_for(t.company_id)
  OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=NEW.company_id AND c.tenant_id=NEW.tenant_id)
  OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_template v WHERE v.id=t.id AND app.attendance_workflow_active_write(v.xmin))
 THEN RAISE EXCEPTION 'Company assignment requires a new authorized workflow version'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_workflow_company_binding BEFORE INSERT ON public.attendance_workflow_company FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_company_bind();
CREATE TRIGGER attendance_workflow_company_immutable BEFORE UPDATE OR DELETE ON public.attendance_workflow_company FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable();
-- Legacy writers keep their exact one-company meaning; the service can add more in the same transaction.
CREATE FUNCTION app.attendance_workflow_default_company() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 INSERT INTO public.attendance_workflow_company(tenant_id,template_id,company_id) VALUES(NEW.tenant_id,NEW.id,NEW.company_id);
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_workflow_default_company AFTER INSERT ON public.attendance_workflow_template FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_default_company();
CREATE POLICY attendance_workflow_shared_read ON public.attendance_workflow_template FOR SELECT USING(tenant_id=app.current_tenant_id() AND (EXISTS(SELECT 1 FROM public.attendance_workflow_company assignment WHERE assignment.template_id=attendance_workflow_template.id AND assignment.tenant_id=attendance_workflow_template.tenant_id AND app.is_admin_for(assignment.company_id)) OR EXISTS(SELECT 1 FROM public.employment e WHERE app.attendance_workflow_applies(attendance_workflow_template.id,e.company_id) AND e.id=ANY((SELECT app.visible_employment_ids())::uuid[]))));
CREATE POLICY attendance_workflow_shared_update ON public.attendance_workflow_template AS RESTRICTIVE FOR UPDATE USING(app.attendance_workflow_all_companies_admin(id)) WITH CHECK(app.attendance_workflow_all_companies_admin(id));
--> statement-breakpoint
-- Actor visibility and candidate approval eligibility are distinct. Neither grants the other's rights.
CREATE FUNCTION app.attendance_selected_approver_eligible(wanted_company uuid,wanted_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e JOIN public.company c ON c.id=wanted_company AND c.tenant_id=e.tenant_id
 WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id() AND e.blacklisted_at IS NULL
  AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (LEAST(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR LEAST(e.terminated_on,e.resignation_date,e.last_working_date)>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND 1=(SELECT count(*) FROM public.app_user u WHERE u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=e.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin')
    AND (r.company_id IS NULL OR r.company_id=c.id OR app.is_company_descendant(c.id,r.company_id)))))
$$;
REVOKE ALL ON FUNCTION app.attendance_selected_approver_eligible(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_selected_approver_eligible(uuid,uuid) TO ai_hr_app;
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_approver_options(wanted_companies uuid[])
RETURNS TABLE(id uuid,name text,employee_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 SELECT e.id,p.full_name,e.employee_code FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND app.access_workforce_employment(e.id,'workforce.view')
 AND cardinality(wanted_companies)>0
 AND NOT EXISTS(SELECT 1 FROM unnest(wanted_companies) c WHERE NOT app.is_admin_for(c) OR NOT app.attendance_selected_approver_eligible(c,e.id))
 ORDER BY p.full_name,e.employee_code,e.id
$$;

--> statement-breakpoint
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
    AND app.attendance_workflow_applies(t.id,NEW.company_id) AND t.application_type=NEW.application_type AND t.version=NEW.template_version AND t.routing_version=NEW.routing_version)
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
CREATE OR REPLACE FUNCTION app.attendance_workflow_resolve_v3(subject_id uuid,configured jsonb) RETURNS jsonb
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
  IF jsonb_typeof(stage) IS DISTINCT FROM 'object' THEN RETURN app.attendance_workflow_v3_problem('invalid_level',i); END IF;
  IF NOT stage ?& ARRAY['name','mode','source','hrAlternative']
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
     OR (employee.terminated_on IS NOT NULL AND employee.terminated_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',i,j); END IF;
    SELECT count(*)::integer,min(u.id::text)::uuid INTO login_count,login_id FROM public.app_user u WHERE u.person_id=employee.person_id AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
     AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=subject.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin')
      AND (r.company_id IS NULL OR r.company_id=subject.company_id OR app.is_company_descendant(subject.company_id,r.company_id)));
    IF login_count<>1 THEN RETURN app.attendance_workflow_v3_problem('missing_or_ambiguous_login',i,j); END IF;
    IF NOT app.attendance_selected_approver_eligible(subject.company_id,employee.id) THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',i,j); END IF;
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

--> statement-breakpoint
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
   AND ((actor->>'kind'='specific_employee' AND app.attendance_selected_approver_eligible(w.company_id,e.id)) OR (actor->>'kind'='direct_manager' AND app.is_company_descendant(w.company_id,e.company_id)))
   AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=w.tenant_id
    AND r.role::text IN ('employee','manager','hr_admin','super_admin')
    AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))) THEN RETURN false; END IF;
 IF acting='assigned' THEN RETURN caller.id=(actor->>'userId')::uuid AND caller.person_id=(actor->>'personId')::uuid; END IF;
 RETURN app.can_decide_via_delegation_from((actor->>'employmentId')::uuid,w.employment_id,'attendance','attendance.correction');
END $$;

--> statement-breakpoint
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
     AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND ((candidate_kind='specific_employee' AND app.attendance_selected_approver_eligible(w.company_id,e.id)) OR (candidate_kind='direct_manager' AND app.is_company_descendant(w.company_id,e.company_id)))
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
