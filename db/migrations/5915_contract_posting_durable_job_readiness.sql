-- Kernel terminal cleanup intentionally clears input (5013); operation_key retains the admitted root event UUID.
-- Match the same exact native job/tenant/case/decision/released letter, without relying on personal input retention.
CREATE OR REPLACE FUNCTION app.contract_shared_postings_page(p_status text,p_company uuid,p_offset integer,p_limit integer,p_posting uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_status IS NULL OR p_offset IS NULL OR p_limit IS NULL OR p_status NOT IN('pending','approved','all') OR p_offset<0 OR p_offset>100000 OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid posting page' USING ERRCODE='22023';END IF;
 IF app.contract_verified_human(app.current_user_id()) IS NOT TRUE THEN RETURN jsonb_build_object('rows','[]'::jsonb,'total',0);END IF;
 WITH RECURSIVE posting_ready AS MATERIALIZED(
 SELECT r.posting_id,bool_and(j.state IN('completed','failed','cancelled')) ready
 FROM public.contract_shared_posting r JOIN public.personnel_posting pp ON pp.tenant_id=r.tenant_id AND pp.id=r.posting_id
 JOIN public.contract_shared_event ev ON ev.tenant_id=r.tenant_id AND ev.case_id=r.case_id AND ev.decision_revision=r.decision_revision AND ev.trigger_event='letterReleased' AND ev.data->>'letterId'=r.letter_id::text AND ev.created_at<=pp.created_at
 JOIN public.bulk_job j ON j.tenant_id=ev.tenant_id AND j.id=ev.job_id AND j.kind='contract_automation' AND j.operation_key=coalesce(ev.root_event_id,ev.id)
 WHERE r.tenant_id=app.current_tenant_id() GROUP BY r.posting_id
 ),admin_scopes(id) AS (
  SELECT co.id FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=co.tenant_id AND r.app_user_id=app.current_user_id() AND r.role::text IN('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=co.id))
  UNION SELECT co.id FROM public.company co JOIN admin_scopes parent ON co.parent_company_id=parent.id WHERE co.tenant_id=app.current_tenant_id()
 ), admin_ids AS MATERIALIZED(SELECT array_agg(id) ids FROM admin_scopes),
 groups AS MATERIALIZED(SELECT g FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'groups','[]'::jsonb)) g WHERE v.tenant_id=app.current_tenant_id()),
 system_admin AS MATERIALIZED(SELECT app.access_capability_allowed('access.system_admin',NULL) allowed),
 entitled AS MATERIALIZED(SELECT co.id FROM public.company co JOIN public.tenant t ON t.id=co.tenant_id WHERE co.tenant_id=app.current_tenant_id() AND t.status IN('active','trial')
 AND EXISTS(SELECT 1 FROM public.tenant_module tm WHERE tm.tenant_id=co.tenant_id AND tm.module_code='lifecycle' AND tm.status IN('active','trial') AND (tm.expires_at IS NULL OR tm.expires_at>now()) AND (tm.company_id IS NULL OR tm.company_id=co.id))),
 selected AS MATERIALIZED(
 SELECT p.*,r.applied_at AS movement_applied_at,c.number AS case_number,CASE WHEN e.person_id=r.subject_person_id AND e.company_id=p.company_id THEN e.employee_code END AS employee_code,per.full_name,co.legal_name,
 e.person_id=r.subject_person_id AS subject_current,e.person_id=r.subject_person_id AND e.company_id=p.company_id AS source_current,
 coalesce(ready.ready,false) AS workflow_ready,f.revision AS case_revision,f.data->>'stage' AS case_stage,coalesce(f.data->'decision'->'payChanges'='true'::jsonb,false) AS pay_needed,g.g->>'name' AS group_name
 FROM public.personnel_posting p JOIN public.contract_shared_posting r ON r.tenant_id=p.tenant_id AND r.posting_id=p.id
 JOIN public.contract_case c ON c.tenant_id=p.tenant_id AND c.id=p.source_ref JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
 JOIN public.employment e ON e.tenant_id=p.tenant_id AND e.id=p.employment_id JOIN public.person per ON per.tenant_id=e.tenant_id AND per.id=r.subject_person_id
 JOIN public.company co ON co.tenant_id=p.tenant_id AND co.id=p.company_id JOIN entitled ok ON ok.id=co.id
 LEFT JOIN posting_ready ready ON ready.posting_id=p.id
 LEFT JOIN public.contract_shared_settings settings ON settings.tenant_id=p.tenant_id AND settings.company_id=p.company_id
 LEFT JOIN public.lc_v9_config v ON v.tenant_id=p.tenant_id LEFT JOIN groups g ON g.g->>'id'=coalesce(settings.posting_group_id,v.data->>'peopleOpsGroup')
 WHERE p.tenant_id=app.current_tenant_id() AND p.source='contract_staff' AND (p_status='all' OR p.status=p_status) AND (p_company IS NULL OR p.company_id=p_company) AND (p_posting IS NULL OR p.id=p_posting)
 AND ((SELECT allowed FROM system_admin) OR p.company_id=ANY(coalesce((SELECT ids FROM admin_ids),'{}'::uuid[])) OR g.g->'members' ? app.current_user_id()::text)
 ), paged AS(SELECT * FROM selected ORDER BY created_at DESC,number DESC LIMIT p_limit OFFSET p_offset)
 SELECT jsonb_build_object('total',(SELECT count(*) FROM selected),'rows',coalesce(jsonb_agg(jsonb_build_object(
 'id',p.id,'number',p.number,'label','PP-'||p.number::text,'companyId',p.company_id,'companyName',p.legal_name,'employmentId',p.employment_id,'employeeName',p.full_name,'employeeCode',p.employee_code,
 'caseId',p.source_ref,'caseNumber',p.case_number,'eventType',p.event_type,'proposed',p.proposed,'edited',p.edited,'current',coalesce(p.applied,p.edited,p.proposed),'status',p.status,'revision',p.revision,
 'approverGroupName',p.group_name,'createdAt',p.created_at,'editedAt',p.edited_at,'approvedAt',p.approved_at,'movementAppliedAt',p.movement_applied_at,
 'canApprove',p.status='pending' AND p.source_current AND p.workflow_ready,'canEdit',p.status='pending' AND p.source_current,'caseRevision',p.case_revision,'sourceCurrent',p.source_current,'workflowReady',p.workflow_ready,
 'canConfirmPay',p.status='approved' AND p.case_stage='pay' AND p.pay_needed AND p.subject_current,'payChanges',p.pay_needed
 ) ORDER BY p.created_at DESC,p.number DESC),'[]'::jsonb)) INTO result FROM paged p;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_postings_page(text,uuid,integer,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_postings_page(text,uuid,integer,integer,uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_posting_workflow_ready(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(bool_and(j.state IN('completed','failed','cancelled')),false)
 FROM public.contract_shared_posting r JOIN public.personnel_posting pp ON pp.tenant_id=r.tenant_id AND pp.id=r.posting_id
 JOIN public.contract_shared_event ev ON ev.tenant_id=r.tenant_id AND ev.case_id=r.case_id AND ev.decision_revision=r.decision_revision AND ev.trigger_event='letterReleased' AND ev.data->>'letterId'=r.letter_id::text AND ev.created_at<=pp.created_at
 JOIN public.bulk_job j ON j.tenant_id=ev.tenant_id AND j.id=ev.job_id AND j.kind='contract_automation' AND j.operation_key=coalesce(ev.root_event_id,ev.id)
 WHERE r.tenant_id=app.current_tenant_id() AND r.posting_id=p_id
$$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_workflow_ready(uuid) FROM PUBLIC,ai_hr_app;
