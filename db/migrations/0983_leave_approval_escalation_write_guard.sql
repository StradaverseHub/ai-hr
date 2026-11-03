-- A broad Company Edit must not also authorize changing Leave routing.
CREATE FUNCTION app.leave_approval_escalation_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 PERFORM app.access_workforce_write_lock();
 IF app.leave_approval_escalation_source_allowed(to_jsonb(OLD),to_jsonb(NEW)) IS NOT TRUE THEN
  RAISE EXCEPTION 'Leave approval escalation action unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.leave_approval_escalation_write_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER aaa_leave_approval_escalation BEFORE UPDATE ON public.company FOR EACH ROW
 WHEN (
  (OLD.escalation_enabled,OLD.escalate_after_days,OLD.escalation_target,OLD.escalation_target_role,OLD.escalation_updated_at)
   IS DISTINCT FROM
  (NEW.escalation_enabled,NEW.escalate_after_days,NEW.escalation_target,NEW.escalation_target_role,NEW.escalation_updated_at)
 )
 EXECUTE FUNCTION app.leave_approval_escalation_write_guard();
CREATE TRIGGER aaa_leave_approval_escalation_access
 BEFORE UPDATE OF escalation_enabled,escalate_after_days,escalation_target,escalation_target_role,escalation_updated_at
 ON public.company FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();
--> statement-breakpoint
CREATE FUNCTION app.leave_approval_company_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type) AS (
  VALUES
   ('leave_approval_policy','module_leave_approval_assignment_action','app.leave_approval_assignment_guard()'::regprocedure,31),
   ('leave_approval_policy','module_leave_approval_assignment_lock','app.module_configuration_write_lock()'::regprocedure,30),
   ('company','aaa_leave_approval_escalation','app.leave_approval_escalation_write_guard()'::regprocedure,19),
   ('company','aaa_leave_approval_escalation_access','app.module_configuration_write_lock()'::regprocedure,18)
 )
 SELECT NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable AND c.relrowsecurity
    AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.leave_approval_company_bindings_complete() FROM PUBLIC,ai_hr_app;
