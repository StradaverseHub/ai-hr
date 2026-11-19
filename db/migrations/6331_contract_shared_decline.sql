-- HR records what the employee told them; no employee signature or signed evidence is rewritten.
CREATE FUNCTION app.contract_shared_record_decline(p_case uuid,p_revision integer,p_reason text,p_notes text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;l public.contract_shared_letter;d public.document_signing_document;result jsonb;next_data jsonb;
BEGIN
 PERFORM app.contract_shared_lock_source(p_case);
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'decline') IS NOT TRUE THEN RAISE EXCEPTION 'Contract decline permission required' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;
 IF f.case_id IS NULL THEN RAISE EXCEPTION 'Contract case unavailable' USING ERRCODE='42501';END IF;
 IF f.data->'declined' IS DISTINCT FROM 'null'::jsonb THEN
  IF f.data->'declined'->>'by'=app.current_user_id()::text AND f.data->'declined'->>'reason'=btrim(p_reason) AND f.data->'declined'->>'notes'=btrim(p_notes)
   AND f.data->'declined'->>'baseRevision'=p_revision::text AND f.data->'declined'->>'personId'=app.contract_actor_person(app.current_user_id())::text THEN
   SELECT jsonb_build_object('eventId',e.id,'jobId',e.job_id) INTO result FROM public.contract_shared_event e WHERE e.tenant_id=f.tenant_id AND e.case_id=f.case_id AND e.trigger_event='employeeDeclined' AND e.occurrence='decline:'||(f.data->'decision'->>'revision');
   RETURN result||jsonb_build_object('flow',f.data);
  END IF;
  RAISE EXCEPTION 'The renewal already has a recorded decline' USING ERRCODE='40001';
 END IF;
 IF f.revision<>p_revision OR f.data->>'stage'<>'document' OR f.data->'decision'->>'kind'<>'renew' OR app.contract_shared_decision_current(p_case,(f.data->'decision'->>'revision')::integer) IS NOT TRUE THEN RAISE EXCEPTION 'The renewal changed' USING ERRCODE='40001';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('termination-reason-catalogue:'||f.tenant_id::text,0));
 IF length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 200 OR length(coalesce(p_notes,''))>5000 OR app.contract_shared_end_reason_offered(p_reason) IS NOT TRUE THEN RAISE EXCEPTION 'Choose an available decline reason' USING ERRCODE='22023';END IF;
 SELECT letter.* INTO l FROM public.contract_shared_letter letter JOIN public.document_signing_document document ON document.tenant_id=letter.tenant_id AND document.id=letter.signing_document_id
 WHERE letter.tenant_id=f.tenant_id AND letter.case_id=p_case AND letter.decision_revision=(f.data->'decision'->>'revision')::integer AND letter.purpose='outcome' AND letter.data->>'state'='routing'
 AND NOT app.document_signing_returned(document.data) AND EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document.data) step WHERE step->>'role'='employee' AND step->>'kind'='sign')
 ORDER BY letter.updated_at,letter.id LIMIT 1;
 IF l.id IS NULL THEN RAISE EXCEPTION 'The employee signature is no longer pending' USING ERRCODE='40001';END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=l.tenant_id AND id=l.id FOR UPDATE;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id FOR UPDATE;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=l.tenant_id AND case_id=p_case FOR UPDATE;
 -- Serializes against the real signing action; recheck after acquiring its row lock.
 IF f.revision<>p_revision OR l.data->>'state'<>'routing' OR app.document_signing_returned(d.data) OR NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(d.data) step WHERE step->>'role'='employee' AND step->>'kind'='sign') THEN RAISE EXCEPTION 'The employee signature changed' USING ERRCODE='40001';END IF;
 UPDATE public.contract_shared_letter SET data=data||jsonb_build_object('state','declined'),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
 UPDATE public.automation_run SET status='failed',waiting_for=NULL,remaining_steps='[]'::jsonb,failure='The employee declined the renewal.',
 log=log||jsonb_build_array(jsonb_build_object('at',now(),'kind','failed','step',NULL,'stepId',NULL,'type',NULL,'message','HR recorded the employee decline. The remaining renewal steps stopped.')),updated_at=now()
 WHERE tenant_id=f.tenant_id AND subject_id=p_case AND module='contract_staff' AND status='waiting' AND waiting_for=l.id;
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'stage','workflow','lastActivityAt',now(),'declined',jsonb_build_object('reason',btrim(p_reason),'notes',btrim(p_notes),'by',app.current_user_id(),'personId',app.contract_actor_person(app.current_user_id()),'at',now(),'baseRevision',p_revision,'letterId',l.id));
 UPDATE public.contract_shared_case SET data=next_data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 result:=app.contract_shared_enqueue_event(p_case,'employeeDeclined','decline:'||(f.data->'decision'->>'revision'),jsonb_build_object('letterId',l.id,'decision',f.data->'decision','period',f.data->'period','declined',next_data->'declined'));
 RETURN result||jsonb_build_object('flow',next_data);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_record_decline(uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_record_decline(uuid,integer,text,text) TO ai_hr_app;
--> statement-breakpoint
