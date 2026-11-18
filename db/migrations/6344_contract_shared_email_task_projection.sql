-- Hosted43944812872 passed all6 native tests: already-authorized assigned email actors complete after posting,
-- closed Contract state is unchanged, changed subject person cannot act or leak values.
-- Projection parity only; all existing read/body visibility and command authorization checks stay unchanged.
CREATE OR REPLACE FUNCTION app.contract_shared_letter_read(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;d public.document_signing_document;visible boolean;is_current boolean;snapshot jsonb;fingerprint text;layers jsonb;history jsonb;receipts jsonb;pending jsonb;
BEGIN
 IF app.document_signing_subject_access('contract',p_letter,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This letter is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id;
 visible:=app.document_signing_content_visible(d.id,l.data->>'state'='released');
 is_current:=CASE WHEN l.purpose='email' THEN app.contract_shared_email_document_current(l.id) ELSE app.contract_shared_decision_current(l.case_id,l.decision_revision) END;
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
REVOKE ALL ON FUNCTION app.contract_shared_letter_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_letter_read(uuid) TO ai_hr_app;

--> statement-breakpoint
