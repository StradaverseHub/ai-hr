-- 0351 — ADR-0077 D5 / slice 7: the PLATFORM PLANE's privilege boundary.
--
-- WHAT WAS ALREADY THERE, and is deliberately not repeated here: 0313 created `platform_user`, enabled
-- RLS on it with no policy, and revoked it from `ai_hr_app`. So the TABLE side of D5 has been right
-- since slice 1.
--
-- WHAT WAS MISSING is the role the whole design rests on. `ai_hr_platform` appeared in ZERO files: the
-- control plane had a table nobody could read and no identity to read it with. This migration grants
-- the privileges; `deploy/bootstrap-db.sql` creates the role (BYPASSRLS, NOSUPERUSER); `db/platform.ts`
-- is the only pool that connects as it.
--
-- WHY A SEPARATE ROLE AT ALL. `ai_hr_app` must never gain cross-tenant read. If the control plane ran
-- on the application's connection, one routing bug would leak a customer's payroll onto another
-- customer's screen. With a distinct role a leak needs TWO independent mistakes — reaching platform
-- code AND holding the platform pool. ADR-0077 considered a separate APPLICATION for this and rejected
-- it as too costly for a handful of tenants, which makes the role the isolation story rather than a
-- convenience.
--
-- IDEMPOTENT ROLE GUARD. The role comes from a bootstrap script that runs once per machine and has not
-- been re-run on existing installs. Every grant is wrapped so a database WITHOUT the role migrates
-- cleanly and simply has no platform plane yet. The alternative is a migration that fails on every
-- existing environment, which is how a release stops being deployable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_platform') THEN
    RAISE NOTICE 'ai_hr_platform role absent — platform grants skipped. Re-run deploy/bootstrap-db.sql to create it.';
    RETURN;
  END IF;

  EXECUTE 'GRANT CONNECT ON DATABASE ' || quote_ident(current_database()) || ' TO ai_hr_platform';
  EXECUTE 'GRANT USAGE ON SCHEMA public TO ai_hr_platform';

  -- THE GRANT LIST IS THE POLICY. Enumerated, never "ALL TABLES": the control plane needs the tenancy
  -- and commercial surface, NOT every table a future migration happens to add. Widening this should be
  -- a decision someone writes down, not a privilege inherited by default.
  EXECUTE 'GRANT SELECT ON tenant, module, domain_event TO ai_hr_platform';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON tenant_module, subscription, usage_snapshot TO ai_hr_platform';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON platform_user TO ai_hr_platform';

  -- `tenant` is READ-ONLY from this pool, on purpose. Suspension is dunning's alone (r105) and closure
  -- is dual-controlled with a retention check (0350) — neither may become a click in a support console.
END $$;

-- FORCE RLS on platform_user. 0313 ENABLEd it; without FORCE, the table OWNER (ai_hr_owner, which runs
-- migrations and seeds) still bypasses every policy. That is fine for the owner itself, but "RLS is on"
-- reads as a stronger guarantee than ENABLE alone provides, and the gap is the kind that is discovered
-- during an audit rather than in a test.
ALTER TABLE platform_user FORCE ROW LEVEL SECURITY;
