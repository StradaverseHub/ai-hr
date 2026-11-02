-- Independent nine-item compatibility repair. Applied 0859 bytes stay immutable.
-- Only the exact server-owned root JSON literal 1 is exempted from the numeric expansion fence.
DO $cohort_upgrade$
DECLARE prior_role text:=pg_catalog.current_setting('role');
 definition text;prior_acl aclitem[];prior_config text[];proc_oid oid;
 needle text:=$needle$pg_catalog.jsonb_path_exists(x.data,'strict $.** ? (@.type() == "number")')$needle$;
 replacement text:=$replacement$pg_catalog.jsonb_path_exists(CASE WHEN x.data->'creationDefaultsVersion'='1'::jsonb THEN x.data-'creationDefaultsVersion' ELSE x.data END,'strict $.** ? (@.type() == "number")')$replacement$;
BEGIN
 SELECT p.oid,p.proacl,p.proconfig INTO proc_oid,prior_acl,prior_config FROM pg_catalog.pg_proc p
 WHERE p.oid=to_regprocedure('app._draft_discard_source_snapshot(uuid,uuid)')
 AND p.proowner='ai_hr_draft_discard_port'::regrole AND p.prosecdef
 AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='c3a2744b7924ff9e4313c579dc9d831c5101a5d2b265dcad380cbab63b645ca9';
 IF proc_oid IS NULL OR pg_catalog.has_schema_privilege('ai_hr_draft_discard_port','app','CREATE') THEN
  RAISE EXCEPTION 'Draft cohort custody requires the exact existing restricted owner' USING ERRCODE='42501';END IF;
 definition:=pg_catalog.pg_get_functiondef(proc_oid);
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'Draft cohort custody predicate changed' USING ERRCODE='42501';END IF;
 definition:=replace(definition,needle,replacement);
 definition:=replace(definition,'No numeric leaf is serialized; timestamps are UTC.','Only the exact root creation cohort 1 may be numeric; timestamps are UTC.');
 GRANT CREATE ON SCHEMA app TO ai_hr_draft_discard_port;
 PERFORM pg_catalog.set_config('role','ai_hr_draft_discard_port',true);
 EXECUTE definition;
 PERFORM pg_catalog.set_config('role',prior_role,true);
 REVOKE CREATE ON SCHEMA app FROM ai_hr_draft_discard_port;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=proc_oid
  AND p.proowner='ai_hr_draft_discard_port'::regrole AND p.prosecdef
  AND p.proacl IS NOT DISTINCT FROM prior_acl AND p.proconfig IS NOT DISTINCT FROM prior_config)
 OR pg_catalog.has_schema_privilege('ai_hr_draft_discard_port','app','CREATE') THEN
  RAISE EXCEPTION 'Draft cohort custody owner or privileges changed' USING ERRCODE='42501';END IF;
END $cohort_upgrade$;
