-- Publication requires the native void receipt and restricted original writer.
CREATE FUNCTION app.workforce_import_revert_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT NOT has_function_privilege('ai_hr_app','app.workforce_import_employment_void_native(uuid[],uuid,text)','EXECUTE')
  AND NOT has_function_privilege('ai_hr_app','app.import_employment_void_matches(public.employment,public.employment)','EXECUTE')
  AND NOT has_table_privilege('ai_hr_app','app.import_employment_void_effect','INSERT,UPDATE,DELETE')
  AND EXISTS(
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid='app.import_employment_void_effect'::regclass
    AND t.tgname='import_employment_void_receipt_epoch' AND t.tgtype=5 AND t.tgenabled IN ('O','A')
    AND p.oid='app.financial_receipts_prune()'::regprocedure
    AND p.proowner=c.relowner AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
  AND EXISTS(
   SELECT FROM pg_trigger t
   WHERE t.tgrelid='public.employment'::regclass AND t.tgfoid='app.employment_void_guard()'::regprocedure
    AND t.tgtype&19=19 AND t.tgenabled IN ('O','A')
  );
$$;
REVOKE ALL ON FUNCTION app.workforce_import_revert_bindings_complete() FROM PUBLIC,ai_hr_app;
