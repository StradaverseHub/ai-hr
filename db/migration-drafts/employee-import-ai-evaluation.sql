-- Centrally reserved source-only: 0620_employee_import_ai_evaluation, idx620, timestamp1792997586572.
-- UNJOURNALED / UNAPPLIED. Depends on coordinated 0612 and AI0613–0619; not a release artifact.
-- Header-only mapping custody. No original file, row values, file name, heading or prompt retained.
CREATE TABLE public.personnel_import_assistance_attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 user_id uuid NOT NULL REFERENCES public.app_user(id),
 company_id uuid NOT NULL REFERENCES public.company(id),
 operation_nonce uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version=1),
 source_revision text NOT NULL CHECK(source_revision~'^[a-f0-9]{64}$'),
 registry_digest text NOT NULL CHECK(registry_digest~'^[a-f0-9]{64}$'),
 headers_digest text NOT NULL CHECK(headers_digest~'^[a-f0-9]{64}$'),
 input_digest text NOT NULL CHECK(input_digest~'^[a-f0-9]{64}$'),
 evaluation_id uuid,evaluation_version integer,
 CHECK((evaluation_id IS NULL AND evaluation_version IS NULL) OR (evaluation_id IS NOT NULL AND evaluation_version IS NOT NULL AND evaluation_version BETWEEN 1 AND 1000000)),
 header_indexes jsonb NOT NULL CHECK(jsonb_typeof(header_indexes)='array' AND jsonb_array_length(header_indexes) BETWEEN 1 AND 128),
 mode text NOT NULL CHECK(mode IN ('deterministic','ai')),
 state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','dispatched','completed','failed')),
 ai_run_id uuid UNIQUE REFERENCES public.ai_model_run(id),
 receipt text CHECK(receipt IS NULL OR octet_length(receipt) BETWEEN 1 AND 65536),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 dispatched_at timestamptz,
 completed_at timestamptz,
 UNIQUE(tenant_id,user_id,operation_nonce),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
 CHECK(mode<>'ai' OR jsonb_array_length(header_indexes)<=32),
 CHECK((mode='deterministic' AND ai_run_id IS NULL AND dispatched_at IS NULL AND state IN ('ready','completed')) OR
  (mode='ai' AND ((state='ready' AND ai_run_id IS NULL AND dispatched_at IS NULL) OR (state IN ('dispatched','completed','failed') AND ai_run_id IS NOT NULL AND dispatched_at IS NOT NULL)))),
 CHECK((state IN ('ready','dispatched') AND receipt IS NULL AND completed_at IS NULL) OR
  (state='completed' AND receipt IS NOT NULL AND completed_at IS NOT NULL) OR (state='failed' AND receipt IS NULL AND completed_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE public.personnel_import_assistance_attempt ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.personnel_import_assistance_attempt FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY personnel_import_assistance_own_read ON public.personnel_import_assistance_attempt FOR SELECT TO ai_hr_app USING(
 tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current()
 AND app.access_workforce_company(company_id,'workforce.view') AND app.access_workforce_company(company_id,'workforce.maintain'));
--> statement-breakpoint
CREATE POLICY personnel_import_assistance_own_insert ON public.personnel_import_assistance_attempt FOR INSERT TO ai_hr_app WITH CHECK(
 tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=company_id AND c.tenant_id=app.current_tenant_id())
 AND app.access_workforce_company(company_id,'workforce.view') AND app.access_workforce_company(company_id,'workforce.maintain')
 AND state='ready' AND ai_run_id IS NULL AND receipt IS NULL);
--> statement-breakpoint
CREATE POLICY personnel_import_assistance_own_update ON public.personnel_import_assistance_attempt FOR UPDATE TO ai_hr_app USING(
 tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND expires_at>now() AND app.principal_snapshot_current()
 AND app.access_workforce_company(company_id,'workforce.view') AND app.access_workforce_company(company_id,'workforce.maintain')) WITH CHECK(
 tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND expires_at>now() AND app.principal_snapshot_current()
 AND app.access_workforce_company(company_id,'workforce.view') AND app.access_workforce_company(company_id,'workforce.maintain')
 AND (ai_run_id IS NULL OR EXISTS(SELECT 1 FROM public.ai_model_run r WHERE r.id=ai_run_id AND r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.feature_id='personnel_import_mapping')));
--> statement-breakpoint
-- Identity-only all-own erasure uses DELETE without WHERE/RETURNING; filtered deletes still require SELECT visibility.
CREATE POLICY personnel_import_assistance_own_delete ON public.personnel_import_assistance_attempt FOR DELETE TO ai_hr_app USING(
 tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current());
--> statement-breakpoint
CREATE POLICY personnel_import_assistance_expired_read ON public.personnel_import_assistance_attempt FOR SELECT TO PUBLIC USING(
 expires_at<=now() AND current_user=session_user AND session_user<>'ai_hr_app'
 AND session_user=pg_get_userbyid((SELECT c.relowner FROM pg_class c WHERE c.oid='public.personnel_import_assistance_attempt'::regclass)));
--> statement-breakpoint
CREATE POLICY personnel_import_assistance_expired_delete ON public.personnel_import_assistance_attempt FOR DELETE TO PUBLIC USING(
 expires_at<=now() AND current_user=session_user AND session_user<>'ai_hr_app'
 AND session_user=pg_get_userbyid((SELECT c.relowner FROM pg_class c WHERE c.oid='public.personnel_import_assistance_attempt'::regclass)));
--> statement-breakpoint
CREATE POLICY personnel_import_assistance_expired_lock ON public.personnel_import_assistance_attempt FOR UPDATE TO PUBLIC USING(
 expires_at<=now() AND current_user=session_user AND session_user<>'ai_hr_app'
 AND session_user=pg_get_userbyid((SELECT c.relowner FROM pg_class c WHERE c.oid='public.personnel_import_assistance_attempt'::regclass))) WITH CHECK(false);
--> statement-breakpoint
GRANT SELECT,DELETE ON public.personnel_import_assistance_attempt TO ai_hr_app;
--> statement-breakpoint
GRANT INSERT(id,tenant_id,user_id,company_id,operation_nonce,source_revision,registry_digest,headers_digest,input_digest,header_indexes,mode,evaluation_id,evaluation_version) ON public.personnel_import_assistance_attempt TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE(state,ai_run_id,dispatched_at,receipt,completed_at) ON public.personnel_import_assistance_attempt TO ai_hr_app;
--> statement-breakpoint
CREATE INDEX personnel_import_assistance_expiry ON public.personnel_import_assistance_attempt(expires_at,tenant_id,id);

--> statement-breakpoint
-- Separate metadata-first 30-day workflow custody. No raw source or clear-text source/input hashes.
CREATE TABLE public.employee_import_evaluation_attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),user_id uuid NOT NULL REFERENCES public.app_user(id),
 company_id uuid NOT NULL REFERENCES public.company(id),cohort_id uuid NOT NULL,operation_nonce uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 1000000),mode text NOT NULL CHECK(mode IN ('baseline','assisted')),
 binding_ciphertext text NOT NULL CHECK(octet_length(binding_ciphertext) BETWEEN 1 AND 4096),
 state text NOT NULL DEFAULT 'collecting' CHECK(state IN ('collecting','prepared','committed')),commit_nonce uuid,
 event_id uuid UNIQUE REFERENCES public.domain_event(id),canonical_counts jsonb,
 observations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(observations)='array' AND jsonb_array_length(observations)<=32 AND octet_length(observations::text)<=65536),
 reused_associations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(reused_associations)='array' AND jsonb_array_length(reused_associations)<=32 AND octet_length(reused_associations::text)<=8192),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '720 hours',write_started_at timestamptz,completion_marked_at timestamptz,
 UNIQUE(tenant_id,user_id,operation_nonce),CHECK(expires_at>created_at AND expires_at<=created_at+interval '720 hours'),
 CHECK((state='collecting' AND commit_nonce IS NULL AND event_id IS NULL AND canonical_counts IS NULL AND completion_marked_at IS NULL AND write_started_at IS NULL) OR
  (state='prepared' AND commit_nonce IS NOT NULL AND event_id IS NULL AND canonical_counts IS NULL AND completion_marked_at IS NULL) OR
  (state='committed' AND commit_nonce IS NOT NULL AND event_id IS NOT NULL AND canonical_counts IS NOT NULL AND jsonb_typeof(canonical_counts)='object' AND write_started_at IS NOT NULL AND completion_marked_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE public.employee_import_evaluation_attempt ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employee_import_evaluation_attempt FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY employee_import_evaluation_own_read ON public.employee_import_evaluation_attempt FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current() AND app.access_workforce_company(company_id,'workforce.view') AND app.access_workforce_company(company_id,'workforce.maintain'));
--> statement-breakpoint
CREATE POLICY employee_import_evaluation_own_insert ON public.employee_import_evaluation_attempt FOR INSERT TO ai_hr_app WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=company_id AND c.tenant_id=app.current_tenant_id()) AND app.access_workforce_company(company_id,'workforce.view') AND app.access_workforce_company(company_id,'workforce.maintain') AND state='collecting' AND version=1 AND event_id IS NULL AND canonical_counts IS NULL AND observations='[]'::jsonb AND reused_associations='[]'::jsonb);
--> statement-breakpoint
CREATE POLICY employee_import_evaluation_own_update ON public.employee_import_evaluation_attempt FOR UPDATE TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND expires_at>now() AND app.principal_snapshot_current() AND app.access_workforce_company(company_id,'workforce.view') AND app.access_workforce_company(company_id,'workforce.maintain')) WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND expires_at>now() AND app.principal_snapshot_current() AND app.access_workforce_company(company_id,'workforce.view') AND app.access_workforce_company(company_id,'workforce.maintain') AND (event_id IS NULL OR EXISTS(SELECT 1 FROM public.domain_event d WHERE d.id=event_id AND d.tenant_id=app.current_tenant_id() AND d.actor_type='user' AND d.actor_id=app.current_user_id() AND d.aggregate_type='employee-import' AND d.aggregate_id=company_id AND d.event_type='employee-import.completed')));
--> statement-breakpoint
CREATE POLICY employee_import_evaluation_own_delete ON public.employee_import_evaluation_attempt FOR DELETE TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current());
--> statement-breakpoint
CREATE POLICY employee_import_evaluation_expired_read ON public.employee_import_evaluation_attempt FOR SELECT TO PUBLIC USING(expires_at<=now() AND current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT c.relowner FROM pg_class c WHERE c.oid='public.employee_import_evaluation_attempt'::regclass)));
--> statement-breakpoint
CREATE POLICY employee_import_evaluation_expired_delete ON public.employee_import_evaluation_attempt FOR DELETE TO PUBLIC USING(expires_at<=now() AND current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT c.relowner FROM pg_class c WHERE c.oid='public.employee_import_evaluation_attempt'::regclass)));
--> statement-breakpoint
CREATE POLICY employee_import_evaluation_expired_lock ON public.employee_import_evaluation_attempt FOR UPDATE TO PUBLIC USING(expires_at<=now() AND current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT c.relowner FROM pg_class c WHERE c.oid='public.employee_import_evaluation_attempt'::regclass))) WITH CHECK(false);
--> statement-breakpoint
GRANT SELECT,DELETE ON public.employee_import_evaluation_attempt TO ai_hr_app;
--> statement-breakpoint
GRANT INSERT(id,tenant_id,user_id,company_id,cohort_id,operation_nonce,mode,binding_ciphertext) ON public.employee_import_evaluation_attempt TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE(version,state,commit_nonce,binding_ciphertext,event_id,canonical_counts,write_started_at,completion_marked_at,observations,reused_associations) ON public.employee_import_evaluation_attempt TO ai_hr_app;
--> statement-breakpoint
CREATE INDEX employee_import_evaluation_expiry ON public.employee_import_evaluation_attempt(expires_at,tenant_id,id);
--> statement-breakpoint
-- Global per-run uniqueness prevents assigning one actual charge to two jobs. Header ID is opaque:
-- header receipts expire earlier, but their actual admitted-run membership must survive until job expiry.
CREATE TABLE public.employee_import_evaluation_run_membership(
 ai_run_id uuid PRIMARY KEY REFERENCES public.ai_model_run(id),evaluation_id uuid NOT NULL REFERENCES public.employee_import_evaluation_attempt(id) ON DELETE CASCADE,
 evaluation_version integer NOT NULL CHECK(evaluation_version BETWEEN 1 AND 1000000),slot integer NOT NULL CHECK(slot BETWEEN 1 AND 128),tenant_id uuid NOT NULL REFERENCES public.tenant(id),user_id uuid NOT NULL REFERENCES public.app_user(id),company_id uuid NOT NULL REFERENCES public.company(id),header_attempt_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(evaluation_id,slot)
);
--> statement-breakpoint
ALTER TABLE public.employee_import_evaluation_run_membership ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employee_import_evaluation_run_membership FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY employee_import_evaluation_membership_read ON public.employee_import_evaluation_run_membership FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employee_import_evaluation_attempt e WHERE e.id=evaluation_id AND e.tenant_id=app.current_tenant_id() AND e.user_id=app.current_user_id() AND e.company_id=employee_import_evaluation_run_membership.company_id));
--> statement-breakpoint
CREATE POLICY employee_import_evaluation_membership_insert ON public.employee_import_evaluation_run_membership FOR INSERT TO ai_hr_app WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employee_import_evaluation_attempt e WHERE e.id=evaluation_id AND e.tenant_id=app.current_tenant_id() AND e.user_id=app.current_user_id() AND e.company_id=employee_import_evaluation_run_membership.company_id AND e.version=evaluation_version AND e.mode='assisted' AND e.state<>'committed' AND e.expires_at>now()) AND EXISTS(SELECT 1 FROM public.ai_model_run r JOIN public.personnel_import_assistance_attempt a ON a.ai_run_id=r.id WHERE r.id=employee_import_evaluation_run_membership.ai_run_id AND r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.feature_id='personnel_import_mapping' AND r.state='pending' AND r.xmin=pg_current_xact_id()::xid AND a.id=employee_import_evaluation_run_membership.header_attempt_id AND a.tenant_id=r.tenant_id AND a.user_id=r.user_id AND a.company_id=employee_import_evaluation_run_membership.company_id AND a.evaluation_id=employee_import_evaluation_run_membership.evaluation_id AND a.evaluation_version=employee_import_evaluation_run_membership.evaluation_version AND a.state='dispatched'));
--> statement-breakpoint
GRANT SELECT ON public.employee_import_evaluation_run_membership TO ai_hr_app;
--> statement-breakpoint
GRANT INSERT(ai_run_id,evaluation_id,evaluation_version,slot,tenant_id,user_id,company_id,header_attempt_id) ON public.employee_import_evaluation_run_membership TO ai_hr_app;
--> statement-breakpoint
CREATE INDEX employee_import_evaluation_membership_job ON public.employee_import_evaluation_run_membership(evaluation_id,ai_run_id);
--> statement-breakpoint
-- Added after the referenced workflow table exists; posted context cannot retarget a prepared header.
CREATE POLICY personnel_import_assistance_evaluation_insert ON public.personnel_import_assistance_attempt AS RESTRICTIVE FOR INSERT TO ai_hr_app WITH CHECK(evaluation_id IS NULL OR EXISTS(SELECT 1 FROM public.employee_import_evaluation_attempt e WHERE e.id=evaluation_id AND e.tenant_id=app.current_tenant_id() AND e.user_id=app.current_user_id() AND e.company_id=personnel_import_assistance_attempt.company_id AND e.version=evaluation_version AND e.state<>'committed' AND e.expires_at>now() AND (personnel_import_assistance_attempt.mode='deterministic' OR e.mode='assisted')));
