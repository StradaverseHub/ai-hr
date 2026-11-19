-- Narrow forward repair: both cached pre-recovery function OIDs and current names share one boundary.
-- The private original implementation is copied before either compatibility name becomes a dispatcher.
DO $$
BEGIN
 EXECUTE replace(pg_get_functiondef('app.contract_shared_worker_event_held_before_email_recovery(uuid,integer)'::regprocedure),'app.contract_shared_worker_event_held_before_email_recovery(', 'app.contract_shared_worker_event_held_recovery_base(');
 EXECUTE replace(pg_get_functiondef('app.contract_shared_effect_held_before_email_recovery(uuid,uuid,text,text)'::regprocedure),'app.contract_shared_effect_held_before_email_recovery(', 'app.contract_shared_effect_held_recovery_base(');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_worker_event_held_recovery_base(uuid,integer),app.contract_shared_effect_held_recovery_base(uuid,uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_worker_event_held(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id::text=current_setting('app.contract_event',true);
 IF event.trigger_event='emailDocumentReady' THEN RETURN event.case_id=p_case AND event.decision_revision=p_revision AND app.contract_shared_email_prerequisite_event_held(event.id);END IF;
 RETURN app.contract_shared_worker_event_held_recovery_base(p_case,p_revision);
END $$;
CREATE OR REPLACE FUNCTION app.contract_shared_worker_event_held_before_email_recovery(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_shared_worker_event_held(p_case,p_revision) $$;
CREATE OR REPLACE FUNCTION app.contract_shared_effect_held(p_case uuid,p_run uuid,p_step text,p_type text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id::text=current_setting('app.contract_event',true);
 IF event.trigger_event='emailDocumentReady' THEN RETURN p_type='sendEmail' AND event.case_id=p_case AND event.data->>'runId'=p_run::text AND event.data->>'stepId'=p_step AND app.contract_shared_email_prerequisite_event_held(event.id);END IF;
 RETURN app.contract_shared_effect_held_recovery_base(p_case,p_run,p_step,p_type);
END $$;
CREATE OR REPLACE FUNCTION app.contract_shared_effect_held_before_email_recovery(p_case uuid,p_run uuid,p_step text,p_type text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_shared_effect_held(p_case,p_run,p_step,p_type) $$;
REVOKE ALL ON FUNCTION app.contract_shared_worker_event_held(uuid,integer),app.contract_shared_worker_event_held_before_email_recovery(uuid,integer),app.contract_shared_effect_held(uuid,uuid,text,text),app.contract_shared_effect_held_before_email_recovery(uuid,uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE app.contract_email_prerequisite_origin ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_email_prerequisite_origin FORCE ROW LEVEL SECURITY;
ALTER TABLE app.contract_email_prerequisite_resume ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_email_prerequisite_resume FORCE ROW LEVEL SECURITY;
ALTER TABLE app.contract_email_upload_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_email_upload_observation FORCE ROW LEVEL SECURITY;
ALTER TABLE app.contract_email_upload_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_email_upload_seen FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_email_prerequisite_origin_owner ON app.contract_email_prerequisite_origin FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_email_prerequisite_resume_owner ON app.contract_email_prerequisite_resume FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_email_upload_observation_owner ON app.contract_email_upload_observation FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_email_upload_seen_owner ON app.contract_email_upload_seen FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.contract_email_prerequisite_origin,app.contract_email_prerequisite_resume,app.contract_email_upload_observation,app.contract_email_upload_seen FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- An original predecision email may outlive the first decision. No source history or new phase is invented.
CREATE OR REPLACE FUNCTION app.contract_shared_email_file_pin_valid(p_pin uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pin public.contract_shared_email_document_step;run public.automation_run;flow jsonb;frozen_step jsonb;step_index integer;actual_company uuid;actual_person uuid;original jsonb;
BEGIN
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=app.current_tenant_id() AND id=p_pin;
 IF pin.id IS NULL THEN RETURN false;END IF;
 SELECT f.data,c.company_id,e.person_id INTO flow,actual_company,actual_person
 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
 JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id
 JOIN public.company company ON company.tenant_id=c.tenant_id AND company.id=c.company_id AND company.archived_at IS NULL
 JOIN public.person person ON person.tenant_id=e.tenant_id AND person.id=e.person_id
 WHERE f.tenant_id=pin.tenant_id AND f.case_id=pin.case_id AND e.voided_at IS NULL AND e.blacklisted_at IS NULL;
 IF flow IS NULL OR actual_company IS DISTINCT FROM pin.company_id OR actual_person IS DISTINCT FROM pin.subject_person_id
 OR flow->'period'->>'sourceRevision' IS DISTINCT FROM pin.source_period_revision OR app.contract_company_entitled(pin.company_id) IS NOT TRUE THEN RETURN false;END IF;
 original:=app.contract_shared_email_prerequisite_origin(pin.id);
 IF original IS NULL THEN
  IF (CASE WHEN flow->'declined' IS NULL OR flow->'declined'='null'::jsonb THEN 'outcome' ELSE 'declined' END) IS DISTINCT FROM pin.phase THEN RETURN false;END IF;
  IF coalesce(flow->'decision'->>'revision','0')<>pin.decision_revision::text AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(flow->'decisionHistory')='array' THEN flow->'decisionHistory' ELSE '[]'::jsonb END) history WHERE history->>'revision'=pin.decision_revision::text) THEN RETURN false;END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_email_template_version email WHERE email.tenant_id=pin.tenant_id AND email.template_id=pin.email_template_id AND email.revision=pin.email_revision AND email.module='contract_staff' AND email.active AND NOT email.retired) THEN RETURN false;END IF;
 SELECT * INTO run FROM public.automation_run WHERE tenant_id=pin.tenant_id AND id=pin.workflow_run_id AND subject_id=pin.case_id AND module='contract_staff' AND status IN('running','waiting');
 IF run.id IS NULL THEN RETURN false;END IF;
 SELECT (ordinality-1)::integer,step INTO step_index,frozen_step FROM public.automation_workflow_version version CROSS JOIN LATERAL jsonb_array_elements(version.definition->'steps') WITH ORDINALITY steps(step,ordinality)
 WHERE version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision AND version.module='contract_staff' AND step->>'id'=pin.workflow_step_id AND step->>'type'='sendEmail' AND step->'params'->>'emailTemplateId'=pin.email_template_id::text LIMIT 1;
 IF frozen_step IS NULL THEN RETURN false;END IF;
 -- Stored pending proof must precede the original-worker alternate, avoiding readiness/effect recursion.
 IF run.status='waiting' AND run.waiting_for::text=pin.id::text AND run.step_cursor=step_index AND run.remaining_steps->0->>'index'=step_index::text AND run.remaining_steps->0->'step'=frozen_step THEN RETURN true;END IF;
 IF EXISTS(SELECT 1 FROM public.contract_shared_event event WHERE event.tenant_id=pin.tenant_id AND event.id::text=current_setting('app.contract_event',true) AND event.trigger_event='emailDocumentReady') THEN RETURN false;END IF;
 RETURN app.contract_shared_effect_held(pin.case_id,pin.workflow_run_id,pin.workflow_step_id,'sendEmail') IS TRUE;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_file_pin_valid(uuid) FROM PUBLIC,ai_hr_app;
