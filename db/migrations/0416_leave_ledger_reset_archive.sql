-- c8052ae3 — THE WRITTEN RECORD OF THE 147 LEAVE-LEDGER ROWS THE MEDICAL / HOSPITALIZATION RESET REMOVES.
--
-- The reporter asked for Medical Leave and Hospitalization Leave to be taken to a clean 0.00 for every
-- employee. The approved plan promises, in these words: "Before anything is removed, copy every affected
-- record into a permanent written record you can read on screen and download, so the old figures are
-- never lost." This table is that sentence, and the listing at /admin/leave/entitlements/ledger-archive
-- plus its CSV are the "read on screen and download" half.
--
-- ⚠️ WHY THERE IS A DELETION HERE AT ALL, AND WHY THAT IS DELIBERATE RATHER THAN CARELESS.
-- `leave_ledger` is documented as APPEND-ONLY, and `leave_adjustment_batch` (0353) reverses by writing
-- compensating rows rather than deleting. That posture is being set aside for this ONE correction, on
-- purpose, and the reasons are specific:
--   · a compensating row cannot cancel the 2027-01-01 and 2028-01-01 grants without posting further
--     future-dated rows for each of those years, which is more of the same problem, not less;
--   · it would leave the entitlement breakdown reading "YTD entitled 14.00" with a "−14.00 correction"
--     beside it, when what the reporter asked for and was promised is a clean 0.00;
--   · deletion is SAFE here only because both types carry ZERO debit rows and ZERO approved leave
--     requests (measured on production 2026-08-07: 0 debits, 1 rejected and 1 cancelled SICK request,
--     nothing approved), so no leave anybody took or was granted is at stake;
--   · and it is made RECOVERABLE by this table, which is written and verified BEFORE anything is deleted.
-- Take away any one of those four and the deletion would not be justified. They are recorded here rather
-- than only in the script, because this table is what a future reader finds first.
--
-- ⚠️ IT COPIES entitlement_reset_archive (0397) — SHAPE AND POSTURE BOTH.
-- Same argument, one layer deeper: every column is TEXT, holds no ids that can dangle and no joins that
-- can fail, so the record stays readable long after the rows, and eventually the leave types, are gone.
-- Same `capture_tag` discipline, so a re-capture can never silently interleave with an earlier one. And
-- the same ADMIN-ONLY RLS on BOTH halves — this is a full dump of who was granted what.
--
-- ONE table for BOTH things the correction removes, discriminated by `layer`:
--   'ledger'       — the leave_ledger rows themselves (production: 147 across the two types).
--   'recalc_audit' — the leave_entitlement_recalc_audit rows that DESCRIBE those ledger rows (22). They go
--                    with them, because an audit row whose ledger row no longer exists is a record of a
--                    correction to nothing. Their figures are the clearest evidence of what went wrong
--                    (previous 180.00 → new 60.00, delta −120.00) so they are archived, not just dropped.

CREATE TABLE IF NOT EXISTS leave_ledger_reset_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  captured_at timestamptz NOT NULL DEFAULT now(),
  -- Which capture run wrote this row. The correction script names its own tag, so a rehearsal on a
  -- restored copy and the real run can never be read as one record.
  capture_tag text NOT NULL,
  -- 'ledger' (leave_ledger) | 'recalc_audit' (leave_entitlement_recalc_audit).
  layer text NOT NULL,
  -- The ORIGINAL row's id, as TEXT and with NO foreign key — deliberately. It is here so a row in this
  -- archive can be tied back to the deployment log and to the script's own output, and a real reference
  -- would be a reference to a row this correction is about to delete.
  source_row_id text,
  -- WHO. Rendered, because the employment this describes may itself be archived one day.
  employee_name text,
  employee_code text,
  employee_email text,
  company_name text,
  -- WHAT. Both the name HR reads and the code the system uses, so a row is findable from either.
  leave_type_name text,
  leave_type_code text,
  -- THE FIGURES, which are the point of the table.
  -- ledger layer: entry type ('accrual' / 'adjustment' / …) and the SIGNED days on the row.
  -- recalc_audit layer: entry_type is NULL and days_text carries the audit row's delta.
  entry_type text,
  days_text text,
  effective_on_text text,
  -- ledger layer: the row's `reason` (e.g. sys:profile_recalc:<employmentId>), verbatim.
  -- recalc_audit layer: the trigger that caused the recalc (e.g. 'grade_changed').
  reason text,
  -- recalc_audit layer only: "previous 180.00 → new 60.00 (delta −120.00)", written out. This is the
  -- sentence that explains every negative balance the reporter reported, so it is rendered rather than
  -- left as three numeric columns nobody joins back together.
  entitlement_text text,
  -- ledger layer only: the leave request this row was sourced from, rendered. Expected to be "not sourced
  -- from a leave request" on EVERY row — production shows zero debits on both types. If a capture ever
  -- writes anything else here, the safety argument above did not hold and the run should be stopped.
  source_request_text text,
  -- When the original row was created, as text.
  recorded_at_text text,
  note text
);
--> statement-breakpoint

ALTER TABLE leave_ledger_reset_archive DROP CONSTRAINT IF EXISTS leave_ledger_reset_archive_layer_check;
--> statement-breakpoint
ALTER TABLE leave_ledger_reset_archive ADD CONSTRAINT leave_ledger_reset_archive_layer_check
  CHECK (layer IN ('ledger', 'recalc_audit'));
--> statement-breakpoint

ALTER TABLE leave_ledger_reset_archive DROP CONSTRAINT IF EXISTS leave_ledger_reset_archive_tag_check;
--> statement-breakpoint
ALTER TABLE leave_ledger_reset_archive ADD CONSTRAINT leave_ledger_reset_archive_tag_check
  CHECK (btrim(capture_tag) <> '');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS leave_ledger_reset_archive_tenant_idx
  ON leave_ledger_reset_archive (tenant_id, capture_tag);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS leave_ledger_reset_archive_layer_idx
  ON leave_ledger_reset_archive (tenant_id, layer);
--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
-- Stated explicitly rather than inherited from production's ALTER DEFAULT PRIVILEGES. That inheritance
-- masks the omission on the deployed database and throws 'permission denied' on the first render against
-- a freshly restored cluster — see 0397 / 0345.
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_ledger_reset_archive" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- ADMIN-ONLY on BOTH halves, exactly as entitlement_reset_archive is and for the same reason: these rows
-- name every employee and every day they were granted. Nothing resolves entitlement from this table, so
-- there is no non-admin reader to serve.
ALTER TABLE leave_ledger_reset_archive ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS leave_ledger_reset_archive_rls ON "leave_ledger_reset_archive";
--> statement-breakpoint
CREATE POLICY leave_ledger_reset_archive_rls ON "leave_ledger_reset_archive" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

-- ── THE CAPTURE IS A FUNCTION, NOT AN INSERT ─────────────────────────────────────────────────────────
--
-- 0398's reasoning, which applies here for one extra reason of its own. The rendering has to be exercised
-- against REAL ROWS before it is trusted, and a migration runs against a database with no tenants in it —
-- so an INSERT here would be a capture of nothing that no test could ever reach. As a function, the same
-- code path the correction script calls on production is called with seeded rows by
-- test/leave-ledger-reset-archive.test.ts.
--
-- AND THIS MIGRATION CAPTURES NOTHING AND DELETES NOTHING. It is the table and the copier only. The
-- deletion is a separate, explicitly-gated, --apply-flagged operator script
-- (scripts/reset-medical-hospitalization-ledger.ts) precisely so that shipping this migration is not the
-- same act as removing a customer's rows.
--
-- SECURITY INVOKER (the default), deliberately: called by the operator's owner credential it sees the
-- tenant it is told to; called by the app it would run under the caller's RLS. One body, correct in both,
-- with no SECURITY DEFINER escalation. The tenant is an explicit ARGUMENT rather than
-- app.current_tenant_id() because the correction runs out of band, where there is no session tenant.

CREATE OR REPLACE FUNCTION app.capture_leave_ledger_reset_archive(
  p_tag text,
  p_tenant uuid,
  p_leave_type_ids uuid[]
)
RETURNS TABLE (ledger_rows int, audit_rows int)
LANGUAGE plpgsql
AS $fn$
DECLARE
  n_ledger int;
  n_audit int;
BEGIN
  IF p_tag IS NULL OR btrim(p_tag) = '' THEN
    RAISE EXCEPTION 'capture_leave_ledger_reset_archive: a capture tag is required.';
  END IF;
  IF p_tenant IS NULL THEN
    RAISE EXCEPTION 'capture_leave_ledger_reset_archive: a tenant id is required.';
  END IF;
  -- An empty or null type list would archive NOTHING and report success, and the caller's next step is a
  -- delete. Refuse rather than return zero.
  IF p_leave_type_ids IS NULL OR array_length(p_leave_type_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'capture_leave_ledger_reset_archive: at least one leave type id is required.';
  END IF;

  -- ── LEDGER LAYER ───────────────────────────────────────────────────────────────────────────────────
  INSERT INTO leave_ledger_reset_archive (
    tenant_id, capture_tag, layer, source_row_id, employee_name, employee_code, employee_email,
    company_name, leave_type_name, leave_type_code, entry_type, days_text, effective_on_text, reason,
    source_request_text, recorded_at_text, note
  )
  SELECT
    ll.tenant_id,
    p_tag,
    'ledger',
    ll.id::text,
    pe.full_name,
    em.employee_code,
    pe.primary_email,
    -- `company.name` does not exist: the column is `legal_name`, with `company_label` as the optional
    -- short form HR actually uses in pickers. Same choice 0398 made, for the same reason.
    coalesce(c.company_label, c.legal_name),
    lt.name,
    lt.code,
    ll.entry_type::text,
    ll.days::text,
    ll.effective_on::text,
    ll.reason,
    -- Expected to be the "no request" string on every row. If it is not, the correction's safety argument
    -- (zero debits, nothing approved) did not hold and the operator must stop.
    CASE
      WHEN ll.source_request_id IS NULL THEN 'not sourced from a leave request'
      ELSE '⚠ sourced from leave request ' || coalesce(lr.start_date::text, '?') || ' → '
             || coalesce(lr.end_date::text, '?') || ' (' || coalesce(lr.status::text, '?') || ')'
    END,
    ll.created_at::text,
    CASE
      WHEN ll.effective_on > (date_trunc('year', now())::date + interval '1 year')::date
        THEN 'Future-dated grant: this row was queued to land by itself in a later leave year.'
      ELSE NULL
    END
  FROM leave_ledger ll
  JOIN employment em ON em.id = ll.employment_id
  LEFT JOIN person pe ON pe.id = em.person_id
  LEFT JOIN company c ON c.id = em.company_id
  LEFT JOIN leave_type lt ON lt.id = ll.leave_type_id
  LEFT JOIN leave_request lr ON lr.id = ll.source_request_id
  WHERE ll.tenant_id = p_tenant
    AND ll.leave_type_id = ANY (p_leave_type_ids)
    -- Re-running the SAME tag must not double the record. A LATER tag is a new snapshot and is expected.
    AND NOT EXISTS (
      SELECT 1 FROM leave_ledger_reset_archive a
      WHERE a.tenant_id = p_tenant AND a.capture_tag = p_tag AND a.layer = 'ledger'
    );
  GET DIAGNOSTICS n_ledger = ROW_COUNT;

  -- ── RECALC-AUDIT LAYER ─────────────────────────────────────────────────────────────────────────────
  -- These rows are the diagnosis in the system's own words. Archiving them is not tidiness: "previous
  -- 180.00 → new 60.00" is the evidence that the negative balances came from the recalc window and not
  -- from leftover configuration, and it must survive the rows it describes.
  INSERT INTO leave_ledger_reset_archive (
    tenant_id, capture_tag, layer, source_row_id, employee_name, employee_code, employee_email,
    company_name, leave_type_name, leave_type_code, days_text, effective_on_text, reason,
    entitlement_text, recorded_at_text, note
  )
  SELECT
    ra.tenant_id,
    p_tag,
    'recalc_audit',
    ra.id::text,
    pe.full_name,
    em.employee_code,
    pe.primary_email,
    coalesce(c.company_label, c.legal_name),
    lt.name,
    lt.code,
    ra.delta::text,
    ra.effective_on::text,
    ra.reason,
    'previous ' || ra.previous_entitlement::text || ' → new ' || ra.new_entitlement::text
      || ' (delta ' || ra.delta::text || ')',
    ra.created_at::text,
    'Describes a leave_ledger row removed by the same correction.'
  FROM leave_entitlement_recalc_audit ra
  JOIN employment em ON em.id = ra.employment_id
  LEFT JOIN person pe ON pe.id = em.person_id
  LEFT JOIN company c ON c.id = em.company_id
  LEFT JOIN leave_type lt ON lt.id = ra.leave_type_id
  WHERE ra.tenant_id = p_tenant
    AND ra.leave_type_id = ANY (p_leave_type_ids)
    AND NOT EXISTS (
      SELECT 1 FROM leave_ledger_reset_archive a
      WHERE a.tenant_id = p_tenant AND a.capture_tag = p_tag AND a.layer = 'recalc_audit'
    );
  GET DIAGNOSTICS n_audit = ROW_COUNT;

  ledger_rows := n_ledger;
  audit_rows := n_audit;
  RETURN NEXT;
END
$fn$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.capture_leave_ledger_reset_archive(text, uuid, uuid[]) TO ai_hr_app;
