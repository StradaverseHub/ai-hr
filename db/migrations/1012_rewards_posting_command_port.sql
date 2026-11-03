CREATE FUNCTION app.reward_post_review(p_unit uuid,p_revision integer,p_batch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source_company uuid;
BEGIN
 IF NOT EXISTS (SELECT FROM public.access_capability WHERE id='function.rewards.posting.execute' AND supported) THEN
  RAISE EXCEPTION 'Reward posting command unavailable' USING ERRCODE='42501';
 END IF;
 SELECT company_id INTO source_company FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id();
 IF source_company IS NULL OR NOT app.function_action_allowed('rewards.posting','view',source_company) THEN
  RAISE EXCEPTION 'Reward posting unavailable' USING ERRCODE='42501';
 END IF;
 RETURN app.reward_post_receipt_command(p_unit,p_revision,p_batch);
END;
$$;
REVOKE ALL ON FUNCTION app.reward_post_review(uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_post_review(uuid,integer,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_posting_published_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() OR OLD.status='posted' OR NEW.status<>'posted'
  OR NOT EXISTS (SELECT FROM public.access_capability WHERE id='function.rewards.posting.execute' AND supported)
 THEN RETURN NEW; END IF;
 IF NOT EXISTS (
  SELECT FROM app.reward_post_native_context effect
  WHERE effect.xact_id=pg_current_xact_id() AND effect.tenant_id=OLD.tenant_id
   AND effect.tenant_id=app.current_tenant_id() AND effect.user_id=app.current_user_id()
   AND effect.unit_id=OLD.id AND effect.active AND NOT effect.completed
   AND effect.admission->>'unitBeforeHash'=app.reward_decision_row_hash(to_jsonb(OLD),'reward_unit')
 )
 THEN RAISE EXCEPTION 'Published Reward posting requires its fixed command' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.reward_posting_published_source_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER z_reward_posting_published_source BEFORE UPDATE ON public.reward_unit
 FOR EACH ROW EXECUTE FUNCTION app.reward_posting_published_source_guard();
--> statement-breakpoint
CREATE FUNCTION app.rewards_posting_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH guards(relation,trigger_name,handler,kind,deferred) AS (
  SELECT 'public.'||relation,'rewards_post_native_capture','app.reward_post_native_capture()'::regprocedure,21,false
  FROM unnest(ARRAY['reward_unit','reward_entry','compensation','employment','payroll_input']) capture(relation)
  UNION ALL VALUES
   ('public.reward_unit','z_reward_posting_published_source','app.reward_posting_published_source_guard()'::regprocedure,19,false),
   ('app.reward_post_native_context','rewards_post_native_effect','app.reward_post_native_validate()'::regprocedure,5,true),
   ('app.reward_post_native_context','rewards_post_native_completed','app.reward_post_native_validate()'::regprocedure,17,true)
 )
 SELECT has_function_privilege('ai_hr_app','app.reward_post_review(uuid,integer,uuid)','EXECUTE')
  AND NOT has_function_privilege('ai_hr_app','app.reward_post_command(uuid,integer,uuid)','EXECUTE')
  AND NOT has_function_privilege('ai_hr_app','app.reward_post_receipt_command(uuid,integer,uuid)','EXECUTE')
  AND NOT has_function_privilege('ai_hr_app','app.reward_post_sources(uuid,integer,uuid)','EXECUTE')
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
REVOKE ALL ON FUNCTION app.rewards_posting_bindings_complete() FROM PUBLIC,ai_hr_app;
