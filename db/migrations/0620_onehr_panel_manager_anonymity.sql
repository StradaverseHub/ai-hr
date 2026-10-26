-- D-TM-01 (P1, anonymity). Through the manager arm of onehr_panel_read (latest definition: 0529 l.173),
-- a subject's line manager could SELECT every performance_onehr_panel row of the report's review as the
-- application role, at any submission count including below the anonymity minimum. Each row carries the
-- rater's identity together with their raw answers, remark and principle comments.
--
-- A manager still assigns and monitors the panel, so membership stays readable, but only through
-- app.onehr_manager_panel. That definer projection returns request, rater employment, relationship and the
-- submitted/archived/reset state, never answers, remark or principle_comments. Membership changes for
-- unsubmitted raters go through app.onehr_manager_panel_member, which writes archived_at and relationship only.
--
-- Unchanged, exactly as 0529 l.173/174/177: the tenant pin; the subject exclusion (nobody, administrators
-- included, reads or updates rows about their own review); the scoped cycle-administrator arm; the rater's
-- own live card (app.onehr_feedback_card) and own-row WITH CHECK; and onehr_panel_insert, through which a
-- manager still nominates raters (no RETURNING, so no SELECT visibility is needed).
--
-- onehr_panel_update loses the same manager arm. Every application UPDATE has a WHERE clause, so it already
-- needs SELECT visibility of the row, which managers no longer have. The arm could therefore serve only blind
-- updates of rater content in rows the manager can no longer read.
ALTER POLICY onehr_panel_read ON performance_onehr_panel USING(tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM employment sub WHERE sub.id=subject_employment_id AND app.is_self_person(sub.person_id)) AND (app.onehr_cycle_admin((SELECT cycle_id FROM performance_review WHERE id=review_id)) OR app.onehr_feedback_card(request_id) IS NOT NULL));
--> statement-breakpoint
ALTER POLICY onehr_panel_update ON performance_onehr_panel USING(tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM employment sub WHERE sub.id=subject_employment_id AND app.is_self_person(sub.person_id)) AND (app.onehr_cycle_admin((SELECT cycle_id FROM performance_review WHERE id=review_id)) OR app.onehr_feedback_card(request_id) IS NOT NULL)) WITH CHECK(tenant_id=app.current_tenant_id() AND (app.onehr_cycle_admin((SELECT cycle_id FROM performance_review WHERE id=review_id)) OR EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=peer_employment_id AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))));
--> statement-breakpoint
-- Panel membership for the subject's live line manager only. Archived members are included because the
-- manager's assignment writer restores them; the service hides them from the manager's screen.
CREATE FUNCTION app.onehr_manager_panel(wanted_review uuid)
RETURNS TABLE(request_id uuid,peer_employment_id uuid,relationship text,submitted_at timestamptz,archived_at timestamptz,reset_at timestamptz,archive_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT a.request_id,a.peer_employment_id,a.relationship,a.submitted_at,a.archived_at,a.reset_at,a.archive_reason
 FROM public.performance_onehr_panel a
 WHERE a.review_id=wanted_review AND a.tenant_id=app.current_tenant_id() AND app.onehr_manager(a.review_id)
  AND NOT EXISTS(SELECT 1 FROM public.employment sub WHERE sub.id=a.subject_employment_id AND sub.tenant_id=a.tenant_id AND app.is_self_person(sub.person_id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_manager_panel(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_manager_panel(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The manager's only panel UPDATE: archive or restore an unsubmitted member and set its relationship label.
-- Submitted members, answers, remarks, comments, reset and archive reasons stay with scoped HR and the rater.
CREATE FUNCTION app.onehr_manager_panel_member(wanted_request uuid,wanted_archived boolean,wanted_relationship text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE public.performance_onehr_panel a
  SET archived_at=CASE WHEN wanted_archived THEN coalesce(a.archived_at,now()) END,
      relationship=coalesce(wanted_relationship,a.relationship)
  WHERE a.request_id=wanted_request AND a.tenant_id=app.current_tenant_id() AND a.submitted_at IS NULL
   AND app.onehr_manager(a.review_id)
   AND NOT EXISTS(SELECT 1 FROM public.employment sub WHERE sub.id=a.subject_employment_id AND sub.tenant_id=a.tenant_id AND app.is_self_person(sub.person_id));
 IF NOT FOUND THEN RAISE EXCEPTION 'Panel member is not available to this manager' USING ERRCODE='insufficient_privilege'; END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_manager_panel_member(uuid,boolean,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_manager_panel_member(uuid,boolean,text) TO ai_hr_app;
