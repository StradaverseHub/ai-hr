-- PROVISIONAL UNAPPLIED SOURCE CLAIM ONLY: 0727 / idx708 / when1793330000064.
-- Other V9 work proposes56-63; performance0726/55 overlaps a sibling claim. This is NOT a canonical
-- reservation or application priority. Reallocate the complete unapplied tail above the actual accepted
-- installation ledger at integration freeze. No historical/applied SQL or sibling claim is changed.
-- Navigation returns one boolean per fixed action. It never exposes subjects, names, values or counts.
CREATE FUNCTION app.assistant_workforce_profile_navigation_available() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() IS TRUE AND EXISTS(
  SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id()
   AND app.assistant_workforce_profile_choice_scope(e.id) IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION app.assistant_workforce_profile_navigation_available() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_workforce_profile_navigation_available() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_employee_code_navigation_available() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() IS TRUE AND EXISTS(
  SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id()
   AND app.assistant_employee_code_choice_scope(e.id));
$$;
REVOKE ALL ON FUNCTION app.assistant_employee_code_navigation_available() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_employee_code_navigation_available() TO ai_hr_app;
