-- r88d — TWO independent additive changes, in one migration because one migration number was allocated
-- to this build agent. They share nothing but the file; either could be reverted without the other.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) cf43c909 — "Replace CSV Import with Excel Import and Add Import History": `employee_import_run`
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- The Excel half of cf43c909 SHIPPED IN r86 (item d8471481, lib/import-file.ts + lib/spreadsheet.ts),
-- and so did the pre-import validation preview and the downloadable error report. What was missing is
-- the RECORD: once an upload finished there was nothing to look back at. `employee-import.completed`
-- was appended to the event log, but the event log is not a screen and its payload carries counts only
-- — not the per-row reasons a rejected row needs in order to be corrected and re-uploaded.
--
-- ── WHY A TABLE AND NOT THE EVENT LOG ─────────────────────────────────────────────────────────────
-- The event log stays the audit spine and keeps its `employee-import.completed` event, unchanged. This
-- table is the READ MODEL for a screen: it is queried by (tenant, recency), it holds a jsonb error
-- detail that would bloat every event-log scan, and it is the thing an admin deletes when they want the
-- error detail gone. Rebuilding a history screen by replaying events would mean a filtered scan of the
-- whole log per page view, and the errors would have to live in the event payload anyway.
--
-- ── WHAT IS DELIBERATELY *NOT* STORED: THE UPLOADED FILE ──────────────────────────────────────────
-- An employee import file carries identity-card numbers, bank account numbers, EPF/SOCSO/tax numbers
-- and salaries for the whole workforce. Retaining it would turn an audit feature into a data-retention
-- liability, and nothing in the approved plan needs it: correcting a rejected row needs the ROW's
-- identity (row number, name, email) and the REASON, which is exactly what `errors` holds. The file's
-- NAME is kept because that is what HR recognises a run by ("the June joiners file").
--
-- `errors` is therefore a bounded array of { rowNum, fullName, email, errors[] } and NEVER a copy of the
-- row: no IC, no bank account, no salary. It is capped in core/import.ts (`IMPORT_RUN_ERROR_CAP`) with
-- `errors_truncated` recording that the cap bit, so a 5,000-row disaster cannot write a 5,000-entry
-- jsonb document — the screen shows what fits and says so.
--
-- ── COUNTS ────────────────────────────────────────────────────────────────────────────────────────
-- `total_rows` = rows in the file. `imported_rows` = rows written. `failed_rows` = every row that did
-- not become an employee, whether it was REJECTED by validation (the dry run's per-row errors) or
-- FAILED at write (a service threw). The screen's outcome (succeeded / partly / failed) is DERIVED from
-- the three, not stored: a stored status would be a fourth fact that can disagree with the other three.
--
-- ── RLS ───────────────────────────────────────────────────────────────────────────────────────────
-- Admin-only, tenant-scoped. A run is not "about" a person — it names many — so there is no
-- app.can_see_person rule to apply, and its error detail names employees the uploader may be the only
-- one entitled to see. Only the roles that can run an import can read its history.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX use IF NOT EXISTS; the policy is DROP ... IF EXISTS then
-- CREATE. Safe on re-run and on a fresh chain replayed in one transaction.
-- ROLLBACK: DROP TABLE employee_import_run. Nothing references it; the importer itself does not read it.

CREATE TABLE IF NOT EXISTS employee_import_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  -- The company SELECTED on the import screen. Nullable so a run is never lost if that company is later
  -- removed; the history row survives as "company no longer available". Note a single file may create
  -- employees at SEVERAL companies (d8471481) — this is the screen's target, not an exhaustive list.
  company_id uuid REFERENCES company(id),
  -- Who ran it. person_id gives the display name; user_id attributes an admin with no person row (an
  -- operator/support login), so "who" is never blank for an import that definitely had an actor.
  created_by_person_id uuid REFERENCES person(id),
  created_by_user_id text,
  -- The uploaded file's name, '' when the CSV was pasted rather than uploaded. NOT the file.
  file_name text NOT NULL DEFAULT '',
  total_rows integer NOT NULL DEFAULT 0,
  imported_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  -- [{ rowNum, fullName, email, errors: [...] }] — the reasons, never the row's data. See the header.
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- True when more rows failed than `errors` holds (the cap bit). The screen says so rather than
  -- letting HR believe a truncated report is the whole story.
  errors_truncated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_import_run_counts_ck CHECK (
    total_rows >= 0 AND imported_rows >= 0 AND failed_rows >= 0
  )
);--> statement-breakpoint

-- The history list is "this tenant's, most recent first".
CREATE INDEX IF NOT EXISTS employee_import_run_tenant_created_idx
  ON employee_import_run (tenant_id, created_at DESC);--> statement-breakpoint

ALTER TABLE employee_import_run ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_import_run TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS employee_import_run_rls ON employee_import_run;--> statement-breakpoint
CREATE POLICY employee_import_run_rls ON employee_import_run FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

COMMENT ON TABLE employee_import_run IS
  'cf43c909 — one row per employee-import RUN: who, when, which file, and the per-row reasons rejected rows were not imported. Read model for the Import History screen; the event log keeps its employee-import.completed event unchanged. The uploaded FILE is deliberately never stored (it carries IC / bank / salary for the whole workforce).';--> statement-breakpoint
COMMENT ON COLUMN employee_import_run.errors IS
  'cf43c909 — [{ rowNum, fullName, email, errors: [...] }]. Identity + reason only, never the row''s data. Capped by core/import.ts IMPORT_RUN_ERROR_CAP; errors_truncated says the cap bit.';--> statement-breakpoint
COMMENT ON COLUMN employee_import_run.failed_rows IS
  'cf43c909 — every row that did not become an employee: rejected by validation OR failed at write. The screen derives succeeded / partly / failed from the counts; no stored status can disagree with them.';--> statement-breakpoint

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) d64d0df4 — "Tax Information": `employee_statutory_my.disabled_individual`
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Whether THIS EMPLOYEE is a registered disabled individual (OKU). That is a fact about the person and
-- is tenant data. The RELIEF AMOUNT it entitles them to is statutory and is NOT here: it lives in the
-- country pack's ruleset (localization/my/statutory-tables.ts `MY_RELIEFS.disabledIndividual`, applied
-- by pcbMonth), exactly like the individual / spouse / per-child deductions. Nothing about this column
-- makes a legislated figure tenant-editable.
--
-- DEFAULT false, NOT NULL. Every existing row therefore reads exactly as it does today and NO existing
-- PCB figure changes on the day this ships — the plan promises the reporter precisely that, and
-- test/statutory-disabled-individual.test.ts pins it. A row only starts claiming the extra deduction
-- once an admin sets the field, and because PCB is computed from year-to-date accumulators, the month
-- that happens absorbs the whole year-to-date correction (correct, and disclosed on the plan).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS. ROLLBACK: DROP COLUMN disabled_individual (no reader outside
-- the tax profile path; dropping it returns every employee to the no-extra-deduction behaviour).

ALTER TABLE employee_statutory_my
  ADD COLUMN IF NOT EXISTS disabled_individual boolean NOT NULL DEFAULT false;--> statement-breakpoint

COMMENT ON COLUMN employee_statutory_my.disabled_individual IS
  'd64d0df4 — the employee is a registered disabled individual (OKU). Tenant data about the person; the RELIEF AMOUNT it entitles them to is statutory and lives in the country pack ruleset (MY_RELIEFS.disabledIndividual), never here. Default false ⇒ every pre-existing row keeps today''s PCB exactly.';
