-- PRIVATE UNRUN: real restricted ledger-owner LOGIN, on hosted populated baseline only initially.
-- Preparation roles must already exist. Inert placeholder functions test ONLY actual preflight/
-- transfer/ACL/restoration mechanics, NOT native deletion or encrypted proof. Whole transaction rollback.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $$ BEGIN
 IF session_user<>current_user OR current_setting('role')<>'none' OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication) THEN RAISE EXCEPTION 'real restricted owner login required';END IF;
 IF to_regprocedure('app._draft_discard_source_snapshot(uuid,uuid)') IS NOT NULL OR to_regprocedure('app.native_employee_draft_discard_delete(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'placeholder names already exist: refuse';END IF;
END $$;
DO $preflight$
DECLARE child oid; app_role oid; owner_role oid; attrs record; app_attrs record; migration_super boolean;
BEGIN
 SELECT oid INTO child FROM pg_catalog.pg_roles WHERE rolname='ai_hr_draft_discard_port';
 SELECT oid INTO app_role FROM pg_catalog.pg_roles WHERE rolname='ai_hr_app';
 SELECT relowner INTO owner_role FROM pg_catalog.pg_class WHERE oid='app.assistant_own_leave_review'::regclass;
 IF current_user<>pg_catalog.pg_get_userbyid(owner_role) THEN RAISE EXCEPTION 'draft-discard: exact ledger owner required';END IF;
 IF child IS NULL OR app_role IS NULL THEN RAISE EXCEPTION 'draft-discard: operator role prerequisite missing';END IF;
 SELECT * INTO attrs FROM pg_catalog.pg_roles WHERE oid=child;
 SELECT * INTO app_attrs FROM pg_catalog.pg_roles WHERE oid=app_role;
 SELECT rolsuper INTO migration_super FROM pg_catalog.pg_roles WHERE rolname=current_user;
 IF NOT app_attrs.rolcanlogin OR app_attrs.rolsuper OR app_attrs.rolbypassrls OR app_attrs.rolcreaterole
  OR app_attrs.rolcreatedb OR app_attrs.rolreplication THEN RAISE EXCEPTION 'draft-discard: app role attributes';END IF;
 IF NOT attrs.rolinherit OR attrs.rolcanlogin OR attrs.rolsuper OR attrs.rolbypassrls OR attrs.rolcreaterole OR attrs.rolcreatedb OR attrs.rolreplication
  OR child=owner_role OR pg_catalog.pg_has_role(child,owner_role,'MEMBER') OR pg_catalog.pg_has_role(app_role,child,'MEMBER')
  OR NOT pg_catalog.pg_has_role(child,app_role,'USAGE') OR pg_catalog.pg_has_role(child,app_role,'SET')
  -- Disposable hosted SUPER migration owner cannot reproduce negative pg_has_role semantics.
  -- Only these two migration-owner checks are skipped; all real app/child/owner/RLS gates remain.
  OR (NOT migration_super AND (NOT pg_catalog.pg_has_role(current_user,child,'SET') OR pg_catalog.pg_has_role(current_user,child,'USAGE'))) THEN
  RAISE EXCEPTION 'draft-discard: incompatible role graph';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=app_role AND member=child AND inherit_option AND NOT set_option AND NOT admin_option)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=child AND roleid<>app_role)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='app' AND (pg_catalog.has_schema_privilege('ai_hr_app',oid,'CREATE') OR pg_catalog.has_schema_privilege(child,oid,'CREATE'))) THEN
  RAISE EXCEPTION 'draft-discard: role/schema privilege prerequisite';END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid IN('public.employee_draft'::regclass,'app.assistant_own_leave_review'::regclass,'app.assistant_own_leave_review_content'::regclass) AND (relowner=child OR relowner=app_role OR pg_catalog.pg_has_role(child,relowner,'MEMBER') OR pg_catalog.pg_has_role(app_role,relowner,'MEMBER') OR NOT relrowsecurity)) THEN
  RAISE EXCEPTION 'draft-discard: RLS owner prerequisite';END IF;
END $preflight$;
CREATE FUNCTION app._draft_discard_source_snapshot(uuid,uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS 'SELECT NULL::jsonb';
CREATE FUNCTION app.native_employee_draft_discard_delete(uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS 'SELECT NULL::uuid';
REVOKE ALL ON FUNCTION app._draft_discard_source_snapshot(uuid,uuid),app.native_employee_draft_discard_delete(uuid) FROM PUBLIC,ai_hr_app;
DO $transfer$
DECLARE prior text:=pg_catalog.current_setting('role'); schema_owner name; target text:='ai_hr_draft_discard_port';
BEGIN
 SELECT pg_catalog.pg_get_userbyid(relowner) INTO schema_owner FROM pg_catalog.pg_class WHERE oid='app.assistant_own_leave_review'::regclass;
 EXECUTE pg_catalog.format('GRANT CREATE ON SCHEMA app TO %I',target);
 ALTER FUNCTION app._draft_discard_source_snapshot(uuid,uuid) OWNER TO ai_hr_draft_discard_port;
 ALTER FUNCTION app.native_employee_draft_discard_delete(uuid) OWNER TO ai_hr_draft_discard_port;
 EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA app FROM %I',target);
 PERFORM pg_catalog.set_config('role',target,true);
 EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION app._draft_discard_source_snapshot(uuid,uuid) TO %I',schema_owner);
 GRANT EXECUTE ON FUNCTION app.native_employee_draft_discard_delete(uuid) TO ai_hr_app;
 PERFORM pg_catalog.set_config('role',prior,true);
END $transfer$;
DO $$ BEGIN
 IF current_user<>session_user OR current_setting('role')<>'none' OR has_schema_privilege('ai_hr_draft_discard_port','app','CREATE') OR has_schema_privilege('ai_hr_app','app','CREATE') THEN RAISE EXCEPTION 'role/schema restoration failed';END IF;
 IF has_function_privilege('ai_hr_app','app._draft_discard_source_snapshot(uuid,uuid)','EXECUTE') OR NOT has_function_privilege('ai_hr_app','app.native_employee_draft_discard_delete(uuid)','EXECUTE') THEN RAISE EXCEPTION 'wrong app ACL';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid IN('app._draft_discard_source_snapshot(uuid,uuid)'::regprocedure,'app.native_employee_draft_discard_delete(uuid)'::regprocedure) AND proowner<>(SELECT oid FROM pg_roles WHERE rolname='ai_hr_draft_discard_port')) THEN RAISE EXCEPTION 'wrong function owner';END IF;
END $$;
SELECT session_user,current_user,current_setting('role') AS effective_role,
 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='app.assistant_own_leave_review'::regclass) ledger_owner;
SELECT oid::regprocedure,pg_get_userbyid(proowner) AS owner,proacl FROM pg_proc WHERE oid IN('app._draft_discard_source_snapshot(uuid,uuid)'::regprocedure,'app.native_employee_draft_discard_delete(uuid)'::regprocedure);
ROLLBACK;
