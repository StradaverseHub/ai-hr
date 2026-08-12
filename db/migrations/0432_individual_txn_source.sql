-- 4e403268 — Individual Transaction: day-by-day input.
--
-- WHAT IS *NOT* HERE, AND THAT IS THE POINT. The request reads as though the ledger cannot hold a dated
-- daily line. It already can: `payroll_individual_txn` has carried `txn_date NOT NULL`, `quantity`, `unit`
-- and `component_id` since f1564110 Phase 3, and the table has never had a unique constraint on
-- (batch, employment) precisely so that multiple dated entries per employee per month are legal. Measured
-- read-only on production 2026-08-12: 47 rows, 45 of them dated the 1st of their month, exactly one
-- carrying hours — the date column exists and is simply unused. So NOTHING about the row shape changes and
-- there is no backfill. What this migration adds is the ONE thing the day-by-day framework genuinely needs
-- and the ledger does not have: where a line came from.
--
-- 1. `source`  — 'manual' | 'attendance' | 'leave' | 'import' | 'system'.
--    TEXT, app-validated (TXN_SOURCES in core/payroll-individual-txn.ts), NOT a new pg enum — the same
--    choice TXN_UNITS and ROUNDING_METHODS already made in this codebase. A pg enum costs a migration to
--    extend and this vocabulary will grow as modules learn to write here; a text column with a literal set
--    in one TypeScript constant does not. Deliberately NO CHECK constraint for the same reason: the app is
--    the single validator, and a CHECK would put a second copy of the vocabulary somewhere a code change
--    cannot reach.
--    NULLABLE, and null READS AS 'manual' (`txnSourceOf`). That is why every one of the 47 existing rows
--    is correct the moment this lands, with no UPDATE and no default: they were all keyed by hand.
--
-- 2. `source_ref` — the id of the record in the ORIGINATING module (an attendance day, a leave request
--    line). Null for anything keyed by hand.
--
-- 3. THE UNIQUENESS GUARD, ADDED NOW EVEN THOUGH NOTHING WRITES IT YET. This is the request's point 14
--    ("repeated synchronization should update the existing transaction rather than duplicate it") and it
--    is put in before the first sync exists on purpose: retrofitting it AFTER a sync has already
--    double-posted a month of overtime is a data repair, not a constraint. It costs nothing today —
--    `source_ref` is null on every row, so the partial index is empty.
--    Keyed on (tenant, employment, date, component, source, source_ref) rather than on source_ref alone,
--    because two different modules may legitimately hand out the same id space.
--    NOTE ON NULLS: `component_id` is nullable and NULLs compare distinct in a unique index. That is
--    acceptable here because the predicate already restricts the index to synced rows, and a synced row
--    always names the pay item it is being paid under (a componentless payable row is refused by
--    assertTxnComponents while INDIVIDUAL_TXN_PAY_ENABLED is on).
--
-- NO GRANT STATEMENT, and that is correct rather than an omission: ALTER TABLE ADD COLUMN inherits the
-- table's existing privileges. A GRANT is required for CREATE TABLE (0345 / 0354 / 0357 / 0425 / 0427),
-- which this is not.

ALTER TABLE "payroll_individual_txn" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint

ALTER TABLE "payroll_individual_txn" ADD COLUMN IF NOT EXISTS "source_ref" text;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_individual_txn_source_ref_uq"
  ON "payroll_individual_txn" ("tenant_id", "employment_id", "txn_date", "component_id", "source", "source_ref")
  WHERE "source_ref" IS NOT NULL;
