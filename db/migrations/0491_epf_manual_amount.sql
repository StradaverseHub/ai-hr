-- Item 70b14723 — MANUAL EPF CONTRIBUTION CATEGORIES: one new enum label and three nullable columns.
--
-- WHAT THIS IS FOR. Until now the only way to make payroll use an exact ringgit EPF figure was Payroll ›
-- Statutory Adjustment, which is per-RUN: you process the month, adjust the employee, and re-key it next
-- month. These three columns make it a STANDING election on the employee's own record, read live by every
-- Process and Reprocess. The per-run path is untouched and still wins where both are present.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠️ WHY THIS IS A TYPE SWAP AND NOT `ALTER TYPE … ADD VALUE`. READ 0448's HEADER BEFORE "SIMPLIFYING".
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- 0448 measured the reason and it has not changed: drizzle-orm 0.45's `PgDialect.migrate` opens ONE
-- `session.transaction(...)` and replays EVERY PENDING FILE inside it
-- (node_modules/drizzle-orm/pg-core/dialect.js, the `for await (const migration of migrations)` loop).
-- Postgres `55P04` forbids USING a value ADDED to a pre-existing type in the same transaction, and it has
-- no such rule for a type CREATED in that transaction. Splitting the addition into its own file buys
-- nothing when both files ship in one deploy — which is the normal case here. So the old type is renamed
-- out of the way, a new `epf_mode` is created with the full four-label vocabulary, the column is moved
-- onto it through text, and the old type is dropped.
--
-- SAFE TO DROP THE OLD TYPE: `epf_mode` is used by exactly ONE column in the whole schema,
-- `employee_statutory_my.epf_mode` (db/schema.ts). A `DROP TYPE` would fail loudly rather than silently
-- if that ever stopped being true.
--
-- THE DEFAULT IS DROPPED AND RESTORED around the type change: a column default is stored as an expression
-- typed against the OLD type and `ALTER COLUMN … TYPE` refuses to rewrite it. 'auto' is the same default
-- 0100-era DDL set and the same one db/schema.ts declares.
--
-- ⚠️ THE NUMBER. Allocated from max(idx) = 490 in db/migrations/meta/_journal.json, NOT from
-- entries.length, which is 403 and has diverged by 87. drizzle's watermark is the last applied `when`, so
-- a file numbered below it never runs and reports NOTHING AT ALL — the columns would simply not exist and
-- the first payroll run would read them as absent.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- THE THREE COLUMNS, AND WHY THERE IS NO CATEGORY COLUMN
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- The ticket asks for THREE categories — Manual (Employee by Amount), Manual (Employer by Amount),
-- Manual (Employee and Employer by Amount). They are exactly the three combinations of (employee amount
-- set, employer amount set) and are DERIVED at render time, which is the rule ADR-0046 already set for
-- Semi-Auto (a `voluntary_excess` row with a null employer rate IS Semi-Auto; nothing stores the word).
-- One enum label, not three, so the lawful vocabulary stays small and no row can carry a category that
-- disagrees with its own amounts.
--
-- All three columns are NULLABLE with NO DEFAULT, so every existing row is byte-identical after this runs
-- and every existing payroll figure is unchanged.
--
-- NO CREATE TABLE, THEREFORE NO GRANT (the rule 0345/0354 exist for). NO RLS CHANGE:
-- employee_statutory_my's policy is `app.can_see_person(person_id)` and is column-blind — it does not
-- mention epf_mode or any other column, so three more columns are covered by it unchanged.

ALTER TYPE "epf_mode" RENAME TO "epf_mode_pre_0491";
--> statement-breakpoint

CREATE TYPE "epf_mode" AS ENUM('auto', 'voluntary_excess', 'exempt', 'manual_amount');
--> statement-breakpoint

ALTER TABLE "employee_statutory_my" ALTER COLUMN "epf_mode" DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE "employee_statutory_my"
  ALTER COLUMN "epf_mode" TYPE "epf_mode" USING "epf_mode"::text::"epf_mode";
--> statement-breakpoint

ALTER TABLE "employee_statutory_my" ALTER COLUMN "epf_mode" SET DEFAULT 'auto';
--> statement-breakpoint

DROP TYPE "epf_mode_pre_0491";
--> statement-breakpoint

-- The typed employee share for the month, in RM. NULL ⇒ the employee side is computed by the rule the
-- mode names (which for every row that exists today is the KWSP Third Schedule).
ALTER TABLE "employee_statutory_my" ADD COLUMN "epf_employee_amount" numeric(12, 2);
--> statement-breakpoint

-- The typed employer share for the month, in RM. NULL ⇒ the employer side stays statutory — the same
-- "a blank side stays statutory" rule the elected RATES already follow.
ALTER TABLE "employee_statutory_my" ADD COLUMN "epf_employer_amount" numeric(12, 2);
--> statement-breakpoint

-- The operator's mandatory words for WHY this employee's EPF is a fixed figure. Required by
-- `resolveEpfElection` for a manual_amount row, exactly as `saveStatutoryAdjustment` requires one for the
-- per-run override. Kept nullable in the DDL because the column is meaningless for the other three modes
-- and because the rule for how a row is decided belongs in the service that decides it (CLAUDE.md §6).
ALTER TABLE "employee_statutory_my" ADD COLUMN "epf_manual_reason" text;
