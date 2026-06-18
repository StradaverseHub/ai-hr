-- AI HR — one-time database bootstrap (run as a Postgres SUPERUSER).
--
--   sudo -u postgres psql \
--     -v owner_pw=CHANGE_ME_OWNER_PW \
--     -v app_pw=CHANGE_ME_APP_PW \
--     -f deploy/bootstrap-db.sql
--   (pass the passwords WITHOUT surrounding quotes — psql's :'var' form quotes them for you.)
--
-- Creates the `ai_hr` database and the TWO roles the app needs:
--   • ai_hr_owner — owns the schema; runs migrations + seed (MIGRATION_DATABASE_URL).
--   • ai_hr_app   — the application role; NON-superuser, NO BYPASSRLS, so row-level security
--                    (including the FORCE-RLS tables) actually governs it (DATABASE_URL).
--
-- WHY the default-privileges block matters: the repo migrations GRANT to ai_hr_app only the tables
-- that existed at Slice 0 (migration 0001). Every table created by later migrations relies on
-- ALTER DEFAULT PRIVILEGES (below) to auto-grant CRUD to ai_hr_app as ai_hr_owner creates it.
-- DO NOT add a blanket "GRANT ... ON ALL TABLES" AFTER migrating — that would re-expose the columns
-- the migrations deliberately REVOKE (the encrypted ai_provider_config.api_key_ciphertext, and the
-- append-only domain_event). The default-privileges approach + the migrations' own REVOKEs are correct.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_owner') THEN
    EXECUTE format('CREATE ROLE ai_hr_owner LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', :'owner_pw');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_app') THEN
    EXECUTE format('CREATE ROLE ai_hr_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'app_pw');
  END IF;
END $$;

-- CREATE DATABASE can't run inside a transaction/DO block — emit it conditionally with \gexec.
SELECT 'CREATE DATABASE ai_hr OWNER ai_hr_owner'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'ai_hr')\gexec

\connect ai_hr

-- The app role may connect + use the public schema; everything else comes from grants below + migrations.
GRANT CONNECT ON DATABASE ai_hr TO ai_hr_app;
GRANT USAGE ON SCHEMA public TO ai_hr_app;

-- Auto-grant CRUD on every table/sequence that ai_hr_owner creates from here on (i.e. all migrations).
ALTER DEFAULT PRIVILEGES FOR ROLE ai_hr_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_hr_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ai_hr_app;

\echo '✅ ai_hr database + roles ready. Now run migrations as ai_hr_owner (see deploy/DEPLOY.md).'
