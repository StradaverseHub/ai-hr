-- Independent Attendance workflow versions. Existing requests are not backfilled or re-routed.
CREATE TABLE attendance_workflow_template (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id), code text NOT NULL, name text NOT NULL,
 description text, application_type text NOT NULL CHECK(application_type IN ('irregularity','self_overtime')),
 priority integer NOT NULL CHECK(priority BETWEEN 0 AND 9999), criteria jsonb NOT NULL DEFAULT '{}',
 stages jsonb NOT NULL, version integer NOT NULL CHECK(version>0), active boolean NOT NULL DEFAULT false,
 lineage_id uuid NOT NULL, superseded_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(stages)='array' AND jsonb_array_length(stages) BETWEEN 1 AND 10)
);--> statement-breakpoint
CREATE UNIQUE INDEX attendance_workflow_current_code ON attendance_workflow_template(tenant_id,company_id,code) WHERE superseded_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX attendance_workflow_lineage_version ON attendance_workflow_template(lineage_id,version);--> statement-breakpoint
CREATE TABLE attendance_workflow_setting (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id), application_type text NOT NULL CHECK(application_type IN ('irregularity','self_overtime')),
 enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX attendance_workflow_setting_company_type ON attendance_workflow_setting(tenant_id,company_id,application_type);--> statement-breakpoint
CREATE TABLE attendance_workflow_request (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 correction_id uuid NOT NULL REFERENCES attendance_correction(id), employment_id uuid NOT NULL REFERENCES employment(id),
 company_id uuid NOT NULL REFERENCES company(id), template_id uuid NOT NULL REFERENCES attendance_workflow_template(id),
 template_code text NOT NULL, template_name text NOT NULL, template_version integer NOT NULL,
 application_type text NOT NULL CHECK(application_type IN ('irregularity','self_overtime')),
 stages jsonb NOT NULL, current_stage integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(stages)='array' AND jsonb_array_length(stages) BETWEEN 1 AND 10),
 CHECK(current_stage>=0 AND current_stage<=jsonb_array_length(stages))
);--> statement-breakpoint
CREATE UNIQUE INDEX attendance_workflow_request_correction ON attendance_workflow_request(correction_id);--> statement-breakpoint
CREATE TABLE attendance_workflow_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 request_id uuid NOT NULL REFERENCES attendance_workflow_request(id), employment_id uuid NOT NULL REFERENCES employment(id),
 stage_index integer NOT NULL CHECK(stage_index>=0), decision text NOT NULL CHECK(decision IN ('approved','rejected')),
 assigned_kind text NOT NULL CHECK(assigned_kind IN ('direct_manager','hr_admin')), assigned_employment_id uuid REFERENCES employment(id),
 actual_user_id text NOT NULL, actual_actor_name text NOT NULL, actual_person_id uuid REFERENCES person(id),
 actual_employment_id uuid REFERENCES employment(id), acting_mode text NOT NULL CHECK(acting_mode IN ('assigned','delegate','administrator')),
 remarks text, previous_status text NOT NULL DEFAULT 'pending', resulting_status text NOT NULL CHECK(resulting_status IN ('pending','approved','rejected')),
 decided_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX attendance_workflow_decision_stage ON attendance_workflow_decision(request_id,stage_index);--> statement-breakpoint
ALTER TABLE attendance_correction ADD COLUMN cancelled_at timestamptz, ADD COLUMN cancelled_by_user_id text,
 ADD COLUMN cancellation_kind text CHECK(cancellation_kind IN ('cancelled','withdrawn')), ADD COLUMN cancellation_reason text;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON attendance_workflow_template,attendance_workflow_setting,attendance_workflow_request,attendance_workflow_decision TO ai_hr_app;--> statement-breakpoint
ALTER TABLE attendance_workflow_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE attendance_workflow_setting ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE attendance_workflow_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE attendance_workflow_decision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Employees must resolve their own company's configuration at submission; writes remain admin scoped.
CREATE POLICY attendance_workflow_template_read ON attendance_workflow_template FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.is_admin_for(company_id) OR EXISTS(SELECT 1 FROM employment e WHERE e.company_id=attendance_workflow_template.company_id AND app.can_see_employment(e.id))));--> statement-breakpoint
CREATE POLICY attendance_workflow_template_write ON attendance_workflow_template FOR ALL USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint
CREATE POLICY attendance_workflow_setting_read ON attendance_workflow_setting FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.is_admin_for(company_id) OR EXISTS(SELECT 1 FROM employment e WHERE e.company_id=attendance_workflow_setting.company_id AND app.can_see_employment(e.id))));--> statement-breakpoint
CREATE POLICY attendance_workflow_setting_write ON attendance_workflow_setting FOR ALL USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint
CREATE POLICY attendance_workflow_request_read ON attendance_workflow_request FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.can_see_employment(employment_id) OR app.can_decide_via_delegation(employment_id,'attendance','attendance.correction')));--> statement-breakpoint
CREATE POLICY attendance_workflow_request_insert ON attendance_workflow_request FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_see_employment(employment_id));--> statement-breakpoint
CREATE POLICY attendance_workflow_request_advance ON attendance_workflow_request FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.can_correct_attendance(employment_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_correct_attendance(employment_id));--> statement-breakpoint
CREATE POLICY attendance_workflow_decision_read ON attendance_workflow_decision FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.can_see_employment(employment_id) OR app.can_decide_via_delegation(employment_id,'attendance','attendance.correction')));--> statement-breakpoint
CREATE POLICY attendance_workflow_decision_insert ON attendance_workflow_decision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND actual_user_id=coalesce(app.current_user_id()::text,'system') AND app.can_correct_attendance(employment_id) AND NOT EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id WHERE e.id=employment_id AND u.id=app.current_user_id()));--> statement-breakpoint
-- Freeze template content and request routing. Only retirement/advancement may be updated.
CREATE FUNCTION app.attendance_workflow_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Approval routing history is immutable'; END IF;
 IF TG_TABLE_NAME='attendance_workflow_template' THEN
  IF to_jsonb(OLD)-'superseded_at' IS DISTINCT FROM to_jsonb(NEW)-'superseded_at' THEN RAISE EXCEPTION 'Workflow versions are immutable'; END IF;
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
END $$;--> statement-breakpoint
CREATE TRIGGER attendance_workflow_template_immutable BEFORE UPDATE OR DELETE ON attendance_workflow_template FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_immutable();--> statement-breakpoint
CREATE TRIGGER attendance_workflow_request_immutable BEFORE UPDATE OR DELETE ON attendance_workflow_request FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_immutable();--> statement-breakpoint
CREATE TRIGGER attendance_workflow_decision_immutable BEFORE UPDATE OR DELETE ON attendance_workflow_decision FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_immutable();--> statement-breakpoint
-- Narrow identity reader for an active manager at submission: no personnel visibility is widened.
CREATE FUNCTION app.attendance_workflow_manager(subject_id uuid) RETURNS TABLE(employment_id uuid,full_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE chain(id,path,cycle) AS (
  SELECT subject_id,ARRAY[subject_id],false
  UNION ALL
  SELECT l.manager_employment_id,c.path||l.manager_employment_id,l.manager_employment_id=ANY(c.path)
  FROM chain c JOIN public.reporting_line l ON l.subordinate_employment_id=c.id
  WHERE NOT c.cycle AND l.tenant_id=app.current_tenant_id() AND l.line_type='administrative'
   AND l.superseded_at IS NULL AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 )
 SELECT manager.id,p.full_name FROM public.employment subject
 JOIN public.reporting_line line ON line.subordinate_employment_id=subject.id AND line.tenant_id=subject.tenant_id
 JOIN public.employment manager ON manager.id=line.manager_employment_id AND manager.tenant_id=subject.tenant_id
 JOIN public.person p ON p.id=manager.person_id AND p.tenant_id=subject.tenant_id
 WHERE subject.id=subject_id AND subject.tenant_id=app.current_tenant_id() AND (app.can_see_employment(subject.id) OR app.can_decide_via_delegation(subject.id,'attendance','attendance.correction'))
 AND NOT EXISTS(SELECT 1 FROM chain WHERE cycle)
 AND manager.person_id<>subject.person_id AND manager.blacklisted_at IS NULL
 AND app.is_company_descendant(subject.company_id,manager.company_id)
 AND EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
  WHERE u.person_id=manager.person_id AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND r.role::text IN ('employee','manager','hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=subject.company_id OR app.is_company_descendant(subject.company_id,r.company_id)))
 AND manager.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND (manager.terminated_on IS NULL OR manager.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND line.line_type='administrative' AND line.superseded_at IS NULL
 AND line.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND (line.valid_to IS NULL OR line.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 ORDER BY line.id;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_workflow_manager(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.attendance_workflow_manager(uuid) TO ai_hr_app;

--> statement-breakpoint
-- A stage is usable only when someone other than the subject has live scoped HR authority.
-- Return a capability boolean; employee submission cannot enumerate administrator identities.
CREATE FUNCTION app.attendance_workflow_has_hr(subject_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e
  JOIN public.app_user u ON u.tenant_id=e.tenant_id AND u.person_id IS DISTINCT FROM e.person_id
  JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=e.tenant_id
  WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id() AND app.can_see_employment(e.id)
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND r.role::text IN ('hr_admin','super_admin')
   AND (r.company_id IS NULL OR r.company_id=e.company_id OR app.is_company_descendant(e.company_id,r.company_id)));
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_workflow_has_hr(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.attendance_workflow_has_hr(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Internal request-bound authority seam. It exposes no employment/pay/schedule facts and changes no RLS.
-- Only a just-recorded final delegated approval can resolve its frozen manager's live login grants.
CREATE FUNCTION app.attendance_workflow_effect_identity(correction uuid, stage integer)
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
 WHERE w.correction_id=correction AND w.tenant_id=app.current_tenant_id()
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
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_workflow_effect_identity(uuid,integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.attendance_workflow_effect_identity(uuid,integer) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_delegate_request(correction uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.attendance_workflow_request w
  JOIN public.attendance_correction c ON c.id=w.correction_id AND c.employment_id=w.employment_id AND c.tenant_id=w.tenant_id
  CROSS JOIN LATERAL jsonb_array_elements(w.stages) stage
  CROSS JOIN LATERAL jsonb_array_elements(stage->'approvers') approver
  WHERE c.id=correction AND w.tenant_id=app.current_tenant_id()
   AND EXISTS(SELECT 1 FROM public.app_user caller WHERE caller.id=app.current_user_id() AND caller.tenant_id=w.tenant_id AND caller.archived_at IS NULL AND NOT app.login_blocked(caller.id))
   AND approver->>'kind'='direct_manager'
   AND app.can_decide_via_delegation(w.employment_id,'attendance','attendance.correction')
   AND app.can_decide_via_delegation_from((approver->>'employmentId')::uuid,w.employment_id,'attendance','attendance.correction')
 );
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_workflow_delegate_request(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.attendance_workflow_delegate_request(uuid) TO ai_hr_app;--> statement-breakpoint
-- Add only request access. A delegate still cannot read the subject's employment, person, pay or punches.
CREATE POLICY attendance_workflow_delegate_read ON attendance_correction FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.attendance_workflow_delegate_request(id));--> statement-breakpoint
CREATE POLICY attendance_workflow_delegate_decide ON attendance_correction FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.attendance_workflow_delegate_request(id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.attendance_workflow_delegate_request(id));--> statement-breakpoint
CREATE FUNCTION app.attendance_application_subject(correction uuid)
RETURNS TABLE(person_id uuid,employee text,employee_code text,company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.person_id,p.full_name,e.employee_code,e.company_id
 FROM public.attendance_correction c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE c.id=correction AND c.tenant_id=app.current_tenant_id()
  AND (app.can_see_employment(e.id) OR app.attendance_workflow_delegate_request(c.id));
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_application_subject(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.attendance_application_subject(uuid) TO ai_hr_app;--> statement-breakpoint
-- Validate all new links in their tenant. The mutable organisation is checked only at submission;
-- subsequent transfers must not rewrite or invalidate a frozen request's historical company.
CREATE FUNCTION app.attendance_workflow_links() RETURNS trigger
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
    AND t.company_id=NEW.company_id AND t.application_type=NEW.application_type AND t.version=NEW.template_version)
   THEN RAISE EXCEPTION 'Invalid workflow application links'; END IF;
 ELSIF TG_TABLE_NAME='attendance_workflow_decision' THEN
  IF NOT EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=NEW.request_id AND w.tenant_id=NEW.tenant_id AND w.employment_id=NEW.employment_id)
   OR (NEW.assigned_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.assigned_employment_id AND e.tenant_id=NEW.tenant_id))
   OR (NEW.actual_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.actual_employment_id AND e.tenant_id=NEW.tenant_id AND e.person_id=NEW.actual_person_id))
   OR (NEW.actual_person_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.person p WHERE p.id=NEW.actual_person_id AND p.tenant_id=NEW.tenant_id))
   THEN RAISE EXCEPTION 'Invalid workflow decision links'; END IF;
 END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER attendance_workflow_template_links BEFORE INSERT ON attendance_workflow_template FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_links();--> statement-breakpoint
CREATE TRIGGER attendance_workflow_setting_links BEFORE INSERT OR UPDATE ON attendance_workflow_setting FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_links();--> statement-breakpoint
CREATE TRIGGER attendance_workflow_request_links BEFORE INSERT ON attendance_workflow_request FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_links();--> statement-breakpoint
CREATE TRIGGER attendance_workflow_decision_links BEFORE INSERT ON attendance_workflow_decision FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_links();

--> statement-breakpoint
-- Delegation adds a decision capability, never an arbitrary application editing capability.
CREATE FUNCTION app.attendance_workflow_delegate_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.can_see_employment(OLD.employment_id) AND app.attendance_workflow_delegate_request(OLD.id) THEN
  IF (to_jsonb(OLD)-ARRAY['status','reject_reason','decided_by_employment_id','decided_at'])
    IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','reject_reason','decided_by_employment_id','decided_at'])
   OR OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected')
   OR (NEW.decided_by_employment_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
    WHERE e.id=NEW.decided_by_employment_id AND e.tenant_id=OLD.tenant_id AND u.id=app.current_user_id()))
   OR (NEW.status='approved' AND NOT (OLD.requested_ot_minutes IS NOT NULL AND OLD.proposed_check_in IS NULL AND OLD.proposed_check_out IS NULL AND OLD.clock_changes IS NULL AND OLD.attendance_date>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
    AND NOT EXISTS(SELECT 1 FROM public.domain_event ev WHERE ev.tenant_id=OLD.tenant_id AND ev.aggregate_id=OLD.id
     AND ev.subject_employment_id=OLD.employment_id AND ev.actor_id=app.current_user_id() AND ev.event_type='attendance-correction.effect.recorded'))
   OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_request w JOIN public.attendance_workflow_decision d ON d.request_id=w.id AND d.tenant_id=w.tenant_id
    WHERE w.correction_id=OLD.id AND w.tenant_id=OLD.tenant_id AND w.current_stage=jsonb_array_length(w.stages)
     AND d.actual_user_id=app.current_user_id()::text AND d.resulting_status=NEW.status::text
     AND (NEW.status='rejected' OR d.stage_index=jsonb_array_length(w.stages)-1))
   THEN RAISE EXCEPTION 'Delegates may only record the authorised final application decision'; END IF;
 END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER attendance_workflow_delegate_update BEFORE UPDATE ON attendance_correction FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_delegate_update_guard();--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_decision_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; assigned_person uuid; actual_person uuid; subject_company uuid;
BEGIN
 SELECT * INTO STRICT w FROM public.attendance_workflow_request WHERE id=NEW.request_id AND tenant_id=NEW.tenant_id FOR UPDATE;
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
 IF NEW.previous_status<>'pending' OR NEW.resulting_status<>CASE WHEN NEW.decision='rejected' OR NEW.stage_index=jsonb_array_length(w.stages)-1 THEN NEW.decision ELSE 'pending' END
  THEN RAISE EXCEPTION 'Invalid stage outcome'; END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER attendance_workflow_decision_authority BEFORE INSERT ON attendance_workflow_decision FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_decision_guard();
