-- e6be5a3b (r330) — THE SYSTEM TESTING MODULE: a reusable test CASE, and a record of each RUN.
--
-- ── WHY THIS IS NOT A SECOND DEFECT TRACKER ─────────────────────────────────────────────────────────
--
-- The reporter's requested field list — Title, Description, Expected Behaviour, Expected Function,
-- Status, Remarks, Created By, Created Date — IS `feedback_request`. Those are the boxes they fill in on
-- every ticket they raise (db/schema.ts feedbackRequest: title, description, expected_behavior,
-- expected_function, category, status, reporter_employment_id, reporter_label, plan, contest_reason,
-- plus attachments). They described the form they were typing into. So the defect half is BUILT and in
-- daily use, and this migration deliberately does not touch it, does not copy it and does not compete
-- with it (CLAUDE.md §1: one authoritative owner per business fact).
--
-- What the board has no concept of is the pair below: a SCRIPT you can run again, and an EXECUTION with
-- an outcome.
--
-- ── STATUS BELONGS TO THE RUN, NOT THE CASE — THE ONE MODELLING DECISION THAT MATTERS ───────────────
--
-- The request lists Status and Actual Result as TEST-CASE fields. Modelled that way a case remembers
-- only its latest outcome, every earlier execution is overwritten, and "it passed in September and
-- failed in October" — the exact question a release checklist exists to answer — is unanswerable
-- forever, with no error and nothing to notice. So `test_case` carries NO status and NO actual_result:
-- both live on `test_run`, one row per execution, and the case's displayed status is DERIVED from its
-- newest run (`run_no DESC`; see below for why not a timestamp).
--
-- ── `run_no` EXISTS BECAUSE `run_at` CANNOT DECIDE "NEWEST" ─────────────────────────────────────────
--
-- CLAUDE.md §8 forbids "the last row" and requires an ORDER BY on any asserted array. `run_at DESC`
-- looks like that ordering and is not one: `now()` is the TRANSACTION timestamp in Postgres, so two runs
-- recorded in one transaction — which is every fixture that seeds a history — carry an IDENTICAL
-- run_at, and "newest" becomes whatever the planner returns. `run_no` is a per-case monotonic integer
-- with a UNIQUE index, so the ordering is a true invariant and the UI can also say "Run #3". It is
-- allocated under `pg_advisory_xact_lock` in core/system-testing.ts (the core/claims.ts idiom) and the
-- unique index turns any race that escapes the lock into a loud error rather than two "run 4"s.
--
-- ── `module_code` IS TEXT AND HAS NO FOREIGN KEY, DELIBERATELY ──────────────────────────────────────
--
-- The legal values are the module catalogue rows THIS TENANT is entitled to, plus the literal
-- 'cross_module'. Neither half can be a FK to `module`:
--   · entitlement is per-tenant and lives in `tenant_module` — a FK to `module` would happily accept a
--     module the customer never bought, which is precisely the noise the controlled list exists to stop;
--   · 'cross_module' is not a thing anyone sells, so giving it a catalogue row would put a fake product
--     into the commercial catalogue that `test/module-catalog-drift.test.ts` pins in both directions.
-- The rule is therefore enforced in the service that decides a save (CLAUDE.md §6), and an EXISTING row
-- is never invalidated by a later entitlement change — a test case written while the tenant had Payroll
-- stays readable after they drop it, which is the honest outcome for a historical record.
--
-- ── RLS: ADMIN-ONLY ON BOTH ENDS, AND THE SERVICE STILL REFUSES FIRST ───────────────────────────────
--
-- `app.is_admin()` on read AND write. This is a tool for whoever runs the product, not an employee
-- surface: a test case is a written description of how the system is supposed to behave, and the run
-- history is a quality record about the vendor. `ai_hr_app` is NOSUPERUSER / NOBYPASSRLS so a missing
-- policy fails CLOSED (ADR-0002).
--
-- Note what that means for the MODULE gate, because the two are easy to confuse (CLAUDE.md §8): RLS
-- here answers "are you an admin of this tenant", never "did this tenant buy the module". The module
-- refusal is `assertModuleEnabled` in core/system-testing.ts, and its test uses an ADMIN session — one
-- that sails through every policy below — precisely so a green refusal cannot be RLS wearing the gate's
-- coat.
--
-- ── GRANT ───────────────────────────────────────────────────────────────────────────────────────────
--
-- Not redundant. Production's ALTER DEFAULT PRIVILEGES (deploy/bootstrap-db.sql) hands ai_hr_app CRUD on
-- every owner-created table, and the suite connects as the owner — so an omission is invisible on both
-- and surfaces only as "permission denied" on a RESTORED developer cluster, after the deploy. Same
-- reasoning as 0345 / 0354 / 0452 / 0480.
--
-- DELETE is granted on both tables for tenant erasure, NOT because the app offers a delete button: this
-- round ships no way to destroy a case or a run from the UI, because the run history is the deliverable.
--
-- ── ON DELETE CASCADE from test_run → test_case ─────────────────────────────────────────────────────
--
-- A run without its script is unreadable — "Failed: the total was 1,203.40" means nothing once the steps
-- that produced it are gone. So the runs go when the case goes, and the case can only go via erasure.
-- `feedback_request_id` is ON DELETE SET NULL instead: a board item is a first-class record with its own
-- lifecycle, and losing the whole run because someone cancelled the ticket it raised would be backwards.
--
-- Rollback:
--   DROP TABLE test_run; DROP TABLE test_case; DROP TYPE test_run_outcome;
--
-- Journal entry: idx 482.

DO $$ BEGIN
  CREATE TYPE "test_run_outcome" AS ENUM ('pass', 'fail', 'blocked', 'partial', 'not_tested');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "test_case" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),

  -- The reporter asked for "a number". Per-tenant, monotonic, allocated from `tenant_counter`
  -- (kind = 'test_case_no') — the same atomic upsert that issues EMP- codes, so two admins creating a
  -- case at once cannot be handed the same number.
  "case_no" integer NOT NULL,

  -- A catalogue code the tenant is entitled to, or the literal 'cross_module'. See the header.
  "module_code" text NOT NULL,
  "title" text NOT NULL,
  -- What must be true before the steps make sense. NULL = none stated, which is not the same as ''.
  "precondition" text,
  -- The steps IN ORDER, as a JSON array of strings. An array because the order IS the data; a child
  -- table would buy nothing but a join and a second place for the order to disagree with itself.
  "steps" jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Catalogue-as-text, constrained app-side (core/system-testing.ts TEST_TYPES / PRIORITIES), not hard
  -- enums — the precedent is employee_loan.loan_type. Neither list was specified by the reporter, so
  -- adding a value must be a code change, not a migration against a table with rows in it.
  "test_type" text NOT NULL DEFAULT 'functional',
  "priority" text NOT NULL DEFAULT 'medium',

  -- The reporter's own two boxes, spelled exactly as feedback_request spells them, because a failed run
  -- copies them into a board item verbatim.
  "expected_behavior" text,
  "expected_function" text,

  "created_by_user_id" uuid REFERENCES "app_user"("id"),
  "updated_by_user_id" uuid REFERENCES "app_user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  -- The steps column is an ARRAY of strings or it is not steps. Enforced here because it is a property
  -- of JSON, not of a testing policy that could change next year.
  CONSTRAINT "test_case_steps_is_array_ck" CHECK (jsonb_typeof("steps") = 'array')
);
--> statement-breakpoint

-- THE GRAIN of the visible number, enforced by the database rather than by the service remembering.
CREATE UNIQUE INDEX IF NOT EXISTS "test_case_no_uq"
  ON "test_case" USING btree ("tenant_id", "case_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_case_module_idx"
  ON "test_case" USING btree ("tenant_id", "module_code", "case_no");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "test_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "test_case_id" uuid NOT NULL REFERENCES "test_case"("id") ON DELETE CASCADE,

  -- 1, 2, 3 … within the case. The ordering key — see the header for why run_at cannot be one.
  "run_no" integer NOT NULL,

  "outcome" "test_run_outcome" NOT NULL,
  -- What the tester actually saw. NULL where they recorded only an outcome — never a placeholder.
  "actual_result" text,
  "run_by_user_id" uuid REFERENCES "app_user"("id"),
  "run_at" timestamptz NOT NULL DEFAULT now(),

  -- THE DEFECT LINK, AND IT IS A REAL FOREIGN KEY. A hand-keyed "Defect ID" is a second source of truth
  -- that can point at nothing (CLAUDE.md §1) and makes the tester re-type the steps they just carried
  -- out. This column is only ever written by raising the item through core/feedback.ts submitFeedback —
  -- the same writer the in-app form uses — and storing the id it returns.
  "feedback_request_id" uuid REFERENCES "feedback_request"("id") ON DELETE SET NULL,

  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "test_run_case_no_uq"
  ON "test_run" USING btree ("test_case_id", "run_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_run_case_idx"
  ON "test_run" USING btree ("tenant_id", "test_case_id", "run_no" DESC);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "test_case" TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "test_run" TO ai_hr_app;
--> statement-breakpoint

ALTER TABLE "test_case" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "test_case_rls" ON "test_case";
--> statement-breakpoint
CREATE POLICY "test_case_rls" ON "test_case" FOR ALL
  USING ("tenant_id" = app.current_tenant_id() AND app.is_admin())
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

ALTER TABLE "test_run" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "test_run_rls" ON "test_run";
--> statement-breakpoint
CREATE POLICY "test_run_rls" ON "test_run" FOR ALL
  USING ("tenant_id" = app.current_tenant_id() AND app.is_admin())
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND app.is_admin());
