-- Contract letters and decision approvals are subjects of the existing signing owner. Routes/actions/revisions have
-- one persisted owner; Contract retains immutable template/body snapshots and its business eligibility adapters.
ALTER TABLE public.document_signing_document DROP CONSTRAINT document_signing_document_subject_type_check;
ALTER TABLE public.document_signing_document ADD CONSTRAINT document_signing_document_subject_type_check CHECK(subject_type IN('probation','contract','contract-approval'));
--> statement-breakpoint
ALTER TABLE public.contract_shared_letter ADD COLUMN signing_document_id uuid,ADD COLUMN decision_revision integer,
 ADD COLUMN workflow_run_id uuid,ADD COLUMN workflow_step_id text,ADD COLUMN purpose text NOT NULL DEFAULT 'outcome' CHECK(purpose IN('outcome','declined'));
ALTER TABLE public.contract_shared_letter ADD CONSTRAINT contract_shared_letter_signing_fk FOREIGN KEY(tenant_id,signing_document_id) REFERENCES public.document_signing_document(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.contract_shared_letter ADD CONSTRAINT contract_shared_letter_run_fk FOREIGN KEY(tenant_id,workflow_run_id) REFERENCES public.automation_run(tenant_id,id);
CREATE UNIQUE INDEX contract_shared_letter_purpose ON public.contract_shared_letter(tenant_id,case_id,decision_revision,purpose);
--> statement-breakpoint
CREATE TABLE public.contract_shared_approval (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),id uuid NOT NULL DEFAULT gen_random_uuid(),case_id uuid NOT NULL,
 decision_revision integer NOT NULL CHECK(decision_revision>0),workflow_run_id uuid NOT NULL,workflow_step_id text NOT NULL,
 signing_document_id uuid NOT NULL,data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES public.contract_shared_case(tenant_id,case_id),
 FOREIGN KEY(tenant_id,workflow_run_id) REFERENCES public.automation_run(tenant_id,id),
 FOREIGN KEY(tenant_id,signing_document_id) REFERENCES public.document_signing_document(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(tenant_id,workflow_run_id,workflow_step_id),CHECK(octet_length(data::text)<=1048576)
);
CREATE INDEX contract_shared_approval_case ON public.contract_shared_approval(tenant_id,case_id,decision_revision);
--> statement-breakpoint
CREATE TABLE public.contract_shared_letter_content (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),letter_id uuid NOT NULL,content_revision integer NOT NULL CHECK(content_revision>0),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,letter_id,content_revision,content_hash),FOREIGN KEY(tenant_id,letter_id) REFERENCES public.contract_shared_letter(tenant_id,id)
);
ALTER TABLE public.contract_shared_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_approval FORCE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_letter_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_letter_content FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_shared_approval_owner ON public.contract_shared_approval FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_shared_letter_content_owner ON public.contract_shared_letter_content FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON public.contract_shared_approval,public.contract_shared_letter_content FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_shared_letter_content_immutable BEFORE UPDATE OR DELETE ON public.contract_shared_letter_content FOR EACH ROW EXECUTE FUNCTION app.contract_case_revision_immutable();
--> statement-breakpoint
-- Fixed dispatch, never a caller-selected function name. Probation adapters retain their current semantics.
CREATE FUNCTION app.contract_shared_decision_current(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
 JOIN public.contract_shared_event e ON e.tenant_id=f.tenant_id AND e.case_id=f.case_id AND e.trigger_event='decisionSubmitted' AND e.decision_revision=p_revision
 WHERE f.tenant_id=app.current_tenant_id() AND f.case_id=p_case AND (f.data->'decision'->>'revision')::integer=p_revision
 AND f.data->'period'->>'sourceRevision'=app.contract_shared_period_revision(c.employment_id)
 AND app.contract_case_company_current(c.id) AND c.source_conflict IS NULL
 AND e.actor_person_id=app.contract_binding_person(e.actor_user_id))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_decision_current(uuid,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- This is a kernel capability check, never a caller-supplied actor or a second job lease.
CREATE FUNCTION app.contract_shared_worker_event_held(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job_id uuid;
BEGIN
 IF app.contract_shared_storage_runner() IS NOT TRUE THEN RETURN false;END IF;
 BEGIN job_id:=nullif(current_setting('app.bulk_job',true),'')::uuid;EXCEPTION WHEN invalid_text_representation THEN RETURN false;END;
 IF job_id IS NULL OR app.bulk_job_capability_held(job_id) IS NOT TRUE THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.bulk_job j JOIN public.contract_shared_event e ON e.tenant_id=j.tenant_id AND e.job_id=j.id AND e.id::text=j.input->>'eventId'
 WHERE j.tenant_id=app.current_tenant_id() AND j.id=job_id AND j.kind='contract_automation' AND e.case_id=p_case AND e.decision_revision=p_revision AND e.processed_at IS NULL)
 AND app.contract_shared_decision_current(p_case,p_revision);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_worker_event_held(uuid,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_approval_signing_content(p_approval uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('companyId',c.company_id,'employmentId',c.employment_id,'contentHash',a.data->>'contentHash','contentRevision',1,'routing',NULL)
 FROM public.contract_shared_approval a JOIN public.contract_case c ON c.tenant_id=a.tenant_id AND c.id=a.case_id
 WHERE a.tenant_id=app.current_tenant_id() AND a.id=p_approval
$$;
REVOKE ALL ON FUNCTION app.contract_shared_approval_signing_content(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- An Any-member claim follows current native group membership; named and round-robin holders remain frozen.
CREATE FUNCTION app.contract_shared_approval_eligible(p_approval uuid,p_step text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_verified_human(app.current_user_id()) AND EXISTS(
 SELECT 1 FROM public.contract_shared_approval a CROSS JOIN LATERAL jsonb_array_elements(a.data->'assignments') x
 JOIN public.contract_case c ON c.tenant_id=a.tenant_id AND c.id=a.case_id JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id
 WHERE a.tenant_id=app.current_tenant_id() AND a.id=p_approval AND x->'layer'->>'id'=p_step
 AND app.contract_actor_person(app.current_user_id())<>e.person_id
 AND CASE WHEN x->'layer'->>'pick'='any' AND nullif(x->>'groupId','') IS NOT NULL THEN EXISTS(
  SELECT 1 FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g
  WHERE v.tenant_id=a.tenant_id AND g->>'id'=x->>'groupId' AND g->'members' ? app.current_user_id()::text)
 ELSE x->'candidatePersonIds'->>app.current_user_id()::text=app.contract_actor_person(app.current_user_id())::text
 AND (x->'layer'->>'pick'<>'roundRobin' OR x->>'selectedUserId'=app.current_user_id()::text) END)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_approval_eligible(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_approval_action_allowed(p_approval uuid,p_action jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_action->>'action' IN('approved','returned') AND p_action->'signature'='null'::jsonb
 AND app.contract_shared_approval_eligible(p_approval,p_action->>'stepId')
 AND EXISTS(SELECT 1 FROM public.contract_shared_approval a WHERE a.tenant_id=app.current_tenant_id() AND a.id=p_approval
 AND app.contract_shared_decision_current(a.case_id,a.decision_revision))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_approval_action_allowed(uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Fixed dispatch, never a caller-selected function name. Probation adapters retain their current semantics.
-- This projection is private: agreed letter terms are exposed only by the content-visibility adapter below.
CREATE FUNCTION app.contract_shared_letter_values(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f jsonb;s jsonb;amount text;values jsonb;signers jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.id IS NULL THEN RETURN NULL;END IF;
 IF l.data->'valuesFixed'='true'::jsonb THEN RETURN l.data->'values';END IF;
 SELECT c.data,app.contract_source(k.employment_id) INTO f,s FROM public.contract_shared_case c JOIN public.contract_case k ON k.tenant_id=c.tenant_id AND k.id=c.case_id WHERE c.tenant_id=l.tenant_id AND c.case_id=l.case_id;
 amount:=CASE WHEN f->'decision'->'payChanges'='true'::jsonb THEN f->'decision'->>'salaryCents' ELSE s->>'salaryCents' END;
 values:=jsonb_build_object('employee.name',coalesce(s->>'name',''),'employee.id',coalesce(s->>'employeeId',''),'employee.jobTitle',coalesce(s->>'designation',''),
 'org.company',coalesce(s->>'company',''),'org.businessGroup',coalesce((SELECT bg.legal_name FROM public.contract_case k JOIN public.company co ON co.tenant_id=k.tenant_id AND co.id=k.company_id JOIN public.company bg ON bg.tenant_id=co.tenant_id AND bg.id=coalesce(co.parent_company_id,co.id) WHERE k.tenant_id=l.tenant_id AND k.id=l.case_id),''),
 'org.department',coalesce(s->>'department',''),'people.lineManager',coalesce(s->>'manager',''),
 'contract.start',f->'period'->>'startOn','contract.end',f->'period'->>'endOn','contract.number',f->'period'->>'number',
 'contract.newStart',coalesce(f->'decision'->>'startOn',''),'contract.newEnd',coalesce(f->'decision'->>'endOn',''),'contract.term',coalesce(f->'decision'->>'months',''),
 'contract.salary',CASE WHEN amount ~ '^[0-9]+$' THEN (amount::bigint/100)::text||'.'||lpad((amount::bigint%100)::text,2,'0') ELSE '' END,
 'contract.reason',coalesce(f->'decision'->>'reason',''),'case.link','/lifecycle/contracts/'||l.case_id::text,'today',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text);
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO signers FROM(
 SELECT 'signingStep.'||(step->>'id')||'.name' AS key,p.full_name AS value
 FROM jsonb_array_elements(l.data->'signingPolicy'->'route'->'steps') step JOIN public.app_user u ON u.tenant_id=l.tenant_id AND u.id::text=step->>'holderId' AND u.person_id::text=step->>'holderPersonId'
 JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id
 UNION ALL SELECT 'signingStep.'||(step->>'id')||'.label',coalesce(step->>'label','Authorised signatory') FROM jsonb_array_elements(l.data->'signingPolicy'->'route'->'steps') step
 ) names;
 RETURN values||signers;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_values(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_snapshot(p_letter uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',l.id,'caseId',l.case_id,'decisionRevision',l.decision_revision,'contentRevision',(l.data->>'contentRevision')::integer,
 'templateId',l.data->>'templateId','templateVersion',l.data->'templateVersion','generatedOn',l.data->>'generatedOn','definition',l.data->'definition','blocks',l.data->'blocks','values',app.contract_shared_letter_values(l.id))
 FROM public.contract_shared_letter l WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter
$$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_snapshot(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_signing_content(p_letter uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('companyId',c.company_id,'employmentId',c.employment_id,'contentHash',encode(sha256(convert_to(app.contract_shared_letter_snapshot(l.id)::text,'UTF8')),'hex'),
 'contentRevision',(l.data->>'contentRevision')::integer,'routing',l.data->'signingPolicy'->'routing')
 FROM public.contract_shared_letter l JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter
$$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_signing_content(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_signing_access(p_type text,p_subject uuid,p_operation text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE case_id uuid;decision_revision integer;document jsonb;metadata jsonb;document_id uuid;pending jsonb;current_decision boolean;assigned boolean;
BEGIN
 IF app.current_tenant_id() IS NULL OR p_type NOT IN('contract','contract-approval') THEN RETURN false;END IF;
 IF p_type='contract' THEN
  SELECT l.case_id,l.decision_revision,l.signing_document_id,l.data INTO case_id,decision_revision,document_id,metadata FROM public.contract_shared_letter l WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_subject;
 ELSE
  SELECT a.case_id,a.decision_revision,a.signing_document_id,a.data INTO case_id,decision_revision,document_id,metadata FROM public.contract_shared_approval a WHERE a.tenant_id=app.current_tenant_id() AND a.id=p_subject;
 END IF;
 IF case_id IS NULL THEN RETURN false;END IF;
 IF p_operation='create' THEN RETURN app.contract_shared_worker_event_held(case_id,decision_revision)
  AND NOT EXISTS(SELECT 1 FROM public.document_signing_document d WHERE d.tenant_id=app.current_tenant_id() AND d.id=document_id);END IF;
 IF app.contract_verified_human(app.current_user_id()) IS NOT TRUE THEN RETURN false;END IF;
 SELECT d.data INTO document FROM public.document_signing_document d WHERE d.tenant_id=app.current_tenant_id() AND d.id=document_id AND d.subject_type=p_type AND d.subject_id=p_subject;
 IF document IS NULL THEN RETURN false;END IF;
 SELECT s INTO pending FROM app.document_signing_pending_steps(document) s ORDER BY (s->>'stage')::integer,s->>'id' LIMIT 1;
 assigned:=EXISTS(SELECT 1 FROM jsonb_array_elements(document->'route'->'steps') s WHERE s->>'holderId'=app.current_user_id()::text AND s->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(document->'actions') a WHERE a->>'actorId'=app.current_user_id()::text AND a->>'actorPersonId'=app.contract_actor_person(app.current_user_id())::text);
 IF p_type='contract-approval' AND pending IS NOT NULL THEN assigned:=assigned OR app.contract_shared_approval_eligible(p_subject,pending->>'id');END IF;
 IF p_operation='read' THEN RETURN assigned OR app.contract_shared_case_permitted(case_id,'view');END IF;
 current_decision:=app.contract_shared_decision_current(case_id,decision_revision);
 IF NOT current_decision THEN RETURN false;END IF;
 IF p_type='contract-approval' THEN
  IF p_operation IN('sign','reroute') THEN RETURN pending IS NOT NULL AND NOT app.document_signing_returned(document) AND app.contract_shared_approval_eligible(p_subject,pending->>'id');END IF;
  RETURN false;
 END IF;
 IF metadata->>'state'<>'routing' THEN RETURN false;END IF;
 IF p_operation='sign' THEN RETURN assigned AND (pending IS NOT NULL OR app.document_signing_returned(document) AND app.document_signing_owner(document)=app.current_user_id());END IF;
 IF p_operation='revise' THEN RETURN app.document_signing_can_edit(document,app.current_user_id());END IF;
 IF p_operation='live_refresh' THEN RETURN assigned AND NOT app.document_signing_locked(document);END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_signing_access(text,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_approval_claim(p_approval uuid,p_step text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.contract_shared_approval;d public.document_signing_document;pending jsonb;assignment jsonb;route jsonb;next_document jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO a FROM public.contract_shared_approval WHERE tenant_id=app.current_tenant_id() AND id=p_approval FOR UPDATE;
 IF a.id IS NULL OR app.contract_shared_decision_current(a.case_id,a.decision_revision) IS NOT TRUE OR app.contract_shared_approval_eligible(a.id,p_step) IS NOT TRUE THEN RAISE EXCEPTION 'This approval is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=a.tenant_id AND id=a.signing_document_id FOR UPDATE;
 SELECT s INTO pending FROM app.document_signing_pending_steps(d.data) s WHERE s->>'id'=p_step;
 IF pending IS NULL THEN RAISE EXCEPTION 'Approval moved to another layer' USING ERRCODE='40001';END IF;
 IF pending->>'holderId'=app.current_user_id()::text AND pending->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text THEN RETURN d.id;END IF;
 SELECT x INTO assignment FROM jsonb_array_elements(a.data->'assignments') x WHERE x->'layer'->>'id'=p_step;
 IF assignment->'layer'->>'pick'<>'any' OR nullif(assignment->>'groupId','') IS NULL THEN RAISE EXCEPTION 'The selected approval holder changed' USING ERRCODE='40001';END IF;
 SELECT jsonb_set(d.data->'route','{steps}',jsonb_agg(CASE WHEN s->>'id'=p_step THEN s||jsonb_build_object('holderId',app.current_user_id(),'holderPersonId',app.contract_actor_person(app.current_user_id())) ELSE s END ORDER BY n)) INTO route FROM jsonb_array_elements(d.data->'route'->'steps') WITH ORDINALITY x(s,n);
 UPDATE public.contract_shared_approval SET data=jsonb_set(data,'{signingPolicy,route}',route),updated_at=now() WHERE tenant_id=a.tenant_id AND id=a.id;
 next_document:=jsonb_set(d.data,'{route}',route);
 PERFORM app.document_signing_store(d.id,d.employment_id,d.company_id,d.subject_id,next_document,d.guardrails,d.revision,'reroute','Current eligible Any-member approver');
 RETURN d.id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_approval_claim(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_approval_claim(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_action_allowed(p_letter uuid,p_action jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_action->>'action' IN('signed','reviewed','approved','returned','resent') AND EXISTS(
 SELECT 1 FROM public.contract_shared_letter l WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter AND l.data->>'state'='routing'
 AND app.contract_shared_decision_current(l.case_id,l.decision_revision))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_action_allowed(uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.document_signing_subject_content(p_type text,p_subject uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_type='probation' AND to_regprocedure('app.probation_signing_content(uuid)') IS NOT NULL THEN EXECUTE 'SELECT app.probation_signing_content($1)' INTO result USING p_subject;
 ELSIF p_type='contract' AND to_regprocedure('app.contract_shared_letter_signing_content(uuid)') IS NOT NULL THEN EXECUTE 'SELECT app.contract_shared_letter_signing_content($1)' INTO result USING p_subject;
 ELSIF p_type='contract-approval' AND to_regprocedure('app.contract_shared_approval_signing_content(uuid)') IS NOT NULL THEN EXECUTE 'SELECT app.contract_shared_approval_signing_content($1)' INTO result USING p_subject;
 END IF;RETURN result;
END $$;
CREATE FUNCTION app.document_signing_subject_guardrails(p_type text,p_subject uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_type='probation' AND to_regprocedure('app.probation_signing_guardrails(uuid)') IS NOT NULL THEN EXECUTE 'SELECT app.probation_signing_guardrails($1)' INTO result USING p_subject;
 ELSIF p_type='contract' THEN SELECT data->'signingPolicy'->'guardrails' INTO result FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_subject;
 ELSIF p_type='contract-approval' THEN SELECT data->'signingPolicy'->'guardrails' INTO result FROM public.contract_shared_approval WHERE tenant_id=app.current_tenant_id() AND id=p_subject;
 END IF;RETURN result;
END $$;
CREATE FUNCTION app.document_signing_subject_route_allowed(p_type text,p_subject uuid,p_route jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result boolean;
BEGIN
 IF p_type='probation' AND to_regprocedure('app.probation_signing_route_allowed(uuid,jsonb)') IS NOT NULL THEN EXECUTE 'SELECT app.probation_signing_route_allowed($1,$2)' INTO result USING p_subject,p_route;
 ELSIF p_type='contract' THEN SELECT data->'signingPolicy'->'route'=p_route INTO result FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_subject;
 ELSIF p_type='contract-approval' THEN SELECT data->'signingPolicy'->'route'=p_route INTO result FROM public.contract_shared_approval WHERE tenant_id=app.current_tenant_id() AND id=p_subject;
 END IF;RETURN result IS TRUE;
END $$;
CREATE FUNCTION app.document_signing_subject_action_allowed(p_type text,p_subject uuid,p_action jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result boolean;
BEGIN
 IF p_type='probation' AND to_regprocedure('app.probation_signing_action_allowed(uuid,jsonb)') IS NOT NULL THEN EXECUTE 'SELECT app.probation_signing_action_allowed($1,$2)' INTO result USING p_subject,p_action;
 ELSIF p_type='contract' AND to_regprocedure('app.contract_shared_letter_action_allowed(uuid,jsonb)') IS NOT NULL THEN EXECUTE 'SELECT app.contract_shared_letter_action_allowed($1,$2)' INTO result USING p_subject,p_action;
 ELSIF p_type='contract-approval' AND to_regprocedure('app.contract_shared_approval_action_allowed(uuid,jsonb)') IS NOT NULL THEN EXECUTE 'SELECT app.contract_shared_approval_action_allowed($1,$2)' INTO result USING p_subject,p_action;
 END IF;RETURN result IS TRUE;
END $$;
REVOKE ALL ON FUNCTION app.document_signing_subject_content(text,uuid),app.document_signing_subject_guardrails(text,uuid),app.document_signing_subject_route_allowed(text,uuid,jsonb),app.document_signing_subject_action_allowed(text,uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.document_signing_subject_access(p_type text,p_subject uuid,p_operation text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE allowed boolean;
BEGIN
 IF app.current_tenant_id() IS NULL THEN RETURN false;END IF;
 IF p_type IN('contract','contract-approval') THEN
  IF to_regprocedure('app.contract_shared_signing_access(text,uuid,text)') IS NULL THEN RETURN false;END IF;
  EXECUTE 'SELECT app.contract_shared_signing_access($1,$2,$3)' INTO allowed USING p_type,p_subject,p_operation;RETURN allowed IS TRUE;
 END IF;
 IF p_type IS DISTINCT FROM 'probation' THEN RETURN false;END IF;
 IF p_operation='canonical_refresh' THEN
  IF to_regprocedure('app.probation_signing_refresh_allowed(uuid)') IS NULL THEN RETURN false;END IF;
  EXECUTE 'SELECT app.probation_signing_refresh_allowed($1)' INTO allowed USING p_subject;RETURN allowed IS TRUE;
 END IF;
 IF app.current_user_id() IS NULL OR app.login_blocked(app.current_user_id()) OR app.principal_snapshot_current() IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id() AND archived_at IS NULL) THEN RETURN false;END IF;
 IF p_operation NOT IN('create','read','sign','decline','revise','reroute') OR to_regprocedure('app.probation_signing_access(uuid,text)') IS NULL THEN RETURN false;END IF;
 EXECUTE 'SELECT app.probation_signing_access($1,$2)' INTO allowed USING p_subject,p_operation;RETURN coalesce(allowed,false);
END $$;
--> statement-breakpoint
-- Live descriptive merge values may change before Contract's first signature. Reviews of the same wording remain
-- receipts of their original hash; signatures always require an exact hash. Wording edits still advance revision.
CREATE OR REPLACE FUNCTION app.document_signing_round_actions(p_data jsonb) RETURNS SETOF jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH history AS (
  SELECT a,n FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_data->'actions')='array' THEN p_data->'actions' ELSE '[]'::jsonb END) WITH ORDINALITY x(a,n)
  WHERE a->>'contentRevision'=p_data->>'contentRevision' AND (a->>'contentHash'=p_data->>'contentHash'
   OR p_data->>'subjectType'='contract' AND p_data->'routing'->'liveMergeReviews'='true'::jsonb AND a->'signature'='null'::jsonb AND a->>'action' IN('reviewed','approved','returned','resent'))
 ) SELECT a FROM history WHERE n>coalesce((SELECT max(n) FROM history WHERE a->>'action'='resent'),0) ORDER BY n
$$;
--> statement-breakpoint
-- The shared store/act bodies follow 5747/5756. Only fixed subject dispatch and the guarded live-field refresh
-- are added; actor checks, append-only receipts, signatures, route order and revision/audit writes remain here.
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
-- Review receipt parity for the shared route validator; inactive past reviewers do not invalidate a completed
-- Contract review solely because a live descriptive merge field refreshed before the first signature.
CREATE OR REPLACE FUNCTION app.document_signing_validate(p_data jsonb,p_rules jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE step jsonb;covered jsonb;target jsonb;role text;manager uuid;
BEGIN
 IF jsonb_typeof(p_data->'route'->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'route'->'steps') NOT BETWEEN 1 AND 30
 OR jsonb_typeof(p_data->'actions') IS DISTINCT FROM 'array' OR jsonb_typeof(p_rules->'requiredRoles') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid signing route'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_data->'route'->'steps'))<>(SELECT count(DISTINCT s->>'id') FROM jsonb_array_elements(p_data->'route'->'steps') s) THEN RAISE EXCEPTION 'Duplicate signing steps'; END IF;
 IF p_data ? 'routing' THEN
  IF jsonb_typeof(p_data->'routing') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid template routing'; END IF;
  IF jsonb_typeof(p_data->'routing'->'templateId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_data->'routing'->'templateVersion') IS DISTINCT FROM 'number'
  OR jsonb_typeof(p_data->'routing'->'caseOwnerId') NOT IN ('string','null') THEN RAISE EXCEPTION 'Invalid template routing'; END IF;
  IF p_data->'routing'->>'caseOwnerId' IS NOT NULL AND p_data->'routing'->>'caseOwnerId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid template routing'; END IF;
 END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_data->'route'->'steps') s WHERE s->'owner'='true'::jsonb)>1 THEN RAISE EXCEPTION 'Only one step can own the document'; END IF;
 FOR step IN SELECT * FROM jsonb_array_elements(p_data->'route'->'steps') LOOP
  IF coalesce(step->>'id','')='' OR coalesce(step->>'role','')='' OR coalesce(step->>'kind','') NOT IN ('sign','acknowledge','approve','review') OR jsonb_typeof(step->'stage') IS DISTINCT FROM 'number' OR (step->>'stage')::integer<0 OR jsonb_typeof(step->'required') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid signing step'; END IF;
  IF step ? 'owner' AND jsonb_typeof(step->'owner') IS DISTINCT FROM 'boolean' OR step ? 'meantFor' AND jsonb_typeof(step->'meantFor') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid signing step'; END IF;
  IF step?'signature' AND (step->'signature' IS DISTINCT FROM 'false'::jsonb OR step->>'kind'<>'approve') THEN RAISE EXCEPTION 'Only Approve may omit a signature';END IF;
  IF step->>'holderId' IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'actions','[]')) prior
  WHERE (prior->>'stepId'=step->>'id' OR coalesce(prior->'coveredStepIds','[]')?(step->>'id')) AND prior->>'action' IN('signed','declined','reviewed','approved')
   AND prior->>'contentRevision'=p_data->>'contentRevision' AND (prior->>'contentHash'=p_data->>'contentHash' OR p_data->>'subjectType'='contract' AND p_data->'routing'->'liveMergeReviews'='true'::jsonb AND prior->'signature'='null'::jsonb AND prior->>'action' IN('reviewed','approved'))
   AND (prior->>'actorId'=step->>'holderId' AND prior->>'actorPersonId'=step->>'holderPersonId' OR prior->>'action'='declined' AND step->>'kind'='acknowledge' AND prior->>'representedId'=coalesce(step->>'representedId',step->>'holderId'))
 ) AND NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=(step->>'holderId')::uuid AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND u.person_id IS NOT NULL AND step->>'holderPersonId'=u.person_id::text AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Invalid signer'; END IF;
  covered:=coalesce(step->'coveredStepIds','[]');
  IF jsonb_typeof(covered) IS DISTINCT FROM 'array' OR jsonb_array_length(covered)>1 OR jsonb_array_length(covered)>0 AND step->>'coveredByStepId' IS NOT NULL THEN RAISE EXCEPTION 'Invalid combined approval coverage';END IF;
  IF step->>'coveredByStepId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') owner WHERE owner->>'id'=step->>'coveredByStepId' AND coalesce(owner->'coveredStepIds','[]')?(step->>'id')) THEN RAISE EXCEPTION 'Covered approval has no signing step';END IF;
  IF jsonb_array_length(covered)=1 THEN
   SELECT value INTO target FROM jsonb_array_elements(p_data->'route'->'steps') WHERE value->>'id'=covered->>0;
   IF target IS NULL OR target->>'coveredByStepId' IS DISTINCT FROM step->>'id' OR step->>'kind'<>'approve' OR target->>'kind'<>'approve' OR step->>'role'=target->>'role'
    OR step->>'required'<>'true' OR target->>'required'<>'true' OR step->>'holderId' IS NULL OR target->>'holderId' IS DISTINCT FROM step->>'holderId'
    OR step->>'holderPersonId' IS NULL OR target->>'holderPersonId' IS DISTINCT FROM step->>'holderPersonId' OR (step->>'stage')::integer>=(target->>'stage')::integer
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') intervening WHERE intervening->>'required'='true' AND intervening->>'id' NOT IN(step->>'id',target->>'id') AND (intervening->>'stage')::integer BETWEEN (step->>'stage')::integer AND (target->>'stage')::integer)
   THEN RAISE EXCEPTION 'One verified signature can cover only adjacent approval roles held by the same actual person';END IF;
  END IF;
 END LOOP;
 FOR role IN SELECT jsonb_array_elements_text(p_rules->'requiredRoles') LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') s WHERE s->>'role'=role AND s->>'required'='true') THEN RAISE EXCEPTION 'Required signing role cannot be removed'; END IF;
 END LOOP;
 IF p_rules->>'independentApprovalFromRole' IS NOT NULL THEN
  SELECT (s->>'holderPersonId')::uuid INTO manager FROM jsonb_array_elements(p_data->'route'->'steps') s WHERE s->>'role'=p_rules->>'independentApprovalFromRole' AND s->>'required'='true' LIMIT 1;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') s WHERE s->>'kind'='approve' AND s->>'required'='true' AND s->>'role'<>p_rules->>'independentApprovalFromRole' AND (s->>'holderId' IS NULL OR manager IS NULL OR (s->>'holderPersonId')::uuid<>manager)) THEN RAISE EXCEPTION 'A distinct approving person is required'; END IF;
 END IF;
END $$;
--> statement-breakpoint
