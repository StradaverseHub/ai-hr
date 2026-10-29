-- WP13 (architecture review R18; ADR-0151 §4.4-4.5): the first Automatic-tier registry entries, run only by the
-- tenant's named agent principal (0672). All deterministic and template-only: no model call, no spend.
--   (a) approval chasers: an overdue pending claim, attendance correction or replacement-leave request is
--       chased to its current approver (generalising the leave escalation sweep, core/leave-escalation.ts);
--   (b) review chasers: a probation, contract or internship review still undecided after its end date is
--       chased to the stage owner (the manager, or HR). The reminders BEFORE the end date stay the existing
--       engine job (core/employment-review.ts sweepReviewReminders) and are not duplicated here.
-- The chasers make no model call, so they never enter AI admission: app._ai_control_context is not touched here.
-- A chaser only appends a stamped reminder event; the notification registry turns it into a bell entry after
-- re-checking that the item is still waiting. Nothing here approves, rejects, submits or changes any HR record.
-- Claimed as 0697 / when 1793330000023 / final idx 687 for the AI architecture programme (29 Oct 2026).
--
-- 1. Registry reference rows (lib/ai/agent-action-registry.ts). No review store row: review_kind is NULL.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
('approvals.claim.chase','approvals','automatic','chaser',NULL),
('approvals.attendance.chase','approvals','automatic','chaser',NULL),
('approvals.toil.chase','approvals','automatic','chaser',NULL),
('employees.review_overdue.remind','employees','automatic','reminder',NULL);
--> statement-breakpoint
-- 2. The principal may read its own chase receipts (cooldown and per-item cap) and who switched each of its
-- four specialists on or off. Replaces 0672's policy with the same rule plus the new types and keys.
DROP POLICY domain_event_agent_read ON public.domain_event;
--> statement-breakpoint
CREATE POLICY domain_event_agent_read ON public.domain_event FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL AND (event_type='readiness.nudge-raised'
  OR (event_type IN ('automatic-chase.approval-raised','automatic-chase.review-raised') AND aggregate_type='automatic-chase'
   AND actor_type='agent' AND actor_id=app.current_agent_principal())
  OR (event_type='tenant-setting.changed' AND aggregate_type='tenant-setting' AND aggregate_id=tenant_id
   AND payload->>'key' IN ('notifications.readiness_nudge_enabled','claims.input_triage_enabled',
    'notifications.approval_chasers_enabled','notifications.review_chasers_enabled'))));
--> statement-breakpoint
-- 3. Every agent effect stays attributable. Replaces 0672's restrictive check with the same rule plus the two
-- chase event types and the two specialists. A chase must name the specialist it runs under.
DROP POLICY domain_event_agent_stamp ON public.domain_event;
--> statement-breakpoint
CREATE POLICY domain_event_agent_stamp ON public.domain_event AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK (app.current_agent_principal() IS NULL OR (
  actor_type='agent' AND actor_id=app.current_agent_principal()
  AND (event_type IN ('orchestrator.readiness-checked','orchestrator.pass-finished','readiness.nudge-raised')
   OR event_type ~ '^orchestrator\.case-(needs_input|needs_review|verified|inactive|reopened)$'
   OR (event_type='automatic-chase.approval-raised' AND aggregate_type='automatic-chase'
    AND payload->>'action' IN ('approvals.claim.chase','approvals.attendance.chase','approvals.toil.chase')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'agent'->'enabledBy')='array' THEN payload->'agent'->'enabledBy' ELSE '[]'::jsonb END) x
     WHERE x->>'feature'='approval_chasers'))
   OR (event_type='automatic-chase.review-raised' AND aggregate_type='automatic-chase'
    AND payload->>'action'='employees.review_overdue.remind'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'agent'->'enabledBy')='array' THEN payload->'agent'->'enabledBy' ELSE '[]'::jsonb END) x
     WHERE x->>'feature'='review_chasers')))
  AND jsonb_typeof(payload->'agent')='object'
  AND payload->'agent'->>'principalId'=actor_id::text
  AND jsonb_typeof(payload->'agent'->'enabledBy')='array'
  AND jsonb_array_length(payload->'agent'->'enabledBy')>0
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'agent'->'enabledBy') x
   WHERE jsonb_typeof(x)<>'object' OR x->>'feature' NOT IN ('readiness_reminders','claims_triage','approval_chasers','review_chasers')
    OR coalesce(x->>'userId','') !~ '^[0-9a-f-]{36}$' OR coalesce(x->>'eventId','') !~ '^[0-9a-f-]{36}$')));
--> statement-breakpoint
-- 4. Overdue-approval source for the principal: ids, the subject's employment and company, the current
-- stage and when the item reached that stage. Never an amount, reason, description, name or decision note.
-- The clock is the latest of submission and any earlier stage or participant decision (the request reached
-- this approver then), mirroring the leave escalation's clock.
CREATE FUNCTION app.agent_overdue_approvals(p_kind text,p_waiting_before timestamptz,p_item_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT 500)
 RETURNS TABLE(item_id uuid,subject_employment_id uuid,subject_company_id uuid,stage text,waiting_since timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
#variable_conflict use_column
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL OR app.current_agent_principal() IS NULL THEN RAISE EXCEPTION 'Agent source unavailable' USING ERRCODE='42501';END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('claim','attendance_correction','replacement_leave') OR p_waiting_before IS NULL
  OR p_limit IS NULL OR p_limit<1 OR p_limit>2000 THEN RAISE EXCEPTION 'Invalid agent source request' USING ERRCODE='22023';END IF;
 IF p_kind='claim' THEN
  RETURN QUERY SELECT q.i1,q.i2,q.i3,q.i4,q.i5 FROM (
   SELECT c.id AS i1,c.employment_id AS i2,e.company_id AS i3,'pending'::text AS i4,
    coalesce((SELECT max(v.occurred_at) FROM public.domain_event v WHERE v.tenant_id=t AND v.aggregate_type='claim-request'
     AND v.aggregate_id=c.id AND v.event_type='claim-request.submitted'),c.created_at) AS i5
   FROM public.claim_request c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=t
   WHERE c.tenant_id=t AND c.status='pending' AND (p_item_ids IS NULL OR c.id=ANY(p_item_ids))) q
  WHERE q.i5<p_waiting_before ORDER BY q.i5,q.i1 LIMIT p_limit;
 ELSIF p_kind='attendance_correction' THEN
  RETURN QUERY SELECT q.i1,q.i2,q.i3,q.i4,q.i5 FROM (
   -- Stage = level and the number of participant decisions already recorded at it, so the next participant of a
   -- sequential level is a new stage with its own cooldown and cap.
   SELECT a.id AS i1,a.employment_id AS i2,e.company_id AS i3,
    coalesce(r.current_stage,0)::text||'.'||(SELECT count(*) FROM public.attendance_workflow_participant_decision z
     WHERE z.request_id=r.id AND z.tenant_id=t AND z.stage_index=r.current_stage)::text AS i4,
    greatest(a.created_at,
     (SELECT max(x.decided_at) FROM public.attendance_workflow_decision x WHERE x.request_id=r.id AND x.tenant_id=t),
     (SELECT max(y.decided_at) FROM public.attendance_workflow_participant_decision y WHERE y.request_id=r.id AND y.tenant_id=t)) AS i5
   FROM public.attendance_correction a JOIN public.employment e ON e.id=a.employment_id AND e.tenant_id=t
   LEFT JOIN public.attendance_workflow_request r ON r.correction_id=a.id AND r.tenant_id=t
   WHERE a.tenant_id=t AND a.status='pending' AND (p_item_ids IS NULL OR a.id=ANY(p_item_ids))) q
  WHERE q.i5<p_waiting_before ORDER BY q.i5,q.i1 LIMIT p_limit;
 ELSE
  RETURN QUERY SELECT q.i1,q.i2,q.i3,q.i4,q.i5 FROM (
   SELECT r.id AS i1,r.employment_id AS i2,e.company_id AS i3,'pending'::text AS i4,r.created_at AS i5
   FROM public.replacement_leave_request r JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=t
   WHERE r.tenant_id=t AND r.status='pending' AND (p_item_ids IS NULL OR r.id=ANY(p_item_ids))) q
  WHERE q.i5<p_waiting_before ORDER BY q.i5,q.i1 LIMIT p_limit;
 END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.agent_overdue_approvals(text,timestamptz,uuid[],integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.agent_overdue_approvals(text,timestamptz,uuid[],integer) TO ai_hr_app;
--> statement-breakpoint
-- 5. Overdue-review source for the principal: open reviews whose end date is on or before the given date, for
-- employments that have not ended and have no pending resignation (the exclusions sweepDueReviews uses).
-- Ids, type, stage and end date only; never the evaluation, recommendation or decision.
CREATE FUNCTION app.agent_overdue_employment_reviews(p_end_on_or_before date,p_review_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT 500)
 RETURNS TABLE(review_id uuid,subject_employment_id uuid,subject_company_id uuid,review_type text,stage text,end_date date)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
#variable_conflict use_column
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL OR app.current_agent_principal() IS NULL THEN RAISE EXCEPTION 'Agent source unavailable' USING ERRCODE='42501';END IF;
 IF p_end_on_or_before IS NULL OR p_limit IS NULL OR p_limit<1 OR p_limit>2000 THEN RAISE EXCEPTION 'Invalid agent source request' USING ERRCODE='22023';END IF;
 RETURN QUERY SELECT r.id,r.employment_id,e.company_id,r.review_type::text,r.status::text,r.end_date
 FROM public.employment_review r JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=t
 WHERE r.tenant_id=t AND r.status::text IN ('pending_manager','pending_hr') AND r.end_date<=p_end_on_or_before
  AND e.terminated_on IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.resignation_request s WHERE s.employment_id=r.employment_id AND s.tenant_id=t AND s.status::text='pending')
  AND (p_review_ids IS NULL OR r.id=ANY(p_review_ids))
 ORDER BY r.end_date,r.id LIMIT p_limit;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.agent_overdue_employment_reviews(date,uuid[],integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.agent_overdue_employment_reviews(date,uuid[],integer) TO ai_hr_app;
--> statement-breakpoint
-- 6. Who can act NOW on a participant-routed (v3/v4) attendance request, for the chase notification. Reuses the
-- workflow's own outstanding rule (app.attendance_workflow_v3_outstanding, 0592): in a sequential level only the
-- next undecided participant; in any-one or all-required levels every undecided participant. Slots, kinds and
-- employment ids only, for an administrator of the request's company (the nightly projection's scope).
CREATE FUNCTION app.attendance_chase_outstanding(p_correction uuid)
 RETURNS TABLE(participant_slot text,participant_kind text,participant_employment_id uuid)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
#variable_conflict use_column
DECLARE w public.attendance_workflow_request; a jsonb;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r
 WHERE r.correction_id=p_correction AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND OR w.current_stage>=jsonb_array_length(w.stages) OR app.is_admin_for(w.company_id) IS NOT TRUE THEN RETURN; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(app.attendance_workflow_v3_effective(w.id,w.current_stage)) LOOP
  IF app.attendance_workflow_v3_outstanding(w.id,w.current_stage,a->>'slot') THEN
   RETURN QUERY SELECT a->>'slot',a->>'kind',
    CASE WHEN coalesce(a->>'employmentId','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN (a->>'employmentId')::uuid END;
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_chase_outstanding(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.attendance_chase_outstanding(uuid) TO ai_hr_app;
--> statement-breakpoint
-- 7. Outcome measurement (ADR-0151 §4.6c, beside 0674): counts per chaser kind for the caller's administered
-- companies. "acted" means the chased item is no longer waiting at the chased stage now; it is an observation,
-- not a claim that the reminder caused it. Counts only: no item, person, amount or recipient leaves.
CREATE FUNCTION app.automatic_chase_outcome_summary(p_from timestamptz)
 RETURNS TABLE(action_id text,chased integer,items integer,acted integer,waiting integer,first_chased_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
#variable_conflict use_column
DECLARE t uuid:=app.current_tenant_id();at_time timestamptz:=clock_timestamp();
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL OR p_from IS NULL OR p_from>at_time
  OR app.principal_snapshot_current() IS NOT TRUE OR app.is_admin() IS NOT TRUE THEN
  RAISE EXCEPTION 'Outcome summary unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY
 WITH scoped AS (
  SELECT d.payload->>'action' AS k,d.aggregate_id AS item,d.payload->>'stage' AS stage,d.occurred_at AS seen_at
  FROM public.domain_event d JOIN public.employment e ON e.id=d.subject_employment_id AND e.tenant_id=t
  WHERE d.tenant_id=t AND d.aggregate_type='automatic-chase' AND d.actor_type='agent'
   AND d.event_type IN ('automatic-chase.approval-raised','automatic-chase.review-raised')
   AND app.is_admin_for(e.company_id)),
 firsts AS (SELECT s.k,min(s.seen_at) AS f FROM scoped s GROUP BY s.k),
 -- One row per chased (item, stage) in the window, judged against the native record now.
 win AS (
  SELECT s.k,s.item,s.stage,
   CASE s.k
    WHEN 'approvals.claim.chase' THEN EXISTS(SELECT 1 FROM public.claim_request q WHERE q.id=s.item AND q.tenant_id=t AND q.status='pending')
    WHEN 'approvals.toil.chase' THEN EXISTS(SELECT 1 FROM public.replacement_leave_request q WHERE q.id=s.item AND q.tenant_id=t AND q.status='pending')
    WHEN 'approvals.attendance.chase' THEN EXISTS(SELECT 1 FROM public.attendance_correction q
     LEFT JOIN public.attendance_workflow_request r ON r.correction_id=q.id AND r.tenant_id=t
     WHERE q.id=s.item AND q.tenant_id=t AND q.status='pending' AND coalesce(r.current_stage,0)::text||'.'||(SELECT count(*)
      FROM public.attendance_workflow_participant_decision z WHERE z.request_id=r.id AND z.tenant_id=t AND z.stage_index=r.current_stage)::text=s.stage)
    WHEN 'employees.review_overdue.remind' THEN EXISTS(SELECT 1 FROM public.employment_review q WHERE q.id=s.item AND q.tenant_id=t AND q.status::text=s.stage)
    ELSE true END AS still
  FROM (SELECT DISTINCT k,item,stage FROM scoped WHERE seen_at>=p_from AND seen_at<=at_time) s),
 sent AS (SELECT s.k,count(*)::int AS n FROM scoped s WHERE s.seen_at>=p_from AND s.seen_at<=at_time GROUP BY s.k)
 SELECT f.k,coalesce(sent.n,0),count(w.k)::int,count(*) FILTER (WHERE w.still=false)::int,count(*) FILTER (WHERE w.still)::int,f.f
 FROM firsts f LEFT JOIN sent ON sent.k=f.k LEFT JOIN win w ON w.k=f.k GROUP BY f.k,f.f,sent.n ORDER BY f.k;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automatic_chase_outcome_summary(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automatic_chase_outcome_summary(timestamptz) TO ai_hr_app;
