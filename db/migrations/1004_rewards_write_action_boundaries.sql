-- Keep the native recommendation guard and repeat the published exact ceiling
-- for direct table writers as well as fixed command callers.
CREATE FUNCTION app.reward_recommendation_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source_company uuid;
BEGIN
 IF app.access_workforce_storage_owner() OR NEW.recommendation IS NOT DISTINCT FROM OLD.recommendation THEN RETURN NEW; END IF;
 SELECT unit.company_id INTO source_company FROM public.reward_unit unit
 WHERE unit.id=OLD.unit_id AND unit.tenant_id=OLD.tenant_id;
 IF source_company IS NULL
  OR NOT app.function_action_allowed('rewards.entries','view',source_company)
  OR NOT app.function_action_allowed('rewards.entries','edit',source_company)
 THEN RAISE EXCEPTION 'Reward entry editing unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.reward_recommendation_action_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER reward_recommendation_action BEFORE UPDATE ON public.reward_entry
 FOR EACH ROW EXECUTE FUNCTION app.reward_recommendation_action_guard();
--> statement-breakpoint
-- Map the actual saved transition. Cancellation advances the revision while
-- off-cycle withdrawal keeps it. Existing native admission remains required.
CREATE FUNCTION app.reward_unit_transition_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE action_key text; operation text:='execute';
BEGIN
 IF app.access_workforce_storage_owner() OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 action_key:=CASE
  WHEN NEW.status='posted' THEN 'rewards.posting'
  WHEN NEW.status='withdrawn' AND NEW.revision=OLD.revision+1 THEN
   CASE WHEN 'gr'=ANY(ARRAY(SELECT app.reward_roles(OLD.id)))
    THEN 'rewards.cancellation.assigned' ELSE 'rewards.cancellation.administration' END
  WHEN NEW.status='withdrawn' THEN 'rewards.decisions.withdraw'
  WHEN NEW.status='rejected' THEN 'rewards.decisions.reject'
  WHEN NEW.status='draft' THEN 'rewards.decisions.return'
  WHEN OLD.status='draft' THEN 'rewards.decisions.submit'
  ELSE 'rewards.decisions.approve'
 END;
 IF action_key='rewards.decisions.approve' THEN operation:='approve'; END IF;
 IF NOT app.function_action_allowed(action_key,'view',OLD.company_id)
  OR NOT app.function_action_allowed(action_key,operation,OLD.company_id)
 THEN RAISE EXCEPTION 'Reward review transition unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.reward_unit_transition_action_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER reward_unit_transition_action BEFORE UPDATE ON public.reward_unit
 FOR EACH ROW EXECUTE FUNCTION app.reward_unit_transition_action_guard();
