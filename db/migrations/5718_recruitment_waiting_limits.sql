-- Recruitment slice 17 (docs/recruitment-reconstruction/specification.md "Slice 17"): applications left unprocessed.
--
-- Recruitment administrators set, per company and for any enabled stage, how long an active application may wait in that stage:
-- a reminder after N days (1–365) and, optionally, "suggest archiving" after M days (N < M ≤ 730), counted in calendar days or
-- working days. Waiting is measured from when the application entered its current stage (slice 1 history: the latest 'applied' or
-- 'moved' event whose to_stage_id is the application's current stage; moving resets it, nothing else does). It is COMPUTED when
-- read and never stored per application. Working days skip weekends and the company's public holidays from AI HR's existing
-- holiday calendar (core/holidays.ts companyHolidayDatesByCompany); Kuala Lumpur days throughout (lib/hr-date). The rules only
-- remind and suggest: nothing here archives or rejects anything (D-057). An operator archives from the "Suggested to archive" list
-- through the normal reject path, with an archive reason.
--
-- Who: recruitment administrators (app.can_admin_recruitment_for) write the rules. The company's job teams read them
-- (app.recruitment_team_in_company: the board shows waiting time to a job's reviewers). A rule holds no personal data, so
-- app.recruitment_destroy_candidate is NOT restated: nothing of a candidate can be in this table.
--
-- What this installs:
--   1. public.recruitment_stage_waiting_rule (one per stage) with tenant_id + company_id, ENABLE + FORCE row security, explicit
--      GRANTs to ai_hr_app and none to PUBLIC. CHECKs: reminder 1–365; archive threshold NULL or greater than the reminder and at
--      most 730; day kind calendar or working. The stage is the company's (composite foreign key); a NEW rule names an ENABLED
--      stage (the guard below; a rule kept when its stage is disabled later stays, and can be edited or removed).
--   2. Two indexes. On the application history by (application, stage entered, time) for the entries into a stage, so the time an
--      application entered its current stage is one index probe per application instead of a scan of its history; and on ACTIVE
--      applications by (job, stage, updated_at), so the bounded waiting scans read a job's stage least recently updated first
--      (updated_at is only a sort key that front-loads likely matches; counts come from the history and unread rows are flagged
--      "N+"). CREATE INDEX IF NOT EXISTS inside the
--      migration transaction, like 5706: PRECONDITION — public.recruitment_application_event and public.recruitment_application are
--      empty wherever this applies, because the recruitment tables are new in this release block (5700–5717 are unapplied outside
--      throwaway databases, CI and the branch author's local render database), so there is no populated table to lock. An
--      installation that already holds applications builds both indexes CONCURRENTLY (same names and definitions) before applying
--      this migration; the IF NOT EXISTS statements then leave them as they are.
--   3. app.recruitment_delete_company_setup restated (5717 body byte for byte) plus the rules, before the stages they name.
--
-- Nothing here calls a model, scores a candidate or changes an application.

-- ── 1. The rule table ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_stage_waiting_rule (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 stage_id uuid NOT NULL,
 remind_days integer NOT NULL CHECK (remind_days BETWEEN 1 AND 365),
 archive_days integer CHECK (archive_days IS NULL OR archive_days <= 730),
 day_kind text NOT NULL CHECK (day_kind IN ('calendar','working')),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_stage_waiting_rule_order_ck CHECK (archive_days IS NULL OR archive_days > remind_days),
 CONSTRAINT recruitment_stage_waiting_rule_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_stage_waiting_rule_stage_fk FOREIGN KEY (stage_id, company_id, tenant_id) REFERENCES public.recruitment_stage(id, company_id, tenant_id),
 CONSTRAINT recruitment_stage_waiting_rule_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_stage_waiting_rule_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_stage_waiting_rule_stage_uq UNIQUE (stage_id)
);
CREATE INDEX recruitment_stage_waiting_rule_company_idx ON public.recruitment_stage_waiting_rule (tenant_id, company_id);
CREATE INDEX recruitment_stage_waiting_rule_created_by_idx ON public.recruitment_stage_waiting_rule (created_by_user_id);
CREATE INDEX recruitment_stage_waiting_rule_updated_by_idx ON public.recruitment_stage_waiting_rule (updated_by_user_id);
--> statement-breakpoint
ALTER TABLE public.recruitment_stage_waiting_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruitment_stage_waiting_rule FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.recruitment_stage_waiting_rule FROM PUBLIC, ai_hr_app;
-- Administrators read and write. The policy names no role, so it binds the owner too: inside app.recruitment_delete_company_setup
-- it admits the caller, who administers the company being deleted, and nobody else.
CREATE POLICY recruitment_stage_waiting_rule_admin ON public.recruitment_stage_waiting_rule FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
-- The company's job teams read (the board and the application page show waiting time to a job's reviewers). Never a write.
CREATE POLICY recruitment_stage_waiting_rule_team ON public.recruitment_stage_waiting_rule FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_stage_waiting_rule TO ai_hr_app;
--> statement-breakpoint
-- Guard (runs as the caller): written by the current user; a rule keeps its company, stage and creation record; a NEW rule names an
-- ENABLED stage of its company.
CREATE FUNCTION app.recruitment_guard_stage_waiting_rule() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.updated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A waiting rule is recorded by the current user' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recruitment_stage st WHERE st.id = NEW.stage_id AND st.tenant_id = NEW.tenant_id
   AND st.company_id = NEW.company_id AND st.enabled) THEN
   RAISE EXCEPTION 'Choose an enabled stage of this company' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_stage_waiting_rule_stage';
  END IF;
  NEW.created_at := now();
 ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.stage_id IS DISTINCT FROM OLD.stage_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A waiting rule keeps its company, stage and creation record' USING ERRCODE = '23514';
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_stage_waiting_rule() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_stage_waiting_rule_guard BEFORE INSERT OR UPDATE ON public.recruitment_stage_waiting_rule
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_stage_waiting_rule();
--> statement-breakpoint

-- ── 2. Stage entry time ────────────────────────────────────────────────────────────────────────────────────
-- When an active application entered its current stage: max(occurred_at) over its history rows with that to_stage_id ('applied' and
-- 'moved' are the only kinds that name one). One backward probe of this index per application.
CREATE INDEX IF NOT EXISTS recruitment_application_event_stage_entry_idx ON public.recruitment_application_event (application_id, to_stage_id, occurred_at)
 WHERE to_stage_id IS NOT NULL;
-- Active applications of a job's stage, least recently updated first (the bounded waiting scans).
CREATE INDEX IF NOT EXISTS recruitment_application_active_stage_updated_idx ON public.recruitment_application (job_id, current_stage_id, updated_at)
 WHERE state = 'active';
--> statement-breakpoint

-- ── 3. Deleting a company (core/company-refs.ts): 5717's body plus the waiting rules ─────────────────────────────────────
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
 -- Slice 17: the waiting rules (company setup; no candidate data), before the stages they name. The administrator policy admits
 -- the owner here, as for the position templates.
 DELETE FROM public.recruitment_stage_waiting_rule WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_stage WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 9: the users' read markers for the company's recruitment tasks (no candidate data).
 DELETE FROM public.recruitment_task_read_marker WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 10: the agency setup, children first. Assignments and submissions need a job opening, which refuses above. A
 -- contract's terms and listed users go with it (ON DELETE CASCADE). The administrator policies admit the owner here
 -- because the caller administers the company (app.is_admin_for implies app.can_admin_recruitment_for).
 DELETE FROM public.recruitment_agency_tag_link WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_consultant WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_contract WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_tag WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 11: screening feedback, then the requests it answers. Both need an application, whose job opening refuses the delete
 -- above; they are listed so the remover covers every company table (owner-bound policies on the company being deleted).
 DELETE FROM public.recruitment_screening_answer WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_screening_request WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 12: background checks, children first (files, details, types of a check, checks), then the company's check types.
 -- Checks need an application, whose job opening refuses the delete above (owner-bound policies on the company being
 -- deleted); the types are company setup (the administrator policy admits the owner here, as for the agency tables).
 DELETE FROM public.recruitment_background_check_file WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_detail WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_type_link WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_type WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 13: the blocked list (history, marks, restricted values, entries — each needs a candidate, which refuses the delete
 -- above; listed so the remover covers every company table), then the pools: memberships (need a candidate too), shares,
 -- sub-pools, pools (real company setup). Owner-bound policies on the company being deleted.
 DELETE FROM public.recruitment_blocked_history WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_application_review_mark WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_blocked_entry_restricted WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_blocked_entry WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool_member WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool_share WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool WHERE tenant_id = app.current_tenant_id() AND company_id = p_company AND parent_id IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 14: custom values (each needs a candidate or a job, which refuses the delete above; listed so the remover covers
 -- every company table; owner-bound policies on the company being deleted), then the options and the fields (company setup;
 -- the administrator policy admits the owner here, as for the check types). Options before their fields.
 DELETE FROM public.recruitment_candidate_custom_restricted WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_candidate_custom_value WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_job_custom_value WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_custom_field_option WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_custom_field WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 15: position templates (company setup; a job opening made from one needs a job, which refuses the delete above).
 -- Their custom values first (they also go with the template, ON DELETE CASCADE; listed so the count covers them), then the
 -- templates. The administrator policy admits the owner here, as for the custom fields.
 DELETE FROM public.recruitment_position_template_value WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_position_template WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 16: the import notes and To assign markers (each needs a candidate, which refuses the delete above), the import rows and
 -- the imports (an import whose every row was refused names no candidate, so it can exist without one), then the export templates
 -- (company setup; the administrator policy admits the owner here). Owner-bound policies on the company being deleted.
 DELETE FROM public.recruitment_candidate_import_note WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_to_assign WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_candidate_import_row WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_candidate_import WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_export_template WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;
