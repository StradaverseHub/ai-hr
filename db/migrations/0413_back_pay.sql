-- 2ef69d1e — Back Pay (Arrears): the run + its evidence lines.
--
-- ⚠️ READ THIS BEFORE CHANGING ANYTHING HERE: NOTHING IN THIS FEATURE RECOMPUTES A CLOSED PAYSLIP.
-- A backdated salary revision leaves the employee short for every month already paid. The two ways out
-- before this migration were to reopen a finished month and re-run it — which rewrites payslips employees
-- have already seen — or to work the arrears out on a spreadsheet. Neither is acceptable, so back pay is
-- modelled as a NEW payable difference that rides the CURRENT run: these two tables record what was
-- computed and agreed, and the only employee-visible write the feature performs is ordinary
-- `payroll_individual_txn` rows on the target (current) period. `payslip` is never written, no batch is
-- reopened, and `generatePayslips` gains no preview mode (the golden tests demand byte-identical output).
--
-- ── THE DUPLICATE GUARD IS `source_compensation_id`, AND IT IS THE POINT ─────────────────────────────
-- Paying the same backdated rise twice is the most expensive mistake this screen could make. Detection
-- therefore EXCLUDES any compensation row already carried by a line of a live (non-cancelled) run, so the
-- guard is a join, not a flag someone has to remember to set. Cancelling a run is what releases the
-- revision back to detection — which is exactly the plan's "refuse to calculate the same salary change a
-- second time unless the earlier back pay has been cancelled first".
--
-- ── SIGN ─────────────────────────────────────────────────────────────────────────────────────────────
-- `difference` is SIGNED and money moves BOTH WAYS. Measured on production 2026-08-06: 26 backdated
-- compensation rows across 22 employees and 3 periods, 9 with a real salary difference, and one of them
-- is 6000 → 5500. A negative run posts as a DEDUCTION (payroll_individual_txn amounts are magnitudes and
-- the `kind` carries the sign) through the same approval. Nothing here may assume arrears are owed to the
-- employee.

CREATE TABLE IF NOT EXISTS back_pay_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  company_id uuid NOT NULL REFERENCES company(id),
  -- 'YYYY-MM' — the CURRENT period the arrears are PAID in. Never one of the affected months.
  target_pay_period text NOT NULL,
  -- Reuses the payroll_run_type taxonomy rather than inventing a second cycle vocabulary.
  target_run_type payroll_run_type NOT NULL DEFAULT 'regular',
  -- draft → verified → posted, or cancelled from any of them. TEXT, not an enum: a later state must not
  -- need a migration, and nothing outside core/back-pay.ts switches on the value.
  status text NOT NULL DEFAULT 'draft',
  created_by_user_id uuid REFERENCES app_user(id),
  -- NULL until Approve and Post. The whole promise of the screen is that no money moves before a named
  -- human agrees to the figures.
  approved_by_user_id uuid REFERENCES app_user(id),
  approved_at timestamptz,
  posted_at timestamptz,
  cancelled_by_user_id uuid REFERENCES app_user(id),
  cancelled_at timestamptz,
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE back_pay_run DROP CONSTRAINT IF EXISTS back_pay_run_status_check;
--> statement-breakpoint
ALTER TABLE back_pay_run ADD CONSTRAINT back_pay_run_status_check
  CHECK (status IN ('draft', 'verified', 'posted', 'cancelled'));
--> statement-breakpoint

-- 'YYYY-MM', stated in the database because a malformed target period is the one input here that would
-- post money into a month that does not exist. Mirrors the 0175 CHECK on payroll_individual_txn.pay_period.
ALTER TABLE back_pay_run DROP CONSTRAINT IF EXISTS back_pay_run_period_check;
--> statement-breakpoint
ALTER TABLE back_pay_run ADD CONSTRAINT back_pay_run_period_check
  CHECK (target_pay_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS back_pay_run_tenant_company_idx ON back_pay_run (tenant_id, company_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS back_pay_run_target_idx ON back_pay_run (tenant_id, company_id, target_pay_period);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS back_pay_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id uuid NOT NULL REFERENCES back_pay_run(id),
  employment_id uuid NOT NULL REFERENCES employment(id),
  -- THE DUPLICATE GUARD'S KEY — the backdated salary revision this line was computed from.
  source_compensation_id uuid NOT NULL REFERENCES compensation(id),
  -- 'YYYY-MM' of the already-paid month this line reworks.
  affected_period text NOT NULL,
  -- 'BASIC' for the salary line, else the pay_component code. TEXT and not a FK on purpose: a line is a
  -- permanent record of what was computed and agreed, and an item archived afterwards must not make an
  -- approved run unreadable.
  pay_code text NOT NULL,
  pay_item_name text NOT NULL,
  old_amount numeric(12,2) NOT NULL DEFAULT 0,
  -- NULL only on a needs-review line, where naming a figure would be a guess.
  new_amount numeric(12,2),
  -- SIGNED. new − old for an earning; old − new for a deduction (a bigger deduction is less take-home).
  difference numeric(12,2) NOT NULL DEFAULT 0,
  needs_review boolean NOT NULL DEFAULT false,
  -- A stable CODE the UI localises (manualOvertime / hoursNotStored / …), never raw English — the same
  -- discipline core/pay-rule.ts's PayRuleErrorCode follows.
  review_reason text,
  -- The posted one-off transaction this line's money went out on; cleared by Cancel. Lines of the same
  -- (employment, affected period) share one txn: the posting is NETTED per month so the payslip carries
  -- one legible arrears line per covered month rather than one per pay item.
  posted_txn_id uuid REFERENCES payroll_individual_txn(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE back_pay_line DROP CONSTRAINT IF EXISTS back_pay_line_period_check;
--> statement-breakpoint
ALTER TABLE back_pay_line ADD CONSTRAINT back_pay_line_period_check
  CHECK (affected_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
--> statement-breakpoint

-- A needs-review line asserts NOTHING about money: no reworked figure, no difference. Stated here so a
-- future writer cannot quietly post a "reviewed" amount the operator never keyed.
ALTER TABLE back_pay_line DROP CONSTRAINT IF EXISTS back_pay_line_review_check;
--> statement-breakpoint
ALTER TABLE back_pay_line ADD CONSTRAINT back_pay_line_review_check
  CHECK (NOT needs_review OR (new_amount IS NULL AND difference = 0));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS back_pay_line_run_idx ON back_pay_line (run_id, employment_id);
--> statement-breakpoint
-- Detection's exclusion query: "which salary revisions are already carried by a live run?"
CREATE INDEX IF NOT EXISTS back_pay_line_source_idx ON back_pay_line (tenant_id, source_compensation_id);
--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
--
-- STATED EXPLICITLY, not inherited. deploy/bootstrap-db.sql sets ALTER DEFAULT PRIVILEGES FOR ROLE
-- ai_hr_owner, so on production a table this role creates comes out already granted — which is exactly
-- why 0353 shipped a table with no grant and nobody noticed until a developer cluster, where a fresh
-- table can land owned by `postgres`, answered the first real render with `permission denied`. No test
-- sees it: the suite connects as the OWNER. Written the way 0396–0400 do. Idempotent.
--
-- DELETE is granted because the role needs one privilege set, not a per-table opinion. Cancel does NOT
-- delete a run or its lines — a cancelled run stays as the record of what was calculated and withdrawn;
-- it only clears posted_txn_id and removes the one-off transactions it created.
GRANT SELECT, INSERT, UPDATE, DELETE ON "back_pay_run" TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "back_pay_line" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
--
-- These rows are PAY: an arrears line names an employee and a salary difference. So unlike
-- leave_generation_run (tenant-read / admin-write), the READ half is admin-gated too — the precedent is
-- payroll_batch_component and payroll_individual_txn, which carry the same class of figure, not the leave
-- audit tables. Both halves: tenant scope AND app.is_admin().
ALTER TABLE back_pay_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS back_pay_run_rls ON "back_pay_run";
--> statement-breakpoint
-- COMPANY-SCOPED, matching the precedent this file cites rather than merely naming it. `app.is_admin()`
-- alone is true for an hr_admin grant on ANY company in the tenant, so with it a Company A admin could
-- read and cancel Company B's back pay runs — per-employee salary differences are the most sensitive
-- payload here. back_pay_run carries company_id directly, so the term is a plain is_admin_for.
CREATE POLICY back_pay_run_rls ON "back_pay_run" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint

ALTER TABLE back_pay_line ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS back_pay_line_rls ON "back_pay_line";
--> statement-breakpoint
-- The line has no company of its own, so it reaches through its run — exactly the shape
-- payroll_batch_component (0065) uses for the same reason.
CREATE POLICY back_pay_line_rls ON "back_pay_line" FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM back_pay_run r WHERE r.id = run_id AND app.is_admin_for(r.company_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM back_pay_run r WHERE r.id = run_id AND app.is_admin_for(r.company_id))
  );
