-- Installation DBA only, after successful exact migration. No HR rows change.
DO $check$
DECLARE fn record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'Installation DBA required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('ai_hr_owner','ai_hr_app') AND(rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) OR pg_has_role('ai_hr_app','ai_hr_owner','MEMBER') THEN RAISE EXCEPTION 'Owner/app attributes changed'; END IF;
 IF (SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE r.rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader') AND m.rolname='ai_hr_owner' AND a.inherit_option AND a.set_option AND NOT a.admin_option)<>3 OR EXISTS(SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE (r.rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader') OR m.rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader')) AND NOT(r.rolname IN('ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader') AND m.rolname='ai_hr_owner' AND a.inherit_option AND a.set_option AND NOT a.admin_option)) THEN RAISE EXCEPTION 'Temporary graph changed'; END IF;
 FOR fn IN SELECT * FROM(VALUES
  ('app.reward_preparation_upload_state(uuid)','ai_hr_reward_preparation_reader',false),
  ('app.reward_preparation_released(uuid)','ai_hr_reward_preparation_reader',false),
  ('app.reward_preparation_view(uuid)','ai_hr_reward_preparation_reader',true),
  ('app.reward_preparation_source_changed()','ai_hr_reward_preparation_invalidator',false),
  ('app.company_org_scope_run(uuid)','ai_hr_company_org_source_reader',false),
  ('app.company_org_scope_rows(uuid)','ai_hr_company_org_source_reader',false),
  ('app.company_org_scope_mappings()','ai_hr_company_org_source_reader',false)
 ) AS f(signature,owner_name,app_execute) LOOP
  IF (SELECT proowner FROM pg_proc WHERE oid=fn.signature::regprocedure)<>fn.owner_name::regrole OR has_function_privilege('ai_hr_app',fn.signature,'EXECUTE') IS DISTINCT FROM fn.app_execute OR EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=fn.signature::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN RAISE EXCEPTION 'Installed function ownership/ACL differs: %',fn.signature; END IF;
 END LOOP;
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
