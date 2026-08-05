-- 49e7e0a2 — Individual Transaction editing after a run is PROCESSED.
--
-- Editing was previously refused once a run left draft. On this system that is a permanent freeze:
-- every payroll run measured on production sits at `processed`, so the draft-only window is never open.
-- Opening it is only safe if the run can SAY that its figures no longer match its inputs, so this
-- migration adds that statement and the timestamp that makes an edit visible at all.
--
-- No new payroll status. `payroll_status` stays exactly ('draft','processed','closed').
-- No table is created, so the existing GRANTs / RLS policies on both tables continue to apply unchanged.

-- The run's recalculation mark: set on any post-processing ledger write, cleared when the affected
-- employees have been reprocessed. `close` is refused while it is set.
ALTER TABLE payroll_batch ADD COLUMN IF NOT EXISTS needs_recalc_at timestamptz;

-- Exactly the employments to hand to the existing selective reprocess. Written in the same statement as
-- needs_recalc_at so the two can never disagree.
ALTER TABLE payroll_batch ADD COLUMN IF NOT EXISTS recalc_employment_ids jsonb;

-- When a one-off transaction was last CHANGED. NULL on every existing row and on any row never edited,
-- so nothing is backfilled and no read changes meaning. The one staleness detector that existed
-- (arrivedAfterProcessing = max(created_at) > processed_at) is blind to an edit; this is what it needs.
ALTER TABLE payroll_individual_txn ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Finding the dirty runs is a "which runs are waiting on me" question the payroll list asks, so index the
-- marked rows only (partial: on a healthy system almost every row is NULL).
CREATE INDEX IF NOT EXISTS payroll_batch_needs_recalc_idx
  ON payroll_batch (tenant_id, needs_recalc_at)
  WHERE needs_recalc_at IS NOT NULL;
