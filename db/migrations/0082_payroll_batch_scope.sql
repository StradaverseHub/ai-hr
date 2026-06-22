-- ADR-0035 1E (#23): optional batch subset selection. Additive + backfill-safe — existing batches keep
-- scope NULL = whole company (today's behaviour). Shape: { departmentIds?: string[], employmentIds?: string[] }.
ALTER TABLE payroll_batch ADD COLUMN scope jsonb;
