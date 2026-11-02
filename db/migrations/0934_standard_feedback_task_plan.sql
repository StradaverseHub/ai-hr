-- Reuse the standard personal-feedback selection plan under the actual caller's table RLS.
-- Same tenant/status/self/exclusion predicates and fields as the former service query.
-- No definer privilege, permission-result cache, source mutation or broader read scope.
CREATE FUNCTION app.standard_feedback_task_metadata(p_tenant uuid)
RETURNS TABLE(id uuid,subject_name text,source_updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 RETURN QUERY
 SELECT r.id,r.subject_name,r.created_at FROM public.peer_feedback_request r
 WHERE r.tenant_id=p_tenant AND r.status='pending'
  AND EXISTS(SELECT 1 FROM public.employment peer WHERE peer.id=r.peer_employment_id
   AND peer.tenant_id=r.tenant_id AND app.is_self_person(peer.person_id))
  AND NOT EXISTS(SELECT 1 FROM public.performance_onehr_panel panel WHERE panel.request_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM public.performance_review review
   JOIN public.performance_onehr_cycle cycle ON cycle.cycle_id=review.cycle_id WHERE review.id=r.review_id)
 ORDER BY r.created_at DESC,r.id;
END $fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.standard_feedback_task_metadata(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.standard_feedback_task_metadata(uuid) TO ai_hr_app;
