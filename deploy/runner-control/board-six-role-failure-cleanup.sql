-- Installation DBA only: failure cleanup without requiring uncommitted functions to exist.
-- Exact same topology/attribute checks and removal as successful postflight; no HR rows change.
DO $check$
DECLARE r record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'Installation DBA required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('ai_hr_owner','ai_hr_app') AND(rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) OR pg_has_role('ai_hr_app','ai_hr_owner','MEMBER') THEN RAISE EXCEPTION 'Owner/app attributes changed'; END IF;
 IF (SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE r.rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader') AND m.rolname='ai_hr_owner' AND a.inherit_option AND a.set_option AND NOT a.admin_option)<>3 OR EXISTS(SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE (r.rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader') OR m.rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader')) AND NOT(r.rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader') AND m.rolname='ai_hr_owner' AND a.inherit_option AND a.set_option AND NOT a.admin_option)) THEN RAISE EXCEPTION 'Temporary graph changed'; END IF;
END $check$;
REVOKE ai_hr_reward_preparation_reader,ai_hr_reward_preparation_invalidator,ai_hr_company_org_source_reader FROM ai_hr_owner;
REVOKE CREATE ON SCHEMA app FROM ai_hr_reward_preparation_reader,ai_hr_reward_preparation_invalidator,ai_hr_company_org_source_reader;
DO $verify$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM pg_roles WHERE rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader') LOOP
  IF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=r.oid OR member=r.oid) OR has_schema_privilege(r.oid,'app','CREATE') THEN RAISE EXCEPTION 'Temporary preparation privilege remains: %',r.rolname; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader'))<>3 THEN RAISE EXCEPTION 'Preparation role missing'; END IF;
END $verify$;
