-- Provisional source reservation after foreign0952_teras_chats. No installation authority.
-- Fixed subject owners must prove a protected current-transaction intent and exact OLD/NEW values.
CREATE FUNCTION app.lifecycle_service_info_intent_allowed(p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE allowed boolean:=false;
BEGIN
 IF jsonb_typeof(p_old) IS DISTINCT FROM 'object' OR jsonb_typeof(p_new) IS DISTINCT FROM 'object'
 OR app.current_tenant_id() IS NULL OR p_old->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text
 OR p_new->>'tenant_id' IS DISTINCT FROM p_old->>'tenant_id' OR p_new->>'id' IS DISTINCT FROM p_old->>'id'
 OR p_new->>'company_id' IS DISTINCT FROM p_old->>'company_id' OR app.current_user_id() IS NULL
 OR app.principal_snapshot_current() IS NOT TRUE OR app.login_blocked(app.current_user_id()) THEN RETURN false;END IF;
 IF to_regprocedure('app.probation_service_info_intent_allowed(jsonb,jsonb)') IS NOT NULL THEN
  EXECUTE 'SELECT app.probation_service_info_intent_allowed($1,$2)' INTO allowed USING p_old,p_new;
  IF allowed IS TRUE THEN RETURN true;END IF;
 END IF;
 IF to_regprocedure('app.contract_service_info_intent_allowed(jsonb,jsonb)') IS NOT NULL THEN
  EXECUTE 'SELECT app.contract_service_info_intent_allowed($1,$2)' INTO allowed USING p_old,p_new;
  IF allowed IS TRUE THEN RETURN true;END IF;
 END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.lifecycle_service_info_intent_allowed(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_service_info_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM jsonb_each(to_jsonb(NEW)) d WHERE d.key=ANY(app.access_workforce_service_info_columns()) AND d.value IS DISTINCT FROM to_jsonb(OLD)->d.key)
 OR app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 IF OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
  RAISE EXCEPTION 'Workforce service information maintenance unavailable' USING ERRCODE='42501';END IF;
 IF NOT app.access_workforce_company(OLD.company_id,'workforce.maintain') OR NOT app.access_workforce_company(NEW.company_id,'workforce.maintain') THEN
  IF app.lifecycle_service_info_intent_allowed(to_jsonb(OLD),to_jsonb(NEW)) IS NOT TRUE THEN
   RAISE EXCEPTION 'Workforce service information maintenance unavailable' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.access_workforce_service_info_update() FROM PUBLIC,ai_hr_app;
