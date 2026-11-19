-- UNALLOCATED combined-source bridge. STAGING owns journal/tag allocation.
-- Order: seven original Resignation SQL bodies -> this bridge -> all original Contract SQL.
-- Both originals CREATE the identical reviewed directory signature. Preserve both SQL bodies;
-- retain the original OID privately so the later original may create its own public signature.
-- No data, policy, owner or new EXECUTE grant. Unexpected source or archive refuses atomically.
DO $bridge$
DECLARE signature regprocedure:=to_regprocedure('app.contract_configuration_directory(uuid[],text,uuid[])');
BEGIN
 IF signature IS NULL OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=signature)
  IS DISTINCT FROM '42bedab17bf4a3ded8f494d48c86b5e7ca21afefffb3ac0a8a3bc1cd2017ce5b' THEN
  RAISE EXCEPTION 'Expected the reviewed Resignation Contract directory before combined bridge';
 END IF;
 IF to_regprocedure('app.contract_configuration_directory_before_combined(uuid[],text,uuid[])') IS NOT NULL THEN
  RAISE EXCEPTION 'Combined Contract directory archive already exists';
 END IF;
 ALTER FUNCTION app.contract_configuration_directory(uuid[],text,uuid[]) RENAME TO contract_configuration_directory_before_combined;
 REVOKE ALL ON FUNCTION app.contract_configuration_directory_before_combined(uuid[],text,uuid[]) FROM PUBLIC,ai_hr_app;
END $bridge$;
