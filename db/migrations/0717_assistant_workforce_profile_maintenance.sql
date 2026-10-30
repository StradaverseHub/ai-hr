-- ADR-0151 personnel parity: one human-reviewed shared-person Workforce profile operation.
-- PROVISIONAL SOURCE CLAIM ONLY: 0717 / idx698 / when1793330000046. Reallocate above the
-- then-live accepted ledger at integration freeze. No installation priority or deployment authority.
-- Reuse the one prepared-action ledger and its generic ASSIGNED custody. Every prior kind retains
-- its prior constraints, binding, verifier and receipt behaviour; no historical SQL is edited.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('employees.workforce_profile.maintain','employees','approve','personnel','employees.workforce_profile.maintain');
--> statement-breakpoint
-- Extend the existing HR generic branch itself, preserving its complete predicate. Other dedicated
-- receipt families retain their separate null-column CHECKs from 0622. Refuse unexpected schema drift.
DO $$
DECLARE previous text;generic_columns text;
BEGIN
 SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname='assistant_review_kind_columns' AND c.contype='c';
 IF previous IS NULL OR position('employees.qualification.maintain' in previous)=0 THEN RAISE EXCEPTION '0717: existing generic assigned branch unavailable';END IF;
 -- Evaluate the already accepted generic-column rule for the new kind, preserving all sibling cases.
 generic_columns:=replace(previous,'action_kind','''employees.qualification.maintain''::text');
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK (CASE WHEN action_kind=''employees.workforce_profile.maintain'' THEN ('||generic_columns||') ELSE ('||previous||') END)';
END $$;
--> statement-breakpoint
-- Preserve each remaining prior expression exactly, adding only a branch for this kind.
DO $$
DECLARE item record;previous text;added text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('assistant_review_decision_columns', 'decision_subject_person_id IS NOT NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
  ('assistant_review_generic_receipt', 'receipt_subject_kind=''person'' AND receipt_subject_id=decision_subject_person_id AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')
 ) AS requirements(name,expression) LOOP
  SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
   WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname=item.name AND c.contype='c';
  IF previous IS NULL THEN RAISE EXCEPTION '0717: missing custody constraint %',item.name;END IF;
  added:='CASE WHEN action_kind=''employees.workforce_profile.maintain'' THEN ('||item.expression||') ELSE ('||previous||') END';
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
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION '0717: missing custody indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''employees.workforce_profile.maintain''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') OR (action_kind=''employees.workforce_profile.maintain'' AND receipt_subject_id IS NOT NULL AND state=''awaiting_confirmation'')';
END $$;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_subject_kind(text) RENAME TO _assistant_assigned_review_subject_kind_0717_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_kind='employees.workforce_profile.maintain' THEN 'person'
  ELSE app._assistant_assigned_review_subject_kind_0717_previous(p_kind) END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind_0717_previous(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) RENAME TO _assistant_assigned_review_binding_0717_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_assigned_review_binding_0717_previous(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 IF p_kind='employees.workforce_profile.maintain' AND (p_subject IS DISTINCT FROM p_subject_person
  OR app.access_workforce_command_person(p_employment) IS NOT TRUE) THEN
  RAISE EXCEPTION 'Workforce profile review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding_0717_previous(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_0717_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();x xid:=pg_current_xact_id()::xid;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u;
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind<>'employees.workforce_profile.maintain' THEN RETURN app._assistant_generic_review_verify_0717_previous(p_id,p_event);END IF;
 IF r.receipt_subject_kind IS DISTINCT FROM 'person' OR r.receipt_subject_id IS DISTINCT FROM r.decision_subject_person_id
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=r.employment_id AND e.tenant_id=t AND e.company_id=r.company_id AND e.person_id=r.decision_subject_person_id)
  OR r.person_id IS NOT DISTINCT FROM r.decision_subject_person_id
  OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=r.decision_subject_person_id)
  OR app.access_workforce_command_person(r.employment_id) IS NOT TRUE THEN RETURN false;END IF;
 -- Both native row and event must be written HERE by THIS login for the bound PERSON.
 -- The native event must retain the exact human-selected employment of that person.
 -- A current event alone cannot bless an old/foreign row, a different aggregate, or a wrong state.
 RETURN EXISTS(SELECT 1 FROM public.person p JOIN public.domain_event d ON d.aggregate_id=p.id AND d.tenant_id=p.tenant_id
  JOIN app.access_workforce_value_intent i ON i.event_id=d.id AND i.tenant_id=d.tenant_id AND i.user_id=d.actor_id
  WHERE p.tenant_id=t AND p.id=r.decision_subject_person_id AND p.xmin=x AND d.id=p_event AND d.xmin=x
   AND d.aggregate_type='person' AND d.event_type='person.updated' AND d.subject_employment_id=r.employment_id
   AND d.payload->>'via'='workforce-maintenance' AND d.actor_type='user' AND d.actor_id=u
   AND i.xact_id=pg_current_xact_id() AND i.kind='person' AND i.row_id=p.id AND i.employment_id=r.employment_id
   AND i.after_hash=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'));

END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify_0717_previous(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Native purpose metadata. Person ownership remains server-only; no raw Person grant is added.
CREATE FUNCTION app.assistant_workforce_profile_choice_scope(p_employment uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.current_user_id() IS NOT NULL AND app.principal_snapshot_current()
  AND app.access_workforce_command_person(p_employment) AND EXISTS(SELECT 1 FROM public.employment e
   WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM public.app_user u
    WHERE u.id=app.current_user_id() AND u.tenant_id=e.tenant_id AND u.person_id=e.person_id)) THEN 'true'::jsonb END;
$$;
REVOKE ALL ON FUNCTION app.assistant_workforce_profile_choice_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_workforce_profile_choice_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_workforce_profile_scope(p_employment uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.employment%ROWTYPE;projected jsonb;fingerprint text;policy_generation text;
BEGIN
 IF app.assistant_workforce_profile_choice_scope(p_employment) IS NULL THEN RAISE EXCEPTION 'Profile review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO selected FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 projected:=app.access_workforce_record(p_employment)->'employment';IF projected IS NULL THEN RAISE EXCEPTION 'Profile review unavailable' USING ERRCODE='42501';END IF;
 SELECT g.generation::text INTO policy_generation FROM app.access_profile_write_generation g WHERE g.tenant_id=selected.tenant_id;
 IF policy_generation IS NULL THEN RAISE EXCEPTION 'Profile policy unavailable' USING ERRCODE='42501';END IF;
 SELECT md5(coalesce(string_agg(e.id::text||':'||e.company_id::text||':'||e.xmin::text,',' ORDER BY e.id),'')||':'||policy_generation) INTO fingerprint FROM public.employment e WHERE e.person_id=selected.person_id AND e.tenant_id=selected.tenant_id;
 RETURN jsonb_build_object('personId',selected.person_id,'companyId',selected.company_id,'employeeName',projected->>'name','employeeCode',projected->>'employeeCode','companyName',projected->>'company','scopeDigest',fingerprint);
END $$;
REVOKE ALL ON FUNCTION app.assistant_workforce_profile_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_workforce_profile_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Own selected employment and shared Person before the preview savepoint. The helper returns no
-- private row data and follows native access -> selected employment -> Person lock order.
CREATE FUNCTION app.assistant_workforce_profile_lock(p_employment uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.employment%ROWTYPE;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.assistant_workforce_profile_choice_scope(p_employment) IS NULL THEN RAISE EXCEPTION 'Profile review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO selected FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Profile review unavailable' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.person WHERE id=selected.person_id AND tenant_id=selected.tenant_id FOR UPDATE;
 IF NOT FOUND OR app.assistant_workforce_profile_choice_scope(p_employment) IS NULL THEN RAISE EXCEPTION 'Profile review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.assistant_workforce_profile_lock(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_workforce_profile_lock(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Returns only the exact current native command event. Subtransaction preview is supported through
-- the native intent's top-level xid and full after-state hash; ledger completion also requires outer xmin.
CREATE FUNCTION app.assistant_workforce_profile_current_event(p_employment uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE reference uuid;found_count integer;
BEGIN
 IF app.assistant_workforce_profile_choice_scope(p_employment) IS NULL THEN RAISE EXCEPTION 'Profile effect unavailable' USING ERRCODE='42501';END IF;
 SELECT min(i.event_id::text)::uuid,count(*) INTO reference,found_count FROM app.access_workforce_value_intent i
  JOIN public.employment e ON e.id=i.employment_id AND e.tenant_id=i.tenant_id JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
  JOIN public.domain_event d ON d.id=i.event_id AND d.tenant_id=i.tenant_id AND d.aggregate_id=p.id
  WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id()
   AND i.employment_id=p_employment AND i.kind='person' AND i.row_id=p.id AND i.audit_root=p.id AND i.event_type='person.updated'
   AND i.after_hash=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
   AND d.event_type='person.updated' AND d.aggregate_type='person' AND d.payload->>'via'='workforce-maintenance'
   AND d.subject_employment_id=e.id AND d.actor_type='user' AND d.actor_id=i.user_id;
 IF found_count<>1 THEN RAISE EXCEPTION 'Profile effect unavailable' USING ERRCODE='42501';END IF;RETURN reference;
END $$;
REVOKE ALL ON FUNCTION app.assistant_workforce_profile_current_event(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_workforce_profile_current_event(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_workforce_profile_receipt(p_employment uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.assistant_workforce_profile_choice_scope(p_employment) IS NULL OR NOT EXISTS(SELECT 1 FROM public.employment e
  JOIN public.domain_event d ON d.aggregate_id=e.person_id AND d.tenant_id=e.tenant_id WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
   AND d.id=p_event AND d.aggregate_type='person' AND d.event_type='person.updated' AND d.subject_employment_id=e.id
   AND d.payload->>'via'='workforce-maintenance' AND d.actor_type='user' AND d.actor_id=app.current_user_id()) THEN RAISE EXCEPTION 'Profile receipt unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('kind','maintained','subjectId',p_employment,'employmentId',p_employment,'eventId',p_event,'sharedPerson',true);
END $$;
REVOKE ALL ON FUNCTION app.assistant_workforce_profile_receipt(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_workforce_profile_receipt(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_workforce_profile_review_subject(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='employees.workforce_profile.maintain';
 IF NOT FOUND THEN RAISE EXCEPTION 'Profile review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_binding(r.action_kind,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id);
 RETURN jsonb_build_object('employmentId',r.employment_id,'personId',r.decision_subject_person_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_workforce_profile_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_workforce_profile_review_subject(uuid) TO ai_hr_app;
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
   replacement:=marker||' WHEN ''employees.workforce_profile.maintain'' THEN r.receipt_event_id';
  ELSE
   marker:='''employees.qualification.maintain''';replacement:=marker||',''employees.workforce_profile.maintain''';
  END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0717: unexpected native outcome owner %',target;END IF;
  definition:=replace(definition,marker,replacement);
  IF target='app.native_outcome_completed_review_choices(jsonb)'::regprocedure THEN
   definition:=regexp_replace(definition,'NOT BETWEEN 1 AND [0-9]+','NOT BETWEEN 1 AND (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
   definition:=regexp_replace(definition,'LIMIT [0-9]+','LIMIT (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
  END IF;
  EXECUTE definition;
 END LOOP;
END $$;
