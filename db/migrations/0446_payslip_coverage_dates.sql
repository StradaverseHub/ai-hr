-- 1b0943d5 / 3c88d593 — Employee Entity Transfer, stage two: A PAYSLIP LEARNS TO STATE ITS OWN COVERAGE.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- THE HOLE THIS FILLS, AND WHY IT IS THE REPORTER'S OWN REQUIREMENT
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Employee 100814 transferred Fiamma → ISEDECOR BINA effective 11 August 2026. Their August is TWO
-- documents: "01 Aug – 10 Aug 2026, Fiamma" and "11 Aug – 31 Aug 2026, ISEDECOR BINA". The payslip table
-- as it stood could express neither. Its columns were id, tenant_id, batch_id, employment_id,
-- basic_salary, allowance, overtime_pay, gross_pay, statutory, other_deductions, total_deductions,
-- net_pay, employer_cost, created_at, bonus, days_worked, version — `days_worked` (21.00 against 31.00)
-- was the ONLY trace of a split month, and a count of days cannot say WHICH days. The reporter's own
-- layout asks for the line `Payroll Period: 01 Aug – 10 Aug 2026`, so this is their requirement rather
-- than an implementation detail.
--
-- Stage one (r194) put the range on `payslip.statutory->'segment'` as part of the immutable snapshot, and
-- that stamp STAYS — it is the audited record, written at the moment the slip was computed, and
-- core/payslip-segment.ts remains the one reader of it. What a jsonb key cannot be is a QUERYABLE fact.
-- The completeness control this round exists for has to ask, across EVERY company's batch for a period,
-- "do this employment's payslips tile the month with no gap and no overlap?" — a question that has to be
-- answered from columns, over batches belonging to different employers, before a run is allowed to close.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- NULLABLE, AND THE NULL MEANS EXACTLY WHAT THE ABSENT STAMP MEANT
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Every payslip that exists today lands with both columns NULL, and readers (core/payslip-segment.ts →
-- `payslipCoverage`) resolve NULL as "the whole pay period" — which is precisely what every payslip ever
-- issued by this system means, and precisely what the absent `segment` stamp already meant. So:
--   • no data step, and the migration cannot fail on a row;
--   • no issued payslip changes, on screen or in its PDF;
--   • the tiling check treats an unstamped legacy slip as covering its whole month, which is true.
-- From this migration onward `generatePayslips` stamps the columns on every slip it writes — the entity
-- segment for a split month, the whole period for everybody else — so the check reads columns, not jsonb.
--
-- NO NOT NULL. Backfilling every historical payslip with a derived period would be inventing a fact about
-- a closed document: a slip's coverage is what its RUN believed at the time, and today's assignment
-- history can be corrected afterwards. An absent value that reads as "the whole period" is honest; a
-- computed one would be a guess written into an audit record.
--
-- THE CHECK CONSTRAINT IS THE INVARIANT THE TILING RELIES ON: either both ends are set or neither, and a
-- range never runs backwards. A half-set pair would make "does this tile the month" unanswerable, and a
-- reversed pair would make a gap look like an overlap. Added guarded, because Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS and this file must stay re-runnable.
--
-- NO GRANT IS OWED. `ALTER TABLE … ADD COLUMN` inherits the table's existing privileges; only CREATE
-- TABLE owes a GRANT. `payslip_rls` (migration 0001) is FOR ALL over the whole table and already covers
-- every column on it, so there is no policy change here either.

ALTER TABLE "payslip"
  ADD COLUMN IF NOT EXISTS "coverage_from" date;
--> statement-breakpoint

ALTER TABLE "payslip"
  ADD COLUMN IF NOT EXISTS "coverage_to" date;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payslip_coverage_ordered') THEN
    ALTER TABLE "payslip"
      ADD CONSTRAINT "payslip_coverage_ordered"
      CHECK (
        ("coverage_from" IS NULL AND "coverage_to" IS NULL)
        OR ("coverage_from" IS NOT NULL AND "coverage_to" IS NOT NULL AND "coverage_from" <= "coverage_to")
      );
  END IF;
END $$;
--> statement-breakpoint

-- The completeness control's access path, and the reason it is a NEW index rather than a reuse of
-- `payslip_batch_employment_uq`. That unique index is keyed (batch_id, employment_id): it serves "this
-- run's slip for this person", which is every read payroll had before this round. The tiling check asks
-- the orthogonal question — "every slip this person holds for this MONTH, across every employer's batch"
-- — which starts from the employment and cannot use a batch-leading key at all.
CREATE INDEX IF NOT EXISTS "payslip_employment_idx" ON "payslip" ("employment_id");
