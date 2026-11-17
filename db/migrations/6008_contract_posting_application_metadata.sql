-- Proposal: exact existing posting audiences see actual kernel progress; approval stays native and atomic.
-- No app-readable job context, confidential Payroll values, preservation counts or new write authority.
CREATE FUNCTION app.contract_posting_application_metadata(p_posting uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('jobId',source.job_id,'state',CASE WHEN job.state='finalizing' THEN 'applying' WHEN job.state IN('failed','cancelled') THEN 'needs_review' ELSE 'queued' END)
 FROM app.contract_posting_job_source source JOIN public.bulk_job job ON job.tenant_id=source.tenant_id AND job.id=source.job_id
 JOIN public.personnel_posting posting ON posting.tenant_id=source.tenant_id AND posting.id=source.posting_id AND posting.status='pending'
 WHERE source.tenant_id=app.current_tenant_id() AND source.posting_id=p_posting AND job.kind='contract_posting_apply'
 AND job.state IN('queued','preparing','finalizing','failed','cancelled') ORDER BY source.requested_at DESC,source.job_id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.contract_posting_application_metadata(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ BEGIN
 EXECUTE replace(pg_get_functiondef('app.contract_posting_request(uuid,integer,jsonb)'::regprocedure),
 'app.contract_posting_request(', 'app.contract_posting_request_before_application_metadata(');
 EXECUTE replace(pg_get_functiondef('app.contract_posting_request_status(uuid)'::regprocedure),
 'app.contract_posting_request_status(', 'app.contract_posting_status_before_application_metadata(');
 EXECUTE replace(pg_get_functiondef('app.contract_shared_posting_read(uuid)'::regprocedure),
 'app.contract_shared_posting_read(', 'app.contract_shared_posting_read_before_apply_metadata(');
 EXECUTE replace(pg_get_functiondef('app.contract_shared_posting_case_summary(uuid)'::regprocedure),
 'app.contract_shared_posting_case_summary(', 'app.contract_shared_posting_summary_before_apply_metadata(');
 EXECUTE replace(pg_get_functiondef('app.contract_shared_postings_page(text,uuid,integer,integer,uuid)'::regprocedure),
 'app.contract_shared_postings_page(', 'app.contract_shared_postings_page_before_apply_metadata(');
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_request_before_application_metadata(uuid,integer,jsonb),
 app.contract_posting_status_before_application_metadata(uuid),app.contract_shared_posting_read_before_apply_metadata(uuid),
 app.contract_shared_posting_summary_before_apply_metadata(uuid),app.contract_shared_postings_page_before_apply_metadata(text,uuid,integer,integer,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_posting_request(p_id uuid,p_revision integer,p_values jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;p public.personnel_posting;r public.contract_shared_posting;v_source app.contract_posting_job_source;progress jsonb;
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'A human Contract posting approval is required' USING ERRCODE='42501';
 END IF;
 SELECT posting_row.* INTO p FROM public.personnel_posting posting_row WHERE posting_row.tenant_id=app.current_tenant_id() AND posting_row.id=p_id AND posting_row.source='contract_staff' AND posting_row.status='approved';
 IF p.id IS NOT NULL THEN
  IF app.principal_snapshot_current() IS NOT TRUE OR app.contract_verified_human(app.current_user_id()) IS NOT TRUE
  OR app.contract_shared_posting_approver(p.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Contract posting receipt unavailable' USING ERRCODE='42501';END IF;
  SELECT receipt_row.* INTO r FROM public.contract_shared_posting receipt_row WHERE receipt_row.tenant_id=p.tenant_id AND receipt_row.posting_id=p.id;
  IF p.movement_id IS NULL OR r.movement_group_id IS NULL OR p.applied IS NULL OR (p_values IS NOT NULL AND p_values IS DISTINCT FROM p.applied)
  OR NOT EXISTS(SELECT 1 FROM public.domain_event movement WHERE movement.tenant_id=p.tenant_id AND movement.id::text=p.movement_id
   AND movement.subject_employment_id=p.employment_id AND movement.payload->'movement'->>'groupId'=r.movement_group_id::text)
  THEN RAISE EXCEPTION 'Review the recorded Contract agreement before continuing' USING ERRCODE='40001';END IF;
  -- A duplicate request reads the actual immutable receipt. It never creates a job or reapproves it.
  RETURN jsonb_build_object('id',p.id,'postingId',p.id,'employmentId',p.employment_id,'eventType',p.event_type,'values',p.applied,
   'behaviourKind',CASE p.event_type WHEN 'contractConversion' THEN 'employmentTypeChange' ELSE 'contractRenewal' END,
   'postingStatus','approved','applicationState',CASE WHEN r.applied_at IS NULL THEN 'scheduled' ELSE 'applied' END,
   'movementId',p.movement_id,'groupId',r.movement_group_id,'alreadyApproved',true);
 END IF;
 result:=app.contract_posting_request_before_application_metadata(p_id,p_revision,p_values);
 SELECT source_row.* INTO v_source FROM app.contract_posting_job_source source_row WHERE source_row.tenant_id=app.current_tenant_id() AND source_row.job_id=(result->>'jobId')::uuid AND source_row.posting_id=p_id;
 SELECT posting_row.* INTO p FROM public.personnel_posting posting_row WHERE posting_row.tenant_id=v_source.tenant_id AND posting_row.id=v_source.posting_id AND posting_row.source='contract_staff';
 IF v_source.job_id IS NULL OR p.id IS NULL THEN RAISE EXCEPTION 'The actual Contract request is unavailable' USING ERRCODE='40001';END IF;
 progress:=app.contract_posting_application_metadata(p.id);
 RETURN result||jsonb_build_object('id',p.id,'employmentId',p.employment_id,'eventType',p.event_type,
  'values',v_source.requested_values,'behaviourKind',CASE p.event_type WHEN 'contractConversion' THEN 'employmentTypeChange' ELSE 'contractRenewal' END,
  'applicationState',coalesce(progress->>'state','queued'));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_posting_request_status(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;movement text;
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'A human Contract application status reader is required' USING ERRCODE='42501';
 END IF;
 result:=app.contract_posting_status_before_application_metadata(p_job);
 SELECT posting.movement_id INTO movement FROM app.contract_posting_job_source source_row
 JOIN public.personnel_posting posting ON posting.tenant_id=source_row.tenant_id AND posting.id=source_row.posting_id
 WHERE source_row.tenant_id=app.current_tenant_id() AND source_row.job_id=p_job;
 result:=result||jsonb_build_object('movementId',movement);
 IF result->>'postingStatus'='pending' AND result->>'jobState'='finalizing' THEN
  result:=result||jsonb_build_object('applicationState','applying');
 END IF;
 RETURN result;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_posting_read(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;progress jsonb;
BEGIN
 result:=app.contract_shared_posting_read_before_apply_metadata(p_id);
 IF result IS NULL THEN RETURN NULL;END IF;
 progress:=app.contract_posting_application_metadata(p_id);
 RETURN result||jsonb_build_object('approvalApplication',progress)
  ||CASE WHEN progress->>'state' IN('queued','applying') OR result->'sourceCurrent' IS DISTINCT FROM 'true'::jsonb
   THEN jsonb_build_object('canApprove',false,'canEdit',false) ELSE '{}'::jsonb END;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_posting_case_summary(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=app.contract_shared_posting_summary_before_apply_metadata(p_case);
 IF result IS NULL THEN RETURN NULL;END IF;
 RETURN result||jsonb_build_object('approvalApplication',app.contract_posting_application_metadata((result->>'postingId')::uuid));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_postings_page(p_status text,p_company uuid,p_offset integer,p_limit integer,p_posting uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;rows jsonb;
BEGIN
 result:=app.contract_shared_postings_page_before_apply_metadata(p_status,p_company,p_offset,p_limit,p_posting);
 -- Only the already-authorized bounded page joins pending application metadata. No per-row owner calls.
 WITH items AS MATERIALIZED(SELECT value,n FROM jsonb_array_elements(result->'rows') WITH ORDINALITY item(value,n)),
 readiness AS MATERIALIZED(
  SELECT proof.posting_id,proof.ready FROM app.contract_posting_workflow_readiness(
   coalesce((SELECT array_agg((value->>'id')::uuid) FROM items),'{}'::uuid[])) proof
 ),
 applications AS MATERIALIZED(
  SELECT DISTINCT ON(source.posting_id) source.posting_id,
   jsonb_build_object('jobId',source.job_id,'state',CASE WHEN job.state='finalizing' THEN 'applying' WHEN job.state IN('failed','cancelled') THEN 'needs_review' ELSE 'queued' END) progress
  FROM app.contract_posting_job_source source JOIN public.bulk_job job ON job.tenant_id=source.tenant_id AND job.id=source.job_id
  JOIN public.personnel_posting posting ON posting.tenant_id=source.tenant_id AND posting.id=source.posting_id AND posting.status='pending'
  WHERE source.tenant_id=app.current_tenant_id() AND source.posting_id IN(SELECT (value->>'id')::uuid FROM items)
  AND job.kind='contract_posting_apply' AND job.state IN('queued','preparing','finalizing','failed','cancelled')
  ORDER BY source.posting_id,source.requested_at DESC,source.job_id DESC
 ) SELECT coalesce(jsonb_agg(items.value||jsonb_build_object('approvalApplication',applications.progress,
   'workflowReady',coalesce(readiness.ready,false),
   'canApprove',items.value->>'status'='pending' AND items.value->'sourceCurrent'='true'::jsonb AND coalesce(readiness.ready,false))
  ||CASE WHEN applications.progress->>'state' IN('queued','applying') THEN jsonb_build_object('canApprove',false,'canEdit',false) ELSE '{}'::jsonb END ORDER BY items.n),'[]'::jsonb)
 INTO rows FROM items LEFT JOIN applications ON applications.posting_id=(items.value->>'id')::uuid
 LEFT JOIN readiness ON readiness.posting_id=(items.value->>'id')::uuid;
 RETURN jsonb_set(result,'{rows}',rows);
END $$;
-- CREATE OR REPLACE retains the exact existing same-OID app ACLs; all copied bodies stay private.
