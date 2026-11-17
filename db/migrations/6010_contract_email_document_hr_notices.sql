-- Explicit human approval: fixed OneHR links for actual pending nonemployee email-document actors only.
-- No authored trigger, new job kind, application EXECUTE, Form answer, employee invitation or business effect.
ALTER TABLE public.contract_shared_event DROP CONSTRAINT contract_shared_event_trigger_event_check;
ALTER TABLE public.contract_shared_event ADD CONSTRAINT contract_shared_event_trigger_event_check CHECK(trigger_event IN('caseOpened','beforeContractEnd','afterContractEnd','decisionSubmitted','approvalsComplete','approvalRejected','employeeDeclined','letterActionNeeded','letterSentBack','letterReleased','manual','approvalActionNeeded','emailDocumentReady','emailDocumentHRNotice'));
ALTER TABLE public.contract_shared_event DROP CONSTRAINT contract_shared_event_system_actor;
ALTER TABLE public.contract_shared_event ADD CONSTRAINT contract_shared_event_system_actor CHECK(actor_type<>'system' OR (actor_user_id IS NULL AND actor_person_id IS NULL AND trigger_event IN('caseOpened','beforeContractEnd','afterContractEnd','emailDocumentHRNotice')));
--> statement-breakpoint
CREATE TABLE app.contract_email_hr_notice(
 tenant_id uuid NOT NULL,event_id uuid NOT NULL,case_id uuid NOT NULL,pin_id uuid NOT NULL,letter_id uuid NOT NULL,signing_revision integer NOT NULL,
 parent_event_id uuid,actor_user_id uuid REFERENCES public.app_user(id),actor_person_id uuid REFERENCES public.person(id),action_id text,
 source jsonb NOT NULL,source_hash bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,event_id),UNIQUE(tenant_id,letter_id,signing_revision),
 FOREIGN KEY(tenant_id,event_id) REFERENCES public.contract_shared_event(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,parent_event_id) REFERENCES public.contract_shared_event(tenant_id,id),
 FOREIGN KEY(tenant_id,pin_id) REFERENCES public.contract_shared_email_document_step(tenant_id,id),
 FOREIGN KEY(tenant_id,letter_id) REFERENCES public.contract_shared_letter(tenant_id,id),
 CHECK((actor_user_id IS NULL)=(actor_person_id IS NULL)),CHECK(parent_event_id IS NOT NULL OR action_id IS NOT NULL)
);
ALTER TABLE app.contract_email_hr_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_email_hr_notice FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_email_hr_notice_owner ON app.contract_email_hr_notice FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.contract_email_hr_notice FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON app.contract_email_hr_notice TO ai_hr_owner;
CREATE TRIGGER contract_email_hr_notice_immutable BEFORE UPDATE OR DELETE ON app.contract_email_hr_notice FOR EACH ROW EXECUTE FUNCTION app.contract_case_revision_immutable();
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_hr_notice_source(p_tenant uuid,p_letter uuid,p_revision integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH subject AS MATERIALIZED(
  SELECT l.*,d.data AS signing,d.revision AS signing_revision,c.company_id,c.employment_id,e.person_id AS actual_person,pin.id AS pin_id
  FROM public.contract_shared_letter l
  JOIN public.document_signing_document d ON d.tenant_id=l.tenant_id AND d.id=l.signing_document_id AND d.subject_type='contract' AND d.subject_id=l.id
  JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id
  JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id AND e.person_id::text=l.data->>'subjectPersonId' AND e.voided_at IS NULL
  JOIN public.company company ON company.tenant_id=e.tenant_id AND company.id=e.company_id AND company.archived_at IS NULL
  JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=l.tenant_id AND pin.case_id=l.case_id AND pin.company_id=c.company_id AND pin.subject_person_id=e.person_id
   AND pin.workflow_run_id=l.workflow_run_id AND pin.workflow_step_id=l.workflow_step_id AND pin.decision_revision=l.decision_revision
   AND pin.documents->>(l.data->>'templateId')=l.id::text
  WHERE l.tenant_id=p_tenant AND l.id=p_letter AND l.purpose='email' AND l.data->>'state'='routing' AND d.revision=p_revision AND d.company_id=c.company_id AND d.employment_id=c.employment_id
   AND app.contract_company_entitled(p_tenant,c.company_id) AND app.contract_shared_email_document_current(p_tenant,l.id)
   AND l.data->'signingPolicy'->'route'=d.data->'route'
   AND jsonb_array_length(d.data->'route'->'steps') BETWEEN 1 AND 30
 ),steps AS(
  SELECT subject.id,step FROM subject CROSS JOIN LATERAL app.document_signing_pending_steps(subject.signing) step
  WHERE NOT app.document_signing_returned(subject.signing)
  UNION ALL SELECT subject.id,app.document_signing_owner_step(subject.signing) FROM subject WHERE app.document_signing_returned(subject.signing)
 ),recipients AS(
  SELECT steps.id,jsonb_build_object('userId',account.id,'personId',account.person_id,'stepId',step->>'id') AS recipient
  FROM steps JOIN subject ON subject.id=steps.id
  JOIN public.app_user account ON account.tenant_id=p_tenant AND account.id::text=step->>'holderId' AND account.person_id::text=step->>'holderPersonId'
  JOIN public.person person ON person.tenant_id=account.tenant_id AND person.id=account.person_id
  WHERE step->>'kind' IN('review','approve','sign') AND account.person_id<>subject.actual_person
   AND account.archived_at IS NULL AND NOT app.login_blocked(account.id) AND length(btrim(person.full_name))>0
 )
 SELECT jsonb_build_object('letterId',subject.id,'pinId',pin_id,'caseId',case_id,'companyId',company_id,'employmentId',employment_id,'subjectPersonId',actual_person,
  'signingRevision',signing_revision,'routeHash',encode(sha256(convert_to((signing->'route')::text,'UTF8')),'hex'),
  'returned',app.document_signing_returned(signing),'recipients',coalesce((SELECT jsonb_agg(recipient ORDER BY recipient->>'userId',recipient->>'stepId') FROM recipients WHERE recipients.id=subject.id),'[]'::jsonb))
 FROM subject
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_hr_notice_source(uuid,uuid,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_hr_notice_emit(p_letter uuid,p_action text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE letter public.contract_shared_letter;document public.document_signing_document;pin public.contract_shared_email_document_step;parent public.contract_shared_event;
 source jsonb;event_id uuid;actor_id uuid;person_id uuid;queued jsonb;action jsonb;root_id uuid;job_id uuid;decision_revision integer;
BEGIN
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF letter.purpose IS DISTINCT FROM 'email' THEN RETURN NULL;END IF;
 SELECT * INTO document FROM public.document_signing_document WHERE tenant_id=letter.tenant_id AND id=letter.signing_document_id;
 source:=app.contract_shared_email_hr_notice_source(letter.tenant_id,letter.id,document.revision);
 IF source IS NULL OR jsonb_array_length(source->'recipients')=0 THEN RETURN NULL;END IF;
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=letter.tenant_id AND id=(source->>'pinId')::uuid;
 IF p_action IS NULL THEN
  SELECT * INTO parent FROM public.contract_shared_event WHERE tenant_id=letter.tenant_id AND id=CASE WHEN current_setting('app.contract_event',true)~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.contract_event',true)::uuid ELSE NULL::uuid END;
  IF parent.id IS NULL OR parent.case_id<>letter.case_id OR parent.processed_at IS NOT NULL
   OR app.contract_shared_effect_held(letter.case_id,pin.workflow_run_id,pin.workflow_step_id,'sendEmail') IS NOT TRUE
   OR app.bulk_job_capability_held(parent.job_id) IS NOT TRUE OR app.bulk_job_seal_verify(parent.job_id,'full') IS NOT NULL
   THEN RAISE EXCEPTION 'Initial notice requires its actual sealed Send email effect' USING ERRCODE='42501';END IF;
  actor_id:=parent.actor_user_id;person_id:=parent.actor_person_id;root_id:=coalesce(parent.root_event_id,parent.id);job_id:=parent.job_id;
 ELSE
  action:=document.data->'actions'->-1;
  IF action->>'id' IS DISTINCT FROM p_action OR action->>'actorId' IS DISTINCT FROM app.current_user_id()::text
   OR action->>'actorPersonId' IS DISTINCT FROM app.contract_actor_person(app.current_user_id())::text
   OR app.contract_verified_human(app.current_user_id()) IS NOT TRUE
   THEN RAISE EXCEPTION 'Actual canonical signing actor required' USING ERRCODE='42501';END IF;
  actor_id:=app.current_user_id();person_id:=app.contract_actor_person(actor_id);
 END IF;
 SELECT notice.event_id INTO event_id FROM app.contract_email_hr_notice notice WHERE notice.tenant_id=letter.tenant_id AND notice.letter_id=letter.id AND notice.signing_revision=document.revision;
 IF event_id IS NOT NULL THEN RETURN event_id;END IF;
 event_id:=gen_random_uuid();decision_revision:=pin.decision_revision;
 INSERT INTO app.contract_email_hr_notice(tenant_id,event_id,case_id,pin_id,letter_id,signing_revision,parent_event_id,actor_user_id,actor_person_id,action_id,source,source_hash)
 VALUES(letter.tenant_id,event_id,letter.case_id,pin.id,letter.id,document.revision,parent.id,actor_id,person_id,p_action,source,app.bulk_job_value_digest(source));
 INSERT INTO public.contract_shared_event(tenant_id,id,case_id,trigger_event,occurrence,decision_revision,actor_type,actor_user_id,actor_person_id,workflow_versions,data,job_id,root_event_id)
 VALUES(letter.tenant_id,event_id,letter.case_id,'emailDocumentHRNotice','email-hr:'||letter.id::text||':'||document.revision::text,decision_revision,
 CASE WHEN actor_id IS NULL THEN 'system' ELSE 'user' END,actor_id,person_id,'[]'::jsonb,jsonb_build_object('noticeId',event_id),job_id,root_id);
 IF job_id IS NULL THEN
  queued:=app.bulk_job_enqueue('contract_automation',event_id,ARRAY[(source->>'companyId')::uuid],'',NULL,jsonb_build_object('eventId',event_id));
  IF queued->>'id' IS NULL THEN RAISE EXCEPTION 'The fixed HR notice could not be queued' USING ERRCODE='40001';END IF;
  UPDATE public.contract_shared_event SET job_id=(queued->>'id')::uuid WHERE tenant_id=letter.tenant_id AND id=event_id;
 END IF;
 RETURN event_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_hr_notice_emit(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_hr_notice_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE letter_id uuid;action jsonb;
BEGIN
 IF NEW.subject_type<>'contract' OR jsonb_array_length(NEW.data->'actions')<>jsonb_array_length(OLD.data->'actions')+1
  OR NEW.data->'actions'-((jsonb_array_length(NEW.data->'actions')-1)::integer) IS DISTINCT FROM OLD.data->'actions' THEN RETURN NEW;END IF;
 SELECT id INTO letter_id FROM public.contract_shared_letter WHERE tenant_id=NEW.tenant_id AND id=NEW.subject_id AND signing_document_id=NEW.id AND purpose='email';
 IF letter_id IS NULL THEN RETURN NEW;END IF;
 action:=NEW.data->'actions'->-1;
 IF action->>'actorId' IS DISTINCT FROM app.current_user_id()::text OR action->>'actorPersonId' IS DISTINCT FROM app.contract_actor_person(app.current_user_id())::text
  OR app.contract_verified_human(app.current_user_id()) IS NOT TRUE THEN RAISE EXCEPTION 'Actual canonical HR progression required' USING ERRCODE='42501';END IF;
 PERFORM app.contract_shared_email_hr_notice_emit(letter_id,action->>'id');RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_hr_notice_progress() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER zz_contract_email_hr_notice_progress AFTER UPDATE OF data ON public.document_signing_document FOR EACH ROW EXECUTE FUNCTION app.contract_shared_email_hr_notice_progress();
--> statement-breakpoint
-- Same-OID adapters preserve old cached callers; copied ordinary bodies remain private and unchanged.
DO $$ BEGIN
 EXECUTE replace(pg_get_functiondef('app.contract_shared_worker_event_held(uuid,integer)'::regprocedure),'app.contract_shared_worker_event_held(', 'app.contract_shared_worker_event_held_before_hr_notice(');
 EXECUTE replace(pg_get_functiondef('app.contract_shared_effect_held(uuid,uuid,text,text)'::regprocedure),'app.contract_shared_effect_held(', 'app.contract_shared_effect_held_before_hr_notice(');
 EXECUTE replace(pg_get_functiondef('app.contract_shared_event_check(uuid,uuid)'::regprocedure),'app.contract_shared_event_check(', 'app.contract_shared_event_check_before_hr_notice(');
 EXECUTE replace(pg_get_functiondef('app.contract_shared_mail_context(uuid,text)'::regprocedure),'app.contract_shared_mail_context(', 'app.contract_shared_mail_context_before_hr_notice(');
 EXECUTE replace(pg_get_functiondef('app.automation_email_queue_rich(text,uuid,text,uuid[],uuid[],text,text,jsonb)'::regprocedure),'app.automation_email_queue_rich(', 'app.automation_email_queue_rich_before_hr_notice(');
 EXECUTE replace(pg_get_functiondef('app.contract_shared_delivery_eligible(uuid,uuid,jsonb)'::regprocedure),'app.contract_shared_delivery_eligible(', 'app.contract_shared_delivery_eligible_before_hr_notice(');
 EXECUTE replace(pg_get_functiondef('app.contract_shared_delivery_eligible(uuid,uuid,uuid,jsonb)'::regprocedure),'app.contract_shared_delivery_eligible(', 'app.contract_shared_delivery_eligible_before_hr_notice(');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_worker_event_held_before_hr_notice(uuid,integer),app.contract_shared_effect_held_before_hr_notice(uuid,uuid,text,text),
 app.contract_shared_event_check_before_hr_notice(uuid,uuid),app.contract_shared_mail_context_before_hr_notice(uuid,text),
 app.automation_email_queue_rich_before_hr_notice(text,uuid,text,uuid[],uuid[],text,text,jsonb),
 app.contract_shared_delivery_eligible_before_hr_notice(uuid,uuid,jsonb),app.contract_shared_delivery_eligible_before_hr_notice(uuid,uuid,uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_hr_notice_identity(p_tenant uuid,p_event uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.contract_email_hr_notice receipt
 JOIN public.contract_shared_event event ON event.tenant_id=receipt.tenant_id AND event.id=receipt.event_id AND event.case_id=receipt.case_id
 JOIN public.bulk_job job ON job.tenant_id=event.tenant_id AND job.id=event.job_id
 JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=receipt.tenant_id AND pin.id=receipt.pin_id AND pin.case_id=receipt.case_id
 LEFT JOIN public.contract_shared_event parent ON parent.tenant_id=receipt.tenant_id AND parent.id=receipt.parent_event_id
 WHERE receipt.tenant_id=p_tenant AND receipt.event_id=p_event AND event.trigger_event='emailDocumentHRNotice' AND event.workflow_versions='[]'::jsonb
 AND event.data=jsonb_build_object('noticeId',event.id) AND event.occurrence='email-hr:'||receipt.letter_id::text||':'||receipt.signing_revision::text
 AND event.decision_revision=pin.decision_revision AND app.bulk_job_value_digest(receipt.source)=receipt.source_hash
 AND receipt.source->>'caseId'=event.case_id::text AND receipt.source->>'letterId'=receipt.letter_id::text AND receipt.source->>'pinId'=pin.id::text
 AND receipt.source->>'companyId'=pin.company_id::text AND receipt.source->>'subjectPersonId'=pin.subject_person_id::text
 AND event.actor_user_id IS NOT DISTINCT FROM receipt.actor_user_id AND event.actor_person_id IS NOT DISTINCT FROM receipt.actor_person_id
 AND job.cancel_requested_at IS NULL AND job.state<>'cancelled' AND job.operation_key=coalesce(event.root_event_id,event.id)
 AND ((receipt.actor_user_id IS NOT NULL AND event.actor_type='user' AND job.kind='contract_automation' AND job.created_by=receipt.actor_user_id
  AND EXISTS(SELECT 1 FROM public.app_user account JOIN public.person person ON person.tenant_id=account.tenant_id AND person.id=account.person_id
   WHERE account.tenant_id=p_tenant AND account.id=receipt.actor_user_id AND account.person_id=receipt.actor_person_id
   AND account.archived_at IS NULL AND NOT app.login_blocked(account.id) AND length(btrim(person.full_name))>0))
 OR (receipt.actor_user_id IS NULL AND receipt.actor_person_id IS NULL AND event.actor_type='system' AND job.kind='contract_scheduled_automation' AND job.created_by IS NULL
  AND job.context=jsonb_build_object('tenantId',p_tenant,'roles','[]'::jsonb) AND parent.actor_type='system'
  AND EXISTS(SELECT 1 FROM app.contract_system_job_source source WHERE source.tenant_id=p_tenant AND source.job_id=job.id AND source.kind=job.kind
   AND source.event_id=coalesce(parent.root_event_id,parent.id) AND source.case_id=pin.case_id AND source.employment_id::text=receipt.source->>'employmentId'
   AND source.period_revision=pin.source_period_revision)))
 AND ((receipt.parent_event_id IS NOT NULL AND parent.job_id=job.id AND parent.case_id=event.case_id
  AND coalesce(parent.root_event_id,parent.id)=job.operation_key AND event.root_event_id=job.operation_key
  AND parent.actor_type=event.actor_type AND parent.actor_user_id IS NOT DISTINCT FROM receipt.actor_user_id AND parent.actor_person_id IS NOT DISTINCT FROM receipt.actor_person_id)
 OR (receipt.parent_event_id IS NULL AND receipt.action_id IS NOT NULL AND event.root_event_id IS NULL AND job.created_by=receipt.actor_user_id)))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_hr_notice_identity(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_shared_email_hr_notice_held(p_event uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_storage_runner() AND app.contract_shared_email_hr_notice_identity(app.current_tenant_id(),p_event)
 AND EXISTS(SELECT 1 FROM public.contract_shared_event event JOIN public.bulk_job job ON job.tenant_id=event.tenant_id AND job.id=event.job_id
  WHERE event.tenant_id=app.current_tenant_id() AND event.id=p_event AND event.id=CASE WHEN current_setting('app.contract_event',true)~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.contract_event',true)::uuid ELSE NULL::uuid END
  AND job.id::text=current_setting('app.bulk_job',true) AND event.processed_at IS NULL AND job.state='finalizing'
  AND job.input=jsonb_build_object('eventId',job.operation_key) AND job.lease_expires_at>clock_timestamp()
  AND app.bulk_job_capability_held(job.id) AND app.bulk_job_seal_verify(job.id,'full') IS NULL)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_hr_notice_held(uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_worker_event_held(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=CASE WHEN current_setting('app.contract_event',true)~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.contract_event',true)::uuid ELSE NULL::uuid END;
 IF event.trigger_event='emailDocumentHRNotice' THEN RETURN event.case_id=p_case AND event.decision_revision=p_revision AND app.contract_shared_email_hr_notice_held(event.id);END IF;
 RETURN app.contract_shared_worker_event_held_before_hr_notice(p_case,p_revision);
END $$;
CREATE OR REPLACE FUNCTION app.contract_shared_effect_held(p_case uuid,p_run uuid,p_step text,p_type text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.contract_shared_event event WHERE event.tenant_id=app.current_tenant_id() AND event.id=CASE WHEN current_setting('app.contract_event',true)~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.contract_event',true)::uuid ELSE NULL::uuid END AND event.trigger_event='emailDocumentHRNotice') THEN RETURN false;END IF;
 RETURN app.contract_shared_effect_held_before_hr_notice(p_case,p_run,p_step,p_type);
END $$;
CREATE OR REPLACE FUNCTION app.contract_shared_event_check(p_event uuid,p_job uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 IF event.trigger_event='emailDocumentHRNotice' THEN RETURN event.job_id=p_job AND event.processed_at IS NULL AND event.actor_user_id=app.current_user_id()
  AND event.actor_person_id=app.contract_actor_person(app.current_user_id()) AND app.contract_verified_human(app.current_user_id())
  AND app.contract_shared_email_hr_notice_identity(event.tenant_id,event.id);END IF;
 RETURN app.contract_shared_event_check_before_hr_notice(p_event,p_job);
END $$;
-- Existing event_check app ACL is preserved; no new EXECUTE grant.
REVOKE ALL ON FUNCTION app.contract_shared_worker_event_held(uuid,integer),app.contract_shared_effect_held(uuid,uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_hr_notice_context(p_tenant uuid,p_event uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('hrNoticeEventId',receipt.event_id,'hrNoticeHash',encode(receipt.source_hash,'hex'),'eventId',receipt.event_id,
 'letterId',receipt.letter_id,'pinId',receipt.pin_id,'employmentId',receipt.source->'employmentId','subjectPersonId',receipt.source->'subjectPersonId',
 'companyId',receipt.source->'companyId','documentRevision',receipt.signing_revision,'decisionRevision',event.decision_revision)
 FROM app.contract_email_hr_notice receipt JOIN public.contract_shared_event event ON event.tenant_id=receipt.tenant_id AND event.id=receipt.event_id
 WHERE receipt.tenant_id=p_tenant AND receipt.event_id=p_event AND app.contract_shared_email_hr_notice_identity(p_tenant,p_event)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_hr_notice_context(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_shared_email_hr_notice_page(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt app.contract_email_hr_notice;source jsonb;
BEGIN
 SELECT * INTO receipt FROM app.contract_email_hr_notice WHERE tenant_id=app.current_tenant_id() AND case_id=p_case AND event_id=CASE WHEN current_setting('app.contract_event',true)~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.contract_event',true)::uuid ELSE NULL::uuid END;
 IF receipt.event_id IS NULL OR app.contract_shared_email_hr_notice_held(receipt.event_id) IS NOT TRUE THEN RAISE EXCEPTION 'Actual sealed HR notice required' USING ERRCODE='42501';END IF;
 source:=app.contract_shared_email_hr_notice_source(receipt.tenant_id,receipt.letter_id,receipt.signing_revision);
 IF source IS DISTINCT FROM receipt.source THEN RETURN jsonb_build_object('letterId',receipt.letter_id,'signingRevision',receipt.signing_revision,'recipients','[]'::jsonb);END IF;
 RETURN jsonb_build_object('letterId',receipt.letter_id,'signingRevision',receipt.signing_revision,'recipients',
  (SELECT coalesce(jsonb_agg(recipient ORDER BY recipient->>'userId'),'[]'::jsonb) FROM(SELECT DISTINCT ON(recipient->>'userId') recipient FROM jsonb_array_elements(source->'recipients') recipient ORDER BY recipient->>'userId',recipient->>'stepId') recipients));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_hr_notice_page(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_mail_context(p_case uuid,p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt app.contract_email_hr_notice;recipient jsonb;source jsonb;event public.contract_shared_event;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=CASE WHEN current_setting('app.contract_event',true)~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.contract_event',true)::uuid ELSE NULL::uuid END;
 IF event.trigger_event IS DISTINCT FROM 'emailDocumentHRNotice' THEN RETURN app.contract_shared_mail_context_before_hr_notice(p_case,p_key);END IF;
 SELECT * INTO receipt FROM app.contract_email_hr_notice WHERE tenant_id=app.current_tenant_id() AND case_id=p_case AND event_id=CASE WHEN current_setting('app.contract_event',true)~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.contract_event',true)::uuid ELSE NULL::uuid END;
 IF receipt.event_id IS NULL THEN RAISE EXCEPTION 'Actual fixed HR notice receipt required' USING ERRCODE='42501';END IF;
 IF app.contract_shared_email_hr_notice_held(receipt.event_id) IS NOT TRUE THEN RAISE EXCEPTION 'Actual sealed HR notice required' USING ERRCODE='42501';END IF;
 source:=app.contract_shared_email_hr_notice_source(receipt.tenant_id,receipt.letter_id,receipt.signing_revision);
 IF source IS DISTINCT FROM receipt.source THEN RAISE EXCEPTION 'HR route changed' USING ERRCODE='40001';END IF;
 SELECT value INTO recipient FROM jsonb_array_elements(source->'recipients') WHERE p_key='email-hr:'||receipt.letter_id::text||':'||receipt.signing_revision::text||':'||(value->>'userId')||':'||(value->>'personId') LIMIT 1;
 IF recipient IS NULL THEN RAISE EXCEPTION 'Actual pending HR recipient required' USING ERRCODE='42501';END IF;
 RETURN app.contract_shared_email_hr_notice_context(receipt.tenant_id,receipt.event_id);
END $$;
CREATE OR REPLACE FUNCTION app.automation_email_queue_rich(p_module text,p_subject uuid,p_key text,p_to uuid[],p_cc uuid[],p_subject_line text,p_body text,p_rich_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;recipient jsonb;receipt app.contract_email_hr_notice;
BEGIN
 IF EXISTS(SELECT 1 FROM public.contract_shared_event event WHERE event.tenant_id=app.current_tenant_id() AND event.id=CASE WHEN current_setting('app.contract_event',true)~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.contract_event',true)::uuid ELSE NULL::uuid END AND event.trigger_event='emailDocumentHRNotice') THEN
  IF p_module IS DISTINCT FROM 'contract_staff' THEN RAISE EXCEPTION 'A fixed Contract HR notice cannot queue another module' USING ERRCODE='42501';END IF;
  context:=app.contract_shared_mail_context(p_subject,p_key);
  SELECT * INTO receipt FROM app.contract_email_hr_notice WHERE tenant_id=app.current_tenant_id() AND event_id=(context->>'hrNoticeEventId')::uuid;
  SELECT value INTO recipient FROM jsonb_array_elements(receipt.source->'recipients') WHERE p_key='email-hr:'||receipt.letter_id::text||':'||receipt.signing_revision::text||':'||(value->>'userId')||':'||(value->>'personId') LIMIT 1;
  IF p_to IS DISTINCT FROM ARRAY[(recipient->>'userId')::uuid] OR coalesce(cardinality(p_cc),0)<>0 OR p_rich_body IS NOT NULL
   OR p_subject_line IS DISTINCT FROM 'Contract document needs your action' OR p_body IS DISTINCT FROM E'A Contract document is waiting for your action.\n\n{{case.link}}'
   THEN RAISE EXCEPTION 'HR notices contain only the fixed OneHR action link' USING ERRCODE='42501';END IF;
 END IF;
 RETURN app.automation_email_queue_rich_before_hr_notice(p_module,p_subject,p_key,p_to,p_cc,p_subject_line,p_body,p_rich_body);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_mail_context(uuid,text) FROM PUBLIC,ai_hr_app;
-- Original queue application ACL remains unchanged.
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_hr_notice_eligible(p_tenant uuid,p_case uuid,p_context jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt app.contract_email_hr_notice;source jsonb;context jsonb;
BEGIN
 SELECT * INTO receipt FROM app.contract_email_hr_notice WHERE tenant_id=p_tenant AND case_id=p_case AND event_id=CASE WHEN p_context->>'hrNoticeEventId'~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (p_context->>'hrNoticeEventId')::uuid ELSE NULL::uuid END;
 IF receipt.event_id IS NULL OR app.contract_shared_email_hr_notice_identity(p_tenant,receipt.event_id) IS NOT TRUE THEN RETURN false;END IF;
 context:=app.contract_shared_email_hr_notice_context(p_tenant,receipt.event_id);
 IF p_context-'recipientPeople' IS DISTINCT FROM context OR jsonb_typeof(p_context->'recipientPeople') IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_each_text(p_context->'recipientPeople'))<>1 THEN RETURN false;END IF;
 source:=app.contract_shared_email_hr_notice_source(p_tenant,receipt.letter_id,receipt.signing_revision);
 RETURN source=receipt.source AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(p_context->'recipientPeople') person
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source->'recipients') recipient WHERE recipient->>'userId'=person.key AND recipient->>'personId'=person.value));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_hr_notice_eligible(uuid,uuid,jsonb) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_delivery_eligible(p_tenant uuid,p_case uuid,p_context jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_context?'hrNoticeEventId' THEN RETURN app.contract_shared_email_hr_notice_eligible(p_tenant,p_case,p_context);END IF;
 RETURN app.contract_shared_delivery_eligible_before_hr_notice(p_tenant,p_case,p_context);
END $$;
CREATE OR REPLACE FUNCTION app.contract_shared_delivery_eligible(p_delivery uuid,p_tenant uuid,p_case uuid,p_context jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE delivery public.automation_email_delivery;receipt app.contract_email_hr_notice;recipient record;
BEGIN
 IF p_context?'hrNoticeEventId' THEN
  IF app.contract_shared_email_hr_notice_eligible(p_tenant,p_case,p_context) IS NOT TRUE THEN RETURN false;END IF;
  SELECT * INTO delivery FROM public.automation_email_delivery WHERE tenant_id=p_tenant AND id=p_delivery AND module='contract_staff' AND subject_id=p_case;
  SELECT * INTO receipt FROM app.contract_email_hr_notice WHERE tenant_id=p_tenant AND event_id=CASE WHEN p_context->>'hrNoticeEventId'~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (p_context->>'hrNoticeEventId')::uuid ELSE NULL::uuid END;
  SELECT * INTO recipient FROM jsonb_each_text(p_context->'recipientPeople');
  RETURN delivery.id IS NOT NULL AND delivery.payload->'context'=p_context
   AND delivery.mail_key='email-hr:'||receipt.letter_id::text||':'||receipt.signing_revision::text||':'||recipient.key||':'||recipient.value||':0'
   AND delivery.payload->'mail'->'to'=jsonb_build_array(recipient.key) AND delivery.payload->'mail'->'cc'='[]'::jsonb
   AND delivery.payload->'mail'->>'subject'='Contract document needs your action'
   AND delivery.payload->'mail'->>'body'=E'A Contract document is waiting for your action.\n\n{{case.link}}'
   AND (delivery.payload->'mail'->'richBody' IS NULL OR delivery.payload->'mail'->'richBody'='null'::jsonb)
   AND delivery.payload->'mail'->'delivery'=jsonb_build_object('version',1,'sender','noreply','pdfDocumentIds','[]'::jsonb,'linkDocumentIds','[]'::jsonb,'assets','[]'::jsonb);
 END IF;
 RETURN app.contract_shared_delivery_eligible_before_hr_notice(p_delivery,p_tenant,p_case,p_context);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_delivery_eligible(uuid,uuid,jsonb),app.contract_shared_delivery_eligible(uuid,uuid,uuid,jsonb) FROM PUBLIC,ai_hr_app;
