-- r81b · 9cbf5e0d — "Employee Status Not Following Defined Business Rules" (Employee Status state machine).
--
-- THE RULE SET THE REPORTER SUPPLIED: six statuses, three retired, and NO MANUAL EDITING. Employee Status
-- is DERIVED — from the confirmation date, a resignation, a blacklist event, or a payroll hold — and there
-- is no field anyone types it into. This migration is the schema half of that: it removes the stored,
-- editable status and the enum whose values the reporter retired.
--
-- ── WHAT IS REMOVED, AND WHY REMOVED RATHER THAN NARROWED ───────────────────────────────────────────
--   assignment.status              (assignment_status NOT NULL)
--   type assignment_status         ('active','on_leave','probation','offboarding','terminated')
--
-- Three of those five values — on_leave, offboarding, terminated — are retired outright by the reporter's
-- rules. The obvious smaller change is to narrow the enum to the surviving two and keep the column. That
-- was rejected: with manual editing gone, the only remaining writer was hireEmployee, which set the column
-- once on the day someone was hired and never touched it again. A column that is written once, can never be
-- corrected, and disagrees with the screens the moment an employee passes confirmation is not a smaller
-- risk than dropping it — it is the same drift this request exists to end, kept alive under a shorter enum.
-- So the column goes, and Employee Status has exactly ONE definition:
--   core/employment-status.ts      (TypeScript, for React)
--   core/employment-status-sql.ts  (the SQL twin, for WHERE clauses and wide reads)
-- pinned equal to each other by test/personnel-status-sync.test.ts.
--
-- ── NOBODY'S STATUS MOVES BECAUSE OF THIS MIGRATION ─────────────────────────────────────────────────
-- Every screen that displays Employee Status — Personnel, Personnel (Admin), the employee profile, the
-- dashboard, the leave directory, the analytics dashboard and its filter — ALREADY derived it before this
-- migration ran (R43 c26c3ce5, then 5afcda91 and r75/9cbf5e0d). The dropped column was not on any of those
-- paths. Dropping it therefore changes ZERO displayed statuses: the value each employee reads the day this
-- ships is the value they read the day before. The STEP 1 notice block below proves that per row rather
-- than asserting it — it prints the stored value beside the derived one for every employment that carried a
-- retired value, so the deploy log itself is the before/after record the reporter was promised.
--
-- ── THE ONE PLACE BEHAVIOUR DOES CHANGE (STEP 2) ────────────────────────────────────────────────────
-- Performance review-cycle eligibility (`review_cycle.eligibility_rules -> 'statuses'`) is the only
-- consumer that ever GATED on the stored column rather than displaying it. Its stored rules name statuses
-- by value, so they are remapped here, in the open:
--     active       -> active                  (unchanged)
--     probation    -> probation               (unchanged)
--     on_leave     -> active                  On Leave is retired; under the new rules somebody on leave
--                                             is simply Active — leave is an absence, not a status.
--     offboarding  -> active_serving_notice   The retired value's exact successor: a recorded resignation
--                                             whose last working day has not arrived.
--     terminated   -> resigned                Resigned replaces Terminated, as the reporter specified.
-- Duplicates are collapsed (on_leave + active both map to active). A cycle carrying such a rule WILL select
-- a slightly different population than it would have yesterday — because it is now matched against the
-- employee's real, dated status instead of a hand-typed column nobody was allowed to keep current. That is
-- the correction, not a side effect, and scripts/report-employee-status-retirement.ts prints every affected
-- cycle by name BEFORE this migration is applied.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────
-- TERMINATION: item ae9350f2 (approved, unbuilt) creates a Termination movement that sets the lifecycle
-- date on its effective date. This migration adds no termination handling and no termination column. The
-- seam is `employment.terminated_on`, which the deriver already reads as one of its three end dates
-- (core/employment-status.ts, `earliest(resignationDate, lastWorkingDate, terminatedOn)`): ae9350f2 writes
-- that date and the status follows with no further change here.
-- EFFECTIVE DATE: item 941c9dac (approved, unbuilt) separates effective date from entry date. The deriver
-- is already a pure function of (dates, today) and takes `today` as a parameter, so it needs no parallel
-- mechanism — when 941c9dac lands, the dates it writes flow through unchanged.
-- WITHHOLD: modelled as a derivation INPUT (`payrollHoldAt`) with no column and no writer, exactly as the
-- plan requires. No payroll-hold column is created here. Until Payroll grows that setting the bucket is
-- unreachable, so this migration cannot and does not put anyone into it.
--
-- ── IDEMPOTENCE / FRESH-CHAIN SAFETY ────────────────────────────────────────────────────────────────
-- Every statement is guarded (IF EXISTS, or an information_schema existence check), so a re-run is a no-op
-- and a FRESH database — which replays this whole chain inside ONE transaction — takes the guarded path
-- rather than failing on an already-absent column. Note the standing enum trap this project hit today: a
-- newly-added enum value cannot be used in the transaction that added it. It does not bite here (nothing
-- is added, and STEP 2 compares JSONB TEXT, never an enum literal), but STEP 1 still casts with
-- `status::text` rather than comparing against enum literals, so the block is safe under any chain order.
-- Verified on a fresh chain via scripts/fresh-migrate.sh, not only against an existing database.

-- ── STEP 1 · Report, per employment, every stored value that is being retired ────────────────────────
-- Read-only. Prints stored-vs-derived so the drop is auditable from the deploy log alone. The derivation
-- repeated inline here is core/employment-status-sql.ts verbatim (blacklist > end dates > confirmation);
-- it is duplicated ONLY inside this one-shot notice block, never in a live read path.
DO $$
DECLARE
  r record;
  n_retired int := 0;
  n_changed int := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'assignment' AND column_name = 'status'
  ) THEN
    RAISE NOTICE '0331 STEP 1: assignment.status already dropped — nothing to report (re-run or fresh chain).';
    RETURN;
  END IF;

  FOR r IN EXECUTE $q$
    SELECT e.employee_code,
           a.status::text AS stored,
           CASE
             WHEN e.blacklisted_at IS NOT NULL THEN 'blacklisted'
             WHEN least(e.resignation_date, e.last_working_date, e.terminated_on) IS NOT NULL
                  AND current_date >= least(e.resignation_date, e.last_working_date, e.terminated_on) THEN 'resigned'
             WHEN least(e.resignation_date, e.last_working_date, e.terminated_on) IS NOT NULL THEN 'active_serving_notice'
             WHEN coalesce(e.final_confirmation_date, e.confirmation_date) IS NOT NULL
                  AND current_date < coalesce(e.final_confirmation_date, e.confirmation_date) THEN 'probation'
             ELSE 'active'
           END AS derived
    FROM assignment a
    JOIN employment e ON e.id = a.employment_id
    WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
    ORDER BY e.employee_code
  $q$
  LOOP
    IF r.stored IN ('on_leave', 'offboarding', 'terminated') THEN
      n_retired := n_retired + 1;
      RAISE NOTICE '0331 retired-value holder: employee % — stored "%" (retired) -> displayed "%"', r.employee_code, r.stored, r.derived;
    END IF;
    IF r.stored IS DISTINCT FROM r.derived THEN
      n_changed := n_changed + 1;
    END IF;
  END LOOP;

  -- n_changed counts rows where the DROPPED column disagreed with what the screens were already showing.
  -- It is expected to be non-zero and is not a status move: the derived value was authoritative before
  -- this migration and is unchanged by it. Printed so the size of the historical drift is on the record.
  RAISE NOTICE '0331 STEP 1 summary: % employment(s) held a retired value; % held a value that already disagreed with the displayed status. Displayed statuses are UNCHANGED by this migration.', n_retired, n_changed;
END $$;--> statement-breakpoint

-- ── STEP 2 · Remap performance-eligibility rules off the retired vocabulary ──────────────────────────
-- Guarded on the presence of a `statuses` key so it touches only the cycles that actually use the
-- predicate; jsonb_agg over DISTINCT collapses the duplicates the mapping can create. Idempotent: the
-- mapping is a no-op on already-migrated values (active -> active, resigned -> resigned, and so on).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'review_cycle' AND column_name = 'eligibility_rules'
  ) THEN
    UPDATE review_cycle rc
    SET eligibility_rules = jsonb_set(
      rc.eligibility_rules,
      '{statuses}',
      (
        SELECT jsonb_agg(DISTINCT mapped)
        FROM jsonb_array_elements_text(rc.eligibility_rules -> 'statuses') AS s(v)
        CROSS JOIN LATERAL (
          SELECT CASE s.v
                   WHEN 'on_leave'    THEN 'active'
                   WHEN 'offboarding' THEN 'active_serving_notice'
                   WHEN 'terminated'  THEN 'resigned'
                   ELSE s.v
                 END
        ) AS m(mapped)
      )
    )
    WHERE rc.eligibility_rules IS NOT NULL
      AND jsonb_typeof(rc.eligibility_rules -> 'statuses') = 'array'
      AND jsonb_array_length(rc.eligibility_rules -> 'statuses') > 0;
  END IF;
END $$;--> statement-breakpoint

-- ── STEP 3 · Drop the column, then the type it used ─────────────────────────────────────────────────
-- Order matters: the type cannot be dropped while a column is still typed by it. No other column, view,
-- function, index or constraint references either (verified by exhaustive search over db/migrations and
-- the schema); assignment's own index is on (employment_id, valid_from) and is untouched.
ALTER TABLE "assignment" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."assignment_status";--> statement-breakpoint

-- ── STEP 4 · Grants, re-stated ──────────────────────────────────────────────────────────────────────
-- No RLS policy on `assignment` or `review_cycle` referenced the dropped column, so no policy changes.
-- Dropping a column does not revoke a table grant; the grants are re-stated explicitly rather than assumed,
-- per the migration standard (a no-op re-grant on an existing grant is harmless and makes the intent
-- checkable in one place).
GRANT SELECT, INSERT, UPDATE, DELETE ON "assignment" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "review_cycle" TO ai_hr_app;
