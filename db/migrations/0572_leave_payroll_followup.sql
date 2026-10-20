-- Leave decisions protect payroll without granting managers salary access.
-- 0569-0571 are reserved by the existing Building candidate and must precede this migration.
CREATE TABLE payroll_leave_exception (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 batch_id uuid NOT NULL REFERENCES payroll_batch(id),
 employment_id uuid NOT NULL REFERENCES employment(id),
 leave_request_id uuid NOT NULL REFERENCES leave_request(id),
 source_action text NOT NULL CHECK(source_action IN ('approval','charged_import')),
 affected_dates jsonb NOT NULL CHECK(jsonb_typeof(affected_dates)='array'),
 created_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
 resolution text CHECK(resolution IN ('adjustment','no_adjustment')),
 adjustment_batch_id uuid REFERENCES payroll_batch(id),
 explanation text, resolved_by uuid REFERENCES app_user(id), resolved_at timestamptz,
 UNIQUE(tenant_id,batch_id,leave_request_id,source_action),
 CHECK ((status='open' AND resolution IS NULL AND adjustment_batch_id IS NULL AND explanation IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
 OR (status='resolved' AND resolution IS NOT NULL AND length(btrim(explanation))>=10 AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
     AND ((resolution='adjustment' AND adjustment_batch_id IS NOT NULL) OR (resolution='no_adjustment' AND adjustment_batch_id IS NULL))))
);
CREATE INDEX payroll_leave_exception_batch ON payroll_leave_exception(tenant_id,batch_id,status,created_at);
ALTER TABLE payroll_leave_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_leave_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_leave_exception_read ON payroll_leave_exception FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND EXISTS (
  SELECT 1 FROM payroll_batch b WHERE b.id=batch_id AND b.tenant_id=payroll_leave_exception.tenant_id
   AND app.is_admin_for(b.company_id) AND app.can_admin_payroll_for(b.company_id)
 )
);
GRANT SELECT ON payroll_leave_exception TO ai_hr_app;
--> statement-breakpoint
-- No money columns, bank data, or other employees' membership is returned.
CREATE FUNCTION app.leave_payroll_coverage(request_ids uuid[])
RETURNS TABLE(request_id uuid,employment_id uuid,batch_id uuid,company_id uuid,status text,pay_period text,
 policy_config jsonb,unpaid_leave_cutoff_day integer,coverage_from date,coverage_to date,segment jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF cardinality(request_ids) IS NULL OR cardinality(request_ids)>10000 OR EXISTS (
   SELECT 1 FROM unnest(request_ids) wanted(id)
   LEFT JOIN leave_request lr ON lr.id=wanted.id AND lr.tenant_id=app.current_tenant_id()
   WHERE lr.id IS NULL OR NOT (app.can_see_employment(lr.employment_id) OR app.can_decide_via_delegation(lr.employment_id))
 ) OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN
   RAISE EXCEPTION 'Leave visibility required';
 END IF;
 -- NOWAIT is intentional: a leave transaction may already hold the audit-chain lock.
 -- Waiting on a payroll writer that next appends an event would invert that lock order.
 -- Refuse atomically and let the caller retry; never leave a decided request with stale pay.
 PERFORM b.id FROM payroll_batch b WHERE b.tenant_id=app.current_tenant_id()
 AND b.pay_period >= (SELECT to_char(min(lr.start_date),'YYYY-MM') FROM leave_request lr WHERE lr.id=ANY(request_ids) AND lr.tenant_id=b.tenant_id)
 AND b.pay_period <= (SELECT to_char(max(lr.end_date)+interval '1 month','YYYY-MM') FROM leave_request lr WHERE lr.id=ANY(request_ids) AND lr.tenant_id=b.tenant_id)
 AND EXISTS (
  SELECT 1 FROM leave_request lr JOIN employment e ON e.id=lr.employment_id AND e.tenant_id=lr.tenant_id
  WHERE lr.id=ANY(request_ids) AND lr.tenant_id=b.tenant_id AND (
   b.company_id=e.company_id OR EXISTS(SELECT 1 FROM assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.company_id=b.company_id)
   OR EXISTS(SELECT 1 FROM payslip ps WHERE ps.batch_id=b.id AND ps.employment_id=e.id AND ps.tenant_id=e.tenant_id)
  )
 ) ORDER BY b.id FOR UPDATE NOWAIT;
 RETURN QUERY
 SELECT lr.id,lr.employment_id,b.id,b.company_id,b.status::text,b.pay_period::text,
   CASE WHEN policy.status='active' THEN jsonb_build_object('cutOff',policy.config->'cutOff','frequency',policy.config->'frequency',
     'leave',jsonb_build_object('deductAbsentDays',policy.config->'leave'->'deductAbsentDays')) ELSE NULL END,
   cfg.unpaid_leave_cut_off_day,ps.coverage_from,ps.coverage_to,jsonb_build_object('segment',ps.statutory->'segment')
 FROM leave_request lr JOIN payslip ps ON ps.employment_id=lr.employment_id AND ps.tenant_id=lr.tenant_id
 JOIN employment e ON e.id=lr.employment_id AND e.tenant_id=lr.tenant_id
 JOIN payroll_batch b ON b.id=ps.batch_id AND b.tenant_id=lr.tenant_id
 LEFT JOIN company_payroll_config cfg ON cfg.company_id=b.company_id AND cfg.tenant_id=b.tenant_id
 LEFT JOIN payroll_policy assigned ON assigned.id=e.payroll_policy_id AND assigned.tenant_id=e.tenant_id AND assigned.company_id=b.company_id
 LEFT JOIN payroll_policy policy ON policy.id=coalesce(assigned.id,cfg.default_payroll_policy_id) AND policy.tenant_id=b.tenant_id AND policy.company_id=b.company_id
 WHERE lr.id=ANY(request_ids) AND lr.tenant_id=app.current_tenant_id() AND b.status IN ('processed','closed')
 ORDER BY b.id,lr.id;
END $$;
REVOKE ALL ON FUNCTION app.leave_payroll_coverage(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_payroll_coverage(uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.leave_type_payroll_requests(wanted_type uuid) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT app.is_admin() OR NOT EXISTS(SELECT 1 FROM leave_type t WHERE t.id=wanted_type AND t.tenant_id=app.current_tenant_id())
 OR EXISTS(SELECT 1 FROM leave_request lr JOIN employment e ON e.id=lr.employment_id AND e.tenant_id=lr.tenant_id
   WHERE lr.leave_type_id=wanted_type AND lr.tenant_id=app.current_tenant_id() AND lr.status='approved' AND NOT app.is_admin_for(e.company_id)) THEN
   RAISE EXCEPTION 'Changing paid status requires HR authority for every affected company';
 END IF;
 RETURN coalesce((SELECT array_agg(lr.id ORDER BY lr.id) FROM leave_request lr
  WHERE lr.leave_type_id=wanted_type AND lr.tenant_id=app.current_tenant_id() AND lr.status='approved'),'{}'::uuid[]);
END $$;
REVOKE ALL ON FUNCTION app.leave_type_payroll_requests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_type_payroll_requests(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.record_leave_payroll_effect(wanted_request uuid,wanted_batch uuid,action text,dates jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE lr leave_request; b payroll_batch; exception_id uuid; added boolean;
BEGIN
 SELECT * INTO lr FROM leave_request WHERE id=wanted_request AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT (app.can_see_employment(lr.employment_id) OR app.can_decide_via_delegation(lr.employment_id))
   OR action IS NULL OR action NOT IN ('approval','charged_import','cancellation','paid_setting')
   OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=lr.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN
   RAISE EXCEPTION 'Leave visibility required';
 END IF;
 IF jsonb_typeof(dates) IS DISTINCT FROM 'array' OR jsonb_array_length(dates)=0 THEN RAISE EXCEPTION 'Affected dates required'; END IF;
 SELECT * INTO b FROM payroll_batch WHERE id=wanted_batch AND tenant_id=lr.tenant_id FOR UPDATE NOWAIT;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM payslip ps WHERE ps.batch_id=b.id AND ps.employment_id=lr.employment_id AND ps.tenant_id=lr.tenant_id) THEN
   RAISE EXCEPTION 'Leave payroll membership required';
 END IF;
 IF b.status='processed' THEN
   added:=NOT (coalesce(b.recalc_employment_ids,'[]'::jsonb) @> jsonb_build_array(lr.employment_id::text));
   UPDATE payroll_batch SET needs_recalc_at=coalesce(needs_recalc_at,now()),
     recalc_employment_ids=CASE WHEN added THEN coalesce(recalc_employment_ids,'[]'::jsonb)||jsonb_build_array(lr.employment_id::text) ELSE recalc_employment_ids END WHERE id=b.id;
   IF added THEN INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
     VALUES(lr.tenant_id,'payroll-batch',b.id,'payroll-batch.recalc-required','user',app.current_user_id(),
       jsonb_build_object('addedEmploymentIds',jsonb_build_array(lr.employment_id::text),'leaveRequestId',lr.id,'sourceAction',action)); END IF;
 ELSIF b.status='closed' THEN
   IF action NOT IN ('approval','charged_import') OR lr.status<>'approved' THEN RAISE EXCEPTION 'Closed payroll cannot be changed by this leave action'; END IF;
   IF lr.imported_history AND NOT EXISTS(SELECT 1 FROM leave_ledger ll WHERE ll.tenant_id=lr.tenant_id AND ll.source_request_id=lr.id AND ll.entry_type='debit') THEN RETURN; END IF;
   INSERT INTO payroll_leave_exception(tenant_id,batch_id,employment_id,leave_request_id,source_action,affected_dates,created_by)
    VALUES(lr.tenant_id,b.id,lr.employment_id,lr.id,action,dates,app.current_user_id())
    ON CONFLICT(tenant_id,batch_id,leave_request_id,source_action) DO NOTHING RETURNING id INTO exception_id;
   IF exception_id IS NOT NULL THEN INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
    VALUES(lr.tenant_id,'payroll-leave-exception',exception_id,'payroll-leave-exception.opened','user',app.current_user_id(),
      jsonb_build_object('batchId',b.id,'leaveRequestId',lr.id,'sourceAction',action)); END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.record_leave_payroll_effect(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_leave_payroll_effect(uuid,uuid,text,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.resolve_leave_payroll_exception(wanted_exception uuid,outcome text,adjustment uuid,note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item payroll_leave_exception; employer uuid;
BEGIN
 SELECT * INTO item FROM payroll_leave_exception WHERE id=wanted_exception AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll leave exception unavailable'; END IF;
 SELECT company_id INTO employer FROM payroll_batch WHERE id=item.batch_id AND tenant_id=item.tenant_id;
 IF NOT app.is_admin_for(employer) OR NOT app.can_admin_payroll_for(employer)
   OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=item.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Payroll HR authority required'; END IF;
 IF item.status<>'open' OR outcome IS NULL OR outcome NOT IN ('adjustment','no_adjustment') OR note IS NULL OR length(btrim(note))<10 OR length(note)>2000 THEN
   RAISE EXCEPTION 'An open exception and a clear resolution explanation are required';
 END IF;
 IF outcome='adjustment' AND NOT EXISTS (
   SELECT 1 FROM payroll_batch b JOIN payslip ps ON ps.batch_id=b.id AND ps.tenant_id=b.tenant_id
   WHERE b.id=adjustment AND b.id<>item.batch_id AND b.tenant_id=item.tenant_id AND b.status='closed' AND b.run_type='adjustment'
    AND ps.employment_id=item.employment_id AND app.is_admin_for(b.company_id) AND app.can_admin_payroll_for(b.company_id)
 ) THEN RAISE EXCEPTION 'Select a closed adjustment run containing this employee'; END IF;
 IF outcome='no_adjustment' AND adjustment IS NOT NULL THEN RAISE EXCEPTION 'No-adjustment resolution cannot reference an adjustment'; END IF;
 UPDATE payroll_leave_exception SET status='resolved',resolution=outcome,adjustment_batch_id=adjustment,explanation=btrim(note),resolved_by=app.current_user_id(),resolved_at=now() WHERE id=item.id;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  VALUES(item.tenant_id,'payroll-leave-exception',item.id,'payroll-leave-exception.resolved','user',app.current_user_id(),
    jsonb_build_object('resolution',outcome,'adjustmentBatchId',adjustment));
END $$;
REVOKE ALL ON FUNCTION app.resolve_leave_payroll_exception(uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_leave_payroll_exception(uuid,text,uuid,text) TO ai_hr_app;
