-- Contract's authorized decision boundary and durable event admission. Execution remains on the shared automation
-- runtime, carried by the existing bulk-job kernel. No Personnel or Payroll value is changed here.
CREATE TABLE public.contract_shared_case_revision (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),case_id uuid NOT NULL,revision integer NOT NULL,
 data jsonb NOT NULL,actor_user_id uuid REFERENCES public.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,case_id,revision),FOREIGN KEY(tenant_id,case_id) REFERENCES public.contract_shared_case(tenant_id,case_id)
);
--> statement-breakpoint
CREATE TABLE public.contract_shared_event (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),id uuid NOT NULL DEFAULT gen_random_uuid(),case_id uuid NOT NULL,
 trigger_event text NOT NULL CHECK(trigger_event IN('caseOpened','beforeContractEnd','afterContractEnd','decisionSubmitted','approvalsComplete','approvalRejected','employeeDeclined','letterActionNeeded','letterSentBack','letterReleased','manual')),
 occurrence text NOT NULL CHECK(length(occurrence) BETWEEN 1 AND 200),decision_revision integer NOT NULL DEFAULT 0 CHECK(decision_revision>=0),
 actor_user_id uuid REFERENCES public.app_user(id),actor_person_id uuid REFERENCES public.person(id),
 workflow_versions jsonb NOT NULL CHECK(jsonb_typeof(workflow_versions)='array' AND jsonb_array_length(workflow_versions)<=200),data jsonb NOT NULL DEFAULT '{}'::jsonb,
 job_id uuid REFERENCES public.bulk_job(id),processed_at timestamptz,error text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES public.contract_shared_case(tenant_id,case_id),
 UNIQUE(tenant_id,case_id,trigger_event,occurrence),CHECK(octet_length(data::text)<=131072)
);
--> statement-breakpoint
CREATE TABLE public.contract_shared_preview (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),id uuid NOT NULL DEFAULT gen_random_uuid(),case_id uuid NOT NULL,
 case_revision integer NOT NULL CHECK(case_revision>0),requested_by uuid NOT NULL REFERENCES public.app_user(id),requested_person_id uuid NOT NULL REFERENCES public.person(id),
 decision jsonb NOT NULL CHECK(jsonb_typeof(decision)='object' AND octet_length(decision::text)<=16384),
 setup_revision text,plan jsonb,job_id uuid REFERENCES public.bulk_job(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES public.contract_shared_case(tenant_id,case_id)
);
--> statement-breakpoint
CREATE INDEX contract_shared_event_pending ON public.contract_shared_event(tenant_id,case_id,created_at,id) WHERE processed_at IS NULL;
--> statement-breakpoint
-- Derived by the shared signing owner, never a competing route or task store. The indexed receipt lets Round robin
-- read referenced people's assignment history without scanning every tenant document's JSON on each preview.
CREATE TABLE public.document_signing_assignment (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),document_id uuid NOT NULL,document_revision integer NOT NULL,
 step_id text NOT NULL,user_id uuid NOT NULL REFERENCES public.app_user(id),person_id uuid NOT NULL REFERENCES public.person(id),
 assigned_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,document_id,document_revision,step_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.document_signing_document(tenant_id,id)
);
CREATE INDEX document_signing_assignment_person ON public.document_signing_assignment(tenant_id,user_id,assigned_at DESC);
ALTER TABLE public.document_signing_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_signing_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY document_signing_assignment_owner ON public.document_signing_assignment FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON public.document_signing_assignment FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
INSERT INTO public.document_signing_assignment(tenant_id,document_id,document_revision,step_id,user_id,person_id,assigned_at)
 SELECT d.tenant_id,d.id,d.revision,s->>'id',u.id,u.person_id,d.created_at FROM public.document_signing_document d
 CROSS JOIN LATERAL jsonb_array_elements(d.data->'route'->'steps') s JOIN public.app_user u ON u.tenant_id=d.tenant_id AND u.id::text=s->>'holderId' AND u.person_id::text=s->>'holderPersonId';
--> statement-breakpoint
CREATE FUNCTION app.document_signing_assignment_project() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO public.document_signing_assignment(tenant_id,document_id,document_revision,step_id,user_id,person_id)
 SELECT NEW.tenant_id,NEW.id,NEW.revision,s->>'id',u.id,u.person_id FROM jsonb_array_elements(NEW.data->'route'->'steps') s
 JOIN public.app_user u ON u.tenant_id=NEW.tenant_id AND u.id::text=s->>'holderId' AND u.person_id::text=s->>'holderPersonId'
 WHERE TG_OP='INSERT' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.data->'route'->'steps') previous
  WHERE previous->>'id'=s->>'id' AND previous->>'holderId'=s->>'holderId' AND previous->>'holderPersonId'=s->>'holderPersonId')
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.document_signing_assignment_project() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER document_signing_assignment_project AFTER INSERT OR UPDATE OF data ON public.document_signing_document FOR EACH ROW EXECUTE FUNCTION app.document_signing_assignment_project();
--> statement-breakpoint
ALTER TABLE public.contract_shared_case_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_case_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_event FORCE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_preview ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_preview FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_shared_case_revision_owner ON public.contract_shared_case_revision FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_shared_event_owner ON public.contract_shared_event FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_shared_preview_owner ON public.contract_shared_preview FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON public.contract_shared_case_revision,public.contract_shared_event,public.contract_shared_preview FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
INSERT INTO public.contract_shared_case_revision(tenant_id,case_id,revision,data)
 SELECT tenant_id,case_id,revision,data FROM public.contract_shared_case;
CREATE TRIGGER contract_shared_history_immutable BEFORE UPDATE OR DELETE ON public.contract_shared_case_revision FOR EACH ROW EXECUTE FUNCTION app.contract_case_revision_immutable();
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_revision_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Contract revision must advance once' USING ERRCODE='40001';END IF;
 IF NEW.data->>'revision' IS DISTINCT FROM NEW.revision::text OR NEW.data->>'version' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'Contract flow revision mismatch' USING ERRCODE='22023';END IF;
 INSERT INTO public.contract_shared_case_revision(tenant_id,case_id,revision,data,actor_user_id) VALUES(NEW.tenant_id,NEW.case_id,NEW.revision,NEW.data,app.current_user_id());
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(NEW.tenant_id,'contract-shared-case',NEW.case_id,'contract.shared.updated',CASE WHEN app.current_user_id() IS NULL THEN 'system'::public.actor_type ELSE 'user'::public.actor_type END,app.current_user_id(),jsonb_build_object('revision',NEW.revision,'stage',NEW.data->>'stage'));
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_revision_audit() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_shared_revision_audit AFTER INSERT OR UPDATE ON public.contract_shared_case FOR EACH ROW EXECUTE FUNCTION app.contract_shared_revision_audit();
--> statement-breakpoint
-- Number adoption originally enriched the initial model in a second write. Keep the initial revision's source and
-- ordinal correct before the audit trigger sees it, rather than creating a fabricated user revision.
CREATE OR REPLACE FUNCTION app.contract_shared_adopt(p_case uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;e public.employment;f jsonb;source_value jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case FOR UPDATE;
 IF c.id IS NULL OR app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'decide') IS NOT TRUE THEN RAISE EXCEPTION 'Contract case is unavailable' USING ERRCODE='42501';END IF;
 SELECT data INTO f FROM public.contract_shared_case WHERE tenant_id=c.tenant_id AND case_id=c.id;
 IF f IS NOT NULL THEN RETURN f;END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=c.tenant_id AND id=c.employment_id FOR UPDATE;
 source_value:=app.contract_source(e.id);
 IF (source_value->>'employmentType') IS DISTINCT FROM 'contract' OR coalesce((source_value->>'ended')::boolean,false) THEN RAISE EXCEPTION 'Only a current Contract employment can start this flow' USING ERRCODE='40001';END IF;
 IF e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL THEN RAISE EXCEPTION 'Verify contract number and dates in Personnel Management before starting shared workflows' USING ERRCODE='22023';END IF;
 IF NOT app.contract_case_company_current(c.id) OR c.source_conflict IS NOT NULL OR e.contract_start_date::text IS DISTINCT FROM c.data->'term'->>'startOn' OR e.contract_end_date::text IS DISTINCT FROM c.data->'term'->>'endOn' THEN RAISE EXCEPTION 'Personnel dates changed; reconcile the current period before cutover' USING ERRCODE='40001';END IF;
 IF c.data->>'state' NOT IN('upcoming','decision_pending') OR c.data->'decision' IS DISTINCT FROM 'null'::jsonb OR coalesce(c.data->'decisionDraft','null'::jsonb) IS DISTINCT FROM 'null'::jsonb
 OR EXISTS(SELECT 1 FROM public.contract_document d WHERE d.tenant_id=c.tenant_id AND d.case_id=c.id)
 OR EXISTS(SELECT 1 FROM public.contract_effect x WHERE x.tenant_id=c.tenant_id AND x.case_id=c.id)
 OR EXISTS(SELECT 1 FROM public.contract_date_amendment a WHERE a.tenant_id=c.tenant_id AND a.case_id=c.id AND a.status IN('pending','failed'))
 OR EXISTS(SELECT 1 FROM public.contract_generation_request g WHERE g.tenant_id=c.tenant_id AND g.case_id=c.id AND g.status IN('pending','failed'))
 THEN RAISE EXCEPTION 'This legacy case has work in progress; finish its pinned flow before cutover' USING ERRCODE='40001';END IF;
 f:=jsonb_build_object('version',2,'revision',1,'stage','open','period',jsonb_build_object('id',c.term_id,'startOn',e.contract_start_date,'endOn',e.contract_end_date,'number',e.contract_number::text,'sourceRevision',app.contract_shared_period_revision(e.id)),
 'decision',NULL,'decisionHistory','[]'::jsonb,'flags','[]'::jsonb,'lastActivityAt',now(),'posting',NULL,'payConfirmation',NULL,'offboardingId',NULL,'declined',NULL);
 INSERT INTO public.contract_shared_case(tenant_id,case_id,revision,data) VALUES(c.tenant_id,c.id,1,f);
 PERFORM app.contract_audit(c.id,'shared.adopted',jsonb_build_object('version',2));
 RETURN f;
END $$;
--> statement-breakpoint
-- The event freezes immutable version references at acceptance, not whichever version the worker sees later.
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner)
 VALUES('contract_automation',NULL,'none','{"eventId":"string"}'::jsonb,true),('contract_preview',NULL,'none','{"previewId":"string"}'::jsonb,true);
--> statement-breakpoint
-- This digest is private. It reveals no current pay or unrelated people's identities to the proposer. A preview
-- expires when source, routing, published definitions or a referenced account's person/active binding changes.
CREATE FUNCTION app.contract_shared_setup_revision(p_case uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH workflows AS MATERIALIZED(SELECT DISTINCT ON(workflow_id) workflow_id,revision,status,definition FROM public.automation_workflow_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' ORDER BY workflow_id,revision DESC),
 routings AS MATERIALIZED(SELECT DISTINCT ON(routing_id) routing_id,revision,retired,routing_rows FROM public.automation_routing_version WHERE tenant_id=app.current_tenant_id() ORDER BY routing_id,revision DESC),
 documents AS MATERIALIZED(SELECT h.id,h.live_version,h.retired,v.definition FROM public.automation_document_template h LEFT JOIN public.automation_document_template_version v ON v.tenant_id=h.tenant_id AND v.template_id=h.id AND v.version=h.live_version WHERE h.tenant_id=app.current_tenant_id() AND h.module='contract_staff'),
 members AS MATERIALIZED(
  SELECT jsonb_array_elements_text(coalesce(g->'members','[]'::jsonb)) AS id FROM public.lc_v9_config c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'groups','[]'::jsonb)) g WHERE c.tenant_id=app.current_tenant_id()
  UNION SELECT x#>>'{}' FROM workflows w CROSS JOIN LATERAL jsonb_path_query(w.definition,'$.**.userId') x
  UNION SELECT x#>>'{}' FROM routings r CROSS JOIN LATERAL jsonb_path_query(r.routing_rows,'$[*].assignTo.userIds[*]') x
  UNION SELECT x#>>'{}' FROM documents d CROSS JOIN LATERAL jsonb_path_query(d.definition,'$.routing[*].who.userIds[*]') x
  UNION SELECT u.id::text FROM public.contract_case c CROSS JOIN LATERAL app.contract_users_for_employment(c.employment_id) u(id) WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case
  UNION SELECT u.id::text FROM public.contract_case c CROSS JOIN LATERAL app.contract_manager_users(c.employment_id) u(id) WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case
 )
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'source',(SELECT app.contract_source(c.employment_id) FROM public.contract_case c WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case),
  'settings',(SELECT to_jsonb(s)-'updated_at' FROM public.contract_shared_settings s JOIN public.contract_case c ON c.tenant_id=s.tenant_id AND c.company_id=s.company_id WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id()),
  'configuration',(SELECT jsonb_build_object('groups',data->'groups','fallback',data->'peopleOpsGroup') FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()),
  'workflows',(SELECT jsonb_agg(jsonb_build_array(workflow_id,revision) ORDER BY workflow_id) FROM workflows),
  'routings',(SELECT jsonb_agg(jsonb_build_array(routing_id,revision) ORDER BY routing_id) FROM routings),
  'documents',(SELECT jsonb_agg(jsonb_build_array(id,live_version,retired) ORDER BY id) FROM documents),
  'emails',(SELECT jsonb_agg(jsonb_build_array(template_id,revision) ORDER BY template_id) FROM(SELECT DISTINCT ON(template_id) template_id,revision FROM public.automation_email_template_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' ORDER BY template_id,revision DESC) latest),
  'people',(SELECT jsonb_agg(jsonb_build_array(u.id,u.person_id,app.contract_verified_human(u.id)) ORDER BY u.id) FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id IN(SELECT id::uuid FROM members WHERE id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
  'reasons',(SELECT jsonb_agg(jsonb_build_array(code,is_active) ORDER BY code) FROM public.termination_reason WHERE tenant_id=app.current_tenant_id())
 )::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION app.contract_shared_setup_revision(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_preview_start(p_case uuid,p_expected integer,p_decision jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;preview_id uuid:=gen_random_uuid();queued jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'decide') IS NOT TRUE THEN RAISE EXCEPTION 'Contract preview unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case FOR UPDATE;
 IF f.case_id IS NULL OR f.revision IS DISTINCT FROM p_expected OR f.data->>'stage'<>'open' OR NOT app.contract_case_company_current(p_case) THEN RAISE EXCEPTION 'Contract case changed; reload before previewing' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(p_decision) IS DISTINCT FROM 'object' OR octet_length(p_decision::text)>16384 THEN RAISE EXCEPTION 'Invalid Contract decision' USING ERRCODE='22023';END IF;
 INSERT INTO public.contract_shared_preview(tenant_id,id,case_id,case_revision,requested_by,requested_person_id,decision)
 VALUES(f.tenant_id,preview_id,p_case,p_expected,app.current_user_id(),app.contract_actor_person(app.current_user_id()),p_decision);
 queued:=app.bulk_job_enqueue('contract_preview',preview_id,ARRAY[(SELECT company_id FROM public.contract_case WHERE tenant_id=f.tenant_id AND id=p_case)]::uuid[],'',NULL,jsonb_build_object('previewId',preview_id));
 IF queued->>'id' IS NULL THEN RAISE EXCEPTION 'The preview could not be queued' USING ERRCODE='40001';END IF;
 UPDATE public.contract_shared_preview SET job_id=(queued->>'id')::uuid WHERE tenant_id=f.tenant_id AND id=preview_id;
 RETURN jsonb_build_object('previewId',preview_id,'jobId',queued->>'id');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_preview_start(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_preview_start(uuid,integer,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_preview_read(p_preview uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.contract_shared_preview;
BEGIN
 SELECT * INTO p FROM public.contract_shared_preview WHERE tenant_id=app.current_tenant_id() AND id=p_preview;
 IF p.id IS NULL OR p.requested_by IS DISTINCT FROM app.current_user_id() OR p.requested_person_id IS DISTINCT FROM app.contract_actor_person(app.current_user_id()) OR app.contract_shared_case_permitted(p.case_id,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p.case_id,'decide') IS NOT TRUE THEN RAISE EXCEPTION 'Contract preview unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('id',p.id,'caseId',p.case_id,'caseRevision',p.case_revision,'decision',p.decision,'plan',p.plan-ARRAY['approvalAssignments','letterAssignments'],'jobId',p.job_id);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_preview_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_preview_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_preview_check(p_preview uuid,p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_preview p JOIN public.contract_shared_case f ON f.tenant_id=p.tenant_id AND f.case_id=p.case_id
 WHERE p.tenant_id=app.current_tenant_id() AND p.id=p_preview AND p.job_id=p_job AND p.requested_by=app.current_user_id() AND p.requested_person_id=app.contract_actor_person(app.current_user_id())
 AND app.contract_shared_case_permitted(p.case_id,'view') AND app.contract_shared_case_permitted(p.case_id,'decide') AND p.case_revision=f.revision AND f.data->>'stage'='open')
$$;
REVOKE ALL ON FUNCTION app.contract_shared_preview_check(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_preview_check(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_preview_finish(p_preview uuid,p_job uuid,p_setup text,p_plan jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.contract_shared_preview;j public.bulk_job;allowed boolean;
BEGIN
 IF app.contract_shared_storage_runner() IS NOT TRUE OR app.bulk_job_capability_held(p_job) IS NOT TRUE THEN RAISE EXCEPTION 'Protected preview worker required' USING ERRCODE='42501';END IF;
 SELECT * INTO j FROM public.bulk_job WHERE tenant_id=app.current_tenant_id() AND id=p_job AND kind='contract_preview';
 SELECT * INTO p FROM public.contract_shared_preview WHERE tenant_id=app.current_tenant_id() AND id=p_preview AND job_id=p_job FOR UPDATE;
 IF p.id IS NULL OR j.id IS NULL OR j.input->>'previewId' IS DISTINCT FROM p.id::text OR j.created_by IS DISTINCT FROM p.requested_by
 OR p.requested_person_id IS DISTINCT FROM app.contract_binding_person(p.requested_by)
 OR NOT EXISTS(SELECT 1 FROM public.contract_shared_case f WHERE f.tenant_id=p.tenant_id AND f.case_id=p.case_id AND f.revision=p.case_revision AND f.data->>'stage'='open') THEN RAISE EXCEPTION 'Preview source changed' USING ERRCODE='40001';END IF;
 PERFORM set_config('app.user_id',p.requested_by::text,true);
 allowed:=app.contract_shared_case_permitted(p.case_id,'view') AND app.contract_shared_case_permitted(p.case_id,'decide');
 PERFORM set_config('app.user_id','',true);
 IF allowed IS NOT TRUE THEN RAISE EXCEPTION 'Contract preview permission changed' USING ERRCODE='42501';END IF;
 IF p_setup IS DISTINCT FROM app.contract_shared_setup_revision(p.case_id) THEN RAISE EXCEPTION 'Preview setup changed; retry' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object' OR jsonb_typeof(p_plan->'blockers') IS DISTINCT FROM 'array' OR jsonb_typeof(p_plan->'workflows') IS DISTINCT FROM 'array' OR octet_length(p_plan::text)>1048576 THEN RAISE EXCEPTION 'Invalid decision plan' USING ERRCODE='22023';END IF;
 UPDATE public.contract_shared_preview SET setup_revision=p_setup,plan=p_plan WHERE tenant_id=p.tenant_id AND id=p.id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_preview_finish(uuid,uuid,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_enqueue_event(p_case uuid,p_trigger text,p_occurrence text,p_data jsonb DEFAULT '{}'::jsonb,p_versions jsonb DEFAULT NULL) RETURNS jsonb
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
 VALUES(f.tenant_id,event_id,p_case,p_trigger,p_occurrence,coalesce((f.data->'decision'->>'revision')::integer,0),app.current_user_id(),app.contract_actor_person(app.current_user_id()),versions,p_data);
 queued:=app.bulk_job_enqueue('contract_automation',event_id,ARRAY[(SELECT company_id FROM public.contract_case WHERE tenant_id=f.tenant_id AND id=p_case)]::uuid[],'',NULL,jsonb_build_object('eventId',event_id));
 IF queued->>'id' IS NULL THEN RAISE EXCEPTION 'The Contract event could not be queued' USING ERRCODE='40001';END IF;
 UPDATE public.contract_shared_event SET job_id=(queued->>'id')::uuid WHERE tenant_id=f.tenant_id AND id=event_id;
 RETURN jsonb_build_object('eventId',event_id,'jobId',queued->>'id');
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_enqueue_event(uuid,text,text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Offered codes mirror the native catalogue's published starting identifiers, never their turnover classification.
-- Tenant overlays remain authoritative for enabled/disabled/custom reasons. A DB test binds this finite code set
-- to core/termination-reason.ts; Contract neither stores nor derives a second termination type.
CREATE FUNCTION app.contract_shared_end_reason_offered(p_code text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT is_active FROM public.termination_reason WHERE tenant_id=app.current_tenant_id() AND code=p_code),p_code=ANY(ARRAY['resignation','career_opportunity','personal_reason','retirement','early_retirement','performance_issue','misconduct','redundancy','contract_expiry','absconded','medical_unfit','death','other']))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_end_reason_offered(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_decision_submit(p_case uuid,p_expected integer,p_decision jsonb,p_preview uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;kind text;start_day date;end_day date;months integer;next_decision jsonb;event_result jsonb;decision_revision integer;existing public.contract_shared_event;preview public.contract_shared_preview;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'decide') IS NOT TRUE THEN RAISE EXCEPTION 'Contract decision is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case FOR UPDATE;
 IF f.case_id IS NULL OR NOT app.contract_case_company_current(p_case) THEN RAISE EXCEPTION 'Current shared Contract case required' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(p_decision) IS DISTINCT FROM 'object' OR octet_length(p_decision::text)>16384 THEN RAISE EXCEPTION 'Invalid Contract decision' USING ERRCODE='22023';END IF;
 IF NOT p_decision ?& ARRAY['kind','startOn','endOn','months','payChanges','salaryCents','reason','endReason'] OR p_decision-ARRAY['kind','startOn','endOn','months','payChanges','salaryCents','reason','endReason']<>'{}'::jsonb
 OR jsonb_typeof(p_decision->'payChanges') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_decision->'reason') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid Contract decision fields' USING ERRCODE='22023';END IF;
 IF f.data->'decision' IS NOT NULL AND f.data->'decision'<>'null'::jsonb THEN
  SELECT * INTO existing FROM public.contract_shared_event WHERE tenant_id=f.tenant_id AND case_id=p_case AND trigger_event='decisionSubmitted' AND occurrence='decision:'||(f.data->'decision'->>'revision');
  IF existing.actor_user_id=app.current_user_id() AND existing.data->>'baseRevision'=p_expected::text AND (f.data->'decision'-ARRAY['submittedBy','submittedAt','revision'])=p_decision THEN RETURN jsonb_build_object('flow',f.data,'eventId',existing.id,'jobId',existing.job_id);END IF;
 END IF;
 IF f.revision IS DISTINCT FROM p_expected OR f.data->>'stage'<>'open' OR f.data->'decision' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'This Contract decision changed or was already submitted' USING ERRCODE='40001';END IF;
 SELECT * INTO preview FROM public.contract_shared_preview WHERE tenant_id=f.tenant_id AND id=p_preview AND case_id=p_case;
 IF preview.id IS NULL OR preview.requested_by IS DISTINCT FROM app.current_user_id() OR preview.requested_person_id IS DISTINCT FROM app.contract_actor_person(app.current_user_id()) OR preview.case_revision IS DISTINCT FROM p_expected OR preview.decision IS DISTINCT FROM p_decision OR preview.plan->'blockers' IS DISTINCT FROM '[]'::jsonb OR preview.setup_revision IS DISTINCT FROM app.contract_shared_setup_revision(p_case) THEN RAISE EXCEPTION 'Review a current, ready decision preview before submitting' USING ERRCODE='40001';END IF;
 IF f.data->'period'->>'sourceRevision' IS DISTINCT FROM app.contract_shared_period_revision((SELECT employment_id FROM public.contract_case WHERE tenant_id=f.tenant_id AND id=p_case)) THEN RAISE EXCEPTION 'Personnel period changed; reconcile before submitting' USING ERRCODE='40001';END IF;
 kind:=p_decision->>'kind';
 IF kind NOT IN('renew','convert','end') OR kind IS NULL OR length(p_decision->>'reason')>5000 OR kind<>'end' AND length(btrim(p_decision->>'reason'))=0 THEN RAISE EXCEPTION 'Choose a decision and explain it' USING ERRCODE='22023';END IF;
 IF kind='end' THEN
  IF jsonb_typeof(p_decision->'endReason') IS DISTINCT FROM 'string' OR app.contract_shared_end_reason_offered(p_decision->>'endReason') IS NOT TRUE OR coalesce(length(btrim(p_decision->>'endReason')),0) NOT BETWEEN 1 AND 200 OR p_decision->'payChanges'<>'false'::jsonb
  OR p_decision->'salaryCents' IS DISTINCT FROM 'null'::jsonb OR p_decision->'startOn' IS DISTINCT FROM 'null'::jsonb OR p_decision->'endOn' IS DISTINCT FROM 'null'::jsonb OR p_decision->'months' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Choose an ending reason without renewal terms' USING ERRCODE='22023';END IF;
 ELSE
  IF coalesce(p_decision->>'startOn','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'A new start date is required' USING ERRCODE='22023';END IF;
  start_day:=(p_decision->>'startOn')::date;
  IF start_day<=(f.data->'period'->>'endOn')::date OR to_char(start_day,'YYYY-MM-DD')<>p_decision->>'startOn' THEN RAISE EXCEPTION 'New start must follow the current period' USING ERRCODE='22023';END IF;
  IF p_decision->'endReason' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Ending reasons apply to End only' USING ERRCODE='22023';END IF;
  IF kind='renew' THEN
   IF coalesce(p_decision->>'endOn','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'A new end date is required' USING ERRCODE='22023';END IF;
   end_day:=(p_decision->>'endOn')::date;
   IF end_day<(start_day+interval '3 months')::date-1 OR to_char(end_day,'YYYY-MM-DD')<>p_decision->>'endOn' THEN RAISE EXCEPTION 'The minimum renewal term is 3 months' USING ERRCODE='22023';END IF;
   IF p_decision->'months'<>'null'::jsonb THEN
    IF jsonb_typeof(p_decision->'months') IS DISTINCT FROM 'number' OR (p_decision->>'months') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Invalid term' USING ERRCODE='22023';END IF;
    months:=(p_decision->>'months')::integer;
    IF months NOT BETWEEN 3 AND 120 OR end_day<>(start_day+make_interval(months=>months))::date-1 THEN RAISE EXCEPTION 'Term and dates differ' USING ERRCODE='22023';END IF;
   END IF;
  ELSIF p_decision->'endOn' IS DISTINCT FROM 'null'::jsonb OR p_decision->'months' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Permanent conversion has no contract end or probation' USING ERRCODE='22023';END IF;
  IF p_decision->'payChanges'='true'::jsonb THEN
   IF jsonb_typeof(p_decision->'salaryCents') IS DISTINCT FROM 'string' OR coalesce(p_decision->>'salaryCents','') !~ '^(0|[1-9][0-9]{0,11})$' THEN RAISE EXCEPTION 'Invalid agreed salary' USING ERRCODE='22023';END IF;
  ELSIF p_decision->'salaryCents' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Unchanged pay has no proposed salary' USING ERRCODE='22023';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(v.workflow_id) status,definition FROM public.automation_workflow_version v WHERE tenant_id=f.tenant_id AND module='contract_staff' ORDER BY workflow_id,revision DESC) latest WHERE status='live' AND definition->'trigger'->>'event'='decisionSubmitted') THEN RAISE EXCEPTION 'Set up a live Contract decision workflow before submitting' USING ERRCODE='22023';END IF;
 decision_revision:=coalesce((f.data->'decisionHistory'->-1->>'revision')::integer,0)+1;
 next_decision:=p_decision||jsonb_build_object('submittedBy',app.current_user_id(),'submittedAt',now(),'revision',decision_revision);
 f.data:=f.data||jsonb_build_object('revision',f.revision+1,'stage','workflow','decision',next_decision,'lastActivityAt',now(),'flags',coalesce((SELECT jsonb_agg(flag) FROM jsonb_array_elements(f.data->'flags') flag WHERE flag#>>'{}' NOT IN('no_workflow','posting_mismatch')),'[]'::jsonb));
 UPDATE public.contract_shared_case SET data=f.data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=p_case;
 event_result:=app.contract_shared_enqueue_event(p_case,'decisionSubmitted','decision:'||decision_revision,jsonb_build_object('baseRevision',p_expected,'decision',next_decision,'period',f.data->'period','previewId',preview.id),preview.plan->'workflowVersions');
 RETURN jsonb_build_object('flow',f.data)||event_result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_decision_submit(uuid,integer,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_decision_submit(uuid,integer,jsonb,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_history(p_case uuid,p_before integer DEFAULT 2147483647) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE THEN RAISE EXCEPTION 'Contract history unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT jsonb_build_object('revision',r.revision,'at',r.created_at,'actorId',r.actor_user_id,'flow',r.data) FROM public.contract_shared_case_revision r
 WHERE r.tenant_id=app.current_tenant_id() AND r.case_id=p_case AND r.revision<p_before ORDER BY r.revision DESC LIMIT 50;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_history(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_history(uuid,integer) TO ai_hr_app;
