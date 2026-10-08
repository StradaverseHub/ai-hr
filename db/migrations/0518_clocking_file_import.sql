-- r424 (feedback 50ed39e1) — Attendance File Structure Mapping + Import Clocking Data + Import Logs.
--
-- THREE NEW TABLES, NOTHING EXISTING CHANGES. `attendance` and `attendance_punch` keep their shape: an
-- imported clocking is an ordinary `attendance_punch` row with method 'import' (the R45 multi-punch child),
-- and the link from a log line to the punch it created lives on the LOG LINE, never on the punch.
--
-- (1) clocking_file_mapping — how ONE clocking device writes its file, described once by an administrator:
--     CSV or TXT, separated by a character or fixed width, which column / character positions hold each
--     field, and what the device's In/Out codes mean. TENANT-WIDE, not per company: a device file does not
--     say which company it is for, and card ids are already tenant-wide (0474). The first 20 lines of the
--     sample file are kept so Edit can show them again; nothing in a sample is ever imported. The built-in
--     "AIHR Standard Template" (staff_id, timestamp) is CODE, not a row (lib/clocking-file.ts), so it can
--     never be edited or deleted and every tenant has it without a seed.
--
-- (2) clocking_import_run — one row per import: who, when, which file (its NAME, byte size and SHA-256 —
--     never its content, the 0341 precedent), which mapping AS IT WAS on the day (mapping_snapshot, so a
--     later edit cannot rewrite what a past import meant), and the counts. The status shown on screen is
--     DERIVED from the counts and failure_reason, never stored (0341: a stored status is a fourth fact
--     that can disagree with the other three). failure_reason is set only on a run that STOPPED and saved
--     nothing; such a row is written in its own transaction after the import's rolled back.
--
-- (3) clocking_import_line — one row per non-blank data line of the file: line number, the card id as
--     read, the employee when one was matched, the date/time/direction read, the result and its message.
--     raw_line is kept ONLY for a line that was not imported (it is what the administrator needs to fix
--     the source) and is capped at 500 characters. attendance_punch_id points at the punch the line
--     created; ON DELETE SET NULL because a punch can legitimately go (its day row cascades) and the log
--     must outlive it.
--
-- RLS. All three are administrator surfaces (the importer is requireAdmin, as today): tenant AND
-- app.is_admin(). A log line additionally names an employee, so its USING adds the employment-visibility
-- set in the r395 SET form (0515) — `employment_id = ANY ((SELECT app.visible_employment_ids())::uuid[])`
-- — because test/r395-policy-visibility-guard.test.ts refuses any USING clause that calls the per-row
-- app.can_see_employment(). WITH CHECK calls the per-row function (one row per check is the right cost,
-- and 34 existing policies do the same). A line with no employee (an unmatched card) is visible to every
-- administrator of the tenant, which is what "Card ID not found, naming no one" needs.
--
-- GRANTs to ai_hr_app on all three (CLAUDE.md §6: a dev restore has no default privileges).
--
-- Journal: idx 518, when 1791700000000. 0516 and 0517 belong to unmerged branches; this entry is
-- re-sequenced at rebase if either lands with a higher `when`.

CREATE TYPE "clocking_file_type" AS ENUM ('csv', 'txt');--> statement-breakpoint
CREATE TYPE "clocking_file_layout" AS ENUM ('delimited', 'fixed_width');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS clocking_file_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  device_name text NOT NULL DEFAULT '',
  file_type clocking_file_type NOT NULL,
  layout clocking_file_layout NOT NULL,
  -- The separator for a delimited file (',' tab ';' or one other character); NULL for fixed width.
  delimiter text,
  has_header boolean NOT NULL DEFAULT false,
  encoding text NOT NULL DEFAULT 'utf-8',
  active boolean NOT NULL DEFAULT true,
  -- { cardId: {column} | {start,end}, deviceId?, day, month, year, hours, minute, inOutCode? }. The six
  -- required fields are enforced by the service (core/attendance-clocking-import.ts), which owns the rule.
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{ code, direction: 'in' | 'out' }]
  in_out_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Up to 20 lines of the sample file, for Edit. Never imported.
  sample_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample_file_name text NOT NULL DEFAULT '',
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clocking_file_mapping_name_ck CHECK (length(btrim(name)) > 0),
  CONSTRAINT clocking_file_mapping_encoding_ck CHECK (encoding IN ('utf-8', 'utf-16le', 'utf-16be', 'windows-1252')),
  CONSTRAINT clocking_file_mapping_delimiter_ck CHECK (
    (layout = 'delimited' AND delimiter IS NOT NULL AND length(delimiter) = 1)
    OR (layout = 'fixed_width' AND delimiter IS NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS clocking_file_mapping_name_uq
  ON clocking_file_mapping (tenant_id, lower(name));--> statement-breakpoint
ALTER TABLE clocking_file_mapping ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON clocking_file_mapping TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS clocking_file_mapping_rls ON clocking_file_mapping;--> statement-breakpoint
CREATE POLICY clocking_file_mapping_rls ON clocking_file_mapping FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

CREATE TABLE IF NOT EXISTS clocking_import_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  -- NULL = the built-in AIHR Standard Template. RESTRICT: a used mapping is deactivated, never deleted.
  mapping_id uuid REFERENCES clocking_file_mapping(id) ON DELETE RESTRICT,
  mapping_name text NOT NULL,
  mapping_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  file_name text NOT NULL DEFAULT '',
  file_bytes integer NOT NULL DEFAULT 0,
  file_sha256 text NOT NULL DEFAULT '',
  created_by_person_id uuid REFERENCES person(id),
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  total_lines integer NOT NULL DEFAULT 0,
  valid_lines integer NOT NULL DEFAULT 0,
  imported_lines integer NOT NULL DEFAULT 0,
  duplicate_lines integer NOT NULL DEFAULT 0,
  unmatched_card_lines integer NOT NULL DEFAULT 0,
  invalid_datetime_lines integer NOT NULL DEFAULT 0,
  other_error_lines integer NOT NULL DEFAULT 0,
  days_updated integer NOT NULL DEFAULT 0,
  employees_updated integer NOT NULL DEFAULT 0,
  -- Set only when the import STOPPED and saved nothing. Status is derived; see the header.
  failure_reason text,
  CONSTRAINT clocking_import_run_counts_ck CHECK (
    total_lines >= 0 AND valid_lines >= 0 AND imported_lines >= 0 AND duplicate_lines >= 0
    AND unmatched_card_lines >= 0 AND invalid_datetime_lines >= 0 AND other_error_lines >= 0
    AND days_updated >= 0 AND employees_updated >= 0
  )
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS clocking_import_run_tenant_created_idx
  ON clocking_import_run (tenant_id, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS clocking_import_run_sha_idx
  ON clocking_import_run (tenant_id, file_sha256);--> statement-breakpoint
ALTER TABLE clocking_import_run ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON clocking_import_run TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS clocking_import_run_rls ON clocking_import_run;--> statement-breakpoint
CREATE POLICY clocking_import_run_rls ON clocking_import_run FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

CREATE TABLE IF NOT EXISTS clocking_import_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id uuid NOT NULL REFERENCES clocking_import_run(id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  card_ref text NOT NULL DEFAULT '',
  employment_id uuid REFERENCES employment(id),
  device_ref text,
  punch_date date,
  punch_time time,
  direction attendance_punch_direction,
  result text NOT NULL,
  message text NOT NULL DEFAULT '',
  raw_line text,
  attendance_punch_id uuid REFERENCES attendance_punch(id) ON DELETE SET NULL,
  -- text + CHECK rather than a pgEnum: this is the vocabulary most likely to grow (the 0275 lesson).
  CONSTRAINT clocking_import_line_result_ck CHECK (result IN (
    'imported', 'duplicate', 'unmatched_card', 'invalid_date', 'invalid_time', 'unknown_in_out_code',
    'missing_value', 'line_too_short', 'ambiguous_card', 'not_employed_on_date', 'future_date',
    'day_corrected', 'period_closed', 'uncoded_on_clocked_day', 'other'
  )),
  CONSTRAINT clocking_import_line_raw_ck CHECK (raw_line IS NULL OR length(raw_line) <= 500),
  CONSTRAINT clocking_import_line_no_ck CHECK (line_no >= 1)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS clocking_import_line_run_idx
  ON clocking_import_line (run_id, line_no);--> statement-breakpoint
ALTER TABLE clocking_import_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON clocking_import_line TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS clocking_import_line_rls ON clocking_import_line;--> statement-breakpoint
CREATE POLICY clocking_import_line_rls ON clocking_import_line FOR ALL
  USING (
    tenant_id = app.current_tenant_id() AND app.is_admin()
    AND (employment_id IS NULL OR employment_id = ANY ((SELECT app.visible_employment_ids())::uuid[]))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id() AND app.is_admin()
    AND (employment_id IS NULL OR app.can_see_employment(employment_id))
  );--> statement-breakpoint

COMMENT ON TABLE clocking_file_mapping IS
  'r424 50ed39e1 — how one clocking device writes its CSV/TXT file. Tenant-wide. The built-in AIHR Standard Template is code (lib/clocking-file.ts), not a row.';--> statement-breakpoint
COMMENT ON TABLE clocking_import_run IS
  'r424 50ed39e1 — one row per clocking-file import. The file itself is never stored (name, size, SHA-256 only). Status is derived from the counts and failure_reason.';--> statement-breakpoint
COMMENT ON TABLE clocking_import_line IS
  'r424 50ed39e1 — one row per data line of an imported clocking file: what it read and what happened to it. raw_line only for a line not imported.';
