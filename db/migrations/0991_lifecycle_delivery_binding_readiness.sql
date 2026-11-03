CREATE FUNCTION app.lifecycle_delivery_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT app.lifecycle_assigned_task_bindings_complete()
 AND NOT EXISTS (
  SELECT FROM unnest(ARRAY['lc_onboarding_private','lc_onboarding_private_revision','lc_onboarding_note']) AS e(relation)
  WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname='lifecycle_native_effect_capture'
    AND t.tgfoid='app.lifecycle_native_effect_capture()'::regprocedure AND t.tgtype=29
    AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable AND c.relrowsecurity
    AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.lifecycle_delivery_bindings_complete() FROM PUBLIC,ai_hr_app;
