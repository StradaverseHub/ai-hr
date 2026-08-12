-- 2961a7ae — Payroll : Statutory Adjustment with full manual override.
--
-- There is nowhere in the system to overrule a statutory figure. Overtime, bonus, TP1 relief, zakat and
-- claim allowances can all be keyed against a run (payroll_input), but EPF, SOCSO, EIS, SKBBK, PCB and the
-- HRD levy come out of the calculation and that is the end of it. If the EPF office confirms a different
-- figure, the only ways out today are to change something upstream and reprocess, or to leave the payslip
-- wrong.
--
-- STORED AS AN INPUT, NOT AS A STAMPED RESULT — the load-bearing design decision.
-- Reprocessing recomputes a payslip from scratch and bumps payslip.version; an override written ONTO the
-- payslip row would be destroyed by the next reprocess, and this reporter reprocesses constantly (their
-- 2026-01 run has been reprocessed twice this month). Storing the override as an input the generator reads
-- makes it idempotent, makes Revert a row delete plus a reprocess, and makes it survive every recompute.
-- This table therefore mirrors payroll_input's shape exactly: one row per (batch, employment).
--
-- NULL IS NOT ZERO, AND THAT IS THE WHOLE REQUIREMENT. Every amount column is NULLABLE with NO DEFAULT:
--   NULL   = no override on this line  → use the system-calculated figure
--   0.00   = override this line to zero → the payslip carries 0.00
-- Defaulting any of these columns to 0 would silently make "blank" and "zero" the same value and destroy
-- the distinction the reporter calls mandatory (their business rules 3 and 4).
--
-- NINE LINES, NOT TEN. The request lists SKBBK / Lindung 24 Jam on both the employee and employer side.
-- localization/my/payroll.ts socso() returns { employer, employee, skbbk } and exposes skbbk as the
-- EMPLOYEE-paid leg only (statutory() → socsoSkbbk, gated by opts.subjectToSkbbk). There is no employer
-- SKBBK figure anywhere in the engine, so there is no column for one here rather than an always-zero tenth.
--
-- NO DATA PRECONDITION. This is a pure CREATE TABLE with no backfill and no dependency on any existing
-- row's contents, so `gate:shadow` (which dumps schema STRUCTURE only, no rows) is a sufficient rehearsal
-- for it. Stated explicitly because a migration whose precondition IS data cannot be rehearsed that way.

CREATE TABLE IF NOT EXISTS "payroll_statutory_adjustment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "batch_id" uuid NOT NULL REFERENCES "payroll_batch"("id"),
  "employment_id" uuid NOT NULL REFERENCES "employment"("id"),

  -- ── The nine overridable lines. ALL NULLABLE, NO DEFAULT — see the note above. ──
  -- Employee side (these reduce/raise the employee's Total Deduction and therefore Net Pay).
  "pcb" numeric(12, 2),
  "epf_employee" numeric(12, 2),
  "socso_employee" numeric(12, 2),
  "socso_skbbk" numeric(12, 2),
  "eis_employee" numeric(12, 2),
  -- Employer side (these move employer cost and CANNOT touch the employee's net pay — that is
  -- structural in core/payroll.ts, which composes employer_cost from the employer legs and net_pay
  -- from the employee legs; it is not a rule anyone has to remember to enforce).
  "hrdf" numeric(12, 2),
  "epf_employer" numeric(12, 2),
  "socso_employer" numeric(12, 2),
  "eis_employer" numeric(12, 2),

  -- Required by the reporter's rule 10: every adjustment, including an adjustment to zero, is captured
  -- with a reason. NOT NULL at the column level so no write path can skip it.
  "reason" text NOT NULL,
  -- Who typed it. payroll_employee_result_history already carries the before/after MONEY on every
  -- regeneration; this is the "who typed what, and why" half that result history does not carry.
  "created_by_user_id" uuid REFERENCES "app_user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One override row per employee per run — the same (batch, employment) uniqueness payroll_input carries,
-- so the screen's save is an upsert and there is never more than one answer for a line.
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_statutory_adjustment_batch_employment_uq"
  ON "payroll_statutory_adjustment" ("batch_id", "employment_id");
--> statement-breakpoint

-- The generator reads every override for a batch in one shot, in the payslip loop.
CREATE INDEX IF NOT EXISTS "payroll_statutory_adjustment_batch_idx"
  ON "payroll_statutory_adjustment" ("batch_id");
--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
-- Explicit and NOT optional: production's ALTER DEFAULT PRIVILEGES masks an omission, so a developer
-- cluster restored from a dump is where "permission denied for table payroll_statutory_adjustment" would
-- surface — on the first payroll GENERATION after the deploy, which is the worst possible place to find
-- it. Same reasoning as 0345 / 0354 / 0357 / 0425 / 0427.
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_statutory_adjustment" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- payroll_input_rls's shape exactly (0099): tenant + the payroll-admin scope of the batch's COMPANY, on
-- both read and write. A company-scoped payroll partner may adjust their own company's runs and no other's.
ALTER TABLE "payroll_statutory_adjustment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "payroll_statutory_adjustment_rls" ON "payroll_statutory_adjustment";
--> statement-breakpoint
CREATE POLICY "payroll_statutory_adjustment_rls" ON "payroll_statutory_adjustment" FOR ALL
  USING (
    "tenant_id" = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = "batch_id" AND app.can_admin_payroll_for(b.company_id))
  )
  WITH CHECK (
    "tenant_id" = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = "batch_id" AND app.can_admin_payroll_for(b.company_id))
  );
