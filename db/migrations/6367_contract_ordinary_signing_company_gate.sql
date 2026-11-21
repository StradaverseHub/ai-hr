-- Confirmed ordinary-only scope gap: frozen proof ef1bcc4a7 / hosted43963344028 permitted actual writes
-- with company A Lifecycle disabled and only B enabled. This denies ordinary decision approval/Letter writes.
-- Existing read visibility, Form/email delegation, actors, writers, targets and all grants remain unchanged.
CREATE OR REPLACE FUNCTION app.contract_shared_approval_read(p_approval uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.contract_shared_approval;d public.document_signing_document;c public.contract_case;s jsonb;pending jsonb;layers jsonb;history jsonb;
BEGIN
 IF app.document_signing_subject_access('contract-approval',p_approval,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This approval is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM public.contract_shared_approval WHERE tenant_id=app.current_tenant_id() AND id=p_approval;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=a.tenant_id AND id=a.signing_document_id;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=a.tenant_id AND id=a.case_id;
 s:=app.contract_source(c.employment_id);
 SELECT step INTO pending FROM app.document_signing_pending_steps(d.data) step ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',step->>'id','label',step->>'label','stage',(step->>'stage')::integer,
 'assigneeName',p.full_name,'fulfilled',app.document_signing_step_fulfilled(d.data,step)) ORDER BY n),'[]'::jsonb) INTO layers
 FROM jsonb_array_elements(d.data->'route'->'steps') WITH ORDINALITY x(step,n)
 LEFT JOIN public.app_user u ON u.tenant_id=a.tenant_id AND u.id::text=step->>'holderId' AND u.person_id::text=step->>'holderPersonId'
 LEFT JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','stepId',x->>'stepId','actorName',x->>'actorName','action',x->>'action','comment',x->>'comment','at',x->>'at') ORDER BY n),'[]'::jsonb) INTO history FROM jsonb_array_elements(d.data->'actions') WITH ORDINALITY actions(x,n);
 RETURN jsonb_build_object('id',a.id,'caseId',a.case_id,'decisionRevision',a.decision_revision,
 'employeeName',s->>'name','employeeCode',s->>'employeeId','company',s->>'company','decision',a.data->'decision','period',a.data->'period',
 'contentRevision',d.data->'contentRevision','contentHash',d.data->>'contentHash','pendingLayerId',pending->>'id','layers',layers,'history',history,
 'canAct',app.contract_company_entitled(c.company_id) AND pending IS NOT NULL AND app.contract_shared_decision_current(a.case_id,a.decision_revision) AND app.contract_shared_approval_eligible(a.id,pending->>'id'),
 'status',CASE WHEN app.document_signing_returned(d.data) THEN 'rejected' WHEN NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(d.data)) THEN 'approved' WHEN NOT app.contract_shared_decision_current(a.case_id,a.decision_revision) THEN 'cancelled' ELSE 'pending' END);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_signing_access(p_type text,p_subject uuid,p_operation text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;document jsonb;assigned boolean;ordinary_company uuid;
BEGIN
 -- Existing reads remain unchanged. Decision approvals and ordinary Letters require their own company module.
 IF p_type='contract-approval' AND p_operation IS DISTINCT FROM 'read' THEN
  SELECT c.company_id INTO ordinary_company FROM public.contract_shared_approval approval JOIN public.contract_case c ON c.tenant_id=approval.tenant_id AND c.id=approval.case_id
  WHERE approval.tenant_id=app.current_tenant_id() AND approval.id=p_subject;
  IF ordinary_company IS NOT NULL AND app.contract_company_entitled(ordinary_company) IS NOT TRUE THEN RETURN false;END IF;
 END IF;
 -- Held email/Form paths below delegate unchanged.
 IF p_type='contract' AND p_operation IS DISTINCT FROM 'read' THEN
  SELECT c.company_id INTO ordinary_company FROM public.contract_shared_letter letter JOIN public.contract_case c ON c.tenant_id=letter.tenant_id AND c.id=letter.case_id
  WHERE letter.tenant_id=app.current_tenant_id() AND letter.id=p_subject AND letter.purpose<>'email'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(letter.data->'definition'->'blocks','[]'::jsonb)) block WHERE block->>'type' IN('field','fields'));
  IF ordinary_company IS NOT NULL AND app.contract_company_entitled(ordinary_company) IS NOT TRUE THEN RETURN false;END IF;
 END IF;
 IF p_type<>'contract' OR p_operation NOT IN('sign','revise','live_refresh') THEN RETURN app.contract_shared_signing_access_before_email_documents(p_type,p_subject,p_operation);END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_subject;
 IF l.purpose IS DISTINCT FROM 'email' THEN RETURN app.contract_shared_signing_access_before_email_documents(p_type,p_subject,p_operation);END IF;
 IF app.contract_verified_human(app.current_user_id()) IS NOT TRUE OR app.contract_shared_email_document_current(p_subject) IS NOT TRUE OR l.data->>'state'<>'routing' THEN RETURN false;END IF;
 SELECT data INTO document FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id AND subject_type='contract' AND subject_id=l.id;
 IF document IS NULL THEN RETURN false;END IF;
 assigned:=EXISTS(SELECT 1 FROM jsonb_array_elements(document->'route'->'steps') step WHERE step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text);
 IF p_operation='sign' THEN RETURN assigned AND (EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document)) OR app.document_signing_returned(document) AND app.document_signing_owner(document)=app.current_user_id());END IF;
 IF p_operation='revise' THEN RETURN app.document_signing_can_edit(document,app.current_user_id());END IF;
 RETURN assigned AND NOT app.document_signing_locked(document);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_read(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;d public.document_signing_document;visible boolean;is_current boolean;snapshot jsonb;fingerprint text;layers jsonb;history jsonb;receipts jsonb;pending jsonb;
BEGIN
 IF app.document_signing_subject_access('contract',p_letter,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This letter is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id;
 visible:=app.document_signing_content_visible(d.id,l.data->>'state'='released');
 is_current:=CASE WHEN l.purpose='email' THEN app.contract_shared_email_document_current(l.id) ELSE app.contract_shared_decision_current(l.case_id,l.decision_revision) END;
 IF l.purpose<>'email' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l.data->'definition'->'blocks','[]'::jsonb)) block WHERE block->>'type' IN('field','fields')) THEN
  is_current:=is_current AND app.contract_company_entitled((SELECT company_id FROM public.contract_case WHERE tenant_id=l.tenant_id AND id=l.case_id));
 END IF;
 SELECT step INTO pending FROM app.document_signing_pending_steps(d.data) step WHERE step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',step->>'id','label',step->>'label','stage',(step->>'stage')::integer,'kind',step->>'kind','owner',coalesce(step->'owner','false'),
 'assigneeName',p.full_name,'unavailable',step->>'holderId' IS NULL OR NOT app.contract_verified_human(u.id),'fulfilled',app.document_signing_step_fulfilled(d.data,step)) ORDER BY n),'[]'::jsonb) INTO layers
 FROM jsonb_array_elements(d.data->'route'->'steps') WITH ORDINALITY x(step,n)
 LEFT JOIN public.app_user u ON u.tenant_id=l.tenant_id AND u.id::text=step->>'holderId' AND u.person_id::text=step->>'holderPersonId'
 LEFT JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','stepId',x->>'stepId','actorName',x->>'actorName','action',x->>'action','comment',x->>'comment','at',x->>'at','revision',x->'contentRevision','hash',x->>'contentHash') ORDER BY n),'[]'::jsonb) INTO history FROM jsonb_array_elements(d.data->'actions') WITH ORDINALITY actions(x,n);
 IF visible THEN
  snapshot:=app.contract_shared_letter_snapshot(l.id);fingerprint:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
  SELECT coalesce(jsonb_agg(jsonb_build_object('stepId',x->>'stepId','role',x->>'role','actorId',x->>'actorId','actorName',x->>'actorName','at',x->>'at','signature',x->'signature') ORDER BY n),'[]'::jsonb) INTO receipts
  FROM app.document_signing_round_actions(d.data) WITH ORDINALITY actions(x,n) WHERE x->>'action'='signed' AND NOT app.document_signing_returned(d.data) AND x->>'contentHash'=fingerprint;
 END IF;
 RETURN jsonb_build_object('id',l.id,'caseId',l.case_id,'decisionRevision',l.decision_revision,'templateId',l.data->>'templateId','templateVersion',l.data->'templateVersion','name',l.data->'definition'->>'name',
 'generatedOn',l.data->>'generatedOn','state',l.data->>'state','valuesFixed',l.data->'valuesFixed','releasedAt',l.data->>'releasedAt','contentRevision',l.data->'contentRevision','contentHash',fingerprint,
 'layers',layers,'history',history,'returned',app.document_signing_returned(d.data),
 'canEdit',visible AND is_current AND l.data->>'state'='routing' AND app.document_signing_can_edit(d.data,app.current_user_id()),
 'canResend',visible AND is_current AND l.data->>'state'='routing' AND app.document_signing_returned(d.data) AND app.document_signing_owner(d.data)=app.current_user_id(),
 'pendingAction',CASE WHEN visible AND is_current AND l.data->>'state'='routing' AND pending IS NOT NULL AND NOT app.document_signing_returned(d.data) THEN jsonb_build_object('stepId',pending->>'id','kind',pending->>'kind') ELSE NULL END,
 'body',CASE WHEN visible THEN jsonb_build_object('definition',snapshot->'definition','blocks',snapshot->'blocks','values',snapshot->'values','receipts',receipts,'fingerprintSource',snapshot::text) ELSE NULL END);
END $$;
