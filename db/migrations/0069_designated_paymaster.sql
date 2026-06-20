-- ADR-0029 (G2) scope-out: designated paymaster employment for cross-employer PCB.
-- Additive + back-compat: nullable; existing rows are unaffected (default per-employer MTD continues).
-- App-validated soft reference (must be one of the person's own employments — enforced in the service),
-- NOT a DB FK: a person→employment FK would close a person↔employment cycle that deadlocks the parallel
-- TRUNCATE CASCADE the test harness uses. Drop the constraint if an earlier run of this migration added it.
ALTER TABLE "person" ADD COLUMN IF NOT EXISTS "designated_paymaster_employment_id" uuid;
