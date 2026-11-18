-- Source-bound native conversion bookkeeping and bounded Contract posting work.
-- Business Employment/Assignment writes remain app-role canonical Movement writes.
ALTER TABLE public.contract_shared_posting_tx ADD COLUMN criteria_locked boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_criteria_held(p_tenant uuid,p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p_tenant=app.current_tenant_id() AND p_kind IN('department','position','cost_center','business_unit') AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM public.contract_shared_posting_tx i WHERE i.tenant_id=p_tenant AND i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid() AND i.login_name=session_user AND i.actor_user_id IS NOT DISTINCT FROM app.current_user_id() AND i.kind='contractConversion' AND NOT i.consumed AND i.criteria_locked),false)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_criteria_held(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_criteria_held(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lock_system_label_criteria(p_tenant uuid,p_kind text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF p_kind NOT IN ('department','position','cost_center','business_unit') OR p_tenant IS NULL THEN
    RAISE EXCEPTION 'Invalid label criteria identity' USING ERRCODE='23514';
  END IF;
  IF app.current_tenant_id() IS NOT NULL AND app.current_tenant_id() <> p_tenant THEN
    RAISE EXCEPTION 'Label tenant mismatch' USING ERRCODE='42501';
  END IF;
  -- The approved fixed conversion already holds these native epoch rows in this exact transaction.
  IF app.contract_shared_posting_criteria_held(p_tenant,p_kind) THEN RETURN;END IF;
  INSERT INTO public.system_label_criteria_epoch(tenant_id,label_kind) VALUES(p_tenant,p_kind) ON CONFLICT DO NOTHING;
  UPDATE public.system_label_criteria_epoch SET revision=revision+1 WHERE tenant_id=p_tenant AND label_kind=p_kind;
END $$;
--> statement-breakpoint
ALTER FUNCTION app.contract_shared_posting_intent(uuid) RENAME TO contract_shared_posting_intent_before_criteria;
CREATE FUNCTION app.contract_shared_posting_intent(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;i public.contract_shared_posting_tx;v_kind text;v_id uuid;v_company uuid;v_allowed boolean;
BEGIN
 result:=app.contract_shared_posting_intent_before_criteria(p_id);
 IF result->'completed'='true'::jsonb OR result->>'kind'<>'contractConversion' THEN RETURN result;END IF;
 SELECT * INTO i FROM public.contract_shared_posting_tx x WHERE x.tenant_id=app.current_tenant_id() AND x.posting_id=p_id AND x.transaction_id=txid_current() AND x.backend_pid=pg_backend_pid() AND x.login_name=session_user AND x.actor_user_id IS NOT DISTINCT FROM app.current_user_id() AND NOT x.consumed AND x.kind='contractConversion';
 IF i.employment_id IS NULL THEN RAISE EXCEPTION 'Exact approved conversion intent required' USING ERRCODE='42501';END IF;
 UPDATE public.contract_shared_posting_tx SET criteria_locked=false WHERE tenant_id=i.tenant_id AND transaction_id=i.transaction_id AND backend_pid=i.backend_pid AND employment_id=i.employment_id;
 -- Only coordination rows use the native owner here; no Personnel, Payroll or organisation fact is written.
 PERFORM app.lock_system_label_criteria(i.tenant_id,'department');
 PERFORM app.lock_system_label_criteria(i.tenant_id,'position');
 PERFORM app.lock_system_label_criteria(i.tenant_id,'cost_center');
 PERFORM app.lock_system_label_criteria(i.tenant_id,'business_unit');
 v_company:=coalesce(i.old_assignment->>'company_id',i.old_employment->>'company_id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.company WHERE id=v_company AND tenant_id=i.tenant_id) THEN RAISE EXCEPTION 'Assignment company must belong to the same tenant' USING ERRCODE='23514';END IF;
 -- Same native 0550 criteria check, over the exact frozen carry-forward references while all four locks hold.
 FOR v_kind,v_id IN SELECT * FROM (VALUES('department',(i.old_assignment->>'department_id')::uuid),('position',(i.old_assignment->>'position_id')::uuid),('cost_center',(i.old_assignment->>'cost_center_id')::uuid),('business_unit',(i.old_assignment->>'business_unit_id')::uuid)) refs(kind,id) LOOP
  IF v_id IS NULL THEN CONTINUE;END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I label WHERE label.id=$1 AND label.tenant_id=$2 AND (label.is_global OR EXISTS(SELECT 1 FROM public.label_company_assignment lca WHERE lca.label_id=label.id AND lca.tenant_id=label.tenant_id AND lca.label_kind=$3 AND lca.company_id=$4)))',v_kind)
  INTO v_allowed USING v_id,i.tenant_id,v_kind,v_company;
  IF NOT v_allowed THEN RAISE EXCEPTION 'Assignment label Criteria do not include its recorded company' USING ERRCODE='23514';END IF;
 END LOOP;
 UPDATE public.contract_shared_posting_tx SET criteria_locked=true WHERE tenant_id=i.tenant_id AND transaction_id=i.transaction_id AND backend_pid=i.backend_pid AND employment_id=i.employment_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_intent_before_criteria(uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.contract_shared_posting_intent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_intent(uuid) TO ai_hr_app;
--> statement-breakpoint
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
 JOIN public.bulk_job j ON j.tenant_id=ev.tenant_id AND j.id=ev.job_id AND j.kind='contract_automation' AND j.input->>'eventId'=coalesce(ev.root_event_id,ev.id)::text
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
CREATE OR REPLACE FUNCTION app.contract_shared_postings_page(p_status text,p_company uuid,p_offset integer,p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_postings_page(p_status,p_company,p_offset,p_limit,NULL::uuid)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_posting_tasks(p_companies uuid[]) RETURNS TABLE(id text,kind text,subject_name text,created_at timestamptz,link_path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH scope AS MATERIALIZED(SELECT * FROM app.contract_shared_posting_scope()),tasks AS(
 SELECT p.id::text||CASE p.status WHEN 'pending' THEN ':posting' ELSE ':pay' END id,
 CASE p.status WHEN 'pending' THEN 'contractPosting' ELSE 'contractPay' END kind,per.full_name subject_name,
 CASE p.status WHEN 'pending' THEN p.created_at ELSE p.approved_at END created_at,
 '/lifecycle/contracts/postings?status='||p.status||'&postingId='||p.id::text||'#posting-'||p.id::text link_path
 FROM public.personnel_posting p JOIN scope s ON s.company_id=p.company_id
 JOIN public.contract_shared_posting r ON r.tenant_id=p.tenant_id AND r.posting_id=p.id
 JOIN public.employment e ON e.tenant_id=p.tenant_id AND e.id=p.employment_id AND e.person_id=r.subject_person_id
 JOIN public.person per ON per.tenant_id=e.tenant_id AND per.id=e.person_id
 JOIN public.contract_shared_case f ON f.tenant_id=p.tenant_id AND f.case_id=p.source_ref
 WHERE p.tenant_id=app.current_tenant_id() AND p.source='contract_staff' AND (p_companies IS NULL OR p.company_id=ANY(p_companies))
 AND (p.status='pending' AND e.company_id=p.company_id OR p.status='approved' AND f.data->>'stage'='pay' AND f.data->'decision'->'payChanges'='true'::jsonb
 AND coalesce(f.data->'payConfirmation','null'::jsonb)='null'::jsonb AND p.movement_id IS NOT NULL)
 ) SELECT * FROM tasks ORDER BY created_at,id
$$;
-- The unbounded set is now private to the counted/page reader below.
REVOKE ALL ON FUNCTION app.contract_shared_posting_tasks(uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_work_page(p_companies uuid[],p_offset integer,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_offset IS NULL OR p_limit IS NULL OR p_offset NOT BETWEEN 0 AND 100000 OR p_limit NOT BETWEEN 1 AND 100 OR cardinality(p_companies)>1000 OR array_position(p_companies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'Invalid Contract posting work page' USING ERRCODE='22023';END IF;
 WITH tasks AS MATERIALIZED(SELECT * FROM app.contract_shared_posting_tasks(p_companies)),paged AS(SELECT * FROM tasks ORDER BY created_at,id LIMIT p_limit OFFSET p_offset)
 SELECT jsonb_build_object('total',(SELECT count(*) FROM tasks),'items',coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'subjectName',subject_name,'createdAt',created_at,'linkPath',link_path) ORDER BY created_at,id),'[]'::jsonb)) INTO result FROM paged;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_work_page(uuid[],integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_work_page(uuid[],integer,integer) TO ai_hr_app;

--> statement-breakpoint
-- Applying Personnel must wait until the causative kernel job is quiescent. Its period then stays
-- current for the entire accepted workflow, including any child notification units. No worker authority widens.
CREATE FUNCTION app.contract_shared_posting_workflow_ready(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(bool_and(j.state IN('completed','failed','cancelled')),false)
 FROM public.contract_shared_posting r JOIN public.personnel_posting pp ON pp.tenant_id=r.tenant_id AND pp.id=r.posting_id
 JOIN public.contract_shared_event ev ON ev.tenant_id=r.tenant_id AND ev.case_id=r.case_id AND ev.decision_revision=r.decision_revision AND ev.trigger_event='letterReleased' AND ev.data->>'letterId'=r.letter_id::text AND ev.created_at<=pp.created_at
 JOIN public.bulk_job j ON j.tenant_id=ev.tenant_id AND j.id=ev.job_id AND j.kind='contract_automation' AND j.input->>'eventId'=coalesce(ev.root_event_id,ev.id)::text
 WHERE r.tenant_id=app.current_tenant_id() AND r.posting_id=p_id
$$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_workflow_ready(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.contract_shared_posting_approve(uuid,integer,jsonb) RENAME TO contract_shared_posting_approve_before_workflow_finish;
CREATE FUNCTION app.contract_shared_posting_approve(p_id uuid,p_revision integer,p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;
BEGIN
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF p.source='contract_staff' AND app.contract_shared_posting_approver(p.company_id) IS TRUE AND p.status='pending' AND app.contract_shared_posting_workflow_ready(p.id) IS NOT TRUE THEN RAISE EXCEPTION 'Wait for the shared workflow to finish before approving its Personnel posting' USING ERRCODE='40001';END IF;
 RETURN app.contract_shared_posting_approve_before_workflow_finish(p_id,p_revision,p_values);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_approve_before_workflow_finish(uuid,integer,jsonb) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.contract_shared_posting_approve(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_approve(uuid,integer,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_posting_read(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',p.id,'number',p.number,'label','PP-'||p.number::text,'companyId',p.company_id,'companyName',co.legal_name,
 'employmentId',p.employment_id,'employeeName',per.full_name,'employeeCode',CASE WHEN e.person_id=r.subject_person_id THEN e.employee_code ELSE NULL END,
 'caseId',p.source_ref,'caseNumber',c.number,'eventType',p.event_type,'proposed',p.proposed,'edited',p.edited,'current',coalesce(p.applied,p.edited,p.proposed),
 'status',p.status,'revision',p.revision,'approverGroupName',(SELECT s.group_name FROM app.contract_shared_posting_scope() s WHERE s.company_id=p.company_id),
 'createdAt',p.created_at,'editedAt',p.edited_at,'approvedAt',p.approved_at,'movementAppliedAt',r.applied_at,
 'workflowReady',app.contract_shared_posting_workflow_ready(p.id),'canApprove',app.contract_shared_posting_approver(p.company_id) IS TRUE AND p.status='pending' AND app.contract_shared_posting_workflow_ready(p.id),
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
