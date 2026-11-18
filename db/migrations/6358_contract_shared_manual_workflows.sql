-- Start-workflow permission admits one selected live manual definition, never caller-supplied steps or effects.
CREATE FUNCTION app.contract_shared_manual_conditions(p_case uuid,p_definition jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_facts jsonb;v_condition jsonb;v_actual text;v_target text;v_match boolean;
BEGIN
 IF jsonb_typeof(p_definition->'conditions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_definition->'conditions')>20 THEN RETURN false;END IF;
 v_facts:=app.contract_shared_event_data(p_case,'manual','{}'::jsonb)->'conditionFacts';
 IF p_definition->>'skipWhen'='decided' AND v_facts->>'decision' IS NOT NULL THEN RETURN false;END IF;
 IF p_definition->>'skipWhen'='caseClosed' AND EXISTS(SELECT 1 FROM public.contract_shared_case c WHERE c.tenant_id=app.current_tenant_id() AND c.case_id=p_case AND c.data->>'stage' IN('renewed','converted','offboarding','superseded')) THEN RETURN false;END IF;
 FOR v_condition IN SELECT value FROM jsonb_array_elements(p_definition->'conditions') LOOP
  IF v_condition->>'field' NOT IN('decision','endReason','declineReason','businessGroup','payChanges','termMonths','daysToEnd') OR v_condition->>'field' IS NULL
  OR jsonb_typeof(v_condition->'values') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(v_condition->'values') NOT BETWEEN 1 AND 200 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_condition->'values') value WHERE jsonb_typeof(value)<>'string') THEN RETURN false;END IF;
  v_actual:=coalesce(v_facts->>(v_condition->>'field'),'');
  IF v_condition->>'op' IN('is','isNot') THEN
   v_match:=(v_condition->'values') ? v_actual;
   IF v_condition->>'op'='isNot' THEN v_match:=NOT v_match;END IF;
  ELSIF v_condition->>'op' IN('lt','lte','gte') THEN
   v_target:=v_condition->'values'->>0;
   IF jsonb_array_length(v_condition->'values')<>1 OR v_actual !~ '^-?[0-9]+([.][0-9]+)?$' OR v_target !~ '^-?[0-9]+([.][0-9]+)?$' THEN RETURN false;END IF;
   v_match:=CASE v_condition->>'op' WHEN 'lt' THEN v_actual::numeric<v_target::numeric WHEN 'lte' THEN v_actual::numeric<=v_target::numeric ELSE v_actual::numeric>=v_target::numeric END;
  ELSE RETURN false;END IF;
  IF NOT v_match THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_manual_conditions(uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_manual_workflows(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'manual') IS NOT TRUE
 THEN RAISE EXCEPTION 'Manual Contract workflows are unavailable' USING ERRCODE='42501';END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',workflow_id,'revision',revision,'name',definition->>'name','description',coalesce(definition->>'description','')) ORDER BY definition->>'name',workflow_id)
 FROM(SELECT * FROM(SELECT DISTINCT ON(workflow_id) workflow_id,revision,status,definition FROM public.automation_workflow_version
 WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' ORDER BY workflow_id,revision DESC) latest
 WHERE status='live' AND definition->'trigger'->>'event'='manual' AND app.contract_shared_manual_conditions(p_case,definition) ORDER BY definition->>'name',workflow_id LIMIT 200) choices),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_manual_workflows(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_manual_workflows(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_manual_start(p_case uuid,p_expected integer,p_workflow uuid,p_workflow_revision integer,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_flow public.contract_shared_case;v_case public.contract_case;v_workflow public.automation_workflow_version;v_existing public.contract_shared_event;
 v_actor_person uuid;v_versions jsonb;v_result jsonb;v_occurrence text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.contract_verified_human(app.current_user_id()) IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'manual') IS NOT TRUE
 THEN RAISE EXCEPTION 'Manual Contract workflows are unavailable' USING ERRCODE='42501';END IF;
 IF p_expected IS NULL OR p_expected<1 OR p_workflow IS NULL OR p_workflow_revision IS NULL OR p_workflow_revision<1 OR p_request IS NULL
 THEN RAISE EXCEPTION 'Choose a current live manual workflow' USING ERRCODE='22023';END IF;
 v_actor_person:=app.contract_actor_person(app.current_user_id());
 PERFORM app.contract_shared_lock_source(p_case);
 SELECT * INTO v_flow FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case FOR UPDATE;
 SELECT * INTO v_case FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 IF v_flow.case_id IS NULL THEN RAISE EXCEPTION 'A shared Contract case is required' USING ERRCODE='22023';END IF;
 v_occurrence:='manual:'||p_request::text;
 v_versions:=jsonb_build_array(jsonb_build_object('workflowId',p_workflow,'revision',p_workflow_revision));
 SELECT * INTO v_existing FROM public.contract_shared_event WHERE tenant_id=v_flow.tenant_id AND case_id=p_case AND trigger_event='manual' AND occurrence=v_occurrence;
 IF v_existing.id IS NOT NULL THEN
  IF v_existing.actor_user_id IS DISTINCT FROM app.current_user_id() OR v_existing.actor_person_id IS DISTINCT FROM v_actor_person
  OR v_existing.workflow_versions IS DISTINCT FROM v_versions OR v_existing.data->>'requestRevision' IS DISTINCT FROM p_expected::text
  THEN RAISE EXCEPTION 'Manual workflow request reference was already used' USING ERRCODE='40001';END IF;
  RETURN jsonb_build_object('eventId',v_existing.id,'jobId',v_existing.job_id);
 END IF;
 IF v_flow.revision IS DISTINCT FROM p_expected OR v_flow.data->'period'->>'sourceRevision' IS DISTINCT FROM app.contract_shared_period_revision(v_case.employment_id)
 OR app.contract_case_company_current(v_case.id) IS NOT TRUE OR v_case.source_conflict IS NOT NULL OR coalesce((app.contract_source(v_case.employment_id)->>'ended')::boolean,false)
 OR v_flow.data->>'stage' IN('renewed','converted','offboarding','superseded')
 THEN RAISE EXCEPTION 'The Contract case or Personnel period changed; reload before starting' USING ERRCODE='40001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('automation-workflow:'||v_flow.tenant_id::text||':'||p_workflow::text,0));
 SELECT * INTO v_workflow FROM public.automation_workflow_version WHERE tenant_id=v_flow.tenant_id AND workflow_id=p_workflow ORDER BY revision DESC LIMIT 1;
 IF v_workflow.workflow_id IS NULL OR v_workflow.module<>'contract_staff' OR v_workflow.revision<>p_workflow_revision OR v_workflow.status<>'live' OR v_workflow.definition->'trigger'->>'event'<>'manual'
 THEN RAISE EXCEPTION 'This live manual workflow changed; reload its current version' USING ERRCODE='40001';END IF;
 IF app.contract_shared_native_intake_hold(v_case.employment_id) IS NOT NULL THEN RAISE EXCEPTION 'Complete the native Contract intake before starting a workflow' USING ERRCODE='40001';END IF;
 IF app.contract_shared_manual_conditions(p_case,v_workflow.definition) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow does not match the current case conditions' USING ERRCODE='22023';END IF;
 v_result:=app.contract_shared_enqueue_event(p_case,'manual',v_occurrence,jsonb_build_object('requestRevision',p_expected),v_versions);
 UPDATE public.contract_shared_case SET data=data||jsonb_build_object('revision',revision+1,'lastActivityAt',now()),revision=revision+1,updated_at=now() WHERE tenant_id=v_flow.tenant_id AND case_id=p_case;
 PERFORM app.contract_audit(p_case,'shared.manual_requested',jsonb_build_object('workflowId',p_workflow,'workflowRevision',p_workflow_revision,'requestId',p_request,'eventId',v_result->>'eventId'));
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_manual_start(uuid,integer,uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_manual_start(uuid,integer,uuid,integer,uuid) TO ai_hr_app;
