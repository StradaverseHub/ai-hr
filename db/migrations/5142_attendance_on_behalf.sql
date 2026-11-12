-- Board 96a54ed2. Draft reservation 5142 @ idx 4542 / when 1793330004842 (unapplied).
-- Request On Behalf and Approve On Behalf for Attendance Irregularity and Self Overtime. Additive: corrections already
-- filed keep NULL submitter columns (NULL = the employee filed it), and every existing decision keeps its mode.

ALTER TABLE public.attendance_correction ADD COLUMN submitted_by_user_id uuid REFERENCES public.app_user(id),
 ADD COLUMN submitted_by_person_id uuid REFERENCES public.person(id), ADD COLUMN submitted_by_name text;
ALTER TABLE public.attendance_correction ADD CONSTRAINT attendance_correction_submitted_by_ck
 CHECK((submitted_by_user_id IS NULL AND submitted_by_person_id IS NULL AND submitted_by_name IS NULL)
  OR (submitted_by_user_id IS NOT NULL AND submitted_by_person_id IS NOT NULL AND submitted_by_name IS NOT NULL AND length(submitted_by_name) BETWEEN 1 AND 300));

--> statement-breakpoint
-- The on-behalf submitter is stamped by the database from the live caller, never from posted values, and only when the
-- Attendance service has authorised the filing in this transaction (app.attendance_on_behalf_submission =
-- '<employment>:<caller user>'). The employee themselves can never be recorded as filing "on behalf". Immutable after.
CREATE FUNCTION app.attendance_correction_submitter_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE caller public.app_user; subject_person uuid; caller_name text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.submitted_by_user_id,NEW.submitted_by_person_id,NEW.submitted_by_name) IS DISTINCT FROM (OLD.submitted_by_user_id,OLD.submitted_by_person_id,OLD.submitted_by_name)
   THEN RAISE EXCEPTION 'The on-behalf submitter of an attendance application is immutable'; END IF;
  RETURN NEW;
 END IF;
 NEW.submitted_by_user_id:=NULL; NEW.submitted_by_person_id:=NULL; NEW.submitted_by_name:=NULL;
 IF coalesce(current_setting('app.attendance_on_behalf_submission',true),'')='' OR app.current_user_id() IS NULL
  OR current_setting('app.attendance_on_behalf_submission',true)<>NEW.employment_id::text||':'||app.current_user_id()::text THEN RETURN NEW; END IF;
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 SELECT e.person_id INTO subject_person FROM public.employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id;
 IF caller.id IS NULL OR caller.person_id IS NULL OR caller.person_id IS NOT DISTINCT FROM subject_person THEN RAISE EXCEPTION 'An on-behalf filing needs a live submitter who is not the employee' USING ERRCODE='42501'; END IF;
 SELECT p.full_name INTO caller_name FROM public.person p WHERE p.id=caller.person_id AND p.tenant_id=NEW.tenant_id;
 NEW.submitted_by_user_id:=caller.id; NEW.submitted_by_person_id:=caller.person_id; NEW.submitted_by_name:=left(coalesce(nullif(btrim(caller_name),''),caller.id::text),300);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_correction_submitter_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_correction_submitter BEFORE INSERT OR UPDATE ON public.attendance_correction FOR EACH ROW EXECUTE FUNCTION app.attendance_correction_submitter_guard();

--> statement-breakpoint
-- Decisions taken for a designated approver record acting_mode on_behalf; the designated approver stays in "assigned".
DO $modes$
DECLARE c record;
BEGIN
 FOR c IN SELECT con.conname,rel.relname FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class rel ON rel.oid=con.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=rel.relnamespace
  WHERE n.nspname='public' AND rel.relname IN ('attendance_workflow_decision','attendance_workflow_participant_decision') AND con.contype='c'
   AND pg_catalog.pg_get_constraintdef(con.oid) LIKE '%acting_mode%' LOOP
  EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',c.relname,c.conname);
 END LOOP;
END $modes$;
ALTER TABLE public.attendance_workflow_decision ADD CONSTRAINT attendance_workflow_decision_acting_mode_ck CHECK(acting_mode IN ('assigned','delegate','administrator','on_behalf'));
ALTER TABLE public.attendance_workflow_participant_decision ADD CONSTRAINT attendance_workflow_participant_decision_acting_mode_ck CHECK(acting_mode IN ('assigned','delegate','administrator','on_behalf'));

--> statement-breakpoint
-- Approve On Behalf authority for one frozen v3/v4 participant slot, independent of whether it is still outstanding
-- (so a same-transaction completion can re-prove it, as v3_assigned_allowed does for the assigned mode). The caller is
-- neither the applicant, the designated approver nor the person who filed the application on the employee's behalf;
-- the designated employment is active (a login is not required, so pending-activation approvers are covered). The
-- caller is scoped HR for the application's company, or the designated approver is beneath one of the caller's own
-- employments in the administrative reporting line and the caller may see the employee. Permission keys are checked
-- by the Attendance service before it writes.
CREATE FUNCTION app.attendance_workflow_on_behalf_allowed(wanted_request uuid,wanted_stage integer,wanted_slot text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; caller public.app_user; actor jsonb; subject_person uuid; submitter uuid;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.id=wanted_request AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND OR NOT app.principal_snapshot_current() THEN RETURN false; END IF;
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT FOUND OR caller.person_id IS NULL THEN RETURN false; END IF;
 SELECT e.person_id INTO subject_person FROM public.employment e WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 SELECT c.submitted_by_person_id INTO submitter FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id;
 IF caller.person_id=subject_person OR caller.person_id IS NOT DISTINCT FROM submitter THEN RETURN false; END IF;
 actor:=app.attendance_workflow_v3_actor(w.id,wanted_stage,wanted_slot);
 IF actor IS NULL OR actor->>'kind' NOT IN ('direct_manager','specific_employee') OR coalesce(actor->>'employmentId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR actor->>'personId'=caller.person_id::text THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=(actor->>'employmentId')::uuid AND e.tenant_id=w.tenant_id AND e.person_id::text=actor->>'personId'
  AND e.person_id<>subject_person AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN RETURN false; END IF;
 IF app.is_admin_for(w.company_id) AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=caller.id AND r.tenant_id=w.tenant_id
  AND r.role::text IN ('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id))) THEN RETURN true; END IF;
 RETURN app.can_see_employment(w.employment_id) AND EXISTS(SELECT 1 FROM public.employment me WHERE me.person_id=caller.person_id AND me.tenant_id=w.tenant_id
  AND me.terminated_on IS NULL AND app.is_admin_report_of((actor->>'employmentId')::uuid,me.id));
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_on_behalf_allowed(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_on_behalf_allowed(uuid,integer,text) TO ai_hr_app;

--> statement-breakpoint
-- The outstanding slot of one designated employment at the application's current level that this caller may decide on
-- their behalf. One person still cannot act on two levels of the same application.
CREATE FUNCTION app.attendance_workflow_on_behalf_slot(correction uuid,designated uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; a jsonb; caller_person uuid;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.correction_id=correction AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND OR designated IS NULL OR w.current_stage>=jsonb_array_length(w.stages) THEN RETURN NULL; END IF;
 SELECT u.person_id INTO caller_person FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF caller_person IS NULL
  OR EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=app.current_user_id() OR d.actual_person_id=caller_person))
  OR EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=app.current_user_id()::text OR d.actual_person_id=caller_person)) THEN RETURN NULL; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(app.attendance_workflow_v3_effective(w.id,w.current_stage)) LOOP
  IF a->>'employmentId'=designated::text AND app.attendance_workflow_v3_outstanding(w.id,w.current_stage,a->>'slot')
   AND app.attendance_workflow_on_behalf_allowed(w.id,w.current_stage,a->>'slot') THEN
   RETURN jsonb_build_object('slot',a->>'slot','assigned',a,'actingMode','on_behalf');
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_on_behalf_slot(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_on_behalf_slot(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
-- Replaces 0592: a decider who filed the application on the employee's behalf is refused (v1/v2 paths).
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
   OR EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND actual_person IS NOT NULL AND c.submitted_by_person_id=actual_person)
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
  OR EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND actual_person IS NOT NULL AND c.submitted_by_person_id=actual_person)
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
-- Replaces 0592: the person who filed on the employee's behalf holds no slot of that application.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_decision_slot(correction uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; a jsonb; slot text; actor_person uuid;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.correction_id=correction AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND OR w.current_stage>=jsonb_array_length(w.stages) THEN RETURN NULL; END IF;
 SELECT u.person_id INTO actor_person FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT FOUND OR actor_person IS NULL OR EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=app.current_user_id() OR d.actual_person_id=actor_person))
  OR EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.submitted_by_person_id=actor_person) THEN RETURN NULL; END IF;
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
-- Replaces 0592: on_behalf rows are admitted only through the on-behalf authority; the filer never decides.
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
  OR NOT (CASE WHEN NEW.acting_mode='on_behalf' THEN app.attendance_workflow_on_behalf_allowed(w.id,NEW.stage_index,NEW.participant_slot)
   ELSE app.attendance_workflow_v3_assigned_allowed(w.id,NEW.stage_index,NEW.participant_slot,NEW.acting_mode) END)
  OR EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.submitted_by_person_id=actor.person_id)
  OR NEW.assigned IS DISTINCT FROM app.attendance_workflow_v3_actor(w.id,NEW.stage_index,NEW.participant_slot)
  OR EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.tenant_id=w.tenant_id AND d.request_id=w.id AND (d.actual_user_id=actor.id OR d.actual_person_id=actor.person_id))
  OR (NEW.actual_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.actual_employment_id AND e.tenant_id=w.tenant_id AND e.person_id=actor.person_id))
  OR (coalesce(current_setting('app.attendance_workflow_effect',true),'')<>'' AND current_setting('app.attendance_workflow_effect',true)<>w.correction_id::text)
  THEN RAISE EXCEPTION 'Only the next distinct authorized frozen participant may decide this pending slot'; END IF;
 SELECT coalesce(p.full_name,actor.id::text) INTO NEW.actual_actor_name FROM public.person p WHERE p.id=actor.person_id AND p.tenant_id=w.tenant_id;
 NEW.decided_at:=clock_timestamp(); RETURN NEW;
END $$;

--> statement-breakpoint
-- Replaces 0592: an on_behalf participant row proves completion through the on-behalf authority.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_completion_write(wanted_request uuid,wanted_stage integer,wanted_decision text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_request w JOIN public.attendance_workflow_participant_decision p ON p.request_id=w.id AND p.tenant_id=w.tenant_id
  WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id() AND w.routing_version IN (3,4) AND p.stage_index=wanted_stage
   AND p.actual_user_id=app.current_user_id() AND app.attendance_workflow_active_write(p.xmin)
   AND app.attendance_workflow_v3_completed(w.id,wanted_stage)=wanted_decision AND p.decision=wanted_decision
   AND (CASE WHEN p.acting_mode='on_behalf' THEN app.attendance_workflow_on_behalf_allowed(w.id,wanted_stage,p.participant_slot)
    ELSE app.attendance_workflow_v3_assigned_allowed(w.id,wanted_stage,p.participant_slot,p.acting_mode) END));
$$;

--> statement-breakpoint
-- Replaces 0570: the participant row may also be written through the on-behalf slot of its designated employment.
DROP POLICY attendance_workflow_v3_participant_insert ON public.attendance_workflow_participant_decision;
CREATE POLICY attendance_workflow_v3_participant_insert ON public.attendance_workflow_participant_decision FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND actual_user_id=app.current_user_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.tenant_id=app.current_tenant_id()
  AND (app.attendance_workflow_v3_decision_slot(w.correction_id) IS NOT NULL
   OR (acting_mode='on_behalf' AND app.attendance_workflow_on_behalf_slot(w.correction_id,(assigned->>'employmentId')::uuid)->>'slot'=participant_slot))));
