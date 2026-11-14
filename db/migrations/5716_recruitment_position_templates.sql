-- Recruitment slice 15 (docs/recruitment-reconstruction/specification.md "Slice 15"): position templates.
--
-- Recruitment administrators keep their company's own position templates (no industry JD library: D-054): a name (unique in
-- the company, ≤120), the job title, description, work location, employment type, recruitment type, job levels, business unit,
-- department, the recruitment process, the interview plan (ordered rounds, each with a scorecard template: an evaluation form,
-- slice 2) and values for enabled custom job fields (slice 14). Only the name and the title are required. "New position from
-- template" opens the ordinary new-position form pre-filled; every position rule applies on save. The position records which
-- template it came from (for reporting) and nothing else: it never stays linked, and later template edits change no position.
-- A company setting turns the feature on (default off).
--
-- Who: recruitment administrators (app.can_admin_recruitment_for) write templates and the setting. The readers are everyone who
-- may create a position in the company (slice 1) — exactly the same predicate today, because a job opening is inserted only
-- through recruitment_job_opening_admin; the service offers non-managing creators the ENABLED templates only. Nobody else reads
-- a template. Templates hold no personal data (no "employee to be replaced", no people), so app.recruitment_destroy_candidate
-- is NOT restated: nothing of a candidate can be in these tables.
--
-- What this installs:
--   1. recruitment_company_setting.position_templates_enabled (default false).
--   2. Two tables with tenant_id + company_id, ENABLE + FORCE row security, explicit GRANTs to ai_hr_app and none to PUBLIC:
--        recruitment_position_template         the template (administrators read and write)
--        recruitment_position_template_value   its custom job field values, typed exactly as recruitment_job_custom_value
--                                              (one row per field; one per chosen option for multiple choice; a CHECK ties
--                                              the filled column to the type), removed with the template (ON DELETE CASCADE)
--   3. References are checked when written and resolved when read. A template names its process, department, business unit,
--      job levels, scorecard templates, custom fields and options by id WITHOUT a foreign key to them: the guard below accepts
--      only the company's enabled or live ones when a reference is set or changed (a custom value: an ENABLED job field of the
--      company with the same type, a number within its range and decimals, an ENABLED option of that field — the slice 14 value
--      rules), and an unchanged reference that has since been disabled or removed stays. The service opens such a template
--      with the missing parts left empty and a plain note. So a template never blocks an administrator from disabling or
--      deleting a process, form, field or option, and a reference never crosses companies.
--   4. recruitment_job_opening.created_from_template_id (nullable; the foreign key sets only this column to NULL when the
--      template is deleted) and recruitment_job_opening.interview_plan_form_ids (the job's interview plan: one scorecard
--      template per round, in order; empty = the slice 2 default rounds, D-005). A new job may name only an ENABLED template of
--      its company while the company setting is on; the template never changes afterwards and only its delete clears it. A plan
--      names enabled forms of the job's company when a form is added, with no empty round before a filled one (the service
--      refuses gaps); a form disabled later stays in a plan that keeps it.
--   5. app.recruitment_delete_company_setup restated (5715 body byte for byte) plus the two tables (values, then templates).
--
-- Nothing here calls a model, scores anything or copies a template into a position by itself.

-- ── 1. The company setting ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.recruitment_company_setting ADD COLUMN position_templates_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- ── 2. Tables ──────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_position_template (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
 title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
 description text CHECK (description IS NULL OR char_length(description) <= 20000),
 work_location text CHECK (work_location IS NULL OR char_length(btrim(work_location)) BETWEEN 1 AND 200),
 employment_type text CHECK (employment_type IS NULL OR employment_type IN ('full_time','part_time','contract','intern')),
 recruitment_type text CHECK (recruitment_type IS NULL OR recruitment_type IN ('budgeted','unbudgeted','replacement')),
 job_grade_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(job_grade_ids) <= 50 AND array_position(job_grade_ids, NULL) IS NULL),
 business_unit_id uuid,
 department_id uuid,
 process_id uuid,
 interview_plan_form_ids uuid[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(interview_plan_form_ids) <= 10 AND array_position(interview_plan_form_ids, NULL) IS NULL),
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_position_template_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_position_template_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_position_template_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_position_template_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_position_template_name_uq ON public.recruitment_position_template (tenant_id, company_id, lower(btrim(name)));
CREATE INDEX recruitment_position_template_enabled_idx ON public.recruitment_position_template (tenant_id, company_id, enabled);
CREATE INDEX recruitment_position_template_created_by_idx ON public.recruitment_position_template (created_by_user_id);
CREATE INDEX recruitment_position_template_updated_by_idx ON public.recruitment_position_template (updated_by_user_id);
--> statement-breakpoint
-- The template's custom job field values: recruitment_job_custom_value's shape and typed CHECK, filed under the template. The
-- field and option are named without a foreign key (see 3 in the header): the guard checks them when written.
CREATE TABLE public.recruitment_position_template_value (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 template_id uuid NOT NULL,
 field_id uuid NOT NULL,
 field_type text NOT NULL,
 text_value text,
 number_value numeric CHECK (number_value IS NULL OR (abs(number_value) < 1e15 AND number_value = round(number_value, 4))),
 date_value date,
 bool_value boolean,
 option_id uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_position_template_value_typed_ck CHECK (CASE field_type
  WHEN 'short_text' THEN char_length(btrim(text_value)) BETWEEN 1 AND 200 AND num_nonnulls(number_value, date_value, bool_value, option_id) = 0
  WHEN 'long_text' THEN char_length(btrim(text_value)) BETWEEN 1 AND 4000 AND num_nonnulls(number_value, date_value, bool_value, option_id) = 0
  WHEN 'number' THEN number_value IS NOT NULL AND num_nonnulls(text_value, date_value, bool_value, option_id) = 0
  WHEN 'date' THEN date_value IS NOT NULL AND num_nonnulls(text_value, number_value, bool_value, option_id) = 0
  WHEN 'year_month' THEN date_value IS NOT NULL AND extract(day FROM date_value) = 1 AND num_nonnulls(text_value, number_value, bool_value, option_id) = 0
  WHEN 'single_choice' THEN option_id IS NOT NULL AND num_nonnulls(text_value, number_value, date_value, bool_value) = 0
  WHEN 'multiple_choice' THEN option_id IS NOT NULL AND num_nonnulls(text_value, number_value, date_value, bool_value) = 0
  WHEN 'yes_no' THEN bool_value IS NOT NULL AND num_nonnulls(text_value, number_value, date_value, option_id) = 0
  ELSE false END),
 CONSTRAINT recruitment_position_template_value_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_position_template_value_template_fk FOREIGN KEY (template_id, company_id, tenant_id)
  REFERENCES public.recruitment_position_template(id, company_id, tenant_id) ON DELETE CASCADE,
 CONSTRAINT recruitment_position_template_value_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
-- One value per template and field, except one row per chosen option for multiple choice.
CREATE UNIQUE INDEX recruitment_position_template_value_one_uq ON public.recruitment_position_template_value (template_id, field_id)
 WHERE field_type <> 'multiple_choice';
CREATE UNIQUE INDEX recruitment_position_template_value_option_uq ON public.recruitment_position_template_value (template_id, field_id, option_id)
 WHERE field_type = 'multiple_choice';
CREATE INDEX recruitment_position_template_value_company_idx ON public.recruitment_position_template_value (tenant_id, company_id);
CREATE INDEX recruitment_position_template_value_updated_by_idx ON public.recruitment_position_template_value (updated_by_user_id);
--> statement-breakpoint
-- The job's template and interview plan. The foreign key's SET NULL names only created_from_template_id: the job keeps its
-- company and tenant when its template is deleted.
ALTER TABLE public.recruitment_job_opening
 ADD COLUMN created_from_template_id uuid,
 ADD COLUMN interview_plan_form_ids uuid[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(interview_plan_form_ids) <= 10 AND array_position(interview_plan_form_ids, NULL) IS NULL),
 ADD CONSTRAINT recruitment_job_opening_template_fk FOREIGN KEY (created_from_template_id, company_id, tenant_id)
  REFERENCES public.recruitment_position_template(id, company_id, tenant_id) ON DELETE SET NULL (created_from_template_id);
CREATE INDEX recruitment_job_opening_template_idx ON public.recruitment_job_opening (created_from_template_id) WHERE created_from_template_id IS NOT NULL;
--> statement-breakpoint

-- ── 3. Row security and grants ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_position_template','recruitment_position_template_value'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
  -- Administrators read and write; they are also everyone who may create a position (see the header). The policy names no
  -- role, so it binds the owner too: inside app.recruitment_delete_company_setup it admits the caller, who administers the
  -- company being deleted, and nobody else.
  EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL
   USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
   WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))', t || '_admin', t);
 END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_position_template, public.recruitment_position_template_value TO ai_hr_app;
--> statement-breakpoint

-- ── 4. Guards (run as the caller) ──────────────────────────────────────────────────────────────────────────
-- Templates: written by the current user; keep their company and creation record. A reference that is SET or CHANGED must be
-- the company's own and usable now (an enabled process; a live department or business unit of the company or a global one; live
-- job levels offered to the company; enabled evaluation forms); one left unchanged may since have been disabled or removed.
CREATE FUNCTION app.recruitment_guard_position_template() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE fresh boolean := TG_OP = 'INSERT';
BEGIN
 IF fresh THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.updated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A position template is recorded by the current user' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();
 ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A position template keeps its company and creation record' USING ERRCODE = '23514';
 END IF;
 IF NEW.process_id IS NOT NULL AND (fresh OR NEW.process_id IS DISTINCT FROM OLD.process_id) AND NOT EXISTS (
  SELECT 1 FROM public.recruitment_process p WHERE p.id = NEW.process_id AND p.tenant_id = NEW.tenant_id AND p.company_id = NEW.company_id AND p.enabled) THEN
  RAISE EXCEPTION 'Choose an enabled recruitment process of this company' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_position_template_reference';
 END IF;
 IF NEW.department_id IS NOT NULL AND (fresh OR NEW.department_id IS DISTINCT FROM OLD.department_id) AND NOT EXISTS (
  SELECT 1 FROM public.department d WHERE d.id = NEW.department_id AND d.tenant_id = NEW.tenant_id AND d.archived_at IS NULL
   AND (d.company_id = NEW.company_id OR d.is_global)) THEN
  RAISE EXCEPTION 'Choose a department of this company' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_position_template_reference';
 END IF;
 IF NEW.business_unit_id IS NOT NULL AND (fresh OR NEW.business_unit_id IS DISTINCT FROM OLD.business_unit_id) AND NOT EXISTS (
  SELECT 1 FROM public.business_unit b WHERE b.id = NEW.business_unit_id AND b.tenant_id = NEW.tenant_id AND b.archived_at IS NULL
   AND (b.company_id = NEW.company_id OR b.is_global)) THEN
  RAISE EXCEPTION 'Choose a business unit of this company' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_position_template_reference';
 END IF;
 IF EXISTS (SELECT 1 FROM unnest(NEW.job_grade_ids) AS x(id) WHERE (fresh OR x.id <> ALL (OLD.job_grade_ids)) AND NOT EXISTS (
  SELECT 1 FROM public.job_grade g WHERE g.id = x.id AND g.tenant_id = NEW.tenant_id AND g.archived_at IS NULL
   AND (g.scope_company_ids IS NULL OR cardinality(g.scope_company_ids) = 0 OR NEW.company_id = ANY (g.scope_company_ids)))) THEN
  RAISE EXCEPTION 'Choose job levels offered to this company' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_position_template_reference';
 END IF;
 IF EXISTS (SELECT 1 FROM unnest(NEW.interview_plan_form_ids) AS x(id) WHERE (fresh OR x.id <> ALL (OLD.interview_plan_form_ids)) AND NOT EXISTS (
  SELECT 1 FROM public.recruitment_evaluation_form f WHERE f.id = x.id AND f.tenant_id = NEW.tenant_id AND f.company_id = NEW.company_id AND f.enabled)) THEN
  RAISE EXCEPTION 'Choose enabled scorecard templates of this company' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_position_template_reference';
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_position_template() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_position_template_guard BEFORE INSERT OR UPDATE ON public.recruitment_position_template
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_position_template();
--> statement-breakpoint
-- Template values: the slice 14 value rules (app.recruitment_guard_custom_value) for a job field, with the template in place of
-- the job: an ENABLED job field of the template's company whose type is the value's type, a number within the field's range and
-- decimals, an ENABLED option of that field when one is newly chosen. A value keeps its template and field. The writer is the
-- current user. Clearing (DELETE) is not checked here: row security decides who may.
CREATE FUNCTION app.recruitment_guard_position_template_value() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE f public.recruitment_custom_field%ROWTYPE;
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.field_id IS DISTINCT FROM OLD.field_id) THEN
  RAISE EXCEPTION 'A template value keeps its template and field' USING ERRCODE = '23514';
 END IF;
 SELECT * INTO f FROM public.recruitment_custom_field WHERE id = NEW.field_id AND tenant_id = NEW.tenant_id;
 IF NOT FOUND OR NOT f.enabled OR f.record_kind <> 'job' OR f.company_id <> NEW.company_id OR f.field_type <> NEW.field_type THEN
  RAISE EXCEPTION 'Choose an enabled custom job field of this company' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_custom_field_disabled';
 END IF;
 IF f.field_type = 'number' AND ((f.number_min IS NOT NULL AND NEW.number_value < f.number_min)
  OR (f.number_max IS NOT NULL AND NEW.number_value > f.number_max) OR NEW.number_value <> round(NEW.number_value, f.number_decimals)) THEN
  RAISE EXCEPTION 'The number is outside the field''s range or has too many decimals' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_custom_value_range';
 END IF;
 IF NEW.option_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.option_id IS DISTINCT FROM OLD.option_id)
  AND NOT EXISTS (SELECT 1 FROM public.recruitment_custom_field_option o WHERE o.id = NEW.option_id AND o.field_id = NEW.field_id AND o.enabled) THEN
  RAISE EXCEPTION 'Choose an enabled option' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_custom_option_disabled';
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_position_template_value() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_position_template_value_guard BEFORE INSERT OR UPDATE ON public.recruitment_position_template_value
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_position_template_value();
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_position_template','recruitment_position_template_value'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_identity()', t || '_identity', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Jobs: a NEW job may name an ENABLED template of its company while the company's setting is on; afterwards the template only
-- ever becomes NULL, and only through the template's delete: inside the foreign key's SET NULL action (a nested trigger,
-- pg_trigger_depth() > 1) or once the template no longer exists — never by a direct UPDATE while it does. An interview plan
-- names enabled evaluation forms of the job's company when a form is added (one kept from before may since have been disabled).
CREATE FUNCTION app.recruitment_guard_job_template() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' AND NEW.created_from_template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.recruitment_position_template t JOIN public.recruitment_company_setting s ON s.company_id = t.company_id AND s.tenant_id = t.tenant_id
  WHERE t.id = NEW.created_from_template_id AND t.tenant_id = NEW.tenant_id AND t.company_id = NEW.company_id AND t.enabled AND s.position_templates_enabled) THEN
  RAISE EXCEPTION 'Choose an enabled position template of this company' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_job_template_unavailable';
 END IF;
 IF TG_OP = 'UPDATE' AND NEW.created_from_template_id IS NOT NULL AND NEW.created_from_template_id IS DISTINCT FROM OLD.created_from_template_id THEN
  RAISE EXCEPTION 'A job keeps the template it was created from' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_job_template_unavailable';
 END IF;
 IF TG_OP = 'UPDATE' AND NEW.created_from_template_id IS NULL AND OLD.created_from_template_id IS NOT NULL AND pg_trigger_depth() <= 1
  AND EXISTS (SELECT 1 FROM public.recruitment_position_template t WHERE t.id = OLD.created_from_template_id AND t.tenant_id = OLD.tenant_id) THEN
  RAISE EXCEPTION 'A job keeps the template it was created from' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_job_template_unavailable';
 END IF;
 IF EXISTS (SELECT 1 FROM unnest(NEW.interview_plan_form_ids) AS x(id) WHERE (TG_OP = 'INSERT' OR x.id <> ALL (OLD.interview_plan_form_ids)) AND NOT EXISTS (
  SELECT 1 FROM public.recruitment_evaluation_form f WHERE f.id = x.id AND f.tenant_id = NEW.tenant_id AND f.company_id = NEW.company_id AND f.enabled)) THEN
  RAISE EXCEPTION 'Choose enabled scorecard templates of this company' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_job_interview_plan_form';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_job_template() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_job_opening_template_guard BEFORE INSERT OR UPDATE OF created_from_template_id, interview_plan_form_ids
 ON public.recruitment_job_opening FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_job_template();
--> statement-breakpoint

-- ── 5. Deleting a company (core/company-refs.ts): 5715's body plus the position templates ────────────────────────
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
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;
