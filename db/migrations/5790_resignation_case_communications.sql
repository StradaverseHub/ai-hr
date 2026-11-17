-- Per-case inspection and actor-only test intents. No legacy runner or transport changes.
-- Allocation reserved by the release coordinator; journal admission is owned there.
CREATE FUNCTION app.resignation_communication_case_scope(p_case uuid,p_offboarding uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j resignation_journey;u app_user;l jsonb;step jsonb;owner_step jsonb;mine boolean;owner_mine boolean;seen boolean;letter_visible boolean;acceptance boolean:=true;retention boolean:=true;acceptance_n integer:=0;retention_n integer:=0;editable boolean:=false;
BEGIN
 SELECT * INTO j FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 SELECT * INTO u FROM app_user WHERE tenant_id=app.current_tenant_id() AND id=app.current_user_id() AND archived_at IS NULL AND person_id IS NOT NULL AND NOT app.login_blocked(id);
 IF j.id IS NULL OR u.id IS NULL OR NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM company c JOIN tenant t ON t.id=c.tenant_id WHERE c.id=j.company_id AND c.tenant_id=j.tenant_id AND c.archived_at IS NULL AND t.status IN('active','trial') AND EXISTS(SELECT 1 FROM tenant_module m WHERE m.tenant_id=c.tenant_id AND m.module_code='lifecycle' AND (m.company_id IS NULL OR m.company_id=c.id) AND m.status IN('active','trial') AND m.activated_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now()))) THEN RETURN '{}'::jsonb;END IF;
 IF p_offboarding IS NOT NULL THEN
  IF NOT app.lc_v9_off_access(j.company_id) OR NOT EXISTS(SELECT 1 FROM lc_v9_case c WHERE c.tenant_id=j.tenant_id AND c.id=p_offboarding AND c.id=j.offboarding_case_id AND c.company_id=j.company_id AND c.employment_id=j.employment_id AND c.data->>'resignationSourceCaseId'=j.id::text) THEN RETURN '{}'::jsonb;END IF;
 ELSIF NOT app.resignation_journey_access(p_case) THEN RETURN '{}'::jsonb;END IF;
 -- Actor/company admission is evaluated ONCE. The following loop touches only the bounded JSON snapshot.
 FOR l IN SELECT value FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) WHERE value->>'state' IN('review','owner','released') LOOP
  mine:=false;seen:=false;owner_mine:=false;owner_step:=NULL;
  SELECT value INTO owner_step FROM jsonb_array_elements(coalesce(l->'document'->'route'->'steps','[]')) WITH ORDINALITY s(value,n) ORDER BY CASE WHEN value->>'owner'='true' THEN 0 WHEN value->>'kind'='review' THEN 1 ELSE 2 END,(value->>'stage')::integer,n LIMIT 1;
  FOR step IN SELECT value FROM jsonb_array_elements(coalesce(l->'document'->'route'->'steps','[]')) LOOP
   IF CASE WHEN l->'teamSteps' ? (step->>'id') THEN l->'teamSteps'->(step->>'id')->'memberIds' ? u.id::text AND l->'teamSteps'->(step->>'id')->'personIds'->>u.id::text=u.person_id::text ELSE step->>'holderId'=u.id::text AND (NOT(step ? 'holderPersonId') OR step->>'holderPersonId'=u.person_id::text) END THEN
    seen:=true;
    IF step=owner_step AND (owner_step->>'owner'='true' OR owner_step->>'kind'='review') THEN owner_mine:=true;END IF;
    IF EXISTS(SELECT 1 FROM app.resignation_pending_steps(l) pending WHERE pending->>'id'=step->>'id') THEN mine:=true;END IF;
   END IF;
  END LOOP;
  IF owner_step IS NULL OR (owner_step->>'owner' IS DISTINCT FROM 'true' AND owner_step->>'kind' IS DISTINCT FROM 'review') THEN owner_mine:=l->'document'->'routing'->>'caseOwnerId'=u.id::text;END IF;
  letter_visible:=l->>'state' IN('review','owner','released') AND (owner_mine OR mine OR l->>'state'='released' AND (seen OR l->>'employeeUserId'=u.id::text) OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l->'history','[]')) a WHERE a->>'actorId'=u.id::text AND a->>'actorPersonId'=u.person_id::text));
  IF p_offboarding IS NOT NULL AND l->>'kind'='acceptance' AND l->>'state'='released' THEN letter_visible:=true;END IF;
  IF l->>'kind'='acceptance' THEN acceptance_n:=acceptance_n+1;acceptance:=acceptance AND coalesce(letter_visible,false);ELSIF l->>'kind'='retention' THEN retention_n:=retention_n+1;retention:=retention AND coalesce(letter_visible,false);END IF;
  editable:=editable OR (owner_mine AND l->>'state' IN('review','owner') AND (l->>'state'='owner' OR mine) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l->'document'->'actions','[]')) a WHERE a->>'action'='signed' AND a->>'contentRevision'=l->>'revision'));
 END LOOP;
 RETURN jsonb_build_object('acceptance',acceptance_n>0 AND acceptance,'retention',p_offboarding IS NULL AND retention_n>0 AND retention,'submitted',p_offboarding IS NULL AND j.stage='decision' AND j.data->'decision'->'to' ? u.id::text,'editable',coalesce(editable,false),'offboarding',p_offboarding IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION app.resignation_communication_case_scope(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.resignation_communication_scope(p_case uuid,p_run uuid,p_offboarding uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH scope AS MATERIALIZED(SELECT app.resignation_communication_case_scope(p_case,p_offboarding) data)
 SELECT coalesce((SELECT jsonb_build_object('visible',CASE WHEN p_offboarding IS NOT NULL THEN r.trigger_event='accepted' AND coalesce((scope.data->>'acceptance')::boolean,false) WHEN r.trigger_event IN('retention','offerAccepted','offerDeclined','offerDue','rejected') THEN coalesce((scope.data->>'retention')::boolean,false) WHEN r.trigger_event='submitted' THEN coalesce((scope.data->>'submitted')::boolean,false) ELSE coalesce((scope.data->>'acceptance')::boolean,false) END,'editable',coalesce((scope.data->>'editable')::boolean,false) AND r.status IN('running','waiting','failed')) FROM automation_run r,scope WHERE r.tenant_id=app.current_tenant_id() AND r.subject_id=p_case AND r.id=p_run AND r.module='off'),'{}'::jsonb);
$$;
REVOKE ALL ON FUNCTION app.resignation_communication_scope(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_communication_scope(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE public.resignation_communication_test (
 tenant_id uuid NOT NULL,case_id uuid NOT NULL,actor_id uuid NOT NULL,request_id uuid NOT NULL,
 case_revision integer NOT NULL CHECK(case_revision>0),run_id uuid NOT NULL,step_id text NOT NULL CHECK(length(step_id) BETWEEN 1 AND 200),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,case_id,actor_id,request_id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES public.resignation_journey(tenant_id,id),
 FOREIGN KEY(actor_id,tenant_id) REFERENCES public.app_user(id,tenant_id)
);
ALTER TABLE public.resignation_communication_test ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resignation_communication_test FORCE ROW LEVEL SECURITY;
CREATE POLICY resignation_communication_test_owner ON public.resignation_communication_test FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON public.resignation_communication_test FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.resignation_communication_test_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'Message test receipts are immutable' USING ERRCODE='42501';END $$;
CREATE TRIGGER resignation_communication_test_immutable BEFORE UPDATE OR DELETE ON public.resignation_communication_test FOR EACH ROW EXECUTE FUNCTION app.resignation_communication_test_immutable();
--> statement-breakpoint
CREATE FUNCTION app.resignation_communication_test_receipt(p_case uuid,p_revision integer,p_run uuid,p_step text,p_request uuid,p_offboarding uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt resignation_communication_test;
BEGIN
 IF coalesce((app.resignation_communication_scope(p_case,p_run,p_offboarding)->>'visible')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'This message is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO receipt FROM resignation_communication_test WHERE tenant_id=app.current_tenant_id() AND case_id=p_case AND actor_id=app.current_user_id() AND request_id=p_request;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF receipt.case_revision<>p_revision OR receipt.run_id<>p_run OR receipt.step_id<>p_step THEN RAISE EXCEPTION 'This test request was already used for another message revision' USING ERRCODE='40001'; END IF;
 RETURN jsonb_build_object('requestId',p_request,'status','queued','replayed',true);
END $$;
REVOKE ALL ON FUNCTION app.resignation_communication_test_receipt(uuid,integer,uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_communication_test_receipt(uuid,integer,uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.resignation_communication_test_begin(p_case uuid,p_revision integer,p_run uuid,p_step text,p_request uuid,p_offboarding uuid,p_mail jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof jsonb;j resignation_journey;definition jsonb;scope jsonb;email_template jsonb;message_step jsonb;
BEGIN
 proof:=app.resignation_runtime_consume('context',p_case,jsonb_build_object('mode','communicationTest','caseId',p_case,'revision',p_revision,'runId',p_run,'stepId',p_step,'requestId',p_request,'offboardingCaseId',p_offboarding,'mail',p_mail));
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO j FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=p_case FOR UPDATE;
 scope:=app.resignation_communication_scope(p_case,p_run,p_offboarding);
 IF coalesce((scope->>'visible')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'This message is unavailable' USING ERRCODE='42501'; END IF;
 IF j.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This case changed; reload before sending a test' USING ERRCODE='40001';END IF;
 SELECT v.definition INTO definition FROM automation_run r JOIN automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision WHERE r.tenant_id=j.tenant_id AND r.id=p_run AND r.module='off' AND r.subject_id=j.id;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(definition->'steps','[]')) s WHERE s->>'id'=p_step AND s->>'type'='sendEmail') THEN RAISE EXCEPTION 'The pinned message step is unavailable' USING ERRCODE='42501'; END IF;
 SELECT value INTO message_step FROM jsonb_array_elements(coalesce(definition->'steps','[]')) WHERE value->>'id'=p_step AND value->>'type'='sendEmail';
 IF p_mail->'content'->>'emailTemplateId' IS DISTINCT FROM message_step->'params'->>'emailTemplateId' THEN RAISE EXCEPTION 'The message template differs from its pinned step' USING ERRCODE='42501';END IF;
 SELECT coalesce((SELECT waiting->'email'->'template' FROM jsonb_array_elements(coalesce(j.data->'waits','[]')) waiting WHERE waiting->>'runId'=p_run::text AND waiting->>'kind'='file' LIMIT 1),(SELECT e FROM lc_v9_config cfg CROSS JOIN LATERAL jsonb_array_elements(coalesce(cfg.data->'emails','[]')) e WHERE cfg.tenant_id=j.tenant_id AND e->>'id'=message_step->'params'->>'emailTemplateId' AND e->>'module'='off' LIMIT 1)) INTO email_template;
 IF email_template IS NULL OR email_template->>'active' IS DISTINCT FROM 'true' OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(email_template->'slots','[]')) slot WHERE slot->>'required'='true' AND NOT EXISTS(SELECT 1 FROM resignation_journey_file f WHERE f.tenant_id=j.tenant_id AND f.case_id=j.id AND f.slot=(email_template->>'id')||':'||(slot->>'id') AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_mail->'content'->'files','[]')) included WHERE included->>'id'=f.id::text))) THEN RAISE EXCEPTION 'Resolve the active template and required case-file holds before sending a test' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(email_template->'attachments','[]')) required WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_mail->'content'->'documents','[]')) d WHERE d->>'templateId'=required AND p_mail->'content'->'pdfDocumentIds' ? (d->>'id'))) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(email_template->'links','[]')) required WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_mail->'content'->'documents','[]')) d WHERE d->>'templateId'=required AND p_mail->'content'->'linkDocumentIds' ? (d->>'id'))) THEN RAISE EXCEPTION 'Required released letters must be included in the test' USING ERRCODE='22023';END IF;
 IF p_mail->'holds' IS DISTINCT FROM '[]'::jsonb OR jsonb_typeof(p_mail->'subject')<>'string' OR jsonb_typeof(p_mail->'body')<>'string' OR jsonb_typeof(p_mail->'content')<>'object' THEN RAISE EXCEPTION 'Resolve message holds before sending a test' USING ERRCODE='22023';END IF;
 -- No request may choose recipients. The live worker resolves this actual user's verified identity.
 IF NOT EXISTS(SELECT 1 FROM app_external_identity i WHERE i.app_user_id=app.current_user_id() AND i.revoked_at IS NULL AND i.issuer LIKE '%/auth/'||app.current_tenant_id()::text) THEN RAISE EXCEPTION 'Your verified delivery identity is unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.resignation_runtime_state(tenant_id,actor,kind,transaction_id,payload,created_at)
 VALUES(app.current_tenant_id(),app.current_user_id()::text,'intent:'||p_case::text,txid_current(),proof||jsonb_build_object('initialStage',j.stage,'companyId',j.company_id,'command',jsonb_build_object('type','communicationTest','revision',p_revision,'runId',p_run,'stepId',p_step,'requestId',p_request,'mail',p_mail)),now())
 ON CONFLICT(tenant_id,actor,kind) DO UPDATE SET transaction_id=excluded.transaction_id,payload=excluded.payload,created_at=excluded.created_at;
END $$;
REVOKE ALL ON FUNCTION app.resignation_communication_test_begin(uuid,integer,uuid,text,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_communication_test_begin(uuid,integer,uuid,text,uuid,uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.resignation_communication_test_queue(p_case uuid,p_revision integer,p_run uuid,p_step text,p_request uuid,p_mail jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent jsonb;key text;hash text;receipt resignation_communication_test;result jsonb;
BEGIN
 SELECT payload INTO intent FROM app.resignation_runtime_state WHERE tenant_id=app.current_tenant_id() AND actor=app.current_user_id()::text AND kind='intent:'||p_case::text AND transaction_id=txid_current();
 IF intent->'command' IS DISTINCT FROM jsonb_build_object('type','communicationTest','revision',p_revision,'runId',p_run,'stepId',p_step,'requestId',p_request,'mail',p_mail) THEN RAISE EXCEPTION 'An exact message test intent is required' USING ERRCODE='42501';END IF;
 hash:=encode(sha256(convert_to(p_mail::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM resignation_communication_test WHERE tenant_id=app.current_tenant_id() AND case_id=p_case AND actor_id=app.current_user_id() AND request_id=p_request;
 IF FOUND THEN
  IF receipt.case_revision<>p_revision OR receipt.run_id<>p_run OR receipt.step_id<>p_step OR receipt.payload_hash<>hash THEN RAISE EXCEPTION 'The immutable test request differs' USING ERRCODE='40001';END IF;
  RETURN jsonb_build_object('requestId',p_request,'status','queued','replayed',true);
 END IF;
 key:='case-test:'||p_case::text||':'||app.current_user_id()::text||':'||p_request::text;
 -- Existing queue consumes the signed exact email proof and validates every released document, asset and case file.
 result:=app.resignation_email_queue(p_case,key,ARRAY[app.current_user_id()],'{}'::uuid[],left('[Test] '||(p_mail->>'subject'),500),p_mail->>'body',p_mail->'content');
 IF coalesce((result->>'queued')::integer,0)<>1 OR jsonb_array_length(coalesce(result->'unreachable','[]'))<>0 THEN RAISE EXCEPTION 'Your verified delivery identity is unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO resignation_communication_test(tenant_id,case_id,actor_id,request_id,case_revision,run_id,step_id,payload_hash) VALUES(app.current_tenant_id(),p_case,app.current_user_id(),p_request,p_revision,p_run,p_step,hash);
 RETURN jsonb_build_object('requestId',p_request,'status','queued','replayed',false);
END $$;
REVOKE ALL ON FUNCTION app.resignation_communication_test_queue(uuid,integer,uuid,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_communication_test_queue(uuid,integer,uuid,text,uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- A current letter reader may inspect only this case's pinned run; no shared configuration grant is added.
CREATE FUNCTION app.resignation_communication_runs(p_case uuid,p_offboarding uuid DEFAULT NULL)
RETURNS TABLE(id uuid,workflow_id uuid,workflow_revision integer,status text,trigger_event text,definition jsonb,editable boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH scope AS MATERIALIZED(SELECT app.resignation_communication_case_scope(p_case,p_offboarding) AS data)
 SELECT r.id,r.workflow_id,r.workflow_revision,r.status,r.trigger_event,v.definition,coalesce((scope.data->>'editable')::boolean,false) AND r.status IN('running','waiting','failed')
 FROM automation_run r JOIN automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision CROSS JOIN scope
 WHERE r.tenant_id=app.current_tenant_id() AND r.subject_id=p_case AND r.module='off' AND CASE WHEN p_offboarding IS NOT NULL THEN r.trigger_event='accepted' AND coalesce((scope.data->>'acceptance')::boolean,false) WHEN r.trigger_event IN('retention','offerAccepted','offerDeclined','offerDue','rejected') THEN coalesce((scope.data->>'retention')::boolean,false) WHEN r.trigger_event='submitted' THEN coalesce((scope.data->>'submitted')::boolean,false) ELSE coalesce((scope.data->>'acceptance')::boolean,false) END
 ORDER BY r.started_at DESC,r.id DESC LIMIT 30;
$$;
REVOKE ALL ON FUNCTION app.resignation_communication_runs(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_communication_runs(uuid,uuid) TO ai_hr_app;
