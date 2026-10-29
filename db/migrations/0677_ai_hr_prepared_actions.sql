-- ADR-0151 (amendment 2026-10-29): the first HR-administrator actions, as three kinds of the wave 1b ASSIGNED
-- family (0671): the caller is the administrator, the subject is ANOTHER person's employment.
--  * leave.adjustment.apply: one employee, one leave type (applyLeaveAdjustmentBatch, individual mode).
--  * employees.movement.transfer: an assignment-only Transfer or Organisation Assignment Change.
--  * toil.credit.grant: an HR manual Leave Credit for one date one employee worked (grantLeaveCreditRows).
-- The stored subject is the employment itself (receipt_subject_kind='employment'); the subject person is kept
-- in decision_subject_person_id exactly as 0671 does, so the erasure and outcome-capture owners cover it.
-- 0671's verifier and binding are wrapped, not copied: they are renamed and the new functions delegate every
-- other kind to them unchanged. Claimed as 0677 between the active ADR-0151 sessions on 29 Oct 2026.
-- No data changes: every existing kind keeps its exact constraint meaning.
DO $$
DECLARE def text;
 old_list constant text:='''approvals.toil.decide''::text]';
 new_list constant text:='''approvals.toil.decide''::text, ''leave.adjustment.apply''::text, ''employees.movement.transfer''::text, ''toil.credit.grant''::text]';
BEGIN
 -- The generic-kind list of the per-kind column rule gains the two kinds; the legacy ELSE expression is
 -- carried over byte-for-byte from the live definition. Exactly one occurrence must match.
 SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname='assistant_review_kind_columns';
 IF def IS NULL OR (length(def)-length(replace(def,old_list,'')))/length(old_list)<>1 THEN
  RAISE EXCEPTION '0677: unexpected assistant_review_kind_columns definition';END IF;
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns '||replace(def,old_list,new_list);
END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_decision_columns;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_decision_columns CHECK(CASE
 WHEN action_kind='approvals.leave.decide' THEN decision_request_id IS NOT NULL AND decision_subject_person_id IS NOT NULL AND ((state='completed')=(decision_event_id IS NOT NULL))
 WHEN action_kind IN ('approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide','leave.adjustment.apply','employees.movement.transfer','toil.credit.grant') THEN decision_subject_person_id IS NOT NULL
  AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL
 ELSE decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_subject_person_id IS NULL AND decision_applicant_person_id IS NULL END);
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_action_kind;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_action_kind CHECK(action_kind IN ('leave.apply','notifications.email_preferences.save','ess.profile.request','claims.draft.save','performance.review.acknowledge','performance.onehr.plan.acknowledge','system_testing.execution.save','claims.submit','org.reporting.change','knowledge_base.article.create','lifecycle.acknowledgement.submit','toil.replacement.request','approvals.leave.decide','attendance.correction.request','typed_pay_components.create','rewards.post','payroll.close','country-my.statutory.update','multi_cycle_payroll.create_run',
 'claims.cancel','leave.cancel','leave.edit','attendance.overtime.request','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide',
 'leave.adjustment.apply','employees.movement.transfer','toil.credit.grant'));
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_generic_receipt;
--> statement-breakpoint
-- The HR kinds name the subject employment itself, which is never the administrator's own (binding below).
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_generic_receipt CHECK(CASE
 WHEN action_kind IN ('claims.cancel','approvals.claim.decide') THEN receipt_subject_kind='claim_request' AND receipt_subject_id IS NOT NULL AND ((state='completed')=(receipt_event_id IS NOT NULL))
 WHEN action_kind IN ('leave.cancel','leave.edit') THEN receipt_subject_kind='leave_request' AND receipt_subject_id IS NOT NULL AND ((state='completed')=(receipt_event_id IS NOT NULL))
 WHEN action_kind IN ('attendance.overtime.request','leave.adjustment.apply','employees.movement.transfer','toil.credit.grant') THEN receipt_subject_kind='employment' AND receipt_subject_id=employment_id AND ((state='completed')=(receipt_event_id IS NOT NULL))
 WHEN action_kind='approvals.attendance.decide' THEN receipt_subject_kind='attendance_correction' AND receipt_subject_id IS NOT NULL AND ((state='completed')=(receipt_event_id IS NOT NULL))
 WHEN action_kind='approvals.toil.decide' THEN receipt_subject_kind='replacement_leave_request' AND receipt_subject_id IS NOT NULL AND ((state='completed')=(receipt_event_id IS NOT NULL))
 ELSE receipt_subject_kind IS NULL AND receipt_subject_id IS NULL AND receipt_event_id IS NULL END);
--> statement-breakpoint
-- One pending review per subject per administrator, as for the assigned decisions.
DROP INDEX app.assistant_review_generic_pending_subject;
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id)
 WHERE receipt_subject_id IS NOT NULL AND state='awaiting_confirmation'
  AND action_kind NOT IN ('approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide','leave.adjustment.apply','employees.movement.transfer','toil.credit.grant');
--> statement-breakpoint
DROP INDEX app.assistant_review_assigned_pending_subject;
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id)
 WHERE receipt_subject_id IS NOT NULL AND state='awaiting_confirmation'
  AND action_kind IN ('approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide','leave.adjustment.apply','employees.movement.transfer','toil.credit.grant');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE p_kind WHEN 'approvals.claim.decide' THEN 'claim_request' WHEN 'approvals.attendance.decide' THEN 'attendance_correction'
  WHEN 'approvals.toil.decide' THEN 'replacement_leave_request' WHEN 'leave.adjustment.apply' THEN 'employment' WHEN 'employees.movement.transfer' THEN 'employment' WHEN 'toil.credit.grant' THEN 'employment' END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- 0671's binding still decides the login, the subject employment/company/person and that the subject person
-- is never the caller. An 'employment' subject must in addition be that subject employment itself.
ALTER FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) RENAME TO _assistant_assigned_review_binding_0671;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_assigned_review_binding_0671(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 IF app._assistant_assigned_review_subject_kind(p_kind)='employment' AND p_subject IS DISTINCT FROM p_employment THEN
  RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Proof that the native command committed THIS effect in THIS transaction by THIS login for THIS employment,
-- whose person is not the administrator's. Every other kind is decided by 0671's verifier, unchanged.
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_0671;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();x xid:=pg_current_xact_id()::xid;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u;
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind NOT IN ('leave.adjustment.apply','employees.movement.transfer','toil.credit.grant') THEN
  RETURN app._assistant_generic_review_verify_0671(p_id,p_event);END IF;
 IF r.receipt_subject_id IS DISTINCT FROM r.employment_id
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=r.employment_id AND e.tenant_id=t AND e.company_id=r.company_id
   AND e.person_id=r.decision_subject_person_id)
  OR r.person_id IS NOT DISTINCT FROM r.decision_subject_person_id
  OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=r.decision_subject_person_id) THEN
  RETURN false;END IF;
 IF r.action_kind='leave.adjustment.apply' THEN
  -- An individual batch by this login, written now, with its ledger row for this employment and its event.
  RETURN EXISTS(SELECT 1 FROM public.leave_adjustment_batch b JOIN public.domain_event d ON d.aggregate_id=b.id AND d.tenant_id=b.tenant_id
   WHERE b.tenant_id=t AND b.actor_user_id=u AND b.target_mode='individual' AND b.written_count=1 AND b.xmin=x
    AND d.id=p_event AND d.aggregate_type='leave-adjustment-batch' AND d.event_type='leave.adjustment.applied'
    AND d.actor_type='user' AND d.actor_id=u AND d.xmin=x
    AND EXISTS(SELECT 1 FROM public.leave_ledger l WHERE l.adjustment_batch_id=b.id AND l.tenant_id=t AND l.employment_id=r.employment_id
     AND l.entry_type='adjustment' AND l.xmin=x));
 END IF;
 IF r.action_kind='toil.credit.grant' THEN
  -- An HR manual Leave Credit for this employment, banked now, with its own accrual event.
  RETURN EXISTS(SELECT 1 FROM public.toil_accrual a JOIN public.domain_event d ON d.aggregate_id=a.id AND d.tenant_id=a.tenant_id
   WHERE a.tenant_id=t AND a.employment_id=r.employment_id AND a.source='hr_manual_grant' AND a.xmin=x
    AND d.id=p_event AND d.aggregate_type='toil-accrual' AND d.event_type='toil.accrued'
    AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=r.employment_id AND d.xmin=x);
 END IF;
 -- Movement: the movement's owning (non-secondary) history event for this employment, written now.
 RETURN EXISTS(SELECT 1 FROM public.domain_event d WHERE d.id=p_event AND d.tenant_id=t AND d.subject_employment_id=r.employment_id
  AND d.actor_type='user' AND d.actor_id=u AND d.xmin=x AND jsonb_typeof(d.payload->'movement')='object'
  AND coalesce(d.payload->'movement'->>'secondary','false')<>'true');
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Outcome linking (ADR-0151 §4.6c): the three kinds join the association list and the readers.
ALTER TABLE public.ai_native_outcome_association DROP CONSTRAINT ai_native_outcome_association_action;
--> statement-breakpoint
ALTER TABLE public.ai_native_outcome_association ADD CONSTRAINT ai_native_outcome_association_action CHECK(action IN('employees.import',
'org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save','claims.cancel','leave.cancel','leave.edit',
'attendance.overtime.request','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide','leave.adjustment.apply','employees.movement.transfer','toil.credit.grant'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.native_outcome_review_completed(p_kind text,p_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.current_tenant_id() IS NOT NULL
 AND app.principal_snapshot_current() AND p_kind IN('org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save','claims.cancel','leave.cancel','leave.edit','attendance.overtime.request','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide','leave.adjustment.apply','employees.movement.transfer','toil.credit.grant')
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
   WHEN 'leave.adjustment.apply' THEN r.receipt_event_id WHEN 'employees.movement.transfer' THEN r.receipt_event_id WHEN 'toil.credit.grant' THEN r.receipt_event_id END=p_event)))
$$;
REVOKE ALL ON FUNCTION app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.native_outcome_completed_review_choices(p_kinds jsonb)
 RETURNS TABLE(action text,action_id uuid,created_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current()
 OR jsonb_typeof(p_kinds) IS DISTINCT FROM 'array' OR jsonb_array_length(p_kinds) NOT BETWEEN 1 AND 29
 THEN RAISE EXCEPTION 'Outcome choices unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_kinds) v WHERE jsonb_typeof(v)<>'string')
 OR (SELECT count(DISTINCT v) FROM jsonb_array_elements_text(p_kinds) v)<>jsonb_array_length(p_kinds)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_kinds) v WHERE v NOT IN
 ('org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save','claims.cancel','leave.cancel','leave.edit','attendance.overtime.request','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide','leave.adjustment.apply','employees.movement.transfer','toil.credit.grant'))
 THEN RAISE EXCEPTION 'Outcome choices unavailable'; END IF;
 RETURN QUERY SELECT r.action_kind,r.id,r.created_at FROM app.assistant_own_leave_review r
 WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id()
 AND r.state='completed' AND r.action_kind IN(SELECT jsonb_array_elements_text(p_kinds))
 AND r.created_at<=now() AND r.created_at>now()-interval '30 days'
 AND app.native_outcome_capture_available(r.action_kind,r.id)
 ORDER BY r.created_at DESC,r.id DESC LIMIT 29;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_completed_review_choices(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_completed_review_choices(jsonb) TO ai_hr_app;
