-- Each authored Generate document step owns its own immutable letter and retry identity.
DROP INDEX public.contract_shared_letter_purpose;
ALTER TABLE public.contract_shared_letter DROP CONSTRAINT contract_shared_letter_purpose_check;
ALTER TABLE public.contract_shared_letter ADD CONSTRAINT contract_shared_letter_purpose_check CHECK(purpose IN('outcome','declined','email'));
CREATE UNIQUE INDEX contract_shared_letter_run_step ON public.contract_shared_letter(tenant_id,workflow_run_id,workflow_step_id,(data->>'templateId'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_prepare_letter(p_case uuid,p_run uuid,p_step text,p_template uuid,p_version integer,p_route jsonb,p_routing jsonb,p_email_ref jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f public.contract_shared_case;c public.contract_case;definition jsonb;expected_template text;blocks jsonb;snapshot jsonb;fingerprint text;next_data jsonb;employee_person uuid;letter_purpose text;run_trigger text;step_type text;email_documents jsonb;expected_email text;
BEGIN
 PERFORM app.contract_shared_lock_source(p_case);
 IF app.contract_shared_effect_held(p_case,p_run,p_step,'generateDocument') IS NOT TRUE AND app.contract_shared_effect_held(p_case,p_run,p_step,'sendEmail') IS NOT TRUE THEN RAISE EXCEPTION 'Protected letter intent required' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case FOR UPDATE;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=f.tenant_id AND id=f.case_id;
 SELECT s->>'type',s->'params'->>'letterTemplateId',s->'params'->>'emailTemplateId' INTO step_type,expected_template,expected_email FROM public.automation_run r JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision
 CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') s WHERE r.tenant_id=c.tenant_id AND r.id=p_run AND s->>'id'=p_step;
 SELECT trigger_event INTO run_trigger FROM public.automation_run WHERE tenant_id=c.tenant_id AND id=p_run;
 letter_purpose:=CASE WHEN f.data->'declined' IS DISTINCT FROM 'null'::jsonb THEN 'declined' ELSE 'outcome' END;
 IF step_type='sendEmail' THEN
  IF p_email_ref->>'id' IS DISTINCT FROM expected_email OR coalesce(p_email_ref->>'revision','') !~ '^[1-9][0-9]{0,5}$' THEN RAISE EXCEPTION 'The actual email definition receipt is required' USING ERRCODE='40001';END IF;
  -- 5827 owns the nullable document_ids extension; this query resolves only when that shared owner is installed.
  EXECUTE 'SELECT document_ids FROM public.automation_email_template_version WHERE tenant_id=$1 AND template_id=$2 AND revision=$3 AND module=''contract_staff'' AND active AND NOT retired'
   INTO email_documents USING c.tenant_id,(p_email_ref->>'id')::uuid,(p_email_ref->>'revision')::integer;
  IF email_documents IS NULL OR NOT email_documents ? p_template::text THEN RAISE EXCEPTION 'This immutable email definition does not include the document' USING ERRCODE='40001';END IF;
  letter_purpose:='email';
 ELSIF step_type<>'generateDocument' OR p_email_ref IS NOT NULL OR expected_template IS DISTINCT FROM p_template::text OR (letter_purpose='declined' AND run_trigger<>'employeeDeclined') THEN RAISE EXCEPTION 'Letter purpose changed' USING ERRCODE='40001';END IF;
 SELECT v.definition INTO definition FROM public.automation_document_template h JOIN public.automation_document_template_version v ON v.tenant_id=h.tenant_id AND v.template_id=h.id AND v.version=h.live_version
 WHERE h.tenant_id=c.tenant_id AND h.id=p_template AND h.module='contract_staff' AND NOT h.retired AND h.live_version=p_version;
 IF definition IS NULL THEN RAISE EXCEPTION 'Published Contract template changed' USING ERRCODE='40001';END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=c.tenant_id AND case_id=c.id AND decision_revision=(f.data->'decision'->>'revision')::integer AND workflow_run_id=p_run AND workflow_step_id=p_step AND data->>'templateId'=p_template::text;
 IF l.id IS NOT NULL THEN
  IF l.data->>'templateId'<>p_template::text THEN RAISE EXCEPTION 'This decision already has a different outcome letter' USING ERRCODE='40001';END IF;
  RETURN jsonb_build_object('id',l.id,'signingDocumentId',l.signing_document_id,'contentHash',(SELECT d.data->>'contentHash' FROM public.document_signing_document d WHERE d.tenant_id=l.tenant_id AND d.id=l.signing_document_id),'state',l.data->>'state','existing',true);
 END IF;
 IF p_routing->>'templateId' IS DISTINCT FROM p_template::text OR p_routing->>'templateVersion' IS DISTINCT FROM p_version::text OR p_routing->'liveMergeReviews' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Invalid pinned template routing' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(p_route->'steps')<>jsonb_array_length(definition->'routing') OR EXISTS(SELECT 1 FROM jsonb_array_elements(definition->'routing') s WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') t WHERE t->>'id'=s->>'id' AND t->>'kind'=s->>'action' AND t->'stage'=s->'order' AND coalesce(t->'owner','false')=coalesce(s->'owner','false'))) THEN RAISE EXCEPTION 'Letter route differs from its published template' USING ERRCODE='22023';END IF;
 SELECT e.person_id INTO employee_person FROM public.employment e WHERE e.tenant_id=c.tenant_id AND e.id=c.employment_id;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='employee' AND s->>'holderId' IS NOT NULL AND s->>'holderPersonId' IS DISTINCT FROM employee_person::text) THEN RAISE EXCEPTION 'An employee step cannot use a substitute signer' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_object_agg(b->>'id',CASE WHEN b->>'type'='table' THEN coalesce(b->>'rows','') ELSE coalesce(b->>'text','') END),'{}'::jsonb) INTO blocks FROM jsonb_array_elements(definition->'blocks') b WHERE b->>'type' IN('heading','subheading','text','table');
 l.id:=gen_random_uuid();l.signing_document_id:=gen_random_uuid();
 INSERT INTO public.contract_shared_letter(tenant_id,id,case_id,signing_document_id,decision_revision,workflow_run_id,workflow_step_id,purpose,data)
 VALUES(c.tenant_id,l.id,c.id,l.signing_document_id,(f.data->'decision'->>'revision')::integer,p_run,p_step,letter_purpose,jsonb_build_object('id',l.id,'templateId',p_template,'templateVersion',p_version,'generatedOn',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'subjectPersonId',employee_person,'emailTemplateRef',p_email_ref,'state','routing','values','{}'::jsonb,'valuesFixed',false,'blocks',blocks,'definition',jsonb_build_object('name',definition->>'name','blocks',definition->'blocks','fields',definition->'fields'),'releasedAt',NULL,'contentRevision',1,
 'signingPolicy',jsonb_build_object('route',p_route,'routing',p_routing,'guardrails',jsonb_build_object('requiredRoles','[]'::jsonb))));
 snapshot:=app.contract_shared_letter_snapshot(l.id);fingerprint:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{values}',snapshot->'values') WHERE tenant_id=c.tenant_id AND id=l.id;
 INSERT INTO public.contract_shared_letter_content(tenant_id,letter_id,content_revision,content_hash,snapshot) VALUES(c.tenant_id,l.id,1,fingerprint,snapshot);
 IF letter_purpose='email' THEN RETURN jsonb_build_object('id',l.id,'signingDocumentId',l.signing_document_id,'contentHash',fingerprint,'state','routing','existing',false);END IF;
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'stage','document','lastActivityAt',now());
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='employee' AND s->>'kind'='sign' AND s->>'holderId' IS NULL) THEN next_data:=jsonb_set(next_data,'{flags}',(next_data->'flags')||'"employee_cannot_sign"'::jsonb);END IF;
 UPDATE public.contract_shared_case SET data=next_data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 RETURN jsonb_build_object('id',l.id,'signingDocumentId',l.signing_document_id,'contentHash',fingerprint,'state','routing','existing',false);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_prepare_letter(uuid,uuid,text,uuid,integer,jsonb,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_prepare_letter(p_case uuid,p_run uuid,p_step text,p_template uuid,p_version integer,p_route jsonb,p_routing jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_prepare_letter(p_case,p_run,p_step,p_template,p_version,p_route,p_routing,NULL)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_prepare_letter(uuid,uuid,text,uuid,integer,jsonb,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Resolves the actual preceding released document of this run, or the exact letter-released event.
-- A different run's or earlier decision's released letter can never authorize a business posting/handoff.
CREATE FUNCTION app.contract_shared_released_step_letter(p_case uuid,p_run uuid,p_step text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;r public.automation_run;e public.contract_shared_event;result uuid;wanted_purpose text;step_order bigint;
BEGIN
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;
 SELECT * INTO r FROM public.automation_run WHERE tenant_id=f.tenant_id AND id=p_run AND module='contract_staff' AND subject_id=p_case;
 SELECT * INTO e FROM public.contract_shared_event WHERE tenant_id=f.tenant_id AND case_id=p_case AND id::text=current_setting('app.contract_event',true);
 IF r.id IS NULL OR e.id IS NULL OR app.contract_shared_worker_event_held(p_case,e.decision_revision) IS NOT TRUE THEN RETURN NULL;END IF;
 wanted_purpose:=CASE WHEN f.data->'declined' IS DISTINCT FROM 'null'::jsonb THEN 'declined' ELSE 'outcome' END;
 SELECT n INTO step_order FROM public.automation_workflow_version v CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') WITH ORDINALITY steps(s,n)
 WHERE v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision AND s->>'id'=p_step;
 SELECT letter.id INTO result FROM public.contract_shared_letter letter JOIN public.document_signing_document document ON document.tenant_id=letter.tenant_id AND document.id=letter.signing_document_id
 JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision
 CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') WITH ORDINALITY steps(s,n)
 WHERE letter.tenant_id=f.tenant_id AND letter.case_id=p_case AND letter.decision_revision=(f.data->'decision'->>'revision')::integer AND letter.purpose=wanted_purpose
 AND letter.workflow_run_id=p_run AND s->>'id'=letter.workflow_step_id AND s->>'type'='generateDocument' AND n<step_order
 AND letter.data->>'state'='released' AND letter.data->'valuesFixed'='true'::jsonb AND NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document.data)) AND NOT app.document_signing_returned(document.data)
 ORDER BY n DESC LIMIT 1;
 IF result IS NULL AND e.trigger_event='letterReleased' AND r.trigger_event='letterReleased' AND r.event_key=e.trigger_event||'|'||e.occurrence THEN
  SELECT letter.id INTO result FROM public.contract_shared_letter letter JOIN public.document_signing_document document ON document.tenant_id=letter.tenant_id AND document.id=letter.signing_document_id
  WHERE letter.tenant_id=f.tenant_id AND letter.case_id=p_case AND letter.id::text=e.data->>'letterId' AND letter.decision_revision=(f.data->'decision'->>'revision')::integer AND letter.purpose=wanted_purpose
  AND letter.data->>'state'='released' AND letter.data->'valuesFixed'='true'::jsonb AND NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document.data)) AND NOT app.document_signing_returned(document.data);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_released_step_letter(uuid,uuid,text) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
