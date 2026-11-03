-- Direct company-administrative table paths retain their native RLS and
-- also enforce the company Lifecycle ceiling. Fixed task ports retain their
-- own subject, assignment and final-effect checks.
CREATE POLICY lifecycle_administrative_read ON public.lc_onboarding_case
 AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING (NOT app.is_admin_for(company_id) OR app.lifecycle_reward_notice_action('lifecycle','view',company_id));
CREATE POLICY lifecycle_administrative_read ON public.lc_onboarding_case_revision
 AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING (NOT app.is_admin_for(company_id) OR app.lifecycle_reward_notice_action('lifecycle','view',company_id));
CREATE POLICY lifecycle_administrative_read ON public.lc_onboarding_private
 AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING (app.lifecycle_reward_notice_action('lifecycle','view',company_id));
CREATE POLICY lifecycle_administrative_read ON public.lc_onboarding_private_revision
 AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING (app.lifecycle_reward_notice_action('lifecycle','view',company_id));
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_onboarding_administration_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation text:='edit';
BEGIN
 IF current_user<>'ai_hr_app' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='lc_onboarding_case' THEN
  operation:=CASE WHEN TG_OP='INSERT' THEN 'add'
   WHEN OLD.data->>'state' IS DISTINCT FROM 'cancelled' AND NEW.data->>'state'='cancelled' THEN 'delete'
   ELSE 'edit' END;
 END IF;
 IF TG_OP='UPDATE' AND app.is_admin_for(OLD.company_id)
  AND NOT app.lifecycle_reward_notice_action('lifecycle',operation,OLD.company_id) THEN
  RAISE EXCEPTION 'Onboarding administration action unavailable in the original company' USING ERRCODE='42501';
 END IF;
 IF app.is_admin_for(NEW.company_id)
  AND NOT app.lifecycle_reward_notice_action('lifecycle',operation,NEW.company_id) THEN
  RAISE EXCEPTION 'Onboarding administration action unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_onboarding_administration_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER lifecycle_administration_action BEFORE INSERT OR UPDATE ON public.lc_onboarding_case
 FOR EACH ROW EXECUTE FUNCTION app.lifecycle_onboarding_administration_guard();
CREATE TRIGGER lifecycle_administration_action BEFORE INSERT OR UPDATE ON public.lc_onboarding_private
 FOR EACH ROW EXECUTE FUNCTION app.lifecycle_onboarding_administration_guard();
