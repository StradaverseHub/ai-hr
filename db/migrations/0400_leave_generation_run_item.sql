-- 93249794 — Generate Entitlement: THE PER-EMPLOYEE LINES of a run's processing log.
--
-- The reporter asked for a per-employee error table ("| Employee | Error |") and for a log HR can download
-- afterwards. Both need one row per (employment, leave type) with the verdict on it — the summary counters
-- on leave_generation_run (0399) cannot produce either.
--
-- ⚠️ `outcome` IS NOT A NEW CLASSIFICATION. Every value it can hold is `LeaveYearGrantOutcome` in
-- core/leave.ts, and every one of those is a LABEL ON A BRANCH openLeaveYear already had. The screen's
-- Validation & Preview step is a DRY RUN of that same function, so the verdict shown before the run and
-- the verdict stored after it come from one pass of one engine. The build notes are explicit that anything
-- else drifts: "build it as a DRY RUN over the same resolver the real run uses, not a separate list of
-- checks".
--
--   granted             an accrual row was written, at `days`
--   unconfigured_method bc36c768's marker — the row is written at 0 days and carry/expiry keep working
--   already_open        this pair already had a 1-January accrual row (the reporter's "duplicate")
--   frozen              ADR-0069, an active encashment snapshot locks the balance
--   earned_method       ADR-0040, this type accrues monthly through accrueEarnedLeave instead
--   no_entitlement      the composition resolved 0 days or fewer — nothing is configured, or zero is
--   pack_blocked        ADR-0077 slice 6, the company's country pack is not active
--
-- The list is deliberately NOT a database CHECK. A new branch in the engine must be able to start being
-- logged in the same commit that introduces it, and a CHECK would make the log the thing that refuses the
-- deploy. The values are pinned by test/leave-generation.test.ts against the TypeScript union instead,
-- which is where a divergence is actually fixable.
--
-- APPEND-ONLY. Rows are written once, at the end of a run, and never updated — the same posture as
-- leave_entitlement_recalc_audit and leave_ledger. A re-run writes a NEW run with new items; it never
-- edits the old one, because "what did we think last Tuesday" is the question this table exists to answer.

CREATE TABLE IF NOT EXISTS leave_generation_run_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  -- ON DELETE CASCADE: an item without its run is unreadable (it carries no year and no scope). Nothing
  -- in the application deletes a run, so this is a shape statement rather than a code path.
  run_id uuid NOT NULL REFERENCES leave_generation_run(id) ON DELETE CASCADE,
  employment_id uuid NOT NULL REFERENCES employment(id),
  leave_type_id uuid NOT NULL REFERENCES leave_type(id),
  -- See the header. Free text by design, pinned to the engine's union by test rather than by CHECK.
  outcome text NOT NULL,
  -- The accrual days posted for this pair. 0 on every non-granting outcome.
  days numeric(6, 2) NOT NULL DEFAULT 0,
  -- Carry brought into the year after the cap and the max-balance clamp, and the excess forfeited at the
  -- boundary. Stored because the forfeit is the number an employee notices and asks about later.
  carry numeric(6, 2) NOT NULL DEFAULT 0,
  forfeit numeric(6, 2) NOT NULL DEFAULT 0,
  -- fa3f4ccb: the resolved figure is under the statutory minimum for the type. ADVISORY — the floor has
  -- not clamped since fa3f4ccb, at the reporter's written request, so this records a warning the engine
  -- computed and did not act on.
  below_statutory_floor boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The two reads this table has: the run's own log (download / detail table), and "what happened to this
-- employee" from the employee side.
CREATE INDEX IF NOT EXISTS leave_generation_run_item_run_idx
  ON leave_generation_run_item (tenant_id, run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS leave_generation_run_item_employment_idx
  ON leave_generation_run_item (tenant_id, employment_id, leave_type_id);
--> statement-breakpoint

-- One verdict per (run, employment, leave type). A second row for the same pair inside one run could only
-- be a double-write, and a log that can double-count is a log nobody can reconcile against the ledger.
CREATE UNIQUE INDEX IF NOT EXISTS leave_generation_run_item_uq
  ON leave_generation_run_item (run_id, employment_id, leave_type_id);
--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
-- Explicit, for the reason spelled out in 0399 and in 0396: production's ALTER DEFAULT PRIVILEGES masks
-- the omission and a developer cluster does not, so the first real render is where it surfaces. Idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_generation_run_item" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- Identical to its parent (0399) and to leave_entitlement_recalc_audit (0245): tenant-READ, admin-WRITE.
ALTER TABLE leave_generation_run_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS leave_generation_run_item_rls ON "leave_generation_run_item";
--> statement-breakpoint
CREATE POLICY leave_generation_run_item_rls ON "leave_generation_run_item" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
