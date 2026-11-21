-- Qualify local capability identifiers without changing the sealed job/event predicates.
CREATE OR REPLACE FUNCTION app.contract_shared_worker_event_held(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_job_id uuid;v_event_id uuid;e public.contract_shared_event;f public.contract_shared_case;c public.contract_case;
BEGIN
 IF app.contract_shared_storage_runner() IS NOT TRUE THEN RETURN false;END IF;
 BEGIN v_job_id:=nullif(current_setting('app.bulk_job',true),'')::uuid;v_event_id:=nullif(current_setting('app.contract_event',true),'')::uuid;EXCEPTION WHEN invalid_text_representation THEN RETURN false;END;
 IF v_job_id IS NULL OR v_event_id IS NULL OR app.bulk_job_capability_held(v_job_id) IS NOT TRUE THEN RETURN false;END IF;
 SELECT e1.* INTO e FROM public.contract_shared_event e1 JOIN public.bulk_job j ON j.tenant_id=e1.tenant_id AND j.id=e1.job_id
 WHERE e1.tenant_id=app.current_tenant_id() AND e1.id=v_event_id AND e1.job_id=v_job_id AND j.kind='contract_automation'
 AND coalesce(e1.root_event_id,e1.id)::text=j.input->>'eventId' AND e1.case_id=p_case AND e1.decision_revision=p_revision AND e1.processed_at IS NULL;
 IF e.id IS NULL THEN RETURN false;END IF;
 IF app.contract_shared_decision_current(p_case,p_revision) THEN RETURN true;END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=e.tenant_id AND case_id=p_case;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=e.tenant_id AND id=p_case;
 IF f.data->'period'->>'sourceRevision' IS DISTINCT FROM app.contract_shared_period_revision(c.employment_id) OR NOT app.contract_case_company_current(c.id) OR c.source_conflict IS NOT NULL OR coalesce((app.contract_source(c.employment_id)->>'ended')::boolean,false) THEN RETURN false;END IF;
 IF p_revision=0 THEN RETURN f.data->'decision'='null'::jsonb AND e.actor_person_id=app.contract_binding_person(e.actor_user_id);END IF;
 RETURN e.trigger_event='approvalRejected' AND EXISTS(SELECT 1 FROM jsonb_array_elements(f.data->'decisionHistory') d WHERE d=e.data->'decision')
 AND EXISTS(SELECT 1 FROM public.contract_shared_event original WHERE original.tenant_id=e.tenant_id AND original.case_id=e.case_id AND original.trigger_event='decisionSubmitted' AND original.decision_revision=e.decision_revision AND original.actor_person_id=app.contract_binding_person(original.actor_user_id));
END $$;
--> statement-breakpoint
