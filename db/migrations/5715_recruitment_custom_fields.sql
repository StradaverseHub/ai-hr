-- Recruitment slice 14 (docs/recruitment-reconstruction/specification.md "Slice 14"): custom candidate and job fields.
--
-- Recruitment administrators define extra fields for candidates and for jobs, per company: a label in each of the six
-- locales (English required; the others fall back to English), help text, a type, required or optional, restricted
-- (candidates only), enabled or disabled, and a position. Types: short text (≤200), long text (≤4,000), number (optional
-- minimum, maximum and 0–4 decimals), date, year and month, single choice and multiple choice (options with labels per
-- locale), yes or no. No file or image types (D-051). Whoever may edit a candidate profile (slice 5: administrators and the
-- candidate's job operators) or a job (slice 1: administrators) fills its custom values; whoever may read the record reads
-- them, except RESTRICTED candidate fields, which follow slice 5's restricted values (administrators and the candidate's job
-- operators only). Candidate fields that name a sensitive category are refused by the service's fixed word list (D-052); the careers
-- page and the referral form do not ask custom fields (D-053).
--
-- What this installs:
--   1. Five tables, each with tenant_id + company_id, ENABLE + FORCE row security, explicit GRANTs to ai_hr_app and none to
--      PUBLIC:
--        recruitment_custom_field                       the definitions (administrators write; the company's job teams read;
--                                                       a restricted field only administrators, recruiters and assistants)
--        recruitment_custom_field_option                the options of a choice field (read with their field)
--        recruitment_candidate_custom_value             a candidate's values of NON-restricted fields (read with the
--                                                       candidate: anyone who may read one of their applications; written by
--                                                       administrators and the candidate's job operators)
--        recruitment_candidate_custom_restricted  a candidate's values of RESTRICTED fields: its ONLY non-owner policy
--                                                       admits administrators and the candidate's job operators (slice 5's
--                                                       restricted values rule), so a hiring manager's, interviewer's or
--                                                       anybody else's direct SELECT returns no row
--        recruitment_job_custom_value                   a job's values (read with the job; written by administrators)
--   2. Typed storage: one row per record and field (one row per chosen option for multiple choice), with a typed column per
--      kind of value — text, number (numeric), date (a date; a year and month is the first of the month), yes or no
--      (boolean), option (the option's id). A CHECK ties the filled column to the field's type; nothing typed is stored as
--      text. Each value row carries its field's record kind, type and restricted flag in a foreign key to the definition, so
--      the database itself refuses (ON UPDATE NO ACTION) to change a field's type or restricted flag once any record has a
--      value, refuses to delete a field with values, and keeps restricted values out of the open table (and the reverse).
--      An option in use cannot be deleted (the option foreign key); it can be disabled. Referential checks do not depend on
--      the caller's row security.
--   3. Guards (run as the caller): definitions and options are written by the current user and keep their company, record
--      kind and creation record; options belong to a choice field; a field leaves a choice type only without options. A value
--      keeps its record and field, is written for an ENABLED field, a number within the field's range and decimals, an
--      ENABLED option when chosen, and never for a candidate whose personal data was removed (serialised against the removal
--      by the 4405 candidate lock). Required values are enforced by the service on save (D: a record created before a field
--      became required stays valid until its next edit).
--   4. app.recruitment_destroy_candidate restated (5713 body byte for byte) plus one step: every custom value of the person
--      (open and restricted) is deleted. app.recruitment_delete_company_setup restated (5713 body byte for byte) plus the
--      five tables, values first (they need a candidate or a job, which refuses the delete first), then options and fields.
--
-- Nothing here calls a model, scores a candidate or infers anything from a value.

-- ── 1. Tables ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_custom_field (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 record_kind text NOT NULL CHECK (record_kind IN ('candidate','job')),
 field_type text NOT NULL CHECK (field_type IN ('short_text','long_text','number','date','year_month','single_choice','multiple_choice','yes_no')),
 label_en text NOT NULL CHECK (char_length(btrim(label_en)) BETWEEN 1 AND 80),
 label_ms text CHECK (label_ms IS NULL OR char_length(btrim(label_ms)) BETWEEN 1 AND 80),
 label_ta text CHECK (label_ta IS NULL OR char_length(btrim(label_ta)) BETWEEN 1 AND 80),
 label_th text CHECK (label_th IS NULL OR char_length(btrim(label_th)) BETWEEN 1 AND 80),
 label_vi text CHECK (label_vi IS NULL OR char_length(btrim(label_vi)) BETWEEN 1 AND 80),
 label_zh text CHECK (label_zh IS NULL OR char_length(btrim(label_zh)) BETWEEN 1 AND 80),
 help_text text CHECK (help_text IS NULL OR char_length(btrim(help_text)) BETWEEN 1 AND 200),
 required boolean NOT NULL DEFAULT false,
 restricted boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true,
 position integer NOT NULL CHECK (position BETWEEN 0 AND 100000),
 number_min numeric CHECK (number_min IS NULL OR abs(number_min) < 1e15),
 number_max numeric CHECK (number_max IS NULL OR abs(number_max) < 1e15),
 number_decimals smallint CHECK (number_decimals IS NULL OR number_decimals BETWEEN 0 AND 4),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_custom_field_restricted_ck CHECK (NOT restricted OR record_kind = 'candidate'),
 CONSTRAINT recruitment_custom_field_number_ck CHECK (CASE WHEN field_type = 'number' THEN number_decimals IS NOT NULL
  ELSE num_nonnulls(number_min, number_max, number_decimals) = 0 END),
 CONSTRAINT recruitment_custom_field_range_ck CHECK (number_min IS NULL OR number_max IS NULL OR number_min <= number_max),
 CONSTRAINT recruitment_custom_field_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_custom_field_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_custom_field_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_custom_field_scope_uq UNIQUE (id, company_id, tenant_id),
 -- What a value row binds to: a value is typed by, and filed under, exactly this definition (see the value tables).
 CONSTRAINT recruitment_custom_field_value_key_uq UNIQUE (id, record_kind, field_type, restricted, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_custom_field_label_uq ON public.recruitment_custom_field (tenant_id, company_id, record_kind, lower(btrim(label_en)));
CREATE INDEX recruitment_custom_field_company_idx ON public.recruitment_custom_field (tenant_id, company_id, record_kind, position);
CREATE INDEX recruitment_custom_field_created_by_idx ON public.recruitment_custom_field (created_by_user_id);
CREATE INDEX recruitment_custom_field_updated_by_idx ON public.recruitment_custom_field (updated_by_user_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_custom_field_option (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 field_id uuid NOT NULL,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 label_en text NOT NULL CHECK (char_length(btrim(label_en)) BETWEEN 1 AND 80),
 label_ms text CHECK (label_ms IS NULL OR char_length(btrim(label_ms)) BETWEEN 1 AND 80),
 label_ta text CHECK (label_ta IS NULL OR char_length(btrim(label_ta)) BETWEEN 1 AND 80),
 label_th text CHECK (label_th IS NULL OR char_length(btrim(label_th)) BETWEEN 1 AND 80),
 label_vi text CHECK (label_vi IS NULL OR char_length(btrim(label_vi)) BETWEEN 1 AND 80),
 label_zh text CHECK (label_zh IS NULL OR char_length(btrim(label_zh)) BETWEEN 1 AND 80),
 enabled boolean NOT NULL DEFAULT true,
 position integer NOT NULL CHECK (position BETWEEN 0 AND 100000),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_custom_field_option_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 -- An option keeps its field: deleting a field (only possible without values) removes its options first, as the company
 -- delete does. Values point at options, so options are never removed by cascade.
 CONSTRAINT recruitment_custom_field_option_field_fk FOREIGN KEY (field_id, company_id, tenant_id)
  REFERENCES public.recruitment_custom_field(id, company_id, tenant_id),
 CONSTRAINT recruitment_custom_field_option_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_custom_field_option_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_custom_field_option_field_uq UNIQUE (id, field_id)
);
CREATE UNIQUE INDEX recruitment_custom_field_option_label_uq ON public.recruitment_custom_field_option (field_id, lower(btrim(label_en)));
CREATE INDEX recruitment_custom_field_option_field_idx ON public.recruitment_custom_field_option (field_id, position);
CREATE INDEX recruitment_custom_field_option_company_idx ON public.recruitment_custom_field_option (tenant_id, company_id);
CREATE INDEX recruitment_custom_field_option_created_by_idx ON public.recruitment_custom_field_option (created_by_user_id);
CREATE INDEX recruitment_custom_field_option_updated_by_idx ON public.recruitment_custom_field_option (updated_by_user_id);
--> statement-breakpoint
-- The three value tables share one shape: the record, the field (with its kind, type and restricted flag in the foreign key),
-- one typed column filled per the type, and who wrote it last. A multiple-choice value is one row per chosen option.
DO $$
DECLARE t text; rec text; rec_table text; kind text; restricted boolean;
BEGIN
 FOR t, rec, rec_table, kind, restricted IN VALUES
  ('recruitment_candidate_custom_value', 'candidate_id', 'recruitment_candidate', 'candidate', false),
  ('recruitment_candidate_custom_restricted', 'candidate_id', 'recruitment_candidate', 'candidate', true),
  ('recruitment_job_custom_value', 'job_id', 'recruitment_job_opening', 'job', false) LOOP
  EXECUTE format($t$CREATE TABLE public.%1$I (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   tenant_id uuid NOT NULL REFERENCES public.tenant(id),
   company_id uuid NOT NULL,
   %2$I uuid NOT NULL,
   field_id uuid NOT NULL,
   record_kind text NOT NULL DEFAULT %4$L CHECK (record_kind = %4$L),
   field_type text NOT NULL,
   restricted boolean NOT NULL DEFAULT %5$L CHECK (restricted = %5$L),
   text_value text,
   number_value numeric CHECK (number_value IS NULL OR (abs(number_value) < 1e15 AND number_value = round(number_value, 4))),
   date_value date,
   bool_value boolean,
   option_id uuid,
   updated_at timestamptz NOT NULL DEFAULT now(),
   updated_by_user_id uuid NOT NULL,
   CONSTRAINT %6$I CHECK (CASE field_type
    WHEN 'short_text' THEN char_length(btrim(text_value)) BETWEEN 1 AND 200 AND num_nonnulls(number_value, date_value, bool_value, option_id) = 0
    WHEN 'long_text' THEN char_length(btrim(text_value)) BETWEEN 1 AND 4000 AND num_nonnulls(number_value, date_value, bool_value, option_id) = 0
    WHEN 'number' THEN number_value IS NOT NULL AND num_nonnulls(text_value, date_value, bool_value, option_id) = 0
    WHEN 'date' THEN date_value IS NOT NULL AND num_nonnulls(text_value, number_value, bool_value, option_id) = 0
    WHEN 'year_month' THEN date_value IS NOT NULL AND extract(day FROM date_value) = 1 AND num_nonnulls(text_value, number_value, bool_value, option_id) = 0
    WHEN 'single_choice' THEN option_id IS NOT NULL AND num_nonnulls(text_value, number_value, date_value, bool_value) = 0
    WHEN 'multiple_choice' THEN option_id IS NOT NULL AND num_nonnulls(text_value, number_value, date_value, bool_value) = 0
    WHEN 'yes_no' THEN bool_value IS NOT NULL AND num_nonnulls(text_value, number_value, date_value, option_id) = 0
    ELSE false END),
   CONSTRAINT %7$I FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
   CONSTRAINT %8$I FOREIGN KEY (%2$I, company_id, tenant_id) REFERENCES public.%3$I(id, company_id, tenant_id),
   CONSTRAINT %9$I FOREIGN KEY (field_id, record_kind, field_type, restricted, company_id, tenant_id)
    REFERENCES public.recruitment_custom_field(id, record_kind, field_type, restricted, company_id, tenant_id),
   CONSTRAINT %10$I FOREIGN KEY (option_id, field_id) REFERENCES public.recruitment_custom_field_option(id, field_id),
   CONSTRAINT %11$I FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
  )$t$, t, rec, rec_table, kind, restricted, t || '_typed_ck', t || '_company_fk', t || '_record_fk', t || '_field_fk', t || '_option_fk',
   t || '_updated_by_fk');
  -- One value per record and field, except one row per chosen option for multiple choice.
  EXECUTE format('CREATE UNIQUE INDEX %I ON public.%I (%I, field_id) WHERE field_type <> %L', t || '_one_uq', t, rec, 'multiple_choice');
  EXECUTE format('CREATE UNIQUE INDEX %I ON public.%I (%I, field_id, option_id) WHERE field_type = %L', t || '_option_uq', t, rec, 'multiple_choice');
  -- The record's values (forms, removal, filters by record) and the field's values (filters by option or yes/no, the
  -- definition's and option's foreign key checks, "in use" counts).
  EXECUTE format('CREATE INDEX %I ON public.%I (%I, field_id)', t || '_record_idx', t, rec);
  EXECUTE format('CREATE INDEX %I ON public.%I (field_id, option_id)', t || '_field_idx', t);
  EXECUTE format('CREATE INDEX %I ON public.%I (option_id) WHERE option_id IS NOT NULL', t || '_option_idx', t);
  EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, company_id)', t || '_company_idx', t);
  EXECUTE format('CREATE INDEX %I ON public.%I (updated_by_user_id)', t || '_updated_by_idx', t);
 END LOOP;
END $$;
--> statement-breakpoint

-- ── 2. Row security and grants ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_custom_field','recruitment_custom_field_option','recruitment_candidate_custom_value',
  'recruitment_candidate_custom_restricted','recruitment_job_custom_value'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Definitions and options: administrators manage them (and, as the owner inside the company delete, remove them); the
-- company's job teams read them (labels to show the values they may read). They carry no candidate data. A RESTRICTED field
-- (and its options) is read only by those who may hold restricted values somewhere in the company — administrators and the
-- company's recruiters and assistants — so its label, help text and options stay hidden from hiring managers and interviewers.
-- The option probe reads the field under the caller's own row security; no field policy reads an option back.
CREATE POLICY recruitment_custom_field_admin ON public.recruitment_custom_field FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_custom_field_team ON public.recruitment_custom_field FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id)
  AND (NOT restricted OR app.recruitment_operates_in_company(company_id)));
CREATE POLICY recruitment_custom_field_option_admin ON public.recruitment_custom_field_option FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_custom_field_option_team ON public.recruitment_custom_field_option FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id)
  AND EXISTS (SELECT 1 FROM public.recruitment_custom_field f WHERE f.id = recruitment_custom_field_option.field_id
   AND f.tenant_id = recruitment_custom_field_option.tenant_id));
-- A candidate's open values: read with the candidate (anyone who may read one of their applications, as the slice 5 profile
-- entries); written by administrators and the candidate's job operators.
CREATE POLICY recruitment_candidate_custom_value_read ON public.recruitment_candidate_custom_value FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_reads_candidate(candidate_id));
CREATE POLICY recruitment_candidate_custom_value_write ON public.recruitment_candidate_custom_value FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id));
-- Restricted values: administrators and the operators of one of the candidate's jobs; nobody else, ever (slice 5's rule). No
-- other non-owner policy exists on this table.
CREATE POLICY recruitment_candidate_custom_restricted_operator ON public.recruitment_candidate_custom_restricted FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id));
-- A job's values: read with the job (the job's own row security answers the probe; no job policy reads a value back, so
-- nothing recurses); written by administrators, who edit jobs (slice 1).
CREATE POLICY recruitment_job_custom_value_read ON public.recruitment_job_custom_value FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.recruitment_job_opening j
  WHERE j.id = recruitment_job_custom_value.job_id AND j.tenant_id = recruitment_job_custom_value.tenant_id));
CREATE POLICY recruitment_job_custom_value_admin ON public.recruitment_job_custom_value FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
--> statement-breakpoint
-- Owner-bound maintenance. The app role never satisfies these (current_user is ai_hr_app, never the owner); the owner does
-- only inside app.recruitment_destroy_candidate for the candidate whose 4405 marker THIS transaction holds, and inside
-- app.recruitment_delete_company_setup for the company it is deleting.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_candidate_custom_value','recruitment_candidate_custom_restricted'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id))', t || '_destroy_read', t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id))', t || '_destroy', t, 'public.' || t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['recruitment_candidate_custom_value','recruitment_candidate_custom_restricted','recruitment_job_custom_value'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_company_delete'', true) = company_id::text)', t || '_company_delete_read', t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_company_delete'', true) = company_id::text)', t || '_company_delete', t, 'public.' || t);
 END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_custom_field, public.recruitment_custom_field_option, public.recruitment_candidate_custom_value,
 public.recruitment_candidate_custom_restricted, public.recruitment_job_custom_value TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Guards ─────────────────────────────────────────────────────────────────────────────────────────────
-- Definitions: written by the current user (an administrator: row security refuses anybody else); a field keeps its company,
-- record kind and creation record. A field leaves a choice type only once its options are removed (the service removes them;
-- a field with values cannot change type at all: the value foreign key refuses).
CREATE FUNCTION app.recruitment_guard_custom_field() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.updated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A custom field is recorded by the current user' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now(); NEW.updated_at := now();
  RETURN NEW;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.record_kind IS DISTINCT FROM OLD.record_kind OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A custom field keeps its company, record kind and creation record' USING ERRCODE = '23514';
 END IF;
 IF NEW.field_type NOT IN ('single_choice','multiple_choice') AND OLD.field_type IN ('single_choice','multiple_choice')
  AND EXISTS (SELECT 1 FROM public.recruitment_custom_field_option o WHERE o.field_id = OLD.id) THEN
  RAISE EXCEPTION 'Remove the options before the field leaves a choice type' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_custom_field_has_options';
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_custom_field() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_custom_field_guard BEFORE INSERT OR UPDATE ON public.recruitment_custom_field
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_custom_field();
--> statement-breakpoint
-- Options: written by the current user, only on a choice field; an option keeps its field, company and creation record.
CREATE FUNCTION app.recruitment_guard_custom_field_option() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.updated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A custom field option is recorded by the current user' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recruitment_custom_field f WHERE f.id = NEW.field_id AND f.tenant_id = NEW.tenant_id
   AND f.field_type IN ('single_choice','multiple_choice')) THEN
   RAISE EXCEPTION 'Options belong to a single or multiple choice field' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_custom_field_option_choice';
  END IF;
  NEW.created_at := now(); NEW.updated_at := now();
  RETURN NEW;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.field_id IS DISTINCT FROM OLD.field_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A custom field option keeps its field and creation record' USING ERRCODE = '23514';
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_custom_field_option() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_custom_field_option_guard BEFORE INSERT OR UPDATE ON public.recruitment_custom_field_option
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_custom_field_option();
--> statement-breakpoint
-- Values (the three tables): a value keeps its record and field; it is written for an ENABLED field of the record's company,
-- a number within the field's range and decimals, an ENABLED option when one is newly chosen (an option chosen before it was
-- disabled stays); never for a candidate whose personal data was removed (the 4405 candidate lock, shared, serialises this
-- against the removal). Clearing (DELETE) is not checked here: row security decides who may. The writer is the current user.
CREATE FUNCTION app.recruitment_guard_custom_value() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE f public.recruitment_custom_field%ROWTYPE; v_col text; v_record uuid;
BEGIN
 IF TG_OP = 'DELETE' THEN
  RETURN OLD;
 END IF;
 v_col := CASE WHEN TG_TABLE_NAME = 'recruitment_job_custom_value' THEN 'job_id' ELSE 'candidate_id' END;
 v_record := (to_jsonb(NEW) ->> v_col)::uuid;
 IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.field_id IS DISTINCT FROM OLD.field_id
  OR v_record IS DISTINCT FROM (to_jsonb(OLD) ->> v_col)::uuid) THEN
  RAISE EXCEPTION 'A custom value keeps its record and field' USING ERRCODE = '23514';
 END IF;
 IF v_col = 'candidate_id' THEN
  PERFORM pg_advisory_xact_lock_shared(app.recruitment_candidate_lock_key(NEW.tenant_id, v_record));
  IF EXISTS (SELECT 1 FROM public.recruitment_candidate c WHERE c.id = v_record AND c.destroyed_at IS NOT NULL) THEN
   RAISE EXCEPTION 'This candidate''s personal data has been removed' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_candidate_removed';
  END IF;
 END IF;
 SELECT * INTO f FROM public.recruitment_custom_field WHERE id = NEW.field_id AND tenant_id = NEW.tenant_id;
 IF NOT FOUND OR NOT f.enabled THEN
  RAISE EXCEPTION 'Choose an enabled custom field' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_custom_field_disabled';
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
REVOKE ALL ON FUNCTION app.recruitment_guard_custom_value() FROM PUBLIC, ai_hr_app;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_candidate_custom_value','recruitment_candidate_custom_restricted','recruitment_job_custom_value'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_custom_value()', t || '_guard', t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['recruitment_custom_field','recruitment_custom_field_option','recruitment_candidate_custom_value',
  'recruitment_candidate_custom_restricted','recruitment_job_custom_value'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_identity()', t || '_identity', t);
 END LOOP;
END $$;
--> statement-breakpoint

-- ── 4. Removal: 5713's app.recruitment_destroy_candidate, byte for byte, plus the custom values ─────────────────────
-- (The new step follows the slice 13 steps, before the candidate row is cleared.)
CREATE OR REPLACE FUNCTION app.recruitment_destroy_candidate(p_candidate uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE c public.recruitment_candidate%ROWTYPE; v_apps uuid[]; v_offers uuid[]; n integer; result jsonb := '{}'::jsonb;
BEGIN
 IF p_candidate IS NULL OR app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
  RAISE EXCEPTION 'Removing a candidate''s personal data needs a recruitment administrator' USING ERRCODE = '42501';
 END IF;
 -- Before anything else: no concurrent write to this candidate's record may interleave with the removal.
 PERFORM pg_advisory_xact_lock(app.recruitment_candidate_lock_key(app.current_tenant_id(), p_candidate));
 SELECT * INTO c FROM public.recruitment_candidate WHERE id = p_candidate AND tenant_id = app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.can_admin_recruitment_for(c.company_id) THEN
  RAISE EXCEPTION 'Removing a candidate''s personal data needs a recruitment administrator' USING ERRCODE = '42501';
 END IF;
 IF c.destroyed_at IS NOT NULL THEN
  RAISE EXCEPTION 'This candidate''s personal data has already been removed' USING ERRCODE = '23514';
 END IF;
 SELECT coalesce(array_agg(a.id), '{}') INTO v_apps FROM public.recruitment_application a WHERE a.candidate_id = c.id AND a.tenant_id = c.tenant_id;
 IF EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = ANY (v_apps) AND a.state IN ('active','hired')) THEN
  RAISE EXCEPTION 'A candidate with an active or hired application keeps their record' USING ERRCODE = '23514';
 END IF;
 -- Slice 13: for a person with a blocked-list entry only (stable here: this removal holds the candidate's lock exclusively and
 -- adding an entry needs it), the company's blocked-list lock (after the candidate's: candidate, then company — the order
 -- every writer here takes), so matching never marks against an entry this removal is deleting, and this removal sees every
 -- mark committed before it. A listed person whose entry still holds an open mark on ANOTHER candidate's active application
 -- keeps their record until an administrator resolves that mark (no hold is lifted without a decision).
 IF EXISTS (SELECT 1 FROM public.recruitment_blocked_entry e WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) THEN
  PERFORM pg_advisory_xact_lock(app.recruitment_blocked_lock_key(c.tenant_id, c.company_id));
  IF EXISTS (SELECT 1 FROM public.recruitment_blocked_entry e
    JOIN public.recruitment_application_review_mark m ON m.entry_id = e.id AND m.cleared_at IS NULL AND m.candidate_id <> c.id
    JOIN public.recruitment_application a ON a.id = m.application_id AND a.state = 'active'
    WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) THEN
   RAISE EXCEPTION 'Resolve the reviews this person''s blocked-list entry holds on other candidates first' USING ERRCODE = '23514',
    CONSTRAINT = 'recruitment_blocked_entry_has_open_marks';
  END IF;
 END IF;
 SELECT coalesce(array_agg(o.id), '{}') INTO v_offers FROM public.recruitment_offer o WHERE o.application_id = ANY (v_apps) AND o.tenant_id = c.tenant_id;
 INSERT INTO app.recruitment_destroy_marker (txid, candidate_id, tenant_id) VALUES (txid_current(), c.id, c.tenant_id);

 -- Slice 10: agency submissions about this person lose their personal data — the one accepted onto this candidate, and those
 -- no candidate links (refused, rejected or still waiting) whose ONLY recorded match is this candidate as a Duplicate (the
 -- same ID number, or the same name with the same e-mail or mobile); one still waiting is closed as rejected. A submission
 -- that matched this candidate only as Suspected, or matched others too, is about someone else: it only loses its link.
 -- Indexed lookups only (by candidate, and the link table by candidate). Each row keeps job, contract, consultant, dates.
 UPDATE public.recruitment_agency_submission s SET full_name = NULL, email = NULL, mobile = NULL, id_type = NULL, id_number = NULL,
  current_salary_amount = NULL, current_salary_currency = NULL, expected_salary_amount = NULL, expected_salary_currency = NULL, comments = NULL,
  review_reason = NULL, resume_name = NULL, resume_mime = NULL, resume_size = NULL, resume_content = NULL, personal_data_removed_at = now()
  WHERE s.candidate_id = c.id AND s.tenant_id = c.tenant_id AND s.personal_data_removed_at IS NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('agencySubmissions', n);
 UPDATE public.recruitment_agency_submission s SET full_name = NULL, email = NULL, mobile = NULL, id_type = NULL, id_number = NULL,
  current_salary_amount = NULL, current_salary_currency = NULL, expected_salary_amount = NULL, expected_salary_currency = NULL, comments = NULL,
  review_reason = NULL, resume_name = NULL, resume_mime = NULL, resume_size = NULL, resume_content = NULL,
  outcome = CASE WHEN s.outcome = 'waiting' THEN 'rejected' ELSE s.outcome END, personal_data_removed_at = now()
  WHERE s.id IN (SELECT m.submission_id FROM app.recruitment_agency_submission_match m
    WHERE m.candidate_id = c.id AND m.tenant_id = c.tenant_id AND m.duplicate
     AND NOT EXISTS (SELECT 1 FROM app.recruitment_agency_submission_match o WHERE o.submission_id = m.submission_id AND o.candidate_id <> c.id))
   AND s.candidate_id IS NULL AND s.personal_data_removed_at IS NULL
   -- Two ID numbers that differ are two people, however alike name and contacts are: only the link goes.
   AND NOT EXISTS (SELECT 1 FROM public.recruitment_candidate_restricted r WHERE r.candidate_id = c.id AND r.tenant_id = c.tenant_id
    AND r.id_number IS NOT NULL AND s.id_number IS NOT NULL AND app.recruitment_norm_id(r.id_number) <> app.recruitment_norm_id(s.id_number));
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('agencyMatchedSubmissions', n);
 DELETE FROM app.recruitment_agency_submission_match WHERE candidate_id = c.id;
 DELETE FROM public.recruitment_candidate_file WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('files', n);
 DELETE FROM public.recruitment_candidate_restricted WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('restricted', n);
 DELETE FROM public.recruitment_candidate_entry WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('entries', n);
 DELETE FROM public.recruitment_candidate_tag WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('tags', n);
 DELETE FROM public.recruitment_candidate_consent WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('consents', n);
 -- Feedback: the 1–5 ratings stay (they carry no personal data); every note and the overview go.
 UPDATE public.recruitment_scorecard s SET overview = NULL,
  ratings = (SELECT coalesce(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'object' THEN e.value - 'notes' ELSE e.value END), '{}'::jsonb)
   FROM jsonb_each(s.ratings) e)
  WHERE s.application_id = ANY (v_apps) AND s.tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('scorecards', n);
 -- Offers: values and rejection comments go; the offer skeleton (status, rounds, decision) stays.
 DELETE FROM public.recruitment_offer_value WHERE offer_id = ANY (v_offers) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('offerValues', n);
 UPDATE public.recruitment_offer SET last_rejection_comment = NULL
  WHERE id = ANY (v_offers) AND tenant_id = c.tenant_id AND last_rejection_comment IS NOT NULL;
 UPDATE public.recruitment_offer_approval SET comment = CASE WHEN decision = 'rejected' THEN '—' ELSE NULL END
  WHERE offer_id = ANY (v_offers) AND tenant_id = c.tenant_id AND comment IS NOT NULL;
 -- The application keeps its skeleton; a free-text source (it may name a referrer) goes.
 UPDATE public.recruitment_application SET source = NULL WHERE id = ANY (v_apps) AND source IS NOT NULL;
 -- Slice 7: a referral keeps its job, date and referrer; the referrer's reason (it describes the candidate) goes.
 UPDATE public.recruitment_referral SET reason = NULL WHERE candidate_id = c.id AND tenant_id = c.tenant_id AND reason IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('referrals', n);
 -- Slice 8: a careers application keeps its job and date; the applicant's message goes.
 UPDATE public.recruitment_careers_application SET message = NULL WHERE candidate_id = c.id AND tenant_id = c.tenant_id AND message IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('careersMessages', n);
 -- Slice 11: screening notes and feedback comments go (they describe the candidate); each request keeps its reviewer, sender,
 -- times and closing, and each answer its result, reviewer and time. Indexed by application.
 UPDATE public.recruitment_screening_request SET note = NULL WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND note IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('screeningNotes', n);
 UPDATE public.recruitment_screening_answer SET comment = NULL WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND comment IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('screeningComments', n);
 -- Slice 12: the person's OPEN background checks are cancelled by the system (a fixed code, so they no longer show as open
 -- or count as the recorder's to-dos); every check keeps its types, status, outcome and dates; the restricted details
 -- (provider, reference, authorisation, summary, cancellation reason) and every file (authorisation and report) go. Indexed
 -- by application.
 UPDATE public.recruitment_background_check SET status = 'cancelled', system_cancel_reason = 'candidate_removed',
  status_changed_by_user_id = app.current_user_id()
  WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND status IN ('awaiting_authorisation','in_progress');
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundChecksCancelled', n);
 DELETE FROM public.recruitment_background_check_file WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundCheckFiles', n);
 DELETE FROM public.recruitment_background_check_detail WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundCheckDetails', n);
 -- Slice 13: the person's pool memberships go (the remover administers the company, so the ordinary membership policy admits
 -- the delete). Their blocked-list entries go with the restricted values (reason, removal reason, identity values), the
 -- history, and every mark those entries made on anyone's application (such a mark has no basis once its entry is gone;
 -- marker-bound owner policies). A mark that SOMEONE ELSE's entry made on this person's applications stays (ids only).
 -- Indexed by candidate and by entry.
 DELETE FROM public.recruitment_talent_pool_member WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('poolMemberships', n);
 DELETE FROM public.recruitment_application_review_mark WHERE entry_id IN (SELECT e.id FROM public.recruitment_blocked_entry e
  WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('blockedMarks', n);
 DELETE FROM public.recruitment_blocked_history WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 DELETE FROM public.recruitment_blocked_entry_restricted WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 DELETE FROM public.recruitment_blocked_entry WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('blockedEntries', n);
 -- Slice 14: every custom value of the person goes, open and restricted (typed values of company-defined fields; the
 -- definitions are company setup and stay). Indexed by candidate. Marker-bound owner policies (and the remover administers
 -- the company).
 DELETE FROM public.recruitment_candidate_custom_value WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('customValues', n);
 DELETE FROM public.recruitment_candidate_custom_restricted WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('customRestrictedValues', n);
 UPDATE public.recruitment_candidate SET
  full_name = 'Removed candidate ' || upper(substr(replace(c.id::text, '-', ''), 1, 8)), email = NULL, phone = NULL, location = NULL,
  current_company = NULL, current_title = NULL, highest_education = NULL, notice_period = NULL, source = NULL,
  destroyed_at = now(), destroyed_by_user_id = app.current_user_id(), updated_at = now(), updated_by_user_id = app.current_user_id()
  WHERE id = c.id;
 DELETE FROM app.recruitment_destroy_marker WHERE txid = txid_current() AND candidate_id = c.id;
 RETURN result || jsonb_build_object('applications', cardinality(v_apps), 'offers', cardinality(v_offers));
END $$;
REVOKE ALL ON FUNCTION app.recruitment_destroy_candidate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_destroy_candidate(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 5. Deleting a company (core/company-refs.ts): 5713's body plus the custom field tables ─────────────────────────
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
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;
