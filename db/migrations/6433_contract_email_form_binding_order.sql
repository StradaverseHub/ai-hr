-- INACTIVE append-only proposal. Identity/allocation/registration belongs to the coordinator.
-- Existing native OIDs, owners and ACLs remain unchanged. No new grant/table/column/helper.
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.contract_shared_letter_bind_employee(uuid)'::regprocedure)
  IS DISTINCT FROM 'f54f8f32adeebdc47226dd1bdc4bd825ea07894fd8233cfb92b2959ca9c3d207' THEN RAISE EXCEPTION 'Expected canonical 5825 employee binding owner before Form binding-order repair';END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.contract_shared_letter_signing_content(uuid)'::regprocedure)
  IS DISTINCT FROM 'c68a03aa1a94f3f95a82f185c0217cbac5e864f083a6a88ce32e2d49dec13609' THEN RAISE EXCEPTION 'Expected canonical 5810 signing content owner before Form binding-order repair';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_signing_content(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;binding_letter public.contract_shared_letter;binding_document public.document_signing_document;
BEGIN
 PERFORM app.contract_shared_lock_source((SELECT case_id FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter));
 -- Canonical reroute validates content BEFORE it persists the new signing route.
 -- At this one private held seam, validate the immutable retained hash; do not
 -- read Form values for a login which is not yet an actual routed participant.
 IF app.contract_shared_email_self_binding_available(p_letter) IS TRUE
  AND app.contract_shared_email_self_binding_held(p_letter) IS TRUE
  AND app.contract_shared_document_kind(p_letter)='Form'
  AND app.contract_shared_form_body_visible(p_letter) IS NOT TRUE THEN
  SELECT * INTO binding_letter FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
  SELECT * INTO binding_document FROM public.document_signing_document WHERE tenant_id=binding_letter.tenant_id AND id=binding_letter.signing_document_id
   AND subject_type='contract' AND subject_id=binding_letter.id;
  IF binding_document.id IS NULL OR binding_document.data->>'contentRevision' IS DISTINCT FROM binding_letter.data->>'contentRevision'
   OR NOT EXISTS(SELECT 1 FROM public.contract_shared_letter_content receipt
    WHERE receipt.tenant_id=binding_letter.tenant_id AND receipt.letter_id=binding_letter.id
     AND receipt.content_revision=(binding_document.data->>'contentRevision')::integer
     AND receipt.content_hash=binding_document.data->>'contentHash'
     AND encode(sha256(convert_to(receipt.snapshot::text,'UTF8')),'hex')=receipt.content_hash)
  THEN RAISE EXCEPTION 'Exact retained employee binding content required' USING ERRCODE='40001';END IF;
  SELECT jsonb_build_object('companyId',c.company_id,'employmentId',c.employment_id,
   'contentHash',binding_document.data->>'contentHash','contentRevision',(binding_document.data->>'contentRevision')::integer,
   'routing',binding_letter.data->'signingPolicy'->'routing') INTO result
   FROM public.contract_case c WHERE c.tenant_id=binding_letter.tenant_id AND c.id=binding_letter.case_id;
  RETURN result;
 END IF;
 SELECT jsonb_build_object('companyId',c.company_id,'employmentId',c.employment_id,'contentHash',encode(sha256(convert_to(app.contract_shared_letter_snapshot(l.id)::text,'UTF8')),'hex'),
 'contentRevision',(l.data->>'contentRevision')::integer,'routing',l.data->'signingPolicy'->'routing') INTO result
 FROM public.contract_shared_letter l JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter;
 RETURN result;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_bind_employee(p_letter uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;d public.document_signing_document;f public.contract_shared_case;employee_person uuid;account_id uuid;account_count integer;route jsonb;snapshot jsonb;fingerprint text;next_document jsonb;flags jsonb;self_email_binding boolean:=false;
BEGIN
 IF app.contract_shared_letter_binding_actor(p_letter) IS NOT TRUE THEN RAISE EXCEPTION 'This employee sign-in cannot be checked from this account' USING ERRCODE='42501';END IF;
 PERFORM app.contract_shared_lock_source((SELECT case_id FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter));
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter FOR UPDATE;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id FOR UPDATE;
 IF app.contract_shared_letter_binding_actor(p_letter) IS NOT TRUE THEN RAISE EXCEPTION 'Letter source changed' USING ERRCODE='40001';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') step WHERE step->>'role'='employee' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(d.data,step)) THEN RETURN;END IF;
 SELECT employment.person_id INTO employee_person FROM public.contract_case c JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id WHERE c.tenant_id=l.tenant_id AND c.id=l.case_id;
 SELECT count(*)::integer,min(account.id::text)::uuid INTO account_count,account_id FROM public.app_user account WHERE account.tenant_id=l.tenant_id AND account.person_id=employee_person AND app.contract_verified_human(account.id);
 IF account_count<>1 THEN RAISE EXCEPTION 'One verified active employee account is required; no email linking or substitute is allowed' USING ERRCODE='22023';END IF;
 -- Only this existing native NULL-to-actual employee binding takes the route-first path.
 -- No chosen account, GUC authority or Form-reader exception is accepted.
 self_email_binding:=l.purpose='email' AND account_id=app.current_user_id()
  AND app.contract_shared_email_self_binding_available(l.id) IS TRUE;
 IF self_email_binding THEN
 SELECT jsonb_set(d.data->'route','{steps}',jsonb_agg(CASE WHEN step->>'role'='employee' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(d.data,step) THEN step||jsonb_build_object('holderId',account_id,'holderPersonId',employee_person) ELSE step END ORDER BY n)) INTO route FROM jsonb_array_elements(d.data->'route'->'steps') WITH ORDINALITY x(step,n);
 UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{signingPolicy,route}',route),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
 next_document:=jsonb_set(d.data,'{route}',route);
 PERFORM app.document_signing_store(d.id,d.employment_id,d.company_id,d.subject_id,next_document,d.guardrails,d.revision,'reroute','Bound the unique verified employee login to the existing employee steps');
  SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id;
 END IF;
 -- A future Employee stage may be bound without exposing its Form before its turn.
 -- Actual pending/owner/history routing remains the sole Form-body authority.
 IF NOT self_email_binding OR app.contract_shared_document_kind(l.id)<>'Form'
  OR app.contract_shared_form_body_visible(l.id) IS TRUE THEN
 snapshot:=app.contract_shared_letter_snapshot(l.id);fingerprint:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 IF d.data->>'contentHash' IS DISTINCT FROM fingerprint THEN
  IF app.document_signing_locked(d.data) THEN RAISE EXCEPTION 'Signed values changed' USING ERRCODE='40001';END IF;
  UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{values}',snapshot->'values'),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
  INSERT INTO public.contract_shared_letter_content(tenant_id,letter_id,content_revision,content_hash,snapshot) VALUES(l.tenant_id,l.id,(d.data->>'contentRevision')::integer,fingerprint,snapshot) ON CONFLICT DO NOTHING;
  next_document:=jsonb_set(d.data,'{contentHash}',to_jsonb(fingerprint));
  PERFORM app.document_signing_store(d.id,d.employment_id,d.company_id,d.subject_id,next_document,d.guardrails,d.revision,'live_refresh','Refreshed live fields before verified employee sign-in binding');
  SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id;
 END IF;
 END IF;
 IF NOT self_email_binding THEN
 SELECT jsonb_set(d.data->'route','{steps}',jsonb_agg(CASE WHEN step->>'role'='employee' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(d.data,step) THEN step||jsonb_build_object('holderId',account_id,'holderPersonId',employee_person) ELSE step END ORDER BY n)) INTO route FROM jsonb_array_elements(d.data->'route'->'steps') WITH ORDINALITY x(step,n);
 UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{signingPolicy,route}',route),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
 next_document:=jsonb_set(d.data,'{route}',route);
 PERFORM app.document_signing_store(d.id,d.employment_id,d.company_id,d.subject_id,next_document,d.guardrails,d.revision,'reroute','Bound the unique verified employee login to the existing employee steps');
 END IF;
 IF l.purpose='email' THEN RETURN;END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=l.tenant_id AND case_id=l.case_id FOR UPDATE;
 SELECT coalesce(jsonb_agg(flag),'[]'::jsonb) INTO flags FROM jsonb_array_elements(f.data->'flags') flag WHERE flag#>>'{}'<>'employee_cannot_sign';
 UPDATE public.contract_shared_case SET data=f.data||jsonb_build_object('revision',f.revision+1,'flags',flags,'lastActivityAt',now()),revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(next_document) step WHERE step->>'role'='employee' AND step->>'holderId'=account_id::text) THEN
  PERFORM app.contract_shared_enqueue_event(l.case_id,'letterActionNeeded','letter:'||l.id::text||':employee-login:'||account_id::text,jsonb_build_object('letterId',l.id,'decision',f.data->'decision','period',f.data->'period'));
 END IF;
END $$;
