-- PROVISIONAL 0699 / 1793330000025 / idx 689. Allocate final identity at integration freeze.
-- Stand-ins gain request-bound approval authority, never Personnel/balance visibility.
CREATE FUNCTION app.delegation_line_covers(line_id uuid, subject_id uuid, wanted_module text, wanted_task text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS (
  SELECT 1 FROM public.reporting_line d
  JOIN public.employment delegate ON delegate.id=d.manager_employment_id AND delegate.tenant_id=d.tenant_id
  JOIN public.employment delegator ON delegator.id=d.subordinate_employment_id AND delegator.tenant_id=d.tenant_id
  JOIN public.employment subject ON subject.id=subject_id AND subject.tenant_id=d.tenant_id
  WHERE d.id=line_id AND d.tenant_id=app.current_tenant_id() AND d.line_type::text='delegate'
   AND d.valid_from<=current_date AND (d.valid_to IS NULL OR d.valid_to>current_date) AND d.superseded_at IS NULL
   AND delegate.terminated_on IS NULL AND delegator.terminated_on IS NULL AND delegate.hired_on<=current_date
   AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.person_id=delegate.person_id AND u.tenant_id=d.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
   AND delegate.person_id<>subject.person_id
   AND (wanted_module IS NULL OR NOT EXISTS(SELECT 1 FROM public.reporting_line_scope s WHERE s.reporting_line_id=d.id AND s.tenant_id=d.tenant_id)
    OR EXISTS(SELECT 1 FROM public.reporting_line_scope s WHERE s.reporting_line_id=d.id AND s.tenant_id=d.tenant_id AND s.module=wanted_module AND (s.task_type IS NULL OR s.task_type=wanted_task)))
   AND (
    (d.scope_company_id IS NULL AND d.scope_business_unit_id IS NULL AND d.scope_department_id IS NULL AND subject.company_id=delegate.company_id)
    OR ((d.scope_company_id IS NOT NULL OR d.scope_business_unit_id IS NOT NULL OR d.scope_department_id IS NOT NULL)
     AND (d.scope_company_id IS NULL OR d.scope_company_id=subject.company_id)
     AND ((d.scope_business_unit_id IS NULL AND d.scope_department_id IS NULL) OR EXISTS(
      SELECT 1 FROM public.assignment a LEFT JOIN public.department dept ON dept.id=a.department_id AND dept.tenant_id=a.tenant_id
      WHERE a.employment_id=subject.id AND a.tenant_id=subject.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
       AND (d.scope_business_unit_id IS NULL OR d.scope_business_unit_id=coalesce(a.business_unit_id,dept.business_unit_id))
       AND (d.scope_department_id IS NULL OR d.scope_department_id=a.department_id)))))
 );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delegation_line_covers(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delegation_line_covers(uuid,uuid,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_decide_via_delegation(subject_emp uuid,p_module text,p_task_type text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reporting_line adm JOIN public.reporting_line d ON d.subordinate_employment_id=adm.manager_employment_id AND d.tenant_id=adm.tenant_id
 WHERE adm.tenant_id=app.current_tenant_id() AND adm.subordinate_employment_id=subject_emp AND adm.line_type='administrative'
  AND adm.superseded_at IS NULL AND adm.valid_from<=current_date AND (adm.valid_to IS NULL OR adm.valid_to>current_date)
  AND EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=d.manager_employment_id AND e.tenant_id=d.tenant_id AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  AND app.delegation_line_covers(d.id,subject_emp,p_module,p_task_type));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_decide_via_delegation_from(p_delegator uuid,subject_emp uuid,p_module text,p_task_type text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reporting_line d WHERE d.subordinate_employment_id=p_delegator AND d.tenant_id=app.current_tenant_id()
  AND EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=d.manager_employment_id AND e.tenant_id=d.tenant_id AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  AND app.delegation_line_covers(d.id,subject_emp,p_module,p_task_type));
$$;
--> statement-breakpoint
CREATE FUNCTION app.delegated_subject_ids(wanted_module text,wanted_task text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(DISTINCT adm.subordinate_employment_id),'{}'::uuid[])
 FROM public.reporting_line adm JOIN public.reporting_line d ON d.subordinate_employment_id=adm.manager_employment_id AND d.tenant_id=adm.tenant_id
 WHERE adm.tenant_id=app.current_tenant_id() AND adm.line_type='administrative' AND adm.superseded_at IS NULL
  AND adm.valid_from<=current_date AND (adm.valid_to IS NULL OR adm.valid_to>current_date)
  AND EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=d.manager_employment_id AND e.tenant_id=d.tenant_id AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  AND app.delegation_line_covers(d.id,adm.subordinate_employment_id,wanted_module,wanted_task);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delegated_subject_ids(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delegated_subject_ids(text,text) TO ai_hr_app;
--> statement-breakpoint
-- Separate operation policies: do not add delegation to existing ALL policies (would grant DELETE).
CREATE POLICY claim_delegate_read ON public.claim_request FOR SELECT TO ai_hr_app USING (
 tenant_id=app.current_tenant_id() AND status::text<>'draft' AND employment_id=ANY((SELECT app.delegated_subject_ids('claims','claims.claim'))::uuid[]));
CREATE POLICY claim_delegate_decide ON public.claim_request FOR UPDATE TO ai_hr_app USING (
 tenant_id=app.current_tenant_id() AND status='pending' AND employment_id=ANY((SELECT app.delegated_subject_ids('claims','claims.claim'))::uuid[])) WITH CHECK (
 tenant_id=app.current_tenant_id() AND status IN ('approved','rejected') AND employment_id=ANY((SELECT app.delegated_subject_ids('claims','claims.claim'))::uuid[]));
CREATE POLICY claim_delegate_attachment_read ON public.claim_attachment FOR SELECT TO ai_hr_app USING (
 tenant_id=app.current_tenant_id() AND employment_id=ANY((SELECT app.delegated_subject_ids('claims','claims.claim'))::uuid[])
 AND EXISTS(SELECT 1 FROM public.claim_request q WHERE q.id=claim_request_id AND q.employment_id=claim_attachment.employment_id AND q.tenant_id=claim_attachment.tenant_id AND q.status::text<>'draft'));
--> statement-breakpoint
CREATE FUNCTION app.unrouted_attendance_delegate(correction_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=correction_id AND c.tenant_id=app.current_tenant_id()
  AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.correction_id=c.id AND w.tenant_id=c.tenant_id)
  AND app.can_decide_via_delegation(c.employment_id,'attendance','attendance.correction'));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.unrouted_attendance_delegate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.unrouted_attendance_delegate(uuid) TO ai_hr_app;
CREATE POLICY attendance_unrouted_delegate_read ON public.attendance_correction FOR SELECT TO ai_hr_app USING (
 tenant_id=app.current_tenant_id() AND app.unrouted_attendance_delegate(id));
CREATE POLICY attendance_unrouted_delegate_decide ON public.attendance_correction FOR UPDATE TO ai_hr_app USING (
 tenant_id=app.current_tenant_id() AND status='pending' AND app.unrouted_attendance_delegate(id)) WITH CHECK (
 tenant_id=app.current_tenant_id() AND status IN ('approved','rejected') AND app.unrouted_attendance_delegate(id));
--> statement-breakpoint
CREATE FUNCTION app.delegated_decision_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE allowed_columns text[];mod text;task text;
BEGIN
 IF app.access_workforce_storage_owner() OR OLD.employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='claim_request' THEN
  mod:='claims';task:='claims.claim';allowed_columns:=ARRAY['status','taxable','decided_by_employment_id','decided_at'];
 ELSIF TG_TABLE_NAME='replacement_leave_request' THEN
  mod:='leave';task:='leave.replacement';allowed_columns:=ARRAY['status','decided_at','decided_by_user_id','decision_note','total_days','total_hours'];
 ELSE
  -- Routed workflows retain their own authority and immutable application guards.
  IF NOT app.unrouted_attendance_delegate(OLD.id) THEN RETURN NEW; END IF;
  mod:='attendance';task:='attendance.correction';allowed_columns:=ARRAY['status','reject_reason','decided_by_employment_id','decided_at'];
 END IF;
 IF OLD.tenant_id<>app.current_tenant_id() OR NOT app.can_decide_via_delegation(OLD.employment_id,mod,task)
  OR OLD.status::text<>'pending' OR NEW.status::text NOT IN ('approved','rejected')
  OR (to_jsonb(OLD)-allowed_columns) IS DISTINCT FROM (to_jsonb(NEW)-allowed_columns)
 THEN RAISE EXCEPTION 'Delegated request permits decision columns only'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delegated_decision_write_guard() FROM PUBLIC;
CREATE TRIGGER claim_delegate_write_guard BEFORE UPDATE ON public.claim_request FOR EACH ROW EXECUTE FUNCTION app.delegated_decision_write_guard();
CREATE TRIGGER attendance_delegate_write_guard BEFORE UPDATE ON public.attendance_correction FOR EACH ROW EXECUTE FUNCTION app.delegated_decision_write_guard();
CREATE TRIGGER replacement_delegate_write_guard BEFORE UPDATE ON public.replacement_leave_request FOR EACH ROW EXECUTE FUNCTION app.delegated_decision_write_guard();
--> statement-breakpoint
-- INSERT RETURNING and receipt reconciliation must see the caller's own decision, not other event data.
CREATE POLICY delegated_own_decision_event_read ON public.domain_event FOR SELECT TO ai_hr_app USING (
 tenant_id=app.current_tenant_id() AND actor_type='user' AND actor_id=app.current_user_id()
 AND ((aggregate_type='claim-request' AND event_type IN ('claim-request.approved','claim-request.rejected'))
  OR (aggregate_type='replacement-leave-request' AND event_type IN ('replacement-leave-request.approved','replacement-leave-request.rejected'))
  OR (aggregate_type='attendance-correction' AND event_type IN ('attendance-correction.approved','attendance-correction.rejected','attendance-workflow.stage.decided','attendance-workflow.participant.decided'))));
--> statement-breakpoint
CREATE FUNCTION app.claim_decision_subject_facts(claim_id uuid) RETURNS TABLE(grade_id uuid,company_id uuid,country text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.grade_id,e.company_id,c.country::text FROM public.claim_request q
 JOIN public.employment e ON e.id=q.employment_id AND e.tenant_id=q.tenant_id
 JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
 WHERE q.id=claim_id AND q.tenant_id=app.current_tenant_id() AND q.status='pending'
  AND (app.can_see_employment(e.id) OR app.can_decide_via_delegation(e.id,'claims','claims.claim'));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_decision_subject_facts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_decision_subject_facts(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.delegated_approval_subject(subject_id uuid,wanted_module text,wanted_task text)
RETURNS TABLE(person_id uuid,employee text,employee_code text,company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.person_id,p.full_name,e.employee_code,e.company_id FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id()
  AND (app.can_see_employment(e.id) OR app.can_decide_via_delegation(e.id,wanted_module,wanted_task));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delegated_approval_subject(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delegated_approval_subject(uuid,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Only a pending delegated request can resolve a current manager's calculation identity. No general lookup.
CREATE FUNCTION app.delegated_request_effect_identity(p_request_id uuid,p_request_kind text) RETURNS TABLE(user_id uuid,roles text,grants jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH subject AS (
  SELECT q.employment_id,'leave'::text AS module,'leave.replacement'::text AS task FROM public.replacement_leave_request q
   WHERE p_request_kind='replacement_leave' AND q.id=p_request_id AND q.tenant_id=app.current_tenant_id() AND q.status='pending'
  UNION ALL
  SELECT q.employment_id,'attendance','attendance.correction' FROM public.attendance_correction q
   WHERE p_request_kind='attendance' AND q.id=p_request_id AND q.tenant_id=app.current_tenant_id() AND q.status='pending'
    AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.correction_id=q.id AND w.tenant_id=q.tenant_id)
 )
 SELECT u.id,string_agg(DISTINCT r.role::text,',' ORDER BY r.role::text),jsonb_agg(jsonb_build_object('role',r.role::text,'companyId',r.company_id) ORDER BY r.role::text,r.company_id)
 FROM subject s JOIN public.reporting_line adm ON adm.subordinate_employment_id=s.employment_id AND adm.tenant_id=app.current_tenant_id()
 JOIN public.employment m ON m.id=adm.manager_employment_id AND m.tenant_id=adm.tenant_id
 JOIN public.employment target ON target.id=s.employment_id AND target.tenant_id=adm.tenant_id
 JOIN public.app_user u ON u.person_id=m.person_id AND u.tenant_id=m.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
 WHERE app.can_decide_via_delegation(s.employment_id,s.module,s.task) AND NOT app.can_see_employment(s.employment_id)
  AND adm.line_type='administrative' AND adm.superseded_at IS NULL AND adm.valid_from<=current_date AND (adm.valid_to IS NULL OR adm.valid_to>current_date)
  AND m.terminated_on IS NULL AND m.hired_on<=current_date
  AND r.role::text IN ('employee','manager') AND (r.company_id IS NULL OR r.company_id=target.company_id OR app.is_company_descendant(target.company_id,r.company_id))
 GROUP BY u.id,u.created_at ORDER BY u.created_at,u.id LIMIT 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delegated_request_effect_identity(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delegated_request_effect_identity(uuid,text) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_application_subject(correction uuid)
RETURNS TABLE(person_id uuid,employee text,employee_code text,company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.person_id,p.full_name,e.employee_code,e.company_id
 FROM public.attendance_correction c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE c.id=correction AND c.tenant_id=app.current_tenant_id()
  AND (app.can_see_employment(e.id) OR app.attendance_workflow_delegate_request(c.id) OR app.attendance_workflow_v2_read(c.id) OR app.attendance_workflow_v3_read(c.id) OR app.unrouted_attendance_delegate(c.id));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.approval_history(
  p_from timestamptz,
  p_to timestamptz,
  p_aggregate_types text[],
  p_action text,
  p_decider_employment_id uuid,
  p_limit int,
  p_offset int
)
  RETURNS TABLE (
    id uuid,
    aggregate_type text,
    aggregate_id uuid,
    event_type text,
    occurred_at timestamptz,
    subject_employment_id uuid,
    subject_name text,
    decider_name text,
    is_auto boolean,
    on_behalf_of_employment_id uuid,
    on_behalf_of_name text,
    payload jsonb
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH RECURSIVE caller_emp AS (
    -- Every employment of the calling principal (a person can hold concurrent employments).
    SELECT e.id, e.company_id, e.terminated_on
    FROM employment e
    JOIN app_user u ON u.person_id = e.person_id
    WHERE u.id = app.current_user_id()
      AND e.tenant_id = app.current_tenant_id()
  ),
  down AS (
    -- Recursive administrative down-walk from each ACTIVE caller employment (mirror of
    -- app.is_admin_report_of: active edges, live intermediates, company-subtree clamp, depth cap).
    SELECT rl.subordinate_employment_id AS emp, me.company_id AS root, 1 AS depth
    FROM reporting_line rl
    JOIN caller_emp me ON me.id = rl.manager_employment_id AND me.terminated_on IS NULL
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND sub.terminated_on IS NULL
      AND app.is_company_descendant(sub.company_id, me.company_id)
    UNION
    SELECT rl.subordinate_employment_id, d.root, d.depth + 1
    FROM reporting_line rl
    JOIN down d ON d.emp = rl.manager_employment_id
    JOIN employment mid ON mid.id = rl.manager_employment_id AND mid.terminated_on IS NULL
    JOIN employment sub ON sub.id = rl.subordinate_employment_id AND sub.terminated_on IS NULL
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND d.depth < 64
      AND app.is_company_descendant(sub.company_id, d.root)
  ),
  ev AS (
    SELECT de.id, de.aggregate_type, de.aggregate_id, de.event_type, de.occurred_at, de.sequence,
           de.subject_employment_id, de.actor_id, de.payload, de.tenant_id
    FROM domain_event de
    WHERE de.tenant_id = app.current_tenant_id()
      -- The closed set of decision events this history covers (resignation uses accepted, not approved;
      -- employment-review.decided carries confirm/extend/terminate).
      AND de.event_type IN (
        'leave-request.approved', 'leave-request.rejected', 'leave-request.step.approved',
        'leave-request.date.decided', 'leave-cancellation.approved', 'leave-cancellation.rejected',
        'attendance-correction.approved', 'attendance-correction.rejected',
        'claim-request.approved', 'claim-request.rejected',
        'replacement-leave-request.approved', 'replacement-leave-request.rejected',
        'attendance-workflow.stage.decided',
        'travel-request.approved', 'travel-request.rejected',
        'resignation.accepted', 'resignation.rejected',
        'profile-change.approved', 'profile-change.rejected',
        'employment-review.decided'
      )
      AND (de.event_type NOT IN ('attendance-workflow.stage.decided') OR de.payload->>'resultingStatus'='pending')
      AND de.subject_employment_id IS NOT NULL
      -- Self rows never appear: the tab is about the viewer's TEAM.
      AND de.subject_employment_id NOT IN (SELECT ce.id FROM caller_emp ce)
      AND (EXISTS(SELECT 1 FROM public.employment scoped_subject WHERE scoped_subject.id=de.subject_employment_id AND scoped_subject.tenant_id=de.tenant_id AND app.is_admin_for(scoped_subject.company_id)) OR de.subject_employment_id IN (SELECT d.emp FROM down d))
      AND (p_from IS NULL OR de.occurred_at >= p_from)
      AND (p_to IS NULL OR de.occurred_at < p_to)
      AND (p_aggregate_types IS NULL OR cardinality(p_aggregate_types) = 0
           OR de.aggregate_type = ANY (p_aggregate_types))
      -- Action filter: Approved / Rejected / Other. Step rows ride '%.approved'; per-day rows group by
      -- their payload outcome; review decisions (confirm/extend/terminate) fall under Other.
      AND (p_action IS NULL
        OR (p_action = 'approved' AND (
              (de.event_type LIKE '%.approved' OR de.event_type = 'resignation.accepted')
              OR (de.event_type IN ('leave-request.date.decided','attendance-workflow.stage.decided') AND de.payload->>'decision' = 'approved')))
        OR (p_action = 'rejected' AND (
              de.event_type LIKE '%.rejected'
              OR (de.event_type IN ('leave-request.date.decided','attendance-workflow.stage.decided') AND de.payload->>'decision' = 'rejected')))
        OR (p_action = 'other' AND de.event_type = 'employment-review.decided'))
      -- Decider filter: an EMPLOYMENT id, mapped to the actor's app_user id(s) via person (server-side —
      -- the viewer may not be able to read the delegate's employment under RLS).
      AND (p_decider_employment_id IS NULL OR de.actor_id IN (
            SELECT u2.id
            FROM employment de2
            JOIN app_user u2 ON u2.person_id = de2.person_id
            WHERE de2.id = p_decider_employment_id
          ))
    ORDER BY de.occurred_at DESC, de.sequence DESC
    LIMIT GREATEST(COALESCE(p_limit, 50), 1)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT
    e.id,
    e.aggregate_type,
    e.aggregate_id,
    e.event_type,
    e.occurred_at,
    e.subject_employment_id,
    subj_p.full_name,
    actor_p.full_name,
    COALESCE((e.payload->>'auto')::boolean, false),
    ob.delegator_employment_id,
    ob.delegator_name,
    e.payload
  FROM ev e
  LEFT JOIN employment subj_e ON subj_e.id = e.subject_employment_id
  LEFT JOIN person subj_p ON subj_p.id = subj_e.person_id
  LEFT JOIN app_user actor_u ON actor_u.id = e.actor_id
  LEFT JOIN person actor_p ON actor_p.id = actor_u.person_id
  LEFT JOIN LATERAL (
    SELECT del.subordinate_employment_id AS delegator_employment_id, dp.full_name AS delegator_name
    FROM reporting_line del
    JOIN employment del_emp ON del_emp.id = del.manager_employment_id   -- the delegate slot = the actor
    JOIN employment deleg_e ON deleg_e.id = del.subordinate_employment_id -- the delegator
    JOIN person dp ON dp.id = deleg_e.person_id
    WHERE del.line_type::text = 'delegate'
      AND del.tenant_id = e.tenant_id
      AND del_emp.person_id = actor_u.person_id
      AND del.valid_from <= ((e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND (del.valid_to IS NULL OR del.valid_to > ((e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
      AND (del.superseded_at IS NULL OR del.superseded_at > e.occurred_at)
      AND EXISTS (
        SELECT 1 FROM reporting_line adm
        WHERE adm.subordinate_employment_id = e.subject_employment_id
          AND adm.line_type = 'administrative'
          AND adm.manager_employment_id = del.subordinate_employment_id
          AND adm.valid_from <= ((e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
          AND (adm.valid_to IS NULL OR adm.valid_to > ((e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
          AND (adm.superseded_at IS NULL OR adm.superseded_at > e.occurred_at)
      )
    ORDER BY del.valid_from, del.id
    LIMIT 1
  ) ob ON true
  ORDER BY e.occurred_at DESC, e.sequence DESC;
$$;
--> statement-breakpoint
CREATE FUNCTION app.active_delegate_employments(subject_id uuid,wanted_module text,wanted_task text,delegators uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT DISTINCT d.manager_employment_id FROM public.reporting_line d
 JOIN public.employment subject ON subject.id=subject_id AND subject.tenant_id=d.tenant_id
 WHERE subject.tenant_id=app.current_tenant_id() AND app.is_admin_for(subject.company_id)
  AND d.subordinate_employment_id=ANY(delegators)
  AND ((wanted_module='leave' AND wanted_task<>'leave.replacement') OR EXISTS(
   SELECT 1 FROM public.reporting_line adm WHERE adm.tenant_id=d.tenant_id AND adm.subordinate_employment_id=subject_id
    AND adm.manager_employment_id=d.subordinate_employment_id AND adm.line_type='administrative' AND adm.superseded_at IS NULL
    AND adm.valid_from<=current_date AND (adm.valid_to IS NULL OR adm.valid_to>current_date)))
  AND app.delegation_line_covers(d.id,subject_id,wanted_module,wanted_task);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.active_delegate_employments(uuid,text,text,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.active_delegate_employments(uuid,text,text,uuid[]) TO ai_hr_app;
