-- PostgreSQL 16. Installation DBA only; does not run a sweep or change an HR row.
-- Privileged maintenance must switch DOWN to the tenant-scoped app role before dispatch.
-- Never grant the owner role to the application role.
BEGIN;
DO $check$
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN RAISE EXCEPTION 'PostgreSQL 16 required'; END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('ai_hr_owner','ai_hr_app')) <> 2
     OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('ai_hr_owner','ai_hr_app')
       AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
  THEN RAISE EXCEPTION 'Unexpected database role topology'; END IF;
  IF pg_has_role('ai_hr_app','ai_hr_owner','MEMBER') THEN
    RAISE EXCEPTION 'Application must never be a member of owner';
  END IF;
END $check$;
GRANT ai_hr_app TO ai_hr_owner WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
DO $verify$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid
    JOIN pg_roles m ON m.oid=a.member WHERE r.rolname='ai_hr_app' AND m.rolname='ai_hr_owner'
    AND NOT a.inherit_option AND a.set_option AND NOT a.admin_option)
  THEN RAISE EXCEPTION 'Required restricted downgrade edge was not established'; END IF;
  IF pg_has_role('ai_hr_app','ai_hr_owner','MEMBER') THEN
    RAISE EXCEPTION 'Application unexpectedly acquired owner membership'; END IF;
END $verify$;
COMMIT;
