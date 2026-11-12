-- Run as the installation DBA IMMEDIATELY AFTER `pnpm db:migrate` when release-rewards-roles-prerequisite.sql was
-- applied before it, whether the migration passed or failed. Removes every temporary privilege that file granted and
-- verifies the resulting topology. Safe to repeat. Keeps the three purpose roles: once 3701 is applied they own
-- definers; before it they are inert NOLOGIN roles with no privileges.
BEGIN;

REVOKE CREATE ON SCHEMA app FROM ai_hr_reward_preparation_reader, ai_hr_reward_preparation_invalidator, ai_hr_company_org_source_reader,
  ai_hr_reward_setup_reader;
REVOKE ai_hr_reward_preparation_reader, ai_hr_reward_preparation_invalidator, ai_hr_company_org_source_reader,
  ai_hr_reward_setup_reader, ai_hr_reward_view_reader FROM ai_hr_owner;

DO $verify$
DECLARE applied boolean := to_regprocedure('app.reward_create_planned_unit_bound(uuid,uuid,uuid)') IS NOT NULL;
BEGIN
  -- No temporary membership or schema privilege is left.
  IF EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
              WHERE m.rolname = 'ai_hr_owner'
                AND r.rolname IN ('ai_hr_reward_preparation_reader', 'ai_hr_reward_preparation_invalidator', 'ai_hr_company_org_source_reader',
                                  'ai_hr_reward_setup_reader', 'ai_hr_reward_view_reader'))
  THEN RAISE EXCEPTION 'Temporary Rewards membership remains on ai_hr_owner'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r
              WHERE r.rolname IN ('ai_hr_reward_preparation_reader', 'ai_hr_reward_preparation_invalidator', 'ai_hr_company_org_source_reader',
                                  'ai_hr_reward_setup_reader', 'ai_hr_reward_view_reader', 'ai_hr_app')
                AND has_schema_privilege(r.rolname, 'app', 'CREATE'))
  THEN RAISE EXCEPTION 'A purpose or application role still holds CREATE on app'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname IN ('ai_hr_reward_preparation_reader', 'ai_hr_reward_preparation_invalidator', 'ai_hr_company_org_source_reader')
                AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolinherit))
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_owner'
                      AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
     OR pg_has_role('ai_hr_app', 'ai_hr_owner', 'MEMBER')
  THEN RAISE EXCEPTION 'Unexpected role attributes after cleanup'; END IF;
  -- When the migration was applied, the definers belong to the intended purpose owners.
  IF applied AND EXISTS (
    SELECT 1 FROM (VALUES
      ('app.reward_preparation_view(uuid)', 'ai_hr_reward_preparation_reader'),
      ('app.reward_preparation_upload_state(uuid)', 'ai_hr_reward_preparation_reader'),
      ('app.reward_preparation_released(uuid)', 'ai_hr_reward_preparation_reader'),
      ('app.reward_preparation_source_changed()', 'ai_hr_reward_preparation_invalidator'),
      ('app.company_org_scope_run(uuid)', 'ai_hr_company_org_source_reader'),
      ('app.company_org_scope_rows(uuid)', 'ai_hr_company_org_source_reader'),
      ('app.company_org_scope_mappings()', 'ai_hr_company_org_source_reader'),
      ('app.reward_create_planned_unit(uuid,uuid,uuid)', 'ai_hr_reward_setup_reader'),
      ('app.reward_create_planned_unit_bound(uuid,uuid,uuid)', 'ai_hr_reward_setup_reader')
    ) AS expected(signature, owner)
    WHERE to_regprocedure(expected.signature) IS NULL
       OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure(expected.signature)) <> expected.owner)
  THEN RAISE EXCEPTION 'Rewards preparation definers do not have their intended owners'; END IF;
  IF applied AND NOT has_function_privilege('ai_hr_reward_preparation_reader', 'app.reward_not_viewing_as()', 'EXECUTE')
  THEN RAISE EXCEPTION 'Preparation reader cannot evaluate View as'; END IF;
  -- The migration's REVOKEs landed: no handed-over definer is executable by PUBLIC (a SET-only owner leaves it so).
  IF applied AND EXISTS (
    SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid IN (to_regprocedure('app.reward_preparation_view(uuid)'), to_regprocedure('app.reward_preparation_upload_state(uuid)'),
                     to_regprocedure('app.reward_preparation_released(uuid)'), to_regprocedure('app.reward_preparation_source_changed()'),
                     to_regprocedure('app.company_org_scope_run(uuid)'), to_regprocedure('app.company_org_scope_rows(uuid)'),
                     to_regprocedure('app.company_org_scope_mappings()'), to_regprocedure('app.reward_create_planned_unit_bound(uuid,uuid,uuid)'))
       AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
  THEN RAISE EXCEPTION 'A Rewards preparation definer is still executable by PUBLIC'; END IF;
END $verify$;

COMMIT;
