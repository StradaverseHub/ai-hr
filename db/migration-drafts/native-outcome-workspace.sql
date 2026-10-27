-- SOURCE ONLY fragment; apply AFTER private target-custody helpers in the ONE coordinated native outcome migration.
-- UNALLOCATED / UNJOURNALED / UNAPPLIED. Discovery remains nomination-only, never canonical proof.

--> statement-breakpoint
-- Own completed discovery only. The calling owner proves the selected governed job/modules first;
-- this function grants no native facts or permission to associate. Every record reopens its source.
CREATE FUNCTION app.native_outcome_completed_review_choices(p_kinds jsonb)
 RETURNS TABLE(action text,action_id uuid,created_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current()
 OR jsonb_typeof(p_kinds) IS DISTINCT FROM 'array' OR jsonb_array_length(p_kinds) NOT BETWEEN 1 AND 19
 THEN RAISE EXCEPTION 'Outcome choices unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_kinds) v WHERE jsonb_typeof(v)<>'string')
 OR (SELECT count(DISTINCT v) FROM jsonb_array_elements_text(p_kinds) v)<>jsonb_array_length(p_kinds)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_kinds) v WHERE v NOT IN
 ('org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save'))
 THEN RAISE EXCEPTION 'Outcome choices unavailable'; END IF;
 RETURN QUERY SELECT r.action_kind,r.id,r.created_at FROM app.assistant_own_leave_review r
 WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id()
 AND r.state='completed' AND r.action_kind IN(SELECT jsonb_array_elements_text(p_kinds))
 AND r.created_at<=now() AND r.created_at>now()-interval '30 days'
 AND app.native_outcome_capture_available(r.action_kind,r.id)
 ORDER BY r.created_at DESC,r.id DESC LIMIT 26;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_completed_review_choices(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_completed_review_choices(jsonb) TO ai_hr_app;
