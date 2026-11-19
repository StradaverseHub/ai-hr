-- One-case read projection; it does not take a row-write or exclusive Access lock.
CREATE FUNCTION app.contract_shared_ending_actions(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;can_decline boolean;
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE THEN RAISE EXCEPTION 'Contract case unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;
 IF f.case_id IS NULL THEN RAISE EXCEPTION 'Shared Contract case unavailable' USING ERRCODE='42501';END IF;
 can_decline:=f.data->>'stage'='document' AND f.data->'decision'->>'kind'='renew' AND f.data->'declined'='null'::jsonb
 AND app.contract_shared_case_permitted(p_case,'decline') AND app.contract_shared_decision_current(p_case,(f.data->'decision'->>'revision')::integer)
 AND EXISTS(SELECT 1 FROM public.contract_shared_letter letter JOIN public.document_signing_document signing ON signing.tenant_id=letter.tenant_id AND signing.id=letter.signing_document_id
 WHERE letter.tenant_id=f.tenant_id AND letter.case_id=p_case AND letter.decision_revision=(f.data->'decision'->>'revision')::integer AND letter.purpose='outcome' AND letter.data->>'state'='routing'
 AND NOT app.document_signing_returned(signing.data) AND EXISTS(SELECT 1 FROM app.document_signing_pending_steps(signing.data) step WHERE step->>'role'='employee' AND step->>'kind'='sign'));
 RETURN jsonb_build_object('canRecordDecline',coalesce(can_decline,false),'offboardingId',f.data->>'offboardingId','lastDay',f.data->'period'->>'endOn','terminationMode','manual','clearance','pending');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_ending_actions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_ending_actions(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The canonical V9 owner first holds its existing per-tenant construction locks. Lock this exact source
-- before the unchanged ending intent takes its source SHARE and flow locks; no lock or recheck is removed.
CREATE FUNCTION app.contract_shared_offboarding_source_lock(p_case uuid,p_run uuid,p_step text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.contract_shared_effect_held(p_case,p_run,p_step,'startOffboarding') IS NOT TRUE THEN RAISE EXCEPTION 'Protected ending step required' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 PERFORM 1 FROM public.employment employment JOIN public.contract_case c ON c.tenant_id=employment.tenant_id AND c.employment_id=employment.id
 WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case FOR UPDATE OF employment;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_offboarding_source_lock(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
