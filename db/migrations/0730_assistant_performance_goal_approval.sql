-- PROVISIONAL DEVELOPMENT allocation 0730 / idx710 / version7 / when1793330000067.
-- No installation or release authorization. Preserve all predecessor SQL bytes.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('performance.goal.approve','performance','approve','personnel','performance.goal.approve');
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
 IF matches<>1 THEN RAISE EXCEPTION '0730: unexpected actor subject scope predicate';END IF;
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=constraint_name;
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',constraint_name);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''performance.goal.approve'' THEN employment_id IS NOT NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL ELSE (%s) END)',constraint_name,previous);
END $$;
--> statement-breakpoint
-- Extend the existing HR generic branch itself, preserving its complete predicate. Other dedicated
-- receipt families retain their separate null-column CHECKs from 0622. Refuse unexpected schema drift.
DO $$
DECLARE previous text;generic_columns text;
BEGIN
 SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname='assistant_review_kind_columns' AND c.contype='c';
 IF previous IS NULL OR position('employees.qualification.maintain' in previous)=0 THEN RAISE EXCEPTION '0730: existing generic assigned branch unavailable';END IF;
 -- Evaluate the already accepted generic-column rule for the new kind, preserving all sibling cases.
 generic_columns:=replace(previous,'action_kind','''employees.qualification.maintain''::text');
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK (CASE WHEN action_kind=''performance.goal.approve'' THEN ('||generic_columns||') ELSE ('||previous||') END)';
END $$;
--> statement-breakpoint
-- Preserve each remaining prior expression exactly, adding only a branch for this kind.
DO $$
DECLARE item record;previous text;added text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('assistant_review_decision_columns', 'decision_subject_person_id IS NOT NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
  ('assistant_review_generic_receipt', 'receipt_subject_kind=''performance_goal'' AND receipt_subject_id IS NOT NULL AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')
 ) AS requirements(name,expression) LOOP
  SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
   WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname=item.name AND c.contype='c';
  IF previous IS NULL THEN RAISE EXCEPTION '0730: missing custody constraint %',item.name;END IF;
  added:='CASE WHEN action_kind=''performance.goal.approve'' THEN ('||item.expression||') ELSE ('||previous||') END';
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (%s)',item.name,added);
 END LOOP;
END $$;
--> statement-breakpoint
-- One pending review per goal PER CALLER, preserving every previous index predicate.
DO $$
DECLARE generic_predicate text;assigned_predicate text;
BEGIN
 SELECT pg_get_expr(indpred,indrelid) INTO generic_predicate FROM pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 SELECT pg_get_expr(indpred,indrelid) INTO assigned_predicate FROM pg_index WHERE indexrelid='app.assistant_review_assigned_pending_subject'::regclass;
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION '0730: missing custody indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''performance.goal.approve''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') OR (action_kind=''performance.goal.approve'' AND receipt_subject_id IS NOT NULL AND state=''awaiting_confirmation'')';
END $$;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_subject_kind(text) RENAME TO _assistant_assigned_review_subject_kind_0730_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_kind='performance.goal.approve' THEN 'performance_goal' ELSE app._assistant_assigned_review_subject_kind_0730_previous(p_kind) END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind_0730_previous(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Mirror the existing native goal RLS and assertCanDecide direct-line/delegation rule.
CREATE FUNCTION app.assistant_goal_approval_choice_scope(p_goal uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND EXISTS(
  SELECT 1 FROM public.performance_goal g JOIN public.employment e ON e.id=g.employment_id AND e.tenant_id=g.tenant_id
  JOIN public.app_user a ON a.id=app.current_user_id() AND a.tenant_id=e.tenant_id
  WHERE g.id=p_goal AND g.tenant_id=app.current_tenant_id() AND a.person_id IS DISTINCT FROM e.person_id
  AND app.can_see_employment(e.id) AND (app.is_admin() OR (a.person_id IS NOT NULL AND (EXISTS(
   SELECT 1 FROM public.reporting_line r JOIN public.employment m ON m.id=r.manager_employment_id AND m.tenant_id=r.tenant_id
   WHERE r.tenant_id=e.tenant_id AND r.subordinate_employment_id=e.id AND r.line_type='administrative'
    AND r.superseded_at IS NULL AND r.valid_from<=current_date AND (r.valid_to IS NULL OR r.valid_to>current_date)
    AND m.person_id=a.person_id) OR app.can_decide_via_delegation(e.id,NULL,NULL)))));
$$;
REVOKE ALL ON FUNCTION app.assistant_goal_approval_choice_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_goal_approval_choice_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_goal_approval_scope(p_goal uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.assistant_goal_approval_choice_scope(p_goal) IS NOT TRUE THEN RAISE EXCEPTION 'Goal review unavailable' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.performance_goal WHERE id=p_goal AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF app.assistant_goal_approval_choice_scope(p_goal) IS NOT TRUE THEN RAISE EXCEPTION 'Goal review unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('subjectId',g.id,'employmentId',g.employment_id,'companyId',e.company_id,'subjectPersonId',e.person_id,'revision',g.xmin::text,'employeeName',p.full_name,'companyName',c.legal_name) INTO result
 FROM public.performance_goal g JOIN public.employment e ON e.id=g.employment_id AND e.tenant_id=g.tenant_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
 WHERE g.id=p_goal AND g.tenant_id=app.current_tenant_id();
 IF result IS NULL THEN RAISE EXCEPTION 'Goal review unavailable' USING ERRCODE='42501';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.assistant_goal_approval_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_goal_approval_scope(uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) RENAME TO _assistant_assigned_review_binding_0730_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_assigned_review_binding_0730_previous(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 IF p_kind='performance.goal.approve' AND (app.assistant_goal_approval_choice_scope(p_subject) IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.performance_goal g WHERE g.id=p_subject AND g.tenant_id=app.current_tenant_id() AND g.employment_id=p_employment)) THEN
  RAISE EXCEPTION 'Goal review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding_0730_previous(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_goal_approval_receipt(p_goal uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.assistant_goal_approval_choice_scope(p_goal) IS NOT TRUE THEN RAISE EXCEPTION 'Goal receipt unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('kind','approved','subjectId',g.id,'employmentId',g.employment_id,'eventId',d.id) INTO result
 FROM public.performance_goal g JOIN public.domain_event d ON d.aggregate_id=g.id AND d.tenant_id=g.tenant_id
 WHERE g.id=p_goal AND g.tenant_id=app.current_tenant_id() AND g.approval_status='approved' AND g.approved_by_user_id=app.current_user_id()
 AND d.id=p_event AND d.aggregate_type='performance-goal' AND d.event_type='performance-goal.approved'
 AND d.subject_employment_id=g.employment_id AND d.actor_type='user' AND d.actor_id=app.current_user_id() AND d.payload IS NULL AND d.occurred_at=g.approved_at;
 IF result IS NULL THEN RAISE EXCEPTION 'Goal receipt unavailable' USING ERRCODE='42501';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.assistant_goal_approval_receipt(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_goal_approval_receipt(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_0730_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;x xid:=pg_current_xact_id()::xid;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id();
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind<>'performance.goal.approve' THEN RETURN app._assistant_generic_review_verify_0730_previous(p_id,p_event);END IF;
 IF r.receipt_subject_kind IS DISTINCT FROM 'performance_goal' OR app.assistant_goal_approval_choice_scope(r.receipt_subject_id) IS NOT TRUE THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.performance_goal g JOIN public.employment e ON e.id=g.employment_id AND e.tenant_id=g.tenant_id
 JOIN public.domain_event d ON d.aggregate_id=g.id AND d.tenant_id=g.tenant_id
 WHERE g.id=r.receipt_subject_id AND g.tenant_id=r.tenant_id AND g.employment_id=r.employment_id AND e.company_id=r.company_id AND e.person_id=r.decision_subject_person_id
 AND g.xmin=x AND d.xmin=x AND g.approval_status='approved' AND g.approved_by_user_id=r.user_id
 AND d.id=p_event AND d.aggregate_type='performance-goal' AND d.event_type='performance-goal.approved' AND d.actor_type='user' AND d.actor_id=r.user_id
 AND d.subject_employment_id=g.employment_id AND d.payload IS NULL AND d.occurred_at=g.approved_at);
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify_0730_previous(uuid,uuid) FROM PUBLIC,ai_hr_app;
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
   replacement:=marker||' WHEN ''performance.goal.approve'' THEN r.receipt_event_id';
  ELSE
   marker:='''employees.qualification.maintain''';replacement:=marker||',''performance.goal.approve''';
  END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0730: unexpected native outcome owner %',target;END IF;
  definition:=replace(definition,marker,replacement);
  IF target='app.native_outcome_completed_review_choices(jsonb)'::regprocedure THEN
   definition:=regexp_replace(definition,'NOT BETWEEN 1 AND [0-9]+','NOT BETWEEN 1 AND (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
   definition:=regexp_replace(definition,'LIMIT [0-9]+','LIMIT (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
  END IF;
  EXECUTE definition;
 END LOOP;
END $$;
