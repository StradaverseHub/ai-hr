-- Canonical assignment INSERT stamps recorded_at and created_at at this transaction.
-- Admit only those exact native timestamps; every business field still equals the frozen approved source.
-- No grant, trigger or general Workforce owner changes. 5815/5817 bytes remain immutable.
CREATE OR REPLACE FUNCTION app.contract_shared_posting_assignment_allowed(p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i public.contract_shared_posting_tx;
BEGIN
 SELECT * INTO i FROM public.contract_shared_posting_tx x WHERE x.tenant_id=app.current_tenant_id() AND x.transaction_id=txid_current() AND x.backend_pid=pg_backend_pid() AND x.login_name=session_user AND x.actor_user_id IS NOT DISTINCT FROM app.current_user_id() AND NOT x.consumed AND x.employment_id=coalesce((p_old->>'employment_id')::uuid,(p_new->>'employment_id')::uuid);
 IF i.employment_id IS NULL OR i.kind<>'contractConversion' OR i.effective_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RETURN false;END IF;
 IF p_old IS NOT NULL THEN RETURN p_old=i.old_assignment AND p_new=p_old||jsonb_build_object('valid_to',i.effective_on);END IF;
 RETURN p_new->>'tenant_id'=i.tenant_id::text AND p_new->>'employment_id'=i.employment_id::text
 AND p_new->>'valid_from'=i.effective_on::text AND p_new->>'valid_to' IS NULL AND p_new->>'employment_type'='full_time'
 AND p_new->>'superseded_at' IS NULL AND (p_new->>'recorded_at')::timestamptz=now() AND (p_new->>'created_at')::timestamptz=now() AND p_new->>'company_id'=coalesce(i.old_assignment->>'company_id',i.old_employment->>'company_id')
 AND (p_new-ARRAY['id','created_at','recorded_at','valid_from','employment_type','company_id'])=(i.old_assignment-ARRAY['id','created_at','recorded_at','valid_from','employment_type','company_id']);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_assignment_allowed(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
