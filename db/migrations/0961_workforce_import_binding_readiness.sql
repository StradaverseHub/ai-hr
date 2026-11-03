-- Check the exact three import courses and the physical Qualification staging guard.
CREATE FUNCTION app.workforce_imports_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(operation,parent_capability) AS (
  VALUES ('view','workforce.view'),('add','workforce.add'),('execute','workforce.edit')
 )
 SELECT (SELECT count(*) FROM app.access_function_action WHERE function_key='workforceImports')=3
  AND NOT EXISTS (
   SELECT FROM expected e
   WHERE NOT EXISTS (
    SELECT FROM app.access_function_action a
    JOIN app.access_function_definition d USING(function_key)
    WHERE a.function_key='workforceImports' AND d.scope='company'
     AND a.operation=e.operation AND a.parent_capability=e.parent_capability
     AND a.delegation_floor_function='app.workforce_function_delegation_allowed'
   )
  )
  AND EXISTS(
   SELECT FROM pg_trigger t
   JOIN pg_proc p ON p.oid=t.tgfoid
   JOIN pg_class c ON c.oid=t.tgrelid
   WHERE c.oid='app.qualification_import_preview'::regclass
    AND t.tgname='qualification_import_preview_subject_guard' AND t.tgtype=7
    AND t.tgenabled IN ('O','A') AND p.oid='app.qualification_import_preview_subject_guard()'::regprocedure
    AND p.prosecdef AND p.proowner=c.relowner AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
  AND NOT has_function_privilege('ai_hr_app','app.workforce_bank_import_subjects_native(jsonb)','EXECUTE');
$$;
REVOKE ALL ON FUNCTION app.workforce_imports_bindings_complete() FROM PUBLIC,ai_hr_app;
