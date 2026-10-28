-- ADR-0151 wave 1b: the remaining four first-wave kinds on the one prepared-action store.
--  * attendance.overtime.request: the caller's OWN overtime request (generic own family of 0670; the
--    subject is the caller's own employment, because the native request row does not exist until the
--    person confirms).
--  * approvals.claim.decide, approvals.attendance.decide, approvals.toil.decide: an ASSIGNED decision.
--    The caller is the decider, the subject employment is someone else's and the native service decides
--    authority. These use a separate "assigned" function family modelled on the 0622 leave-decision
--    custody: the row keeps the subject's employment/company and the subject PERSON (in the existing
--    decision_subject_person_id column, so every existing privacy-erasure and outcome-capture owner
--    already covers it), and the decider can never be the subject.
-- Claimed as 0671 (when 1793210000000) on 29 Oct 2026 and announced to the active sessions.
-- No data changes: every existing kind keeps its exact constraint meaning.
DO $$
DECLARE found integer;name text;def text;
 old_list constant text:='ARRAY[''claims.cancel''::text, ''leave.cancel''::text, ''leave.edit''::text]';
 new_list constant text:='ARRAY[''claims.cancel''::text, ''leave.cancel''::text, ''leave.edit''::text, ''attendance.overtime.request''::text, ''approvals.claim.decide''::text, ''approvals.attendance.decide''::text, ''approvals.toil.decide''::text]';
BEGIN
 -- The 0670 per-kind column rule: generic kinds hold no legacy receipt column. Only its generic-kind
 -- list changes; the legacy ELSE expression is carried over byte-for-byte from the live definition.
 SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname='assistant_review_kind_columns';
 IF def IS NULL OR (length(def)-length(replace(def,old_list,'')))/length(old_list)<>1 THEN
  RAISE EXCEPTION '0671: unexpected assistant_review_kind_columns definition';END IF;
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns '||replace(def,old_list,new_list);
 -- The 0622 decision-column rule is unnamed; find it by definition. Exactly one must match.
 SELECT count(*),min(conname) INTO found,name FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%approvals.leave.decide%' AND pg_get_constraintdef(oid) LIKE '%decision_applicant_person_id IS NULL%';
 IF found<>1 THEN RAISE EXCEPTION '0671: expected one decision-column constraint, found %',found;END IF;
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',name);
END $$;
--> statement-breakpoint
-- approvals.leave.decide keeps its exact 0622 rule. The assigned generic kinds name only the subject person.
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_decision_columns CHECK(CASE
 WHEN action_kind='approvals.leave.decide' THEN decision_request_id IS NOT NULL AND decision_subject_person_id IS NOT NULL AND ((state='completed')=(decision_event_id IS NOT NULL))
 WHEN action_kind IN ('approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide') THEN decision_subject_person_id IS NOT NULL
  AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL
 ELSE decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_subject_person_id IS NULL AND decision_applicant_person_id IS NULL END);
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_action_kind;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_action_kind CHECK(action_kind IN ('leave.apply','notifications.email_preferences.save','ess.profile.request','claims.draft.save','performance.review.acknowledge','performance.onehr.plan.acknowledge','system_testing.execution.save','claims.submit','org.reporting.change','knowledge_base.article.create','lifecycle.acknowledgement.submit','toil.replacement.request','approvals.leave.decide','attendance.correction.request','typed_pay_components.create','rewards.post','payroll.close','country-my.statutory.update','multi_cycle_payroll.create_run',
 'claims.cancel','leave.cancel','leave.edit','attendance.overtime.request','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide'));
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_generic_receipt;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_generic_receipt CHECK(CASE
 WHEN action_kind IN ('claims.cancel','approvals.claim.decide') THEN receipt_subject_kind='claim_request' AND receipt_subject_id IS NOT NULL AND ((state='completed')=(receipt_event_id IS NOT NULL))
 WHEN action_kind IN ('leave.cancel','leave.edit') THEN receipt_subject_kind='leave_request' AND receipt_subject_id IS NOT NULL AND ((state='completed')=(receipt_event_id IS NOT NULL))
 WHEN action_kind='attendance.overtime.request' THEN receipt_subject_kind='employment' AND receipt_subject_id=employment_id AND ((state='completed')=(receipt_event_id IS NOT NULL))
 WHEN action_kind='approvals.attendance.decide' THEN receipt_subject_kind='attendance_correction' AND receipt_subject_id IS NOT NULL AND ((state='completed')=(receipt_event_id IS NOT NULL))
 WHEN action_kind='approvals.toil.decide' THEN receipt_subject_kind='replacement_leave_request' AND receipt_subject_id IS NOT NULL AND ((state='completed')=(receipt_event_id IS NOT NULL))
 ELSE receipt_subject_kind IS NULL AND receipt_subject_id IS NULL AND receipt_event_id IS NULL END);
--> statement-breakpoint
-- Own kinds: one pending review per subject. Assigned kinds: one pending review per subject PER DECIDER,
-- so one approver's open review neither blocks nor reveals itself to another approver of the same item.
DROP INDEX app.assistant_review_generic_pending_subject;
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id)
 WHERE receipt_subject_id IS NOT NULL AND state='awaiting_confirmation'
  AND action_kind NOT IN ('approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide');
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id)
 WHERE receipt_subject_id IS NOT NULL AND state='awaiting_confirmation'
  AND action_kind IN ('approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide');
--> statement-breakpoint
-- The OWN generic kinds. Assigned kinds are deliberately absent, so no own-family function accepts them.
CREATE OR REPLACE FUNCTION app._assistant_generic_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE p_kind WHEN 'claims.cancel' THEN 'claim_request' WHEN 'leave.cancel' THEN 'leave_request' WHEN 'leave.edit' THEN 'leave_request'
  WHEN 'attendance.overtime.request' THEN 'employment' END;
$$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE p_kind WHEN 'approvals.claim.decide' THEN 'claim_request' WHEN 'approvals.attendance.decide' THEN 'attendance_correction'
  WHEN 'approvals.toil.decide' THEN 'replacement_leave_request' END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- 0670 prepare, unchanged except that an 'employment' subject must be the bound own employment itself.
CREATE OR REPLACE FUNCTION app.assistant_generic_review_prepare(p_kind text,p_id uuid,p_person uuid,p_employment uuid,p_company uuid,
 p_subject uuid,p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();subject_kind text:=app._assistant_generic_review_subject_kind(p_kind);
BEGIN
 IF subject_kind IS NULL OR p_subject IS NULL THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(p_person,p_employment,p_company);
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
  AND i.tenant_id=t AND i.person_id=p_person)
  OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
   AND i.tenant_id=t AND i.person_id=p_person) THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$'
  OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$'
  OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512
  OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='22023';END IF;
 -- The subject must be this employment's own row. Ownership of the effect is still the native service's.
 IF subject_kind='claim_request' AND NOT EXISTS(SELECT 1 FROM public.claim_request q
   WHERE q.id=p_subject AND q.tenant_id=t AND q.employment_id=p_employment) THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 IF subject_kind='leave_request' AND NOT EXISTS(SELECT 1 FROM public.leave_request q
   WHERE q.id=p_subject AND q.tenant_id=t AND q.employment_id=p_employment) THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 IF subject_kind='employment' AND p_subject IS DISTINCT FROM p_employment THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u
   AND state='awaiting_confirmation' AND expires_at>at_time)>=5
  OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u
   AND created_at>at_time-interval '10 minutes')>=20 THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='54000';END IF;
 -- An expired pending review for the same subject yields to the new one.
 UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL
  WHERE tenant_id=t AND action_kind=p_kind AND receipt_subject_id=p_subject AND state='awaiting_confirmation' AND expires_at<=at_time;
 INSERT INTO app.assistant_own_leave_review
  (action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,receipt_subject_kind,receipt_subject_id,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES(p_kind,p_id,t,u,p_person,p_employment,p_company,subject_kind,p_subject,
  p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_generic_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_generic_review_prepare(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_generic_review_prepare(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Per-kind proof that the native command committed THIS effect in THIS transaction for THIS login and
-- subject. Consistency evidence only; the native service remains the owner of the effect's rules. The
-- three assigned kinds also prove the decider is not the subject.
CREATE OR REPLACE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();x xid:=pg_current_xact_id()::xid;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u;
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind='claims.cancel' THEN
  RETURN EXISTS(SELECT 1 FROM public.claim_request q JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
   WHERE q.id=r.receipt_subject_id AND q.tenant_id=t AND q.employment_id=r.employment_id AND q.status='cancelled'
    AND q.xmin=x AND d.id=p_event AND d.aggregate_type='claim-request' AND d.event_type='claim-request.cancelled'
    AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id AND d.xmin=x);
 END IF;
 IF r.action_kind IN ('leave.cancel','leave.edit') THEN
  RETURN EXISTS(SELECT 1 FROM public.leave_request q JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
   WHERE q.id=r.receipt_subject_id AND q.tenant_id=t AND q.employment_id=r.employment_id AND q.parent_group_id IS NULL
    AND q.status=CASE r.action_kind WHEN 'leave.cancel' THEN 'cancelled'::public.leave_request_status ELSE 'pending'::public.leave_request_status END
    AND q.xmin=x AND d.id=p_event AND d.aggregate_type='leave-request'
    AND d.event_type=CASE r.action_kind WHEN 'leave.cancel' THEN 'leave-request.self-cancelled' ELSE 'leave-request.edited' END
    AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id AND d.xmin=x);
 END IF;
 -- A NEW pending overtime-only request (no clock times) of the bound own employment.
 IF r.action_kind='attendance.overtime.request' THEN
  RETURN r.receipt_subject_id=r.employment_id AND EXISTS(SELECT 1 FROM public.attendance_correction q JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
   WHERE q.tenant_id=t AND q.employment_id=r.employment_id AND q.status='pending' AND q.cancelled_at IS NULL
    AND q.requested_ot_minutes IS NOT NULL AND q.proposed_check_in IS NULL AND q.proposed_check_out IS NULL AND q.clock_changes IS NULL
    AND q.xmin=x AND d.id=p_event AND d.aggregate_type='attendance-correction' AND d.event_type='attendance-correction.requested'
    AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id AND d.xmin=x);
 END IF;
 IF r.action_kind NOT IN ('approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide') THEN RETURN false;END IF;
 -- Assigned: the stored subject person still owns the subject employment and is not this login's person.
 IF NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=r.employment_id AND e.tenant_id=t AND e.company_id=r.company_id
   AND e.person_id=r.decision_subject_person_id)
  OR r.person_id IS NOT DISTINCT FROM r.decision_subject_person_id
  OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=r.decision_subject_person_id) THEN
  RETURN false;END IF;
 IF r.action_kind='approvals.claim.decide' THEN
  RETURN EXISTS(SELECT 1 FROM public.claim_request q JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
   WHERE q.id=r.receipt_subject_id AND q.tenant_id=t AND q.employment_id=r.employment_id AND q.status IN ('approved','rejected')
    AND q.xmin=x AND d.id=p_event AND d.aggregate_type='claim-request' AND d.event_type='claim-request.'||q.status::text
    AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id AND d.xmin=x);
 END IF;
 IF r.action_kind='approvals.toil.decide' THEN
  RETURN EXISTS(SELECT 1 FROM public.replacement_leave_request q JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
   WHERE q.id=r.receipt_subject_id AND q.tenant_id=t AND q.employment_id=r.employment_id AND q.status IN ('approved','rejected')
    AND q.decided_by_user_id=u AND q.xmin=x AND d.id=p_event AND d.aggregate_type='replacement-leave-request'
    AND d.event_type='replacement-leave-request.'||q.status::text
    AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id AND d.xmin=x);
 END IF;
 -- Attendance: a final decision writes the request and its approved/rejected event; an earlier level of a
 -- multi-level workflow records only its level decision and leaves the request pending.
 RETURN EXISTS(SELECT 1 FROM public.attendance_correction q JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
  WHERE q.id=r.receipt_subject_id AND q.tenant_id=t AND q.employment_id=r.employment_id
   AND d.id=p_event AND d.aggregate_type='attendance-correction' AND d.actor_type='user' AND d.actor_id=u
   AND d.subject_employment_id=q.employment_id AND d.xmin=x
   AND ((q.status IN ('approved','rejected') AND q.xmin=x AND d.event_type='attendance-correction.'||q.status::text)
    OR (q.status='pending' AND d.event_type IN ('attendance-workflow.stage.decided','attendance-workflow.participant.decided'))));
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Assigned custody JSON: the decider's nullable person and the subject person are both part of the binding.
CREATE FUNCTION app._assistant_assigned_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object(
  'actionId',r.id,'action',r.action_kind,'contractVersion',1,
  'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'subjectPersonId',r.decision_subject_person_id),
  'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,
  'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object(
   'formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
  'subjectKind',r.receipt_subject_kind,'subjectId',r.receipt_subject_id,'eventId',r.receipt_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id
 WHERE r.id=p_id AND app._assistant_assigned_review_subject_kind(r.action_kind) IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Current login bound to the stored decider person; the subject row belongs to the stored subject
-- employment, company and person; and that person is never the decider. Decision authority is NOT
-- decided here: the trusted command asks the native service before preparing and when confirming.
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();subject_kind text:=app._assistant_assigned_review_subject_kind(p_kind);
BEGIN
 PERFORM app._assistant_leave_decision_login(p_person,true);
 IF subject_kind IS NULL OR p_subject IS NULL OR p_subject_person IS NULL OR p_subject_person IS NOT DISTINCT FROM p_person
  OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=p_subject_person)
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=t AND e.company_id=p_company AND e.person_id=p_subject_person)
  OR (subject_kind='claim_request' AND NOT EXISTS(SELECT 1 FROM public.claim_request q WHERE q.id=p_subject AND q.tenant_id=t AND q.employment_id=p_employment))
  OR (subject_kind='attendance_correction' AND NOT EXISTS(SELECT 1 FROM public.attendance_correction q WHERE q.id=p_subject AND q.tenant_id=t AND q.employment_id=p_employment))
  OR (subject_kind='replacement_leave_request' AND NOT EXISTS(SELECT 1 FROM public.replacement_leave_request q WHERE q.id=p_subject AND q.tenant_id=t AND q.employment_id=p_employment)) THEN
  RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_assigned_review_prepare(p_kind text,p_id uuid,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,
 p_subject uuid,p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();subject_kind text:=app._assistant_assigned_review_subject_kind(p_kind);
BEGIN
 PERFORM app._assistant_assigned_review_binding(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 -- A preparation in the same privacy-erasure transaction must not create new uncaptured private text.
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
  AND i.tenant_id=t AND i.person_id=ANY(ARRAY[p_person,p_subject_person]))
  OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
   AND i.tenant_id=t AND i.person_id=ANY(ARRAY[p_person,p_subject_person])) THEN
  RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$'
  OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$'
  OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512
  OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN
  RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u
   AND state='awaiting_confirmation' AND expires_at>at_time)>=5
  OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u
   AND created_at>at_time-interval '10 minutes')>=20 THEN
  RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='54000';END IF;
 UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL
  WHERE tenant_id=t AND user_id=u AND action_kind=p_kind AND receipt_subject_id=p_subject AND state='awaiting_confirmation' AND expires_at<=at_time;
 INSERT INTO app.assistant_own_leave_review
  (action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,decision_subject_person_id,receipt_subject_kind,receipt_subject_id,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES(p_kind,p_id,t,u,p_person,p_employment,p_company,p_subject_person,subject_kind,p_subject,
  p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_assigned_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Nomination only: the trusted command takes the native locks before it reads the review row for update.
CREATE FUNCTION app.assistant_assigned_review_subject(p_id uuid,p_kind text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_leave_decision_login();
 IF app._assistant_assigned_review_subject_kind(p_kind) IS NULL THEN RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind=p_kind;
 IF NOT FOUND THEN RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_leave_decision_login(r.person_id,true);
 RETURN jsonb_build_object('subjectId',r.receipt_subject_id,'mode',CASE WHEN r.state='completed' THEN 'recorded' ELSE 'pending' END);
END $$;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_subject(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_subject(uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Discard is login-only retirement (no subject binding), so a decider who lost access can still retire it.
CREATE FUNCTION app.assistant_assigned_review_read(p_id uuid,p_kind text,p_discard boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_leave_decision_login();
 IF app._assistant_assigned_review_subject_kind(p_kind) IS NULL THEN RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind=p_kind FOR UPDATE NOWAIT;
 IF NOT FOUND OR (p_discard IS TRUE AND r.state='completed') THEN RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
 IF p_discard IS NOT TRUE THEN
  PERFORM app._assistant_assigned_review_binding(r.action_kind,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id);
 END IF;
 IF r.state='awaiting_confirmation' THEN
  IF clock_timestamp()>=r.expires_at THEN
   UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired' WHERE id=r.id;
  ELSIF p_discard IS TRUE THEN
   UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='discarded' WHERE id=r.id;
  END IF;
 END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a
  WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_assigned_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_read(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_read(uuid,text,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_assigned_review_complete(p_id uuid,p_kind text,p_reviewed_digest text,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_leave_decision_login();
 IF app._assistant_assigned_review_subject_kind(p_kind) IS NULL OR p_event IS NULL THEN RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind=p_kind FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_binding(r.action_kind,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id);
 IF r.state='completed' THEN
  IF r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest OR NOT app._assistant_generic_review_verify(r.id,p_event) THEN
   RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='completed',receipt_event_id=p_event WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Decision review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_assigned_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_complete(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_complete(uuid,text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Metadata only, this login's own reviews, same 30-day window as the generic index.
CREATE FUNCTION app.assistant_assigned_reviews_index(p_kind text)
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;
BEGIN
 PERFORM app._assistant_leave_decision_login();
 IF app._assistant_assigned_review_subject_kind(p_kind) IS NULL THEN RAISE EXCEPTION 'Review index unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.action_kind=p_kind
   AND r.created_at>=at_time-interval '30 days' AND r.created_at<=at_time
  ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_assigned_reviews_index(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_reviews_index(text) TO ai_hr_app;
--> statement-breakpoint
-- Outcome linking (ADR-0151 §4.6c): the four kinds join the association list and the 0670 readers.
ALTER TABLE public.ai_native_outcome_association DROP CONSTRAINT ai_native_outcome_association_action;
--> statement-breakpoint
ALTER TABLE public.ai_native_outcome_association ADD CONSTRAINT ai_native_outcome_association_action CHECK(action IN('employees.import',
'org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save','claims.cancel','leave.cancel','leave.edit',
'attendance.overtime.request','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.native_outcome_review_completed(p_kind text,p_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.current_tenant_id() IS NOT NULL
 AND app.principal_snapshot_current() AND p_kind IN('org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save','claims.cancel','leave.cancel','leave.edit','attendance.overtime.request','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide')
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
   WHEN 'approvals.attendance.decide' THEN r.receipt_event_id WHEN 'approvals.toil.decide' THEN r.receipt_event_id END=p_event)))
$$;
REVOKE ALL ON FUNCTION app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.native_outcome_completed_review_choices(p_kinds jsonb)
 RETURNS TABLE(action text,action_id uuid,created_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current()
 OR jsonb_typeof(p_kinds) IS DISTINCT FROM 'array' OR jsonb_array_length(p_kinds) NOT BETWEEN 1 AND 26
 THEN RAISE EXCEPTION 'Outcome choices unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_kinds) v WHERE jsonb_typeof(v)<>'string')
 OR (SELECT count(DISTINCT v) FROM jsonb_array_elements_text(p_kinds) v)<>jsonb_array_length(p_kinds)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_kinds) v WHERE v NOT IN
 ('org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save','claims.cancel','leave.cancel','leave.edit','attendance.overtime.request','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide'))
 THEN RAISE EXCEPTION 'Outcome choices unavailable'; END IF;
 RETURN QUERY SELECT r.action_kind,r.id,r.created_at FROM app.assistant_own_leave_review r
 WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id()
 AND r.state='completed' AND r.action_kind IN(SELECT jsonb_array_elements_text(p_kinds))
 AND r.created_at<=now() AND r.created_at>now()-interval '30 days'
 AND app.native_outcome_capture_available(r.action_kind,r.id)
 ORDER BY r.created_at DESC,r.id DESC LIMIT 26;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_completed_review_choices(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_completed_review_choices(jsonb) TO ai_hr_app;
