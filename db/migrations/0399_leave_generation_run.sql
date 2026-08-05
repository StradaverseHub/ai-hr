-- 93249794 — Generate Entitlement: THE PROCESSING LOG, one row per run.
--
-- The request asks for two things this system had no place to put: "Produce a processing summary and
-- downloadable log upon completion", and "Record every generation process in the Audit Trail, including:
-- user who initiated the process, date and time, Leave Type, Leave Year, employees processed,
-- success/failure count, validation results, processing outcome."
--
-- Until this item the ONLY record a year-open left was its `leave-year.opened` domain event, whose payload
-- is three integers — {year, granted, skipped, forfeits}. That cannot answer "which employees failed and
-- why", and it cannot answer "who ran it and what did they select", because the scope did not exist as a
-- concept before this screen. So the run is recorded here and the per-employee lines in
-- leave_generation_run_item (0400).
--
-- ⚠️ THIS TABLE RECORDS. IT DECIDES NOTHING.
-- No engine reads it, no resolution consults it, and deleting every row would change no employee's
-- entitlement by a single day. openLeaveYear's idempotency marker is, and remains, the LEDGER's own
-- accrual row at 1 January — never a configuration or bookkeeping table. That distinction is deliberate
-- and load-bearing: 4b0e76ae cleared `leave_year_config` precisely because a table that looked like it
-- gated the year-open did not, and the reset had to be argued about first. This one cannot acquire that
-- ambiguity, because nothing reads it.
--
-- ── THE PRECEDENT ─────────────────────────────────────────────────────────────────────────────────────
-- `leave_entitlement_recalc_audit` (0245, R45 7527ea5f) — the human-readable trail of each automatic
-- entitlement recalculation, written alongside the ledger rows that carried the delta. Same posture here:
-- append-only, never mutated, and the ledger stays the source of truth for what was actually granted.
-- The criteria column follows `leave_adjustment_batch` (491c499f): store what was ASKED, not what it
-- resolved to, because re-running the same criteria later can legitimately reach different people and the
-- difference is the interesting part.

CREATE TABLE IF NOT EXISTS leave_generation_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  -- Who pressed Process. An entitlement generation is an administrative act, not an employment fact —
  -- the same reason leave_adjustment_batch.actor_user_id points at app_user rather than employment.
  actor_user_id uuid REFERENCES app_user(id),
  -- The entitlement year the run granted. NOT a FK to leave_year_config: that table was cleared and its
  -- screen removed by 4b0e76ae, and the year list is computed (entitlementYearOptions), so a reference to
  -- it would be a reference to nothing.
  leave_year integer NOT NULL,
  -- The leave types the operator selected, as posted. An EMPTY array is a real and different value: it
  -- means "every type this sweep grants", which is what the unscoped run has always done.
  leave_type_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 'criteria' | 'individual'. The same resolved set means different things: a criteria run is a rule that
  -- can be re-run, an individual run is a list somebody typed.
  target_mode text NOT NULL,
  -- core/org-criteria.ts `OrgCriteria`, exactly as the Leave Adjustments batch and the entitlement
  -- eligibility rules store it. `{}` means EVERYONE and is a legitimate, deliberate value.
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The employment ids given directly in 'individual' mode. Empty in criteria mode.
  employment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- How many employments the selection resolved to, BEFORE the sweep's own year-boundary eligibility.
  employees_selected integer NOT NULL DEFAULT 0,
  -- The three counters openLeaveYear itself returns, stored verbatim so the log and the engine agree.
  granted integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  forfeits integer NOT NULL DEFAULT 0,
  -- The reporter's "235 Successful / 3 Failed", counted in EMPLOYMENTS. Passed = the employee ended the
  -- run holding entitlement for at least one selected type ('granted' OR 'already_open' — the sweep is
  -- idempotent, and a re-run reporting the whole company as failed would be worse than useless). Failed =
  -- reached by the run and holding nothing for any of them. Derived from the run items, stored so the
  -- summary survives without a join and reads the same forever.
  employees_passed integer NOT NULL DEFAULT 0,
  employees_failed integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- 'criteria' or 'individual' and nothing else — the two the screen can post. A third value would make
-- every reader guess.
ALTER TABLE leave_generation_run DROP CONSTRAINT IF EXISTS leave_generation_run_mode_check;
--> statement-breakpoint
ALTER TABLE leave_generation_run ADD CONSTRAINT leave_generation_run_mode_check
  CHECK (target_mode IN ('criteria', 'individual'));
--> statement-breakpoint

-- An object, not an array and not a scalar. `{}` is valid and meaningful — see above.
ALTER TABLE leave_generation_run DROP CONSTRAINT IF EXISTS leave_generation_run_criteria_check;
--> statement-breakpoint
ALTER TABLE leave_generation_run ADD CONSTRAINT leave_generation_run_criteria_check
  CHECK (jsonb_typeof(criteria) = 'object');
--> statement-breakpoint

ALTER TABLE leave_generation_run DROP CONSTRAINT IF EXISTS leave_generation_run_types_check;
--> statement-breakpoint
ALTER TABLE leave_generation_run ADD CONSTRAINT leave_generation_run_types_check
  CHECK (jsonb_typeof(leave_type_ids) = 'array' AND jsonb_typeof(employment_ids) = 'array');
--> statement-breakpoint

-- The same window openLeaveYearAction has always validated (2020..2100). Stated in the database too,
-- because a typo'd year is the one input here that silently produces a completely empty run.
ALTER TABLE leave_generation_run DROP CONSTRAINT IF EXISTS leave_generation_run_year_check;
--> statement-breakpoint
ALTER TABLE leave_generation_run ADD CONSTRAINT leave_generation_run_year_check
  CHECK (leave_year BETWEEN 2020 AND 2100);
--> statement-breakpoint

-- The listing is "the most recent runs for this tenant", which is the only way this table is ever read.
CREATE INDEX IF NOT EXISTS leave_generation_run_tenant_idx ON leave_generation_run (tenant_id, created_at DESC);
--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
--
-- STATED EXPLICITLY, not inherited. deploy/bootstrap-db.sql sets ALTER DEFAULT PRIVILEGES FOR ROLE
-- ai_hr_owner, so on production a table this role creates comes out already granted — which is exactly
-- why 0353 shipped a table with no grant and nobody noticed until a developer cluster, where a fresh
-- table can land owned by `postgres`, answered the first real render with `permission denied`. No test
-- sees it: the suite connects as the OWNER. Written out the way 0396 / 0397 / 0398 do. Idempotent.
--
-- DELETE is granted for the same reason every neighbour has it (the role needs one privilege set, not a
-- per-table opinion); nothing in the application ever issues one, and test/leave-generation.test.ts pins
-- that no core file deletes or updates a row here.
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_generation_run" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
--
-- THE SAME TREATMENT AS ITS NEIGHBOURS: tenant-READ, admin-WRITE — 0245 for
-- leave_entitlement_recalc_audit, 0134 for leave_policy, 0396 for the entitlement template layer. The read
-- half is not admin-gated for consistency with those, and because the guard that actually matters here is
-- the route's: /admin/leave/generate is `requireAdmin`, registered in lib/permissions.ts, and the CSV
-- export refuses a non-admin before it reads a row.
ALTER TABLE leave_generation_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS leave_generation_run_rls ON "leave_generation_run";
--> statement-breakpoint
CREATE POLICY leave_generation_run_rls ON "leave_generation_run" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
