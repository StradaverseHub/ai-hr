CREATE FUNCTION app.reward_decide(p_unit uuid,p_revision integer,p_action text,p_reason text,p_acknowledged boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE key text:='rewards.decisions.'||p_action; operation text:=CASE WHEN p_action='approve' THEN 'approve' ELSE 'execute' END;
BEGIN
 IF p_action IS NULL OR p_action NOT IN ('submit','approve','return','reject','withdraw')
  OR NOT EXISTS (SELECT FROM public.access_capability WHERE id='function.'||key||'.'||operation AND supported)
 THEN RAISE EXCEPTION 'Reward decision command unavailable' USING ERRCODE='42501'; END IF;
 RETURN app.reward_decision_command(p_unit,p_revision,p_action,p_reason,p_acknowledged);
END;
$$;
REVOKE ALL ON FUNCTION app.reward_decide(uuid,integer,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_decide(uuid,integer,text,text,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_decision_published_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE command text; capability text; source public.reward_unit; native_effect boolean;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='reward_unit' THEN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status='posted'
   OR NEW.status='withdrawn' AND NEW.revision=OLD.revision+1 THEN RETURN NEW; END IF;
  command:=CASE WHEN NEW.status='draft' THEN 'return' WHEN NEW.status='rejected' THEN 'reject'
   WHEN NEW.status='withdrawn' THEN 'withdraw' WHEN OLD.status='draft' THEN 'submit' ELSE 'approve' END;
  capability:='function.rewards.decisions.'||command||CASE WHEN command='approve' THEN '.approve' ELSE '.execute' END;
  IF NOT EXISTS (SELECT FROM public.access_capability WHERE id=capability AND supported) THEN RETURN NEW; END IF;
  SELECT EXISTS (
   SELECT FROM app.reward_decision_native_effect effect WHERE effect.xact_id=pg_current_xact_id()
    AND effect.tenant_id=OLD.tenant_id AND effect.tenant_id=app.current_tenant_id()
    AND effect.user_id=app.current_user_id() AND effect.unit_id=OLD.id AND effect.active AND NOT effect.completed
    AND effect.admission->>'action'=command
    AND effect.admission->>'unitBeforeHash'=app.reward_decision_row_hash(to_jsonb(OLD),'reward_unit')
    AND app.reward_decision_unit_shape(effect.admission,to_jsonb(OLD),to_jsonb(NEW))
  ) INTO native_effect;
 ELSE
  command:=NEW.action;
  capability:='function.rewards.decisions.'||command||CASE WHEN command='approve' THEN '.approve' ELSE '.execute' END;
  IF NOT EXISTS (SELECT FROM public.access_capability WHERE id=capability AND supported) THEN RETURN NEW; END IF;
  IF command='withdraw' THEN
   -- Cancellation keeps its own separate decision and always updates the unit first.
   SELECT unit.* INTO source FROM public.reward_unit unit WHERE unit.id=NEW.unit_id
    AND unit.tenant_id=NEW.tenant_id AND unit.tenant_id=app.current_tenant_id()
    AND unit.status='withdrawn' AND unit.revision=NEW.revision+1
    AND unit.xmin::text=pg_current_xact_id()::xid::text;
   IF source.id IS NOT NULL AND NEW.actor_id=app.current_user_id() THEN RETURN NEW; END IF;
  END IF;
  SELECT EXISTS (
   SELECT FROM app.reward_decision_native_effect effect WHERE effect.xact_id=pg_current_xact_id()
    AND effect.tenant_id=NEW.tenant_id AND effect.tenant_id=app.current_tenant_id()
    AND effect.user_id=NEW.actor_id AND effect.user_id=app.current_user_id()
    AND effect.unit_id=NEW.unit_id AND effect.decision_id=NEW.id AND effect.active AND NOT effect.completed
    AND effect.admission->>'action'=NEW.action AND effect.admission->>'fromStage'=NEW.from_stage
    AND effect.admission->>'toStage'=NEW.to_stage
  ) INTO native_effect;
 END IF;
 IF native_effect IS NOT TRUE THEN
  RAISE EXCEPTION 'Published Reward decisions require their fixed command' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.reward_decision_published_source_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER z_reward_decision_published_source BEFORE UPDATE ON public.reward_unit
 FOR EACH ROW EXECUTE FUNCTION app.reward_decision_published_source_guard();
CREATE TRIGGER z_reward_decision_published_source BEFORE INSERT ON public.reward_decision
 FOR EACH ROW EXECUTE FUNCTION app.reward_decision_published_source_guard();
--> statement-breakpoint
CREATE FUNCTION app.rewards_decision_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH ports(signature,executable) AS (
  VALUES ('app.reward_decide(uuid,integer,text,text,boolean)',true),
   ('app.reward_decision_command(uuid,integer,text,text,boolean)',false),
   ('app.reward_decision_admission(uuid,integer,text,text,boolean)',false)
 ), guards(relation,trigger_name,handler,kind,deferred) AS (
  VALUES ('public.reward_unit','z_reward_decision_published_source','app.reward_decision_published_source_guard()'::regprocedure,19,false),
   ('public.reward_decision','z_reward_decision_published_source','app.reward_decision_published_source_guard()'::regprocedure,7,false),
   ('public.reward_unit','rewards_decision_native_capture','app.reward_decision_native_capture()'::regprocedure,17,false),
   ('public.reward_decision','rewards_decision_native_capture','app.reward_decision_native_capture()'::regprocedure,5,false),
   ('app.reward_decision_native_effect','rewards_decision_native_effect','app.reward_decision_native_validate()'::regprocedure,17,true)
 )
 SELECT NOT EXISTS (
  SELECT FROM ports e WHERE NOT EXISTS (
   SELECT FROM pg_proc p JOIN pg_class c ON c.oid='public.access_capability'::regclass
   WHERE p.oid=to_regprocedure(e.signature) AND p.proowner=c.relowner AND p.prosecdef
    AND has_function_privilege('ai_hr_app',p.oid,'EXECUTE')=e.executable
  )
 ) AND NOT EXISTS (
  SELECT FROM guards e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE c.oid=to_regclass(e.relation) AND c.relrowsecurity
    AND t.tgname=e.trigger_name AND t.tgfoid=e.handler AND t.tgtype=e.kind
    AND t.tgenabled IN ('O','A') AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.rewards_decision_bindings_complete() FROM PUBLIC,ai_hr_app;
