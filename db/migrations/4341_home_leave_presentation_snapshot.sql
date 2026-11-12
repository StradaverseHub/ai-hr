-- Home's three leave review lists only discover the current login's metadata.
-- The read snapshot covers identity, grants and rows without joining the
-- Access write interval. Reopen, confirmation, retention and audit keep their
-- existing command owners and require fresh authorization independently.
CREATE FUNCTION app.home_leave_presentation_index(p_kind text)
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $presentation$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();p uuid;at_time timestamptz;
BEGIN
 IF session_user<>'ai_hr_app' OR nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL
  OR t IS NULL OR u IS NULL OR p_kind IS NULL OR p_kind NOT IN ('leave.apply','leave.cancel','approvals.leave.decide')
  OR current_setting('transaction_isolation')<>'repeatable read' OR current_setting('transaction_read_only')<>'on'
  OR app.principal_snapshot_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Leave review index unavailable' USING ERRCODE='42501';
 END IF;
 SELECT a.person_id INTO p FROM public.app_user a
  WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id);
 -- Assigned decision discovery permits a person-less login, unlike the two own indices.
 -- Own application additionally proves the person still exists in the tenant.
 IF NOT FOUND OR (p_kind IN ('leave.apply','leave.cancel') AND p IS NULL)
  OR (p_kind='leave.apply' AND NOT EXISTS(SELECT 1 FROM public.person actual WHERE actual.id=p AND actual.tenant_id=t)) THEN
  RAISE EXCEPTION 'Leave review index unavailable' USING ERRCODE='42501';
 END IF;
 at_time:=clock_timestamp();
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=t AND r.user_id=u AND r.person_id IS NOT DISTINCT FROM p AND r.action_kind=p_kind
   AND (p_kind='approvals.leave.decide' OR (r.created_at>=at_time-interval '30 days' AND r.created_at<=at_time))
  ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END;
$presentation$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.home_leave_presentation_index(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_leave_presentation_index(text) TO ai_hr_app;
