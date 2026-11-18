-- Forward source review after frozen6000–6008. No new app EXECUTE, decision, approval or Payroll owner.
-- Preserve normal legacy terminal readiness; a NEW technical reconciliation is not business completion.
DO $$ BEGIN
 EXECUTE replace(pg_get_functiondef('app.contract_posting_workflow_readiness(uuid[])'::regprocedure),
  'app.contract_posting_workflow_readiness(', 'app.contract_posting_readiness_before_reconciliation(');
 EXECUTE replace(pg_get_functiondef('app.contract_shared_postings_page(text,uuid,integer,integer,uuid)'::regprocedure),
  'app.contract_shared_postings_page(', 'app.contract_shared_postings_page_before_authority_factor(');
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_readiness_before_reconciliation(uuid[]),
 app.contract_shared_postings_page_before_authority_factor(text,uuid,integer,integer,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_posting_workflow_readiness(p_ids uuid[]) RETURNS TABLE(posting_id uuid,ready boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_ids IS NULL OR cardinality(p_ids)=0 THEN RETURN;END IF;
 IF cardinality(p_ids)>100 THEN RAISE EXCEPTION 'Bound the Contract readiness projection' USING ERRCODE='22023';END IF;
 RETURN QUERY WITH ordinary AS MATERIALIZED(
  SELECT prior.posting_id,prior.ready FROM app.contract_posting_readiness_before_reconciliation(p_ids) prior
 ),reconciliation_holds AS MATERIALIZED(
  SELECT DISTINCT receipt.posting_id FROM ordinary
  JOIN public.contract_shared_posting receipt ON receipt.tenant_id=app.current_tenant_id() AND receipt.posting_id=ordinary.posting_id
  JOIN public.personnel_posting posting ON posting.tenant_id=receipt.tenant_id AND posting.id=receipt.posting_id
  JOIN public.contract_shared_event cause ON cause.tenant_id=receipt.tenant_id AND cause.case_id=receipt.case_id
   AND cause.decision_revision=receipt.decision_revision AND cause.trigger_event='letterReleased'
   AND cause.data->>'letterId'=receipt.letter_id::text AND cause.created_at<=posting.created_at
  JOIN public.bulk_job job ON job.tenant_id=cause.tenant_id AND job.id=cause.job_id AND job.kind='contract_automation'
   AND job.operation_key=coalesce(cause.root_event_id,cause.id)
  JOIN public.contract_shared_event retained ON retained.tenant_id=cause.tenant_id AND retained.case_id=cause.case_id
   AND retained.job_id=job.id AND coalesce(retained.root_event_id,retained.id)=job.operation_key
   AND retained.decision_revision=receipt.decision_revision AND retained.email_reconciliation IS NOT NULL
  -- The new canonical owner writes this metadata only for retained unattempted references or started
  -- remaining work. It cannot turn a technically closed job into proof that its business work ran.
 ) SELECT ordinary.posting_id,ordinary.ready AND hold.posting_id IS NULL
 FROM ordinary LEFT JOIN reconciliation_holds hold ON hold.posting_id=ordinary.posting_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_workflow_readiness(uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_postings_page(p_status text,p_company uuid,p_offset integer,p_limit integer,p_posting uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;rows jsonb;
BEGIN
 result:=app.contract_shared_postings_page_before_authority_factor(p_status,p_company,p_offset,p_limit,p_posting);
 WITH items AS MATERIALIZED(SELECT value,n FROM jsonb_array_elements(result->'rows') WITH ORDINALITY item(value,n)),
 approvers AS MATERIALIZED(SELECT scope.company_id FROM app.contract_shared_posting_scope() scope)
 SELECT coalesce(jsonb_agg(items.value||jsonb_build_object('canApprove',
  items.value->'canApprove'='true'::jsonb AND approvers.company_id IS NOT NULL) ORDER BY items.n),'[]'::jsonb)
 INTO rows FROM items LEFT JOIN approvers ON approvers.company_id=(items.value->>'companyId')::uuid;
 RETURN jsonb_set(result,'{rows}',rows);
END $$;
-- Same OID retains the existing page audience/ACL. The two copied bodies remain private.
