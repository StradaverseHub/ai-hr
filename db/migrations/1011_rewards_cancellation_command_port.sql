CREATE FUNCTION app.rewards_delete_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current()
  AND cap='rewards.delete' AND app.lifecycle_reward_notice_legacy_allowed(t,u,cap,co)
  AND CASE WHEN co IS NULL THEN app.is_group_admin() ELSE app.reward_admin(co) END;
$$;
REVOKE ALL ON FUNCTION app.rewards_delete_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_cancel_review(p_unit uuid,p_revision integer,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (SELECT count(*) FROM public.access_capability WHERE supported
  AND id IN ('function.rewards.cancellation.assigned.execute','function.rewards.cancellation.administration.execute'))<>2
 THEN RAISE EXCEPTION 'Reward cancellation command unavailable' USING ERRCODE='42501'; END IF;
 RETURN app.reward_cancel_command(p_unit,p_revision,p_reason);
END;
$$;
REVOKE ALL ON FUNCTION app.reward_cancel_review(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_cancel_review(uuid,integer,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_cancellation_published_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.reward_unit; admitted boolean;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='reward_unit' THEN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
   AND NOT app.lifecycle_reward_notice_action('rewards','delete',OLD.company_id)
  THEN RAISE EXCEPTION 'Reward review deletion unavailable' USING ERRCODE='42501'; END IF;
  IF NEW.status<>'withdrawn' OR OLD.status='withdrawn' OR NEW.revision<>OLD.revision+1 THEN RETURN NEW; END IF;
 ELSE
  IF NEW.action<>'withdraw' THEN RETURN NEW; END IF;
  SELECT unit.* INTO source FROM public.reward_unit unit WHERE unit.id=NEW.unit_id
   AND unit.tenant_id=NEW.tenant_id AND unit.tenant_id=app.current_tenant_id()
   AND unit.status='withdrawn' AND unit.revision=NEW.revision+1;
  IF source.id IS NULL THEN RETURN NEW; END IF;
 END IF;
 IF NOT EXISTS (SELECT FROM public.access_capability WHERE supported
  AND id IN ('function.rewards.cancellation.assigned.execute','function.rewards.cancellation.administration.execute'))
 THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='reward_unit' THEN
  SELECT EXISTS (
   SELECT FROM app.reward_cancel_native_effect effect WHERE effect.xact_id=pg_current_xact_id()
    AND effect.tenant_id=OLD.tenant_id AND effect.tenant_id=app.current_tenant_id()
    AND effect.user_id=app.current_user_id() AND effect.unit_id=OLD.id AND effect.active AND NOT effect.completed
    AND effect.admission->>'unitBeforeHash'=app.reward_decision_row_hash(to_jsonb(OLD),'reward_unit')
  ) INTO admitted;
 ELSE
  SELECT EXISTS (
   SELECT FROM app.reward_cancel_native_effect effect WHERE effect.xact_id=pg_current_xact_id()
    AND effect.tenant_id=NEW.tenant_id AND effect.user_id=app.current_user_id()
    AND effect.user_id=NEW.actor_id AND effect.unit_id=NEW.unit_id AND effect.decision_id=NEW.id
    AND effect.active AND NOT effect.completed
  ) INTO admitted;
 END IF;
 IF admitted IS NOT TRUE THEN
  RAISE EXCEPTION 'Published Reward cancellation requires its fixed command' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.reward_cancellation_published_source_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER z_reward_cancellation_published_source BEFORE UPDATE ON public.reward_unit
 FOR EACH ROW EXECUTE FUNCTION app.reward_cancellation_published_source_guard();
CREATE TRIGGER z_reward_cancellation_published_source BEFORE INSERT ON public.reward_decision
 FOR EACH ROW EXECUTE FUNCTION app.reward_cancellation_published_source_guard();
--> statement-breakpoint
DO $view$
DECLARE definition text; anchor text:=' IF app.function_action_allowed(key,''execute'',unit.company_id)IS NOT TRUE OR(course=';
BEGIN
 definition:=pg_get_functiondef('app.reward_cancel_admission(uuid,integer,text)'::regprocedure);
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'Rewards cancellation admission changed';
 END IF;
 EXECUTE replace(definition,anchor,' IF app.function_action_allowed(key,''view'',unit.company_id)IS NOT TRUE OR '||substr(anchor,5));
END;
$view$;
--> statement-breakpoint
CREATE FUNCTION app.rewards_cancellation_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH guards(relation,trigger_name,handler,kind,deferred) AS (
  VALUES
   ('public.reward_unit','z_reward_cancellation_published_source','app.reward_cancellation_published_source_guard()'::regprocedure,19,false),
   ('public.reward_decision','z_reward_cancellation_published_source','app.reward_cancellation_published_source_guard()'::regprocedure,7,false),
   ('public.reward_unit','rewards_cancel_native_capture','app.reward_cancel_native_capture()'::regprocedure,17,false),
   ('public.reward_decision','rewards_cancel_native_capture','app.reward_cancel_native_capture()'::regprocedure,5,false),
   ('app.reward_cancel_native_effect','rewards_cancel_native_effect','app.reward_cancel_native_validate()'::regprocedure,17,true)
 )
 SELECT has_function_privilege('ai_hr_app','app.reward_cancel_review(uuid,integer,text)','EXECUTE')
  AND NOT has_function_privilege('ai_hr_app','app.reward_cancel_command(uuid,integer,text)','EXECUTE')
  AND NOT has_function_privilege('ai_hr_app','app.reward_cancel_admission(uuid,integer,text)','EXECUTE')
  AND NOT EXISTS (
   SELECT FROM guards e WHERE NOT EXISTS (
    SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.oid=to_regclass(e.relation) AND c.relrowsecurity
     AND t.tgname=e.trigger_name AND t.tgfoid=e.handler AND t.tgtype=e.kind
     AND t.tgenabled IN ('O','A') AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
     AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
   )
  );
$$;
REVOKE ALL ON FUNCTION app.rewards_cancellation_bindings_complete() FROM PUBLIC,ai_hr_app;
