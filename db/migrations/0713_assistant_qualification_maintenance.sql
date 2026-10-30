-- ADR-0151 personnel parity: one human-reviewed qualification register operation.
-- PROVISIONAL SOURCE CLAIM ONLY: 0713 / idx694 / when1793330000042. Reallocate above the
-- then-live accepted ledger at integration freeze. No installation priority or deployment authority.
-- Reuse the one prepared-action ledger and its generic ASSIGNED custody. Every prior kind retains
-- its prior constraints, binding, verifier and receipt behaviour; no historical SQL is edited.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('employees.qualification.maintain','employees','approve','personnel','employees.qualification.maintain');
--> statement-breakpoint
-- Extend the existing HR generic branch itself, preserving its complete predicate. Other dedicated
-- receipt families retain their separate null-column CHECKs from 0622. Refuse unexpected schema drift.
DO $$
DECLARE previous text;marker constant text:='''toil.credit.grant''::text]';
BEGIN
 SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname='assistant_review_kind_columns' AND c.contype='c';
 IF previous IS NULL OR (length(previous)-length(replace(previous,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION '0713: expected one existing HR generic column branch';END IF;
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK ('||
  replace(previous,marker,'''toil.credit.grant''::text, ''employees.qualification.maintain''::text]')||')';
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
  IF previous IS NULL THEN RAISE EXCEPTION '0713: missing custody constraint %',item.name;END IF;
  added:='CASE WHEN action_kind=''employees.qualification.maintain'' THEN ('||item.expression||') ELSE ('||previous||') END';
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
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION '0713: missing custody indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''employees.qualification.maintain''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') OR (action_kind=''employees.qualification.maintain'' AND receipt_subject_id IS NOT NULL AND state=''awaiting_confirmation'')';
END $$;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_subject_kind(text) RENAME TO _assistant_assigned_review_subject_kind_0713_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_kind='employees.qualification.maintain' THEN 'employment'
  ELSE app._assistant_assigned_review_subject_kind_0713_previous(p_kind) END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind_0713_previous(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) RENAME TO _assistant_assigned_review_binding_0713_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_assigned_review_binding_0713_previous(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 IF p_kind='employees.qualification.maintain' AND (p_subject IS DISTINCT FROM p_employment
  OR app.is_admin() IS NOT TRUE OR app.access_workforce_employment(p_employment,'workforce.maintain') IS NOT TRUE) THEN
  RAISE EXCEPTION 'Qualification review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding_0713_previous(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_0713_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();x xid:=pg_current_xact_id()::xid;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u;
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind<>'employees.qualification.maintain' THEN RETURN app._assistant_generic_review_verify_0713_previous(p_id,p_event);END IF;
 IF r.receipt_subject_kind IS DISTINCT FROM 'employment' OR r.receipt_subject_id IS DISTINCT FROM r.employment_id
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=r.employment_id AND e.tenant_id=t AND e.company_id=r.company_id AND e.person_id=r.decision_subject_person_id)
  OR r.person_id IS NOT DISTINCT FROM r.decision_subject_person_id
  OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=r.decision_subject_person_id)
  OR app.is_admin() IS NOT TRUE OR app.access_workforce_employment(r.employment_id,'workforce.maintain') IS NOT TRUE THEN RETURN false;END IF;
 -- Both the native row and event must have been written HERE, by THIS login, for THIS employment.
 -- A current event alone cannot bless an old/foreign row, a different aggregate, or a wrong state.
 RETURN EXISTS(SELECT 1 FROM public.employee_qualification q JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
  WHERE q.tenant_id=t AND q.employment_id=r.employment_id AND q.xmin=x AND d.id=p_event AND d.xmin=x
   AND d.aggregate_type='employee-qualification' AND d.subject_employment_id=r.employment_id
   AND d.actor_type='user' AND d.actor_id=u
   AND ((d.event_type IN('qualification.added','qualification.updated') AND q.archived_at IS NULL)
    OR (d.event_type='qualification.archived' AND q.archived_at IS NOT NULL)));
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify_0713_previous(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Native outcome custody remains user-owned; the new generic event uses receipt_event_id.
CREATE OR REPLACE FUNCTION app.native_outcome_review_completed(p_kind text,p_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.current_tenant_id() IS NOT NULL
 AND app.principal_snapshot_current() AND p_kind IN('org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save','claims.cancel','leave.cancel','leave.edit','attendance.overtime.request','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide','leave.adjustment.apply','employees.movement.transfer','toil.credit.grant','employees.qualification.maintain')
 AND EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.id=p_id AND r.tenant_id=app.current_tenant_id()
  AND r.user_id=app.current_user_id() AND r.action_kind=p_kind AND r.state='completed'
  AND r.created_at<=now() AND r.created_at>now()-interval '30 days')
$$;
REVOKE ALL ON FUNCTION app.native_outcome_review_completed(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_review_completed(text,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.native_outcome_targets_require(p_tenant uuid,p_user uuid,p_person uuid,p_action text,p_source uuid,p_event uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND p_user=app.current_user_id() AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.person_id IS NOT DISTINCT FROM p_person AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND EXISTS(SELECT 1 FROM app.native_outcome_source_capture c WHERE c.tenant_id=p_tenant AND c.user_id=p_user
  AND c.person_id IS NOT DISTINCT FROM p_person AND c.action=p_action AND c.source_id=p_source AND c.event_id=p_event AND c.expires_at>now()
  AND c.target_count=(SELECT count(*) FROM app.native_outcome_source_target t WHERE t.capture_id=c.id))
 AND((p_action='employees.import' AND EXISTS(SELECT 1 FROM public.employee_import_evaluation_attempt e WHERE e.id=p_source AND e.tenant_id=p_tenant AND e.user_id=p_user AND e.state='committed' AND e.event_id=p_event AND e.expires_at>now()))
 OR(p_action<>'employees.import' AND EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.id=p_source AND r.tenant_id=p_tenant AND r.user_id=p_user
  AND r.action_kind=p_action AND r.state='completed' AND r.person_id IS NOT DISTINCT FROM p_person AND CASE p_action
   WHEN 'leave.apply' THEN r.submission_event_id WHEN 'org.reporting.change' THEN r.reporting_set_event_id
   WHEN 'ess.profile.request' THEN r.profile_requested_event_id WHEN 'approvals.leave.decide' THEN r.decision_event_id
   WHEN 'knowledge_base.article.create' THEN r.knowledge_created_event_id WHEN 'payroll.close' THEN r.payroll_closed_event_id
   WHEN 'attendance.correction.request' THEN r.attendance_requested_event_id WHEN 'claims.draft.save' THEN r.claim_saved_event_id
   WHEN 'claims.submit' THEN r.claim_submitted_event_id WHEN 'performance.review.acknowledge' THEN r.performance_ack_event_id
   WHEN 'performance.onehr.plan.acknowledge' THEN r.performance_ack_event_id WHEN 'rewards.post' THEN r.rewards_posted_event_id
   WHEN 'lifecycle.acknowledgement.submit' THEN r.lifecycle_submitted_event_id WHEN 'toil.replacement.request' THEN r.toil_submitted_event_id
   WHEN 'multi_cycle_payroll.create_run' THEN r.multi_cycle_created_event_id WHEN 'typed_pay_components.create' THEN r.pay_component_created_event_id
   WHEN 'country-my.statutory.update' THEN r.country_statutory_event_id WHEN 'notifications.email_preferences.save' THEN r.notification_event_id
   WHEN 'system_testing.execution.save' THEN r.testing_event_id WHEN 'claims.cancel' THEN r.receipt_event_id WHEN 'leave.cancel' THEN r.receipt_event_id WHEN 'leave.edit' THEN r.receipt_event_id
   WHEN 'attendance.overtime.request' THEN r.receipt_event_id WHEN 'approvals.claim.decide' THEN r.receipt_event_id
   WHEN 'approvals.attendance.decide' THEN r.receipt_event_id WHEN 'approvals.toil.decide' THEN r.receipt_event_id
   WHEN 'leave.adjustment.apply' THEN r.receipt_event_id WHEN 'employees.movement.transfer' THEN r.receipt_event_id WHEN 'toil.credit.grant' THEN r.receipt_event_id WHEN 'employees.qualification.maintain' THEN r.receipt_event_id END=p_event)))
$$;
REVOKE ALL ON FUNCTION app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.native_outcome_completed_review_choices(p_kinds jsonb)
 RETURNS TABLE(action text,action_id uuid,created_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current()
 OR jsonb_typeof(p_kinds) IS DISTINCT FROM 'array' OR jsonb_array_length(p_kinds) NOT BETWEEN 1 AND 30
 THEN RAISE EXCEPTION 'Outcome choices unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_kinds) v WHERE jsonb_typeof(v)<>'string')
 OR (SELECT count(DISTINCT v) FROM jsonb_array_elements_text(p_kinds) v)<>jsonb_array_length(p_kinds)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_kinds) v WHERE v NOT IN
 ('org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save','claims.cancel','leave.cancel','leave.edit','attendance.overtime.request','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide','leave.adjustment.apply','employees.movement.transfer','toil.credit.grant','employees.qualification.maintain'))
 THEN RAISE EXCEPTION 'Outcome choices unavailable'; END IF;
 RETURN QUERY SELECT r.action_kind,r.id,r.created_at FROM app.assistant_own_leave_review r
 WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id()
 AND r.state='completed' AND r.action_kind IN(SELECT jsonb_array_elements_text(p_kinds))
 AND r.created_at<=now() AND r.created_at>now()-interval '30 days'
 AND app.native_outcome_capture_available(r.action_kind,r.id)
 ORDER BY r.created_at DESC,r.id DESC LIMIT 30;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_completed_review_choices(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_completed_review_choices(jsonb) TO ai_hr_app;
