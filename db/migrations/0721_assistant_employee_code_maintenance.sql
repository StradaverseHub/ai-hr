-- ADR-0151 personnel parity: one human-reviewed employment employee-code correction.
-- PROVISIONAL SOURCE CLAIM ONLY: 0721 / idx702 / when1793330000050. Reallocate above the
-- then-live accepted ledger at integration freeze. No installation priority or deployment authority.
-- Reuse the one prepared-action ledger and its generic ASSIGNED custody. Every prior kind retains
-- its prior constraints, binding, verifier and receipt behaviour; no historical SQL is edited.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('employees.code.maintain','employees','approve','personnel','employees.code.maintain');
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
 IF matches<>1 THEN RAISE EXCEPTION '0721: unexpected actor subject scope predicate';END IF;
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=constraint_name;
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',constraint_name);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''employees.code.maintain'' THEN employment_id IS NOT NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL ELSE (%s) END)',constraint_name,previous);
END $$;
--> statement-breakpoint
-- Extend the existing HR generic branch itself, preserving its complete predicate. Other dedicated
-- receipt families retain their separate null-column CHECKs from 0622. Refuse unexpected schema drift.
DO $$
DECLARE previous text;generic_columns text;
BEGIN
 SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname='assistant_review_kind_columns' AND c.contype='c';
 IF previous IS NULL OR position('employees.qualification.maintain' in previous)=0 THEN RAISE EXCEPTION '0721: existing generic assigned branch unavailable';END IF;
 -- Evaluate the already accepted generic-column rule for the new kind, preserving all sibling cases.
 generic_columns:=replace(previous,'action_kind','''employees.qualification.maintain''::text');
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK (CASE WHEN action_kind=''employees.code.maintain'' THEN ('||generic_columns||') ELSE ('||previous||') END)';
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
  IF previous IS NULL THEN RAISE EXCEPTION '0721: missing custody constraint %',item.name;END IF;
  added:='CASE WHEN action_kind=''employees.code.maintain'' THEN ('||item.expression||') ELSE ('||previous||') END';
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
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION '0721: missing custody indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''employees.code.maintain''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') OR (action_kind=''employees.code.maintain'' AND receipt_subject_id IS NOT NULL AND state=''awaiting_confirmation'')';
END $$;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_subject_kind(text) RENAME TO _assistant_assigned_review_subject_kind_0721_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_kind='employees.code.maintain' THEN 'employment' ELSE app._assistant_assigned_review_subject_kind_0721_previous(p_kind) END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind_0721_previous(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Scope metadata follows the exact employment company command. Shared-person company policy is not borrowed.
CREATE FUNCTION app.assistant_employee_code_choice_scope(p_employment uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND EXISTS(
  SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
  AND app.access_workforce_command_company(e.company_id) AND NOT EXISTS(SELECT 1 FROM public.app_user a
   WHERE a.id=app.current_user_id() AND a.tenant_id=e.tenant_id AND a.person_id=e.person_id));
$$;
REVOKE ALL ON FUNCTION app.assistant_employee_code_choice_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_employee_code_choice_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_employee_code_scope(p_employment uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.employment%ROWTYPE;projected jsonb;policy_generation text;source_revision text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.assistant_employee_code_choice_scope(p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Employee ID review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO selected FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.assistant_employee_code_choice_scope(p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Employee ID review unavailable' USING ERRCODE='42501';END IF;
 SELECT x.value INTO projected FROM app.access_workforce_list_rows() x(value) WHERE x.value->>'employmentId'=selected.id::text;
 SELECT e.xmin::text,g.generation::text INTO source_revision,policy_generation FROM public.employment e JOIN app.access_profile_write_generation g ON g.tenant_id=e.tenant_id WHERE e.id=selected.id AND e.tenant_id=selected.tenant_id;
 IF projected IS NULL OR policy_generation IS NULL THEN RAISE EXCEPTION 'Employee ID review unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('subjectId',selected.id,'employmentId',selected.id,'companyId',selected.company_id,'subjectPersonId',selected.person_id,
  'employeeName',projected->>'name','employeeCode',selected.employee_code,'companyName',projected->>'company','revision',source_revision,'generation',policy_generation);
END $$;
REVOKE ALL ON FUNCTION app.assistant_employee_code_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_employee_code_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) RENAME TO _assistant_assigned_review_binding_0721_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_assigned_review_binding_0721_previous(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 IF p_kind='employees.code.maintain' AND (p_subject IS DISTINCT FROM p_employment OR app.assistant_employee_code_choice_scope(p_employment) IS NOT TRUE) THEN RAISE EXCEPTION 'Employee ID review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding_0721_previous(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_0721_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();x xid:=pg_current_xact_id()::xid;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u;
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind<>'employees.code.maintain' THEN RETURN app._assistant_generic_review_verify_0721_previous(p_id,p_event);END IF;
 IF r.receipt_subject_kind IS DISTINCT FROM 'employment' OR r.receipt_subject_id IS DISTINCT FROM r.employment_id
  OR app.assistant_employee_code_choice_scope(r.employment_id) IS NOT TRUE THEN RETURN false;END IF;
 -- The employment and native code event are both top-level writes in THIS transaction by THIS login.
 -- The shared Person is ownership metadata only; it is not changed and must not have a current xmin.
 RETURN EXISTS(SELECT 1 FROM public.employment e JOIN public.domain_event d ON d.tenant_id=e.tenant_id AND d.aggregate_id=e.id
  WHERE e.id=r.employment_id AND e.tenant_id=t AND e.person_id=r.decision_subject_person_id AND e.company_id=r.company_id AND e.xmin=x
  AND d.id=p_event AND d.xmin=x AND d.aggregate_type='employment' AND d.event_type='employment.employee-code.set'
  AND d.subject_employment_id=e.id AND d.actor_type='user' AND d.actor_id=u
  AND d.payload->'after'->>'employeeCode'=e.employee_code
  AND d.payload->'before'->'employeeCode' IS DISTINCT FROM d.payload->'after'->'employeeCode');
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify_0721_previous(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_employee_code_receipt(p_employment uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt jsonb;
BEGIN
 IF app.assistant_employee_code_choice_scope(p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Employee ID receipt unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('kind','maintained','subjectId',e.id,'employmentId',e.id,'eventId',d.id,'before',d.payload->'before'->'employeeCode','after',d.payload->'after'->'employeeCode') INTO receipt
 FROM public.employment e JOIN public.domain_event d ON d.aggregate_id=e.id AND d.tenant_id=e.tenant_id
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND d.id=p_event AND d.aggregate_type='employment'
 AND d.subject_employment_id=e.id AND d.event_type='employment.employee-code.set' AND d.actor_type='user' AND d.actor_id=app.current_user_id();
 IF receipt IS NULL THEN RAISE EXCEPTION 'Employee ID receipt unavailable' USING ERRCODE='42501';END IF;RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION app.assistant_employee_code_receipt(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_employee_code_receipt(uuid,uuid) TO ai_hr_app;
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
   replacement:=marker||' WHEN ''employees.code.maintain'' THEN r.receipt_event_id';
  ELSE
   marker:='''employees.qualification.maintain''';replacement:=marker||',''employees.code.maintain''';
  END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0721: unexpected native outcome owner %',target;END IF;
  definition:=replace(definition,marker,replacement);
  IF target='app.native_outcome_completed_review_choices(jsonb)'::regprocedure THEN
   definition:=regexp_replace(definition,'NOT BETWEEN 1 AND [0-9]+','NOT BETWEEN 1 AND (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
   definition:=regexp_replace(definition,'LIMIT [0-9]+','LIMIT (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
  END IF;
  EXECUTE definition;
 END LOOP;
END $$;
