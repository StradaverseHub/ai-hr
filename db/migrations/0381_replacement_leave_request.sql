-- 296fc027 · Step 2 — the EMPLOYEE REQUEST path. A header table plus a worked-date line table, and two
-- small changes to toil_accrual so a self-declared credit can be recorded honestly.
--
-- WHY THIS IS NOT A leave_request ROW, stated here because it is the single most tempting shortcut and
-- the most expensive one. `leave_request` means TIME TAKEN, everywhere, without exception: the balance
-- check refuses it against the employee's entitlement, the team calendar renders it as an absence, and
-- payroll counts its unpaid days. A replacement-leave request is the OPPOSITE — it is a claim for time
-- ALREADY WORKED that should ADD to a balance. Reusing the table would have corrupted all three surfaces
-- at once, and none of the three would have failed loudly; they would simply have been wrong.

-- ── The header: one row per request ───────────────────────────────────────────────────────────────────
CREATE TYPE "replacement_leave_request_unit" AS ENUM ('day', 'hour');
--> statement-breakpoint
CREATE TYPE "replacement_leave_request_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "replacement_leave_request" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  employment_id uuid NOT NULL REFERENCES employment(id),
  -- The leave type the employee picked. Recorded because the form asks for it; the credit itself is always
  -- posted to the tenant's REPLACEMENT type, which is what the balance and the register are keyed on.
  leave_type_id uuid REFERENCES leave_type(id),
  -- 'day' ⇒ each line carries a number of days. 'hour' ⇒ each line carries From/To times and their hours.
  -- One unit per REQUEST rather than per line: a request that mixed the two would have no honest total to
  -- show at the bottom of the table, which is the thing the employee is asked to check before submitting.
  unit "replacement_leave_request_unit" NOT NULL,
  -- The totals as submitted, stored rather than re-summed on read. They are what the employee saw and
  -- agreed to; re-deriving them later from the lines would silently follow any change to the rounding.
  total_days numeric(6, 2) NOT NULL DEFAULT 0,
  total_hours numeric(6, 2) NOT NULL DEFAULT 0,
  reason text,
  -- THE REQUEST DATE. Frozen here and copied onto each credit at approval, so the employee's Replacement
  -- Leave table can show "asked on / approved on" without guessing either.
  submitted_on date NOT NULL,
  status "replacement_leave_request_status" NOT NULL DEFAULT 'pending',
  -- THE APPROVAL INSTANT — and the anchor the expiry period is counted from. Not the submission date and
  -- not the date worked: the request is explicit that the countdown starts when the line manager approves.
  decided_at timestamptz,
  decided_by_user_id uuid REFERENCES app_user(id),
  decision_note text,
  -- The employee's own recorded agreement to bank time instead of taking the statutory overtime cash.
  -- Only meaningful for a First-Schedule (<= wage ceiling) employee; NULL above the ceiling, where no
  -- statutory-floor substitution agreement is needed. The gate itself lives in core/toil.ts and is
  -- re-applied at APPROVAL, so this column records consent rather than being trusted as the check.
  first_schedule_consent boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- ── The lines: one row per worked date claimed ────────────────────────────────────────────────────────
--
-- `subject_employment_id` is DENORMALISED onto the line on purpose. It is what the RLS policy keys on, and
-- keying a child policy on a column it has to reach the parent for means every visibility check becomes a
-- join the planner has to prove safe. leave_request_date (migration 0138) made exactly this choice for
-- exactly this reason, and this policy is copied from it verbatim so the two grains cannot drift.
CREATE TABLE IF NOT EXISTS "replacement_leave_request_date" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  request_id uuid NOT NULL REFERENCES replacement_leave_request(id) ON DELETE CASCADE,
  subject_employment_id uuid NOT NULL REFERENCES employment(id),
  worked_date date NOT NULL,
  -- Populated per the request's unit: `days` for a Day request, `from_time`/`to_time`/`hours` for an Hour
  -- one. Nullable rather than split into two tables — the shapes differ by three columns, not by meaning.
  days numeric(6, 2),
  from_time time,
  to_time time,
  hours numeric(6, 2),
  -- The credit this line minted, once approved. NULL while pending, and NULL forever on a rejected
  -- request — which is what makes "was this line actually banked?" answerable without re-deriving it.
  accrual_id uuid REFERENCES toil_accrual(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The same worked date twice in one request is a data-entry slip, not a claim for twice the credit. (The
-- cross-REQUEST guard is toil_accrual's own unique index, which is the one that also stops an employee
-- claiming a date a manager already banked — see the double-bank note in core/toil.ts.)
CREATE UNIQUE INDEX "rl_request_date_request_date_uq" ON "replacement_leave_request_date" USING btree ("request_id", "worked_date");
--> statement-breakpoint
CREATE INDEX "rl_request_date_request_idx" ON "replacement_leave_request_date" USING btree ("request_id");
--> statement-breakpoint
CREATE INDEX "rl_request_date_subject_idx" ON "replacement_leave_request_date" USING btree ("subject_employment_id", "worked_date");
--> statement-breakpoint
CREATE INDEX "rl_request_employment_idx" ON "replacement_leave_request" USING btree ("employment_id", "status");
--> statement-breakpoint

-- ── GRANTS AND RLS ───────────────────────────────────────────────────────────────────────────────────
--
-- THE GRANTS ARE STATED EXPLICITLY, not inherited. deploy/bootstrap-db.sql sets ALTER DEFAULT PRIVILEGES
-- FOR ROLE ai_hr_owner, so on production a table this role creates comes out already granted — which is
-- why migration 0353 shipped a table with no grant and nobody noticed. It is NOT invisible anywhere the
-- table is created by a different role: on a developer cluster a fresh table can land owned by `postgres`,
-- and the app connection then gets `permission denied`, after tsc, the unit tests and every guard suite
-- have passed. No test catches it because the suite connects as the OWNER. So: written out, like 0345,
-- 0354 and 0357 write theirs. Idempotent — a GRANT on an already-granted table is a no-op.
GRANT SELECT, INSERT, UPDATE, DELETE ON "replacement_leave_request" TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "replacement_leave_request_date" TO ai_hr_app;
--> statement-breakpoint

ALTER TABLE "replacement_leave_request" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Copied from leave_request_rls (migration 0109) verbatim, keyed on employment_id: the employee sees their
-- own, an administrative manager sees their reports', an admin sees the company's, and a routed delegate
-- can read and decide the one delegated to them. Same visibility as the leave request it sits beside, so a
-- manager's to-do list does not need a second, subtly different rule.
CREATE POLICY "replacement_leave_request_rls" ON "replacement_leave_request" FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_decide_via_delegation(employment_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_decide_via_delegation(employment_id))
  );
--> statement-breakpoint

ALTER TABLE "replacement_leave_request_date" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Copied from leave_request_date_rls (migration 0138) verbatim, keyed on subject_employment_id. Identical
-- to the parent's predicate by construction: no stricter (which would hide the worked-date breakdown from
-- the manager deciding it) and no looser (which would leak it).
CREATE POLICY "replacement_leave_request_date_rls" ON "replacement_leave_request_date" FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(subject_employment_id) OR app.can_decide_via_delegation(subject_employment_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(subject_employment_id) OR app.can_decide_via_delegation(subject_employment_id))
  );
--> statement-breakpoint

-- ── toil_accrual learns to record a SELF-DECLARED credit ─────────────────────────────────────────────
--
-- day_type BECOMES NULLABLE. A credit granted from an employee request has no attendance row behind it,
-- so it genuinely has no day type, and the alternative — writing 'workday' — is not a harmless default:
-- the expiry sweep values a First-Schedule employee's convert-to-pay from the day type, so a fabricated
-- one produces a confident, wrong figure on a statutory obligation. core/toil.ts's `convertAmountFor`
-- falls back to the contractual ORP basis when it is NULL and stamps a note on the event saying the day
-- type was self-declared, so the amount is reconciled by a human rather than trusted.
--
-- No existing row is touched: DROP NOT NULL widens the column and every banked credit keeps its value.
ALTER TABLE "toil_accrual" ALTER COLUMN "day_type" DROP NOT NULL;
--> statement-breakpoint

-- WHICH PATH minted a credit. Nullable with NO default and no backfill, deliberately: a credit banked
-- before this column existed genuinely does not know whether a manager elected it off the roster or an
-- attendance-correction approval banked it automatically, and stamping every legacy row with a guess would
-- make the audit trail claim a precision it does not have. NULL reads as "recorded before this was tracked".
CREATE TYPE "toil_accrual_source" AS ENUM ('roster', 'auto_approval', 'employee_request');
--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD COLUMN "source" "toil_accrual_source";
