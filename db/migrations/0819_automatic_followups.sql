-- PROVISIONAL 0700 / when1793330000026 / idx690. Final allocation is integration-freeze owned.
-- WP13 c/d/e: deterministic reminders, no model spend or HR fact/approval/task writer authority.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
('attendance.missing_clock.remind','attendance','automatic','reminder',NULL),
('employees.passport_expiry.remind','employees','automatic','reminder',NULL),
('lifecycle.step.chase','lifecycle','automatic','reminder',NULL);
--> statement-breakpoint
DROP POLICY domain_event_agent_read ON public.domain_event;
--> statement-breakpoint
CREATE POLICY domain_event_agent_read ON public.domain_event FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL AND (event_type='readiness.nudge-raised'
  OR (event_type IN ('automatic-chase.approval-raised','automatic-chase.review-raised','automatic-chase.followup-raised') AND aggregate_type='automatic-chase'
   AND actor_type='agent' AND actor_id=app.current_agent_principal())
  OR (event_type='tenant-setting.changed' AND aggregate_type='tenant-setting' AND aggregate_id=tenant_id
   AND payload->>'key' IN ('notifications.readiness_nudge_enabled','claims.input_triage_enabled',
    'notifications.approval_chasers_enabled','notifications.review_chasers_enabled','notifications.missing_clock_reminders_enabled','notifications.passport_expiry_reminders_enabled','notifications.lifecycle_step_chasers_enabled'))));
--> statement-breakpoint
-- Preserve attribution enforcement while adding only the closed follow-up event/action/source/stage shapes.
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
     WHERE x->>'feature'='review_chasers'))
   OR (event_type='automatic-chase.followup-raised' AND aggregate_type='automatic-chase'
    AND payload-ARRAY['action','source','stage','companyId','waitingOn','eligibleOn','chaseNumber','agent']='{}'::jsonb
    AND jsonb_typeof(payload->'chaseNumber')='number' AND payload->>'chaseNumber' ~ '^[1-4]$'
    AND payload->>'companyId' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND pg_input_is_valid(payload->>'waitingOn','date') AND pg_input_is_valid(payload->>'eligibleOn','date')
    AND ((payload->>'action'='attendance.missing_clock.remind' AND payload->>'source'='missing_clock' AND payload->>'stage' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND pg_input_is_valid(payload->>'stage','date'))
     OR (payload->>'action'='employees.passport_expiry.remind' AND payload->>'source'='passport_expiry' AND payload->>'stage' ~ '^passport:[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND pg_input_is_valid(substring(payload->>'stage' from 10),'date'))
     OR (payload->>'action'='lifecycle.step.chase' AND payload->>'source'='lifecycle_step' AND payload->>'stage' ~ '^[a-z][a-z0-9_]{0,39}:[0-9]{1,12}$'))
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'agent'->'enabledBy')='array' THEN payload->'agent'->'enabledBy' ELSE '[]'::jsonb END) x
     WHERE x->>'feature'=CASE payload->>'source' WHEN 'missing_clock' THEN 'clock_reminders' WHEN 'passport_expiry' THEN 'document_reminders' WHEN 'lifecycle_step' THEN 'lifecycle_chasers' END)))
  AND jsonb_typeof(payload->'agent')='object'
  AND payload->'agent'->>'principalId'=actor_id::text
  AND jsonb_typeof(payload->'agent'->'enabledBy')='array'
  AND jsonb_array_length(payload->'agent'->'enabledBy')>0
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'agent'->'enabledBy') x
   WHERE jsonb_typeof(x)<>'object' OR x->>'feature' NOT IN ('readiness_reminders','claims_triage','approval_chasers','review_chasers','clock_reminders','document_reminders','lifecycle_chasers')
    OR coalesce(x->>'userId','') !~ '^[0-9a-f-]{36}$' OR coalesce(x->>'eventId','') !~ '^[0-9a-f-]{36}$')));
--> statement-breakpoint

-- A fixed id/date/policy projection, not generic Personnel/Attendance/Lifecycle table access. Agent or
-- company administrator only. Ordinary notification projection reuses it to suppress stale notices.
CREATE FUNCTION app.automatic_followup_facts(p_source text,p_today date,p_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT 2000)
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL OR p_today IS NULL OR p_limit IS NULL OR p_limit<1 OR p_limit>2000
  OR p_source IS NULL OR p_source NOT IN ('missing_clock','passport_expiry','lifecycle_step') THEN RAISE EXCEPTION 'Follow-up source unavailable' USING ERRCODE='42501';END IF;
 IF p_source='missing_clock' THEN
  RETURN QUERY SELECT jsonb_build_object('itemId',e.id,'employmentId',e.id,'companyId',e.company_id,'stage',(p_today-1)::text,'waitingOn',(p_today-1)::text)
   FROM public.employment e
   WHERE e.tenant_id=t AND e.hired_on<=p_today-1 AND (e.terminated_on IS NULL OR e.terminated_on>p_today)
    AND (app.current_agent_principal() IS NOT NULL OR (app.is_admin_for(e.company_id) AND (app.current_user_id() IS NULL OR app.principal_snapshot_current())))
    AND (p_ids IS NULL OR e.id=ANY(p_ids))
    AND NOT EXISTS(SELECT 1 FROM public.attendance a WHERE a.employment_id=e.id AND a.tenant_id=t AND a.attendance_date=p_today-1 AND a.check_in_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM public.attendance_punch a WHERE a.employment_id=e.id AND a.tenant_id=t AND a.attendance_date=p_today-1 AND a.direction::text='in' AND a.voided_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.leave_request_date l WHERE l.subject_employment_id=e.id AND l.tenant_id=t AND l.leave_date=p_today-1 AND l.status::text IN ('pending','approved'))
    AND NOT EXISTS(SELECT 1 FROM public.attendance_correction a WHERE a.employment_id=e.id AND a.tenant_id=t AND a.attendance_date=p_today-1 AND a.status::text IN ('pending','approved'))
   ORDER BY e.id LIMIT p_limit;
 ELSIF p_source='passport_expiry' THEN
  RETURN QUERY SELECT jsonb_build_object('itemId',e.id,'employmentId',e.id,'companyId',e.company_id,'stage','passport:'||s.passport_expiry_date::text,'waitingOn',s.passport_expiry_date::text)
   FROM public.employment e JOIN public.employee_statutory_my s ON s.person_id=e.person_id AND s.tenant_id=t
   JOIN public.company c ON c.id=e.company_id AND c.tenant_id=t AND c.country::text='MY'
   WHERE e.tenant_id=t AND e.hired_on<=p_today AND (e.terminated_on IS NULL OR e.terminated_on>p_today)
    AND (app.current_agent_principal() IS NOT NULL OR (app.is_admin_for(e.company_id) AND (app.current_user_id() IS NULL OR app.principal_snapshot_current())))
    AND s.passport_expiry_date BETWEEN p_today AND p_today+30 AND (p_ids IS NULL OR e.id=ANY(p_ids))
   ORDER BY s.passport_expiry_date,e.id LIMIT p_limit;
 ELSE
  RETURN QUERY SELECT jsonb_build_object('itemId',c.id,'employmentId',e.id,'companyId',c.company_id,'kind',c.kind,'status',c.status,
   'laptopRequired',c.laptop_required,'carparkRequired',c.carpark_required,'outcome',c.outcome,
   'transitionAt',greatest(c.created_at,(SELECT max(h.at) FROM public.lc_history h WHERE h.tenant_id=t AND h.ref_type='case' AND h.ref_id=c.id AND h.action='case.edited' AND h.detail->'fields' ?| ARRAY['laptopRequired','carparkRequired']),(SELECT max(v.occurred_at) FROM public.domain_event v WHERE v.tenant_id=t AND v.aggregate_type='lifecycle-case' AND v.aggregate_id=c.id
    AND v.event_type IN ('lifecycle-case.step-done','lifecycle-case.step-undone','lifecycle-case.reopened','lifecycle-case.outcome-set','lifecycle-case.outcome-changed','lifecycle-case.owner-changed')),(SELECT max(v.occurred_at) FROM public.domain_event v WHERE v.tenant_id=t AND v.aggregate_type='lifecycle-config' AND v.event_type IN ('lifecycle-config.steps-saved','lifecycle-config.steps-reset','lifecycle-config.defaults-loaded') AND (v.payload->>'kind'=c.kind OR v.event_type='lifecycle-config.defaults-loaded'))),
   'defs',coalesce((SELECT jsonb_agg(jsonb_build_object('key',d.step_key,'phase',d.phase,'rule',d.rule,'sort',d.sort,'active',d.active) ORDER BY d.phase,d.sort,d.step_key)
    FROM public.lc_step_def d WHERE d.tenant_id=t AND d.kind=c.kind),'[]'::jsonb),
   'records',coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.step_key,'done',r.done)) FROM public.lc_case_step r WHERE r.tenant_id=t AND r.case_id=c.id),'[]'::jsonb))
   FROM public.lc_case c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=t
   WHERE c.tenant_id=t AND c.status='in_progress' AND c.kind IN ('onboarding','offboarding')
    AND (app.current_agent_principal() IS NOT NULL OR (app.is_admin_for(c.company_id) AND (app.current_user_id() IS NULL OR app.principal_snapshot_current()))) AND (p_ids IS NULL OR c.id=ANY(p_ids))
   ORDER BY c.created_at,c.id LIMIT p_limit;
 END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automatic_followup_facts(text,date,uuid[],integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automatic_followup_facts(text,date,uuid[],integer) TO ai_hr_app;
--> statement-breakpoint
-- Current lifecycle staff / scoped HR, resolved only by a company administrator during notification projection.
CREATE FUNCTION app.automatic_followup_staff(p_company uuid,p_lifecycle boolean) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT DISTINCT e.id FROM public.app_user u JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND app.is_admin_for(p_company) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  AND e.terminated_on IS NULL AND e.hired_on<=current_date
  AND (EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=u.tenant_id AND r.role::text IN ('hr_admin','super_admin')
   AND (r.company_id IS NULL OR r.company_id=p_company OR app.is_company_descendant(p_company,r.company_id)))
   OR (p_lifecycle AND EXISTS(SELECT 1 FROM public.lc_staff s WHERE s.user_id=u.id AND s.tenant_id=u.tenant_id AND s.level IN ('agent','manager')
    AND (s.company_id IS NULL OR s.company_id=p_company OR app.is_company_descendant(p_company,s.company_id)))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automatic_followup_staff(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automatic_followup_staff(uuid,boolean) TO ai_hr_app;

--> statement-breakpoint
-- Only references of scoped lifecycle stages leave this definer. TypeScript's canonical lifecycle
-- rule/phase owner determines actionability; SQL does not implement a second lifecycle rule engine.
CREATE FUNCTION app.automatic_lifecycle_chased_stages(p_from timestamptz)
RETURNS TABLE(item_id uuid,stage text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();at_time timestamptz:=clock_timestamp();
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL OR p_from IS NULL OR p_from>at_time
  OR app.principal_snapshot_current() IS NOT TRUE OR app.is_admin() IS NOT TRUE THEN
  RAISE EXCEPTION 'Lifecycle outcome references unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT DISTINCT d.aggregate_id,d.payload->>'stage'
 FROM public.domain_event d JOIN public.lc_case c ON c.id=d.aggregate_id AND c.tenant_id=t
 JOIN public.employment e ON e.id=d.subject_employment_id AND e.tenant_id=t
 WHERE d.tenant_id=t AND d.event_type='automatic-chase.followup-raised' AND d.aggregate_type='automatic-chase'
  AND d.actor_type='agent' AND d.payload->>'action'='lifecycle.step.chase'
  AND d.occurred_at>=p_from AND d.occurred_at<=at_time AND app.is_admin_for(c.company_id);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automatic_lifecycle_chased_stages(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automatic_lifecycle_chased_stages(timestamptz) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automatic_chase_outcome_summary(p_from timestamptz)
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
   AND d.event_type IN ('automatic-chase.approval-raised','automatic-chase.review-raised','automatic-chase.followup-raised')
   AND CASE WHEN d.payload->>'action'='lifecycle.step.chase' THEN EXISTS(SELECT 1 FROM public.lc_case q WHERE q.id=d.aggregate_id AND q.tenant_id=t AND app.is_admin_for(q.company_id)) ELSE app.is_admin_for(e.company_id) END),
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
    WHEN 'attendance.missing_clock.remind' THEN EXISTS(SELECT 1 FROM public.employment q WHERE q.id=s.item AND q.tenant_id=t
     AND NOT EXISTS(SELECT 1 FROM public.attendance a WHERE a.employment_id=q.id AND a.tenant_id=t AND a.attendance_date=s.stage::date AND a.check_in_at IS NOT NULL)
     AND NOT EXISTS(SELECT 1 FROM public.attendance_punch a WHERE a.employment_id=q.id AND a.tenant_id=t AND a.attendance_date=s.stage::date AND a.direction::text='in' AND a.voided_at IS NULL)
     AND NOT EXISTS(SELECT 1 FROM public.leave_request_date l WHERE l.subject_employment_id=q.id AND l.tenant_id=t AND l.leave_date=s.stage::date AND l.status::text IN ('pending','approved'))
     AND NOT EXISTS(SELECT 1 FROM public.attendance_correction a WHERE a.employment_id=q.id AND a.tenant_id=t AND a.attendance_date=s.stage::date AND a.status::text IN ('pending','approved')))
    WHEN 'employees.passport_expiry.remind' THEN EXISTS(SELECT 1 FROM public.employment q JOIN public.employee_statutory_my p ON p.person_id=q.person_id AND p.tenant_id=t
     WHERE q.id=s.item AND q.tenant_id=t AND 'passport:'||p.passport_expiry_date::text=s.stage)
    WHEN 'lifecycle.step.chase' THEN NULL::boolean -- canonical native owner measures this in the outcome service
    ELSE true END AS still
  FROM (SELECT DISTINCT k,item,stage FROM scoped WHERE seen_at>=p_from AND seen_at<=at_time) s),
 sent AS (SELECT s.k,count(*)::int AS n FROM scoped s WHERE s.seen_at>=p_from AND s.seen_at<=at_time GROUP BY s.k)
 SELECT f.k,coalesce(sent.n,0),count(w.k)::int,CASE WHEN f.k='lifecycle.step.chase' THEN NULL::int ELSE count(*) FILTER (WHERE w.still=false)::int END,CASE WHEN f.k='lifecycle.step.chase' THEN NULL::int ELSE count(*) FILTER (WHERE w.still)::int END,f.f
 FROM firsts f LEFT JOIN sent ON sent.k=f.k LEFT JOIN win w ON w.k=f.k GROUP BY f.k,f.f,sent.n ORDER BY f.k;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automatic_chase_outcome_summary(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automatic_chase_outcome_summary(timestamptz) TO ai_hr_app;
