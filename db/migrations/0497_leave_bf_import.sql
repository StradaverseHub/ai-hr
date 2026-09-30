-- r369 · db55d08a — LEAVE B/F DATA IMPORT: the run/batch table the rollback needs, and the one nullable
-- column on `leave_ledger` that links a ledger row to the run that wrote it.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS FOR
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- A customer moving onto the platform brings three different things and they must not be confused:
--
--   THE BALANCES   — `core/leave-import.ts` (Leave Config › Leave Adjustments › Leave Balance Import):
--                    raw `leave_ledger` movements, where the uploader states the entry type and the date.
--   THE RECORDS    — `core/leave-history-import.ts` (migration 0490): the past leave itself, in
--                    `leave_request`, plus its debit when the run deducts.
--   THE OPENING B/F — this migration. The BROUGHT-FORWARD figure a leave year opens with.
--
-- ⚠️ BROUGHT FORWARD IS DERIVED AND NOT STORED, AND THAT IS WHY THIS TOOL EXISTS.
-- `core/read.ts` computes it as `sum(leave_ledger.days) where effective_on < cycleStart` (`priorBalance`,
-- surfaced as `broughtForward`), and the Employee Balances grid column is that figure put through the
-- leave type's carry rule (`carriedForward` ← `carryAllowanceFrom`). NO COLUMN IS ADDED HERE TO HOLD
-- EITHER. The importer writes an ordinary `leave_ledger` row dated the day before that employee's leave
-- year opens, so every existing balance surface picks it up with no change at all.
--
-- ⚠️ THE ROW IT WRITES IS `entry_type = 'adjustment'`, NEVER `'accrual'`.
-- `yearOpenMarkerCond` (core/leave.ts) is `entry_type = 'accrual' AND effective_on inside the year`. ANY
-- accrual row dated anywhere in 2026 — including a hand-imported one — makes Generate Entitlement believe
-- that (employment, leave type) has already been opened, so it grants NOTHING for the year and posts no
-- cap forfeit. An employee would end up with the imported 3.5 days where they should have had a full
-- annual allowance, and nothing would warn anybody. An `adjustment` row is invisible to that predicate.
-- `lib/leave-bf-import-schema.ts` names the entry type once (`LEAVE_BF_ENTRY_TYPE`) and
-- test/leave-bf-import.test.ts fails if a committed row ever satisfies the marker.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) `leave_bf_import_run` — the run log AND the rollback batch
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Modelled on `leave_history_import_run` (0490) for the questions it answers, and on
-- `leave_adjustment_batch` (0353) for the `reversed_at` / `reversed_by_user_id` pair that makes it a
-- batch. The reporter asked for "a Rollback batch option, which is very useful during migration", and a
-- rollback needs something for the ledger rows to point at.
--
-- ⚠️ WHY NOT `leave_adjustment_batch` ITSELF. Its `days` column is NOT NULL and SINGULAR — one amount
-- applied to many people, which is what the Leave Adjustments screen does. A B/F file carries a DIFFERENT
-- amount on every line, so there is no one figure to put there; forcing one in would either lie or force a
-- batch per line, which makes "undo the file I just loaded" unanswerable again.
--
-- THREE counts, not 0490's four: there is no cross-run duplicate status, because re-running a corrected
-- file is the expected workflow and `import_mode = 'replace'` is what makes it safe. imported + failed =
-- total, always, and the screen's outcome badge is DERIVED from them — no stored status column, which
-- would be a fourth fact that can disagree with the numbers beside it (0341's rule).
--
-- `ledger_rows` is a FOURTH, non-disjoint count and is deliberately not part of that sum: a Replace line
-- writes TWO rows (the negation of what a previous run put there, then the new figure) and a figure of 0
-- over nothing writes NONE. "How many rows did this touch" and "how many of my lines went in" are
-- different questions and a single number cannot answer both.
--
-- THE UPLOADED FILE IS NEVER STORED (0341's rule, 0490's restatement). A B/F file names every employee and
-- their leave entitlement; correcting a rejected row needs the row's IDENTITY (row number, employee id,
-- leave code, year) and the REASON, which is all `errors` holds. The file's NAME is kept because that is
-- what HR recognises a run by.
--
-- ── RLS ───────────────────────────────────────────────────────────────────────────────────────────
-- Admin-only, tenant-scoped, exactly as 0341 and 0490: a run is not "about" one person — it names many —
-- and its error detail names employees the uploader may be the only one entitled to see. The page guard is
-- `requireAdmin()`, matching both sibling importers; this is the same restriction at the ROW level.
--
-- ⚠️ THE GRANT IS NOT OPTIONAL (CLAUDE.md §6; precedents 0345, 0354, 0490). A dev restore has no default
-- privileges and the test suite connects as the OWNER, so an omitted GRANT is invisible to every test and
-- fails only in production.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS; every constraint and the policy are DROP IF
-- EXISTS then CREATE.
-- ROLLBACK: DROP the constraint and the column on leave_ledger (statement 2 below), then
-- DROP TABLE leave_bf_import_run.

CREATE TABLE IF NOT EXISTS leave_bf_import_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  -- Who ran it. person_id gives the display name; user_id attributes an admin with no person row (an
  -- operator / support login), so "who" is never blank for an import that definitely had an actor.
  created_by_person_id uuid REFERENCES person(id),
  created_by_user_id text,
  -- The uploaded file's name, '' when the rows were pasted rather than uploaded. NOT the file.
  file_name text NOT NULL DEFAULT '',
  -- The reporter's own two options. Recorded because two runs of the same file under the two modes do
  -- different things to a balance, and "which was this?" must be answerable months later from the record.
  import_mode text NOT NULL DEFAULT 'replace',
  total_rows integer NOT NULL DEFAULT 0,
  imported_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  -- Ledger rows actually written. See the header: NOT part of total = imported + failed.
  ledger_rows integer NOT NULL DEFAULT 0,
  -- [{ rowNum, employeeId, leaveCode, entitlementYear, errors: [...] }] — identity + reason only, never
  -- the row's data. Capped by core/leave-bf-import.ts LEAVE_BF_ERROR_CAP.
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- True when more rows were rejected than `errors` holds. The screen says so rather than letting HR
  -- believe a truncated report is the whole story.
  errors_truncated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 0353's rule: a rollback writes COMPENSATING rows and never deletes, and this pair stops the screen
  -- offering the same run twice.
  reversed_at timestamptz,
  reversed_by_user_id text,
  CONSTRAINT leave_bf_import_run_counts_ck CHECK (
    total_rows >= 0 AND imported_rows >= 0 AND failed_rows >= 0 AND ledger_rows >= 0
  ),
  -- The reporter's two modes and nothing else. A third value would reach the posting logic as an
  -- unhandled branch, and the posting logic is what moves days.
  CONSTRAINT leave_bf_import_run_mode_ck CHECK (import_mode IN ('replace', 'add')),
  -- 0353's `leave_adjustment_batch_reversal_pair_check`, for the same reason: a reversed_at with no actor
  -- loses who did it; an actor with no timestamp leaves the run looking live and re-reversible.
  CONSTRAINT leave_bf_import_run_reversal_pair_ck CHECK ((reversed_at IS NULL) = (reversed_by_user_id IS NULL))
);--> statement-breakpoint

-- The log is "this tenant's, most recent first".
CREATE INDEX IF NOT EXISTS leave_bf_import_run_tenant_created_idx
  ON leave_bf_import_run (tenant_id, created_at DESC);--> statement-breakpoint

ALTER TABLE leave_bf_import_run ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_bf_import_run TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS leave_bf_import_run_rls ON leave_bf_import_run;--> statement-breakpoint
CREATE POLICY leave_bf_import_run_rls ON leave_bf_import_run FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

COMMENT ON TABLE leave_bf_import_run IS
  'db55d08a — one row per Leave B/F Data Import RUN: who, when, which file, which mode, the counts, and the per-row reasons rejected rows were not imported. Also the ROLLBACK BATCH: leave_ledger.bf_import_run_id points here, and reversing writes compensating adjustment rows carrying the same run id rather than deleting anything. The uploaded FILE is deliberately never stored.';--> statement-breakpoint
COMMENT ON COLUMN leave_bf_import_run.import_mode IS
  'db55d08a — ''replace'' (the reporter''s recommended default: negate what a PREVIOUS B/F import put there, then write the new figure) or ''add'' (write the figure alone). Replace negates only rows carrying a bf_import_run_id — never the rest of the prior-year balance, which holds real accruals, debits and adjustments.';--> statement-breakpoint
COMMENT ON COLUMN leave_bf_import_run.ledger_rows IS
  'db55d08a — leave_ledger rows this run wrote, which is NOT imported_rows: a Replace line writes two (the negation and the new figure) and a figure of 0 over nothing writes none. Deliberately outside the total = imported + failed identity.';--> statement-breakpoint

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) `leave_ledger.bf_import_run_id` — the link, and the CHECK that keeps the rollback arithmetic sound
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- NULLABLE, and NULL is the state of every row already in the table plus every row any existing writer
-- creates. This is 0353's `adjustment_batch_id` in the same shape and for the same reason.
--
-- ⚠️ EVERY WRITER OF `leave_ledger` WAS LISTED BEFORE THIS CONSTRAINT WAS WRITTEN (CLAUDE.md §6: a CHECK,
-- NOT VALID or otherwise, fires on every UPDATE by every writer). The INSERT sites are
-- core/leave.ts, core/org.ts, core/toil.ts, core/leave-adjustment.ts, core/leave-import.ts,
-- core/leave-history-import.ts, scripts/reverse-ineligible-leave-grants.ts and the new
-- core/leave-bf-import.ts. There is NO `update(leaveLedger)` anywhere in the repo — the table is
-- append-only by ADR-0006 — and the two scripts that touch it otherwise
-- (reset-entitlement-configuration.ts, reset-medical-hospitalization-ledger.ts) only DELETE, which no
-- CHECK constrains. Only the new importer ever sets this column, so the constraint is satisfied by
-- construction for every existing row and every other writer, and it is added VALID rather than NOT VALID
-- because validating it is a scan over a column that is NULL everywhere.
--
-- WHY THE CONSTRAINT AT ALL: undoing a run SUMS the rows carrying its id and writes their negations. An
-- accrual or a debit swept in by mistake would be handed back as entitlement — 0353's words, and the same
-- failure here. It is also what makes Replace mode safe: Replace negates only rows carrying a run id.
--
-- No GRANT is needed: `leave_ledger` is already granted to ai_hr_app and a column inherits the table's
-- privileges (0490's note).

ALTER TABLE leave_ledger
  ADD COLUMN IF NOT EXISTS bf_import_run_id uuid REFERENCES leave_bf_import_run(id);--> statement-breakpoint

-- Partial, because the overwhelming majority of ledger rows will never carry a run and there is no reason
-- to index their NULLs (0353's precedent). The rollback and the Replace lookup are both `WHERE
-- bf_import_run_id = ?` / `IS NOT NULL`.
CREATE INDEX IF NOT EXISTS leave_ledger_bf_import_run_idx
  ON leave_ledger (bf_import_run_id)
  WHERE bf_import_run_id IS NOT NULL;--> statement-breakpoint

ALTER TABLE leave_ledger
  DROP CONSTRAINT IF EXISTS leave_ledger_bf_import_is_adjustment_check;--> statement-breakpoint
ALTER TABLE leave_ledger
  ADD CONSTRAINT leave_ledger_bf_import_is_adjustment_check
  CHECK (bf_import_run_id IS NULL OR entry_type = 'adjustment');--> statement-breakpoint

COMMENT ON COLUMN leave_ledger.bf_import_run_id IS
  'db55d08a — the Leave B/F Data Import run that wrote this row. NULL for every other writer and every row that predates migration 0497. Confined to entry_type=''adjustment'' by leave_ledger_bf_import_is_adjustment_check: the B/F importer writes an ADJUSTMENT and never an ACCRUAL, because an accrual dated inside a leave year satisfies yearOpenMarkerCond and makes Generate Entitlement grant that employee nothing for the year.';
