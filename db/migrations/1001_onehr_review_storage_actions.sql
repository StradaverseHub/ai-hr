-- Raw review reads retain an independently authorized task or administrative
-- course. Explicit page projections still select and check just one course.
ALTER POLICY onehr_review_read ON public.performance_onehr_review
 USING (
  tenant_id=app.current_tenant_id() AND (
   app.onehr_review_task_view(review_id,'self')
   OR app.onehr_review_task_view(review_id,'assigned')
   OR app.onehr_review_administration(review_id)
  )
 );
--> statement-breakpoint
DO $review$
DECLARE body text;
 anchor text:=' IF administrative AND NOT app.financial_onehr_result_admin(NEW.review_id) THEN RAISE EXCEPTION';
BEGIN
 body:=pg_get_functiondef('app.financial_onehr_administrative_delta_guard()'::regprocedure);
 IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'OneHR administrative source guard changed';
 END IF;
 EXECUTE replace(body,anchor,
  E' IF administrative AND (NOT app.financial_onehr_result_admin(NEW.review_id)\n'
  ||E'  OR TG_OP=''UPDATE'' AND TG_TABLE_NAME=''performance_onehr_review'' AND NOT app.onehr_review_administration_edit(NEW.review_id)) THEN RAISE EXCEPTION');
END $review$;
--> statement-breakpoint
CREATE FUNCTION app.financial_onehr_review_course_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE course text;key text;self_delta boolean;assigned_delta boolean;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF (NEW.tenant_id,NEW.review_id,NEW.employment_id,NEW.company_id,NEW.cycle_id)
  IS DISTINCT FROM (OLD.tenant_id,OLD.review_id,OLD.employment_id,OLD.company_id,OLD.cycle_id) THEN
  RAISE EXCEPTION 'OneHR review source is immutable' USING ERRCODE='42501';
 END IF;

 self_delta:=(NEW.results_submitted_at,NEW.self_remark,NEW.competency_self_sections,NEW.competency_self_remark,NEW.submitted_proof)
  IS DISTINCT FROM (OLD.results_submitted_at,OLD.self_remark,OLD.competency_self_sections,OLD.competency_self_remark,OLD.submitted_proof);
 assigned_delta:=(NEW.competency_manager_sections,NEW.competency_manager_remark,NEW.manager_remark,NEW.manager_remark_by_user_id)
  IS DISTINCT FROM (OLD.competency_manager_sections,OLD.competency_manager_remark,OLD.manager_remark,OLD.manager_remark_by_user_id);
 IF NOT self_delta AND NOT assigned_delta
  AND (NEW.kpis,NEW.manager_performance,NEW.manager_score,NEW.competencies,NEW.competency_status)
  IS NOT DISTINCT FROM (OLD.kpis,OLD.manager_performance,OLD.manager_score,OLD.competencies,OLD.competency_status) THEN
  RETURN NEW;
 END IF;
 PERFORM app.audit_access_order_lock_for(OLD.tenant_id);
 PERFORM app.access_workforce_write_lock();
 course:=app.financial_onehr_review_course_for(OLD.tenant_id,app.current_user_id(),OLD.review_id);
 IF course='self' AND NOT assigned_delta THEN
  key:='performance.onehr.selfReview';
 ELSIF course='assigned' AND NOT self_delta THEN
  key:='performance.onehr.assignedReview';
 ELSIF app.financial_onehr_result_admin(OLD.review_id) THEN
  key:='performance.onehr.reviewAdministration';
 ELSE
  RAISE EXCEPTION 'OneHR review source course unavailable' USING ERRCODE='42501';
 END IF;

 IF NOT app.function_action_allowed(key,'view',OLD.company_id)
  OR NOT app.function_action_allowed(key,'edit',OLD.company_id) THEN
  RAISE EXCEPTION 'OneHR review action unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.financial_onehr_review_course_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER z_financial_onehr_review_course BEFORE UPDATE ON public.performance_onehr_review
 FOR EACH ROW EXECUTE FUNCTION app.financial_onehr_review_course_guard();
