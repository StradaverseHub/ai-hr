-- Forward-only decision retry and verified identity repair. Earlier migration bytes and pins remain unchanged.
ALTER TABLE public.contract_shared_case_revision ADD COLUMN actor_person_id uuid REFERENCES public.person(id),ADD COLUMN actor_name text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_period_revision(p_employment uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(e.id,e.person_id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,a.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex')
 FROM public.employment e LEFT JOIN LATERAL(SELECT employment_type FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) a ON true
 WHERE e.tenant_id=app.current_tenant_id() AND e.id=p_employment
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_revision_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Contract revision must advance once' USING ERRCODE='40001';END IF;
 IF NEW.data->>'revision' IS DISTINCT FROM NEW.revision::text OR NEW.data->>'version' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'Contract flow revision mismatch' USING ERRCODE='22023';END IF;
 INSERT INTO public.contract_shared_case_revision(tenant_id,case_id,revision,data,actor_user_id,actor_person_id,actor_name) VALUES(NEW.tenant_id,NEW.case_id,NEW.revision,NEW.data,app.current_user_id(),app.contract_actor_person(app.current_user_id()),(SELECT p.full_name FROM public.person p WHERE p.tenant_id=NEW.tenant_id AND p.id=app.contract_actor_person(app.current_user_id())));
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(NEW.tenant_id,'contract-shared-case',NEW.case_id,'contract.shared.updated',CASE WHEN app.current_user_id() IS NULL THEN 'system'::public.actor_type ELSE 'user'::public.actor_type END,app.current_user_id(),jsonb_build_object('revision',NEW.revision,'stage',NEW.data->>'stage'));
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_decision_submit(p_case uuid,p_expected integer,p_decision jsonb,p_preview uuid) RETURNS jsonb
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
  IF existing.actor_user_id=app.current_user_id() AND existing.actor_person_id=app.contract_actor_person(app.current_user_id()) AND existing.data->>'baseRevision'=p_expected::text AND ((f.data->'decision')-ARRAY['submittedBy','submittedAt','revision'])=p_decision THEN RETURN jsonb_build_object('flow',f.data,'eventId',existing.id,'jobId',existing.job_id);END IF;
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
CREATE OR REPLACE FUNCTION app.contract_shared_history(p_case uuid,p_before integer DEFAULT 2147483647) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE THEN RAISE EXCEPTION 'Contract history unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT jsonb_build_object('revision',r.revision,'at',r.created_at,'actorId',r.actor_user_id,'actorPersonId',r.actor_person_id,'actorName',r.actor_name,'flow',r.data) FROM public.contract_shared_case_revision r
 WHERE r.tenant_id=app.current_tenant_id() AND r.case_id=p_case AND r.revision<p_before ORDER BY r.revision DESC LIMIT 50;
END $$;
--> statement-breakpoint
