-- Purpose-limited posting queue. NO current/agreed salary, decision JSON, pay attester identity, or signing policy.
-- Resolve actual administrative scopes and current assignment-group membership once, never per posting.
CREATE FUNCTION app.contract_shared_postings_page(p_status text,p_company uuid,p_offset integer,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_status NOT IN('pending','approved','all') OR p_offset<0 OR p_offset>100000 OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid posting page' USING ERRCODE='22023';END IF;
 IF app.contract_verified_human(app.current_user_id()) IS NOT TRUE THEN RETURN jsonb_build_object('rows','[]'::jsonb,'total',0);END IF;
 WITH RECURSIVE admin_scopes(id) AS (
  SELECT co.id FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=co.tenant_id AND r.app_user_id=app.current_user_id() AND r.role::text IN('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=co.id))
  UNION SELECT co.id FROM public.company co JOIN admin_scopes parent ON co.parent_company_id=parent.id WHERE co.tenant_id=app.current_tenant_id()
 ), admin_ids AS MATERIALIZED(SELECT array_agg(id) ids FROM admin_scopes),
 groups AS MATERIALIZED(SELECT g FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'groups','[]'::jsonb)) g WHERE v.tenant_id=app.current_tenant_id()),
 system_admin AS MATERIALIZED(SELECT app.access_capability_allowed('access.system_admin',NULL) allowed),
 entitled AS MATERIALIZED(SELECT co.id FROM public.company co JOIN public.tenant t ON t.id=co.tenant_id WHERE co.tenant_id=app.current_tenant_id() AND t.status IN('active','trial')
 AND EXISTS(SELECT 1 FROM public.tenant_module tm WHERE tm.tenant_id=co.tenant_id AND tm.module_code='lifecycle' AND tm.status IN('active','trial') AND (tm.expires_at IS NULL OR tm.expires_at>now()) AND (tm.company_id IS NULL OR tm.company_id=co.id))),
 selected AS MATERIALIZED(
 SELECT p.*,r.applied_at AS movement_applied_at,c.number AS case_number,e.employee_code,per.full_name,co.legal_name,
 f.revision AS case_revision,f.data->>'stage' AS case_stage,coalesce(f.data->'decision'->'payChanges'='true'::jsonb,false) AS pay_needed,g.g->>'name' AS group_name
 FROM public.personnel_posting p JOIN public.contract_shared_posting r ON r.tenant_id=p.tenant_id AND r.posting_id=p.id
 JOIN public.contract_case c ON c.tenant_id=p.tenant_id AND c.id=p.source_ref JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
 JOIN public.employment e ON e.tenant_id=p.tenant_id AND e.id=p.employment_id JOIN public.person per ON per.tenant_id=e.tenant_id AND per.id=e.person_id
 JOIN public.company co ON co.tenant_id=p.tenant_id AND co.id=p.company_id JOIN entitled ok ON ok.id=co.id
 LEFT JOIN public.contract_shared_settings settings ON settings.tenant_id=p.tenant_id AND settings.company_id=p.company_id
 LEFT JOIN public.lc_v9_config v ON v.tenant_id=p.tenant_id LEFT JOIN groups g ON g.g->>'id'=coalesce(settings.posting_group_id,v.data->>'peopleOpsGroup')
 WHERE p.tenant_id=app.current_tenant_id() AND p.source='contract_staff' AND (p_status='all' OR p.status=p_status) AND (p_company IS NULL OR p.company_id=p_company)
 AND ((SELECT allowed FROM system_admin) OR p.company_id=ANY(coalesce((SELECT ids FROM admin_ids),'{}'::uuid[])) OR g.g->'members' ? app.current_user_id()::text)
 ), paged AS(SELECT * FROM selected ORDER BY created_at DESC,number DESC LIMIT p_limit OFFSET p_offset)
 SELECT jsonb_build_object('total',(SELECT count(*) FROM selected),'rows',coalesce(jsonb_agg(jsonb_build_object(
 'id',p.id,'number',p.number,'label','PP-'||p.number::text,'companyId',p.company_id,'companyName',p.legal_name,'employmentId',p.employment_id,'employeeName',p.full_name,'employeeCode',p.employee_code,
 'caseId',p.source_ref,'caseNumber',p.case_number,'eventType',p.event_type,'proposed',p.proposed,'edited',p.edited,'current',coalesce(p.applied,p.edited,p.proposed),'status',p.status,'revision',p.revision,
 'approverGroupName',p.group_name,'createdAt',p.created_at,'editedAt',p.edited_at,'approvedAt',p.approved_at,'movementAppliedAt',p.movement_applied_at,
 'canApprove',p.status='pending','canEdit',p.status='pending','caseRevision',p.case_revision,
 'canConfirmPay',p.status='approved' AND p.case_stage='pay' AND p.pay_needed,'payChanges',p.pay_needed
 ) ORDER BY p.created_at DESC,p.number DESC),'[]'::jsonb)) INTO result FROM paged p;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_postings_page(text,uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_postings_page(text,uuid,integer,integer) TO ai_hr_app;
--> statement-breakpoint
-- Corrections remain pending. Approval still compares dates/counter to the released immutable agreement.
ALTER FUNCTION app.personnel_posting_edit(uuid,integer,jsonb) RENAME TO personnel_posting_edit_before_contract;
CREATE FUNCTION app.personnel_posting_edit(p_id uuid,p_revision integer,p_values jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;
BEGIN
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF p.source IS DISTINCT FROM 'contract_staff' THEN RETURN app.personnel_posting_edit_before_contract(p_id,p_revision,p_values);END IF;
 PERFORM app.access_workforce_write_lock();
 IF app.contract_shared_posting_approver(p.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Only Contract posting approvers can correct these values' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=p.tenant_id AND id=p.id FOR UPDATE;
 IF p.status<>'pending' OR p.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This posting changed' USING ERRCODE='40001';END IF;
 IF app.personnel_posting_values_ok(p.event_type,p_values) IS NOT TRUE THEN RAISE EXCEPTION 'Check the posting dates and contract number' USING ERRCODE='22023';END IF;
 IF coalesce(p.edited,p.proposed)=p_values THEN RETURN p.revision;END IF;
 UPDATE public.personnel_posting SET edited=p_values,edited_by=app.current_user_id(),edited_at=now(),revision=revision+1 WHERE tenant_id=p.tenant_id AND id=p.id;
 PERFORM app.contract_audit(p.source_ref,'shared.posting_edited',jsonb_build_object('postingId',p.id,'before',coalesce(p.edited,p.proposed),'after',p_values));
 RETURN p.revision+1;
END $$;
REVOKE ALL ON FUNCTION app.personnel_posting_edit_before_contract(uuid,integer,jsonb) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.personnel_posting_edit(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_posting_edit(uuid,integer,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- An open reminder/next-period case or a separately outstanding pay attestation never locks the native counter.
CREATE OR REPLACE FUNCTION app.contract_shared_number_locked(p_employment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_case c LEFT JOIN public.contract_shared_case s ON s.tenant_id=c.tenant_id AND s.case_id=c.id
 WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=p_employment
 AND (s.case_id IS NOT NULL AND s.data->'decision'<>'null'::jsonb AND s.data->>'stage' NOT IN('renewed','converted','offboarding','superseded') AND coalesce(s.data->'posting'->'approvedAt','null'::jsonb)='null'::jsonb
 OR s.case_id IS NULL AND c.data->'decision' IS DISTINCT FROM 'null'::jsonb AND c.data->>'state' NOT IN('renewed','handed_off','cancelled')))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_renewal_open(wanted_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_case c LEFT JOIN public.contract_shared_case s ON s.tenant_id=c.tenant_id AND s.case_id=c.id
 WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=wanted_employment AND
 (s.case_id IS NULL AND c.data->>'state' NOT IN('renewed','handed_off','cancelled') OR s.case_id IS NOT NULL AND s.data->'decision'<>'null'::jsonb
 AND s.data->>'stage' NOT IN('renewed','converted','offboarding','superseded') AND coalesce(s.data->'posting'->'approvedAt','null'::jsonb)='null'::jsonb))
$$;
