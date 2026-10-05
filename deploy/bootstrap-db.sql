-- AI HR — one-time database bootstrap (run as a Postgres SUPERUSER).
--
--   sudo -u postgres deploy/bootstrap-db.sh
-- The wrapper reads hidden prompts (or --stdin), then supplies environment variables to psql 16+.
-- Never put passwords in command arguments: sudo logs them and process listings expose them.
--
-- Creates the `ai_hr` database and the THREE roles the app needs:
--   • ai_hr_owner    — owns the schema; runs migrations + seed (MIGRATION_DATABASE_URL).
--   • ai_hr_app      — the application role; NON-superuser, NO BYPASSRLS, so row-level security
--                       (including the FORCE-RLS tables) actually governs it (DATABASE_URL).
--   • ai_hr_platform — ADR-0077 D5 slice 7: the CONTROL PLANE role, BYPASSRLS, on its own pool
--                       (PLATFORM_DATABASE_URL). Stradaverse staff looking across tenants.
--
-- WHY ai_hr_platform IS A SEPARATE ROLE AND NOT A FLAG ON ai_hr_app. ai_hr_app must NEVER gain
-- cross-tenant read. If the platform view ran on the app's connection, a routing bug alone would leak
-- one customer's payroll into another's screen. With a distinct role the leak needs TWO independent
-- mistakes: reaching platform code AND holding the platform pool. That is the whole point of D5, and
-- it is also why ADR-0077 rejected "just add a superuser flag when needed".
--
-- WHY the default-privileges block matters: the repo migrations GRANT to ai_hr_app only the tables
-- that existed at Slice 0 (migration 0001). Every table created by later migrations relies on
-- ALTER DEFAULT PRIVILEGES (below) to auto-grant CRUD to ai_hr_app as ai_hr_owner creates it.
-- DO NOT add a blanket "GRANT ... ON ALL TABLES" AFTER migrating — that would re-expose the columns
-- the migrations deliberately REVOKE (the encrypted ai_provider_config.api_key_ciphertext, and the
-- append-only domain_event). The default-privileges approach + the migrations' own REVOKEs are correct.
\set ON_ERROR_STOP on
\set ECHO none
\set ECHO_HIDDEN off
\set VERBOSITY terse
\set SHOW_CONTEXT never

-- Reset first: \getenv leaves its target unchanged when the environment variable is absent.
-- This also prevents a stale/predefined psql variable from rescuing missing credential input.
\set owner_pw ''
\set app_pw ''
\set platform_pw ''
\getenv owner_pw AIHR_BOOTSTRAP_OWNER_PW
\getenv app_pw AIHR_BOOTSTRAP_APP_PW
\getenv platform_pw AIHR_BOOTSTRAP_PLATFORM_PW

SET password_encryption = 'scram-sha-256';

-- Stash the passwords in session GUCs first: psql ':var' substitution does NOT happen
-- inside a dollar-quoted DO body, so the DO block reads them via current_setting() instead.
-- (These are session-local on the postgres superuser connection and vanish when it closes.)
\o /dev/null
SELECT set_config('aihr_bootstrap.owner_pw', :'owner_pw', false);
SELECT set_config('aihr_bootstrap.app_pw',   :'app_pw',   false);
SELECT set_config('aihr_bootstrap.platform_pw', :'platform_pw', false);
\o

DO $$
BEGIN
  IF coalesce(current_setting('aihr_bootstrap.owner_pw', true), '') = ''
     OR coalesce(current_setting('aihr_bootstrap.app_pw', true), '') = ''
     OR coalesce(current_setting('aihr_bootstrap.platform_pw', true), '') = '' THEN
    RAISE EXCEPTION 'All three bootstrap passwords are required and must be non-empty; no roles were created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_owner') THEN
    EXECUTE format('CREATE ROLE ai_hr_owner LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', current_setting('aihr_bootstrap.owner_pw'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_app') THEN
    EXECUTE format('CREATE ROLE ai_hr_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', current_setting('aihr_bootstrap.app_pw'));
  END IF;
  -- BYPASSRLS is the entire privilege. NOSUPERUSER still, so it cannot alter the schema, disable a
  -- policy, or read the columns the migrations REVOKE — it sees rows across tenants, nothing more.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_platform') THEN
    EXECUTE format('CREATE ROLE ai_hr_platform LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS', current_setting('aihr_bootstrap.platform_pw'));
  END IF;
END $$;

-- CREATE DATABASE can't run inside a transaction/DO block — emit it conditionally with \gexec.
SELECT 'CREATE DATABASE ai_hr OWNER ai_hr_owner'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'ai_hr')\gexec

\connect ai_hr

-- The app role may connect + use the public schema; everything else comes from grants below + migrations.
GRANT CONNECT ON DATABASE ai_hr TO ai_hr_app;
GRANT USAGE ON SCHEMA public TO ai_hr_app;

-- The platform role connects and reads. It is granted per-table by migration 0351, NOT by a blanket
-- default-privileges rule like ai_hr_app's: the control plane should see the tenancy and billing
-- tables, not every table a future migration happens to create. An explicit grant list is the
-- difference between "cross-tenant view of the commercial surface" and "cross-tenant view of
-- everything", and only one of those is what D5 authorises.
GRANT CONNECT ON DATABASE ai_hr TO ai_hr_platform;
GRANT USAGE ON SCHEMA public TO ai_hr_platform;

-- Auto-grant CRUD on every table/sequence that ai_hr_owner creates from here on (i.e. all migrations).
ALTER DEFAULT PRIVILEGES FOR ROLE ai_hr_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_hr_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ai_hr_app;

\echo '✅ ai_hr database + 3 roles ready. Now run migrations as ai_hr_owner (see deploy/DEPLOY.md).'
