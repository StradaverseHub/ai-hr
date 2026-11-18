-- Original payroll employer owns these narrow historical labels. No Personnel directory grant,
-- source download, mutation, or unreleased-stage visibility is added by these readers.
CREATE FUNCTION app.payroll_history_maintenance_permissions(targets uuid[] DEFAULT NULL)
RETURNS TABLE(company_id uuid,can_edit boolean,can_remove boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH grants AS MATERIALIZED(SELECT g.role,g.company_id FROM app.current_grants() g),
 carrier AS MATERIALIZED(SELECT coalesce(jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)),'[]'::jsonb) value FROM grants g),
 companies AS MATERIALIZED(SELECT c.id FROM public.company c CROSS JOIN carrier WHERE c.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (targets IS NULL OR c.id=ANY(targets)) AND app.grants_payroll_admin_for(carrier.value,c.id)),
 roles AS MATERIALIZED(SELECT DISTINCT c.id,g.role FROM companies c CROSS JOIN grants g WHERE g.company_id IS NULL OR g.company_id=c.id OR app.is_company_descendant(c.id,g.company_id)),
 keys AS(SELECT unnest(ARRAY['payroll.history.import','payroll.history.revert']) key),
 configured AS MATERIALIZED(SELECT c.id,k.key,p.role,p.allowed,p.company_id FROM companies c CROSS JOIN keys k JOIN public.payroll_permission_grant p ON p.tenant_id=app.current_tenant_id() AND p.permission_key=k.key AND (p.company_id=c.id OR p.company_id IS NULL)),
 effective AS MATERIALIZED(SELECT x.* FROM configured x WHERE x.company_id=x.id OR x.company_id IS NULL AND NOT EXISTS(SELECT 1 FROM configured specific WHERE specific.id=x.id AND specific.key=x.key AND specific.company_id=x.id)),
 decisions AS(SELECT c.id,k.key,CASE WHEN EXISTS(SELECT 1 FROM effective e WHERE e.id=c.id AND e.key=k.key) THEN EXISTS(SELECT 1 FROM effective e JOIN roles r ON r.id=e.id AND r.role=e.role WHERE e.id=c.id AND e.key=k.key AND e.allowed AND NOT EXISTS(SELECT 1 FROM effective denied WHERE denied.id=e.id AND denied.key=e.key AND denied.role=e.role AND NOT denied.allowed)) ELSE EXISTS(SELECT 1 FROM roles r WHERE r.id=c.id AND r.role IN('hr_admin','super_admin')) END allowed FROM companies c CROSS JOIN keys k)
 SELECT d.id,bool_or(d.allowed AND d.key='payroll.history.import'),bool_or(d.allowed AND d.key='payroll.history.revert') FROM decisions d GROUP BY d.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_permissions(uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Closed-key counterpart of decidePayrollPermission / personnelFormulaPermissionsTx. Company
-- override sets win over tenant sets, including overrides for roles absent from this carrier.
CREATE FUNCTION app.payroll_history_maintenance_permission(target uuid,permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT CASE permission WHEN 'payroll.history.import' THEN p.can_edit WHEN 'payroll.history.revert' THEN p.can_remove ELSE false END FROM app.payroll_history_maintenance_permissions(ARRAY[target]) p WHERE p.company_id=target),false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_permission(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_maintenance_permission(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_maintenance_page(p_company uuid DEFAULT NULL,p_period text DEFAULT NULL,p_search text DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25,p_withdrawn boolean DEFAULT false,p_record uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_withdrawn IS NULL OR p_period IS NOT NULL AND p_period!~'^[0-9]{4}-(0[1-9]|1[0-2])$' OR length(p_search)>200 THEN RAISE EXCEPTION 'Invalid imported history page' USING ERRCODE='22023';END IF;
 WITH hidden AS MATERIALIZED(SELECT s.relation,s.row_id FROM app.payroll_history_staged_row s JOIN app.payroll_history_stage stage ON stage.stage_id=s.stage_id WHERE stage.tenant_id=app.current_tenant_id() AND stage.state='staged'),
 permissions AS MATERIALIZED(SELECT * FROM app.payroll_history_maintenance_permissions(CASE WHEN p_company IS NULL THEN NULL ELSE ARRAY[p_company] END) WHERE can_edit),
 scoped_records AS MATERIALIZED(SELECT r.* FROM public.payroll_history_import_record r JOIN permissions ON permissions.company_id=r.company_id WHERE r.tenant_id=app.current_tenant_id() AND (p_record IS NULL OR r.id=p_record) AND (p_period IS NULL OR r.period=p_period) AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_record' AND h.row_id=r.id)),
 current_revisions AS MATERIALIZED(SELECT DISTINCT ON(r.record_id) r.* FROM public.payroll_history_import_revision r JOIN scoped_records subject ON subject.id=r.record_id WHERE r.tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_revision' AND h.row_id=r.id) ORDER BY r.record_id,r.ordinal DESC),
 attempts AS MATERIALIZED(SELECT a.id,a.plan FROM public.payroll_history_import_attempt a JOIN (SELECT DISTINCT attempt_id FROM current_revisions) chosen ON chosen.attempt_id=a.id WHERE a.tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_attempt' AND h.row_id=a.id)),
 planned AS MATERIALIZED(SELECT DISTINCT ON(a.id,value->>'companyId',value->>'employmentId',value->>'period',value->>'cycleId') a.id attempt_id,value AS planned_value FROM attempts a CROSS JOIN LATERAL jsonb_array_elements(coalesce(a.plan->'rows','[]'::jsonb)) WITH ORDINALITY item(value,ordinality) ORDER BY a.id,value->>'companyId',value->>'employmentId',value->>'period',value->>'cycleId',ordinality),
 name_needed AS MATERIALIZED(SELECT r.* FROM scoped_records r JOIN current_revisions rev ON rev.record_id=r.id LEFT JOIN planned ON planned.attempt_id=rev.attempt_id AND planned.planned_value->>'companyId'=r.company_id::text AND planned.planned_value->>'employmentId'=r.employment_id::text AND planned.planned_value->>'period'=r.period AND planned.planned_value->>'cycleId'=r.cycle_id::text WHERE nullif(btrim(planned.planned_value->>'employeeName'),'') IS NULL),
 name_revisions AS MATERIALIZED(SELECT rev.* FROM public.payroll_history_import_revision rev JOIN name_needed r ON r.id=rev.record_id WHERE rev.tenant_id=app.current_tenant_id() AND rev.snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_revision' AND h.row_id=rev.id OR h.relation='payroll_history_import_snapshot' AND h.row_id=rev.snapshot_id)),
 name_attempts AS MATERIALIZED(SELECT a.id,a.plan FROM public.payroll_history_import_attempt a JOIN(SELECT DISTINCT attempt_id FROM name_revisions) chosen ON chosen.attempt_id=a.id WHERE a.tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_attempt' AND h.row_id=a.id)),
 name_plans AS MATERIALIZED(SELECT a.id attempt_id,value planned_value FROM name_attempts a CROSS JOIN LATERAL jsonb_array_elements(coalesce(a.plan->'rows','[]'::jsonb)) value),
 retained_names AS MATERIALIZED(SELECT DISTINCT ON(r.id) r.id,nullif(btrim(plan.planned_value->>'employeeName'),'') employee_name FROM name_needed r JOIN name_revisions rev ON rev.record_id=r.id JOIN public.payroll_history_import_snapshot snapshot ON snapshot.id=rev.snapshot_id AND snapshot.record_id=r.id AND snapshot.tenant_id=r.tenant_id JOIN name_plans plan ON plan.attempt_id=rev.attempt_id AND plan.planned_value->>'companyId'=r.company_id::text AND plan.planned_value->>'employmentId'=r.employment_id::text AND plan.planned_value->>'period'=r.period AND plan.planned_value->>'cycleId'=r.cycle_id::text AND plan.planned_value->>'valueHash'=snapshot.value_hash AND plan.planned_value->'values'=snapshot."values" WHERE nullif(btrim(plan.planned_value->>'employeeName'),'') IS NOT NULL ORDER BY r.id,rev.ordinal,rev.id),
 records AS MATERIALIZED(
  SELECT r.id,r.company_id,r.employment_id,r.period,r.cycle_id,c.legal_name company_name,nullif(planned.planned_value->>'currency','') currency,
   coalesce(nullif(planned.planned_value->>'employeeNo',''),CASE WHEN e.company_id=r.company_id THEN e.employee_code END,'') employee_no,
   coalesce(nullif(btrim(planned.planned_value->>'employeeName'),''),retained_names.employee_name,'') employee_name,rev.cycle_name,rev.id revision_id,rev.snapshot_id,permissions.can_edit,permissions.can_remove,
   CASE WHEN rev.maintenance IS NOT NULL THEN NOT EXISTS(SELECT 1 FROM jsonb_each(rev.maintenance->'state'->'chains') chain WHERE chain.value->0->'item' IS NOT NULL AND chain.value->0->'item'<>'null'::jsonb AND nullif(chain.value->0->>'attemptId','') IS NOT NULL) ELSE rev.snapshot_id IS NULL OR baseline_batch.history_import_attempt_id IS NULL END withdrawn
  FROM scoped_records r JOIN permissions ON permissions.company_id=r.company_id
  JOIN public.company c ON c.id=r.company_id AND c.tenant_id=r.tenant_id
  JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  JOIN public.payroll_cycle cycle ON cycle.id=r.cycle_id AND cycle.tenant_id=r.tenant_id AND cycle.company_id=r.company_id
  JOIN current_revisions rev ON rev.record_id=r.id
  LEFT JOIN retained_names ON retained_names.id=r.id
  LEFT JOIN public.payslip baseline_slip ON baseline_slip.id=rev.snapshot_id AND baseline_slip.tenant_id=r.tenant_id
  LEFT JOIN public.payroll_batch baseline_batch ON baseline_batch.id=baseline_slip.batch_id AND baseline_batch.tenant_id=r.tenant_id
  JOIN attempts attempt ON attempt.id=rev.attempt_id
  LEFT JOIN planned ON planned.attempt_id=attempt.id AND planned.planned_value->>'companyId'=r.company_id::text AND planned.planned_value->>'employmentId'=r.employment_id::text AND planned.planned_value->>'period'=r.period AND planned.planned_value->>'cycleId'=r.cycle_id::text
  WHERE r.tenant_id=app.current_tenant_id() AND (p_record IS NULL OR r.id=p_record) AND (p_period IS NULL OR r.period=p_period)
   AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_record' AND h.row_id=r.id OR h.relation='payroll_history_import_attempt' AND h.row_id=attempt.id OR h.relation='payroll_history_import_snapshot' AND h.row_id=rev.snapshot_id)
 ), filtered AS MATERIALIZED(SELECT * FROM records r WHERE (p_withdrawn OR NOT r.withdrawn) AND (coalesce(btrim(p_search),'')='' OR position(lower(btrim(p_search)) IN lower(r.employee_no||' '||r.employee_name||' '||r.company_name||' '||r.cycle_name))>0)),
 page AS MATERIALIZED(SELECT * FROM filtered ORDER BY period DESC,company_id,employee_no,employment_id,cycle_id,id LIMIT p_limit OFFSET p_offset),
 batches AS MATERIALIZED(SELECT r.id record_id,b.id,b.released_at,b.needs_recalc_at FROM page r JOIN public.payroll_batch b ON b.tenant_id=app.current_tenant_id() AND b.company_id=r.company_id AND b.history_import_attempt_id IS NULL AND b.pay_period>=r.period AND left(b.pay_period,4)=left(r.period,4) WHERE NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_batch' AND h.row_id=b.id)),
 payroll_impact AS(SELECT b.record_id,count(*)::integer payroll,count(*) FILTER(WHERE b.released_at IS NOT NULL)::integer issued,count(*) FILTER(WHERE b.needs_recalc_at IS NOT NULL)::integer review FROM batches b GROUP BY b.record_id),
 payment_impact AS(SELECT b.record_id,count(DISTINCT event.id)::integer payment FROM batches b JOIN public.domain_event event ON event.tenant_id=app.current_tenant_id() AND event.aggregate_id=b.id AND event.event_type='payroll-batch.payment-summary.exported' GROUP BY b.record_id),
 report_impact AS(SELECT r.id record_id,count(DISTINCT report.id)::integer report FROM page r JOIN public.statutory_report report ON report.tenant_id=app.current_tenant_id() AND report.company_id=r.company_id AND (report.period_key=left(r.period,4) OR report.period_key>=r.period AND left(report.period_key,4)=left(r.period,4)) GROUP BY r.id),
 items AS(SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'companyId',r.company_id,'companyName',r.company_name,'employmentId',r.employment_id,'employeeNo',r.employee_no,'employeeName',r.employee_name,'period',r.period,'cycleId',r.cycle_id,'cycleName',r.cycle_name,'currency',r.currency,'currentRevisionId',r.revision_id,'withdrawn',r.withdrawn,'canEdit',r.can_edit,'canRemove',r.can_remove,'impactCounts',jsonb_build_object('payroll',coalesce(pi.payroll,0),'issued',coalesce(pi.issued,0),'review',coalesce(pi.review,0),'payment',coalesce(pay.payment,0),'report',coalesce(ri.report,0))) ORDER BY r.period DESC,r.company_id,r.employee_no,r.employment_id,r.cycle_id,r.id),'[]'::jsonb) value FROM page r LEFT JOIN payroll_impact pi ON pi.record_id=r.id LEFT JOIN payment_impact pay ON pay.record_id=r.id LEFT JOIN report_impact ri ON ri.record_id=r.id)
 SELECT jsonb_build_object('items',items.value,'total',(SELECT count(*) FROM filtered),'offset',p_offset,'limit',p_limit) INTO result FROM items;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_page(uuid,text,text,integer,integer,boolean,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_maintenance_page(uuid,text,text,integer,integer,boolean,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_maintenance_audit(p_record uuid,p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_record IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid imported history audit page' USING ERRCODE='22023';END IF;
 WITH hidden AS MATERIALIZED(SELECT s.relation,s.row_id FROM app.payroll_history_staged_row s JOIN app.payroll_history_stage stage ON stage.stage_id=s.stage_id WHERE stage.tenant_id=app.current_tenant_id() AND stage.state='staged'),
 subject AS MATERIALIZED(SELECT r.id FROM public.payroll_history_import_record r JOIN app.payroll_history_maintenance_permissions(NULL) permissions ON permissions.company_id=r.company_id AND permissions.can_edit WHERE r.id=p_record AND r.tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_record' AND h.row_id=r.id)),
 revisions AS MATERIALIZED(SELECT r.*,a.source_name FROM public.payroll_history_import_revision r JOIN subject ON subject.id=r.record_id JOIN public.payroll_history_import_attempt a ON a.id=r.attempt_id AND a.tenant_id=r.tenant_id WHERE r.tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_revision' AND h.row_id=r.id OR h.relation='payroll_history_import_attempt' AND h.row_id=a.id)),
 page AS MATERIALIZED(SELECT * FROM revisions ORDER BY ordinal DESC,id LIMIT p_limit),
 carrier AS MATERIALIZED(SELECT coalesce(jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)),'[]'::jsonb) value FROM app.current_grants() g),
 attempt_access AS MATERIALIZED(SELECT a.id,(a.created_by=app.current_user_id() OR cardinality(a.company_ids)>0) AND NOT EXISTS(SELECT 1 FROM unnest(a.company_ids) co WHERE NOT app.grants_payroll_admin_for(carrier.value,co)) allowed FROM public.payroll_history_import_attempt a JOIN(SELECT DISTINCT attempt_id FROM page) chosen ON chosen.attempt_id=a.id CROSS JOIN carrier WHERE a.tenant_id=app.current_tenant_id()),
 events AS MATERIALIZED(SELECT e.id,e.actor_id,e.attempt_id,change FROM public.payroll_history_import_event e JOIN(SELECT DISTINCT attempt_id FROM page) chosen ON chosen.attempt_id=e.attempt_id CROSS JOIN LATERAL jsonb_array_elements(e.changes) change WHERE e.tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_event' AND h.row_id=e.id)),
 actors AS(SELECT r.id,CASE WHEN count(DISTINCT e.actor_id)=1 THEN min(e.actor_id::text)::uuid ELSE NULL END actor_id FROM page r LEFT JOIN events e ON e.attempt_id=r.attempt_id AND e.change->>'recordId'=r.record_id::text AND (e.change->>'revisionId'=r.id::text OR r.kind='adopted' AND e.change->>'previousRevisionId'=r.id::text) GROUP BY r.id)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'ordinal',r.ordinal,'kind',r.kind,'operation',coalesce(r.maintenance->>'operation',r.kind),'reason',r.maintenance->>'reason','actorId',actors.actor_id,'at',r.created_at,'attemptId',r.attempt_id,'sourceName',CASE WHEN access.allowed THEN r.source_name ELSE '' END,'previousRevisionId',r.previous_revision_id,'snapshotId',r.snapshot_id) ORDER BY r.ordinal DESC,r.id) FROM page r JOIN actors ON actors.id=r.id JOIN attempt_access access ON access.id=r.attempt_id),'[]'::jsonb),'total',(SELECT count(*) FROM revisions)) INTO result;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_audit(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_maintenance_audit(uuid,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE INDEX payroll_history_record_maintenance_page_idx ON public.payroll_history_import_record(tenant_id,company_id,period DESC,employment_id,cycle_id,id);
