-- Scheduled-actions run log (job_run). The operator-tier record of the four out-of-band sweeps
-- (leave.accrue / review.sweep / leave.expire-carry / leave.expire-aged): when each ran, how long it
-- took, whether it worked, and what it changed. Modelled on statutory_pack_sync_log (0046) — the
-- established "written only by a script under the owner role, read-only in the app" pattern.
--
-- NATIONAL / GLOBAL, no tenant_id: one sweep run fans out across every tenant, so a run belongs to the
-- installation, not to a customer. Everything stored here is a job name, a timestamp, an outcome and
-- CROSS-TENANT AGGREGATE counters — deliberately no per-tenant breakdown, because (see the read gate
-- below) any tenant's group admin can read the whole table.
--
-- THERE IS NO WRITE PATH FROM THE WEB TIER, and that is the central security decision, not an omission:
--   app.is_group_admin() (0016 lines 38-44) is EXISTS(SELECT 1 FROM app.current_grants() g WHERE
--   g.role='super_admin' OR (g.role='hr_admin' AND g.company_id IS NULL)). current_grants() reads
--   app.grants from the CURRENT SESSION and has NO tenant dimension. Every tenant has a group-wide
--   hr_admin — that is the ordinary top HR admin role. So any write path gated on that predicate would
--   let ONE customer's HR admin forge or delete the job history of EVERY other customer. There is no
--   operator-vs-customer predicate in this codebase today; rather than invent one, we remove the write
--   path entirely. Writes come only from the four scripts running under MIGRATION_DATABASE_URL (the
--   table owner), exactly as scripts/statutory-sync.ts already inserts into statutory_pack_sync_log.
--   No SECURITY DEFINER function, no server action, no INSERT/UPDATE/DELETE grant.
--
-- `outcome` is a plain text column, NOT a pgEnum — the 0275 lesson: widening a pgEnum later needs a
-- migration and a lock, and the value set here ('success' | 'partial' | 'failed') is controlled in code.
-- `result` is jsonb and must NOT be coerced to integers: expire-carry / expire-aged aggregate forfeited
-- days as a rounded FLOAT (e.g. 12.5 days).
CREATE TABLE job_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,
  outcome text NOT NULL,
  tenants_processed integer NOT NULL DEFAULT 0,
  tenants_failed integer NOT NULL DEFAULT 0,
  result jsonb,
  error text
);
--> statement-breakpoint

-- The screen's only query shape: latest runs for one job key, newest first.
CREATE INDEX job_run_key_ran_at_idx ON job_run (job_key, ran_at DESC);
--> statement-breakpoint

-- RLS + grants, copying 0046 IN FULL including the explicit REVOKE.
--
-- The REVOKE is mandatory, not belt-and-braces: deploy/bootstrap-db.sql line 51 runs ALTER DEFAULT
-- PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app, so every new public table
-- is auto-granted full CRUD to the app role. "Grant only SELECT by omission" does NOT make a table
-- read-only here. And cleanroom-verify.sh lines 26-27 reproduce the same ALTER DEFAULT PRIVILEGES, so
-- the cleanroom MASKS a missing GRANT and can never catch a missing REVOKE — test/job-run-rls.test.ts
-- is the only thing that catches a dropped REVOKE.
--
-- ENABLE, deliberately NOT FORCE. ENABLE subjects the non-owner app role (ai_hr_app) to RLS while the
-- table OWNER bypasses it — which is precisely what lets the owner-role sweep scripts INSERT while
-- ai_hr_app cannot. FORCE would also block the owner and break the only write path there is.
ALTER TABLE job_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

GRANT SELECT ON job_run TO ai_hr_app;
--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON job_run FROM ai_hr_app;
--> statement-breakpoint

-- Read gate. State plainly what this does and does not do: app.is_group_admin() is per-session and has
-- no tenant dimension, so ANY tenant's group-wide hr_admin can read every row. That is accepted HERE and
-- ONLY here, because job_run holds no customer data — a job name, a timestamp, an outcome and
-- cross-tenant aggregate counts. It would NOT have been acceptable for a write path, which is the main
-- reason there is none.
CREATE POLICY job_run_read ON job_run FOR SELECT USING (app.is_group_admin());
