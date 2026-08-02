-- ADR-0077 slice 10 — make usage_snapshot idempotent per (tenant, company, day).
--
-- The table has existed since slice 1 and NOTHING HAS EVER WRITTEN TO IT. r113 is the capture sweep, and
-- a daily sweep that can run twice is a daily sweep that WILL run twice: a retry after a network blip, a
-- manual catch-up for a missed day, an operator re-running it to see the output. Without a unique key
-- every one of those doubles the day's usage, and usage is the input to a bill.
--
-- WHY AN INDEX AND NOT `ON CONFLICT DO NOTHING` ALONE — the r102 lesson, stated there as: "tenant_module
-- has NO unique constraint (only a PK on id), so `ON CONFLICT DO NOTHING` would be a no-op". A conflict
-- target has to exist for the upsert to mean anything. This is that target.
--
-- UPSERT, NOT DO-NOTHING, and the difference matters for a re-run. A same-day re-run should REPLACE the
-- day's counts, not silently keep the first attempt: if a sweep ran at 02:00 and an operator re-runs it at
-- 18:00 after fixing a data problem, the later, more accurate figure is the one that should stand. Slice
-- 10's verification is "a synthetic bill for a past month re-derives from snapshot rows alone", which
-- requires the row to be the best answer for that day, not the earliest one.
--
-- NULLS are not a concern in the key: all three columns are NOT NULL (tenant_id and company_id by their
-- FKs, captured_on by its own constraint), so this behaves as a plain unique key with no NULL-distinct
-- surprises.
--
-- Created on an EMPTY table, so there is nothing to deduplicate first and no risk of the index failing
-- on existing duplicates. If that ever stops being true this migration needs a dedupe ahead of it.

CREATE UNIQUE INDEX IF NOT EXISTS "usage_snapshot_tenant_company_day_uq"
  ON "usage_snapshot" ("tenant_id", "company_id", "captured_on");
