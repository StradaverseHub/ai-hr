-- Draft authoring and sharing are the self-review Edit course. Reviewing,
-- progressing, acknowledging and reopening keep their existing sealed owners.
CREATE FUNCTION app.financial_onehr_own_plan_edit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF NOT app.onehr_self_employment(NEW.employment_id) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND (OLD.status<>'draft'
  OR (OLD.career,OLD.goals,OLD.status) IS NOT DISTINCT FROM (NEW.career,NEW.goals,NEW.status)) THEN
  RETURN NEW;
 END IF;

 IF NOT EXISTS (
  SELECT FROM public.performance_onehr_review review
  WHERE review.review_id=NEW.review_id AND review.tenant_id=NEW.tenant_id
   AND review.tenant_id=app.current_tenant_id() AND review.employment_id=NEW.employment_id
   AND app.function_action_allowed('performance.onehr.selfReview','view',review.company_id)
   AND app.function_action_allowed('performance.onehr.selfReview','edit',review.company_id)
 ) THEN RAISE EXCEPTION 'OneHR own plan editing unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.financial_onehr_own_plan_edit_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER z_financial_onehr_own_plan_edit BEFORE INSERT OR UPDATE ON public.performance_onehr_plan
 FOR EACH ROW EXECUTE FUNCTION app.financial_onehr_own_plan_edit_guard();
CREATE TRIGGER aaa_financial_onehr_own_plan_edit_access BEFORE INSERT OR UPDATE ON public.performance_onehr_plan
 FOR EACH STATEMENT EXECUTE FUNCTION app.module_configuration_write_lock();
