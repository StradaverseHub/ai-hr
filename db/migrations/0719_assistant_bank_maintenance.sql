-- ADR-0151 personnel parity: one human-reviewed shared-person bank destination operation.
-- PROVISIONAL SOURCE CLAIM ONLY: 0719 / idx700 / when1793330000048. Reallocate above the
-- then-live accepted ledger at integration freeze. No installation priority or deployment authority.
-- Reuse the one prepared-action ledger and its generic ASSIGNED custody. Every prior kind retains
-- its prior constraints, binding, verifier and receipt behaviour; no historical SQL is edited.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('employees.bank.maintain','employees','approve','personnel','employees.bank.maintain');
--> statement-breakpoint
-- Extend the existing HR generic branch itself, preserving its complete predicate. Other dedicated
-- receipt families retain their separate null-column CHECKs from 0622. Refuse unexpected schema drift.
DO $$
DECLARE previous text;generic_columns text;
BEGIN
 SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname='assistant_review_kind_columns' AND c.contype='c';
 IF previous IS NULL OR position('employees.qualification.maintain' in previous)=0 THEN RAISE EXCEPTION '0719: existing generic assigned branch unavailable';END IF;
 -- Evaluate the already accepted generic-column rule for the new kind, preserving all sibling cases.
 generic_columns:=replace(previous,'action_kind','''employees.qualification.maintain''::text');
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK (CASE WHEN action_kind=''employees.bank.maintain'' THEN ('||generic_columns||') ELSE ('||previous||') END)';
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
  IF previous IS NULL THEN RAISE EXCEPTION '0719: missing custody constraint %',item.name;END IF;
  added:='CASE WHEN action_kind=''employees.bank.maintain'' THEN ('||item.expression||') ELSE ('||previous||') END';
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (%s)',item.name,added);
 END LOOP;
END $$;
--> statement-breakpoint
-- One pending review per employment PER ADMINISTRATOR, preserving every previous index predicate.
DO $$
DECLARE generic_predicate text;assigned_predicate text;
BEGIN
 SELECT pg_get_expr(indpred,indrelid) INTO generic_predicate FROM pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 SELECT pg_get_expr(indpred,indrelid) INTO assigned_predicate FROM pg_index WHERE indexrelid='app.assistant_review_assigned_pending_subject'::regclass;
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION '0719: missing custody indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''employees.bank.maintain''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') OR (action_kind=''employees.bank.maintain'' AND receipt_subject_id IS NOT NULL AND state=''awaiting_confirmation'')';
END $$;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_subject_kind(text) RENAME TO _assistant_assigned_review_subject_kind_0719_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_kind='employees.bank.maintain' THEN 'person'
  ELSE app._assistant_assigned_review_subject_kind_0719_previous(p_kind) END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind_0719_previous(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) RENAME TO _assistant_assigned_review_binding_0719_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_assigned_review_binding_0719_previous(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 IF p_kind='employees.bank.maintain' AND (p_subject IS DISTINCT FROM p_subject_person
  OR app.is_admin() IS NOT TRUE OR app.access_workforce_person(p_subject_person,'workforce.maintain') IS NOT TRUE OR app.can_admin_payroll_employment(p_employment) IS NOT TRUE) THEN
  RAISE EXCEPTION 'Bank review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding_0719_previous(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_0719_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();x xid:=pg_current_xact_id()::xid;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u;
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind<>'employees.bank.maintain' THEN RETURN app._assistant_generic_review_verify_0719_previous(p_id,p_event);END IF;
 IF r.receipt_subject_kind IS DISTINCT FROM 'person' OR r.receipt_subject_id IS DISTINCT FROM r.decision_subject_person_id
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=r.employment_id AND e.tenant_id=t AND e.company_id=r.company_id AND e.person_id=r.decision_subject_person_id)
  OR r.person_id IS NOT DISTINCT FROM r.decision_subject_person_id
  OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=r.decision_subject_person_id)
  OR app.is_admin() IS NOT TRUE OR app.access_workforce_person(r.decision_subject_person_id,'workforce.maintain') IS NOT TRUE OR app.can_admin_payroll_employment(r.employment_id) IS NOT TRUE THEN RETURN false;END IF;
 -- Both native row and event must be written HERE by THIS login for the bound PERSON.
 -- The native event may use another employment of that same person.
 -- A current event alone cannot bless an old/foreign row, a different aggregate, or a wrong state.
 RETURN EXISTS(SELECT 1 FROM public.employee_statutory_my q JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
  JOIN public.employment event_employment ON event_employment.id=d.subject_employment_id AND event_employment.tenant_id=d.tenant_id AND event_employment.person_id=q.person_id
  WHERE q.tenant_id=t AND q.person_id=r.decision_subject_person_id AND q.xmin=x AND d.id=p_event AND d.xmin=x
   AND d.aggregate_type='employee-statutory' AND d.actor_type='user' AND d.actor_id=u
   AND d.event_type='employee.bank.updated' AND d.payload->>'personId'=q.person_id::text
   AND d.payload->'after'=jsonb_build_object('bankName',q.bank_name,'bankAccountNo',q.bank_account_no,'enableCustomHolderName',q.enable_custom_holder_name,'customHolderName',q.custom_holder_name,'enableCustomHolderId',q.enable_custom_holder_id,'customHolderId',q.custom_holder_id));

END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify_0719_previous(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Shared-person metadata nomination. No HR field values or other-company identifiers leave this owner.
CREATE FUNCTION app.assistant_bank_maintenance_scope(p_employment uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment%ROWTYPE;fingerprint text;company_ids uuid[];country text;
BEGIN
 IF app.current_user_id() IS NULL OR NOT app.principal_snapshot_current() OR app.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Bank review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.access_workforce_person(e.person_id,'workforce.maintain') IS NOT TRUE
  OR EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=e.tenant_id AND u.person_id=e.person_id)
  OR EXISTS(SELECT 1 FROM public.employment m JOIN public.company c ON c.id=m.company_id AND c.tenant_id=m.tenant_id WHERE m.tenant_id=e.tenant_id AND m.person_id=e.person_id AND (c.country<>'MY' OR app.is_admin_for(c.id) IS NOT TRUE OR app.can_admin_payroll_employment(m.id) IS NOT TRUE))
 THEN RAISE EXCEPTION 'Bank review unavailable' USING ERRCODE='42501';END IF;
 SELECT md5(coalesce(string_agg(m.id::text||':'||m.xmin::text||':'||c.id::text||':'||c.xmin::text,',' ORDER BY m.id),'')),array_agg(DISTINCT c.id ORDER BY c.id)
 INTO fingerprint,company_ids FROM public.employment m JOIN public.company c ON c.id=m.company_id AND c.tenant_id=m.tenant_id WHERE m.tenant_id=e.tenant_id AND m.person_id=e.person_id;
 SELECT c.country INTO country FROM public.company c WHERE c.id=e.company_id AND c.tenant_id=e.tenant_id;
 RETURN jsonb_build_object('personId',e.person_id,'companyId',e.company_id,'country',country,'companyIds',company_ids,'scopeDigest',fingerprint||':'||coalesce((SELECT a.revision::text FROM public.access_configuration a WHERE a.tenant_id=e.tenant_id),''));
END $$;
REVOKE ALL ON FUNCTION app.assistant_bank_maintenance_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_bank_maintenance_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_bank_maintenance_review_subject(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='employees.bank.maintain';
 IF NOT FOUND THEN RAISE EXCEPTION 'Bank review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_binding(r.action_kind,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id);
 RETURN jsonb_build_object('employmentId',r.employment_id,'personId',r.decision_subject_person_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_bank_maintenance_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_bank_maintenance_review_subject(uuid) TO ai_hr_app;
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
   replacement:=marker||' WHEN ''employees.bank.maintain'' THEN r.receipt_event_id';
  ELSE
   marker:='''employees.qualification.maintain''';replacement:=marker||',''employees.bank.maintain''';
  END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0719: unexpected native outcome owner %',target;END IF;
  definition:=replace(definition,marker,replacement);
  IF target='app.native_outcome_completed_review_choices(jsonb)'::regprocedure THEN
   bound:=substring(definition from 'NOT BETWEEN 1 AND ([0-9]+)');
   IF bound IS NOT NULL THEN
    definition:=replace(definition,'NOT BETWEEN 1 AND '||bound,'NOT BETWEEN 1 AND (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)');
   ELSIF position('NOT BETWEEN 1 AND (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)' in definition)=0 THEN
    RAISE EXCEPTION '0719: outcome choices bound unavailable';
   END IF;
  END IF;
  EXECUTE definition;
 END LOOP;
END $$;
