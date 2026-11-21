-- Coarse letter-purpose guidance only; same guarded read owner/OID/ACL, no action grant.
CREATE OR REPLACE FUNCTION app.contract_shared_letter_actions(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE letter public.contract_shared_letter;signing public.document_signing_document;can_bind boolean;pending_role text;company_available boolean;self_actor boolean;source_flow jsonb;
BEGIN
 IF app.document_signing_subject_access('contract',p_letter,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This letter is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO signing FROM public.document_signing_document WHERE tenant_id=letter.tenant_id AND id=letter.signing_document_id;
 SELECT app.contract_company_entitled(contract.company_id),employment.person_id=app.contract_actor_person(app.current_user_id()) INTO company_available,self_actor
 FROM public.contract_case contract JOIN public.employment employment ON employment.tenant_id=contract.tenant_id AND employment.id=contract.employment_id AND employment.company_id=contract.company_id
 WHERE contract.tenant_id=letter.tenant_id AND contract.id=letter.case_id;
 can_bind:=company_available AND app.contract_shared_letter_binding_actor(letter.id) AND EXISTS(SELECT 1 FROM jsonb_array_elements(signing.data->'route'->'steps') step WHERE step->>'role'='employee' AND step->>'kind'='sign' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(signing.data,step));
 IF letter.data->>'state'='routing' AND company_available AND (CASE WHEN letter.purpose='email' THEN app.contract_shared_email_document_current(letter.id) ELSE app.contract_shared_decision_current(letter.case_id,letter.decision_revision) END) AND NOT app.document_signing_returned(signing.data) THEN
  SELECT CASE WHEN step->>'role'='employee' THEN 'employee' ELSE 'company' END INTO pending_role FROM app.document_signing_pending_steps(signing.data) step
  WHERE step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text AND step->>'kind'='sign'
  ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
 END IF;
 SELECT data INTO source_flow FROM public.contract_shared_case WHERE tenant_id=letter.tenant_id AND case_id=letter.case_id;
 RETURN jsonb_build_object('canBindEmployee',coalesce(can_bind,false),'canSelfBind',coalesce(can_bind AND self_actor,false),'companyActionsAvailable',coalesce(company_available,false),'pendingRole',pending_role,'purpose',letter.purpose,'contractDeclineGuidance',coalesce(letter.purpose='outcome' AND pending_role='employee' AND source_flow->'decision'->>'kind'='renew' AND (source_flow->'decision'->>'revision')::integer=letter.decision_revision,false));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_actions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_letter_actions(uuid) TO ai_hr_app;
