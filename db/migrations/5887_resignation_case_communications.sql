-- Per-case inspection and actor-only test intents. No legacy runner or transport changes.
-- Allocation reserved by the release coordinator; journal admission is owned there.
CREATE FUNCTION app.resignation_communication_case_scope(p_case uuid,p_offboarding uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j resignation_journey;u app_user;l jsonb;step jsonb;owner_step jsonb;mine boolean;owner_mine boolean;seen boolean;letter_visible boolean;acceptance boolean:=true;retention boolean:=true;acceptance_n integer:=0;retention_n integer:=0;editable boolean:=false;
BEGIN
 SELECT * INTO j FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 SELECT * INTO u FROM app_user WHERE tenant_id=app.current_tenant_id() AND id=app.current_user_id() AND archived_at IS NULL AND NOT app.login_blocked(id);
 IF j.id IS NULL OR u.id IS NULL OR NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM company c JOIN tenant t ON t.id=c.tenant_id WHERE c.id=j.company_id AND c.tenant_id=j.tenant_id AND c.archived_at IS NULL AND t.status IN('active','trial') AND EXISTS(SELECT 1 FROM tenant_module m WHERE m.tenant_id=c.tenant_id AND m.module_code='lifecycle' AND (m.company_id IS NULL OR m.company_id=c.id) AND m.status IN('active','trial') AND m.activated_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now()))) THEN RETURN '{}'::jsonb;END IF;
 IF p_offboarding IS NOT NULL THEN
  IF NOT app.lc_v9_off_access(j.company_id) OR NOT EXISTS(SELECT 1 FROM lc_v9_case c WHERE c.tenant_id=j.tenant_id AND c.id=p_offboarding AND c.id=j.offboarding_case_id AND c.company_id=j.company_id AND c.employment_id=j.employment_id AND c.data->>'resignationSourceCaseId'=j.id::text) THEN RETURN '{}'::jsonb;END IF;
 ELSIF NOT app.resignation_journey_access(p_case) THEN RETURN '{}'::jsonb;END IF;
 -- Actor/company admission is evaluated ONCE. The following loop touches only the bounded JSON snapshot.
 FOR l IN SELECT value FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) WHERE value->>'state' IN('review','owner','released') LOOP
  mine:=false;seen:=false;owner_mine:=false;owner_step:=NULL;
  SELECT value INTO owner_step FROM jsonb_array_elements(coalesce(l->'document'->'route'->'steps','[]')) WITH ORDINALITY s(value,n) ORDER BY CASE WHEN value->>'owner'='true' THEN 0 WHEN value->>'kind'='review' THEN 1 ELSE 2 END,(value->>'stage')::integer,n LIMIT 1;
  FOR step IN SELECT value FROM jsonb_array_elements(coalesce(l->'document'->'route'->'steps','[]')) LOOP
   IF (CASE WHEN l->'teamSteps' ? (step->>'id') THEN l->'teamSteps'->(step->>'id')->'memberIds' ? u.id::text AND l->'teamSteps'->(step->>'id')->'personIds'->>u.id::text=u.person_id::text ELSE step->>'holderId'=u.id::text AND (NOT(step ? 'holderPersonId') OR step->>'holderPersonId'=u.person_id::text) END) THEN
    seen:=true;
    IF step=owner_step AND (owner_step->>'owner'='true' OR owner_step->>'kind'='review') THEN owner_mine:=true;END IF;
    IF EXISTS(SELECT 1 FROM app.resignation_pending_steps(l) pending WHERE pending->>'id'=step->>'id') THEN mine:=true;END IF;
   END IF;
  END LOOP;
  IF owner_step IS NULL OR (owner_step->>'owner' IS DISTINCT FROM 'true' AND owner_step->>'kind' IS DISTINCT FROM 'review') THEN owner_mine:=l->'document'->'routing'->>'caseOwnerId'=u.id::text;END IF;
  letter_visible:=u.person_id IS NOT NULL AND l->>'state' IN('review','owner','released') AND (owner_mine OR mine OR l->>'state'='released' AND (seen OR l->>'employeeUserId'=u.id::text AND j.person_id=u.person_id) OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l->'history','[]')) a WHERE a->>'actorId'=u.id::text AND a->>'actorPersonId'=u.person_id::text));
  IF p_offboarding IS NOT NULL AND l->>'kind'='acceptance' AND l->>'state'='released' THEN letter_visible:=true;END IF;
  IF l->>'kind'='acceptance' THEN acceptance_n:=acceptance_n+1;acceptance:=acceptance AND coalesce(letter_visible,false);ELSIF l->>'kind'='retention' THEN retention_n:=retention_n+1;retention:=retention AND coalesce(letter_visible,false);END IF;
  editable:=editable OR (u.person_id IS NOT NULL AND owner_mine AND l->>'state' IN('review','owner') AND (l->>'state'='owner' OR mine) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l->'document'->'actions','[]')) a WHERE a->>'action'='signed' AND a->>'contentRevision'=l->>'revision'));
 END LOOP;
 RETURN jsonb_build_object('admitted',true,'acceptanceCount',acceptance_n,'acceptance',acceptance_n>0 AND acceptance,'retention',p_offboarding IS NULL AND retention_n>0 AND retention,'submitted',p_offboarding IS NULL AND j.stage='decision' AND j.data->'decision'->'to' ? u.id::text,'editable',coalesce(editable,false),'offboarding',p_offboarding IS NOT NULL);
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
REVOKE ALL ON FUNCTION app.resignation_communication_test_immutable() FROM PUBLIC,ai_hr_app;
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
 SELECT coalesce((SELECT waiting->'email'->'template' FROM jsonb_array_elements(coalesce(j.data->'waits','[]')) waiting WHERE waiting->>'runId'=p_run::text AND waiting->>'kind'='file' AND waiting->'step'->>'id'=p_step LIMIT 1),(SELECT e FROM lc_v9_config cfg CROSS JOIN LATERAL jsonb_array_elements(coalesce(cfg.data->'emails','[]')) e WHERE cfg.tenant_id=j.tenant_id AND e->>'id'=message_step->'params'->>'emailTemplateId' AND e->>'module'='off' LIMIT 1)) INTO email_template;
 IF email_template IS NULL OR email_template->>'active' IS DISTINCT FROM 'true' OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(email_template->'slots','[]')) AS required_slot(value) WHERE required_slot.value->>'required'='true' AND NOT EXISTS(SELECT 1 FROM resignation_journey_file f WHERE f.tenant_id=j.tenant_id AND f.case_id=j.id AND f.slot=(email_template->>'id')||':'||(required_slot.value->>'id') AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_mail->'content'->'files','[]')) AS included_file(value) WHERE included_file.value->>'id'=f.id::text))) THEN RAISE EXCEPTION 'Resolve the active template and required case-file holds before sending a test' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(email_template->'attachments','[]')) required WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_mail->'content'->'documents','[]')) d WHERE d->>'templateId'=required AND p_mail->'content'->'pdfDocumentIds' ? (d->>'id'))) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(email_template->'links','[]')) required WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_mail->'content'->'documents','[]')) d WHERE d->>'templateId'=required AND p_mail->'content'->'linkDocumentIds' ? (d->>'id'))) THEN RAISE EXCEPTION 'Required released letters must be included in the test' USING ERRCODE='22023';END IF;
 IF p_offboarding IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.resignation_communication_runs(p_case,p_offboarding) allowed CROSS JOIN LATERAL jsonb_array_elements(coalesce(allowed.definition->'steps','[]')) allowed_step WHERE allowed.id=p_run AND allowed.preview_available AND allowed_step->>'id'=p_step AND allowed_step->>'type'='sendEmail') THEN RAISE EXCEPTION 'This message is not an acceptance-only communication' USING ERRCODE='42501';END IF;
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
-- Offboarding admission excludes private message templates BEFORE either definition or file metadata leaves SQL.
-- The bridge needs only message recipients/template IDs and pinned acceptance generator references, never other step payloads.
CREATE FUNCTION app.resignation_communication_runs(p_case uuid,p_offboarding uuid DEFAULT NULL)
RETURNS TABLE(id uuid,workflow_id uuid,workflow_revision integer,status text,trigger_event text,definition jsonb,editable boolean,preview_available boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH scope AS MATERIALIZED(SELECT app.resignation_communication_case_scope(p_case,p_offboarding) AS data),
 case_data AS MATERIALIZED(SELECT j.data FROM resignation_journey j WHERE j.tenant_id=app.current_tenant_id() AND j.id=p_case),
 config AS MATERIALIZED(SELECT cfg.data FROM lc_v9_config cfg WHERE cfg.tenant_id=app.current_tenant_id()),
 selected_runs AS MATERIALIZED(
 SELECT r.id,r.workflow_id,r.workflow_revision,r.status,r.trigger_event,r.started_at,v.definition,coalesce((scope.data->>'editable')::boolean,false) AND r.status IN('running','waiting','failed') AS editable,CASE WHEN r.trigger_event IN('retention','offerAccepted','offerDeclined','offerDue','rejected') THEN coalesce((scope.data->>'retention')::boolean,false) WHEN r.trigger_event='submitted' THEN coalesce((scope.data->>'submitted')::boolean,false) ELSE coalesce((scope.data->>'acceptance')::boolean,false) END AS preview_available
 FROM automation_run r JOIN automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision CROSS JOIN scope
 WHERE r.tenant_id=app.current_tenant_id() AND r.subject_id=p_case AND r.module='off' AND CASE WHEN p_offboarding IS NOT NULL THEN r.trigger_event='accepted' AND (coalesce((scope.data->>'acceptance')::boolean,false) OR coalesce((scope.data->>'admitted')::boolean,false) AND (scope.data->>'acceptanceCount')::integer=0) WHEN r.trigger_event IN('retention','offerAccepted','offerDeclined','offerDue','rejected') THEN coalesce((scope.data->>'retention')::boolean,false) WHEN r.trigger_event='submitted' THEN coalesce((scope.data->>'submitted')::boolean,false) ELSE coalesce((scope.data->>'acceptance')::boolean,false) END
 ORDER BY r.started_at DESC,r.id DESC LIMIT 30
 ), steps AS(
 SELECT r.*,step,n,coalesce((SELECT wait->'email'->'template' FROM case_data c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'waits','[]')) wait WHERE wait->>'runId'=r.id::text AND wait->>'kind'='file' AND wait->'step'->>'id'=step->>'id' AND wait->'email'->'template'->>'id'=step->'params'->>'emailTemplateId' LIMIT 1),
 (SELECT e FROM config cfg CROSS JOIN LATERAL jsonb_array_elements(coalesce(cfg.data->'emails','[]')) e WHERE e->>'id'=step->'params'->>'emailTemplateId' AND e->>'module'='off' LIMIT 1)) AS template
 FROM selected_runs r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.definition->'steps','[]')) WITH ORDINALITY definition_steps(step,n)
 WHERE step->>'type' IN('sendEmail','generateDocument')
 ), safe_steps AS(
 SELECT steps.* FROM steps WHERE step->>'type'='generateDocument' OR (step->>'type'='sendEmail' AND (p_offboarding IS NULL OR (
 template IS NOT NULL AND jsonb_build_array(template->'subject',template->'body',template->'bodyDoc',(SELECT c.data->'emailOverrides'->(template->>'id') FROM case_data c))::text !~ 'retention[.]|employee[.]salary'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(template->'attachments','[]')||coalesce(template->'links','[]')) reference WHERE NOT EXISTS(
 SELECT 1 FROM case_data c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'letters','[]')) letter WHERE letter->>'kind'='acceptance' AND letter->>'templateId'=reference
 UNION ALL SELECT 1 FROM jsonb_array_elements(coalesce(steps.definition->'steps','[]')) generator WHERE generator->>'type'='generateDocument' AND generator->'params'->>'letterTemplateId'=reference))
 )))
 )
 SELECT r.id,r.workflow_id,r.workflow_revision,r.status,r.trigger_event,
 jsonb_build_object('name',r.definition->'name','steps',coalesce((SELECT jsonb_agg(CASE WHEN ss.step->>'type'='generateDocument' THEN jsonb_build_object('id',ss.step->'id','type','generateDocument','params',jsonb_build_object('letterTemplateId',ss.step->'params'->'letterTemplateId')) ELSE jsonb_build_object('id',ss.step->'id','type','sendEmail','to',coalesce(ss.step->'to','[]'),'cc',coalesce(ss.step->'cc','[]'),'params',jsonb_build_object('emailTemplateId',ss.step->'params'->'emailTemplateId')) END ORDER BY ss.n) FROM safe_steps ss WHERE ss.id=r.id),'[]'::jsonb)),r.editable,r.preview_available
 FROM selected_runs r ORDER BY r.started_at DESC,r.id DESC;
$$;
REVOKE ALL ON FUNCTION app.resignation_communication_runs(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_communication_runs(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
-- Purpose-bound counterpart of the canonical context projection. No general case/file authority is added.
CREATE FUNCTION app.resignation_communication_offboarding_context(p_employment uuid,p_case uuid,p_offboarding uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();r jsonb;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM app.resignation_runtime_consume('context',p_case,jsonb_build_object('mode','offboardingCommunications','employmentId',p_employment,'caseId',p_case,'offboardingCaseId',p_offboarding));
 IF coalesce((app.resignation_communication_case_scope(p_case,p_offboarding)->>'admitted')::boolean,false) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM resignation_journey j WHERE j.tenant_id=t AND j.id=p_case AND j.employment_id=p_employment AND j.offboarding_case_id=p_offboarding) THEN RAISE EXCEPTION 'The linked case communication context is unavailable' USING ERRCODE='42501';END IF;
 WITH configured AS(SELECT cfg.tenant_id,cfg.data||CASE WHEN shared.tenant_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('groups',coalesce(shared.data->'groups','[]'::jsonb),'groupsRevision',shared.revision) END AS data FROM lc_v9_config cfg LEFT JOIN lc_onboarding_config shared ON shared.tenant_id=cfg.tenant_id WHERE cfg.tenant_id=t)
 SELECT jsonb_build_object('employmentId',e.id,'personId',e.person_id,'companyId',e.company_id,'employeeName',p.full_name,'employeeCode',coalesce(e.employee_code,''),'companyName',co.legal_name,
 'businessGroupId',a.business_unit_id,'businessGroup',coalesce(bu.name,''),'departmentId',a.department_id,'department',coalesce(dep.name,''),'positionId',a.position_id,'jobGradeId',e.grade_id,'position',coalesce(pos.title,''),'jobGrade',coalesce(g.code,''),'employmentType',coalesce(a.employment_type::text,'permanent'),'confirmed',e.final_confirmation_date IS NULL OR e.final_confirmation_date<=day,'finalConfirmationDate',e.final_confirmation_date::text,'noticeBefore',CASE WHEN e.notice_before_confirmation_value IS NOT NULL THEN jsonb_build_object('value',e.notice_before_confirmation_value,'unit',e.notice_before_confirmation_unit) ELSE NULL END,'noticeAfter',CASE WHEN e.notice_after_confirmation_value IS NOT NULL THEN jsonb_build_object('value',e.notice_after_confirmation_value,'unit',e.notice_after_confirmation_unit) ELSE NULL END,
 'basicSalary',(SELECT c.basic_salary::text FROM compensation c WHERE c.tenant_id=t AND c.employment_id=e.id AND c.superseded_at IS NULL AND c.valid_from<=day AND (c.valid_to IS NULL OR c.valid_to>day) ORDER BY c.valid_from DESC,c.id LIMIT 1),
 'currency',(SELECT c.currency::text FROM compensation c WHERE c.tenant_id=t AND c.employment_id=e.id AND c.superseded_at IS NULL AND c.valid_from<=day AND (c.valid_to IS NULL OR c.valid_to>day) ORDER BY c.valid_from DESC,c.id LIMIT 1),
 'employeeUserId',(SELECT (array_agg(u.id))[1] FROM app_user u WHERE u.tenant_id=t AND u.person_id=e.person_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) HAVING count(*)=1),
 'supervisorUserId',(SELECT (array_agg(DISTINCT u.id))[1] FROM reporting_line rl JOIN employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id JOIN app_user u ON u.person_id=me.person_id AND u.tenant_id=me.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE rl.tenant_id=t AND rl.subordinate_employment_id=e.id AND rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=day AND (rl.valid_to IS NULL OR rl.valid_to>day) HAVING count(DISTINCT u.id)=1),
 'config',(SELECT data FROM configured),
 'workflows',coalesce((SELECT jsonb_agg(v.definition||jsonb_build_object('id',v.workflow_id,'status',v.status,'required',v.required)) FROM(SELECT DISTINCT ON(workflow_id) workflow_id,status,required,definition FROM automation_workflow_version WHERE tenant_id=t AND module='off' ORDER BY workflow_id,revision DESC LIMIT 200) v WHERE v.status='live' AND v.definition->'trigger'->>'event'='submitted'),'[]'),
 'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.routing_id,'name',r.name,'rows',r.routing_rows)) FROM (SELECT DISTINCT ON(routing_id) routing_id,name,routing_rows,retired FROM automation_routing_version WHERE tenant_id=t ORDER BY routing_id,revision DESC LIMIT 500) r WHERE NOT retired),'[]'),
 'users',coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id,'personId',u.person_id,'name',coalesce(up.full_name,'Assigned account'))) FROM app_user u LEFT JOIN person up ON up.id=u.person_id AND up.tenant_id=u.tenant_id WHERE u.tenant_id=t AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (
 u.id=app.current_user_id() OR u.person_id=e.person_id OR EXISTS(SELECT 1 FROM reporting_line rl JOIN employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id WHERE rl.tenant_id=t AND rl.subordinate_employment_id=e.id AND me.person_id=u.person_id AND rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=day AND (rl.valid_to IS NULL OR rl.valid_to>day)) OR
 u.id=ANY(coalesce((SELECT j.participant_ids FROM resignation_journey j WHERE j.tenant_id=t AND j.id=p_case),'{}'::uuid[])) OR u.id::text IN(SELECT v #>> '{}' FROM configured cfg CROSS JOIN LATERAL jsonb_path_query(cfg.data,'$.**.members[*]') v WHERE cfg.tenant_id=t UNION SELECT v #>> '{}' FROM configured cfg CROSS JOIN LATERAL jsonb_path_query(cfg.data,'$.**.userId') v WHERE cfg.tenant_id=t UNION SELECT v #>> '{}' FROM automation_routing_version ar CROSS JOIN LATERAL jsonb_path_query(ar.routing_rows,'$.**.userIds[*]') v WHERE ar.tenant_id=t UNION SELECT v #>> '{}' FROM automation_workflow_version aw CROSS JOIN LATERAL jsonb_path_query(aw.definition,'$.**.userId') v WHERE aw.tenant_id=t AND aw.module='off')
 )),'[]')) INTO r
 FROM employment e JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT * FROM assignment WHERE employment_id=e.id AND tenant_id=t AND superseded_at IS NULL AND valid_from<=day AND (valid_to IS NULL OR valid_to>day) ORDER BY valid_from DESC,id LIMIT 1)a ON true
 LEFT JOIN business_unit bu ON bu.id=a.business_unit_id AND bu.tenant_id=t LEFT JOIN department dep ON dep.id=a.department_id AND dep.tenant_id=t LEFT JOIN position pos ON pos.id=a.position_id AND pos.tenant_id=t LEFT JOIN job_grade g ON g.id=e.grade_id AND g.tenant_id=t WHERE e.id=p_employment AND e.tenant_id=t;
 -- Availability is the canonical approved leave-day/range projection; no leave reason or other absence data exits.
 r:=r||jsonb_build_object('unavailableUserIds',coalesce((SELECT jsonb_agg(DISTINCT u->>'id') FROM jsonb_array_elements(r->'users') u JOIN app_user au ON au.tenant_id=t AND au.id::text=u->>'id' JOIN employment e ON e.tenant_id=t AND e.person_id=au.person_id JOIN leave_request lr ON lr.tenant_id=t AND lr.employment_id=e.id WHERE EXISTS(SELECT 1 FROM leave_request_date ld WHERE ld.leave_request_id=lr.id AND ld.leave_date=day AND ld.status='approved') OR lr.status='approved' AND day BETWEEN lr.start_date AND lr.end_date AND NOT EXISTS(SELECT 1 FROM leave_request_date ld WHERE ld.leave_request_id=lr.id)),'[]'::jsonb),
 'assignmentLoads',coalesce((WITH candidates AS(SELECT u->>'id' id FROM jsonb_array_elements(r->'users') u), shared AS(SELECT * FROM app.onboarding_assignment_loads()), tasks AS(SELECT a #>> '{}' id,task FROM resignation_journey j CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.data->'tasks','[]')) task CROSS JOIN LATERAL jsonb_array_elements(coalesce(task->'userIds','[]')) a WHERE j.tenant_id=app.current_tenant_id() AND j.stage NOT IN('retained','withdrawn') AND task->>'status' IN('todo','progress')), task_counts AS(SELECT id,count(*) n FROM tasks GROUP BY id) SELECT jsonb_agg(jsonb_build_object('userId',c.id,'taskLoad',coalesce(s.task_load,0)+coalesce(tc.n,0),'lastAuto',s.last_auto)) FROM candidates c LEFT JOIN shared s ON s.user_id::text=c.id LEFT JOIN task_counts tc ON tc.id=c.id),'[]'::jsonb));
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION app.resignation_communication_offboarding_context(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_communication_offboarding_context(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.resignation_communication_files(p_case uuid,p_offboarding uuid DEFAULT NULL)
RETURNS TABLE(id uuid,slot text,name text,content_hash text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH runs AS MATERIALIZED(SELECT * FROM app.resignation_communication_runs(p_case,p_offboarding) WHERE preview_available),
 case_data AS MATERIALIZED(SELECT j.data FROM resignation_journey j WHERE j.tenant_id=app.current_tenant_id() AND j.id=p_case),
 config AS MATERIALIZED(SELECT cfg.data FROM lc_v9_config cfg WHERE cfg.tenant_id=app.current_tenant_id()),
 steps AS(SELECT r.id AS run_id,step FROM runs r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.definition->'steps','[]')) step WHERE step->>'type'='sendEmail'),
 templates AS(
  SELECT coalesce((SELECT wait->'email'->'template' FROM case_data c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'waits','[]')) wait WHERE wait->>'runId'=steps.run_id::text AND wait->>'kind'='file' AND wait->'step'->>'id'=steps.step->>'id' AND wait->'email'->'template'->>'id'=steps.step->'params'->>'emailTemplateId' LIMIT 1),
   (SELECT e FROM config cfg CROSS JOIN LATERAL jsonb_array_elements(coalesce(cfg.data->'emails','[]')) e WHERE e->>'id'=steps.step->'params'->>'emailTemplateId' AND e->>'module'='off' LIMIT 1)) AS template FROM steps
 ), allowed_slots AS(SELECT DISTINCT (t.template->>'id')||':'||(slot->>'id') AS slot FROM templates t CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.template->'slots','[]')) slot)
 SELECT DISTINCT ON(f.slot) f.id,f.slot,f.name,f.content_hash FROM resignation_journey_file f JOIN allowed_slots allowed ON allowed.slot=f.slot
 WHERE f.tenant_id=app.current_tenant_id() AND f.case_id=p_case AND f.document_id IS NULL
 ORDER BY f.slot,f.created_at DESC,f.id DESC LIMIT 200;
$$;
REVOKE ALL ON FUNCTION app.resignation_communication_files(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_communication_files(uuid,uuid) TO ai_hr_app;
