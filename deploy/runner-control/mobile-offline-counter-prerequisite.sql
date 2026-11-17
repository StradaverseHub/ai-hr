-- DBA-only prerequisite for the UNALLOCATED grouped offline-count proposal. No installation is authorized here.
BEGIN;
DO $check$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_owner' AND rolcanlogin
  AND NOT(rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
  OR (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='app')<>'ai_hr_owner'
 THEN RAISE EXCEPTION 'Unexpected migration owner'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_mobile_offline_counter'
  AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolinherit))
  OR EXISTS(SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid OR r.oid=a.member
   WHERE r.rolname='ai_hr_mobile_offline_counter')
 THEN RAISE EXCEPTION 'Unsafe preexisting offline counter role or membership'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_mobile_offline_counter') THEN
  IF has_schema_privilege('ai_hr_mobile_offline_counter','app','CREATE') THEN RAISE EXCEPTION 'Unexpected schema CREATE'; END IF;
 ELSE
  CREATE ROLE ai_hr_mobile_offline_counter NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $check$;
GRANT ai_hr_mobile_offline_counter TO ai_hr_owner WITH INHERIT TRUE,SET TRUE,ADMIN FALSE;
GRANT CREATE ON SCHEMA app TO ai_hr_mobile_offline_counter;
COMMIT;
