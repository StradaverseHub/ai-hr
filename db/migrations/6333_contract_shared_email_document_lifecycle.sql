-- Email Forms/Acknowledgements are independent signing tasks. Completing one never changes the Contract
-- posting, pay confirmation or closure. The frozen person and historical decision remain its identity boundary.
CREATE FUNCTION app.contract_shared_email_document_current(p_letter uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_letter l JOIN public.contract_shared_case f ON f.tenant_id=l.tenant_id AND f.case_id=l.case_id
 JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter AND l.purpose='email' AND employment.person_id::text=l.data->>'subjectPersonId' AND employment.voided_at IS NULL
 AND ((f.data->'decision'->>'revision')::integer=l.decision_revision OR EXISTS(SELECT 1 FROM jsonb_array_elements(f.data->'decisionHistory') decision WHERE (decision->>'revision')::integer=l.decision_revision)))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_document_current(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.contract_shared_signing_access(text,uuid,text) RENAME TO contract_shared_signing_access_before_email_documents;
CREATE FUNCTION app.contract_shared_signing_access(p_type text,p_subject uuid,p_operation text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;document jsonb;assigned boolean;
BEGIN
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
REVOKE ALL ON FUNCTION app.contract_shared_signing_access_before_email_documents(text,uuid,text),app.contract_shared_signing_access(text,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_action_allowed(p_letter uuid,p_action jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_action->>'action' IN('signed','reviewed','approved','returned','resent') AND EXISTS(SELECT 1 FROM public.contract_shared_letter l
 WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter AND l.data->>'state'='routing'
 AND CASE WHEN l.purpose='email' THEN app.contract_shared_email_document_current(l.id) ELSE app.contract_shared_decision_current(l.case_id,l.decision_revision) END)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_action_allowed(uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.contract_shared_signing_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.contract_shared_approval;l public.contract_shared_letter;f public.contract_shared_case;action jsonb;next_data jsonb;complete boolean;snapshot jsonb;flags jsonb;
BEGIN
 IF NEW.subject_type NOT IN('contract','contract-approval') OR jsonb_array_length(NEW.data->'actions')=jsonb_array_length(OLD.data->'actions') THEN RETURN NEW;END IF;
 IF NEW.subject_type='contract' THEN
  SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=NEW.tenant_id AND id=NEW.subject_id FOR UPDATE;
  IF l.purpose='email' THEN SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=l.tenant_id AND case_id=l.case_id;
  ELSE SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=l.tenant_id AND case_id=l.case_id FOR UPDATE;END IF;
  IF l.id IS NULL OR (CASE WHEN l.purpose='email' THEN app.contract_shared_email_document_current(l.id) ELSE app.contract_shared_decision_current(l.case_id,l.decision_revision) END) IS NOT TRUE THEN RAISE EXCEPTION 'Letter decision changed' USING ERRCODE='40001';END IF;
  action:=NEW.data->'actions'->-1;
  complete:=NOT app.document_signing_returned(NEW.data) AND NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(NEW.data));
  SELECT content.snapshot INTO snapshot FROM public.contract_shared_letter_content content WHERE content.tenant_id=l.tenant_id AND content.letter_id=l.id
   AND content.content_revision=(NEW.data->>'contentRevision')::integer AND content.content_hash=NEW.data->>'contentHash';
  IF snapshot IS NULL THEN RAISE EXCEPTION 'The action has no exact retained letter snapshot' USING ERRCODE='40001';END IF;
  UPDATE public.contract_shared_letter SET data=data||jsonb_build_object('values',snapshot->'values','valuesFixed',NOT app.document_signing_returned(NEW.data) AND (app.document_signing_locked(NEW.data) OR complete),
   'state',CASE WHEN complete THEN 'released' ELSE 'routing' END,'releasedAt',CASE WHEN complete THEN action->>'at' ELSE NULL END),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
  -- Canonical signing revisions/actions already audit this task. Email tasks cannot fire Contract outcome workflows.
  IF l.purpose='email' THEN RETURN NEW;END IF;
  SELECT coalesce(jsonb_agg(flag),'[]'::jsonb) INTO flags FROM jsonb_array_elements(f.data->'flags') flag WHERE flag#>>'{}'<>'sent_back';
  IF app.document_signing_returned(NEW.data) THEN flags:=flags||'"sent_back"'::jsonb;END IF;
  next_data:=f.data||jsonb_build_object('revision',f.revision+1,'lastActivityAt',now(),'stage',CASE WHEN complete THEN 'workflow' ELSE 'document' END,'flags',flags);
  IF action->>'action'='returned' THEN
   PERFORM app.contract_shared_enqueue_event(l.case_id,'letterSentBack','letter:'||l.id::text||':action:'||(action->>'id'),jsonb_build_object('letterId',l.id,'decision',f.data->'decision','period',f.data->'period','sentBackBy',action->>'actorName','sentBackReason',action->>'comment'));
  ELSIF complete THEN
   PERFORM app.contract_shared_enqueue_event(l.case_id,'letterReleased','letter:'||l.id::text||':action:'||(action->>'id'),jsonb_build_object('letterId',l.id,'decision',f.data->'decision','period',f.data->'period'));
  ELSE
   PERFORM app.contract_shared_enqueue_event(l.case_id,'letterActionNeeded','letter:'||l.id::text||':action:'||(action->>'id'),jsonb_build_object('letterId',l.id,'decision',f.data->'decision','period',f.data->'period'));
  END IF;
  UPDATE public.contract_shared_case SET data=next_data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
  RETURN NEW;
 END IF;
 SELECT * INTO a FROM public.contract_shared_approval WHERE tenant_id=NEW.tenant_id AND id=NEW.subject_id;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=a.tenant_id AND case_id=a.case_id FOR UPDATE;
 IF a.id IS NULL OR app.contract_shared_decision_current(a.case_id,a.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Approval decision changed' USING ERRCODE='40001';END IF;
 action:=NEW.data->'actions'->-1;
 complete:=NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(NEW.data));
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'lastActivityAt',now(),'stage',CASE WHEN complete THEN 'workflow' ELSE 'approval' END);
 IF action->>'action'='returned' THEN
  PERFORM app.contract_shared_enqueue_event(a.case_id,'approvalRejected','approval:'||a.id::text,jsonb_build_object('approvalId',a.id,'decision',f.data->'decision','period',f.data->'period','reason',action->>'comment'));
  next_data:=next_data||jsonb_build_object('stage','open','decision',NULL,'decisionHistory',(f.data->'decisionHistory')||jsonb_build_array(f.data->'decision'),'flags','[]'::jsonb,'posting',NULL,'payConfirmation',NULL);
 ELSIF complete THEN
  PERFORM app.contract_shared_enqueue_event(a.case_id,'approvalsComplete','approval:'||a.id::text,jsonb_build_object('approvalId',a.id,'decision',f.data->'decision','period',f.data->'period'));
 END IF;
 UPDATE public.contract_shared_case SET data=next_data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_signing_progress() FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_binding_actor(p_letter uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.contract_shared_letter l
 JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 JOIN public.document_signing_document signing ON signing.tenant_id=l.tenant_id AND signing.id=l.signing_document_id
 WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter AND l.data->>'state'='routing' AND CASE WHEN l.purpose='email' THEN app.contract_shared_email_document_current(l.id) ELSE app.contract_shared_decision_current(l.case_id,l.decision_revision) END
 AND (employment.person_id=app.contract_actor_person(app.current_user_id())
 OR app.document_signing_owner(signing.data)=app.current_user_id() AND app.document_signing_owner_step(signing.data)->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text
 OR app.contract_shared_case_permitted(c.id,'view') AND app.contract_shared_case_permitted(c.id,'manual')))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_binding_actor(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_bind_employee(p_letter uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;d public.document_signing_document;f public.contract_shared_case;employee_person uuid;account_id uuid;account_count integer;route jsonb;snapshot jsonb;fingerprint text;next_document jsonb;flags jsonb;
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
 snapshot:=app.contract_shared_letter_snapshot(l.id);fingerprint:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 IF d.data->>'contentHash' IS DISTINCT FROM fingerprint THEN
  IF app.document_signing_locked(d.data) THEN RAISE EXCEPTION 'Signed values changed' USING ERRCODE='40001';END IF;
  UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{values}',snapshot->'values'),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
  INSERT INTO public.contract_shared_letter_content(tenant_id,letter_id,content_revision,content_hash,snapshot) VALUES(l.tenant_id,l.id,(d.data->>'contentRevision')::integer,fingerprint,snapshot) ON CONFLICT DO NOTHING;
  next_document:=jsonb_set(d.data,'{contentHash}',to_jsonb(fingerprint));
  PERFORM app.document_signing_store(d.id,d.employment_id,d.company_id,d.subject_id,next_document,d.guardrails,d.revision,'live_refresh','Refreshed live fields before verified employee sign-in binding');
  SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id;
 END IF;
 SELECT jsonb_set(d.data->'route','{steps}',jsonb_agg(CASE WHEN step->>'role'='employee' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(d.data,step) THEN step||jsonb_build_object('holderId',account_id,'holderPersonId',employee_person) ELSE step END ORDER BY n)) INTO route FROM jsonb_array_elements(d.data->'route'->'steps') WITH ORDINALITY x(step,n);
 UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{signingPolicy,route}',route),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
 next_document:=jsonb_set(d.data,'{route}',route);
 PERFORM app.document_signing_store(d.id,d.employment_id,d.company_id,d.subject_id,next_document,d.guardrails,d.revision,'reroute','Bound the unique verified employee login to the existing employee steps');
 IF l.purpose='email' THEN RETURN;END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=l.tenant_id AND case_id=l.case_id FOR UPDATE;
 SELECT coalesce(jsonb_agg(flag),'[]'::jsonb) INTO flags FROM jsonb_array_elements(f.data->'flags') flag WHERE flag#>>'{}'<>'employee_cannot_sign';
 UPDATE public.contract_shared_case SET data=f.data||jsonb_build_object('revision',f.revision+1,'flags',flags,'lastActivityAt',now()),revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(next_document) step WHERE step->>'role'='employee' AND step->>'holderId'=account_id::text) THEN
  PERFORM app.contract_shared_enqueue_event(l.case_id,'letterActionNeeded','letter:'||l.id::text||':employee-login:'||account_id::text,jsonb_build_object('letterId',l.id,'decision',f.data->'decision','period',f.data->'period'));
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_bind_employee(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_letter_bind_employee(uuid) TO ai_hr_app;

--> statement-breakpoint
