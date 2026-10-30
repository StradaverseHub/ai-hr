-- ADR-0151 personnel parity: one human-reviewed employment non-own current schedule-group change.
-- PROVISIONAL SOURCE CLAIM ONLY: 0729 / idx709 / when1793330000066. Reallocate above the
-- then-live accepted ledger at integration freeze. No installation priority or deployment authority.
-- Reuse the one prepared-action ledger and its generic ASSIGNED custody. Every prior kind retains
-- its prior constraints, binding, verifier and receipt behaviour; no historical SQL is edited.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('attendance.schedule_group.maintain','attendance','approve','personnel','attendance.schedule_group.maintain');
--> statement-breakpoint
-- A USER need not be linked to a PERSON. Only this kind gains a nullable actor identity;
-- its true subject remains bound by the existing decision/binding/receipt owners.
-- Preserve the complete accepted scope predicate for every predecessor kind.
DO $$
DECLARE previous text;constraint_name text;matches integer;
BEGIN
 SELECT count(*),min(conname) INTO matches,constraint_name FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c'
   AND pg_get_expr(conbin,conrelid) LIKE '%testing_execution_id IS NOT NULL%'
   AND pg_get_expr(conbin,conrelid) LIKE '%employment_id IS NULL%';
 IF matches<>1 THEN RAISE EXCEPTION '0729: unexpected actor subject scope predicate';END IF;
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=constraint_name;
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',constraint_name);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''attendance.schedule_group.maintain'' THEN employment_id IS NOT NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL ELSE (%s) END)',constraint_name,previous);
END $$;
--> statement-breakpoint
-- Extend the existing HR generic branch itself, preserving its complete predicate. Other dedicated
-- receipt families retain their separate null-column CHECKs from 0622. Refuse unexpected schema drift.
DO $$
DECLARE previous text;generic_columns text;
BEGIN
 SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname='assistant_review_kind_columns' AND c.contype='c';
 IF previous IS NULL OR position('employees.qualification.maintain' in previous)=0 THEN RAISE EXCEPTION '0729: existing generic assigned branch unavailable';END IF;
 -- Exact canonical generic null-column rule from0670; carry the nested predecessor ONLY ONCE.
 -- Copying/rebinding the whole predecessor here duplicates its expression tree and exhausts replay memory.
 generic_columns:='leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND performance_ack_event_id IS NULL';
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK (CASE WHEN action_kind=''attendance.schedule_group.maintain'' THEN ('||generic_columns||') ELSE ('||previous||') END)';
END $$;
--> statement-breakpoint
-- Preserve each remaining prior expression exactly, adding only a branch for this kind.
DO $$
DECLARE item record;previous text;added text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('assistant_review_decision_columns', 'decision_subject_person_id IS NOT NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
  ('assistant_review_generic_receipt', 'receipt_subject_kind=''employment'' AND receipt_subject_id=employment_id AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')
 ) AS requirements(name,expression) LOOP
  SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
   WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname=item.name AND c.contype='c';
  IF previous IS NULL THEN RAISE EXCEPTION '0729: missing custody constraint %',item.name;END IF;
  added:='CASE WHEN action_kind=''attendance.schedule_group.maintain'' THEN ('||item.expression||') ELSE ('||previous||') END';
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (%s)',item.name,added);
 END LOOP;
END $$;
--> statement-breakpoint
-- One pending review per employment PER CALLER, preserving every previous index predicate.
DO $$
DECLARE generic_predicate text;assigned_predicate text;
BEGIN
 SELECT pg_get_expr(indpred,indrelid) INTO generic_predicate FROM pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 SELECT pg_get_expr(indpred,indrelid) INTO assigned_predicate FROM pg_index WHERE indexrelid='app.assistant_review_assigned_pending_subject'::regclass;
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION '0729: missing custody indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''attendance.schedule_group.maintain''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') OR (action_kind=''attendance.schedule_group.maintain'' AND receipt_subject_id IS NOT NULL AND state=''awaiting_confirmation'')';
END $$;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_subject_kind(text) RENAME TO _assistant_assigned_review_subject_kind_0729_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_kind='attendance.schedule_group.maintain' THEN 'employment' ELSE app._assistant_assigned_review_subject_kind_0729_previous(p_kind) END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind_0729_previous(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Native mounted HR/company admission; NON-OWN is an explicit Assistant narrowing.
CREATE FUNCTION app.assistant_attendance_schedule_group_choice_scope(p_employment uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND app.is_admin() AND EXISTS(
 SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
 AND app.is_admin_for(e.company_id) AND app.can_admin_employment(e.id)
 AND NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=e.tenant_id AND a.person_id=e.person_id));
$$;
REVOKE ALL ON FUNCTION app.assistant_attendance_schedule_group_choice_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_schedule_group_choice_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_attendance_schedule_group_scope(p_employment uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment%ROWTYPE;revision text;generation text;
BEGIN
 IF app.assistant_attendance_schedule_group_choice_scope(p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Schedule group unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.assistant_attendance_schedule_group_choice_scope(p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Schedule group unavailable' USING ERRCODE='42501';END IF;
 SELECT r.xmin::text,coalesce(a.revision::text,'')||':'||coalesce(g.generation::text,'') INTO revision,generation FROM public.employment r LEFT JOIN public.access_configuration a ON a.tenant_id=r.tenant_id LEFT JOIN app.access_profile_write_generation g ON g.tenant_id=r.tenant_id WHERE r.id=e.id AND r.tenant_id=e.tenant_id;
 RETURN jsonb_build_object('subjectId',e.id,'employmentId',e.id,'companyId',e.company_id,'subjectPersonId',e.person_id,'employeeName',(SELECT full_name FROM public.person WHERE id=e.person_id AND tenant_id=e.tenant_id),'employeeCode',e.employee_code,'companyName',(SELECT legal_name FROM public.company WHERE id=e.company_id AND tenant_id=e.tenant_id),'attendanceRuleId',e.attendance_rule_id,'revision',revision,'generation',generation);
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_schedule_group_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_schedule_group_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) RENAME TO _assistant_assigned_review_binding_0729_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_assigned_review_binding_0729_previous(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 IF p_kind='attendance.schedule_group.maintain' AND (p_subject IS DISTINCT FROM p_employment OR app.assistant_attendance_schedule_group_choice_scope(p_employment) IS NOT TRUE) THEN RAISE EXCEPTION 'Schedule group review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding_0729_previous(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_0729_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();x xid:=pg_current_xact_id()::xid;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u;
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind<>'attendance.schedule_group.maintain' THEN RETURN app._assistant_generic_review_verify_0729_previous(p_id,p_event);END IF;
 IF r.receipt_subject_kind IS DISTINCT FROM 'employment' OR r.receipt_subject_id IS DISTINCT FROM r.employment_id
  OR app.assistant_attendance_schedule_group_choice_scope(r.employment_id) IS NOT TRUE THEN RETURN false;END IF;
 -- The employment and native code event are both top-level writes in THIS transaction by THIS login.
 -- The shared Person is ownership metadata only; it is not changed and must not have a current xmin.
 RETURN EXISTS(SELECT 1 FROM public.employment e JOIN public.domain_event d ON d.tenant_id=e.tenant_id AND d.aggregate_id=e.id
  WHERE e.id=r.employment_id AND e.tenant_id=t AND e.person_id=r.decision_subject_person_id AND e.company_id=r.company_id AND e.xmin=x
  AND d.id=p_event AND d.xmin=x AND d.aggregate_type='employment' AND d.event_type='employment.schedule-group.changed'
  AND d.subject_employment_id=e.id AND d.actor_type='user' AND d.actor_id=u
  AND d.payload->'after' IS NOT DISTINCT FROM coalesce(to_jsonb(e.attendance_rule_id),'null'::jsonb)
  AND d.payload->'before' IS DISTINCT FROM d.payload->'after');
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify_0729_previous(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The exact ID is returned by the SAME native top-level transaction; never search for a lookalike event.
CREATE FUNCTION app.assistant_attendance_schedule_group_current_event(p_employment uuid,p_event uuid,p_before jsonb,p_after jsonb) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE found uuid;x xid:=pg_current_xact_id()::xid;
BEGIN
 IF app.assistant_attendance_schedule_group_choice_scope(p_employment) IS NOT TRUE OR p_before IS NULL OR p_after IS NULL OR p_before IS NOT DISTINCT FROM p_after THEN RAISE EXCEPTION 'Schedule group proof unavailable' USING ERRCODE='42501';END IF;
 SELECT d.id INTO found FROM public.employment e JOIN public.domain_event d ON d.tenant_id=e.tenant_id AND d.aggregate_id=e.id
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND e.xmin=x
 AND d.id=p_event AND d.xmin=x AND d.aggregate_type='employment' AND d.event_type='employment.schedule-group.changed'
 AND d.subject_employment_id=e.id AND d.actor_type='user' AND d.actor_id=app.current_user_id()
 AND d.payload=jsonb_build_object('before',p_before,'after',p_after)
 AND p_after IS NOT DISTINCT FROM coalesce(to_jsonb(e.attendance_rule_id),'null'::jsonb);
 IF found IS NULL THEN RAISE EXCEPTION 'Schedule group proof unavailable' USING ERRCODE='42501';END IF;RETURN found;
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_schedule_group_current_event(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_schedule_group_current_event(uuid,uuid,jsonb,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_attendance_schedule_group_receipt(p_employment uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt jsonb;
BEGIN
 IF app.assistant_attendance_schedule_group_choice_scope(p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Schedule group receipt unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('kind','maintained','subjectId',e.id,'employmentId',e.id,'eventId',d.id,'before',d.payload->'before','after',d.payload->'after') INTO receipt
 FROM public.employment e JOIN public.domain_event d ON d.tenant_id=e.tenant_id AND d.aggregate_id=e.id
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND d.id=p_event AND d.aggregate_type='employment'
 AND d.subject_employment_id=e.id AND d.event_type='employment.schedule-group.changed' AND d.actor_type='user' AND d.actor_id=app.current_user_id()
 AND d.payload->'before' IS DISTINCT FROM d.payload->'after';
 IF receipt IS NULL THEN RAISE EXCEPTION 'Schedule group receipt unavailable' USING ERRCODE='42501';END IF;RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_schedule_group_receipt(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_schedule_group_receipt(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Extend current outcome owners, preserving sibling action packages composed before this provisional tail.
DO $$
DECLARE target regprocedure;definition text;marker text;replacement text;bound text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY[
  'app.native_outcome_review_completed(text,uuid)',
  'app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)',
  'app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN
   marker:='WHEN ''employees.qualification.maintain'' THEN r.receipt_event_id';
   replacement:=marker||' WHEN ''attendance.schedule_group.maintain'' THEN r.receipt_event_id';
  ELSE
   marker:='''employees.qualification.maintain''';replacement:=marker||',''attendance.schedule_group.maintain''';
  END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0729: unexpected native outcome owner %',target;END IF;
  definition:=replace(definition,marker,replacement);
  IF target='app.native_outcome_completed_review_choices(jsonb)'::regprocedure THEN
   definition:=regexp_replace(definition,'NOT BETWEEN 1 AND [0-9]+','NOT BETWEEN 1 AND (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
   definition:=regexp_replace(definition,'LIMIT [0-9]+','LIMIT (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
  END IF;
  EXECUTE definition;
 END LOOP;
END $$;
