-- 491c499f — Leave Adjustments becomes a place, and a bulk adjustment becomes REVERSIBLE AS A UNIT.
--
-- Adjustments are made today from inside a leave type's Entitlement step (the festive-grant card). They
-- write one leave_ledger 'adjustment' row per targeted employment and ONE summary domain_event whose
-- aggregate_id is the TENANT — so afterwards there is no way to find the rows a single action wrote.
-- core/leave-import.ts:298 has the same shape: it mints a batch uuid purely as an event aggregate_id, and
-- the ledger rows it writes carry no link back to it.
--
-- That is the gap this migration closes. The approved plan's requirement is explicit: "a grant applied to
-- many employees at once needs a way to see what it did afterwards ... so a mistake can be found and
-- reversed as a unit rather than employee by employee". A shared reference on every row it writes is the
-- only thing that makes that possible; an event alone cannot locate the rows.

-- ── The batch header ──────────────────────────────────────────────────────────────────────────────────
--
-- One row per ADJUSTMENT ACTION, not per employee. It records what was asked for, so the screen can list
-- what happened without re-deriving it from the ledger, and so a reversal knows what it is undoing.
--
-- WHY A TABLE AND NOT JUST A COLUMN ON THE LEDGER. The ledger is per-employee and append-only. The batch
-- carries facts that belong to the ACTION and would otherwise be duplicated onto every row it wrote (who,
-- why, which criteria, how many were targeted vs actually written) — and duplicated facts drift. It also
-- gives the reversal somewhere to record itself that is not another ledger row.
CREATE TABLE IF NOT EXISTS leave_adjustment_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  -- The app_user who ran it. NOT the employment: an adjustment is an administrative act, and the person
  -- who performed it may not be an employee of the company they acted on.
  actor_user_id uuid REFERENCES app_user(id),
  -- What was applied. days is SIGNED — unlike the festive grant, which refuses anything <= 0, an
  -- adjustment must be able to take days away as well as give them. That is what "adjustment" means, and
  -- core/read.ts classifyLedgerAdjustment already counts a negative human-reason row as a config
  -- adjustment, so the read side is ready for it.
  days numeric(6, 2) NOT NULL,
  effective_on date NOT NULL,
  -- The HUMAN reason, copied onto every ledger row this batch writes. NOT NULL and non-blank on purpose:
  -- classifyLedgerAdjustment treats a NULL reason as a 'config' adjustment, so a blank one would be
  -- indistinguishable from a configured entitlement change on the balance breakdown.
  reason text NOT NULL,
  -- 'criteria' (resolved from filters) or 'individual' (explicitly picked). Recorded because the same
  -- resulting set means different things, and re-running a criteria batch later can legitimately hit a
  -- different set of people.
  target_mode text NOT NULL,
  -- The criteria as posted, for a 'criteria' batch. Kept verbatim so the screen can show what was asked
  -- rather than what it resolved to.
  criteria jsonb,
  -- How many employments were resolved, and how many rows were actually written. They differ when a
  -- target is skipped (a frozen encashment snapshot, an already-identical row).
  targeted_count integer NOT NULL DEFAULT 0,
  written_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Reversal is recorded HERE rather than by deleting rows. The ledger is append-only: a reversal writes
  -- compensating rows, and this pair says the batch has been undone so the screen stops offering it twice.
  reversed_at timestamptz,
  reversed_by_user_id uuid REFERENCES app_user(id)
);
--> statement-breakpoint

-- A blank reason would read as "configured entitlement change" on the balance breakdown. Refused here, not
-- only in the form, because the form is not the only possible writer.
ALTER TABLE leave_adjustment_batch
  DROP CONSTRAINT IF EXISTS leave_adjustment_batch_reason_check;
--> statement-breakpoint
ALTER TABLE leave_adjustment_batch
  ADD CONSTRAINT leave_adjustment_batch_reason_check CHECK (btrim(reason) <> '');
--> statement-breakpoint

-- A human reason must never collide with the machine codes the sweeps write. core/leave.ts documents that
-- 'sys:' can never be typed by a human; this makes that an invariant rather than an expectation, because
-- a sys:-prefixed human row would be swept up by the forfeit and recalc reconciliation queries.
ALTER TABLE leave_adjustment_batch
  DROP CONSTRAINT IF EXISTS leave_adjustment_batch_reason_not_system_check;
--> statement-breakpoint
ALTER TABLE leave_adjustment_batch
  ADD CONSTRAINT leave_adjustment_batch_reason_not_system_check CHECK (reason NOT LIKE 'sys:%');
--> statement-breakpoint

-- Zero days is not an adjustment. It would write a ledger row that changes nothing and shows up in the
-- breakdown as an event that did not happen.
ALTER TABLE leave_adjustment_batch
  DROP CONSTRAINT IF EXISTS leave_adjustment_batch_days_check;
--> statement-breakpoint
ALTER TABLE leave_adjustment_batch
  ADD CONSTRAINT leave_adjustment_batch_days_check CHECK (days <> 0);
--> statement-breakpoint

ALTER TABLE leave_adjustment_batch
  DROP CONSTRAINT IF EXISTS leave_adjustment_batch_target_mode_check;
--> statement-breakpoint
ALTER TABLE leave_adjustment_batch
  ADD CONSTRAINT leave_adjustment_batch_target_mode_check CHECK (target_mode IN ('criteria', 'individual'));
--> statement-breakpoint

-- Both halves of the reversal move together, or neither does. A reversed_at with no actor loses who did
-- it; an actor with no timestamp leaves the batch looking live.
ALTER TABLE leave_adjustment_batch
  DROP CONSTRAINT IF EXISTS leave_adjustment_batch_reversal_pair_check;
--> statement-breakpoint
ALTER TABLE leave_adjustment_batch
  ADD CONSTRAINT leave_adjustment_batch_reversal_pair_check
  CHECK ((reversed_at IS NULL) = (reversed_by_user_id IS NULL));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS leave_adjustment_batch_tenant_idx
  ON leave_adjustment_batch (tenant_id, created_at DESC);
--> statement-breakpoint

-- ── The link from the ledger ──────────────────────────────────────────────────────────────────────────
--
-- NULLABLE, and NULL is the state of every row already in the table plus every row any existing writer
-- creates. Nothing about the accrual, debit, forfeit, recalc or festive-grant paths changes: they simply
-- do not set it. Only the new screen does.
ALTER TABLE leave_ledger
  ADD COLUMN IF NOT EXISTS adjustment_batch_id uuid REFERENCES leave_adjustment_batch(id);
--> statement-breakpoint

-- The index the reversal needs. Partial, because the overwhelming majority of ledger rows will never carry
-- a batch and there is no reason to index their NULLs.
CREATE INDEX IF NOT EXISTS leave_ledger_adjustment_batch_idx
  ON leave_ledger (adjustment_batch_id)
  WHERE adjustment_batch_id IS NOT NULL;
--> statement-breakpoint

-- Only an 'adjustment' row may belong to a batch. An accrual or a debit carrying a batch reference would
-- make the reversal arithmetic wrong in a way nothing else would catch: reversing a batch sums its rows,
-- and a debit swept in by mistake would be handed back as entitlement.
ALTER TABLE leave_ledger
  DROP CONSTRAINT IF EXISTS leave_ledger_batch_is_adjustment_check;
--> statement-breakpoint
ALTER TABLE leave_ledger
  ADD CONSTRAINT leave_ledger_batch_is_adjustment_check
  CHECK (adjustment_batch_id IS NULL OR entry_type = 'adjustment');
--> statement-breakpoint

-- ── RLS ───────────────────────────────────────────────────────────────────────────────────────────────
-- Same shape as every other tenant table: the app role sees only its own tenant's rows.
ALTER TABLE leave_adjustment_batch ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE leave_adjustment_batch FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS leave_adjustment_batch_rls ON leave_adjustment_batch;
--> statement-breakpoint
CREATE POLICY leave_adjustment_batch_rls ON leave_adjustment_batch FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
