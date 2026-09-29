-- r362 · 3f15ffdb — LEAVE HISTORY DATA IMPORT: the four facts a migrated leave record carries that
-- `leave_request` has never had, and the run log that records who loaded what.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS FOR, AND WHAT IT DELIBERATELY DOES NOT TOUCH
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- A customer moving onto the platform brings two different things and they must not be confused:
--
--   THE BALANCES  — already handled. `core/leave-import.ts` writes `leave_ledger` rows (opening
--                   balance, carry-forward, ad-hoc credit) and every balance figure in the product is
--                   derived from that table and nothing else (core/read.ts leaveBalance*).
--   THE RECORDS   — this migration. The past approved leave itself, with its original reference
--                   number, dates and remarks, so an employee's Leave History is not empty on day one.
--                   Leave History is built entirely from `leave_request` (core/read.ts
--                   `leaveRequestSelection`), so an imported record MUST land there. No parallel table.
--
-- ⚠️ AN IMPORTED HISTORICAL RECORD WRITES NO LEDGER ROW, AND THAT IS THE LOAD-BEARING DECISION.
-- The migrated opening balance ALREADY has the past leave taken out of it. Writing a debit for every
-- imported record would deduct the same days a second time, from a figure that is encashed at
-- termination (core/leave-encashment.ts) and feeds `unpaidDaysByEmployment` (core/payroll.ts). So the
-- two importers do one job each and nothing is counted twice. Two consequences, stated here because
-- they are properties of the DATA and not of one screen:
--   · an imported record appears in Leave History but is NOT added to the "Taken" figure, which is
--     derived from ledger debits carrying a source_request_id (core/read.ts);
--   · cancelling an imported record credits nothing back, because `chargedDays` is
--     sum(leave_ledger.days) where source_request_id = the request, guarded by `> 0` (core/leave.ts).
--     That is correct: nothing was ever taken off.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) `leave_request` — FOUR ADDITIVE, NULLABLE COLUMNS, and one partial unique index
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Every existing row reads exactly as it does today: three columns are NULL and the marker defaults
-- false, so no screen, sweep, report or balance changes on the day this ships.
--
--  external_reference  The legacy system's leave transaction number ("LV/2025/00418"). There was
--                      nowhere to put it: what Employee Leave Record shows today is a PREFIX OF THE
--                      INTERNAL UUID (app/leave/employee-records/page.tsx), which is this product's
--                      own id and cannot carry someone else's. It is also the only stable key for the
--                      cross-run duplicate check the ticket asks for, which is what the index below is.
--  entitlement_year    The leave year the record was charged against IN THE OLD SYSTEM. Not derivable
--                      from start_date: a leave period is configurable (company.leave_period_*), so a
--                      January leave can belong to the previous entitlement year. Stored as stated;
--                      the importer WARNS when it disagrees with the start date's year and never
--                      rejects — see the day-count note below for the same reasoning.
--  submitted_on        The date the employee submitted, which is a third distinct fact: `created_at`
--                      is when the record was ENTERED and `decided_at` is when it was APPROVED. The
--                      ticket lists all three and the old system had all three.
--  imported_history    THE MARKER. An approved `leave_request` with no sourced ledger debit is a shape
--                      this system has never had. Rather than leave readers and sweeps to infer it
--                      from the absence of a row in another table, the row says so about itself, so a
--                      future reader that must exclude migrated history can do it by construction.
--                      boolean NOT NULL DEFAULT false — the 0341 `disabled_individual` precedent — so
--                      "is this migrated history" is never a three-valued question.
--
-- WHY NO CHECK CONSTRAINT (CLAUDE.md §6). The rules — a reference is required, a year must be sane, a
-- session only on a single-day record — are enforced in `core/leave-history-import.ts`, the service
-- that decides. A table constraint here would fire on every UPDATE by every OTHER writer of
-- leave_request, and there are two in production: `insertLeaveRequest` (core/leave.ts, the ordinary
-- apply path) and the partial-cancellation split (core/leave.ts, r301). Both were read before this
-- index was written. Neither sets `external_reference`, and the split ENUMERATES the columns it
-- copies onto a new segment rather than copying the row — so a cancelled-in-part imported record
-- keeps its reference on the surviving original and the new segments carry NULL. No collision.
--
-- THE INDEX IS PARTIAL, and that is not an optimisation. `WHERE external_reference IS NOT NULL` means
-- the millions of ordinary rows — every request ever applied for in this product — are entirely
-- unconstrained by it; only imported history is. Tenant-scoped because a legacy reference is unique
-- within the customer's old system, not across customers.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- ROLLBACK: DROP INDEX leave_request_external_reference_uq, then DROP COLUMN each of the four.
-- No GRANT is needed here: `leave_request` is already granted to ai_hr_app and a column inherits the
-- table's privileges.

ALTER TABLE leave_request
  ADD COLUMN IF NOT EXISTS external_reference text,
  ADD COLUMN IF NOT EXISTS entitlement_year integer,
  ADD COLUMN IF NOT EXISTS submitted_on date,
  ADD COLUMN IF NOT EXISTS imported_history boolean NOT NULL DEFAULT false;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS leave_request_external_reference_uq
  ON leave_request (tenant_id, external_reference)
  WHERE external_reference IS NOT NULL;--> statement-breakpoint

COMMENT ON COLUMN leave_request.external_reference IS
  '3f15ffdb — the ORIGINATING system''s leave reference, carried across by Leave History Data Import. NULL for every request applied for in this product (the reference shown on screen for those is a prefix of this row''s own uuid). Unique per tenant where present.';--> statement-breakpoint
COMMENT ON COLUMN leave_request.entitlement_year IS
  '3f15ffdb — the leave year the record was charged against in the ORIGINATING system. Not derivable from start_date (a leave period is configurable), so it is stored as stated; a disagreement with the start date''s year is a non-blocking warning at import, never a rejection.';--> statement-breakpoint
COMMENT ON COLUMN leave_request.submitted_on IS
  '3f15ffdb — when the employee SUBMITTED, a third fact distinct from created_at (entered) and decided_at (approved). NULL for every row created in this product, where submission and entry are the same moment.';--> statement-breakpoint
COMMENT ON COLUMN leave_request.imported_history IS
  '3f15ffdb — TRUE only for a record loaded by Leave History Data Import: approved, and deliberately carrying NO leave_ledger debit because the migrated opening balance already has those days removed. The marker exists so a reader or sweep can exclude migrated history by construction rather than inferring it from a missing row in another table.';--> statement-breakpoint

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) `leave_history_import_run` — the audit trail (ticket point 10)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Modelled on `employee_import_run` (0341) deliberately, down to the reasoning, because the questions
-- are the same ones: who loaded this, when, from which file, and which rows did not go in and why.
--
-- ── WHY A TABLE AND NOT THE EVENT LOG ─────────────────────────────────────────────────────────────
-- The event log stays the audit spine and keeps its summary event. This table is the READ MODEL for a
-- screen: queried by (tenant, recency), holding a jsonb error detail that would bloat every event-log
-- scan. Rebuilding the log screen by replaying events would mean a filtered scan of the whole log per
-- page view, and the reasons would have to live in the event payload anyway.
--
-- ── WHAT IS DELIBERATELY NOT STORED: THE UPLOADED FILE ────────────────────────────────────────────
-- 0341's rule, applied for a narrower but real reason: a leave-history file names who was sick, for
-- how long and why ("Remark"), for the whole workforce. Correcting a rejected row needs the row's
-- IDENTITY (row number, employee no., leave reference) and the REASON — which is all `errors` holds.
-- The file's NAME is kept because that is what HR recognises a run by.
--
-- ── COUNTS ────────────────────────────────────────────────────────────────────────────────────────
-- FOUR, not three, because the ticket asks the preview and the summary for four and a duplicate is not
-- a failure: total = rows read; imported = records written; duplicate = rows whose leave reference
-- already exists (in the file or in the system); failed = every other row that did not go in. The
-- three non-total counts are disjoint and sum to `total`. No stored outcome/status column: a fourth
-- fact that can disagree with the counts beside it (0341's rule).
--
-- ── RLS ───────────────────────────────────────────────────────────────────────────────────────────
-- Admin-only, tenant-scoped, exactly as 0341: a run is not "about" one person — it names many — and
-- its error detail names employees the uploader may be the only one entitled to see. This is ticket
-- point 11 (only HR/Admin may reach the function) enforced at the row level as well as the page guard.
--
-- ⚠️ THE GRANT IS NOT OPTIONAL (CLAUDE.md §6; precedents 0345, 0354). A dev restore has no default
-- privileges and the test suite connects as the OWNER, so an omitted GRANT is invisible to every test
-- and fails only in production.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS; the policy is DROP IF EXISTS then CREATE.
-- ROLLBACK: DROP TABLE leave_history_import_run. Nothing references it; the importer does not read it
-- to decide anything (the duplicate check reads leave_request.external_reference, the real data).

CREATE TABLE IF NOT EXISTS leave_history_import_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  -- Who ran it. person_id gives the display name; user_id attributes an admin with no person row (an
  -- operator / support login), so "who" is never blank for an import that definitely had an actor.
  created_by_person_id uuid REFERENCES person(id),
  created_by_user_id text,
  -- The uploaded file's name, '' when the rows were pasted rather than uploaded. NOT the file.
  file_name text NOT NULL DEFAULT '',
  total_rows integer NOT NULL DEFAULT 0,
  imported_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  -- Rows rejected because the leave reference already exists — in this file or already in the system.
  -- Counted apart from failures because "already loaded" is the expected answer on a re-upload, not an
  -- error the customer has to correct, and the ticket asks for the two separately.
  duplicate_rows integer NOT NULL DEFAULT 0,
  -- [{ rowNum, employeeNo, leaveReference, errors: [...] }] — identity + reason only, never the row's
  -- data (no dates, no remark). Capped by core/leave-history-import.ts LEAVE_HISTORY_ERROR_CAP.
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- True when more rows were rejected than `errors` holds. The screen says so rather than letting HR
  -- believe a truncated report is the whole story.
  errors_truncated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_history_import_run_counts_ck CHECK (
    total_rows >= 0 AND imported_rows >= 0 AND failed_rows >= 0 AND duplicate_rows >= 0
  )
);--> statement-breakpoint

-- The log is "this tenant's, most recent first".
CREATE INDEX IF NOT EXISTS leave_history_import_run_tenant_created_idx
  ON leave_history_import_run (tenant_id, created_at DESC);--> statement-breakpoint

ALTER TABLE leave_history_import_run ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_history_import_run TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS leave_history_import_run_rls ON leave_history_import_run;--> statement-breakpoint
CREATE POLICY leave_history_import_run_rls ON leave_history_import_run FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

COMMENT ON TABLE leave_history_import_run IS
  '3f15ffdb — one row per Leave History Data Import RUN: who, when, which file, the four counts, and the per-row reasons rejected rows were not imported. Read model for the import log on the Leave History Data Import screen; the event log keeps its leave-history-import.completed event unchanged. The uploaded FILE is deliberately never stored.';--> statement-breakpoint
COMMENT ON COLUMN leave_history_import_run.duplicate_rows IS
  '3f15ffdb — rows rejected because the leave reference already exists, in this file or already in the system. Counted apart from failed_rows: on a re-upload of an already-loaded file this is the expected answer, not a correction the customer has to make.';
