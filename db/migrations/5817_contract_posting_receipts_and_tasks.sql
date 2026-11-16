-- Forward refinements: one set-based scope for queue/tasks and idempotent canonical posting receipts.
CREATE FUNCTION app.contract_shared_posting_scope() RETURNS TABLE(company_id uuid,group_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE admin_scopes(id) AS (
 SELECT co.id FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=co.tenant_id AND r.app_user_id=app.current_user_id() AND r.role::text IN('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=co.id))
 UNION SELECT co.id FROM public.company co JOIN admin_scopes parent ON co.parent_company_id=parent.id WHERE co.tenant_id=app.current_tenant_id()
 ), admin_ids AS MATERIALIZED(SELECT array_agg(id) ids FROM admin_scopes),
 groups AS MATERIALIZED(SELECT g->>'id' id,min(g->>'name') name,bool_or(g->'members' ? app.current_user_id()::text) member
 FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'groups','[]'::jsonb)) g WHERE v.tenant_id=app.current_tenant_id() GROUP BY g->>'id'),
 principal AS MATERIALIZED(SELECT app.contract_verified_human(app.current_user_id()) human,app.access_capability_allowed('access.system_admin',NULL) system_admin)
 SELECT co.id,g.name FROM public.company co JOIN public.tenant t ON t.id=co.tenant_id
 LEFT JOIN public.contract_shared_settings s ON s.tenant_id=co.tenant_id AND s.company_id=co.id
 LEFT JOIN public.lc_v9_config v ON v.tenant_id=co.tenant_id LEFT JOIN groups g ON g.id=coalesce(s.posting_group_id,v.data->>'peopleOpsGroup')
 CROSS JOIN principal me WHERE co.tenant_id=app.current_tenant_id() AND me.human AND t.status IN('active','trial')
 AND EXISTS(SELECT 1 FROM public.tenant_module tm WHERE tm.tenant_id=co.tenant_id AND tm.module_code='lifecycle' AND tm.status IN('active','trial') AND (tm.expires_at IS NULL OR tm.expires_at>now()) AND (tm.company_id IS NULL OR tm.company_id=co.id))
 AND (me.system_admin OR co.id=ANY(coalesce((SELECT ids FROM admin_ids),'{}'::uuid[])) OR g.member)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_scope() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_tasks(p_companies uuid[]) RETURNS TABLE(id text,kind text,subject_name text,created_at timestamptz,link_path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH scope AS MATERIALIZED(SELECT * FROM app.contract_shared_posting_scope()),tasks AS(
 SELECT p.id::text||CASE p.status WHEN 'pending' THEN ':posting' ELSE ':pay' END id,
 CASE p.status WHEN 'pending' THEN 'contractPosting' ELSE 'contractPay' END kind,per.full_name subject_name,
 CASE p.status WHEN 'pending' THEN p.created_at ELSE p.approved_at END created_at,
 '/lifecycle/contracts/postings?status='||p.status||'#posting-'||p.id::text link_path
 FROM public.personnel_posting p JOIN scope s ON s.company_id=p.company_id
 JOIN public.contract_shared_posting r ON r.tenant_id=p.tenant_id AND r.posting_id=p.id
 JOIN public.employment e ON e.tenant_id=p.tenant_id AND e.id=p.employment_id AND e.person_id=r.subject_person_id
 JOIN public.person per ON per.tenant_id=e.tenant_id AND per.id=e.person_id
 JOIN public.contract_shared_case f ON f.tenant_id=p.tenant_id AND f.case_id=p.source_ref
 WHERE p.tenant_id=app.current_tenant_id() AND p.source='contract_staff' AND (p_companies IS NULL OR p.company_id=ANY(p_companies))
 AND (p.status='pending' OR p.status='approved' AND f.data->>'stage'='pay' AND f.data->'decision'->'payChanges'='true'::jsonb
 AND coalesce(f.data->'payConfirmation','null'::jsonb)='null'::jsonb AND p.movement_id IS NOT NULL)
 ) SELECT * FROM tasks ORDER BY created_at,id
$$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_tasks(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_tasks(uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- Checked before this addition: no contract_shared_posting_read definition exists in5814–5817.
-- Actual-actor authority is explicit in both row visibility and each action capability. The native
-- predicate checks app.current_user_id(), verified login/person and current approver-group/admin scope.
-- Source identity is a separate stale-data hint, never a grant. No salary/decision body is returned.
CREATE FUNCTION app.contract_shared_posting_read(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',p.id,'number',p.number,'label','PP-'||p.number::text,'companyId',p.company_id,'companyName',co.legal_name,
 'employmentId',p.employment_id,'employeeName',per.full_name,'employeeCode',CASE WHEN e.person_id=r.subject_person_id THEN e.employee_code ELSE NULL END,
 'caseId',p.source_ref,'caseNumber',c.number,'eventType',p.event_type,'proposed',p.proposed,'edited',p.edited,'current',coalesce(p.applied,p.edited,p.proposed),
 'status',p.status,'revision',p.revision,'approverGroupName',(SELECT s.group_name FROM app.contract_shared_posting_scope() s WHERE s.company_id=p.company_id),
 'createdAt',p.created_at,'editedAt',p.edited_at,'approvedAt',p.approved_at,'movementAppliedAt',r.applied_at,
 'canApprove',app.contract_shared_posting_approver(p.company_id) IS TRUE AND p.status='pending',
 'canEdit',app.contract_shared_posting_approver(p.company_id) IS TRUE AND p.status='pending','caseRevision',f.revision,
 'canConfirmPay',app.contract_shared_posting_approver(p.company_id) IS TRUE AND p.status='approved' AND f.data->>'stage'='pay' AND f.data->'decision'->'payChanges'='true'::jsonb,
 'sourceCurrent',e.person_id=r.subject_person_id AND e.company_id=p.company_id,
 'payChanges',coalesce(f.data->'decision'->'payChanges'='true'::jsonb,false))
 FROM public.personnel_posting p JOIN public.contract_shared_posting r ON r.tenant_id=p.tenant_id AND r.posting_id=p.id
 JOIN public.contract_case c ON c.tenant_id=p.tenant_id AND c.id=p.source_ref JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
 JOIN public.employment e ON e.tenant_id=p.tenant_id AND e.id=p.employment_id JOIN public.person per ON per.tenant_id=r.tenant_id AND per.id=r.subject_person_id
 JOIN public.company co ON co.tenant_id=p.tenant_id AND co.id=p.company_id
 WHERE p.tenant_id=app.current_tenant_id() AND p.id=p_id AND p.source='contract_staff'
 AND app.contract_shared_posting_approver(p.company_id) IS TRUE
$$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_read(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_read(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Follow the existing canonical writer lock family before taking any Employment/flow write lock.
CREATE FUNCTION app.contract_shared_posting_prelock(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF p.id IS NULL OR p.source<>'contract_staff' OR (app.contract_shared_posting_approver(p.company_id) OR p.status='approved' AND app.access_workforce_employment(p.employment_id,'workforce.maintain')) IS NOT TRUE THEN RAISE EXCEPTION 'Contract posting application unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||p.tenant_id::text,0));
 PERFORM statutory.id FROM public.employee_statutory_my statutory JOIN public.employment e ON e.tenant_id=statutory.tenant_id AND e.person_id=statutory.person_id
 WHERE e.tenant_id=p.tenant_id AND e.id=p.employment_id FOR UPDATE OF statutory;
 PERFORM 1 FROM public.employment e WHERE e.tenant_id=p.tenant_id AND e.id=p.employment_id FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_prelock(uuid) FROM PUBLIC,ai_hr_app;
ALTER FUNCTION app.contract_shared_posting_intent(uuid) RENAME TO contract_shared_posting_intent_before_source_lock;
CREATE FUNCTION app.contract_shared_posting_intent(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;remark text;
BEGIN
 PERFORM app.contract_shared_posting_prelock(p_id);
 result:=app.contract_shared_posting_intent_before_source_lock(p_id);
 SELECT coalesce(nullif(btrim(p.applied->>'remarks'),''),'Personnel posting PP-'||p.number::text) INTO remark FROM public.personnel_posting p WHERE p.tenant_id=app.current_tenant_id() AND p.id=p_id;
 RETURN result||jsonb_build_object('remarks',remark);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_intent_before_source_lock(uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.contract_shared_posting_intent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_intent(uuid) TO ai_hr_app;
ALTER FUNCTION app.contract_shared_posting_approve(uuid,integer,jsonb) RENAME TO contract_shared_posting_approve_before_source_lock;
CREATE FUNCTION app.contract_shared_posting_approve(p_id uuid,p_revision integer,p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;
BEGIN
 PERFORM app.contract_shared_posting_prelock(p_id);
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF app.contract_shared_posting_approver(p.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Only the actual Contract posting approver group can approve' USING ERRCODE='42501';END IF;
 IF p.status='approved' AND p.movement_id IS NOT NULL THEN
  IF p_revision NOT IN(p.revision,p.revision-1) OR p_values IS NOT NULL AND p_values IS DISTINCT FROM p.applied THEN RAISE EXCEPTION 'The approved posting is fixed' USING ERRCODE='40001';END IF;
  RETURN jsonb_build_object('duplicate',true,'alreadyApplied',true,'movementId',p.movement_id,'id',p.id,'number',p.number,'employmentId',p.employment_id,'eventType',p.event_type,'values',p.applied);
 END IF;
 RETURN app.contract_shared_posting_approve_before_source_lock(p_id,p_revision,p_values);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_approve_before_source_lock(uuid,integer,jsonb) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.contract_shared_posting_approve(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_approve(uuid,integer,jsonb) TO ai_hr_app;

--> statement-breakpoint
-- A due movement must retain the original approved scheduled group; another group cannot claim its receipt.
CREATE OR REPLACE FUNCTION app.contract_shared_posting_applied(p_posting uuid,p_group uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i public.contract_shared_posting_tx;r public.contract_shared_posting;e public.employment;
BEGIN
 SELECT * INTO i FROM public.contract_shared_posting_tx WHERE tenant_id=app.current_tenant_id() AND posting_id=p_posting AND transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user AND actor_user_id IS NOT DISTINCT FROM app.current_user_id() AND NOT consumed FOR UPDATE;
 IF i.employment_id IS NULL THEN RAISE EXCEPTION 'Current Contract movement intent required' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM public.contract_shared_posting WHERE tenant_id=i.tenant_id AND posting_id=i.posting_id;
 SELECT * INTO e FROM public.employment WHERE tenant_id=i.tenant_id AND id=i.employment_id;
 IF p_group IS NULL OR (r.movement_group_id IS NOT NULL AND r.movement_group_id IS DISTINCT FROM p_group) OR to_jsonb(e) IS DISTINCT FROM i.old_employment||i.desired OR i.effective_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 OR (i.kind='contractConversion' AND NOT EXISTS(SELECT 1 FROM public.assignment a WHERE a.tenant_id=i.tenant_id AND a.employment_id=i.employment_id AND a.employment_type='full_time' AND a.valid_from=i.effective_on AND a.valid_to IS NULL AND a.superseded_at IS NULL))
 OR NOT EXISTS(SELECT 1 FROM public.domain_event d WHERE d.tenant_id=i.tenant_id AND d.subject_employment_id=i.employment_id AND d.occurred_at=now() AND d.payload->'movement'->>'groupId'=p_group::text AND d.payload->'movement'->>'type'=i.kind) THEN RAISE EXCEPTION 'The canonical Contract movement did not apply the agreed values' USING ERRCODE='23514';END IF;
 UPDATE public.contract_shared_posting SET applied_at=now(),movement_group_id=p_group WHERE tenant_id=i.tenant_id AND posting_id=i.posting_id;
 UPDATE public.contract_shared_posting_tx SET consumed=true WHERE tenant_id=i.tenant_id AND transaction_id=i.transaction_id AND backend_pid=i.backend_pid AND employment_id=i.employment_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_applied(uuid,uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_applied(uuid,uuid) TO ai_hr_app;
