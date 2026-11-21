-- The existing Offboarding constructor consumes this held, exact source intent. No Personnel termination,
-- clearance receipt, employee_document copy or Payroll write is created by a Contract ending.
CREATE FUNCTION app.contract_shared_offboarding_intent(p_case uuid,p_run uuid,p_step text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;c public.contract_case;l public.contract_shared_letter;document public.document_signing_document;reason text;
BEGIN
 PERFORM app.contract_shared_lock_source(p_case);
 IF app.contract_shared_effect_held(p_case,p_run,p_step,'startOffboarding') IS NOT TRUE THEN RAISE EXCEPTION 'Protected ending workflow step required' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case FOR UPDATE;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=f.tenant_id AND id=p_case;
 IF f.data->'decision'->>'kind'<>'end' AND f.data->'declined'='null'::jsonb THEN RAISE EXCEPTION 'Only End or a recorded declined renewal can start Offboarding' USING ERRCODE='22023';END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=f.tenant_id AND id=app.contract_shared_released_step_letter(p_case,p_run,p_step);
 IF l.id IS NULL THEN RAISE EXCEPTION 'Release this workflow step letter before handing off' USING ERRCODE='40001';END IF;
 SELECT * INTO document FROM public.document_signing_document WHERE tenant_id=f.tenant_id AND id=l.signing_document_id;
 reason:=CASE WHEN f.data->'declined' IS DISTINCT FROM 'null'::jsonb THEN f.data->'declined'->>'reason' ELSE f.data->'decision'->>'endReason' END;
 RETURN jsonb_build_object('employmentId',c.employment_id,'type',CASE WHEN reason IN('retirement','early_retirement') THEN 'Retirement' ELSE 'Contract end' END,
 'noticeDate',((f.data->'decision'->>'submittedAt')::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur')::date,'lastDay',f.data->'period'->>'endOn','reason',reason,
 'letterId',l.id,'signingDocumentId',l.signing_document_id,'letterHash',document.data->>'contentHash','offboardingCaseId',f.data->>'offboardingId');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_offboarding_intent(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_offboarding_sequence(p_case uuid,p_run uuid,p_step text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent jsonb;result bigint;
BEGIN
 intent:=app.contract_shared_offboarding_intent(p_case,p_run,p_step);
 IF intent->>'offboardingCaseId' IS NOT NULL THEN RAISE EXCEPTION 'Offboarding was already created' USING ERRCODE='40001';END IF;
 INSERT INTO public.tenant_counter(tenant_id,kind,value) VALUES(app.current_tenant_id(),'OFB9',1) ON CONFLICT(tenant_id,kind) DO UPDATE SET value=tenant_counter.value+1 RETURNING value INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_offboarding_sequence(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_offboarding_record(p_case uuid,p_run uuid,p_step text,p_offboarding uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent jsonb;c public.contract_case;
BEGIN
 intent:=app.contract_shared_offboarding_intent(p_case,p_run,p_step);
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 IF NOT EXISTS(SELECT 1 FROM public.lc_v9_case x WHERE x.tenant_id=c.tenant_id AND x.id=p_offboarding AND x.company_id=c.company_id AND x.employment_id=c.employment_id AND x.module='off'
 AND x.xmin::text=(txid_current()%4294967296)::text AND x.data->>'contractSharedSourceCaseId'=p_case::text AND x.data->'contractSharedSourceLetter'->>'letterId'=intent->>'letterId'
 AND x.data->'contractSharedSourceLetter'->>'signingDocumentId'=intent->>'signingDocumentId' AND x.data->'contractSharedSourceLetter'->>'hash'=intent->>'letterHash'
 AND x.data->'facts'->>'caseType'=intent->>'type' AND x.data->'facts'->>'lastDay'=intent->>'lastDay' AND x.data->'facts'->>'noticeDate'=intent->>'noticeDate'
 AND x.data->>'contractSharedTerminationReason'=intent->>'reason' AND x.data->>'contractSharedClearance'='pending-manual-personnel') THEN RAISE EXCEPTION 'Canonical ending receipt differs' USING ERRCODE='40001';END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload)
 VALUES(c.tenant_id,'lifecycle-v9-case',p_offboarding,'lifecycle-v9.created','system',c.employment_id,jsonb_build_object('caseId',p_offboarding,'action','created','contractSharedSourceCaseId',p_case));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_offboarding_record(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_complete_offboarding(p_case uuid,p_run uuid,p_step text,p_offboarding uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;intent jsonb;next_data jsonb;
BEGIN
 intent:=app.contract_shared_offboarding_intent(p_case,p_run,p_step);
 IF intent->>'offboardingCaseId' IS NOT NULL THEN
  IF intent->>'offboardingCaseId'<>p_offboarding::text THEN RAISE EXCEPTION 'A different Offboarding case is already linked' USING ERRCODE='40001';END IF;
  SELECT data INTO next_data FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;RETURN next_data;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=app.current_tenant_id() AND e.aggregate_id=p_offboarding AND e.event_type='lifecycle-v9.created'
 AND e.payload->>'contractSharedSourceCaseId'=p_case::text AND e.xmin::text=(txid_current()%4294967296)::text) THEN RAISE EXCEPTION 'Canonical Offboarding construction receipt required' USING ERRCODE='40001';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case FOR UPDATE;
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'stage','offboarding','offboardingId',p_offboarding,'lastActivityAt',now(),'endingHandoff',intent||jsonb_build_object('offboardingCaseId',p_offboarding,'clearance','pending','personnelTermination','manual','at',now()));
 UPDATE public.contract_shared_case SET data=next_data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 RETURN next_data;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_complete_offboarding(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

-- Contract writers share source, then lock letter, signing document and flow in that order.
-- Read-only subject content remains free of row-write locks; other module branches are unchanged.
CREATE OR REPLACE FUNCTION app.document_signing_store(p_id uuid,p_employment uuid,p_company uuid,p_subject uuid,p_data jsonb,p_rules jsonb,p_expected integer,p_operation text,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old document_signing_document;new_revision integer;expected_rules jsonb;route_allowed boolean;content jsonb;resolved_route jsonb;actor uuid:=app.current_user_id();kind text:=p_data->>'subjectType';
BEGIN
 IF coalesce(p_operation,'') NOT IN ('create','revise','reroute','canonical_refresh','live_refresh') OR NOT app.document_signing_subject_access(kind,p_subject,p_operation) THEN RAISE EXCEPTION 'Signing operation not permitted'; END IF;
 IF NOT EXISTS(SELECT 1 FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() AND company_id=p_company) THEN RAISE EXCEPTION 'Invalid signing subject'; END IF;
 IF p_data->>'tenantId' IS DISTINCT FROM app.current_tenant_id()::text OR p_data->>'companyId' IS DISTINCT FROM p_company::text OR p_data->>'subjectId' IS DISTINCT FROM p_subject::text OR kind IS NULL OR kind NOT IN('probation','contract','contract-approval') THEN RAISE EXCEPTION 'Signing subject mismatch'; END IF;
 content:=app.document_signing_subject_content(kind,p_subject);
 IF kind IN('contract','contract-approval') AND p_data->'routing' IS DISTINCT FROM nullif(content->'routing','null'::jsonb) THEN RAISE EXCEPTION 'The subject template routing changed';END IF;
 IF content IS NULL OR content->>'companyId' IS DISTINCT FROM p_company::text OR content->>'employmentId' IS DISTINCT FROM p_employment::text OR content->>'contentHash' IS DISTINCT FROM p_data->>'contentHash' OR content->>'contentRevision' IS DISTINCT FROM p_data->>'contentRevision' THEN RAISE EXCEPTION 'Signing content changed'; END IF;
 expected_rules:=app.document_signing_subject_guardrails(kind,p_subject);
 route_allowed:=app.document_signing_subject_route_allowed(kind,p_subject,p_data->'route');
 IF expected_rules IS NULL OR expected_rules<>p_rules OR NOT coalesce(route_allowed,false) THEN RAISE EXCEPTION 'Signing subject policy or current route changed'; END IF;
 IF coalesce(p_data->>'contentHash','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_data->'contentRevision') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid content fingerprint or revision'; END IF;
 PERFORM app.document_signing_validate(p_data,p_rules);
 IF kind='contract' THEN PERFORM 1 FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_subject FOR UPDATE;END IF;
 SELECT * INTO old FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF p_operation='create' THEN
  IF FOUND OR p_expected IS DISTINCT FROM 0 OR p_data->'actions' IS DISTINCT FROM '[]'::jsonb OR p_data->>'contentRevision' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'Invalid initial signing revision'; END IF;
  INSERT INTO document_signing_document(id,tenant_id,company_id,employment_id,subject_type,subject_id,data,guardrails) VALUES(p_id,app.current_tenant_id(),p_company,p_employment,kind,p_subject,p_data,p_rules);
  new_revision:=1;
 ELSE
  IF NOT FOUND OR old.subject_type IS DISTINCT FROM kind OR old.subject_id<>p_subject OR old.employment_id<>p_employment OR old.company_id<>p_company OR old.revision IS DISTINCT FROM p_expected OR old.guardrails<>p_rules OR btrim(coalesce(p_reason,''))='' THEN RAISE EXCEPTION 'Signing revision changed or reason missing'; END IF;
  IF p_data->'actions' IS DISTINCT FROM old.data->'actions' THEN RAISE EXCEPTION 'Signing history is immutable'; END IF;
  -- The template routing a document was generated with is frozen.
  IF p_data->'routing' IS DISTINCT FROM old.data->'routing' THEN RAISE EXCEPTION 'The template routing of a document cannot change'; END IF;
  IF p_operation='canonical_refresh' THEN
   IF to_regprocedure('app.probation_signing_refresh_route(uuid)') IS NULL THEN RAISE EXCEPTION 'Canonical refresh policy is unavailable';END IF;
   EXECUTE 'SELECT app.probation_signing_refresh_route($1)' INTO resolved_route USING p_subject;
   IF resolved_route IS NULL OR p_data->'route' IS DISTINCT FROM resolved_route OR (p_data-'route') IS DISTINCT FROM (old.data-'route') OR p_data->'route' IS NOT DISTINCT FROM old.data->'route' THEN
    RAISE EXCEPTION 'Canonical refresh may only adopt the exact current pending route';
   END IF;
  END IF;
  IF p_operation='live_refresh' THEN
   IF kind<>'contract' OR old.data->'routing'->'liveMergeReviews' IS DISTINCT FROM 'true'::jsonb OR app.document_signing_locked(old.data) OR (p_data-'contentHash') IS DISTINCT FROM (old.data-'contentHash') THEN RAISE EXCEPTION 'Only live Contract fields may refresh before the first signature';END IF;
  ELSIF p_operation='revise' THEN
   IF kind IN('contract','contract-approval') AND (p_data-ARRAY['contentHash','contentRevision']) IS DISTINCT FROM (old.data-ARRAY['contentHash','contentRevision']) THEN RAISE EXCEPTION 'A Contract content revision keeps its frozen identity and route';END IF;
   IF (p_data->>'contentRevision')::integer<>(old.data->>'contentRevision')::integer+1 OR p_data->>'contentHash'=old.data->>'contentHash' THEN RAISE EXCEPTION 'Invalid content revision'; END IF;
   IF jsonb_typeof(old.data->'routing')='object' THEN
    IF NOT app.document_signing_can_edit(old.data,actor) THEN RAISE EXCEPTION 'The content is locked or it is not your turn to edit it'; END IF;
    IF p_data->'route' IS DISTINCT FROM old.data->'route' THEN RAISE EXCEPTION 'A routed document keeps the routing it was generated with'; END IF;
   END IF;
  ELSE
   IF p_data->>'contentRevision'<>old.data->>'contentRevision' OR p_data->>'contentHash'<>old.data->>'contentHash' THEN RAISE EXCEPTION 'Rerouting cannot change signed content'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(old.data->'route'->'steps') s WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') n WHERE (n-CASE WHEN p_operation='canonical_refresh' THEN ARRAY['holderId','holderPersonId','representedId','coveredStepIds','coveredByStepId'] ELSE ARRAY['holderId','holderPersonId','representedId'] END)=(s-CASE WHEN p_operation='canonical_refresh' THEN ARRAY['holderId','holderPersonId','representedId','coveredStepIds','coveredByStepId'] ELSE ARRAY['holderId','holderPersonId','representedId'] END))) OR jsonb_array_length(p_data->'route'->'steps')<>jsonb_array_length(old.data->'route'->'steps') THEN RAISE EXCEPTION 'Rerouting cannot remove or change required steps'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(old.data->'route'->'steps') original
    JOIN jsonb_array_elements(p_data->'route'->'steps') proposed ON original->>'id'=proposed->>'id'
    WHERE app.document_signing_step_fulfilled(old.data,original) AND original<>proposed)
   THEN RAISE EXCEPTION 'Completed signatures cannot be reassigned'; END IF;
  END IF;
  new_revision:=old.revision+1;
  UPDATE document_signing_document SET data=p_data,revision=new_revision,updated_at=now() WHERE id=old.id;
 END IF;
 INSERT INTO document_signing_revision(document_id,tenant_id,revision,data,actor_user_id,actor_kind,reason) VALUES(p_id,app.current_tenant_id(),new_revision,p_data,actor,CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END,coalesce(nullif(btrim(p_reason),''),'Created signing route'));
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(app.current_tenant_id(),'document-signing',p_id,CASE p_operation WHEN 'create' THEN 'document-signing.created' WHEN 'revise' THEN 'document-signing.revised' WHEN 'live_refresh' THEN 'document-signing.live-fields-refreshed' ELSE 'document-signing.rerouted' END,CASE WHEN actor IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,actor,p_employment,jsonb_build_object('documentId',p_id,'revision',new_revision,'operation',p_operation));
 RETURN p_id;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.document_signing_act(p_id uuid,p_action jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;step jsonb;prior jsonb;stage integer;v_action jsonb;v_name text;v_person uuid;new_data jsonb;content jsonb;route_allowed boolean;coverage jsonb;routed boolean;v_kind text;v_owner uuid;
BEGIN
 -- All subject writers lock the source part before the signing document.
 SELECT * INTO d FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RAISE EXCEPTION 'Signing subject unavailable';END IF;
 content:=app.document_signing_subject_content(d.subject_type,d.subject_id);
 IF d.subject_type='contract' THEN PERFORM 1 FROM public.contract_shared_letter WHERE tenant_id=d.tenant_id AND id=d.subject_id FOR UPDATE;END IF;
 SELECT * INTO d FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.document_signing_subject_access(d.subject_type,d.subject_id,CASE WHEN p_action->>'action'='declined' THEN 'decline' ELSE 'sign' END) THEN RAISE EXCEPTION 'Signing action not permitted'; END IF;
 IF jsonb_typeof(p_action) IS DISTINCT FROM 'object' OR jsonb_typeof(p_action->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(p_action->'stepId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_action->'contentRevision') IS DISTINCT FROM 'number' OR coalesce(p_action->>'id','')='' OR coalesce(p_action->>'stepId','')='' OR length(p_action->>'id')>200 OR jsonb_typeof(p_action->'comment') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid signing action shape'; END IF;
 IF content IS NULL OR content->>'companyId' IS DISTINCT FROM d.company_id::text OR content->>'employmentId' IS DISTINCT FROM d.employment_id::text OR content->>'contentHash' IS DISTINCT FROM d.data->>'contentHash' OR content->>'contentRevision' IS DISTINCT FROM d.data->>'contentRevision' THEN RAISE EXCEPTION 'Signing content changed'; END IF;
 route_allowed:=app.document_signing_subject_route_allowed(d.subject_type,d.subject_id,d.data->'route');
 IF route_allowed IS NOT TRUE THEN RAISE EXCEPTION 'Current signing holders changed'; END IF;
 SELECT person_id INTO v_person FROM app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id();
 IF v_person IS NULL OR p_action->>'actorPersonId' IS DISTINCT FROM v_person::text THEN RAISE EXCEPTION 'Verified signer person changed'; END IF;
 IF p_action->>'actorId' IS DISTINCT FROM app.current_user_id()::text OR p_action->>'contentHash' IS DISTINCT FROM d.data->>'contentHash' OR p_action->'contentRevision' IS DISTINCT FROM d.data->'contentRevision' THEN RAISE EXCEPTION 'Signer or document revision changed'; END IF;
 SELECT a INTO prior FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'id'=p_action->>'id';
 IF prior IS NOT NULL THEN
  IF (prior-'at'-'actorName')=(p_action-'at'-'actorName') THEN RETURN d.data; END IF;
  RAISE EXCEPTION 'Signing action reference already used';
 END IF;
 routed:=coalesce(jsonb_typeof(d.data->'routing')='object',false);
 v_kind:=coalesce(p_action->>'action','');
 IF v_kind='resent' THEN
  -- The owner sends a returned template-routing document round again unchanged.
  v_owner:=app.document_signing_owner(d.data);
  IF NOT routed OR NOT app.document_signing_returned(d.data) THEN RAISE EXCEPTION 'Only a document that was sent back can be sent round again'; END IF;
  IF v_owner IS NULL OR v_owner<>app.current_user_id() THEN RAISE EXCEPTION 'Only the owner of the document can send it round again'; END IF;
  IF p_action->>'role' IS DISTINCT FROM 'owner' OR p_action->>'representedId' IS DISTINCT FROM app.current_user_id()::text OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb OR p_action ? 'coveredStepIds'
  OR p_action->>'stepId' IS DISTINCT FROM coalesce(app.document_signing_owner_step(d.data)->>'id','owner')
  THEN RAISE EXCEPTION 'Invalid re-send'; END IF;
  coverage:='[]'::jsonb;
  step:=jsonb_build_object('id',p_action->>'stepId');
 ELSE
  IF app.document_signing_returned(d.data) THEN RAISE EXCEPTION 'The document was sent back to its owner'; END IF;
  SELECT min((s->>'stage')::integer) INTO stage FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND NOT app.document_signing_step_fulfilled(d.data,s);
  SELECT s INTO step FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'id'=p_action->>'stepId' AND (s->>'stage')::integer=stage AND s->>'coveredByStepId' IS NULL;
  IF step IS NULL OR (v_kind<>'declined' AND step->>'holderId' IS DISTINCT FROM app.current_user_id()::text) OR p_action->>'role' IS DISTINCT FROM step->>'role' OR p_action->>'representedId' IS DISTINCT FROM coalesce(step->>'representedId',step->>'holderId') THEN RAISE EXCEPTION 'Only the assigned pending signer may act'; END IF;
  IF app.document_signing_step_fulfilled(d.data,step) THEN RAISE EXCEPTION 'Signature already recorded'; END IF;
  coverage:=CASE WHEN v_kind='signed' THEN coalesce(step->'coveredStepIds','[]') ELSE '[]'::jsonb END;
  IF coalesce(p_action->'coveredStepIds','[]') IS DISTINCT FROM coverage THEN RAISE EXCEPTION 'The signature role coverage differs from the authoritative pending route';END IF;
  IF v_kind='declined' THEN
   IF step->>'kind'<>'acknowledge' OR step->>'holderPersonId'=v_person::text OR btrim(coalesce(p_action->>'comment',''))='' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'An independent recorded refusal confirmation is required'; END IF;
  ELSIF v_kind='returned' THEN
   IF btrim(coalesce(p_action->>'comment',''))='' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'A return reason is required'; END IF;
  ELSIF v_kind IN ('reviewed','approved') THEN
   -- Review, and Approve on a template-routing document, are decisions without a signature.
   IF p_action->'signature' IS DISTINCT FROM 'null'::jsonb OR v_kind='reviewed' AND step->>'kind'<>'review' OR v_kind='approved' AND (step->>'kind'<>'approve' OR NOT (routed OR step->'signature' IS NOT DISTINCT FROM 'false'::jsonb)) THEN RAISE EXCEPTION 'This step takes a different action'; END IF;
  ELSIF v_kind='signed' THEN
   IF step->>'kind'='review' OR (routed OR step->'signature' IS NOT DISTINCT FROM 'false'::jsonb) AND step->>'kind'='approve' THEN RAISE EXCEPTION 'This step takes a different action'; END IF;
   IF app.document_signature_valid(p_action->'signature') IS NOT TRUE THEN RAISE EXCEPTION 'A valid signature and consent are required';END IF;
  ELSE RAISE EXCEPTION 'Invalid signing action'; END IF;
  IF v_kind IN ('signed','approved') AND step->>'kind'='approve' AND d.guardrails->>'independentApprovalFromRole' IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'=d.guardrails->>'independentApprovalFromRole' AND a->>'action'='signed' AND a->>'actorPersonId'=v_person::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') other_step WHERE other_step->>'kind'='approve' AND other_step->>'required'='true' AND other_step->>'holderPersonId'<>v_person::text) THEN RAISE EXCEPTION 'A distinct approving person is required'; END IF;
 END IF;
 -- A subject owner must validate action payloads as well as the shared route and actor.
 -- In particular, an employee acknowledgement cannot replace the saved review comment.
 IF app.document_signing_subject_action_allowed(d.subject_type,d.subject_id,p_action) IS NOT TRUE THEN RAISE EXCEPTION 'The current subject does not permit this signing action';END IF;
 SELECT p.full_name INTO v_name FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id();
 IF v_name IS NULL THEN RAISE EXCEPTION 'Verified signer name is missing'; END IF;
 v_action:=(p_action-'coveredStepIds')||CASE WHEN jsonb_array_length(coverage)>0 THEN jsonb_build_object('coveredStepIds',coverage) ELSE '{}'::jsonb END||jsonb_build_object('actorName',v_name,'actorPersonId',v_person,'at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 new_data:=jsonb_set(d.data,'{actions}',(d.data->'actions')||jsonb_build_array(v_action));
 UPDATE document_signing_document SET data=new_data,revision=revision+1,updated_at=now() WHERE id=d.id;
 INSERT INTO document_signing_revision(document_id,tenant_id,revision,data,actor_user_id,reason) VALUES(d.id,d.tenant_id,d.revision+1,new_data,app.current_user_id(),CASE v_kind WHEN 'resent' THEN 'Sent the document round again' ELSE 'Recorded signing action' END);
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(d.tenant_id,'document-signing',d.id,CASE v_kind WHEN 'signed' THEN 'document-signing.signed' WHEN 'declined' THEN 'document-signing.acknowledgement-declined' WHEN 'reviewed' THEN 'document-signing.reviewed' WHEN 'approved' THEN 'document-signing.approved' WHEN 'resent' THEN 'document-signing.resent' ELSE 'document-signing.returned' END,'user',app.current_user_id(),d.employment_id,jsonb_build_object('documentId',d.id,'revision',d.revision+1,'stepId',step->>'id'));
 RETURN new_data;
END $$;

--> statement-breakpoint
