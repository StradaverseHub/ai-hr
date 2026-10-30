-- PRIVATE UNRUN. Only for child CREATED by the matching committed preparation receipt,
-- BEFORE domain migration/ownership transfer. Never remove a reused child or installed port.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SELECT set_config('proposal.expected_catalog', :'expected_catalog_sha', true);
SELECT set_config('proposal.created_here', :'receipt_child_created', true);
\ir snapshot-view.sql
DO $$
DECLARE own_name text; child oid; op oid; registry_installed boolean:=false;
BEGIN
 IF current_setting('proposal.created_here')<>'true' THEN RAISE EXCEPTION 'cannot rollback preexisting child';END IF;
 IF session_user<>current_user OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'real privileged operator required';END IF;
 IF (SELECT catalog_sha FROM port_catalog_receipt) IS DISTINCT FROM current_setting('proposal.expected_catalog') THEN RAISE EXCEPTION 'catalog changed';END IF;
 SELECT oid INTO child FROM pg_roles WHERE rolname='ai_hr_draft_discard_port';
 IF child IS NULL THEN RAISE EXCEPTION 'child absent: inspect receipt';END IF;
 IF to_regprocedure('app._draft_discard_source_snapshot(uuid,uuid)') IS NOT NULL OR to_regprocedure('app.native_employee_draft_discard_delete(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'domain installed: no role rollback';END IF;
 IF to_regclass('app.assistant_action_kind') IS NOT NULL THEN
  EXECUTE $registry_query$SELECT EXISTS(SELECT 1 FROM app.assistant_action_kind WHERE id='employees.draft.discard')$registry_query$ INTO registry_installed;
 END IF;
 IF registry_installed THEN RAISE EXCEPTION 'domain installed: no role rollback';END IF;
 IF (SELECT count(*) FROM pg_auth_members WHERE member=child OR roleid=child)<>2 THEN RAISE EXCEPTION 'unexpected child edges';END IF;
 SELECT pg_get_userbyid(relowner) INTO own_name FROM pg_class WHERE oid='app.assistant_own_leave_review'::regclass;
 SELECT oid INTO op FROM pg_roles WHERE rolname=current_user;
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE (member=child OR roleid=child) AND grantor<>op) THEN RAISE EXCEPTION 'foreign grantor: refuse';END IF;
 EXECUTE format('REVOKE ai_hr_draft_discard_port FROM %I',own_name);
 REVOKE ai_hr_app FROM ai_hr_draft_discard_port;
 -- No CASCADE, DROP OWNED, REASSIGN OWNED or privilege repair. Any dependency aborts ALL revokes.
 DROP ROLE ai_hr_draft_discard_port;
END $$;
SELECT * FROM port_catalog_receipt;
COMMIT;
