-- The separate career-profile storage owner retains its empty assigned
-- placeholder and native period checks. Only actual content has an Edit course.
DO $career$
DECLARE body text;
 anchor text:=E' RETURN NEW;\nEND;';
BEGIN
 body:=pg_get_functiondef('app.financial_onehr_career_guard()'::regprocedure);
 IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'OneHR career source guard changed';
 END IF;
 EXECUTE replace(body,anchor,
  E' IF NOT placeholder AND (TG_OP=''INSERT'' OR NEW.career IS DISTINCT FROM OLD.career) THEN\n'
  ||E'  IF own_course THEN\n'
  ||E'   IF NOT EXISTS (SELECT FROM public.performance_onehr_review review WHERE review.review_id=NEW.review_id\n'
  ||E'    AND review.tenant_id=NEW.tenant_id AND review.employment_id=NEW.employment_id\n'
  ||E'    AND app.function_action_allowed(''performance.onehr.selfReview'',''view'',review.company_id)\n'
  ||E'    AND app.function_action_allowed(''performance.onehr.selfReview'',''edit'',review.company_id))\n'
  ||E'    THEN RAISE EXCEPTION ''OneHR own career editing unavailable'' USING ERRCODE=''42501''; END IF;\n'
  ||E'  ELSIF NOT app.onehr_review_administration_edit(NEW.review_id) THEN\n'
  ||E'   RAISE EXCEPTION ''OneHR administrative career editing unavailable'' USING ERRCODE=''42501'';\n'
  ||E'  END IF;\n END IF;\n'||anchor);
END $career$;
--> statement-breakpoint
CREATE FUNCTION app.onehr_review_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type) AS (
  VALUES
   ('performance_onehr_review','z_financial_onehr_review_course','app.financial_onehr_review_course_guard()'::regprocedure,19),
   ('performance_onehr_review','z_financial_onehr_administrative_delta_guard','app.financial_onehr_administrative_delta_guard()'::regprocedure,23),
   ('performance_onehr_plan','z_financial_onehr_own_plan_edit','app.financial_onehr_own_plan_edit_guard()'::regprocedure,23),
   ('performance_onehr_plan','z_financial_onehr_plan_review_guard','app.financial_onehr_plan_review_guard()'::regprocedure,23),
   ('performance_onehr_plan','z_financial_onehr_plan_progress_guard','app.financial_onehr_plan_progress_guard()'::regprocedure,19),
   ('performance_onehr_plan','z_financial_onehr_plan_reopen_guard','app.financial_onehr_plan_reopen_guard()'::regprocedure,19),
   ('performance_assessment_career_profile','z_financial_onehr_career_guard','app.financial_onehr_career_guard()'::regprocedure,23),
   ('performance_assessment_career_profile','z_financial_onehr_career_review_guard','app.financial_onehr_career_comment_guard()'::regprocedure,23),
   ('performance_assessment_draft','z_financial_onehr_draft_write_guard','app.financial_onehr_draft_write_guard()'::regprocedure,31)
 )
 SELECT NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable AND c.relrowsecurity
    AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 ) AND EXISTS (
  SELECT FROM pg_policy p WHERE p.polrelid='public.performance_onehr_review'::regclass
   AND p.polname='onehr_review_read' AND p.polcmd='r'
   AND EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=p.oid
    AND d.refclassid='pg_proc'::regclass AND d.refobjid='app.onehr_review_task_view(uuid,text)'::regprocedure)
   AND EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=p.oid
    AND d.refclassid='pg_proc'::regclass AND d.refobjid='app.onehr_review_administration(uuid)'::regprocedure)
 );
$$;
REVOKE ALL ON FUNCTION app.onehr_review_bindings_complete() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.financial_letter_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT app.letter_operations_bindings_complete()
  AND app.payroll_operations_bindings_complete()
  AND app.performance_cycle_bindings_complete()
  AND app.onehr_review_bindings_complete()
  AND app.onehr_plan_acknowledgement_bindings_complete()
  AND app.onehr_panel_feedback_bindings_complete();
$$;
REVOKE ALL ON FUNCTION app.financial_letter_bindings_complete() FROM PUBLIC,ai_hr_app;
