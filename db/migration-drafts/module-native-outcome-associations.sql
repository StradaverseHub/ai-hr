-- SOURCE ONLY, UNALLOCATED / UNJOURNALED / UNAPPLIED. No migration number is reserved here.
-- Evidence association metadata, NOT an execution ledger or permission to replay an action.
-- SQL integrity alone never proves canonical-engine provenance; trusted native owners still do.
CREATE FUNCTION app.native_outcome_review_completed(p_kind text,p_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.current_tenant_id() IS NOT NULL
 AND app.principal_snapshot_current() AND p_kind IN('org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save')
 AND EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.id=p_id AND r.tenant_id=app.current_tenant_id()
  AND r.user_id=app.current_user_id() AND r.action_kind=p_kind AND r.state='completed'
  AND r.created_at<=now() AND r.created_at>now()-interval '30 days')
$$;
REVOKE ALL ON FUNCTION app.native_outcome_review_completed(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_review_completed(text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- This is a new bounded association evidence window, NOT pending confirmation expiry or a
-- claim about physical/native completed receipt retention. Every reopen still rechecks authority.
CREATE FUNCTION app.native_outcome_review_retention(p_kind text,p_id uuid) RETURNS timestamptz
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
 SELECT r.created_at+interval '30 days' FROM app.assistant_own_leave_review r
 WHERE app.native_outcome_review_completed(p_kind,p_id) AND r.id=p_id AND r.action_kind=p_kind
 AND r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id()
$$;
REVOKE ALL ON FUNCTION app.native_outcome_review_retention(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_review_retention(text,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE public.ai_native_outcome_association(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES public.app_user(id) ON DELETE CASCADE,
 person_id uuid REFERENCES public.person(id) ON DELETE CASCADE,job_id uuid NOT NULL REFERENCES public.ai_agent_job_receipt(id) ON DELETE CASCADE,
 request_nonce uuid NOT NULL,request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'),
 action text NOT NULL CHECK(action IN('employees.import','org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save')),source_kind text NOT NULL CHECK(source_kind IN('review','employee_import')),
 review_id uuid REFERENCES app.assistant_own_leave_review(id) ON DELETE CASCADE,
 import_attempt_id uuid REFERENCES public.employee_import_evaluation_attempt(id) ON DELETE CASCADE,
 event_id uuid NOT NULL REFERENCES public.domain_event(id) ON DELETE CASCADE,native_digest text NOT NULL CHECK(native_digest~'^[a-f0-9]{64}$'),
 job_receipt_digest text NOT NULL CHECK(job_receipt_digest~'^[a-f0-9]{64}$'),receipt text NOT NULL CHECK(octet_length(receipt) BETWEEN 1 AND 16384),
 consented boolean NOT NULL CHECK(consented),created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days'),
 CHECK((source_kind='review' AND action<>'employees.import' AND review_id IS NOT NULL AND import_attempt_id IS NULL)
 OR(source_kind='employee_import' AND action='employees.import' AND import_attempt_id IS NOT NULL AND review_id IS NULL)),
 UNIQUE(tenant_id,user_id,request_nonce),UNIQUE(tenant_id,user_id,event_id)
);
ALTER TABLE public.ai_native_outcome_association ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_native_outcome_association FORCE ROW LEVEL SECURITY;
CREATE POLICY native_outcome_own_read ON public.ai_native_outcome_association FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current() AND expires_at>now());
CREATE POLICY native_outcome_own_create ON public.ai_native_outcome_association FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT u.person_id FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id())
 AND app.principal_snapshot_current() AND consented AND EXISTS(SELECT 1 FROM public.ai_agent_job_receipt j
 WHERE j.id=job_id AND j.tenant_id=ai_native_outcome_association.tenant_id AND j.user_id=app.current_user_id() AND j.expires_at>=ai_native_outcome_association.expires_at AND encode(sha256(convert_to(j.receipt,'UTF8')),'hex')=ai_native_outcome_association.job_receipt_digest)
 AND((source_kind='review' AND app.native_outcome_review_completed(action,review_id) AND app.native_outcome_review_retention(action,review_id)>=expires_at) OR(source_kind='employee_import'
 AND EXISTS(SELECT 1 FROM public.employee_import_evaluation_attempt e WHERE e.id=import_attempt_id AND e.tenant_id=app.current_tenant_id()
 AND e.user_id=app.current_user_id() AND e.state='committed' AND e.event_id=ai_native_outcome_association.event_id AND e.expires_at>=ai_native_outcome_association.expires_at))));
-- Own erasure remains possible after Assistant/native grants are revoked; returns no private rows.
CREATE POLICY native_outcome_own_delete ON public.ai_native_outcome_association FOR DELETE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current());
REVOKE ALL ON public.ai_native_outcome_association FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,DELETE ON public.ai_native_outcome_association TO ai_hr_app;
CREATE INDEX native_outcome_expiry ON public.ai_native_outcome_association(expires_at,id);
--> statement-breakpoint
-- Same normal session-owner expired-only retention path; no app table/role/bypass grants.
CREATE POLICY native_outcome_expired_owner_read ON public.ai_native_outcome_association FOR SELECT TO PUBLIC
 USING(expires_at<=now() AND current_user=session_user AND session_user<>'ai_hr_app'
 AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_native_outcome_association'::regclass)));
CREATE POLICY native_outcome_expired_owner_delete ON public.ai_native_outcome_association FOR DELETE TO PUBLIC
 USING(expires_at<=now() AND current_user=session_user AND session_user<>'ai_hr_app'
 AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_native_outcome_association'::regclass)));

--> statement-breakpoint
-- Every physical append/delete, including owner expiry and FK cascade, joins the same custody
-- interval. This grants no data authority; normal privilege/RLS/FK checks remain mandatory.
-- Multi-owner cleanup refuses/rolls back on busy rather than waiting or ignoring a partial set.
CREATE FUNCTION app.native_outcome_custody_mutation_lock() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid; u uuid;
BEGIN
 IF TG_OP='INSERT' THEN t:=NEW.tenant_id;u:=NEW.user_id;
 ELSIF TG_OP='DELETE' THEN t:=OLD.tenant_id;u:=OLD.user_id;
 ELSE RAISE EXCEPTION 'Native outcome custody operation refused'; END IF;
 IF t IS NULL OR u IS NULL OR NOT pg_try_advisory_xact_lock(hashtextextended('native-outcome:v1:'||t::text||':'||u::text,0))
 THEN RAISE EXCEPTION 'Native outcome custody is busy' USING ERRCODE='55P03'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_custody_mutation_lock() FROM PUBLIC;
CREATE TRIGGER native_outcome_custody_mutation BEFORE INSERT OR DELETE ON public.ai_native_outcome_association
 FOR EACH ROW EXECUTE FUNCTION app.native_outcome_custody_mutation_lock();
