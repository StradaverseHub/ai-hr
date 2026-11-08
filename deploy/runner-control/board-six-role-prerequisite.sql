-- Installation DBA only. Temporary privileges for immutable 3701; no HR rows change.
-- Run in one transaction; the caller binds database, source, ledger and lease.
DO $check$
DECLARE r record;
BEGIN
 IF current_setting('server_version_num')::int < 160000 OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PostgreSQL 16 installation DBA required'; END IF;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN('ai_hr_owner','ai_hr_app'))<>2 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('ai_hr_owner','ai_hr_app') AND(rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN RAISE EXCEPTION 'Unexpected owner/app attributes'; END IF;
 IF pg_has_role('ai_hr_app','ai_hr_owner','MEMBER') OR (SELECT nspowner FROM pg_namespace WHERE nspname='app')<>'ai_hr_owner'::regrole OR (SELECT proowner FROM pg_proc WHERE oid='app.reward_roles(uuid)'::regprocedure)<>'ai_hr_owner'::regrole THEN RAISE EXCEPTION 'Unexpected native ownership/topology'; END IF;
 FOR r IN SELECT * FROM pg_roles WHERE rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader') LOOP
  IF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit OR r.rolconnlimit<>-1 OR r.rolvaliduntil IS NOT NULL THEN RAISE EXCEPTION 'Unsafe preparation role: %',r.rolname; END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=r.oid OR member=r.oid) OR has_schema_privilege(r.oid,'app','CREATE') THEN RAISE EXCEPTION 'Unexpected existing preparation privileges: %',r.rolname; END IF;
 END LOOP;
END $check$;
DO $create$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_preparation_reader') THEN CREATE ROLE ai_hr_reward_preparation_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_preparation_invalidator') THEN CREATE ROLE ai_hr_reward_preparation_invalidator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_company_org_source_reader') THEN CREATE ROLE ai_hr_company_org_source_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT; END IF;
END $create$;
GRANT ai_hr_reward_preparation_reader,ai_hr_reward_preparation_invalidator,ai_hr_company_org_source_reader TO ai_hr_owner WITH INHERIT TRUE, SET TRUE, ADMIN FALSE;
GRANT CREATE ON SCHEMA app TO ai_hr_reward_preparation_reader,ai_hr_reward_preparation_invalidator,ai_hr_company_org_source_reader;
DO $verify$
BEGIN
 IF (SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid WHERE r.rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader') AND a.member='ai_hr_owner'::regrole AND a.inherit_option AND a.set_option AND NOT a.admin_option)<>3 THEN RAISE EXCEPTION 'Temporary edges differ'; END IF;
END $verify$;
