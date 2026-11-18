-- Native period/event ports are callable only inside a held fixed morning kernel unit.
CREATE FUNCTION app.contract_shared_system_event(p_case uuid,p_trigger text,p_occurrence text,p_versions jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;event_id uuid;job uuid;versions jsonb;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF app.contract_shared_system_job_held(nullif(current_setting('app.bulk_job',true),'')::uuid) IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM public.bulk_job WHERE id::text=current_setting('app.bulk_job',true) AND kind='contract_schedule')
 OR p_trigger NOT IN('caseOpened','beforeContractEnd','afterContractEnd') THEN RAISE EXCEPTION 'Held native morning event required' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;
 IF f.case_id IS NULL OR length(p_occurrence)>200 THEN RAISE EXCEPTION 'Native current period required' USING ERRCODE='22023';END IF;
 SELECT id,job_id INTO event_id,job FROM public.contract_shared_event WHERE tenant_id=f.tenant_id AND case_id=p_case AND trigger_event=p_trigger AND occurrence=p_occurrence;
 IF event_id IS NOT NULL THEN RETURN jsonb_build_object('eventId',event_id,'jobId',job);END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('workflowId',workflow_id,'revision',revision) ORDER BY workflow_id),'[]'::jsonb) INTO versions FROM(
 SELECT DISTINCT ON(workflow_id) workflow_id,revision,status,definition FROM public.automation_workflow_version WHERE tenant_id=f.tenant_id AND module='contract_staff' ORDER BY workflow_id,revision DESC) latest
 WHERE status='live' AND definition->'trigger'->>'event'=p_trigger;
 IF p_versions IS NOT NULL THEN
  IF jsonb_typeof(p_versions) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_versions) wanted WHERE NOT versions @> jsonb_build_array(wanted)) THEN RAISE EXCEPTION 'Scheduled workflow changed' USING ERRCODE='40001';END IF;
  versions:=p_versions;
 END IF;
 event_id:=gen_random_uuid();
 INSERT INTO public.contract_shared_event(tenant_id,id,case_id,trigger_event,occurrence,decision_revision,actor_user_id,actor_person_id,actor_type,workflow_versions,data)
 VALUES(f.tenant_id,event_id,p_case,p_trigger,p_occurrence,coalesce((f.data->'decision'->>'revision')::integer,0),NULL,NULL,'system',versions,app.contract_shared_event_data(p_case,p_trigger,'{}'::jsonb));
 job:=app.contract_shared_system_enqueue('contract_scheduled_automation',event_id,jsonb_build_object('eventId',event_id),p_trigger,day,p_case,event_id);
 UPDATE public.contract_shared_event SET job_id=job WHERE tenant_id=f.tenant_id AND id=event_id;
 RETURN jsonb_build_object('eventId',event_id,'jobId',job);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_system_event(uuid,text,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_system_period_open(p_employment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE case_number text;reference_number bigint;e public.employment;existing public.contract_case;new_case uuid:=gen_random_uuid();new_term uuid:=gen_random_uuid();term_version integer;flow jsonb;source jsonb;period text;queued jsonb;actor uuid:=app.current_user_id();
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.contract_shared_system_job_held(nullif(current_setting('app.bulk_job',true),'')::uuid) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.bulk_job WHERE id::text=current_setting('app.bulk_job',true) AND kind='contract_schedule') THEN RAISE EXCEPTION 'Held morning admission required' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=app.current_tenant_id() AND id=p_employment FOR UPDATE;
 IF e.id IS NULL OR NOT app.contract_company_writable(e.company_id) OR NOT EXISTS(SELECT 1 FROM public.contract_shared_settings WHERE tenant_id=e.tenant_id AND company_id=e.company_id) THEN RAISE EXCEPTION 'Contract case opening unavailable' USING ERRCODE='42501';END IF;
 IF e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL OR e.contract_end_date<e.contract_start_date
 OR e.hired_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR e.voided_at IS NOT NULL OR e.blacklisted_at IS NOT NULL
 OR least(e.terminated_on,e.resignation_date,e.last_working_date)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=e.tenant_id AND c.id=e.company_id AND c.archived_at IS NULL)
 OR (SELECT a.employment_type FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) IS DISTINCT FROM 'contract'
 THEN RAISE EXCEPTION 'Verify the active fixed-term Personnel period before opening a case' USING ERRCODE='22023';END IF;
 IF app.contract_shared_native_intake_hold(e.id) IS NOT NULL THEN RAISE EXCEPTION 'Complete the native first post-retirement intake before starting a generic Contract period' USING ERRCODE='40001';END IF;
 period:=app.contract_shared_period_revision(e.id);

 SELECT * INTO existing FROM public.contract_case c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id
 AND c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text ORDER BY c.created_at DESC,c.id LIMIT 1 FOR UPDATE;
 IF existing.id IS NOT NULL THEN
  IF existing.data->'sourceSnapshot'->>'personId' IS NOT NULL AND existing.data->'sourceSnapshot'->>'personId' IS DISTINCT FROM e.person_id::text
   OR EXISTS(SELECT 1 FROM public.contract_shared_case f WHERE f.tenant_id=e.tenant_id AND f.case_id=existing.id AND f.data->'period'->>'sourceRevision' IS DISTINCT FROM period)
  THEN RAISE EXCEPTION 'The existing period source changed; reconcile it before continuing' USING ERRCODE='40001';END IF;
  -- Opening never adopts, rewrites or restarts a legacy case. Its pinned WIP remains on the legacy route.
  RETURN jsonb_build_object('caseId',existing.id,'legacy',NOT EXISTS(SELECT 1 FROM public.contract_shared_case f WHERE f.tenant_id=e.tenant_id AND f.case_id=existing.id));
 END IF;
 -- Never bypass unfinished work for a prior period by manufacturing a second active case.
 IF EXISTS(SELECT 1 FROM public.contract_case c LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id
  AND (f.case_id IS NULL AND c.data->>'state' NOT IN('renewed','handed_off','cancelled') OR f.case_id IS NOT NULL AND f.data->>'stage' NOT IN('renewed','converted','offboarding','superseded','pay')))
 THEN RAISE EXCEPTION 'Finish or reconcile the prior Contract case before opening the new Personnel period' USING ERRCODE='40001';END IF;
 source:=app.contract_source(e.id);
 SELECT coalesce(max(version),0)+1 INTO term_version FROM public.contract_term WHERE tenant_id=e.tenant_id AND employment_id=e.id;
 INSERT INTO public.contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision)
 VALUES(new_term,e.tenant_id,e.company_id,e.id,term_version,'fixed_term',e.contract_start_date,e.contract_end_date,period);
 INSERT INTO public.tenant_counter(tenant_id,kind,value) VALUES(e.tenant_id,'contract-'||to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY'),1)
 ON CONFLICT(tenant_id,kind) DO UPDATE SET value=tenant_counter.value+1 RETURNING value INTO reference_number;
 case_number:='CT-'||to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY')||'-'||lpad(reference_number::text,greatest(4,length(reference_number::text)),'0');
 INSERT INTO public.contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data)
 VALUES(new_case,e.tenant_id,e.company_id,e.id,new_term,case_number,1,
  jsonb_build_object('id',new_case,'number',case_number,'revision',1,'state','upcoming','term',jsonb_build_object('id',new_term,'kind','fixed_term','startOn',e.contract_start_date,'endOn',e.contract_end_date,'sourceRevision',period),'sourceSnapshot',source,'decision',NULL,'decisionDraft',NULL));
 flow:=jsonb_build_object('version',2,'revision',1,'stage','open','period',jsonb_build_object('id',new_term,'startOn',e.contract_start_date,'endOn',e.contract_end_date,'number',e.contract_number::text,'sourceRevision',period),
  'decision',NULL,'decisionHistory','[]'::jsonb,'flags','[]'::jsonb,'lastActivityAt',now(),'posting',NULL,'payConfirmation',NULL,'offboardingId',NULL,'declined',NULL);
 INSERT INTO public.contract_shared_case(tenant_id,case_id,revision,data) VALUES(e.tenant_id,new_case,1,flow);
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(e.tenant_id,'contract',new_case,'contract.shared.opened','system',NULL,e.id,jsonb_build_object('periodId',new_term,'contractNumber',e.contract_number,'jobId',current_setting('app.bulk_job',true)));
 queued:=app.contract_shared_system_event(new_case,'caseOpened','period:'||new_term::text);
 RETURN queued||jsonb_build_object('caseId',new_case,'legacy',false);
END $$;

REVOKE ALL ON FUNCTION app.contract_shared_system_period_open(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_worker_event_held(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_job_id uuid;v_event_id uuid;e public.contract_shared_event;f public.contract_shared_case;c public.contract_case;
BEGIN
 IF app.contract_shared_storage_runner() IS NOT TRUE THEN RETURN false;END IF;
 BEGIN v_job_id:=nullif(current_setting('app.bulk_job',true),'')::uuid;v_event_id:=nullif(current_setting('app.contract_event',true),'')::uuid;EXCEPTION WHEN invalid_text_representation THEN RETURN false;END;
 IF app.contract_shared_system_job_held(v_job_id) THEN
  RETURN EXISTS(SELECT 1 FROM public.contract_shared_event event JOIN app.contract_system_job_source source ON source.job_id=event.job_id AND source.tenant_id=event.tenant_id AND source.event_id=event.id
   WHERE event.tenant_id=app.current_tenant_id() AND event.id=v_event_id AND event.case_id=p_case AND event.decision_revision=p_revision AND event.actor_type='system' AND event.processed_at IS NULL
   AND event.trigger_event IN('caseOpened','beforeContractEnd','afterContractEnd'));
 END IF;
 IF v_job_id IS NULL OR v_event_id IS NULL OR app.bulk_job_capability_held(v_job_id) IS NOT TRUE THEN RETURN false;END IF;
 SELECT e1.* INTO e FROM public.contract_shared_event e1 JOIN public.bulk_job j ON j.tenant_id=e1.tenant_id AND j.id=e1.job_id
 WHERE e1.tenant_id=app.current_tenant_id() AND e1.id=v_event_id AND e1.job_id=v_job_id AND j.kind='contract_automation'
 AND coalesce(e1.root_event_id,e1.id)::text=j.input->>'eventId' AND e1.case_id=p_case AND e1.decision_revision=p_revision AND e1.processed_at IS NULL;
 IF e.id IS NULL THEN RETURN false;END IF;
 IF app.contract_shared_decision_current(p_case,p_revision) THEN RETURN true;END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=e.tenant_id AND case_id=p_case;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=e.tenant_id AND id=p_case;
 IF app.contract_shared_native_intake_hold(c.employment_id) IS NOT NULL THEN RETURN false;END IF;
 IF f.data->'period'->>'sourceRevision' IS DISTINCT FROM app.contract_shared_period_revision(c.employment_id) OR NOT app.contract_case_company_current(c.id) OR c.source_conflict IS NOT NULL OR coalesce((app.contract_source(c.employment_id)->>'ended')::boolean,false) THEN RETURN false;END IF;
 IF p_revision=0 THEN RETURN f.data->'decision'='null'::jsonb AND e.actor_person_id=app.contract_binding_person(e.actor_user_id);END IF;
 RETURN e.trigger_event='approvalRejected' AND EXISTS(SELECT 1 FROM jsonb_array_elements(f.data->'decisionHistory') d WHERE d=e.data->'decision')
 AND EXISTS(SELECT 1 FROM public.contract_shared_event original WHERE original.tenant_id=e.tenant_id AND original.case_id=e.case_id AND original.trigger_event='decisionSubmitted' AND original.decision_revision=e.decision_revision AND original.actor_person_id=app.contract_binding_person(original.actor_user_id));
END $$;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_effect_held(p_case uuid,p_run uuid,p_step text,p_type text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (NOT app.contract_shared_system_job_held(nullif(current_setting('app.bulk_job',true),'')::uuid) OR p_type IN('notify','sendEmail')) AND EXISTS(SELECT 1 FROM public.automation_run r JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision
 JOIN public.contract_shared_case f ON f.tenant_id=r.tenant_id AND f.case_id=r.subject_id
 WHERE r.tenant_id=app.current_tenant_id() AND r.id=p_run AND r.module='contract_staff' AND r.subject_id=p_case AND r.status IN('running','waiting')
 AND app.contract_shared_worker_event_held(p_case,coalesce((f.data->'decision'->>'revision')::integer,0))
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.definition->'steps') s WHERE s->>'id'=p_step AND s->>'type'=p_type))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_effect_held(uuid,uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_system_period_try_open(p_employment uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN app.contract_shared_system_period_open(p_employment);
EXCEPTION WHEN SQLSTATE '40001' OR SQLSTATE '22023' OR SQLSTATE '42501' THEN
 RETURN jsonb_build_object('held',true,'reason','The current native period or setup needs review.');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_system_period_try_open(uuid) FROM PUBLIC,ai_hr_app;
