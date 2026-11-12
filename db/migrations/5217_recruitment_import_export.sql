-- Recruitment slice 16 (docs/recruitment-reconstruction/specification.md "Slice 16"): candidate import, list exports and the
-- To assign list.
--
-- Recruitment administrators and the company's recruiters and assistants (operators of any job in the company) import candidates
-- from a structured file (no résumé parsing: D-056). The file is validated in full and previewed first; the import itself runs on
-- the shared background bulk-job kernel (5011/5013), never inside a web request: one step per file row, short chunk transactions
-- under the importer's freshly resolved authority, progress, cancellation and a result page. Rows are independent (D-055): a row
-- the database refuses is reported and the others continue. Each good row creates ONE new candidate (possible duplicates are
-- imported and flagged, never merged) and, when it names an Open job the importer may add applications to, one application at the
-- job's first enabled stage through the ordinary insert (repeat guard, slice 13 blocked-list matching). A candidate with no
-- application is "to assign": the company's operators see them on the To assign list until someone assigns a job (a normal
-- application) or removes them from the list (nothing is deleted). Exports are generated on request from what the exporter reads
-- under row security, and not stored; administrators keep the company's saved column sets ("export templates").
--
-- What this installs:
--   1. The bulk-job kind recruitment_candidate_import (creator scope: one active import per person; the input is the company, the
--      previewed file's sha256, the screen's language and the permission confirmation; the file itself is the job's source
--      content, cleared by the kernel when the job ends together with the per-row payloads).
--   2. Five tables with tenant_id + company_id, ENABLE + FORCE row security, explicit GRANTs to ai_hr_app and none to PUBLIC:
--        recruitment_candidate_import       one import (its id is the bulk job's): company, importer, the permission
--                                           confirmation, rows in the file, how it ended — no personal data
--        recruitment_candidate_import_row   one result per file row: outcome, the candidate and application it created, what
--                                           happened to its job, duplicate and review flags, an error code and field keys —
--                                           never a value from the file
--        recruitment_to_assign              a candidate with no application: who imported them and when, the job title as
--                                           written in the file, the possible-duplicate flag, and whether someone removed them
--                                           from the list (hidden)
--        recruitment_candidate_import_note  the notes column of the file, per candidate (read like the candidate's other
--                                           operator-only data)
--        recruitment_export_template        a saved column set per company and export kind
--   3. Row security: imports and their rows are read by their importer while they still operate in the company, and by the
--      company's administrators; the To assign list and its candidates are read by the company's operators (administrators
--      included); export templates are written by administrators and read by operators. A To assign marker and an import note can
--      only be written for a candidate the current user created in this very transaction (checked by definer guards that see the
--      company's candidates through the 4405 duplicate-probe policy), so a marker can never be used to reach someone else's
--      candidate. The marker is removed by the database whenever ANY channel inserts an application for the candidate (an AFTER
--      INSERT definer trigger, owner-bound policy).
--   3b. Bounds and endings (review of slice 16): recruitment_import_preview_quota (previews per person per Kuala Lumpur day, no
--      personal data; the person's own rows only); app.recruitment_candidate_duplicate_flags (a file's possible duplicates as keys,
--      each probe stopping at its first match); app.recruitment_settle_candidate_import (the worker's owner settle: an import's
--      outcome and refused rows when its importer can no longer write them); the To assign guard also refuses a candidate with an
--      application (an owner-bound probe).
--   4. app.recruitment_destroy_candidate restated (5215 body byte for byte) plus one step: the person's To assign marker (with the
--      job title as written) and import note go; import rows keep ids only.
--   5. app.recruitment_delete_company_setup restated (5216 body byte for byte) plus the five tables.
--
-- Nothing here calls a model, parses a résumé or infers anything about a candidate.

-- ── 1. The bulk-job kind ─────────────────────────────────────────────────────────────────────────────────────
-- input_shape is core/recruitment candidate import admission (packs/recruitment/import.ts CandidateImportJobInput).
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
 VALUES('recruitment_candidate_import',NULL,'creator','{"companyId":"string","previewHash":"string","locale":"string","permissionConfirmed":"boolean"}'::jsonb,4096,false);
--> statement-breakpoint

-- ── 2. Tables ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_candidate_import (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 permission_confirmed_at timestamptz NOT NULL,
 file_rows integer NOT NULL CHECK (file_rows BETWEEN 0 AND 5000),
 outcome text CHECK (outcome IS NULL OR outcome IN ('completed','cancelled','failed')),
 finished_at timestamptz,
 CONSTRAINT recruitment_candidate_import_finished_ck CHECK ((outcome IS NULL) = (finished_at IS NULL)),
 CONSTRAINT recruitment_candidate_import_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_candidate_import_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_candidate_import_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE INDEX recruitment_candidate_import_company_idx ON public.recruitment_candidate_import (tenant_id, company_id, created_at DESC);
CREATE INDEX recruitment_candidate_import_created_by_idx ON public.recruitment_candidate_import (created_by_user_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE public.recruitment_candidate_import_row (
 import_id uuid NOT NULL,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 row_num integer NOT NULL CHECK (row_num BETWEEN 2 AND 1000000),
 outcome text NOT NULL CHECK (outcome IN ('created','failed','invalid')),
 candidate_id uuid,
 application_id uuid,
 job_id uuid,
 job_result text CHECK (job_result IS NULL OR job_result IN ('applied','no_job','unknown_job','job_not_open','job_not_allowed')),
 possible_duplicate boolean NOT NULL DEFAULT false,
 needs_review boolean NOT NULL DEFAULT false,
 error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z_]{0,59}$'),
 error_fields text[] NOT NULL DEFAULT '{}' CHECK (cardinality(error_fields) <= 60 AND array_position(error_fields, NULL) IS NULL),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (import_id, row_num),
 CONSTRAINT recruitment_candidate_import_row_created_ck CHECK ((outcome = 'created') = (candidate_id IS NOT NULL)),
 CONSTRAINT recruitment_candidate_import_row_error_ck CHECK ((outcome = 'created') = (error_code IS NULL)),
 CONSTRAINT recruitment_candidate_import_row_application_ck CHECK (application_id IS NULL OR (candidate_id IS NOT NULL AND job_id IS NOT NULL)),
 CONSTRAINT recruitment_candidate_import_row_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_candidate_import_row_import_fk FOREIGN KEY (import_id, company_id, tenant_id)
  REFERENCES public.recruitment_candidate_import(id, company_id, tenant_id) ON DELETE CASCADE,
 CONSTRAINT recruitment_candidate_import_row_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id)
  REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_candidate_import_row_application_fk FOREIGN KEY (application_id) REFERENCES public.recruitment_application(id),
 CONSTRAINT recruitment_candidate_import_row_job_fk FOREIGN KEY (job_id) REFERENCES public.recruitment_job_opening(id)
);
CREATE INDEX recruitment_candidate_import_row_candidate_idx ON public.recruitment_candidate_import_row (candidate_id) WHERE candidate_id IS NOT NULL;
CREATE INDEX recruitment_candidate_import_row_application_idx ON public.recruitment_candidate_import_row (application_id) WHERE application_id IS NOT NULL;
CREATE INDEX recruitment_candidate_import_row_job_idx ON public.recruitment_candidate_import_row (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX recruitment_candidate_import_row_company_idx ON public.recruitment_candidate_import_row (tenant_id, company_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_to_assign (
 candidate_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 import_id uuid,
 job_title_as_written text CHECK (job_title_as_written IS NULL OR char_length(btrim(job_title_as_written)) BETWEEN 1 AND 200),
 -- Slice 5's duplicate count found a possible match when the candidate was added (a flag for the list; never a merge).
 possible_duplicate boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 hidden_at timestamptz,
 hidden_by_user_id uuid,
 CONSTRAINT recruitment_to_assign_hidden_ck CHECK ((hidden_at IS NULL) = (hidden_by_user_id IS NULL)),
 CONSTRAINT recruitment_to_assign_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_to_assign_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_to_assign_import_fk FOREIGN KEY (import_id, company_id, tenant_id) REFERENCES public.recruitment_candidate_import(id, company_id, tenant_id),
 CONSTRAINT recruitment_to_assign_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_to_assign_hidden_by_fk FOREIGN KEY (hidden_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_to_assign_company_idx ON public.recruitment_to_assign (tenant_id, company_id, (hidden_at IS NULL), created_at DESC);
CREATE INDEX recruitment_to_assign_import_idx ON public.recruitment_to_assign (import_id) WHERE import_id IS NOT NULL;
CREATE INDEX recruitment_to_assign_created_by_idx ON public.recruitment_to_assign (created_by_user_id);
CREATE INDEX recruitment_to_assign_hidden_by_idx ON public.recruitment_to_assign (hidden_by_user_id) WHERE hidden_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE public.recruitment_candidate_import_note (
 candidate_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 import_id uuid NOT NULL,
 note text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_candidate_import_note_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_candidate_import_note_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_candidate_import_note_import_fk FOREIGN KEY (import_id, company_id, tenant_id) REFERENCES public.recruitment_candidate_import(id, company_id, tenant_id),
 CONSTRAINT recruitment_candidate_import_note_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_candidate_import_note_import_idx ON public.recruitment_candidate_import_note (import_id);
CREATE INDEX recruitment_candidate_import_note_company_idx ON public.recruitment_candidate_import_note (tenant_id, company_id);
CREATE INDEX recruitment_candidate_import_note_created_by_idx ON public.recruitment_candidate_import_note (created_by_user_id);
--> statement-breakpoint
-- A column set: 1–60 distinct column keys (a fixed key, or cf.<custom field id>). Which keys a kind offers is the service's
-- (packs/recruitment/export-model.ts); an unknown key in a saved set is skipped when the set is used.
CREATE FUNCTION app.recruitment_export_columns_valid(p text[]) RETURNS boolean LANGUAGE sql IMMUTABLE
 SET search_path = pg_catalog, pg_temp AS $$
 SELECT p IS NOT NULL AND cardinality(p) BETWEEN 1 AND 60 AND array_position(p, NULL) IS NULL
  AND (SELECT count(DISTINCT x) FROM unnest(p) x) = cardinality(p)
  AND NOT EXISTS (SELECT 1 FROM unnest(p) x WHERE x !~ '^([a-z][A-Za-z]{0,39}|cf\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
$$;
REVOKE ALL ON FUNCTION app.recruitment_export_columns_valid(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_export_columns_valid(text[]) TO ai_hr_app;
CREATE TABLE public.recruitment_export_template (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('board','talent_pool','interview_feedback')),
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
 columns text[] NOT NULL CHECK (app.recruitment_export_columns_valid(columns)),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_export_template_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_export_template_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_export_template_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_export_template_name_uq ON public.recruitment_export_template (tenant_id, company_id, kind, lower(btrim(name)));
CREATE INDEX recruitment_export_template_created_by_idx ON public.recruitment_export_template (created_by_user_id);
CREATE INDEX recruitment_export_template_updated_by_idx ON public.recruitment_export_template (updated_by_user_id);
--> statement-breakpoint

-- ── 3. Row security and grants ───────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_candidate_import','recruitment_candidate_import_row','recruitment_to_assign',
  'recruitment_candidate_import_note','recruitment_export_template'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Imports: their importer while they still operate in the company (they recorded it and run it), and the company's
-- administrators (read only). The importer writes the record and its outcome.
CREATE POLICY recruitment_candidate_import_read ON public.recruitment_candidate_import FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND ((created_by_user_id = app.current_user_id() AND app.recruitment_operates_in_company(company_id))
  OR app.can_admin_recruitment_for(company_id)));
CREATE POLICY recruitment_candidate_import_insert ON public.recruitment_candidate_import FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND created_by_user_id = app.current_user_id() AND app.recruitment_operates_in_company(company_id));
CREATE POLICY recruitment_candidate_import_update ON public.recruitment_candidate_import FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND created_by_user_id = app.current_user_id() AND app.recruitment_operates_in_company(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND created_by_user_id = app.current_user_id() AND app.recruitment_operates_in_company(company_id));
-- Row results: read with their import (its own row security answers the probe; no import policy reads a row back); written
-- once by the import's own importer.
CREATE POLICY recruitment_candidate_import_row_read ON public.recruitment_candidate_import_row FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.recruitment_candidate_import i
  WHERE i.id = recruitment_candidate_import_row.import_id AND i.tenant_id = recruitment_candidate_import_row.tenant_id));
CREATE POLICY recruitment_candidate_import_row_insert ON public.recruitment_candidate_import_row FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id) AND EXISTS (SELECT 1 FROM public.recruitment_candidate_import i
  WHERE i.id = recruitment_candidate_import_row.import_id AND i.tenant_id = recruitment_candidate_import_row.tenant_id
   AND i.company_id = recruitment_candidate_import_row.company_id AND i.created_by_user_id = app.current_user_id() AND i.outcome IS NULL));
-- The To assign list: the company's operators (administrators included) read it, add to it (guarded below) and hide or show
-- entries. Nobody removes an entry through the app role: an application insert, the removal of the person and the company delete
-- do (owner-bound policies below).
CREATE POLICY recruitment_to_assign_operator ON public.recruitment_to_assign FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id));
CREATE POLICY recruitment_to_assign_insert ON public.recruitment_to_assign FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND created_by_user_id = app.current_user_id() AND app.recruitment_operates_in_company(company_id));
CREATE POLICY recruitment_to_assign_update ON public.recruitment_to_assign FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id));
-- A To assign candidate is read by the company's operators (the marker's own row security answers the probe; no marker policy
-- reads a candidate, so nothing recurses). Their restricted values, custom values and files stay under the slice 5 and 14 rules.
CREATE POLICY recruitment_candidate_to_assign_read ON public.recruitment_candidate FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.recruitment_to_assign t
  WHERE t.candidate_id = recruitment_candidate.id AND t.tenant_id = recruitment_candidate.tenant_id));
-- Import notes: operator-only, like attachments (slice 5): administrators and the operators of one of the candidate's jobs, and
-- while the candidate is on To assign the company's operators. Written once, at import, by the importer (guarded below).
CREATE POLICY recruitment_candidate_import_note_read ON public.recruitment_candidate_import_note FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND (app.recruitment_operates_candidate(company_id, candidate_id)
  OR EXISTS (SELECT 1 FROM public.recruitment_to_assign t WHERE t.candidate_id = recruitment_candidate_import_note.candidate_id
   AND t.tenant_id = recruitment_candidate_import_note.tenant_id)));
CREATE POLICY recruitment_candidate_import_note_insert ON public.recruitment_candidate_import_note FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND created_by_user_id = app.current_user_id() AND app.recruitment_operates_in_company(company_id));
-- Export templates: administrators manage them (and, as the owner inside the company delete, remove them); operators use them.
CREATE POLICY recruitment_export_template_admin ON public.recruitment_export_template FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_export_template_operator ON public.recruitment_export_template FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id));
--> statement-breakpoint
-- Owner-bound maintenance. The app role never satisfies these (current_user is ai_hr_app, never the owner). The owner does only:
-- inside app.recruitment_clear_to_assign for the candidate whose application THIS statement inserted; inside
-- app.recruitment_destroy_candidate for the candidate whose 4405 marker THIS transaction holds; and inside
-- app.recruitment_delete_company_setup for the company it is deleting.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_to_assign'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_to_assign_clear'', true) = candidate_id::text)', t || '_clear_read', t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_to_assign_clear'', true) = candidate_id::text)', t || '_clear', t, 'public.' || t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['recruitment_to_assign','recruitment_candidate_import_note'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id))', t || '_destroy_read', t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id))', t || '_destroy', t, 'public.' || t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['recruitment_candidate_import','recruitment_candidate_import_row','recruitment_to_assign','recruitment_candidate_import_note'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_company_delete'', true) = company_id::text)', t || '_company_delete_read', t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_company_delete'', true) = company_id::text)', t || '_company_delete', t, 'public.' || t);
 END LOOP;
END $$;
--> statement-breakpoint
-- The To assign guard's probe: whether the candidate it is marking has any application (owner only, for that candidate only).
CREATE POLICY recruitment_application_to_assign_probe ON public.recruitment_application FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_application'::regclass))
 AND current_setting('app.recruitment_to_assign_probe', true) = candidate_id::text);
-- An import's ending when its importer can no longer write it (app.recruitment_settle_candidate_import, run by the bulk-job worker's
-- owner connection): only that import's record and rows, only while the setting names it.
CREATE POLICY recruitment_candidate_import_settle_read ON public.recruitment_candidate_import FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_import'::regclass))
 AND current_setting('app.recruitment_import_settle', true) = id::text);
CREATE POLICY recruitment_candidate_import_settle ON public.recruitment_candidate_import FOR UPDATE USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_import'::regclass))
 AND current_setting('app.recruitment_import_settle', true) = id::text) WITH CHECK (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_import'::regclass))
 AND current_setting('app.recruitment_import_settle', true) = id::text);
CREATE POLICY recruitment_candidate_import_row_settle_read ON public.recruitment_candidate_import_row FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_import_row'::regclass))
 AND current_setting('app.recruitment_import_settle', true) = import_id::text);
CREATE POLICY recruitment_candidate_import_row_settle ON public.recruitment_candidate_import_row FOR INSERT WITH CHECK (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_import_row'::regclass))
 AND current_setting('app.recruitment_import_settle', true) = import_id::text);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.recruitment_candidate_import, public.recruitment_to_assign TO ai_hr_app;
GRANT SELECT, INSERT ON public.recruitment_candidate_import_row, public.recruitment_candidate_import_note TO ai_hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_export_template TO ai_hr_app;
--> statement-breakpoint

-- ── 4. Guards ───────────────────────────────────────────────────────────────────────────────────────────────
-- Imports: recorded by the current user now; they keep their company, importer, confirmation and file size; the outcome is set
-- once (from none) with its time.
CREATE FUNCTION app.recruitment_guard_candidate_import() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.outcome IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
   RAISE EXCEPTION 'An import is recorded by the current user, unfinished' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
  OR NEW.permission_confirmed_at IS DISTINCT FROM OLD.permission_confirmed_at OR NEW.file_rows IS DISTINCT FROM OLD.file_rows
  OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL THEN
  RAISE EXCEPTION 'An import only records how it ended, once' USING ERRCODE = '23514';
 END IF;
 NEW.finished_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_candidate_import() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_candidate_import_guard BEFORE INSERT OR UPDATE ON public.recruitment_candidate_import
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_candidate_import();
--> statement-breakpoint
-- A To assign marker and an import note name a candidate the CURRENT USER created in THIS transaction (the candidate's created_at
-- is the transaction's now()): an importer can mark only the person they just imported, never reach someone else's candidate
-- through a marker. A definer, so it sees the company's candidates through the 4405 duplicate-probe policy (the caller operates in
-- the company); it reads nothing else. A marker then only changes its hidden state (hidden by the current user, now; or shown
-- again); everything else stays.
CREATE FUNCTION app.recruitment_guard_to_assign() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() OR NOT EXISTS (
   SELECT 1 FROM public.recruitment_candidate c WHERE c.id = NEW.candidate_id AND c.tenant_id = NEW.tenant_id AND c.company_id = NEW.company_id
    AND c.created_by_user_id = app.current_user_id() AND c.created_at = now() AND c.destroyed_at IS NULL) THEN
   RAISE EXCEPTION 'Only a candidate you have just added can be put on the To assign list' USING ERRCODE = '42501',
    CONSTRAINT = 'recruitment_to_assign_new_candidate';
  END IF;
  IF TG_TABLE_NAME = 'recruitment_to_assign' THEN
   -- …and the candidate has no application at all (an owner-bound probe for this candidate only, cleared at once).
   PERFORM set_config('app.recruitment_to_assign_probe', NEW.candidate_id::text, true);
   IF EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.candidate_id = NEW.candidate_id AND a.tenant_id = NEW.tenant_id) THEN
    PERFORM set_config('app.recruitment_to_assign_probe', '', true);
    RAISE EXCEPTION 'A candidate with an application is not to assign' USING ERRCODE = '42501', CONSTRAINT = 'recruitment_to_assign_new_candidate';
   END IF;
   PERFORM set_config('app.recruitment_to_assign_probe', '', true);
   NEW.hidden_at := NULL; NEW.hidden_by_user_id := NULL;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
 END IF;
 IF NEW.candidate_id IS DISTINCT FROM OLD.candidate_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.import_id IS DISTINCT FROM OLD.import_id OR NEW.job_title_as_written IS DISTINCT FROM OLD.job_title_as_written
  OR NEW.possible_duplicate IS DISTINCT FROM OLD.possible_duplicate
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A To assign entry only changes whether it is shown' USING ERRCODE = '23514';
 END IF;
 IF NEW.hidden_at IS NOT NULL AND OLD.hidden_at IS NULL THEN
  NEW.hidden_at := now(); NEW.hidden_by_user_id := app.current_user_id();
 ELSIF NEW.hidden_at IS NULL THEN
  NEW.hidden_by_user_id := NULL;
 ELSE
  NEW.hidden_at := OLD.hidden_at; NEW.hidden_by_user_id := OLD.hidden_by_user_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_to_assign() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_to_assign_guard BEFORE INSERT OR UPDATE ON public.recruitment_to_assign
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_to_assign();
CREATE TRIGGER recruitment_candidate_import_note_guard BEFORE INSERT ON public.recruitment_candidate_import_note
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_to_assign();
--> statement-breakpoint
-- An application for a candidate, from any channel (manual, To assign, import, careers page, referral, agency, talent pool), takes
-- them off the To assign list. Owner-bound to this candidate for this statement only (the setting is cleared again at once).
CREATE FUNCTION app.recruitment_clear_to_assign() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
BEGIN
 PERFORM set_config('app.recruitment_to_assign_clear', NEW.candidate_id::text, true);
 DELETE FROM public.recruitment_to_assign WHERE candidate_id = NEW.candidate_id AND tenant_id = NEW.tenant_id;
 PERFORM set_config('app.recruitment_to_assign_clear', '', true);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_clear_to_assign() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_application_clear_to_assign AFTER INSERT ON public.recruitment_application
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_clear_to_assign();
--> statement-breakpoint
-- Export templates: written by the current user; keep their company, kind and creation record.
CREATE FUNCTION app.recruitment_guard_export_template() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'An export template is recorded by the current user' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();
 ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'An export template keeps its company, kind and creation record' USING ERRCODE = '23514';
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_export_template() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_export_template_guard BEFORE INSERT OR UPDATE ON public.recruitment_export_template
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_export_template();
--> statement-breakpoint
-- Import rows never change; the other tables keep their tenant and company (the shared identity guard).
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_candidate_import','recruitment_to_assign','recruitment_export_template'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_identity()', t || '_identity', t);
 END LOOP;
END $$;
--> statement-breakpoint

-- ── 4b. Preview quota, duplicate flags and the owner settle ─────────────────────────────────────────────────────
-- Previews per person per Kuala Lumpur day (an import preview answers "is someone with this ID number already a candidate?"
-- in bulk, so it is bounded and audited). The day is the database's, never the caller's. No personal data.
CREATE TABLE public.recruitment_import_preview_quota (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 app_user_id uuid NOT NULL,
 day date NOT NULL,
 previews integer NOT NULL DEFAULT 1 CHECK (previews BETWEEN 1 AND 1000),
 PRIMARY KEY (tenant_id, app_user_id, day),
 CONSTRAINT recruitment_import_preview_quota_user_fk FOREIGN KEY (app_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_import_preview_quota_user_idx ON public.recruitment_import_preview_quota (app_user_id);
ALTER TABLE public.recruitment_import_preview_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruitment_import_preview_quota FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.recruitment_import_preview_quota FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_import_preview_quota_self ON public.recruitment_import_preview_quota FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app_user_id = app.current_user_id())
 WITH CHECK (tenant_id = app.current_tenant_id() AND app_user_id = app.current_user_id());
GRANT SELECT, INSERT, UPDATE ON public.recruitment_import_preview_quota TO ai_hr_app;
CREATE FUNCTION app.recruitment_guard_preview_quota() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  NEW.day := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; NEW.previews := 1;
 ELSIF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.app_user_id IS DISTINCT FROM OLD.app_user_id OR NEW.day IS DISTINCT FROM OLD.day
  OR NEW.previews < OLD.previews THEN
  RAISE EXCEPTION 'A preview count only grows' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_preview_quota() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_import_preview_quota_guard BEFORE INSERT OR UPDATE ON public.recruitment_import_preview_quota
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_preview_quota();
--> statement-breakpoint
-- Which of a file's probes may be a duplicate (slice 5's rule: the same ID number, or two of e-mail, name and mobile), for a caller
-- who operates in the company: the probe keys only, never a count or a row of anyone. The rule is checked as its four pairs, each an
-- EXISTS that stops at the first live candidate found through one selective expression index (ID number; e-mail; mobile), so a
-- common name shared by thousands of candidates is never aggregated. The caller bounds the statement's time.
CREATE FUNCTION app.recruitment_candidate_duplicate_flags(p_company uuid, p_probes jsonb) RETURNS SETOF integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE t uuid := app.current_tenant_id();
BEGIN
 IF p_company IS NULL OR t IS NULL OR NOT app.recruitment_operates_in_company(p_company) THEN
  RAISE EXCEPTION 'Checking for duplicate candidates needs recruitment access to the company' USING ERRCODE = '42501';
 END IF;
 IF jsonb_typeof(p_probes) <> 'array' OR jsonb_array_length(p_probes) > 5000 THEN
  RAISE EXCEPTION 'At most 5,000 probes' USING ERRCODE = '22023';
 END IF;
 RETURN QUERY
 SELECT x.k FROM jsonb_to_recordset(p_probes) AS x(k integer, n text, e text, m text, i text)
 CROSS JOIN LATERAL (SELECT app.recruitment_norm_name(x.n) AS v_name, app.recruitment_norm_email(x.e) AS v_email,
   app.recruitment_norm_mobile(x.m) AS v_mobile, app.recruitment_norm_id(x.i) AS v_id) v
 WHERE (v.v_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.recruitment_candidate_restricted r
     JOIN public.recruitment_candidate c ON c.id = r.candidate_id AND c.destroyed_at IS NULL
     WHERE r.tenant_id = t AND r.company_id = p_company AND r.id_number IS NOT NULL AND app.recruitment_norm_id(r.id_number) = v.v_id))
  OR (v.v_email IS NOT NULL AND EXISTS (SELECT 1 FROM public.recruitment_candidate c
     WHERE c.tenant_id = t AND c.company_id = p_company AND c.email IS NOT NULL AND app.recruitment_norm_email(c.email) = v.v_email AND c.destroyed_at IS NULL
      AND ((v.v_name IS NOT NULL AND app.recruitment_norm_name(c.full_name) = v.v_name)
       OR (v.v_mobile IS NOT NULL AND c.phone IS NOT NULL AND app.recruitment_norm_mobile(c.phone) = v.v_mobile))))
  OR (v.v_mobile IS NOT NULL AND v.v_name IS NOT NULL AND EXISTS (SELECT 1 FROM public.recruitment_candidate c
     WHERE c.tenant_id = t AND c.company_id = p_company AND c.phone IS NOT NULL AND app.recruitment_norm_mobile(c.phone) = v.v_mobile AND c.destroyed_at IS NULL
      AND app.recruitment_norm_name(c.full_name) = v.v_name));
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_duplicate_flags(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_candidate_duplicate_flags(uuid, jsonb) TO ai_hr_app;
--> statement-breakpoint
-- The bulk-job worker's owner connection ends an import whatever its importer may still do: the record's outcome from the job's
-- terminal state (set once, from none), and a refused row for every step the kernel recorded as failed without one, so the
-- results stay row for row. Only for that job's own import record; nothing else is readable or writable through it.
CREATE FUNCTION app.recruitment_settle_candidate_import(p_job uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE j public.bulk_job%ROWTYPE; rec public.recruitment_candidate_import%ROWTYPE;
BEGIN
 SELECT * INTO j FROM public.bulk_job WHERE id = p_job AND kind = 'recruitment_candidate_import';
 IF NOT FOUND OR j.state NOT IN ('completed','failed','cancelled') THEN RETURN; END IF;
 PERFORM set_config('app.recruitment_import_settle', p_job::text, true);
 SELECT * INTO rec FROM public.recruitment_candidate_import WHERE id = p_job AND tenant_id = j.tenant_id;
 IF FOUND THEN
  INSERT INTO public.recruitment_candidate_import_row (import_id, tenant_id, company_id, row_num, outcome, error_code)
   SELECT p_job, rec.tenant_id, rec.company_id, s.row_num, 'failed', 'refused' FROM public.bulk_job_step s
   WHERE s.job_id = p_job AND s.state = 'failed' AND s.row_num IS NOT NULL
   ON CONFLICT (import_id, row_num) DO NOTHING;
  UPDATE public.recruitment_candidate_import SET outcome = j.state WHERE id = p_job AND outcome IS NULL;
 END IF;
 PERFORM set_config('app.recruitment_import_settle', '', true);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_settle_candidate_import(uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint

-- ── 5. Removal: 5215's app.recruitment_destroy_candidate, byte for byte, plus the To assign marker and the import note ─────────
-- (The new step follows the slice 14 steps, before the candidate row is cleared.)
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
 -- Slice 16: the person's To assign marker (it holds the job title as written in their import file) and their import note go.
 -- Their import rows stay with ids, outcomes and codes only (no personal data). Indexed by candidate. Marker-bound owner policies.
 DELETE FROM public.recruitment_to_assign WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('toAssign', n);
 DELETE FROM public.recruitment_candidate_import_note WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('importNotes', n);
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

-- ── 6. Deleting a company (core/company-refs.ts): 5216's body plus the slice 16 tables ───────────────────────────────────────
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
