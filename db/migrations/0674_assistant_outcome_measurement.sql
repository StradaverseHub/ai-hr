-- ADR-0151 §4.6c: outcome measurement per Assistant action kind. Claimed as 0674 (when 1793240000000) with the
-- active sessions on 29 Oct 2026; the journal index is assigned at journaling.
--
-- The prepared-action store is closed to ai_hr_app (0622 revokes it; 0657 admits only non-app definers that
-- are administrators of the row's company). This adds ONE read-only definer that returns counts, never rows:
-- no names, amounts, reasons, digests, subjects or receipt ids leave the store. No table and no data change.
--
-- Scope: a row is counted when the caller administers its company; a row without a company (tenant-wide
-- kinds such as Knowledge Base or pay components) only for a group administrator. "Reversed" is reported
-- only where the canonical row or event proves it, and is NULL (not zero) for every other kind.
CREATE FUNCTION app.assistant_action_outcome_summary(p_from timestamptz)
 RETURNS TABLE(action_kind text,prepared integer,awaiting integer,completed integer,discarded integer,
  expired integer,refused integer,reversed integer,first_prepared_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();g boolean;at_time timestamptz:=clock_timestamp();
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL OR p_from IS NULL OR p_from>at_time
  OR app.principal_snapshot_current() IS NOT TRUE OR app.is_admin() IS NOT TRUE THEN
  RAISE EXCEPTION 'Outcome summary unavailable' USING ERRCODE='42501';END IF;
 g:=app.is_group_admin();
 RETURN QUERY
 WITH scoped AS (
  SELECT r.* FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=t AND CASE WHEN r.company_id IS NULL THEN g ELSE app.is_admin_for(r.company_id) END),
 -- All-time first preparation in scope: the "after" boundary of the process before/after comparison.
 firsts AS (SELECT s.action_kind AS k,min(s.created_at) AS f FROM scoped s GROUP BY s.action_kind),
 win AS (
  SELECT s.action_kind AS k,s.state,s.expires_at,
   CASE WHEN s.state<>'completed' THEN false
    -- A submission that did not stand: the native request was later rejected or cancelled.
    WHEN s.action_kind='leave.apply' THEN EXISTS(SELECT 1 FROM public.leave_request q
     WHERE q.id=s.leave_request_id AND q.tenant_id=t AND q.status::text IN ('rejected','cancelled'))
    WHEN s.action_kind='claims.submit' THEN EXISTS(SELECT 1 FROM public.claim_request q
     WHERE q.id=s.claim_submission_id AND q.tenant_id=t AND q.status::text IN ('rejected','cancelled'))
    WHEN s.action_kind='attendance.correction.request' THEN EXISTS(SELECT 1 FROM public.attendance_correction q
     WHERE q.id=s.attendance_correction_id AND q.tenant_id=t AND q.status::text IN ('rejected','cancelled'))
    WHEN s.action_kind='ess.profile.request' THEN EXISTS(SELECT 1 FROM public.profile_change_request q
     WHERE q.id=s.profile_request_id AND q.tenant_id=t AND q.status::text='rejected')
    -- An edit that did not stand: the same leave was edited again or withdrawn after the Assistant's edit.
    WHEN s.action_kind='leave.edit' THEN EXISTS(SELECT 1 FROM public.domain_event receipt
     JOIN public.domain_event later ON later.tenant_id=receipt.tenant_id AND later.aggregate_type='leave-request'
      AND later.aggregate_id=receipt.aggregate_id AND later.id<>receipt.id AND later.occurred_at>receipt.occurred_at
      AND later.event_type IN ('leave-request.edited','leave-request.self-cancelled','leave-request.cancelled')
     WHERE receipt.id=s.receipt_event_id AND receipt.tenant_id=t AND receipt.aggregate_id=s.receipt_subject_id)
    ELSE false END AS rev
  FROM scoped s WHERE s.created_at>=p_from AND s.created_at<=at_time)
 SELECT f.k,count(w.k)::int,
  count(*) FILTER (WHERE w.state='awaiting_confirmation' AND w.expires_at>at_time)::int,
  count(*) FILTER (WHERE w.state='completed')::int,
  count(*) FILTER (WHERE w.state='discarded')::int,
  -- A review past its expiry that no sweep has closed yet is expired, not awaiting.
  count(*) FILTER (WHERE w.state='expired' OR (w.state='awaiting_confirmation' AND w.expires_at<=at_time))::int,
  count(*) FILTER (WHERE w.state='refused')::int,
  CASE WHEN f.k IN ('leave.apply','claims.submit','attendance.correction.request','ess.profile.request','leave.edit')
   THEN count(*) FILTER (WHERE w.rev)::int END,
  f.f
 FROM firsts f LEFT JOIN win w ON w.k=f.k GROUP BY f.k,f.f ORDER BY f.k;
END $$;
REVOKE ALL ON FUNCTION app.assistant_action_outcome_summary(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_action_outcome_summary(timestamptz) TO ai_hr_app;
