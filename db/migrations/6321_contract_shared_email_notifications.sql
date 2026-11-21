-- Contract uses the existing OneHR workflow-mail delivery owner and private SMTP capability.
ALTER TABLE public.automation_email_delivery DROP CONSTRAINT automation_email_delivery_module_check;
ALTER TABLE public.automation_email_delivery ADD CONSTRAINT automation_email_delivery_module_check CHECK(module IN('probation','contract_staff'));
ALTER TABLE public.contract_shared_event DROP CONSTRAINT contract_shared_event_trigger_event_check;
ALTER TABLE public.contract_shared_event ADD CONSTRAINT contract_shared_event_trigger_event_check CHECK(trigger_event IN('caseOpened','beforeContractEnd','afterContractEnd','decisionSubmitted','approvalsComplete','approvalRejected','employeeDeclined','letterActionNeeded','letterSentBack','letterReleased','manual','approvalActionNeeded'));
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_event_data(p_case uuid,p_trigger text,p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f jsonb;c public.contract_case;facts jsonb;result jsonb;document_revision integer;
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 SELECT data INTO f FROM public.contract_shared_case WHERE tenant_id=c.tenant_id AND case_id=c.id;
 facts:=jsonb_build_object('decision',CASE f->'decision'->>'kind' WHEN 'renew' THEN 'Renew' WHEN 'convert' THEN 'Convert to permanent' WHEN 'end' THEN 'End' END,
 'endReason',f->'decision'->>'endReason','declineReason',f->'declined'->>'reason','payChanges',CASE WHEN f->'decision'='null'::jsonb THEN NULL WHEN f->'decision'->'payChanges'='true'::jsonb THEN 'Yes' ELSE 'No' END,
 'termMonths',f->'decision'->>'months','daysToEnd',((f->'period'->>'endOn')::date-(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)::text,
 'businessGroup',(SELECT coalesce(company.parent_company_id,company.id)::text FROM public.company company WHERE company.tenant_id=c.tenant_id AND company.id=c.company_id));
 result:=coalesce(p_data,'{}'::jsonb)||jsonb_build_object('conditionFacts',facts,'eventDate',to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY-MM-DD'),'sourcePersonId',(SELECT person_id FROM public.employment WHERE tenant_id=c.tenant_id AND id=c.employment_id));
 IF p_trigger IN('letterActionNeeded','letterSentBack','letterReleased') THEN
  SELECT signing.revision INTO document_revision FROM public.contract_shared_letter letter JOIN public.document_signing_document signing ON signing.tenant_id=letter.tenant_id AND signing.id=letter.signing_document_id
  WHERE letter.tenant_id=c.tenant_id AND letter.case_id=c.id AND letter.id::text=result->>'letterId';
  IF document_revision IS NULL THEN RAISE EXCEPTION 'A canonical case letter is required for this event' USING ERRCODE='22023';END IF;
  result:=result||jsonb_build_object('documentRevision',document_revision);
 END IF;
 IF p_trigger='approvalActionNeeded' THEN
  SELECT signing.revision INTO document_revision FROM public.contract_shared_approval approval JOIN public.document_signing_document signing ON signing.tenant_id=approval.tenant_id AND signing.id=approval.signing_document_id
  WHERE approval.tenant_id=c.tenant_id AND approval.case_id=c.id AND approval.id::text=result->>'approvalId';
  IF document_revision IS NULL THEN RAISE EXCEPTION 'A canonical case approval is required for this event' USING ERRCODE='22023';END IF;
  result:=result||jsonb_build_object('documentRevision',document_revision);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_event_data(uuid,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_mail_context(p_case uuid,p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin public.contract_shared_event;run_id uuid;step_id text;step_type text;context jsonb;
BEGIN
 SELECT * INTO origin FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND case_id=p_case AND id::text=current_setting('app.contract_event',true);
 IF origin.id IS NULL OR app.contract_shared_worker_event_held(p_case,origin.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Protected Contract email intent required' USING ERRCODE='42501';END IF;
 IF origin.trigger_event='approvalActionNeeded' AND p_key LIKE 'approval:'||(origin.data->>'approvalId')||':'||(origin.data->>'documentRevision')||':%' THEN
  IF NOT EXISTS(SELECT 1 FROM public.contract_shared_approval approval JOIN public.document_signing_document signing ON signing.tenant_id=approval.tenant_id AND signing.id=approval.signing_document_id
  WHERE approval.tenant_id=origin.tenant_id AND approval.case_id=p_case AND approval.id::text=origin.data->>'approvalId' AND signing.revision::text=origin.data->>'documentRevision'
  AND NOT app.document_signing_returned(signing.data) AND EXISTS(SELECT 1 FROM app.document_signing_pending_steps(signing.data))) THEN RAISE EXCEPTION 'This approval notification is no longer pending' USING ERRCODE='40001';END IF;
 ELSE
 SELECT run.id,step->>'id',step->>'type' INTO run_id,step_id,step_type FROM public.automation_run run
 JOIN public.automation_workflow_version version ON version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision
 CROSS JOIN LATERAL jsonb_array_elements(version.definition->'steps') step WHERE run.tenant_id=origin.tenant_id AND run.subject_id=p_case AND run.module='contract_staff'
 AND p_key=run.id::text||':'||(step->>'id') AND step->>'type' IN('notify','sendEmail');
 IF run_id IS NULL OR app.contract_shared_effect_held(p_case,run_id,step_id,step_type) IS NOT TRUE THEN RAISE EXCEPTION 'This accepted step cannot queue an email' USING ERRCODE='42501';END IF;
 END IF;
 SELECT jsonb_build_object('eventId',origin.id,'decisionRevision',origin.decision_revision,'periodRevision',f.data->'period'->>'sourceRevision','subjectPersonId',coalesce(origin.data->>'sourcePersonId',employment.person_id::text),'employmentId',employment.id,
 'letterId',origin.data->>'letterId','approvalId',CASE WHEN origin.trigger_event='approvalActionNeeded' THEN origin.data->>'approvalId' END,'documentRevision',origin.data->'documentRevision') INTO context
 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 WHERE f.tenant_id=origin.tenant_id AND f.case_id=p_case;
 RETURN context;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_mail_context(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_delivery_period_current(p_tenant uuid,p_case uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
 JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 LEFT JOIN LATERAL(SELECT employment_type FROM public.assignment assignment WHERE assignment.tenant_id=employment.tenant_id AND assignment.employment_id=employment.id AND assignment.superseded_at IS NULL
 AND assignment.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (assignment.valid_to IS NULL OR assignment.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY assignment.valid_from DESC,assignment.id LIMIT 1) placement ON true
 WHERE f.tenant_id=p_tenant AND f.case_id=p_case AND employment.voided_at IS NULL AND employment.blacklisted_at IS NULL
 AND (least(employment.resignation_date,employment.last_working_date,employment.terminated_on) IS NULL OR least(employment.resignation_date,employment.last_working_date,employment.terminated_on)>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND f.data->'period'->>'sourceRevision'=encode(sha256(convert_to(jsonb_build_array(employment.id,employment.person_id,employment.company_id,employment.contract_start_date,employment.contract_end_date,employment.contract_number,placement.employment_type,employment.voided_at,employment.blacklisted_at,employment.resignation_date,employment.last_working_date,employment.terminated_on)::text,'UTF8')),'hex'))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_delivery_period_current(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Tenant is supplied by the capability's stored delivery row, never by an email request or recipient.
CREATE FUNCTION app.contract_shared_delivery_eligible(p_tenant uuid,p_case uuid,p_context jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
 JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 JOIN public.contract_shared_event event ON event.tenant_id=f.tenant_id AND event.case_id=f.case_id AND event.id::text=p_context->>'eventId'
 JOIN public.app_user origin ON origin.tenant_id=event.tenant_id AND origin.id=event.actor_user_id AND origin.person_id=event.actor_person_id
 JOIN public.tenant tenant ON tenant.id=f.tenant_id JOIN public.company company ON company.tenant_id=c.tenant_id AND company.id=c.company_id
 WHERE f.tenant_id=p_tenant AND f.case_id=p_case AND employment.person_id::text=p_context->>'subjectPersonId' AND f.data->'period'->>'sourceRevision'=p_context->>'periodRevision'
 AND event.decision_revision::text=p_context->>'decisionRevision' AND tenant.status IN('active','trial') AND company.archived_at IS NULL
 AND (f.data->'declined'='null'::jsonb OR event.trigger_event='employeeDeclined' OR EXISTS(SELECT 1 FROM public.contract_shared_letter declined_letter WHERE declined_letter.tenant_id=f.tenant_id AND declined_letter.case_id=f.case_id AND declined_letter.id::text=event.data->>'letterId' AND declined_letter.purpose='declined'))
 AND (event.trigger_event<>'approvalActionNeeded' OR EXISTS(SELECT 1 FROM public.contract_shared_approval approval JOIN public.document_signing_document signing ON signing.tenant_id=approval.tenant_id AND signing.id=approval.signing_document_id
 WHERE approval.tenant_id=f.tenant_id AND approval.case_id=f.case_id AND approval.id::text=p_context->>'approvalId' AND signing.revision::text=p_context->>'documentRevision'
 AND NOT app.document_signing_returned(signing.data) AND EXISTS(SELECT 1 FROM app.document_signing_pending_steps(signing.data))))
 AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=f.tenant_id AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.expires_at IS NULL OR module.expires_at>now()) AND (module.company_id IS NULL OR module.company_id=c.company_id))
 AND (event.trigger_event NOT IN('letterActionNeeded','letterSentBack') OR EXISTS(SELECT 1 FROM public.contract_shared_letter letter JOIN public.document_signing_document signing ON signing.tenant_id=letter.tenant_id AND signing.id=letter.signing_document_id
 WHERE letter.tenant_id=f.tenant_id AND letter.case_id=f.case_id AND letter.id::text=p_context->>'letterId' AND letter.data->>'state'='routing' AND signing.revision::text=p_context->>'documentRevision'))
 AND CASE WHEN event.decision_revision=0 THEN f.data->'decision'='null'::jsonb AND f.data->>'stage'='open' AND app.contract_shared_delivery_period_current(p_tenant,p_case)
 ELSE ((f.data->'decision'->>'revision')=event.decision_revision::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(f.data->'decisionHistory') decision WHERE decision->>'revision'=event.decision_revision::text))
 AND EXISTS(SELECT 1 FROM public.contract_shared_event original JOIN public.app_user actor ON actor.tenant_id=original.tenant_id AND actor.id=original.actor_user_id AND actor.person_id=original.actor_person_id
 WHERE original.tenant_id=f.tenant_id AND original.case_id=f.case_id AND original.trigger_event='decisionSubmitted' AND original.decision_revision=event.decision_revision)
 AND (app.contract_shared_delivery_period_current(p_tenant,p_case)
 OR EXISTS(SELECT 1 FROM public.contract_shared_letter letter WHERE letter.tenant_id=f.tenant_id AND letter.case_id=f.case_id AND letter.decision_revision=event.decision_revision AND letter.data->>'state'='released' AND letter.data->'valuesFixed'='true'::jsonb)
 OR EXISTS(SELECT 1 FROM public.personnel_posting posting WHERE posting.tenant_id=f.tenant_id AND posting.id::text=f.data->'posting'->>'id' AND posting.source='contract_staff' AND posting.source_ref=f.case_id AND posting.employment_id=c.employment_id AND posting.status='approved')) END)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_delivery_eligible(uuid,uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_approval_eligible_user(p_tenant uuid,p_approval uuid,p_step text,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_approval approval CROSS JOIN LATERAL jsonb_array_elements(approval.data->'assignments') assignment
 JOIN public.contract_case c ON c.tenant_id=approval.tenant_id AND c.id=approval.case_id JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 JOIN public.app_user account ON account.tenant_id=approval.tenant_id AND account.id=p_user JOIN public.person person ON person.tenant_id=account.tenant_id AND person.id=account.person_id
 WHERE approval.tenant_id=p_tenant AND approval.id=p_approval AND assignment->'layer'->>'id'=p_step AND account.archived_at IS NULL AND NOT app.login_blocked(account.id)
 AND length(btrim(person.full_name))>0 AND account.person_id<>employment.person_id
 AND CASE WHEN assignment->'layer'->>'pick'='any' AND nullif(assignment->>'groupId','') IS NOT NULL THEN EXISTS(SELECT 1 FROM public.lc_v9_config config CROSS JOIN LATERAL jsonb_array_elements(config.data->'groups') assignment_group
 WHERE config.tenant_id=approval.tenant_id AND assignment_group->>'id'=assignment->>'groupId' AND assignment_group->'members' ? account.id::text)
 ELSE assignment->'candidatePersonIds'->>account.id::text=account.person_id::text AND (assignment->'layer'->>'pick'<>'roundRobin' OR assignment->>'selectedUserId'=account.id::text) END)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_approval_eligible_user(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Each kernel unit resolves at most 200 current approvers; large Any groups continue by user id.
CREATE FUNCTION app.contract_shared_approval_mail_page(p_case uuid,p_after uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin public.contract_shared_event;result jsonb;
BEGIN
 SELECT * INTO origin FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND case_id=p_case AND id::text=current_setting('app.contract_event',true);
 IF origin.trigger_event IS DISTINCT FROM 'approvalActionNeeded' OR app.contract_shared_worker_event_held(p_case,origin.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Protected approval notice required' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('approvalId',approval.id,'revision',signing.revision,'recipients',coalesce((
  SELECT jsonb_agg(account.id ORDER BY account.id) FROM (
   SELECT DISTINCT account.id FROM app.document_signing_pending_steps(signing.data) pending
   JOIN LATERAL jsonb_array_elements(approval.data->'assignments') assignment ON assignment->'layer'->>'id'=pending->>'id'
   CROSS JOIN LATERAL(
    SELECT member AS user_id FROM public.lc_v9_config config CROSS JOIN LATERAL jsonb_array_elements(config.data->'groups') assignment_group CROSS JOIN LATERAL jsonb_array_elements_text(assignment_group->'members') member
    WHERE config.tenant_id=approval.tenant_id AND assignment->'layer'->>'pick'='any' AND assignment_group->>'id'=assignment->>'groupId'
    UNION SELECT candidate FROM jsonb_object_keys(assignment->'candidatePersonIds') candidate WHERE (assignment->'layer'->>'pick'<>'any' OR nullif(assignment->>'groupId','') IS NULL)
    AND (assignment->'layer'->>'pick'<>'roundRobin' OR candidate=assignment->>'selectedUserId')
   ) candidate
   JOIN public.app_user account ON account.tenant_id=approval.tenant_id AND account.id::text=candidate.user_id
   WHERE (p_after IS NULL OR account.id>p_after) AND app.contract_shared_approval_eligible_user(approval.tenant_id,approval.id,pending->>'id',account.id)
   ORDER BY account.id LIMIT 200
  ) account),'[]'::jsonb)) INTO result
 FROM public.contract_shared_approval approval JOIN public.document_signing_document signing ON signing.tenant_id=approval.tenant_id AND signing.id=approval.signing_document_id
 WHERE approval.tenant_id=origin.tenant_id AND approval.case_id=p_case AND approval.id::text=origin.data->>'approvalId' AND signing.revision::text=origin.data->>'documentRevision'
 AND NOT app.document_signing_returned(signing.data) AND EXISTS(SELECT 1 FROM app.document_signing_pending_steps(signing.data));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_approval_mail_page(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_approval_eligible(p_approval uuid,p_step text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_approval_eligible_user(app.current_tenant_id(),p_approval,p_step,app.current_user_id())
$$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_delivery_link(p_tenant uuid,p_case uuid,p_user uuid,p_context jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid;
BEGIN
 SELECT letter.id INTO target FROM public.contract_shared_letter letter WHERE letter.tenant_id=p_tenant AND letter.case_id=p_case AND letter.id::text=p_context->>'letterId';
 IF target IS NOT NULL THEN RETURN '/lifecycle/contracts/letters/'||target::text;END IF;
 SELECT approval.id INTO target FROM public.contract_shared_approval approval JOIN public.document_signing_document signing ON signing.tenant_id=approval.tenant_id AND signing.id=approval.signing_document_id
 WHERE approval.tenant_id=p_tenant AND approval.case_id=p_case AND approval.decision_revision::text=p_context->>'decisionRevision'
 AND EXISTS(SELECT 1 FROM app.document_signing_pending_steps(signing.data) step WHERE app.contract_shared_approval_eligible_user(p_tenant,approval.id,step->>'id',p_user))
 ORDER BY approval.created_at DESC,approval.id LIMIT 1;
 RETURN CASE WHEN target IS NOT NULL THEN '/lifecycle/contracts/approvals/'||target::text ELSE '/lifecycle/contracts/'||p_case::text END;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_delivery_link(uuid,uuid,uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_effect_held(p_case uuid,p_run uuid,p_step text,p_type text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.automation_run run JOIN public.automation_workflow_version version ON version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision
 JOIN public.contract_shared_event event ON event.tenant_id=run.tenant_id AND event.case_id=run.subject_id AND event.id::text=current_setting('app.contract_event',true)
 WHERE run.tenant_id=app.current_tenant_id() AND run.id=p_run AND run.module='contract_staff' AND run.subject_id=p_case AND run.status IN('running','waiting')
 AND app.contract_shared_worker_event_held(p_case,event.decision_revision) AND (p_type IN('notify','sendEmail') OR app.contract_shared_decision_current(p_case,event.decision_revision))
 AND EXISTS(SELECT 1 FROM public.contract_shared_case flow WHERE flow.tenant_id=run.tenant_id AND flow.case_id=p_case AND (flow.data->'declined'='null'::jsonb OR event.trigger_event='employeeDeclined'
  OR EXISTS(SELECT 1 FROM public.contract_shared_letter letter WHERE letter.tenant_id=run.tenant_id AND letter.case_id=p_case AND letter.id::text=event.data->>'letterId' AND letter.purpose='declined')))
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(version.definition->'steps') step WHERE step->>'id'=p_step AND step->>'type'=p_type))
$$;
--> statement-breakpoint

-- Event conditions are frozen at admission; delayed execution does not reinterpret a new organisation assignment.
CREATE OR REPLACE FUNCTION app.contract_shared_enqueue_event(p_case uuid,p_trigger text,p_occurrence text,p_data jsonb DEFAULT '{}'::jsonb,p_versions jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;event_id uuid;existing_job uuid;queued jsonb;versions jsonb;
BEGIN
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;
 IF f.case_id IS NULL OR app.contract_verified_human(app.current_user_id()) IS NOT TRUE THEN RAISE EXCEPTION 'Verified Contract event required' USING ERRCODE='42501';END IF;
 SELECT id,job_id INTO event_id,existing_job FROM public.contract_shared_event WHERE tenant_id=f.tenant_id AND case_id=p_case AND trigger_event=p_trigger AND occurrence=p_occurrence;
 IF event_id IS NOT NULL THEN RETURN jsonb_build_object('eventId',event_id,'jobId',existing_job);END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('workflowId',workflow_id,'revision',revision) ORDER BY workflow_id),'[]'::jsonb) INTO versions FROM
 (SELECT DISTINCT ON(v.workflow_id) workflow_id,revision,status,definition FROM public.automation_workflow_version v WHERE tenant_id=f.tenant_id AND module='contract_staff' ORDER BY workflow_id,revision DESC) latest
 WHERE status='live' AND definition->'trigger'->>'event'=p_trigger;
 IF p_versions IS NOT NULL THEN
  IF jsonb_typeof(p_versions) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid accepted workflow versions' USING ERRCODE='22023';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_versions) x WHERE NOT EXISTS(SELECT 1 FROM public.automation_workflow_version v WHERE v.tenant_id=f.tenant_id AND v.workflow_id::text=x->>'workflowId' AND v.revision::text=x->>'revision' AND v.module='contract_staff' AND v.status='live' AND v.definition->'trigger'->>'event'=p_trigger)) THEN RAISE EXCEPTION 'Accepted workflow version is unavailable' USING ERRCODE='40001';END IF;
  versions:=p_versions;
 END IF;
 event_id:=gen_random_uuid();
 INSERT INTO public.contract_shared_event(tenant_id,id,case_id,trigger_event,occurrence,decision_revision,actor_user_id,actor_person_id,workflow_versions,data)
 VALUES(f.tenant_id,event_id,p_case,p_trigger,p_occurrence,coalesce((f.data->'decision'->>'revision')::integer,0),app.current_user_id(),app.contract_actor_person(app.current_user_id()),versions,app.contract_shared_event_data(p_case,p_trigger,p_data));
 queued:=app.bulk_job_enqueue('contract_automation',event_id,ARRAY[(SELECT company_id FROM public.contract_case WHERE tenant_id=f.tenant_id AND id=p_case)]::uuid[],'',NULL,jsonb_build_object('eventId',event_id));
 IF queued->>'id' IS NULL THEN RAISE EXCEPTION 'The Contract event could not be queued' USING ERRCODE='40001';END IF;
 UPDATE public.contract_shared_event SET job_id=(queued->>'id')::uuid WHERE tenant_id=f.tenant_id AND id=event_id;
 RETURN jsonb_build_object('eventId',event_id,'jobId',queued->>'id');
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.contract_shared_enqueue_child_event(p_parent uuid,p_trigger text,p_occurrence text,p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent public.contract_shared_event;versions jsonb;event_id uuid;
BEGIN
 SELECT * INTO parent FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_parent;
 IF parent.id IS NULL OR parent.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR app.contract_shared_worker_event_held(parent.case_id,parent.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Protected causative event required' USING ERRCODE='42501';END IF;
 IF p_trigger NOT IN('letterActionNeeded','letterReleased','approvalActionNeeded') THEN RAISE EXCEPTION 'Invalid owner event' USING ERRCODE='22023';END IF;
 SELECT id INTO event_id FROM public.contract_shared_event WHERE tenant_id=parent.tenant_id AND case_id=parent.case_id AND trigger_event=p_trigger AND occurrence=p_occurrence;
 IF event_id IS NOT NULL THEN RETURN event_id;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('workflowId',workflow_id,'revision',revision) ORDER BY workflow_id),'[]'::jsonb) INTO versions FROM
 (SELECT DISTINCT ON(v.workflow_id) workflow_id,revision,status,definition FROM public.automation_workflow_version v WHERE tenant_id=parent.tenant_id AND module='contract_staff' ORDER BY workflow_id,revision DESC) latest
 WHERE status='live' AND definition->'trigger'->>'event'=p_trigger;
 INSERT INTO public.contract_shared_event(tenant_id,case_id,trigger_event,occurrence,decision_revision,actor_user_id,actor_person_id,workflow_versions,data,job_id,root_event_id)
 VALUES(parent.tenant_id,parent.case_id,p_trigger,p_occurrence,parent.decision_revision,parent.actor_user_id,parent.actor_person_id,versions,app.contract_shared_event_data(parent.case_id,p_trigger,p_data),parent.job_id,coalesce(parent.root_event_id,parent.id)) RETURNING id INTO event_id;
 RETURN event_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_enqueue_child_event(uuid,text,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

-- Assignment mail is a native task transition, independent of configurable Notify email steps.
CREATE FUNCTION app.contract_shared_approval_notice_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE approval public.contract_shared_approval;
BEGIN
 IF NEW.subject_type<>'contract-approval' OR jsonb_array_length(NEW.data->'actions')=jsonb_array_length(OLD.data->'actions')
 OR app.document_signing_returned(NEW.data) OR NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(NEW.data)) THEN RETURN NEW;END IF;
 SELECT * INTO approval FROM public.contract_shared_approval WHERE tenant_id=NEW.tenant_id AND signing_document_id=NEW.id;
 IF approval.id IS NULL THEN RAISE EXCEPTION 'Missing native approval task' USING ERRCODE='40001';END IF;
 PERFORM app.contract_shared_enqueue_event(approval.case_id,'approvalActionNeeded','approval:'||approval.id::text||':revision:'||NEW.revision::text,jsonb_build_object('approvalId',approval.id));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_approval_notice_transition() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_shared_approval_notice_transition AFTER UPDATE OF data ON public.document_signing_document FOR EACH ROW EXECUTE FUNCTION app.contract_shared_approval_notice_transition();
--> statement-breakpoint

-- Preserve Probation envelopes; Contract messages bind recipients and resolve an individual task link.
CREATE OR REPLACE FUNCTION app.automation_email_queue_rich(p_module text, p_subject uuid, p_key text, p_to uuid[], p_cc uuid[], p_subject_line text, p_body text,p_rich_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); to_ids uuid[]; cc_ids uuid[]; unreachable uuid[]; queued integer := 0; v_employment uuid; link text; v_context jsonb; recipient_people jsonb; chunk_size integer:=8;
BEGIN
  IF app.automation_can_run(p_module, p_subject) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE = '42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF p_rich_body IS NOT NULL AND (jsonb_typeof(p_rich_body) IS DISTINCT FROM 'object' OR octet_length(p_rich_body::text)>524288) THEN RAISE EXCEPTION 'Invalid rich email source' USING ERRCODE='22023';END IF;
  IF length(coalesce(p_key, '')) NOT BETWEEN 1 AND 300 OR length(coalesce(p_subject_line, '')) NOT BETWEEN 1 AND 500 OR length(coalesce(p_body, '')) > 20000
     OR coalesce(cardinality(p_to), 0) > 200 OR coalesce(cardinality(p_cc), 0) > 200 OR coalesce(cardinality(p_to), 0) + coalesce(cardinality(p_cc), 0) = 0
  THEN RAISE EXCEPTION 'Invalid workflow email' USING ERRCODE = '22023'; END IF;
  IF p_module = 'probation' THEN
    SELECT c.employment_id INTO v_employment FROM public.probation_case c WHERE c.id = p_subject AND c.tenant_id = t;
    IF v_employment IS NULL THEN RAISE EXCEPTION 'Probation case unavailable'; END IF;
    link := '/lifecycle/probation/' || p_subject::text;
  ELSIF p_module='contract_staff' THEN
    v_context:=app.contract_shared_mail_context(p_subject,p_key);
    v_employment:=(v_context->>'employmentId')::uuid;
    link:='/lifecycle/contracts/'||p_subject::text;
    chunk_size:=1;
  ELSE RAISE EXCEPTION 'Invalid workflow email' USING ERRCODE = '22023'; END IF;
  WITH input AS (
    SELECT DISTINCT ON (x.id) x.id, x.n, x.list FROM (
      SELECT id, n, 1 AS list FROM unnest(coalesce(p_to, '{}'::uuid[])) WITH ORDINALITY a(id, n)
      UNION ALL SELECT id, n, 2 AS list FROM unnest(coalesce(p_cc, '{}'::uuid[])) WITH ORDINALITY b(id, n)) x
    WHERE x.id IS NOT NULL ORDER BY x.id, x.list, x.n
  ), checked AS (
    SELECT i.id, i.n, i.list, EXISTS(
      SELECT 1 FROM public.app_user u JOIN public.app_external_identity identity ON identity.app_user_id = u.id AND identity.revoked_at IS NULL AND identity.issuer LIKE '%/auth/' || t::text
      WHERE u.id = i.id AND u.tenant_id = t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) AS reachable
    FROM input i
  )
  SELECT coalesce(array_agg(id ORDER BY n) FILTER (WHERE reachable AND list = 1), '{}'),
         coalesce(array_agg(id ORDER BY n) FILTER (WHERE reachable AND list = 2), '{}'),
         coalesce(array_agg(id ORDER BY list, n) FILTER (WHERE NOT reachable), '{}')
    INTO to_ids, cc_ids, unreachable FROM checked;
  IF cardinality(to_ids) = 0 THEN to_ids := cc_ids; cc_ids := '{}'; END IF;
  IF cardinality(to_ids) > 0 THEN
    IF p_module='contract_staff' THEN
      SELECT coalesce(jsonb_object_agg(account.id::text,account.person_id),'{}'::jsonb) INTO recipient_people FROM public.app_user account WHERE account.tenant_id=t AND account.id=ANY(to_ids||cc_ids);
      v_context:=v_context||jsonb_build_object('recipientPeople',recipient_people);
    END IF;
    WITH inserted AS (
      INSERT INTO public.automation_email_delivery (tenant_id, module, subject_id, mail_key, payload, created_by)
      SELECT t, p_module, p_subject, p_key || ':' || g::text,
        jsonb_build_object('version', 1, 'module', p_module, 'subjectId', p_subject, 'linkPath', link, 'mail', jsonb_build_object(
          'id', p_key || ':' || g::text, 'to', to_jsonb(to_ids[g * chunk_size + 1 : g * chunk_size + chunk_size]), 'cc', CASE WHEN g = 0 THEN to_jsonb(cc_ids) ELSE '[]'::jsonb END,
          'subject', p_subject_line, 'body', coalesce(p_body, ''),'richBody',p_rich_body,
          'delivery', jsonb_build_object('version', 1, 'sender', 'noreply', 'pdfDocumentIds', '[]'::jsonb, 'linkDocumentIds', '[]'::jsonb, 'assets', '[]'::jsonb)))||CASE WHEN v_context IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('context',v_context) END,
        app.current_user_id()
      FROM generate_series(0, (cardinality(to_ids) - 1) / chunk_size) g
      ON CONFLICT (tenant_id, mail_key) DO NOTHING RETURNING 1)
    SELECT count(*) INTO queued FROM inserted;
  END IF;
  IF queued > 0 THEN
    INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, subject_employment_id, payload)
    VALUES (t, 'automation-email', p_subject, 'automation.email-queued', CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,
      app.current_user_id(), v_employment, jsonb_build_object('module', p_module, 'subjectId', p_subject, 'key', p_key, 'messages', queued,
      'recipients', cardinality(to_ids) + cardinality(cc_ids), 'withoutEmail', cardinality(unreachable)));
  END IF;
  RETURN jsonb_build_object('queued', queued, 'to', to_jsonb(to_ids), 'cc', to_jsonb(cc_ids), 'unreachable', to_jsonb(unreachable));
END $$;

--> statement-breakpoint

-- The private capability rechecks source, recipient-person bindings and current task status before SMTP.
CREATE OR REPLACE FUNCTION app.automation_email_target(p_id uuid, p_token uuid, p_origin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.automation_email_delivery%ROWTYPE; recipients jsonb; bindings jsonb; total integer;
BEGIN
  IF p_origin IS NULL OR p_origin !~ '^https://[^/@?#[:space:]]+(:[0-9]+)?$' THEN RETURN NULL; END IF;
  SELECT * INTO job FROM public.automation_email_delivery WHERE id = p_id AND lease_token = p_token
    AND status = 'leased' AND started_at IS NULL AND lease_until > clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF job.module = 'probation' AND NOT EXISTS(SELECT 1 FROM public.probation_case c WHERE c.id = job.subject_id AND c.tenant_id = job.tenant_id) THEN RETURN NULL; END IF;
  IF job.module='contract_staff' AND app.contract_shared_delivery_eligible(job.tenant_id,job.subject_id,job.payload->'context') IS NOT TRUE THEN RETURN NULL;END IF;
  recipients := coalesce(job.payload->'mail'->'to', '[]'::jsonb) || coalesce(job.payload->'mail'->'cc', '[]'::jsonb);
  SELECT count(*) INTO total FROM jsonb_array_elements_text(recipients);
  SELECT jsonb_agg(jsonb_build_object('userId', r.uid, 'subject', identity.subject, 'issuer', identity.issuer) ORDER BY r.ordinality)
    INTO bindings
    FROM jsonb_array_elements_text(recipients) WITH ORDINALITY r(uid, ordinality)
    JOIN public.app_user u ON u.id::text = r.uid AND u.tenant_id = job.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    JOIN public.app_external_identity identity ON identity.app_user_id = u.id AND identity.issuer = p_origin || '/auth/' || job.tenant_id::text AND identity.revoked_at IS NULL AND (job.module<>'contract_staff' OR u.person_id::text=job.payload->'context'->'recipientPeople'->>u.id::text);
  bindings := coalesce(bindings, '[]'::jsonb);
  IF total < 1 OR jsonb_array_length(bindings) <> total OR (SELECT count(DISTINCT b->>'userId') FROM jsonb_array_elements(bindings) b) <> total THEN RETURN NULL; END IF;
  IF job.module='contract_staff' THEN
    job.payload:=jsonb_set(job.payload,'{linkPath}',to_jsonb(app.contract_shared_delivery_link(job.tenant_id,job.subject_id,(job.payload->'mail'->'to'->>0)::uuid,job.payload->'context')));
  END IF;
  RETURN jsonb_build_object('id', job.id, 'tenantId', job.tenant_id, 'module', job.module, 'subjectId', job.subject_id, 'payload', job.payload, 'bindings', bindings);
END $$;
--> statement-breakpoint
