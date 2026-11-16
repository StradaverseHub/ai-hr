-- AP-033: metadata discovery is a read. Preserve its exact principal, person, kind, history
-- and ordering rules; share Access with ordinary readers/writers and exclude configuration editors.
-- No retirement/confirmation owner, private body, grant or source command changes.
CREATE OR REPLACE FUNCTION app.assistant_legacy_reviews_index(p_kind text)
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();at_time timestamptz;live boolean;p uuid;
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR p_kind IS NULL OR p_kind NOT IN ('leave.apply','notifications.email_preferences.save','ess.profile.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','system_testing.execution.save') THEN
  RAISE EXCEPTION 'Review index unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
 SELECT true,a.person_id INTO live,p FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id);
 IF app.principal_snapshot_current() IS NOT TRUE OR live IS NOT TRUE THEN
  RAISE EXCEPTION 'Review index unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=t AND r.user_id=u AND r.person_id IS NOT DISTINCT FROM p AND r.action_kind=p_kind
   -- Preserve original per-kind history windows; neither reader widens private source disclosure.
   AND (p_kind IN ('system_testing.execution.save','claims.submit') OR (r.created_at>=at_time-interval '30 days' AND r.created_at<=at_time))
  ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_legacy_reviews_index(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_legacy_reviews_index(text) TO ai_hr_app;
