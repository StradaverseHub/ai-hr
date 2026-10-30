-- PROVISIONAL DEVELOPMENT allocation 0747 / idx726 / version7 / when1793330000084.
-- No installation or release authorization. Preserve all predecessor SQL bytes.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('performance.checkin.schedule','performance','approve','personnel','performance.checkin.schedule');
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
 IF matches<>1 THEN RAISE EXCEPTION '0747: unexpected actor subject scope predicate';END IF;
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=constraint_name;
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',constraint_name);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''performance.checkin.schedule'' THEN employment_id IS NOT NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL ELSE (%s) END)',constraint_name,previous);
END $$;
--> statement-breakpoint
-- Extend the existing HR generic branch itself, preserving its complete predicate. Other dedicated
-- receipt families retain their separate null-column CHECKs from 0622. Refuse unexpected schema drift.
DO $$
DECLARE previous text;
BEGIN
 SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname='assistant_review_kind_columns' AND c.contype='c';
 IF previous IS NULL OR position('employees.qualification.maintain' in previous)=0 THEN RAISE EXCEPTION '0747: existing generic assigned branch unavailable';END IF;
 -- Canonical strict generic legacy-column null rule (0670/0671/0677).
 -- Carry the predecessor expression ONCE; copying it into the new branch grows exponentially.
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK (CASE WHEN action_kind=''performance.checkin.schedule'' THEN leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND performance_ack_event_id IS NULL ELSE ('||previous||') END)';
END $$;
--> statement-breakpoint
-- Preserve each remaining prior expression exactly, adding only a branch for this kind.
DO $$
DECLARE item record;previous text;added text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('assistant_review_decision_columns', 'decision_subject_person_id IS NOT NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
  ('assistant_review_generic_receipt', 'receipt_subject_kind=''employment'' AND receipt_subject_id IS NOT NULL AND receipt_subject_id=employment_id AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')
 ) AS requirements(name,expression) LOOP
  SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
   WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname=item.name AND c.contype='c';
  IF previous IS NULL THEN RAISE EXCEPTION '0747: missing custody constraint %',item.name;END IF;
  added:='CASE WHEN action_kind=''performance.checkin.schedule'' THEN ('||item.expression||') ELSE ('||previous||') END';
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (%s)',item.name,added);
 END LOOP;
END $$;
--> statement-breakpoint
-- Distinct creation intents keep their own prospective UUID, including identical employee/date.
-- Exclude only this kind from pending employment uniqueness; retain every predecessor predicate.
DO $$
DECLARE generic_predicate text;assigned_predicate text;
BEGIN
 SELECT pg_get_expr(indpred,indrelid) INTO generic_predicate FROM pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 SELECT pg_get_expr(indpred,indrelid) INTO assigned_predicate FROM pg_index WHERE indexrelid='app.assistant_review_assigned_pending_subject'::regclass;
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION '0747: missing custody indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''performance.checkin.schedule''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') AND action_kind<>''performance.checkin.schedule''';
END $$;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_subject_kind(text) RENAME TO _assistant_assigned_review_subject_kind_0747_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_kind='performance.checkin.schedule' THEN 'employment' ELSE app._assistant_assigned_review_subject_kind_0747_previous(p_kind) END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind_0747_previous(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Prospective identity is private creation intent, not an existing check-in subject.
ALTER TABLE app.assistant_own_leave_review
 ADD COLUMN checkin_schedule_planned_id uuid UNIQUE,
 ADD COLUMN checkin_schedule_date date,
 ADD COLUMN checkin_schedule_manager_id uuid,
 ADD COLUMN checkin_schedule_result_id uuid UNIQUE,
 ADD COLUMN checkin_schedule_birth_hash text,
 ADD COLUMN checkin_schedule_birth_xmin text,
 ADD COLUMN checkin_schedule_birth_xact text;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_checkin_schedule_columns CHECK(
 CASE WHEN action_kind='performance.checkin.schedule' THEN
  checkin_schedule_planned_id IS NOT NULL AND checkin_schedule_date IS NOT NULL
  AND ((checkin_schedule_result_id IS NULL AND checkin_schedule_birth_hash IS NULL AND checkin_schedule_birth_xmin IS NULL AND checkin_schedule_birth_xact IS NULL)
   OR (checkin_schedule_result_id IS NOT NULL AND checkin_schedule_birth_hash IS NOT NULL AND checkin_schedule_birth_xmin IS NOT NULL AND checkin_schedule_birth_xact IS NOT NULL AND checkin_schedule_result_id=checkin_schedule_planned_id AND checkin_schedule_birth_hash ~ '^[a-f0-9]{64}$' AND checkin_schedule_birth_xmin ~ '^[0-9]+$' AND checkin_schedule_birth_xact ~ '^[0-9]+$'))
  AND (state<>'completed' OR checkin_schedule_result_id IS NOT NULL)
 ELSE checkin_schedule_planned_id IS NULL AND checkin_schedule_date IS NULL AND checkin_schedule_manager_id IS NULL AND checkin_schedule_result_id IS NULL AND checkin_schedule_birth_hash IS NULL AND checkin_schedule_birth_xmin IS NULL AND checkin_schedule_birth_xact IS NULL END);
--> statement-breakpoint
-- The same native resolver is used by the pack, preparation and physical birth verification.
-- reporting_line_rls USING is tenant-only (0196); keep that explicit even when this INVOKER
-- function is called by the private SECURITY DEFINER birth trigger. No visibility is broadened.
CREATE FUNCTION app.performance_current_admin_manager(p_tenant uuid,p_subject uuid) RETURNS uuid
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT r.manager_employment_id FROM public.reporting_line r
 WHERE r.tenant_id=p_tenant AND r.tenant_id=app.current_tenant_id() AND r.subordinate_employment_id=p_subject
 AND r.line_type='administrative' AND r.valid_from<=current_date AND (r.valid_to IS NULL OR r.valid_to>current_date)
 AND r.superseded_at IS NULL LIMIT 1;
$$;
REVOKE ALL ON FUNCTION app.performance_current_admin_manager(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.performance_current_admin_manager(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_checkin_schedule_choice_scope(p_employment uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND EXISTS(
 SELECT 1 FROM public.employment e JOIN public.app_user a ON a.id=app.current_user_id() AND a.tenant_id=e.tenant_id
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
 AND (a.person_id IS DISTINCT FROM e.person_id OR EXISTS(SELECT 1 FROM app.current_grants() cg WHERE cg.role='super_admin'))
 AND app.can_see_employment(e.id) AND (app.is_admin() OR (a.person_id IS NOT NULL AND (EXISTS(
 SELECT 1 FROM public.reporting_line r JOIN public.employment m ON m.id=r.manager_employment_id AND m.tenant_id=r.tenant_id
 WHERE r.tenant_id=e.tenant_id AND r.subordinate_employment_id=e.id AND r.line_type='administrative' AND r.superseded_at IS NULL
 AND r.valid_from<=current_date AND (r.valid_to IS NULL OR r.valid_to>current_date) AND m.person_id=a.person_id)
 OR app.can_decide_via_delegation(e.id,NULL,NULL)))));
$$;
REVOKE ALL ON FUNCTION app.assistant_checkin_schedule_choice_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_checkin_schedule_choice_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_checkin_schedule_scope(p_employment uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.assistant_checkin_schedule_choice_scope(p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Scheduling review unavailable' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF app.assistant_checkin_schedule_choice_scope(p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Scheduling review unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('employmentId',e.id,'companyId',e.company_id,'subjectPersonId',e.person_id,'employeeName',p.full_name,'companyName',c.legal_name)
 INTO result FROM public.employment e JOIN public.person p ON (p).id=e.person_id AND (p).tenant_id=e.tenant_id
 JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id();
 IF result IS NULL THEN RAISE EXCEPTION 'Scheduling review unavailable' USING ERRCODE='42501';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.assistant_checkin_schedule_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_checkin_schedule_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) RENAME TO _assistant_assigned_review_binding_0747_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_kind<>'performance.checkin.schedule' THEN PERFORM app._assistant_assigned_review_binding_0747_previous(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);RETURN;END IF;
 PERFORM app._assistant_leave_decision_login(p_person,true);
 IF p_subject IS DISTINCT FROM p_employment OR app.assistant_checkin_schedule_choice_scope(p_employment) IS NOT TRUE OR NOT EXISTS(
 SELECT 1 FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() AND company_id=p_company AND person_id=p_subject_person)
 THEN RAISE EXCEPTION 'Scheduling review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding_0747_previous(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_checkin_schedule_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_set(app._assistant_assigned_review_json(r.id),'{metadata,binding}',
 (app._assistant_assigned_review_json(r.id)#>'{metadata,binding}')||jsonb_build_object('plannedResultId',r.checkin_schedule_planned_id,'scheduledOn',r.checkin_schedule_date,'managerEmploymentId',r.checkin_schedule_manager_id))
 ||jsonb_build_object('checkinResultId',r.checkin_schedule_result_id,'birthCommitment',r.checkin_schedule_birth_hash)
 FROM app.assistant_own_leave_review r WHERE r.id=p_id AND r.action_kind='performance.checkin.schedule';
$$;
REVOKE ALL ON FUNCTION app._assistant_checkin_schedule_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_checkin_schedule_prepare(p_id uuid,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,
 p_planned uuid,p_date date,p_manager uuid,p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app.access_workforce_write_lock();
 PERFORM 1 FROM public.employment WHERE id=p_employment AND tenant_id=t FOR UPDATE;
 PERFORM app._assistant_assigned_review_binding('performance.checkin.schedule',p_person,p_employment,p_company,p_subject_person,p_employment);
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=ANY(ARRAY[p_person,p_subject_person]))
 OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=ANY(ARRAY[p_person,p_subject_person]))
 THEN RAISE EXCEPTION 'Scheduling review unavailable' USING ERRCODE='42501';END IF;
 IF p_manager IS DISTINCT FROM app.performance_current_admin_manager(t,p_employment) OR p_id IS NULL OR p_planned IS NULL OR p_date IS NULL OR EXISTS(SELECT 1 FROM public.performance_checkin WHERE id=p_planned)
 OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$' OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$'
 OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512
 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536
 OR (p_manager IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment WHERE id=p_manager AND tenant_id=t))
 THEN RAISE EXCEPTION 'Scheduling review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5
 OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20
 THEN RAISE EXCEPTION 'Scheduling review unavailable' USING ERRCODE='54000';END IF;
 WITH expired AS (UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL
 WHERE tenant_id=t AND user_id=u AND action_kind='performance.checkin.schedule' AND state='awaiting_confirmation' AND expires_at<=at_time RETURNING id)
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id IN (SELECT id FROM expired);
 INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,decision_subject_person_id,receipt_subject_kind,receipt_subject_id,
 intent_digest,reviewed_digest,state,created_at,expires_at,checkin_schedule_planned_id,checkin_schedule_date,checkin_schedule_manager_id)
 VALUES('performance.checkin.schedule',p_id,t,u,p_person,p_employment,p_company,p_subject_person,'employment',p_employment,p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes',p_planned,p_date,p_manager);
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_checkin_schedule_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_checkin_schedule_prepare(uuid,uuid,uuid,uuid,uuid,uuid,date,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_checkin_schedule_prepare(uuid,uuid,uuid,uuid,uuid,uuid,date,uuid,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Fixed birth fields survive legitimate native notes/status/completed-at updates.
CREATE FUNCTION app._assistant_checkin_schedule_birth_hash(p public.performance_checkin) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(1,(p).id,(p).tenant_id,(p).subject_employment_id,(p).manager_employment_id,(p).scheduled_on,(p).created_by_user_id,
 to_char((p).created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,'UTF8')),'hex');
$$;
REVOKE ALL ON FUNCTION app._assistant_checkin_schedule_birth_hash(public.performance_checkin) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_checkin_schedule_birth() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;observed_xmin text;observed public.performance_checkin;top_id text:=pg_current_xact_id()::text;
BEGIN
 IF TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_RELID<>'public.performance_checkin'::regclass::oid
 THEN RAISE EXCEPTION 'Invalid scheduling birth relation' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE checkin_schedule_planned_id=NEW.id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RETURN NEW;END IF;
 IF r.action_kind<>'performance.checkin.schedule' OR r.state<>'awaiting_confirmation' OR r.expires_at<=clock_timestamp()
 OR r.tenant_id IS DISTINCT FROM app.current_tenant_id() OR r.user_id IS DISTINCT FROM app.current_user_id() OR NEW.tenant_id IS DISTINCT FROM r.tenant_id
 OR NEW.subject_employment_id IS DISTINCT FROM r.employment_id OR NEW.scheduled_on IS DISTINCT FROM r.checkin_schedule_date
 OR NEW.manager_employment_id IS DISTINCT FROM r.checkin_schedule_manager_id OR NEW.created_by_user_id IS DISTINCT FROM r.user_id
 OR NEW.status<>'scheduled' OR NEW.notes IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.created_at IS DISTINCT FROM transaction_timestamp() OR r.checkin_schedule_result_id IS NOT NULL
 THEN RAISE EXCEPTION 'Scheduling birth unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 PERFORM 1 FROM public.employment WHERE id=r.employment_id AND tenant_id=r.tenant_id FOR UPDATE;
 IF NEW.manager_employment_id IS DISTINCT FROM app.performance_current_admin_manager(r.tenant_id,r.employment_id)
 THEN RAISE EXCEPTION 'Scheduling manager changed' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_binding(r.action_kind,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id);
 -- Observe physical INSERT writer immediately. A child subtransaction cannot release and later
 -- UPDATE its tuple to launder xmin into the enclosing top transaction.
 SELECT g.xmin::text INTO observed_xmin FROM public.performance_checkin g WHERE g.id=NEW.id AND g.tenant_id=NEW.tenant_id;
 SELECT g.* INTO observed FROM public.performance_checkin g WHERE g.id=NEW.id AND g.tenant_id=NEW.tenant_id;
 IF observed_xmin IS DISTINCT FROM (pg_current_xact_id()::xid)::text OR to_jsonb(observed) IS DISTINCT FROM to_jsonb(NEW)
 THEN RAISE EXCEPTION 'Scheduling birth writer unavailable' USING ERRCODE='42501';END IF;
 UPDATE app.assistant_own_leave_review SET checkin_schedule_result_id=NEW.id,checkin_schedule_birth_hash=app._assistant_checkin_schedule_birth_hash(NEW),
 checkin_schedule_birth_xmin=observed_xmin,checkin_schedule_birth_xact=top_id WHERE id=r.id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._assistant_checkin_schedule_birth() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_checkin_schedule_birth AFTER INSERT ON public.performance_checkin FOR EACH ROW EXECUTE FUNCTION app._assistant_checkin_schedule_birth();
--> statement-breakpoint
CREATE FUNCTION app._assistant_checkin_schedule_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.action_kind='performance.checkin.schedule' THEN
  IF ROW(NEW.checkin_schedule_planned_id,NEW.checkin_schedule_date,NEW.checkin_schedule_manager_id) IS DISTINCT FROM ROW(OLD.checkin_schedule_planned_id,OLD.checkin_schedule_date,OLD.checkin_schedule_manager_id)
  OR (OLD.checkin_schedule_result_id IS NOT NULL AND ROW(NEW.checkin_schedule_result_id,NEW.checkin_schedule_birth_hash,NEW.checkin_schedule_birth_xmin,NEW.checkin_schedule_birth_xact)
   IS DISTINCT FROM ROW(OLD.checkin_schedule_result_id,OLD.checkin_schedule_birth_hash,OLD.checkin_schedule_birth_xmin,OLD.checkin_schedule_birth_xact))
  THEN RAISE EXCEPTION 'Scheduling identity is immutable' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._assistant_checkin_schedule_immutable() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_checkin_schedule_immutable BEFORE UPDATE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app._assistant_checkin_schedule_immutable();
--> statement-breakpoint
CREATE FUNCTION app._assistant_checkin_schedule_terminal() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.id=NEW.id AND r.action_kind='performance.checkin.schedule' AND r.checkin_schedule_result_id IS NOT NULL AND r.state<>'completed')
 THEN RAISE EXCEPTION 'Scheduling birth must complete atomically' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._assistant_checkin_schedule_terminal() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER assistant_checkin_schedule_terminal AFTER INSERT OR UPDATE ON app.assistant_own_leave_review DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.action_kind='performance.checkin.schedule') EXECUTE FUNCTION app._assistant_checkin_schedule_terminal();
--> statement-breakpoint
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_0747_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;x text:=(pg_current_xact_id()::xid)::text;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id();
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind<>'performance.checkin.schedule' THEN RETURN app._assistant_generic_review_verify_0747_previous(p_id,p_event);END IF;
 IF app.assistant_checkin_schedule_choice_scope(r.employment_id) IS NOT TRUE OR r.checkin_schedule_birth_xact IS DISTINCT FROM pg_current_xact_id()::text OR r.checkin_schedule_birth_xmin IS DISTINCT FROM x THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.performance_checkin g JOIN public.domain_event d ON d.aggregate_id=g.id AND d.tenant_id=g.tenant_id
 WHERE g.id=r.checkin_schedule_result_id AND g.id=r.checkin_schedule_planned_id AND g.tenant_id=r.tenant_id AND g.subject_employment_id=r.employment_id
 AND g.manager_employment_id IS NOT DISTINCT FROM r.checkin_schedule_manager_id AND g.scheduled_on=r.checkin_schedule_date AND g.created_by_user_id=r.user_id
 AND g.status='scheduled' AND g.notes IS NULL AND g.completed_at IS NULL AND g.created_at=transaction_timestamp() AND g.xmin::text=r.checkin_schedule_birth_xmin
 AND app._assistant_checkin_schedule_birth_hash(g)=r.checkin_schedule_birth_hash
 AND d.id=p_event AND d.xmin::text=x AND d.aggregate_type='performance-checkin' AND d.event_type='performance-checkin.scheduled'
 AND d.actor_type='user' AND d.actor_id=r.user_id AND d.subject_employment_id=r.employment_id AND d.payload=jsonb_build_object('scheduledOn',r.checkin_schedule_date::text));
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify_0747_previous(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_checkin_schedule_read(p_id uuid,p_discard boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.assistant_assigned_review_read(p_id,'performance.checkin.schedule',p_discard);RETURN app._assistant_checkin_schedule_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_checkin_schedule_read(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_checkin_schedule_read(uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_checkin_schedule_complete(p_id uuid,p_digest text,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.assistant_assigned_review_complete(p_id,'performance.checkin.schedule',p_digest,p_event);RETURN app._assistant_checkin_schedule_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_checkin_schedule_complete(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_checkin_schedule_complete(uuid,text,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_checkin_schedule_receipt(p_id uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;result jsonb;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='performance.checkin.schedule' AND state='completed' AND receipt_event_id=p_event;
 IF NOT FOUND THEN RAISE EXCEPTION 'Scheduling receipt unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_binding(r.action_kind,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id);
 SELECT jsonb_build_object('kind','scheduled','employmentId',r.employment_id,'checkinId',g.id,'eventId',d.id,'scheduledOn',r.checkin_schedule_date)
 INTO result FROM public.performance_checkin g JOIN public.domain_event d ON d.aggregate_id=g.id AND d.tenant_id=g.tenant_id
 WHERE g.id=r.checkin_schedule_result_id AND g.id=r.checkin_schedule_planned_id AND g.tenant_id=r.tenant_id
 AND g.subject_employment_id=r.employment_id AND g.manager_employment_id IS NOT DISTINCT FROM r.checkin_schedule_manager_id
 AND g.created_by_user_id=r.user_id AND g.scheduled_on=r.checkin_schedule_date AND app._assistant_checkin_schedule_birth_hash(g)=r.checkin_schedule_birth_hash
 AND d.id=p_event AND d.aggregate_type='performance-checkin' AND d.event_type='performance-checkin.scheduled' AND d.actor_type='user' AND d.actor_id=r.user_id
 AND d.subject_employment_id=r.employment_id AND d.payload=jsonb_build_object('scheduledOn',r.checkin_schedule_date::text);
 -- Status/notes/completed_at can legitimately change after the native birth. Recovery never creates.
 IF result IS NULL THEN RAISE EXCEPTION 'Scheduling receipt unavailable' USING ERRCODE='42501';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.assistant_checkin_schedule_receipt(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_checkin_schedule_receipt(uuid,uuid) TO ai_hr_app;

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
   replacement:=marker||' WHEN ''performance.checkin.schedule'' THEN r.receipt_event_id';
  ELSE
   marker:='''employees.qualification.maintain''';replacement:=marker||',''performance.checkin.schedule''';
  END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0747: unexpected native outcome owner %',target;END IF;
  definition:=replace(definition,marker,replacement);
  IF target='app.native_outcome_completed_review_choices(jsonb)'::regprocedure THEN
   definition:=regexp_replace(definition,'NOT BETWEEN 1 AND [0-9]+','NOT BETWEEN 1 AND (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
   definition:=regexp_replace(definition,'LIMIT [0-9]+','LIMIT (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
  END IF;
  EXECUTE definition;
 END LOOP;
END $$;
