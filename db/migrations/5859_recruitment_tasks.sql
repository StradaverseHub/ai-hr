-- Recruitment slice 9 (docs/recruitment-reconstruction/specification.md "Slice 9"): recruitment tasks and updates.
--
-- To-dos and updates are COMPUTED LIVE by packs/recruitment/tasks.ts from the current recruitment records under the
-- viewer's own row security (D-031): nothing here copies a candidate name, a job title or an event into a new row, so a
-- slice 5 removal and a lost job-team membership take effect at once. The only stored state is when a user last marked a
-- category read (D-032).
--
-- What this installs:
--   1. public.recruitment_task_read_marker: one row per tenant, company, user and update category (requisitions, offers,
--      interviews, applications) holding "read up to" — an update is unread when it happened after it. Row security is
--      FORCED: a user reads, adds and moves forward only their own rows, and adds one only for a company whose recruitment
--      they may see (app.can_see_recruitment_company, 4402). The time only moves forward and never past now() (guard).
--      There is no DELETE grant: rows go only with the company's recruitment setup (3 below, through two owner-bound
--      policies) or with the user (ON DELETE CASCADE; logins are archived, not deleted, in practice). No candidate data, no job or requisition reference.
--   2. Indexes for the live reads. The bell provider runs on every authenticated render, so each of its reads starts from
--      the viewer: the pending approval step of an offer or requisition by approver (expression indexes matching
--      `approver_user_ids[pending_position] = app.current_user_id()`, which also serve app.recruitment_viewer and
--      recruitmentTeamPresence), a job's active applications by stage, and an application's open (not cancelled)
--      interviews by stage for the "to schedule" probe. The updates read per job, newest first, within the window:
--      feedback by (job, submitted_at), careers applications by (job, received_at), referrals by (job, created_at); and
--      offers and requisitions touched in the window by creator and by job (every decision updates its row's updated_at).
--   3. app.recruitment_delete_company_setup restated (4408 body byte for byte) plus one step: the company's read markers.
--
-- Nothing here sends a notification or e-mail (D-029), calls a model, or reads anything a viewer could not read already.

-- ── 1. The read marker ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_task_read_marker (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 app_user_id uuid NOT NULL,
 category text NOT NULL CHECK (category IN ('requisitions','offers','interviews','applications')),
 read_up_to timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT recruitment_task_read_marker_pk PRIMARY KEY (tenant_id, app_user_id, company_id, category),
 CONSTRAINT recruitment_task_read_marker_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_task_read_marker_user_fk FOREIGN KEY (app_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX recruitment_task_read_marker_company_idx ON public.recruitment_task_read_marker (company_id, tenant_id);
--> statement-breakpoint
ALTER TABLE public.recruitment_task_read_marker ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.recruitment_task_read_marker FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.recruitment_task_read_marker FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- Own rows only. The policies name no role, so they bind the table owner too (FORCE).
CREATE POLICY recruitment_task_read_marker_own_read ON public.recruitment_task_read_marker FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app_user_id = app.current_user_id());
CREATE POLICY recruitment_task_read_marker_own_insert ON public.recruitment_task_read_marker FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app_user_id = app.current_user_id() AND app.can_see_recruitment_company(company_id));
CREATE POLICY recruitment_task_read_marker_own_update ON public.recruitment_task_read_marker FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app_user_id = app.current_user_id())
 WITH CHECK (tenant_id = app.current_tenant_id() AND app_user_id = app.current_user_id());
-- Only app.recruitment_delete_company_setup deletes markers (the app role has no DELETE grant), and only while it removes
-- this company's setup for an administrator of the company. A DELETE also reads the rows it removes, so the definer needs
-- a matching SELECT policy for every user's marker of that company; both are bound to the table owner (the definer), so
-- the app role cannot use them by setting the context value itself.
CREATE POLICY recruitment_task_read_marker_company_delete ON public.recruitment_task_read_marker FOR DELETE
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_task_read_marker'::regclass))
  AND tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id)
  AND current_setting('app.recruitment_company_delete', true) = company_id::text);
CREATE POLICY recruitment_task_read_marker_company_delete_read ON public.recruitment_task_read_marker FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_task_read_marker'::regclass))
  AND tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id)
  AND current_setting('app.recruitment_company_delete', true) = company_id::text);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.recruitment_task_read_marker TO ai_hr_app;
--> statement-breakpoint
-- A marker keeps its tenant, company, user and category; its time never passes now() and never moves back.
CREATE FUNCTION app.recruitment_guard_task_read_marker() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
   OR NEW.app_user_id IS DISTINCT FROM OLD.app_user_id OR NEW.category IS DISTINCT FROM OLD.category THEN
   RAISE EXCEPTION 'A read marker keeps its user, company and category' USING ERRCODE = '23514';
  END IF;
  NEW.read_up_to := greatest(OLD.read_up_to, least(NEW.read_up_to, now()));
 ELSE
  NEW.read_up_to := least(NEW.read_up_to, now());
 END IF;
 NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_task_read_marker() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_task_read_marker_guard BEFORE INSERT OR UPDATE ON public.recruitment_task_read_marker
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_task_read_marker();
--> statement-breakpoint

-- ── 2. Indexes for the live reads ─────────────────────────────────────────────────────────────────────────────
-- Plain CREATE INDEX inside the migration transaction, like 4401–4408: these tables are new in this unapplied block.
CREATE INDEX recruitment_offer_pending_approver_idx ON public.recruitment_offer (tenant_id, (approver_user_ids[pending_position])) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX recruitment_requisition_pending_approver_idx ON public.recruitment_requisition (tenant_id, (approver_user_ids[pending_position])) WHERE approval_status = 'pending';
--> statement-breakpoint
CREATE INDEX recruitment_application_job_stage_active_idx ON public.recruitment_application (job_id, current_stage_id) WHERE state = 'active';
--> statement-breakpoint
CREATE INDEX recruitment_scorecard_job_submitted_idx ON public.recruitment_scorecard (job_id, submitted_at);
--> statement-breakpoint
CREATE INDEX recruitment_careers_application_job_received_idx ON public.recruitment_careers_application (job_id, received_at);
--> statement-breakpoint
CREATE INDEX recruitment_referral_job_created_idx ON public.recruitment_referral (job_id, created_at);
--> statement-breakpoint
CREATE INDEX recruitment_interview_open_stage_idx ON public.recruitment_interview (application_id, stage_id) WHERE cancelled_at IS NULL;
--> statement-breakpoint
CREATE INDEX recruitment_offer_creator_updated_idx ON public.recruitment_offer (tenant_id, created_by_user_id, updated_at);
--> statement-breakpoint
CREATE INDEX recruitment_offer_job_updated_idx ON public.recruitment_offer (job_id, updated_at);
--> statement-breakpoint
CREATE INDEX recruitment_requisition_creator_updated_idx ON public.recruitment_requisition (tenant_id, created_by_user_id, updated_at);
--> statement-breakpoint

-- ── 3. Deleting a company (core/company-refs.ts): 4408's body plus the read markers ─────────────────────────────
CREATE OR REPLACE FUNCTION app.recruitment_delete_company_setup(p_company uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE removed integer := 0; n integer;
BEGIN
 IF p_company IS NULL OR app.current_tenant_id() IS NULL OR NOT app.is_admin_for(p_company) THEN
  RAISE EXCEPTION 'Deleting a company''s recruitment setup needs its administrator' USING ERRCODE = '42501';
 END IF;
 IF EXISTS (SELECT 1 FROM public.recruitment_job_opening WHERE tenant_id = app.current_tenant_id() AND company_id = p_company)
  OR EXISTS (SELECT 1 FROM public.recruitment_candidate WHERE tenant_id = app.current_tenant_id() AND company_id = p_company)
  OR EXISTS (SELECT 1 FROM public.recruitment_requisition WHERE tenant_id = app.current_tenant_id() AND company_id = p_company) THEN
  RAISE EXCEPTION 'The company has recruitment history' USING ERRCODE = '23503';
 END IF;
 PERFORM set_config('app.recruitment_company_delete', p_company::text, true);
 DELETE FROM public.recruitment_tag WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_tag_group WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_approval_step WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_offer_field WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_company_setting WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 8: the careers page and its privacy notice versions (a consent that names a version needs a candidate, which
 -- refuses the delete as retained history above).
 DELETE FROM public.recruitment_careers_site WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_careers_notice WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_evaluation_form WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_archive_reason WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_process WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_stage WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 9: the users' read markers for the company's recruitment tasks (no candidate data).
 DELETE FROM public.recruitment_task_read_marker WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;
