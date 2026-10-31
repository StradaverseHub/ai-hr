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
  ('assistant_review_generic_receipt', 'receipt_subject_kind IS NOT NULL AND receipt_subject_id IS NOT NULL AND receipt_subject_kind=''employment'' AND receipt_subject_id=employment_id AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')
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

--> statement-breakpoint
-- SQL-owned PRE-native evidence in the EXISTING private pending ledger. Never a caller's expected row.
ALTER TABLE app.assistant_own_leave_review
 ADD COLUMN attendance_group_proof_version integer,
 ADD COLUMN attendance_group_unchanged text,
 ADD COLUMN attendance_group_before uuid,
 ADD COLUMN attendance_group_after uuid;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_attendance_group_proof CHECK(
 CASE WHEN action_kind='attendance.schedule_group.maintain' THEN
  (attendance_group_proof_version IS NULL AND attendance_group_unchanged IS NULL AND attendance_group_before IS NULL AND attendance_group_after IS NULL AND state<>'completed')
  OR (attendance_group_proof_version IS NOT NULL AND attendance_group_proof_version=1 AND
   ((state='awaiting_confirmation' AND attendance_group_unchanged IS NOT NULL AND attendance_group_unchanged ~ '^[a-f0-9]{64}$')
    OR (state<>'awaiting_confirmation' AND attendance_group_unchanged IS NULL AND attendance_group_before IS NULL AND attendance_group_after IS NULL)))
 ELSE attendance_group_proof_version IS NULL AND attendance_group_unchanged IS NULL AND attendance_group_before IS NULL AND attendance_group_after IS NULL END);
--> statement-breakpoint
CREATE FUNCTION app._assistant_attendance_group_unchanged(p public.employment) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to((to_jsonb(p)-'attendance_rule_id')::text,'UTF8')),'hex');
$$;
REVOKE ALL ON FUNCTION app._assistant_attendance_group_unchanged(public.employment) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) RENAME TO _assistant_assigned_review_prepare_attendance_previous;
--> statement-breakpoint
CREATE FUNCTION app.assistant_assigned_review_prepare(p_kind text,p_id uuid,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid,p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_kind='attendance.schedule_group.maintain' THEN RAISE EXCEPTION 'Attendance protected prepare required' USING ERRCODE='42501';END IF;
 RETURN app._assistant_assigned_review_prepare_attendance_previous(p_kind,p_id,p_person,p_employment,p_company,p_subject_person,p_subject,p_intent_digest,p_reviewed_digest,p_kid,p_wrapped_dek,p_ciphertext);
END $$;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_prepare_attendance_previous(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_attendance_schedule_group_prepare(p_id uuid,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_target uuid,p_intent text,p_reviewed text,p_kid text,p_wrapped text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original public.employment%ROWTYPE;actual public.employment%ROWTYPE;r app.assistant_own_leave_review%ROWTYPE;expected jsonb;persisted jsonb;unchanged text;ignored jsonb;
BEGIN
 PERFORM app.assistant_attendance_schedule_group_scope(p_employment);
 SELECT * INTO original FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR original.attendance_rule_id IS NOT DISTINCT FROM p_target OR (p_target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.attendance_rule g WHERE g.id=p_target AND g.tenant_id=original.tenant_id)) THEN RAISE EXCEPTION 'Attendance group prepare unavailable' USING ERRCODE='42501';END IF;
 unchanged:=app._assistant_attendance_group_unchanged(original);
 -- Capture BEFORE any ledger/body INSERT trigger can change the retained employment.
 ignored:=app._assistant_assigned_review_prepare_attendance_previous('attendance.schedule_group.maintain',p_id,p_person,p_employment,p_company,p_subject_person,p_employment,p_intent,p_reviewed,p_kid,p_wrapped,p_ciphertext);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='attendance.schedule_group.maintain' FOR UPDATE;
 IF NOT FOUND OR r.state<>'awaiting_confirmation' OR r.person_id IS DISTINCT FROM p_person OR r.employment_id IS DISTINCT FROM p_employment OR r.company_id IS DISTINCT FROM p_company OR r.decision_subject_person_id IS DISTINCT FROM p_subject_person OR r.receipt_subject_kind IS DISTINCT FROM 'employment' OR r.receipt_subject_id IS DISTINCT FROM p_employment OR r.intent_digest IS DISTINCT FROM p_intent OR r.reviewed_digest IS DISTINCT FROM p_reviewed THEN RAISE EXCEPTION 'Attendance group prepare unavailable' USING ERRCODE='42501';END IF;
 expected:=to_jsonb(r)||jsonb_build_object('attendance_group_proof_version',1,'attendance_group_unchanged',unchanged,'attendance_group_before',original.attendance_rule_id,'attendance_group_after',p_target);
 UPDATE app.assistant_own_leave_review SET attendance_group_proof_version=1,attendance_group_unchanged=unchanged,attendance_group_before=original.attendance_rule_id,attendance_group_after=p_target WHERE id=p_id;
 SELECT to_jsonb(q) INTO persisted FROM app.assistant_own_leave_review q WHERE q.id=p_id;
 SELECT * INTO actual FROM public.employment WHERE id=p_employment AND tenant_id=original.tenant_id;
 IF persisted IS DISTINCT FROM expected OR to_jsonb(actual) IS DISTINCT FROM to_jsonb(original)
 OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=p_id AND c.kid=p_kid AND c.wrapped_dek=p_wrapped AND c.ciphertext=p_ciphertext) THEN RAISE EXCEPTION 'Attendance protected prepare changed' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_multi_cycle_run_review_identity(p_person);
 IF clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Attendance prepare expired' USING ERRCODE='42501';END IF;
 RETURN app._assistant_assigned_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_schedule_group_prepare(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_schedule_group_prepare(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_attendance_schedule_group_arm(p_employment uuid,p_before uuid,p_after uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;e public.employment%ROWTYPE;
BEGIN
 PERFORM app.assistant_attendance_schedule_group_scope(p_employment);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='attendance.schedule_group.maintain' AND receipt_subject_id=p_employment AND state='awaiting_confirmation' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.attendance_group_proof_version IS DISTINCT FROM 1 OR r.attendance_group_unchanged IS NULL OR r.attendance_group_before IS DISTINCT FROM p_before OR r.attendance_group_after IS DISTINCT FROM p_after OR clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Attendance group arm unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_multi_cycle_run_review_identity(r.person_id);
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=r.tenant_id;
 IF app._assistant_attendance_group_unchanged(e) IS DISTINCT FROM r.attendance_group_unchanged OR e.attendance_rule_id IS DISTINCT FROM r.attendance_group_before THEN RAISE EXCEPTION 'Attendance protected original changed' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_schedule_group_arm(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_schedule_group_arm(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_attendance_group_after(p app.assistant_own_leave_review,p_event uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment%ROWTYPE;d public.domain_event%ROWTYPE;
BEGIN
 PERFORM app.assistant_attendance_schedule_group_scope(p.employment_id);
 SELECT * INTO e FROM public.employment WHERE id=p.employment_id AND tenant_id=p.tenant_id;
 SELECT * INTO d FROM public.domain_event WHERE id=p_event AND tenant_id=p.tenant_id AND aggregate_type='employment' AND event_type='employment.schedule-group.changed' AND aggregate_id=p.employment_id AND subject_employment_id=p.employment_id AND actor_type='user' AND actor_id=p.user_id;
 IF NOT FOUND OR p.attendance_group_proof_version IS DISTINCT FROM 1 OR p.attendance_group_unchanged IS NULL OR p.attendance_group_before IS NOT DISTINCT FROM p.attendance_group_after
 OR app._assistant_attendance_group_unchanged(e) IS DISTINCT FROM p.attendance_group_unchanged OR e.attendance_rule_id IS DISTINCT FROM p.attendance_group_after
 OR d.payload IS DISTINCT FROM jsonb_build_object('before',p.attendance_group_before,'after',p.attendance_group_after)
 OR NOT EXISTS(SELECT 1 FROM public.employment x JOIN public.domain_event v ON v.id=d.id WHERE x.id=e.id AND x.xmin=pg_current_xact_id()::xid AND v.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'Attendance protected native postimage changed' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_attendance_group_after(app.assistant_own_leave_review,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_attendance_schedule_group_review_current(p_employment uuid,p_event uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app.assistant_attendance_schedule_group_scope(p_employment);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='attendance.schedule_group.maintain' AND receipt_subject_id=p_employment AND state='awaiting_confirmation' FOR UPDATE NOWAIT;
 IF NOT FOUND OR clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Attendance current review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_multi_cycle_run_review_identity(r.person_id);PERFORM app._assistant_attendance_group_after(r,p_event);
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_schedule_group_review_current(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_schedule_group_review_current(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- A boolean ownership guard only, never a payable amount or a new payroll eligibility producer.
-- Mirrors attendanceCoverage/cutOffWindowFor using the SAME assigned-policy/default/company
-- cut-off precedence as app.attendance_payroll_protection_rows. No batch locking from a child trigger.
CREATE FUNCTION app._assistant_attendance_batch_covers(p_employment uuid,p_date date,p_batch jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE config jsonb;company_anchor integer;co jsonb;frequency text;block jsonb;anchor_value jsonb;anchor integer;month_start date;window_start date;window_end date;
BEGIN
 IF p_date IS NULL OR p_batch->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR p_batch->>'status' NOT IN('processed','closed') THEN RETURN false;END IF;
 SELECT CASE WHEN policy.status='active' THEN policy.config ELSE NULL END,cfg.attendance_cut_off_day INTO config,company_anchor
 FROM public.employment e
 LEFT JOIN public.company_payroll_config cfg ON cfg.company_id=(p_batch->>'company_id')::uuid AND cfg.tenant_id=e.tenant_id
 LEFT JOIN public.payroll_policy assigned ON assigned.id=e.payroll_policy_id AND assigned.tenant_id=e.tenant_id AND assigned.company_id=(p_batch->>'company_id')::uuid
 LEFT JOIN public.payroll_policy policy ON policy.id=coalesce(assigned.id,cfg.default_payroll_policy_id) AND policy.tenant_id=e.tenant_id AND policy.company_id=(p_batch->>'company_id')::uuid
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR p_batch->>'pay_period' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN RETURN false;END IF;
 month_start:=((p_batch->>'pay_period')||'-01')::date;co:=config->'cutOff';frequency:=coalesce(config->>'frequency','monthly');
 IF co->>'mode'='custom' AND jsonb_typeof(co->'anchorDay')='number' THEN
  block:=CASE WHEN frequency<>'monthly' THEN co->'perFrequency'->frequency ELSE NULL END;
  anchor_value:=coalesce(nullif(block->'perType'->'attendance','null'::jsonb),nullif(co->'perType'->'attendance','null'::jsonb),nullif(block->'anchorDay','null'::jsonb),co->'anchorDay');
  anchor:=greatest(1,least(28,trunc((anchor_value#>>'{}')::numeric)::integer));
 ELSIF company_anchor IS NOT NULL THEN anchor:=greatest(1,least(28,company_anchor));
 END IF;
 IF anchor IS NULL THEN window_start:=month_start;window_end:=(month_start+interval '1 month')::date-1;
 ELSE window_start:=(month_start-interval '1 month')::date+anchor-1;window_end:=month_start+anchor-2;END IF;
 RETURN p_date BETWEEN window_start AND window_end;
END $$;
REVOKE ALL ON FUNCTION app._assistant_attendance_batch_covers(uuid,date,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Only cutoff/selection and immutable history ID/provenance dependencies; no salary values/content.
CREATE FUNCTION app._assistant_attendance_dependency_rows(p_employment uuid,p_date date) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.employment%ROWTYPE;companies uuid[];records uuid[];company_rows jsonb;history_rows jsonb;snapshots jsonb;revisions jsonb;result jsonb;months text[];
BEGIN
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR p_date IS NULL THEN RAISE EXCEPTION 'Attendance dependencies unavailable' USING ERRCODE='42501';END IF;
 months:=ARRAY[to_char(p_date,'YYYY-MM'),to_char(p_date+interval '1 month','YYYY-MM')];
 SELECT coalesce(array_agg(company_id ORDER BY company_id),'{}'::uuid[]) INTO companies FROM(
  SELECT company_id FROM(
   SELECT e.company_id company_id
   UNION SELECT b.company_id FROM public.payroll_batch b JOIN public.payslip ps ON ps.batch_id=b.id AND ps.tenant_id=b.tenant_id
    WHERE b.tenant_id=e.tenant_id AND ps.employment_id=e.id AND b.status IN('processed','closed') AND b.pay_period=ANY(months)
   UNION SELECT h.company_id FROM public.payroll_history_import_record h WHERE h.tenant_id=e.tenant_id AND h.employment_id=e.id AND h.period=ANY(months)
  ) ids ORDER BY company_id LIMIT 65
 ) bounded;
 IF cardinality(companies)>64 THEN RAISE EXCEPTION 'Review these dependencies natively' USING ERRCODE='54000';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('companyId',c.id,'configId',cfg.id,'assignedPolicyId',assigned.id,'selectedPolicyId',policy.id,
  'usesDefault',assigned.id IS NULL,'companyAnchorUsed',NOT coalesce(policy.status='active' AND policy.config->'cutOff'->>'mode'='custom' AND jsonb_typeof(policy.config->'cutOff'->'anchorDay')='number',false),
  'companyAnchor',CASE WHEN coalesce(policy.status='active' AND policy.config->'cutOff'->>'mode'='custom' AND jsonb_typeof(policy.config->'cutOff'->'anchorDay')='number',false) THEN NULL ELSE cfg.attendance_cut_off_day END,
  'defaultPolicyId',CASE WHEN assigned.id IS NULL THEN cfg.default_payroll_policy_id ELSE NULL END,
  'policyStatus',policy.status,'policyCutOff',CASE WHEN policy.status='active' THEN policy.config->'cutOff' ELSE NULL END,
  'policyFrequency',CASE WHEN policy.status='active' THEN policy.config->'frequency' ELSE NULL END) ORDER BY c.id),'[]'::jsonb) INTO company_rows
 FROM public.company c
 LEFT JOIN public.company_payroll_config cfg ON cfg.company_id=c.id AND cfg.tenant_id=c.tenant_id
 LEFT JOIN public.payroll_policy assigned ON assigned.id=e.payroll_policy_id AND assigned.tenant_id=c.tenant_id AND assigned.company_id=c.id
 LEFT JOIN public.payroll_policy policy ON policy.id=coalesce(assigned.id,cfg.default_payroll_policy_id) AND policy.tenant_id=c.tenant_id AND policy.company_id=c.id
 WHERE c.tenant_id=e.tenant_id AND c.id=ANY(companies);
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO records FROM(
  SELECT h.id FROM public.payroll_history_import_record h WHERE h.tenant_id=e.tenant_id AND h.employment_id=e.id
   AND app._assistant_attendance_batch_covers(e.id,p_date,jsonb_build_object('tenant_id',h.tenant_id,'company_id',h.company_id,'pay_period',h.period,'status','closed'))
  ORDER BY h.id LIMIT 129
 ) bounded;
 IF cardinality(records)>128 OR (SELECT count(*) FROM public.payroll_history_import_snapshot WHERE record_id=ANY(records) AND tenant_id=e.tenant_id)>256
 OR (SELECT count(*) FROM public.payroll_history_import_revision WHERE record_id=ANY(records) AND tenant_id=e.tenant_id)>512 THEN RAISE EXCEPTION 'Review this history natively' USING ERRCODE='54000';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id),'[]'::jsonb) INTO history_rows FROM public.payroll_history_import_record h WHERE h.id=ANY(records) AND h.tenant_id=e.tenant_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',h.id,'tenantId',h.tenant_id,'recordId',h.record_id) ORDER BY h.id),'[]'::jsonb) INTO snapshots FROM public.payroll_history_import_snapshot h WHERE h.record_id=ANY(records) AND h.tenant_id=e.tenant_id;
 SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.record_id,h.ordinal),'[]'::jsonb) INTO revisions FROM public.payroll_history_import_revision h WHERE h.record_id=ANY(records) AND h.tenant_id=e.tenant_id;
 result:=jsonb_build_object('version',1,'employmentId',e.id,'date',p_date,'assignedPolicyId',e.payroll_policy_id,'companies',company_rows,'historyRecords',history_rows,'historySnapshots',snapshots,'historyRevisions',revisions);
 IF octet_length(result::text)>120000 THEN RAISE EXCEPTION 'Review large dependencies natively' USING ERRCODE='54000';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app._assistant_attendance_dependency_rows(uuid,date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_attendance_dependency_digest(p_employment uuid,p_date date) RETURNS text
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(app._assistant_attendance_dependency_rows(p_employment,p_date)::text,'UTF8')),'hex');
$$;
REVOKE ALL ON FUNCTION app._assistant_attendance_dependency_digest(uuid,date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_attendance_completion_assert(p_id uuid,p_old jsonb,p_event uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;expected jsonb;guard oid;proof jsonb;coverage jsonb;closed boolean;
BEGIN
 guard:=to_regprocedure('app._assistant_review_body_pending_parent()')::oid;
 IF guard IS NULL OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='app.assistant_own_leave_review_content'::regclass AND tgfoid=guard AND tgtype=23 AND tgenabled IN('O','A'))
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='app.assistant_own_leave_review_content'::regclass AND tgfoid=guard AND tgtype=21 AND tgenabled IN('O','A')) THEN RAISE EXCEPTION 'Attendance pending-parent guard unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id;
 expected:=p_old||jsonb_build_object('state','completed','intent_digest',NULL,'reviewed_digest',NULL,'receipt_event_id',p_event);
 IF p_old->>'action_kind'='attendance.schedule_group.maintain' THEN expected:=expected||jsonb_build_object('attendance_group_unchanged',NULL,'attendance_group_before',NULL,'attendance_group_after',NULL);
 ELSIF p_old->>'action_kind'='attendance.day_schedule.correct' THEN expected:=expected||jsonb_build_object('attendance_day_dependencies',NULL);END IF;
 IF NOT FOUND OR to_jsonb(r) IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=p_id)
 OR r.tenant_id IS DISTINCT FROM app.current_tenant_id() OR r.user_id IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Attendance completed custody changed' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_multi_cycle_run_review_identity(r.person_id);
 IF r.action_kind='attendance.schedule_group.maintain' THEN
  PERFORM app._assistant_attendance_group_after(jsonb_populate_record(NULL::app.assistant_own_leave_review,p_old),p_event);
 ELSIF r.action_kind='attendance.day_schedule.correct' THEN
  IF p_old->>'attendance_day_proof_version' IS DISTINCT FROM '1' OR p_old->>'attendance_day_dependencies' IS NULL
   OR app._assistant_attendance_dependency_digest(r.employment_id,(to_jsonb(r)->>'day_schedule_date')::date) IS DISTINCT FROM p_old->>'attendance_day_dependencies' THEN RAISE EXCEPTION 'Attendance protected dependencies changed' USING ERRCODE='42501';END IF;
  proof:=app.assistant_attendance_day_schedule_receipt(r.employment_id,(to_jsonb(r)->>'day_schedule_date')::date,p_event,true);
  SELECT coalesce(jsonb_agg(b.id ORDER BY b.id),'[]'::jsonb),coalesce(bool_or(b.status='closed'),false) INTO coverage,closed
   FROM public.payroll_batch b WHERE b.tenant_id=r.tenant_id
    AND app._assistant_attendance_batch_covers(r.employment_id,(to_jsonb(r)->>'day_schedule_date')::date,to_jsonb(b))
    AND EXISTS(SELECT 1 FROM public.payslip ps WHERE ps.batch_id=b.id AND ps.tenant_id=r.tenant_id AND ps.employment_id=r.employment_id AND app.payroll_history_effective(ps.id));
  IF closed OR coverage IS DISTINCT FROM proof->'witness'->'payrollBatchIds' THEN RAISE EXCEPTION 'Attendance final payroll membership changed' USING ERRCODE='42501';END IF;
 ELSE RAISE EXCEPTION 'Attendance completion kind unavailable' USING ERRCODE='42501';END IF;
 IF clock_timestamp()>=(p_old->>'expires_at')::timestamptz THEN RAISE EXCEPTION 'Attendance confirmation expired' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_attendance_completion_assert(uuid,jsonb,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.assistant_assigned_review_complete(uuid,text,text,uuid) RENAME TO _assistant_assigned_review_complete_attendance_previous;
--> statement-breakpoint
CREATE FUNCTION app.assistant_assigned_review_complete(p_id uuid,p_kind text,p_reviewed_digest text,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_row app.assistant_own_leave_review%ROWTYPE;output jsonb;
BEGIN
 IF p_kind<>'attendance.schedule_group.maintain' THEN RETURN app._assistant_assigned_review_complete_attendance_previous(p_id,p_kind,p_reviewed_digest,p_event);END IF;
 PERFORM app._assistant_multi_cycle_run_review_identity(NULL,false);
 SELECT * INTO old_row FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind=p_kind FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Attendance review unavailable' USING ERRCODE='42501';END IF;
 IF old_row.state='awaiting_confirmation' THEN PERFORM app._assistant_attendance_group_after(old_row,p_event);END IF;
 output:=app._assistant_assigned_review_complete_attendance_previous(p_id,p_kind,p_reviewed_digest,p_event);
 IF old_row.state='awaiting_confirmation' THEN PERFORM app._assistant_attendance_completion_assert(p_id,to_jsonb(old_row),p_event);END IF;
 RETURN app._assistant_assigned_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_complete(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_complete(uuid,text,text,uuid) TO ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_complete_attendance_previous(uuid,text,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Pending proof is SQL-owned and immutable after qualification. Scrub only the pending native
-- commitment on terminal transitions, including canonical erasure. Permanent version/receipt identity stays.
--> statement-breakpoint
CREATE FUNCTION app._assistant_attendance_cascade_admitted(p_row app.assistant_own_leave_review) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ref record;key_value uuid;parent_present boolean;body jsonb:=to_jsonb(p_row);
BEGIN
 FOR ref IN SELECT c.confrelid,child.attname child_name,parent.attname parent_name
  FROM pg_constraint c JOIN pg_attribute child ON child.attrelid=c.conrelid AND child.attnum=c.conkey[1]
   JOIN pg_attribute parent ON parent.attrelid=c.confrelid AND parent.attnum=c.confkey[1]
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.contype='f' AND c.confdeltype='c'
   AND cardinality(c.conkey)=1 AND cardinality(c.confkey)=1
 LOOP
  IF body->>ref.child_name IS NULL THEN CONTINUE;END IF;
  -- Never mistake an RLS-hidden parent for an actually absent FK parent.
  IF row_security_active(ref.confrelid) THEN
   RAISE EXCEPTION 'Attendance cascade witness unavailable' USING ERRCODE='42501';END IF;
  key_value:=(body->>ref.child_name)::uuid;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s WHERE %I=$1)',ref.confrelid::regclass,ref.parent_name)
   INTO parent_present USING key_value;
  IF NOT parent_present THEN RETURN true;END IF;
 END LOOP;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app._assistant_attendance_cascade_admitted(app.assistant_own_leave_review) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_attendance_terminal_identity() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_json jsonb:=to_jsonb(OLD);new_json jsonb;keys text[];
BEGIN
 IF OLD.action_kind IN('attendance.schedule_group.maintain','attendance.day_schedule.correct') AND OLD.state='completed' THEN
  IF TG_OP='DELETE' THEN
   -- Actual configured cascading parent absence only, never an erasure/session flag.
   IF NOT app._assistant_attendance_cascade_admitted(OLD) THEN RAISE EXCEPTION 'Attendance completed identity changed' USING ERRCODE='42501';END IF;
  ELSIF to_jsonb(NEW) IS DISTINCT FROM old_json THEN RAISE EXCEPTION 'Attendance completed identity changed' USING ERRCODE='42501';END IF;
 END IF;
 IF TG_OP='DELETE' THEN IF TG_WHEN='AFTER' THEN RETURN NULL;ELSE RETURN OLD;END IF;END IF;
 new_json:=to_jsonb(NEW);
 IF OLD.action_kind='attendance.schedule_group.maintain' AND old_json->>'attendance_group_proof_version'='1' THEN
  keys:=ARRAY['id','action_kind','tenant_id','user_id','person_id','employment_id','company_id','decision_subject_person_id','receipt_subject_kind','receipt_subject_id','attendance_group_proof_version','attendance_group_unchanged','attendance_group_before','attendance_group_after'];
  IF NEW.state='awaiting_confirmation' AND EXISTS(SELECT 1 FROM unnest(keys) AS fields(key) WHERE new_json->fields.key IS DISTINCT FROM old_json->fields.key) THEN RAISE EXCEPTION 'Attendance pending proof immutable' USING ERRCODE='42501';END IF;
 ELSIF OLD.action_kind='attendance.day_schedule.correct' AND old_json->>'attendance_day_proof_version'='1' THEN
  keys:=ARRAY['id','action_kind','tenant_id','user_id','person_id','employment_id','company_id','decision_subject_person_id','receipt_subject_kind','receipt_subject_id','attendance_day_proof_version','attendance_day_dependencies'];
  IF NEW.state='awaiting_confirmation' AND EXISTS(SELECT 1 FROM unnest(keys) AS fields(key) WHERE new_json->fields.key IS DISTINCT FROM old_json->fields.key) THEN RAISE EXCEPTION 'Attendance pending proof immutable' USING ERRCODE='42501';END IF;
 END IF;
 IF NEW.action_kind='attendance.schedule_group.maintain' AND NEW.state<>'awaiting_confirmation' THEN
  IF TG_WHEN='BEFORE' THEN NEW.attendance_group_unchanged:=NULL;NEW.attendance_group_before:=NULL;NEW.attendance_group_after:=NULL;
  ELSIF new_json->>'attendance_group_unchanged' IS NOT NULL OR new_json->>'attendance_group_before' IS NOT NULL OR new_json->>'attendance_group_after' IS NOT NULL THEN RAISE EXCEPTION 'Attendance terminal proof not scrubbed' USING ERRCODE='42501';END IF;
 ELSIF NEW.action_kind='attendance.day_schedule.correct' AND NEW.state<>'awaiting_confirmation' THEN
  IF TG_WHEN='BEFORE' THEN NEW:=jsonb_populate_record(NEW,jsonb_build_object('attendance_day_dependencies',NULL));
  ELSIF new_json->>'attendance_day_dependencies' IS NOT NULL THEN RAISE EXCEPTION 'Attendance terminal proof not scrubbed' USING ERRCODE='42501';END IF;
 END IF;
 IF TG_WHEN='AFTER' THEN RETURN NULL;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_attendance_terminal_identity() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_attendance_terminal_identity BEFORE UPDATE OR DELETE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app._assistant_attendance_terminal_identity();
CREATE TRIGGER assistant_attendance_terminal_identity_after AFTER UPDATE OR DELETE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app._assistant_attendance_terminal_identity();
--> statement-breakpoint
CREATE FUNCTION app._assistant_attendance_dependency_relevant(p_employment uuid,p_date date,p_table text,p_image jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE history jsonb;dependencies jsonb;
BEGIN
 IF p_table='payroll_history_import_record' THEN history:=p_image;
 ELSIF p_table IN('payroll_history_import_snapshot','payroll_history_import_revision') THEN
  SELECT to_jsonb(h) INTO history FROM public.payroll_history_import_record h WHERE h.id=(p_image->>'record_id')::uuid AND h.tenant_id=app.current_tenant_id();
 END IF;
 IF p_table IN('payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision') THEN
  IF history IS NULL OR history->>'employment_id' IS DISTINCT FROM p_employment::text THEN RETURN false;END IF;
  RETURN app._assistant_attendance_batch_covers(p_employment,p_date,jsonb_build_object('tenant_id',history->'tenant_id','company_id',history->'company_id','pay_period',history->'period','status','closed'));
 END IF;
 dependencies:=app._assistant_attendance_dependency_rows(p_employment,p_date);
 IF p_table='payroll_policy' THEN RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(dependencies->'companies') c WHERE c->>'selectedPolicyId'=p_image->>'id');
 ELSIF p_table='company_payroll_config' THEN RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(dependencies->'companies') c WHERE c->>'companyId'=p_image->>'company_id');END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app._assistant_attendance_dependency_relevant(uuid,date,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Existing immutable native event xmin is the completion's root identity. No session switch,
-- extra ledger, private content hash or future-transaction freeze is introduced.
CREATE FUNCTION app._assistant_attendance_root_effect_fence() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE image jsonb;r record;which integer;matches boolean;old_image jsonb;new_image jsonb;company_dep jsonb;
BEGIN
 FOR which IN 1..2 LOOP
  IF (which=1 AND TG_OP='INSERT') OR (which=2 AND TG_OP='DELETE') THEN CONTINUE;END IF;
  image:=CASE WHEN which=1 THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  FOR r IN SELECT q.tenant_id,q.action_kind,q.employment_id,q.user_id,to_jsonb(q)->>'day_schedule_date' AS date,q.receipt_event_id,d.payload
   FROM app.assistant_own_leave_review q JOIN public.domain_event d ON d.id=q.receipt_event_id AND d.tenant_id=q.tenant_id
   WHERE q.tenant_id=(image->>'tenant_id')::uuid AND q.action_kind IN('attendance.schedule_group.maintain','attendance.day_schedule.correct') AND q.state='completed' AND d.xmin=pg_current_xact_id()::xid LOOP
   -- Select roots by actual OLD/NEW row tenant, never by mutable caller context. These
   -- dependency readers use caller tenant internally; refuse before consulting them when
   -- a same-root write targets the protected tenant under a different context. Rows in
   -- genuinely other tenants never select this protected root and remain writable.
   IF r.action_kind='attendance.day_schedule.correct' AND r.tenant_id IS DISTINCT FROM app.current_tenant_id()
    AND TG_TABLE_NAME IN('payroll_batch','payslip','payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision','payroll_policy','company_payroll_config')
   THEN RAISE EXCEPTION 'Attendance completed root tenant context changed' USING ERRCODE='42501';END IF;
   matches:=false;
   IF TG_TABLE_NAME='app_user' THEN matches:=image->>'id'=r.user_id::text;
   ELSIF TG_TABLE_NAME='employment' THEN matches:=image->>'id'=r.employment_id::text;
   ELSIF TG_TABLE_NAME='domain_event' THEN matches:=image->>'id'=r.receipt_event_id::text OR (r.action_kind='attendance.day_schedule.correct' AND coalesce(r.payload->'reviewEffects'->'relatedEventIds','[]'::jsonb) ? (image->>'id'));
   ELSIF r.action_kind='attendance.day_schedule.correct' THEN
    IF TG_TABLE_NAME IN('attendance','attendance_day_adjustment','attendance_punch','attendance_overtime_source') THEN matches:=image->>'employment_id'=r.employment_id::text AND image->>'attendance_date'=r.date;
    ELSIF TG_TABLE_NAME='payroll_batch' THEN
     matches:=coalesce(r.payload->'reviewEffects'->'payrollBatchIds','[]'::jsonb) ? (image->>'id')
      OR (app._assistant_attendance_batch_covers(r.employment_id,r.date::date,image) AND EXISTS(SELECT 1 FROM public.payslip ps WHERE ps.batch_id=(image->>'id')::uuid AND ps.tenant_id=(image->>'tenant_id')::uuid AND ps.employment_id=r.employment_id AND app.payroll_history_effective(ps.id)));
    ELSIF TG_TABLE_NAME='payslip' THEN
     matches:=image->>'employment_id'=r.employment_id::text AND app.payroll_history_effective((image->>'id')::uuid)
      AND (coalesce(r.payload->'reviewEffects'->'payrollBatchIds','[]'::jsonb) ? (image->>'batch_id')
       OR EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=(image->>'batch_id')::uuid AND b.tenant_id=(image->>'tenant_id')::uuid AND app._assistant_attendance_batch_covers(r.employment_id,r.date::date,to_jsonb(b))));
    ELSIF TG_TABLE_NAME IN('payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision') THEN
     matches:=app._assistant_attendance_dependency_relevant(r.employment_id,r.date::date,TG_TABLE_NAME,image);
    ELSIF TG_TABLE_NAME='payroll_policy' THEN
     old_image:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;new_image:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
     IF TG_OP<>'UPDATE' OR jsonb_build_array(old_image->'id',old_image->'tenant_id',old_image->'company_id',old_image->'status',CASE WHEN old_image->>'status'='active' THEN old_image->'config'->'cutOff' END,CASE WHEN old_image->>'status'='active' THEN old_image->'config'->'frequency' END)
      IS DISTINCT FROM jsonb_build_array(new_image->'id',new_image->'tenant_id',new_image->'company_id',new_image->'status',CASE WHEN new_image->>'status'='active' THEN new_image->'config'->'cutOff' END,CASE WHEN new_image->>'status'='active' THEN new_image->'config'->'frequency' END)
     THEN matches:=app._assistant_attendance_dependency_relevant(r.employment_id,r.date::date,TG_TABLE_NAME,image);END IF;
    ELSIF TG_TABLE_NAME='company_payroll_config' THEN
     SELECT entry.value INTO company_dep FROM jsonb_array_elements(app._assistant_attendance_dependency_rows(r.employment_id,r.date::date)->'companies') AS entry(value) WHERE entry.value->>'companyId'=image->>'company_id';
     IF company_dep IS NOT NULL THEN
      old_image:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;new_image:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
      matches:=TG_OP<>'UPDATE' OR jsonb_build_array(old_image->'id',old_image->'tenant_id',old_image->'company_id') IS DISTINCT FROM jsonb_build_array(new_image->'id',new_image->'tenant_id',new_image->'company_id')
       OR (company_dep->>'usesDefault'='true' AND old_image->'default_payroll_policy_id' IS DISTINCT FROM new_image->'default_payroll_policy_id')
       OR (company_dep->>'companyAnchorUsed'='true' AND old_image->'attendance_cut_off_day' IS DISTINCT FROM new_image->'attendance_cut_off_day');
     END IF;
    ELSIF TG_TABLE_NAME='attendance_overtime_calculation' THEN
     matches:=image->>'source_id' IN(r.payload->'reviewEffects'->'before'->'summary'->'pattern'->>'sourceId',r.payload->'reviewEffects'->'after'->'summary'->'pattern'->>'sourceId');
    ELSIF TG_TABLE_NAME IN('attendance_overtime_calculation_evidence','attendance_overtime_policy_part','attendance_overtime_line') THEN
     matches:=image->>'calculation_id' IN(r.payload->'reviewEffects'->'before'->'summary'->'pattern'->>'calculationId',r.payload->'reviewEffects'->'after'->'summary'->'pattern'->>'calculationId');

    END IF;
   END IF;
   IF matches THEN RAISE EXCEPTION 'Attendance completed root effects sealed' USING ERRCODE='42501';END IF;
  END LOOP;
 END LOOP;
 IF TG_WHEN='AFTER' THEN RETURN NULL;ELSIF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_attendance_root_effect_fence() FROM PUBLIC,ai_hr_app;
DO $$ DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['app_user','employment','domain_event','attendance','attendance_day_adjustment','attendance_punch','attendance_overtime_source','attendance_overtime_calculation','attendance_overtime_calculation_evidence','attendance_overtime_policy_part','attendance_overtime_line','payroll_batch','payslip','payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision','payroll_policy','company_payroll_config'] LOOP
  EXECUTE format('CREATE TRIGGER assistant_attendance_root_effect BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app._assistant_attendance_root_effect_fence()',name);
  EXECUTE format('CREATE TRIGGER assistant_attendance_root_effect_after AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app._assistant_attendance_root_effect_fence()',name);
 END LOOP;
END $$;
