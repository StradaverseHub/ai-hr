-- ADR-0151 personnel parity: one human-reviewed ordinary employment document metadata operation.
-- PROVISIONAL SOURCE CLAIM ONLY: 0720 / idx701 / when1793330000049. Reallocate above the
-- then-live accepted ledger at integration freeze. No installation priority or deployment authority.
-- Reuse the one prepared-action ledger and its generic ASSIGNED custody. Every prior kind retains
-- its prior constraints, binding, verifier and receipt behaviour; no historical SQL is edited.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('employees.document_metadata.maintain','employees','approve','personnel','employees.document_metadata.maintain');
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
 IF matches<>1 THEN RAISE EXCEPTION '0720: unexpected actor subject scope predicate';END IF;
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=constraint_name;
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',constraint_name);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''employees.document_metadata.maintain'' THEN employment_id IS NOT NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL ELSE (%s) END)',constraint_name,previous);
END $$;
--> statement-breakpoint
-- Extend the existing HR generic branch itself, preserving its complete predicate. Other dedicated
-- receipt families retain their separate null-column CHECKs from 0622. Refuse unexpected schema drift.
DO $$
DECLARE previous text;generic_columns text;
BEGIN
 SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname='assistant_review_kind_columns' AND c.contype='c';
 IF previous IS NULL OR position('employees.qualification.maintain' in previous)=0 THEN RAISE EXCEPTION '0720: existing generic assigned branch unavailable';END IF;
 -- Evaluate the already accepted generic-column rule for the new kind, preserving all sibling cases.
 generic_columns:=replace(previous,'action_kind','''employees.qualification.maintain''::text');
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK (CASE WHEN action_kind=''employees.document_metadata.maintain'' THEN ('||generic_columns||') ELSE ('||previous||') END)';
END $$;
--> statement-breakpoint
-- Preserve each remaining prior expression exactly, adding only a branch for this kind.
DO $$
DECLARE item record;previous text;added text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('assistant_review_decision_columns', 'decision_subject_person_id IS NOT NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
  ('assistant_review_generic_receipt', 'receipt_subject_kind=''employee_document'' AND receipt_subject_id IS NOT NULL AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')
 ) AS requirements(name,expression) LOOP
  SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
   WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname=item.name AND c.contype='c';
  IF previous IS NULL THEN RAISE EXCEPTION '0720: missing custody constraint %',item.name;END IF;
  added:='CASE WHEN action_kind=''employees.document_metadata.maintain'' THEN ('||item.expression||') ELSE ('||previous||') END';
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
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION '0720: missing custody indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''employees.document_metadata.maintain''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') OR (action_kind=''employees.document_metadata.maintain'' AND receipt_subject_id IS NOT NULL AND state=''awaiting_confirmation'')';
END $$;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_subject_kind(text) RENAME TO _assistant_assigned_review_subject_kind_0720_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_kind='employees.document_metadata.maintain' THEN 'employee_document'
  ELSE app._assistant_assigned_review_subject_kind_0720_previous(p_kind) END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind_0720_previous(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) RENAME TO _assistant_assigned_review_binding_0720_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_assigned_review_binding_0720_previous(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 IF p_kind='employees.document_metadata.maintain' AND (app.is_admin() IS NOT TRUE
  OR app.access_workforce_employment(p_employment,'workforce.maintain') IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.employee_document q WHERE q.id=p_subject AND q.tenant_id=app.current_tenant_id() AND q.employment_id=p_employment AND q.letter_artifact_id IS NULL)) THEN
  RAISE EXCEPTION 'Document metadata review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding_0720_previous(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_0720_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();x xid:=pg_current_xact_id()::xid;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u;
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind<>'employees.document_metadata.maintain' THEN RETURN app._assistant_generic_review_verify_0720_previous(p_id,p_event);END IF;
 IF r.receipt_subject_kind IS DISTINCT FROM 'employee_document' OR r.receipt_subject_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=r.employment_id AND e.tenant_id=t AND e.company_id=r.company_id AND e.person_id=r.decision_subject_person_id)
  OR r.person_id IS NOT DISTINCT FROM r.decision_subject_person_id
  OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=r.decision_subject_person_id)
  OR app.is_admin() IS NOT TRUE OR app.access_workforce_employment(r.employment_id,'workforce.maintain') IS NOT TRUE THEN RETURN false;END IF;
 -- Description is intentionally absent from the ordinary audit payload. Its exact persisted value
 -- is covered by the native SQL UPDATE RETURNING hash of the closed three-field after-state.
 RETURN EXISTS(SELECT 1 FROM public.employee_document q JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
  WHERE q.id=r.receipt_subject_id AND q.tenant_id=t AND q.employment_id=r.employment_id AND q.letter_artifact_id IS NULL
   AND q.xmin=x AND q.updated_by_user_id=u AND d.id=p_event AND d.xmin=x AND d.aggregate_type='employee-document'
   AND d.event_type='employee-document.updated' AND d.subject_employment_id=q.employment_id AND d.actor_type='user' AND d.actor_id=u
   AND d.payload->>'title'=q.title AND d.payload->'category'=coalesce(to_jsonb(q.category),'null'::jsonb)
   AND d.payload->>'metadataAfterHash'=encode(sha256(convert_to(jsonb_build_object('title',q.title,'category',q.category,'description',q.description)::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify_0720_previous(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Stored-employment metadata nomination. No HR field values or other-company identifiers leave this owner.
CREATE FUNCTION app.assistant_document_metadata_scope(p_document uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.employee_document%ROWTYPE;e public.employment%ROWTYPE;fingerprint text;
BEGIN
 IF app.current_user_id() IS NULL OR NOT app.principal_snapshot_current() OR app.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Document metadata review unavailable' USING ERRCODE='42501';END IF;
 -- Nomination reads only identity; do not load the bytea row or private title/description to resolve authority.
 SELECT d.employment_id,d.letter_artifact_id INTO q.employment_id,q.letter_artifact_id FROM public.employee_document d WHERE d.id=p_document AND d.tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RAISE EXCEPTION 'Document metadata review unavailable' USING ERRCODE='42501';END IF;
 SELECT id,tenant_id,person_id,company_id INTO e.id,e.tenant_id,e.person_id,e.company_id FROM public.employment WHERE id=q.employment_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.access_workforce_employment(e.id,'workforce.maintain') IS NOT TRUE OR q.letter_artifact_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=e.tenant_id AND a.person_id=e.person_id)
 THEN RAISE EXCEPTION 'Document metadata review unavailable' USING ERRCODE='42501';END IF;
 SELECT md5(current_employment.xmin::text||':'||c.xmin::text||':'||coalesce(a.revision::text,'')) INTO fingerprint FROM public.employment current_employment JOIN public.company c ON c.id=current_employment.company_id AND c.tenant_id=current_employment.tenant_id LEFT JOIN public.access_configuration a ON a.tenant_id=c.tenant_id WHERE current_employment.id=e.id AND current_employment.tenant_id=e.tenant_id;
 RETURN jsonb_build_object('employmentId',e.id,'personId',e.person_id,'companyId',e.company_id,'scopeDigest',fingerprint);
END $$;
REVOKE ALL ON FUNCTION app.assistant_document_metadata_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_document_metadata_scope(uuid) TO ai_hr_app;
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
   replacement:=marker||' WHEN ''employees.document_metadata.maintain'' THEN r.receipt_event_id';
  ELSE
   marker:='''employees.qualification.maintain''';replacement:=marker||',''employees.document_metadata.maintain''';
  END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0720: unexpected native outcome owner %',target;END IF;
  definition:=replace(definition,marker,replacement);
  IF target='app.native_outcome_completed_review_choices(jsonb)'::regprocedure THEN
   bound:=substring(definition from 'NOT BETWEEN 1 AND ([0-9]+)');
   IF bound IS NOT NULL THEN
    definition:=replace(definition,'NOT BETWEEN 1 AND '||bound,'NOT BETWEEN 1 AND (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)');
   ELSIF position('NOT BETWEEN 1 AND (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)' in definition)=0 THEN
    RAISE EXCEPTION '0720: outcome choices bound unavailable';
   END IF;
  END IF;
  EXECUTE definition;
 END LOOP;
END $$;
