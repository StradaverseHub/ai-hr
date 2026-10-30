-- Coordinator-allocated provisional DEVELOPMENT slot0732 / idx712 / when1793330000069.
-- UNAPPLIED SOURCE ONLY; reallocate above accepted ledger before installation. No release authority.
-- Preserve every historical SQL byte. Closed reasoned rejection custody; no field/photo/evidence effect.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('employees.profile_request.reject','employees','approve','personnel','employees.profile_request.reject');
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
 IF matches<>1 THEN RAISE EXCEPTION 'profile-rejection: unexpected actor subject scope predicate';END IF;
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=constraint_name;
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',constraint_name);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''employees.profile_request.reject'' THEN employment_id IS NOT NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL ELSE (%s) END)',constraint_name,previous);
END $$;
--> statement-breakpoint
-- Extend the existing HR generic branch itself, preserving its complete predicate. Other dedicated
-- receipt families retain their separate null-column CHECKs from 0622. Refuse unexpected schema drift.
DO $$
DECLARE previous text;generic_columns text;
BEGIN
 SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname='assistant_review_kind_columns' AND c.contype='c';
 IF previous IS NULL OR position('employees.qualification.maintain' in previous)=0 THEN RAISE EXCEPTION 'profile-rejection: existing generic assigned branch unavailable';END IF;
 -- Evaluate the already accepted generic-column rule for the new kind, preserving all sibling cases.
 generic_columns:=replace(previous,'action_kind','''employees.qualification.maintain''::text');
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK (CASE WHEN action_kind=''employees.profile_request.reject'' THEN ('||generic_columns||') ELSE ('||previous||') END)';
END $$;
--> statement-breakpoint
-- Preserve each remaining prior expression exactly, adding only a branch for this kind.
DO $$
DECLARE item record;previous text;added text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('assistant_review_decision_columns', 'decision_subject_person_id IS NOT NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
  ('assistant_review_generic_receipt', 'receipt_subject_kind=''profile_change_request'' AND receipt_subject_id IS NOT NULL AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')
 ) AS requirements(name,expression) LOOP
  SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
   WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname=item.name AND c.contype='c';
  IF previous IS NULL THEN RAISE EXCEPTION 'profile-rejection: missing custody constraint %',item.name;END IF;
  added:='CASE WHEN action_kind=''employees.profile_request.reject'' THEN ('||item.expression||') ELSE ('||previous||') END';
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (%s)',item.name,added);
 END LOOP;
END $$;
--> statement-breakpoint
-- One pending review per selected request PER CALLER, preserving every previous index predicate.
DO $$
DECLARE generic_predicate text;assigned_predicate text;
BEGIN
 SELECT pg_get_expr(indpred,indrelid) INTO generic_predicate FROM pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 SELECT pg_get_expr(indpred,indrelid) INTO assigned_predicate FROM pg_index WHERE indexrelid='app.assistant_review_assigned_pending_subject'::regclass;
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION 'profile-rejection: missing custody indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''employees.profile_request.reject''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') OR (action_kind=''employees.profile_request.reject'' AND receipt_subject_id IS NOT NULL AND state=''awaiting_confirmation'')';
END $$;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_subject_kind(text) RENAME TO _assistant_assigned_review_subject_kind_pr_reject_prev;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_kind='employees.profile_request.reject' THEN 'profile_change_request' ELSE app._assistant_assigned_review_subject_kind_pr_reject_prev(p_kind) END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind_pr_reject_prev(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Boolean witness delegates current native HR, company, named-route, effective-context and tenant narrowing.
CREATE FUNCTION app.assistant_profile_rejection_scope(p_request uuid) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.profile_change_request%ROWTYPE;
BEGIN
 IF app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR app.is_admin() IS NOT TRUE THEN RETURN false;END IF;
 SELECT * INTO q FROM public.profile_change_request WHERE id=p_request AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR q.status NOT IN('pending','rejected') OR app.is_self_person(q.person_id)
  OR app.profile_request_assignee(q.id) IS NOT TRUE OR app.access_profile_review_permitted(q.employment_id) IS NOT TRUE THEN RETURN false;END IF;
 IF jsonb_typeof(q.proposed) IS DISTINCT FROM 'object' OR octet_length(q.proposed::text)>65536
  OR EXISTS(SELECT 1 FROM public.profile_change_attachment a WHERE a.request_id=q.id AND a.tenant_id=q.tenant_id) THEN RETURN false;END IF;
 IF q.proposed ? 'v' THEN
  IF q.proposed->'v' IS DISTINCT FROM '2'::jsonb OR jsonb_typeof(q.proposed->'fields') IS DISTINCT FROM 'array'
   OR jsonb_typeof(q.proposed->'registers') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(q.proposed->'registers')<>0 OR jsonb_array_length(q.proposed->'fields') NOT BETWEEN 1 AND 32 THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(q.proposed->'fields') f WHERE NOT EXISTS(SELECT 1 FROM app.access_profile_value_bindings() b WHERE b.field_id=f->>'fieldId' AND b.owner NOT IN('dependent','qualification','emergency'))) THEN RETURN false;END IF;
 ELSE
  IF (SELECT count(*) FROM jsonb_object_keys(q.proposed)) NOT BETWEEN 1 AND 32 OR EXISTS(SELECT 1 FROM jsonb_each(q.proposed) f WHERE jsonb_typeof(f.value) NOT IN('string','number','boolean','null') OR NOT EXISTS(SELECT 1 FROM app.access_profile_value_bindings() b WHERE b.legacy_key=f.key)) THEN RETURN false;END IF;
 END IF;
 IF q.route_id IS NOT NULL AND q.route_context->>'fingerprint' IS DISTINCT FROM app.access_profile_route_fingerprint(q.employment_id) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_setting WHERE tenant_id=q.tenant_id AND key='ess.profile_change_approver' AND value='"group_admin"'::jsonb)
  AND app.is_group_admin() IS NOT TRUE THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.employment e WHERE e.id=q.employment_id AND e.tenant_id=q.tenant_id AND e.person_id=q.person_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_profile_rejection_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_profile_rejection_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) RENAME TO _assistant_assigned_review_binding_profile_rejection_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_assigned_review_binding_profile_rejection_previous(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 IF p_kind='employees.profile_request.reject' AND (app.assistant_profile_rejection_scope(p_subject) IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.profile_change_request q JOIN public.employment e ON e.id=q.employment_id AND e.tenant_id=q.tenant_id
  WHERE q.id=p_subject AND q.tenant_id=app.current_tenant_id() AND q.employment_id=p_employment AND q.person_id=p_subject_person AND e.company_id=p_company)) THEN
  RAISE EXCEPTION 'Profile rejection review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding_profile_rejection_previous(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_profile_rejection_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;x xid:=pg_current_xact_id()::xid;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id();
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind<>'employees.profile_request.reject' THEN RETURN app._assistant_generic_review_verify_profile_rejection_previous(p_id,p_event);END IF;
 IF r.receipt_subject_kind IS DISTINCT FROM 'profile_change_request' OR app.assistant_profile_rejection_scope(r.receipt_subject_id) IS NOT TRUE THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.profile_change_request q JOIN public.employment e ON e.id=q.employment_id AND e.tenant_id=q.tenant_id
 JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
 WHERE q.id=r.receipt_subject_id AND q.tenant_id=r.tenant_id AND q.employment_id=r.employment_id AND q.person_id=r.decision_subject_person_id
 AND e.company_id=r.company_id AND q.status='rejected' AND length(btrim(q.decision_reason))>0 AND q.decided_at IS NOT NULL AND q.decided_by_employment_id IS NULL
 AND q.xmin=x AND d.id=p_event AND d.xmin=x AND d.aggregate_type='profile-change' AND d.event_type='profile-change.rejected'
 AND d.actor_type='user' AND d.actor_id=r.user_id AND d.subject_employment_id=q.employment_id
 AND d.payload->>'decision'='rejected' AND d.payload->'reasonGiven'='true'::jsonb AND d.payload->'deciderEmploymentId'='null'::jsonb
 AND d.payload->>'decisionRowHash'=encode(sha256(convert_to(to_jsonb(q)::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify_profile_rejection_previous(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$
DECLARE target regprocedure;definition text;marker text;replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY[
  'app.native_outcome_review_completed(text,uuid)',
  'app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)',
  'app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN
   marker:='WHEN ''employees.qualification.maintain'' THEN r.receipt_event_id';
   replacement:=marker||' WHEN ''employees.profile_request.reject'' THEN r.receipt_event_id';
  ELSE marker:='''employees.qualification.maintain''';replacement:=marker||',''employees.profile_request.reject''';END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'profile-rejection: unexpected native outcome owner %',target;END IF;
  definition:=replace(definition,marker,replacement);
  IF target='app.native_outcome_completed_review_choices(jsonb)'::regprocedure THEN
   definition:=regexp_replace(definition,'NOT BETWEEN 1 AND [0-9]+','NOT BETWEEN 1 AND (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
   definition:=regexp_replace(definition,'LIMIT [0-9]+','LIMIT (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
  END IF;EXECUTE definition;
 END LOOP;
END $$;
--> statement-breakpoint
-- Return only an opaque logical Access revision commitment to the already-authorized reviewer.
CREATE FUNCTION app.assistant_profile_rejection_authority_hash(p_request uuid) RETURNS text
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result text;
BEGIN
 IF app.assistant_profile_rejection_scope(p_request) IS NOT TRUE THEN RAISE EXCEPTION 'Profile rejection authority unavailable' USING ERRCODE='42501';END IF;
 -- Match the native Access owner's effective legacy-versus-initialized semantics. The caller
 -- already holds the shared Access write barrier; do not initialize Access merely to review HR work.
 -- Missing and uninitialized rows both use legacy role authority, so their commitment is stable.
 -- Genuine initialization or any later logical revision produces a different commitment.
 SELECT encode(sha256(convert_to(COALESCE((SELECT jsonb_build_array(1,'initialized_access',s.revision)
  FROM public.access_configuration s WHERE s.tenant_id=app.current_tenant_id() AND s.initialized),
  jsonb_build_array(1,'legacy_uninitialized_access'))::text,'UTF8')),'hex') INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.assistant_profile_rejection_authority_hash(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_profile_rejection_authority_hash(uuid) TO ai_hr_app;
--> statement-breakpoint
-- This kind retires expired own ciphertext before a replacement pending review is inserted.
-- All predecessor kinds keep their complete installed prepare implementation unchanged.
ALTER FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) RENAME TO assistant_assigned_review_prepare_pr_reject_prev;
--> statement-breakpoint
CREATE FUNCTION app.assistant_assigned_review_prepare(p_kind text,p_id uuid,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid,p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE expired record;
BEGIN
 IF p_kind='employees.profile_request.reject' THEN
  PERFORM app._assistant_leave_decision_login(p_person,true);
  FOR expired IN SELECT id FROM app.assistant_own_leave_review WHERE tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind=p_kind AND receipt_subject_id=p_subject AND state='awaiting_confirmation' AND expires_at<=clock_timestamp() FOR UPDATE LOOP
   PERFORM app.assistant_assigned_review_read(expired.id,p_kind);
  END LOOP;
  PERFORM app.assistant_own_leave_reviews_expire_own(100);
 END IF;
 RETURN app.assistant_assigned_review_prepare_pr_reject_prev(p_kind,p_id,p_person,p_employment,p_company,p_subject_person,p_subject,p_intent_digest,p_reviewed_digest,p_kid,p_wrapped_dek,p_ciphertext);
END $$;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_prepare_pr_reject_prev(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC,ai_hr_app;
