-- Draft administration and author access share the physical draft guard. Only
-- the company course can prepare and consume the completed native hire source.
CREATE FUNCTION app.workforce_drafts_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected_trigger(relation,trigger_name,owner_function,trigger_type,deferred) AS (
  VALUES
   ('public.employee_draft','aaa_workforce_draft_purpose','app.workforce_draft_purpose_guard()'::regprocedure,31,false),
   ('public.employment','workforce_hire_source_bind','app.access_workforce_bind_hire_source()'::regprocedure,5,false),
   ('app.workforce_hire_source','workforce_hire_source_complete','app.access_workforce_hire_source_complete()'::regprocedure,21,true),
   ('app.workforce_draft_discard_source','workforce_draft_discard_complete','app.workforce_draft_discard_complete_guard()'::regprocedure,5,true)
 )
 SELECT NOT EXISTS(
  SELECT FROM expected_trigger e
  WHERE NOT EXISTS(
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   JOIN pg_class c ON c.oid='public.access_capability'::regclass
   WHERE t.tgrelid=to_regclass(e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.owner_function
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A')
    AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND p.proowner=c.relowner AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 ) AND EXISTS(
  SELECT FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  WHERE p.polrelid='public.employee_draft'::regclass AND p.polname='workforce_draft_function_read'
   AND p.polcmd='r' AND NOT p.polpermissive AND c.relrowsecurity
   AND p.polroles=ARRAY['ai_hr_app'::regrole::oid]
   AND position('workforce_draft_view_current' in pg_get_expr(p.polqual,p.polrelid))>0
 );
$$;
REVOKE ALL ON FUNCTION app.workforce_drafts_bindings_complete() FROM PUBLIC,ai_hr_app;
