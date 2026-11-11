-- Run as the installation DBA on the application database IMMEDIATELY BEFORE `pnpm db:migrate` of a release that
-- applies 3701_rewards_unit_preparation and 4100_rewards_review_creator_independence to an installation whose ledger
-- predates them. Then run release-rewards-roles-cleanup.sql IMMEDIATELY AFTER the migration, whether it passed or
-- failed. Safe to repeat. Changes no table row.
--
-- Why: the migration owner (ai_hr_owner) is NOCREATEROLE and a member of no purpose role, so it cannot
--   * create 3701's three NOLOGIN purpose roles;
--   * hand 3701's definers to them (ALTER ... OWNER TO needs SET ROLE to the new owner, and the new owner needs
--     CREATE on schema app);
--   * rename and re-grant 4100's ai_hr_reward_setup_reader-owned app.reward_create_planned_unit (ownership needs
--     INHERIT membership), then hand its replacement back to that role;
--   * repeat 3701's GRANT EXECUTE on the ai_hr_reward_view_reader-owned app.reward_not_viewing_as(), which as a
--     non-owner silently grants nothing (WARNING 01007).
-- Proven by the populated restricted-owner rehearsal (test/production-upgrade-rehearsal.test.ts); without this file
-- 3701 and 4100 are refused with 42501.
BEGIN;

DO $check$
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN RAISE EXCEPTION 'PostgreSQL 16 required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_owner' AND rolcanlogin
                   AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
     OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) <> 'ai_hr_owner'
     OR (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'app') <> 'ai_hr_owner'
  THEN RAISE EXCEPTION 'Unexpected migration owner or database ownership'; END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('ai_hr_reward_setup_reader', 'ai_hr_reward_view_reader')) <> 2
  THEN RAISE EXCEPTION 'Rewards purpose roles from the installed ledger are missing'; END IF;
  -- Purpose roles, existing or about to be created, must be inert.
  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname IN ('ai_hr_reward_preparation_reader', 'ai_hr_reward_preparation_invalidator', 'ai_hr_company_org_source_reader',
                                'ai_hr_reward_setup_reader', 'ai_hr_reward_view_reader')
                AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname IN ('ai_hr_reward_preparation_reader', 'ai_hr_reward_preparation_invalidator', 'ai_hr_company_org_source_reader')
                AND rolinherit)
  THEN RAISE EXCEPTION 'Unsafe Rewards purpose role attributes'; END IF;
  -- Refuse an unexpected starting state rather than later revoking something this file did not grant.
  IF EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
              WHERE m.rolname = 'ai_hr_owner'
                AND r.rolname IN ('ai_hr_reward_preparation_reader', 'ai_hr_reward_preparation_invalidator', 'ai_hr_company_org_source_reader',
                                  'ai_hr_reward_setup_reader', 'ai_hr_reward_view_reader')
                AND NOT (a.set_option AND NOT a.admin_option))
  THEN RAISE EXCEPTION 'ai_hr_owner already holds an unexpected Rewards membership'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r
              WHERE r.rolname IN ('ai_hr_reward_preparation_reader', 'ai_hr_reward_preparation_invalidator', 'ai_hr_company_org_source_reader',
                                  'ai_hr_reward_setup_reader')
                AND has_schema_privilege(r.rolname, 'app', 'CREATE')
                AND NOT pg_has_role('ai_hr_owner', r.rolname, 'SET'))
  THEN RAISE EXCEPTION 'A Rewards purpose role already holds CREATE on app outside this procedure'; END IF;
END $check$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_reward_preparation_reader') THEN
    CREATE ROLE ai_hr_reward_preparation_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_reward_preparation_invalidator') THEN
    CREATE ROLE ai_hr_reward_preparation_invalidator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_company_org_source_reader') THEN
    CREATE ROLE ai_hr_company_org_source_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END $roles$;

-- TEMPORARY, for this migration only. New definer owners: SET to hand objects over, no inherited privileges.
GRANT ai_hr_reward_preparation_reader, ai_hr_reward_preparation_invalidator, ai_hr_company_org_source_reader
  TO ai_hr_owner WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
-- Existing owners whose objects the release renames, re-grants or replaces: ownership checks need INHERIT.
GRANT ai_hr_reward_setup_reader, ai_hr_reward_view_reader TO ai_hr_owner WITH INHERIT TRUE, SET TRUE, ADMIN FALSE;
-- ALTER ... OWNER TO requires the new owner to hold CREATE on the object's schema.
GRANT CREATE ON SCHEMA app TO ai_hr_reward_preparation_reader, ai_hr_reward_preparation_invalidator, ai_hr_company_org_source_reader,
  ai_hr_reward_setup_reader;

DO $verify$
BEGIN
  IF NOT (pg_has_role('ai_hr_owner', 'ai_hr_reward_preparation_reader', 'SET')
      AND pg_has_role('ai_hr_owner', 'ai_hr_reward_preparation_invalidator', 'SET')
      AND pg_has_role('ai_hr_owner', 'ai_hr_company_org_source_reader', 'SET')
      AND pg_has_role('ai_hr_owner', 'ai_hr_reward_setup_reader', 'USAGE')
      AND pg_has_role('ai_hr_owner', 'ai_hr_reward_view_reader', 'USAGE'))
  THEN RAISE EXCEPTION 'Temporary migration memberships were not established'; END IF;
  IF pg_has_role('ai_hr_app', 'ai_hr_owner', 'MEMBER') THEN RAISE EXCEPTION 'Application must never be a member of owner'; END IF;
END $verify$;

COMMIT;
