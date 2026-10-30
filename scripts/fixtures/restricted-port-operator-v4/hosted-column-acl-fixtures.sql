-- AUTHORED UNRUN; hosted disposable POPULATED baseline ONLY, real privileged operator session.
-- No staging invocation. Exact proposal validator is reproduced below solely for fixture isolation.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
\ir snapshot-view.sql
CREATE FUNCTION pg_temp.validate_port_proposal() RETURNS void LANGUAGE plpgsql AS $fixture$
DECLARE actual text; own oid; appid oid; child oid; operator_id oid; owner_name text; made boolean:=false; x record; permission_name text;
BEGIN
 IF current_setting('server_version_num')::integer<160000 THEN RAISE EXCEPTION 'PG16 membership semantics required';END IF;
 SELECT oid INTO operator_id FROM pg_roles WHERE rolname=current_user AND rolsuper;
 IF operator_id IS NULL OR session_user<>current_user THEN RAISE EXCEPTION 'explicit real privileged operator login required';END IF;
 SELECT catalog_sha INTO actual FROM port_catalog_receipt;
 IF actual IS DISTINCT FROM current_setting('proposal.expected_catalog') THEN RAISE EXCEPTION 'catalog changed: inspect again';END IF;
 SELECT relowner INTO own FROM pg_class WHERE oid='app.assistant_own_leave_review'::regclass;
 SELECT rolname INTO owner_name FROM pg_roles WHERE oid=own;
 SELECT oid INTO appid FROM pg_roles WHERE rolname='ai_hr_app';
 IF appid IS NULL OR own=appid OR owner_name IS NULL THEN RAISE EXCEPTION 'owner/app identity unavailable';END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE oid=appid AND (NOT rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN RAISE EXCEPTION 'unsafe app attributes';END IF;
 -- A real restricted LOGIN rehearsal is required. Do not silently substitute postgres SET ROLE.
 IF EXISTS(SELECT 1 FROM pg_roles WHERE oid=own AND (NOT rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN RAISE EXCEPTION 'restricted ledger owner login prerequisite unavailable';END IF;
 SELECT oid INTO child FROM pg_roles WHERE rolname='ai_hr_draft_discard_port';
 IF child IS NULL THEN
  CREATE ROLE ai_hr_draft_discard_port NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION CONNECTION LIMIT -1;
  GRANT ai_hr_app TO ai_hr_draft_discard_port WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
  EXECUTE format('GRANT ai_hr_draft_discard_port TO %I WITH INHERIT FALSE, SET TRUE, ADMIN FALSE',owner_name);
  SELECT oid INTO child FROM pg_roles WHERE rolname='ai_hr_draft_discard_port';made:=true;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE oid=child AND (rolcanlogin OR NOT rolinherit OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolconnlimit<>-1 OR rolvaliduntil IS NOT NULL)) THEN RAISE EXCEPTION 'incompatible existing child attributes';END IF;
 IF (SELECT count(*) FROM pg_auth_members WHERE roleid=child OR member=child)<>2
 OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=appid AND member=child AND inherit_option AND NOT set_option AND NOT admin_option)
 OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=child AND member=own AND NOT inherit_option AND set_option AND NOT admin_option)
 OR pg_has_role(appid,child,'MEMBER') OR pg_has_role(child,own,'MEMBER')
 OR NOT pg_has_role(child,appid,'USAGE') OR pg_has_role(child,appid,'SET')
 OR NOT pg_has_role(own,child,'SET') OR pg_has_role(own,child,'USAGE') THEN RAISE EXCEPTION 'incompatible incident/transitive graph';END IF;
 -- This is PRE-DOMAIN role preparation only. Native0752 owns its eventual exact column ACLs.
 -- A previous completed installation requires post-install validation, never this role installer.
 IF to_regprocedure('app._draft_discard_source_snapshot(uuid,uuid)') IS NOT NULL
 OR to_regprocedure('app.native_employee_draft_discard_delete(uuid)') IS NOT NULL
 OR EXISTS(SELECT 1 FROM app.assistant_action_kind WHERE id='employees.draft.discard')
 THEN RAISE EXCEPTION 'domain already installed: use post-install validation, not role preparation';END IF;
 -- Before domain adoption there must be no direct child grant on any protected relation or column,
 -- including employee_draft (its intended rights come ONLY by inheriting app RLS privileges).
 IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE a.grantee=child AND c.oid=ANY(ARRAY[to_regclass('public.employee_draft'),to_regclass('app.assistant_own_leave_review'),to_regclass('app.assistant_own_leave_review_content'),to_regclass('app.native_outcome_source_capture'),to_regclass('app.native_outcome_source_target'),to_regclass('public.ai_native_outcome_association')]))
 OR EXISTS(SELECT 1 FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
  WHERE a.grantee=child AND c.attnum>0 AND NOT c.attisdropped AND c.attrelid=ANY(ARRAY[to_regclass('public.employee_draft'),to_regclass('app.assistant_own_leave_review'),to_regclass('app.assistant_own_leave_review_content'),to_regclass('app.native_outcome_source_capture'),to_regclass('app.native_outcome_source_target'),to_regclass('public.ai_native_outcome_association')]))
 THEN RAISE EXCEPTION 'unexpected direct child relation/column ACL';END IF;
 -- Effective privilege probes include inherited/PUBLIC/table-level and column-level grants.
 -- No unexpected ACL is repaired/revoked, and no existing app right is broadened.
 FOR x IN SELECT c.oid,n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.oid=ANY(ARRAY[to_regclass('app.assistant_own_leave_review'),to_regclass('app.assistant_own_leave_review_content'),to_regclass('app.native_outcome_source_capture'),to_regclass('app.native_outcome_source_target')]) LOOP
  FOREACH permission_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
   IF has_table_privilege(child,x.oid,permission_name) THEN RAISE EXCEPTION 'unexpected effective child private-table privilege';END IF;
  END LOOP;
  FOREACH permission_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
   IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=x.oid AND a.attnum>0 AND NOT a.attisdropped
    AND has_column_privilege(child,x.oid,a.attnum,permission_name))
   THEN RAISE EXCEPTION 'unexpected effective child private-column privilege';END IF;
  END LOOP;
 END LOOP;
 -- 0650 intentionally gives app SELECT/INSERT/DELETE on association. Child inherits EXACTLY that
 -- approved RLS-scoped baseline; it is not a zero-private relation. No direct child ACL is allowed above.
 FOR x IN SELECT r.oid FROM pg_roles r WHERE r.oid IN(appid,child) LOOP
  FOREACH permission_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
   IF has_table_privilege(x.oid,'public.ai_native_outcome_association',permission_name)
    IS DISTINCT FROM (permission_name IN('SELECT','INSERT','DELETE'))
   THEN RAISE EXCEPTION 'association effective privilege differs from approved app baseline';END IF;
  END LOOP;
  FOREACH permission_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
   IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.ai_native_outcome_association'::regclass
    AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(x.oid,a.attrelid,a.attnum,permission_name)
     IS DISTINCT FROM (permission_name IN('SELECT','INSERT')))
   THEN RAISE EXCEPTION 'association effective column privilege differs from approved app baseline';END IF;
  END LOOP;
 END LOOP;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.ai_native_outcome_association'::regclass)
 THEN RAISE EXCEPTION 'association RLS prerequisite';END IF;
 IF has_schema_privilege(appid,'app','CREATE') OR has_schema_privilege(child,'app','CREATE') THEN RAISE EXCEPTION 'unsafe effective schema CREATE';END IF;
 FOR x IN SELECT oid,relowner,relrowsecurity FROM pg_class WHERE oid IN('public.employee_draft'::regclass,'app.assistant_own_leave_review'::regclass,'app.assistant_own_leave_review_content'::regclass) LOOP
  IF NOT x.relrowsecurity OR x.relowner IN(appid,child) OR pg_has_role(appid,x.relowner,'MEMBER') OR pg_has_role(child,x.relowner,'MEMBER') THEN RAISE EXCEPTION 'unsafe protected-table ownership/RLS';END IF;
 END LOOP;
 PERFORM set_config('proposal.child_created',made::text,true);
END
$fixture$;
SELECT set_config('proposal.expected_catalog',(SELECT catalog_sha FROM port_catalog_receipt),true);
SELECT pg_temp.validate_port_proposal();
-- Healthy inherited 0650 association rights must pass once and again without creating another role.
SELECT set_config('proposal.expected_catalog',(SELECT catalog_sha FROM port_catalog_receipt),true);
CREATE TEMP TABLE port_fixture_healthy_catalog AS SELECT * FROM port_catalog_receipt;
SELECT pg_temp.validate_port_proposal();
DO $$ BEGIN IF (SELECT catalog_sha FROM port_catalog_receipt) IS DISTINCT FROM (SELECT catalog_sha FROM port_fixture_healthy_catalog) OR (SELECT catalog FROM port_catalog_receipt) IS DISTINCT FROM (SELECT catalog FROM port_fixture_healthy_catalog) THEN RAISE EXCEPTION 'idempotent validation changed full catalog';END IF;END $$;
DO $$ DECLARE child oid; before_hash text; after_hash text; rejected boolean; BEGIN
 SELECT oid INTO child FROM pg_roles WHERE rolname='ai_hr_draft_discard_port';
 IF NOT has_table_privilege(child,'public.ai_native_outcome_association','SELECT') OR NOT has_table_privilege(child,'public.ai_native_outcome_association','INSERT') OR NOT has_table_privilege(child,'public.ai_native_outcome_association','DELETE') OR has_table_privilege(child,'public.ai_native_outcome_association','UPDATE') THEN RAISE EXCEPTION 'positive association baseline not reached';END IF;
 -- Grant changes AFTER approved snapshot must alter attacl fingerprint before mutation can pass.
 SELECT catalog_sha INTO before_hash FROM port_catalog_receipt;
 BEGIN
  GRANT SELECT(ciphertext) ON app.assistant_own_leave_review_content TO ai_hr_draft_discard_port;
  SELECT catalog_sha INTO after_hash FROM port_catalog_receipt;
  IF before_hash=after_hash THEN RAISE EXCEPTION 'column ACL fingerprint omitted';END IF;
  rejected:=false;
  BEGIN PERFORM pg_temp.validate_port_proposal();EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'catalog changed: inspect again' THEN RAISE;END IF;rejected:=true;END;
  IF NOT rejected THEN RAISE EXCEPTION 'stale catalog accepted';END IF;
  -- Even a freshly observed hostile grant is NEVER reconciled into the accepted baseline.
  PERFORM set_config('proposal.expected_catalog',after_hash,true);rejected:=false;
  BEGIN PERFORM pg_temp.validate_port_proposal();EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'unexpected direct child relation/column ACL' THEN RAISE;END IF;rejected:=true;END;
  IF NOT rejected THEN RAISE EXCEPTION 'direct ciphertext grant accepted';END IF;
  RAISE EXCEPTION 'fixture rollback ciphertext';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'fixture rollback ciphertext' THEN RAISE;END IF;
 END;
 PERFORM set_config('proposal.expected_catalog',(SELECT catalog_sha FROM port_catalog_receipt),true);
 BEGIN
  GRANT UPDATE(target_id) ON app.native_outcome_source_target TO PUBLIC;
  PERFORM set_config('proposal.expected_catalog',(SELECT catalog_sha FROM port_catalog_receipt),true);rejected:=false;
  BEGIN PERFORM pg_temp.validate_port_proposal();EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'unexpected effective child private-column privilege' THEN RAISE;END IF;rejected:=true;END;
  IF NOT rejected THEN RAISE EXCEPTION 'inherited PUBLIC capture mutation accepted';END IF;
  RAISE EXCEPTION 'fixture rollback capture';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'fixture rollback capture' THEN RAISE;END IF;
 END;
 -- Extra association UPDATE is not part of0650 approved inheritance, even after fresh snapshot.
 BEGIN
  GRANT UPDATE ON public.ai_native_outcome_association TO ai_hr_app;
  PERFORM set_config('proposal.expected_catalog',(SELECT catalog_sha FROM port_catalog_receipt),true);rejected:=false;
  BEGIN PERFORM pg_temp.validate_port_proposal();EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'association effective privilege differs from approved app baseline' THEN RAISE;END IF;rejected:=true;END;
  IF NOT rejected THEN RAISE EXCEPTION 'association UPDATE accepted';END IF;
  RAISE EXCEPTION 'fixture rollback association';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'fixture rollback association' THEN RAISE;END IF;
 END;
 -- Existing child attributes must be refused, never silently repaired.
 BEGIN
  ALTER ROLE ai_hr_draft_discard_port LOGIN;
  PERFORM set_config('proposal.expected_catalog',(SELECT catalog_sha FROM port_catalog_receipt),true);rejected:=false;
  BEGIN PERFORM pg_temp.validate_port_proposal();EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'incompatible existing child attributes' THEN RAISE;END IF;rejected:=true;END;
  IF NOT rejected THEN RAISE EXCEPTION 'LOGIN child accepted';END IF;
  RAISE EXCEPTION 'fixture rollback attributes';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'fixture rollback attributes' THEN RAISE;END IF;
 END;
 -- A nonoperator/SET ROLE session must fail BEFORE catalog mutation, not gain privilege from the fixture.
 BEGIN
  PERFORM set_config('role','ai_hr_draft_discard_port',true);rejected:=false;
  BEGIN PERFORM pg_temp.validate_port_proposal();EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'explicit real privileged operator login required' THEN RAISE;END IF;rejected:=true;END;
  IF NOT rejected THEN RAISE EXCEPTION 'wrong operator accepted';END IF;
  RAISE EXCEPTION 'fixture rollback operator';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'fixture rollback operator' THEN RAISE;END IF;
 END;
 IF (SELECT catalog_sha FROM port_catalog_receipt) IS DISTINCT FROM (SELECT catalog_sha FROM port_fixture_healthy_catalog)
 OR (SELECT catalog FROM port_catalog_receipt) IS DISTINCT FROM (SELECT catalog FROM port_fixture_healthy_catalog)
 THEN RAISE EXCEPTION 'hostile fixture rollback did not restore full catalog';END IF;
 PERFORM set_config('proposal.expected_catalog',(SELECT catalog_sha FROM port_catalog_receipt),true);
 PERFORM pg_temp.validate_port_proposal();
END $$;
ROLLBACK;
