-- Private adapters for the existing automation and signing owners. No app caller can manufacture a run or effect.
-- Owner-generated events stay inside the causative kernel job. They carry no separate cursor or executor identity.
ALTER TABLE public.contract_shared_event ADD COLUMN root_event_id uuid;
ALTER TABLE public.contract_shared_event ADD CONSTRAINT contract_shared_event_root_fk FOREIGN KEY(tenant_id,root_event_id) REFERENCES public.contract_shared_event(tenant_id,id);
CREATE INDEX contract_shared_event_job_pending ON public.contract_shared_event(tenant_id,job_id,created_at,id) WHERE processed_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_decision_current(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
 JOIN public.contract_shared_event e ON e.tenant_id=f.tenant_id AND e.case_id=f.case_id AND e.trigger_event='decisionSubmitted' AND e.decision_revision=p_revision
 WHERE f.tenant_id=app.current_tenant_id() AND f.case_id=p_case AND (f.data->'decision'->>'revision')::integer=p_revision
 AND f.data->'period'->>'sourceRevision'=app.contract_shared_period_revision(c.employment_id)
 AND app.contract_case_company_current(c.id) AND c.source_conflict IS NULL AND NOT coalesce((app.contract_source(c.employment_id)->>'ended')::boolean,false)
 AND e.actor_person_id=app.contract_binding_person(e.actor_user_id))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_worker_event_held(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job_id uuid;event_id uuid;e public.contract_shared_event;f public.contract_shared_case;c public.contract_case;
BEGIN
 IF app.contract_shared_storage_runner() IS NOT TRUE THEN RETURN false;END IF;
 BEGIN job_id:=nullif(current_setting('app.bulk_job',true),'')::uuid;event_id:=nullif(current_setting('app.contract_event',true),'')::uuid;EXCEPTION WHEN invalid_text_representation THEN RETURN false;END;
 IF job_id IS NULL OR event_id IS NULL OR app.bulk_job_capability_held(job_id) IS NOT TRUE THEN RETURN false;END IF;
 SELECT e1.* INTO e FROM public.contract_shared_event e1 JOIN public.bulk_job j ON j.tenant_id=e1.tenant_id AND j.id=e1.job_id
 WHERE e1.tenant_id=app.current_tenant_id() AND e1.id=event_id AND e1.job_id=job_id AND j.kind='contract_automation'
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
CREATE OR REPLACE FUNCTION app.document_signing_returned(p_data jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_data->>'subjectType'='contract' AND p_data->'routing'->'liveMergeReviews'='true'::jsonb THEN
 coalesce((SELECT a->>'action'='returned' FROM jsonb_array_elements(p_data->'actions') WITH ORDINALITY x(a,n) WHERE a->>'action' IN('returned','resent') ORDER BY n DESC LIMIT 1),false)
 ELSE EXISTS(SELECT 1 FROM app.document_signing_round_actions(p_data) a WHERE a->>'action'='returned') END
$$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_lock_source(p_case uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 PERFORM 1 FROM public.employment e JOIN public.contract_case c ON c.tenant_id=e.tenant_id AND c.employment_id=e.id
 WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case FOR SHARE OF e;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_lock_source(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_approval_signing_content(p_approval uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app.contract_shared_lock_source((SELECT case_id FROM public.contract_shared_approval WHERE tenant_id=app.current_tenant_id() AND id=p_approval));
 SELECT jsonb_build_object('companyId',c.company_id,'employmentId',c.employment_id,'contentHash',a.data->>'contentHash','contentRevision',1,'routing',NULL) INTO result
 FROM public.contract_shared_approval a JOIN public.contract_case c ON c.tenant_id=a.tenant_id AND c.id=a.case_id WHERE a.tenant_id=app.current_tenant_id() AND a.id=p_approval;
 RETURN result;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_signing_content(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app.contract_shared_lock_source((SELECT case_id FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter));
 SELECT jsonb_build_object('companyId',c.company_id,'employmentId',c.employment_id,'contentHash',encode(sha256(convert_to(app.contract_shared_letter_snapshot(l.id)::text,'UTF8')),'hex'),
 'contentRevision',(l.data->>'contentRevision')::integer,'routing',l.data->'signingPolicy'->'routing') INTO result
 FROM public.contract_shared_letter l JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter;
 RETURN result;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_run_subject_access(p_module text,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_active_user() AND app.probation_case_access(p_subject)
 WHEN 'contract_staff' THEN app.contract_shared_case_permitted(p_subject,'view') ELSE false END,false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_can_run(p_module text,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND p_subject IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_storage_runner() OR app.automation_run_subject_access(p_module,p_subject)
 WHEN 'contract_staff' THEN EXISTS(SELECT 1 FROM public.contract_shared_event e WHERE e.tenant_id=app.current_tenant_id() AND e.case_id=p_subject AND e.id::text=current_setting('app.contract_event',true)
 AND app.contract_shared_worker_event_held(e.case_id,e.decision_revision)) ELSE false END,false)
$$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_effect_held(p_case uuid,p_run uuid,p_step text,p_type text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.automation_run r JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision
 JOIN public.contract_shared_case f ON f.tenant_id=r.tenant_id AND f.case_id=r.subject_id
 WHERE r.tenant_id=app.current_tenant_id() AND r.id=p_run AND r.module='contract_staff' AND r.subject_id=p_case AND r.status IN('running','waiting')
 AND app.contract_shared_worker_event_held(p_case,(f.data->'decision'->>'revision')::integer)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.definition->'steps') s WHERE s->>'id'=p_step AND s->>'type'=p_type))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_effect_held(uuid,uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_worker_context(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;f public.contract_shared_case;e public.contract_shared_event;s jsonb;participants jsonb;documents jsonb;
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;
 SELECT * INTO e FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND case_id=p_case AND id::text=current_setting('app.contract_event',true);
 IF c.id IS NULL OR f.case_id IS NULL OR e.id IS NULL OR app.contract_shared_worker_event_held(p_case,e.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Protected Contract event required' USING ERRCODE='42501';END IF;
 IF e.trigger_event='approvalRejected' THEN f.data:=jsonb_set(f.data,'{decision}',e.data->'decision');END IF;
 s:=app.contract_source(c.employment_id)-ARRAY['salaryCents','allowanceCents','allowanceComponentId','fixedAllowanceId','compensationId'];
 s:=s||jsonb_build_object('contractNumber',(SELECT e.contract_number FROM public.employment e WHERE e.tenant_id=c.tenant_id AND e.id=c.employment_id),'periodRevision',app.contract_shared_period_revision(c.employment_id),
 'businessUnitId',s->>'businessGroupId','jobTitle',s->>'designation');
 s:=s||coalesce((SELECT jsonb_build_object('businessGroupId',bg.id,'businessGroup',bg.legal_name) FROM public.company co JOIN public.company bg ON bg.tenant_id=co.tenant_id AND bg.id=coalesce(co.parent_company_id,co.id) WHERE co.tenant_id=c.tenant_id AND co.id=c.company_id),'{}'::jsonb);
 s:=s||coalesce((SELECT jsonb_build_object('departmentId',a.department_id) FROM public.assignment a WHERE a.tenant_id=c.tenant_id AND a.employment_id=c.employment_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1),'{}'::jsonb);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',p.full_name,'role',r.role) ORDER BY r.role,u.id),'[]'::jsonb) INTO participants
 FROM (SELECT app.contract_users_for_employment(c.employment_id) AS id,'employee' AS role UNION ALL SELECT app.contract_manager_users(c.employment_id),'directSuperior') r
 JOIN public.app_user u ON u.tenant_id=c.tenant_id AND u.id=r.id JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id;
 SELECT coalesce(jsonb_agg(d.data ORDER BY l.updated_at,l.id),'[]'::jsonb) INTO documents FROM public.contract_shared_letter l
 JOIN public.document_signing_document d ON d.tenant_id=l.tenant_id AND d.id=l.signing_document_id WHERE l.tenant_id=c.tenant_id AND l.case_id=c.id AND l.data->>'state'='routing';
 RETURN jsonb_build_object('view',jsonb_build_object('id',c.id,'caseNumber',c.number,'companyId',c.company_id,'employmentId',c.employment_id,'permissions','[]'::jsonb,
 'source',s,'sourceCurrent',true,'flow',f.data,'legacyState',c.data->>'state','sourceConflict',c.source_conflict,'cutoverAvailable',false),'participants',participants,'documents',documents);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_worker_context(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_prepare_approval(p_case uuid,p_run uuid,p_step text,p_assignments jsonb,p_route jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.contract_shared_approval;c public.contract_case;f public.contract_shared_case;expected_layers jsonb;actual_layers jsonb;fingerprint text;next_data jsonb;
BEGIN
 PERFORM app.contract_shared_lock_source(p_case);
 IF app.contract_shared_effect_held(p_case,p_run,p_step,'requestApproval') IS NOT TRUE THEN RAISE EXCEPTION 'Protected approval intent required' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM public.contract_shared_approval WHERE tenant_id=app.current_tenant_id() AND workflow_run_id=p_run AND workflow_step_id=p_step;
 IF a.id IS NOT NULL THEN RETURN jsonb_build_object('id',a.id,'signingDocumentId',a.signing_document_id,'contentHash',a.data->>'contentHash','existing',true);END IF;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=c.tenant_id AND case_id=c.id FOR UPDATE;
 SELECT s->'params'->'layers' INTO expected_layers FROM public.automation_run r JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision
 CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') s WHERE r.tenant_id=c.tenant_id AND r.id=p_run AND s->>'id'=p_step;
 IF jsonb_typeof(p_assignments) IS DISTINCT FROM 'array' OR jsonb_array_length(p_assignments) NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'Invalid approval layers' USING ERRCODE='22023';END IF;
 SELECT jsonb_agg(x->'layer' ORDER BY n) INTO actual_layers FROM jsonb_array_elements(p_assignments) WITH ORDINALITY a(x,n);
 IF actual_layers IS DISTINCT FROM expected_layers OR jsonb_array_length(p_route->'steps')<>jsonb_array_length(p_assignments) THEN RAISE EXCEPTION 'Approval layers differ from the accepted workflow' USING ERRCODE='22023';END IF;
 a.id:=gen_random_uuid();a.signing_document_id:=gen_random_uuid();
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('approvalId',a.id,'caseId',c.id,'decision',f.data->'decision','period',f.data->'period')::text,'UTF8')),'hex');
 INSERT INTO public.contract_shared_approval(tenant_id,id,case_id,decision_revision,workflow_run_id,workflow_step_id,signing_document_id,data)
 VALUES(c.tenant_id,a.id,c.id,(f.data->'decision'->>'revision')::integer,p_run,p_step,a.signing_document_id,jsonb_build_object('assignments',p_assignments,'decision',f.data->'decision','period',f.data->'period','contentHash',fingerprint,'signingPolicy',jsonb_build_object('route',p_route,'guardrails',jsonb_build_object('requiredRoles','[]'::jsonb))));
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'stage','approval','lastActivityAt',now());
 UPDATE public.contract_shared_case SET data=next_data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 RETURN jsonb_build_object('id',a.id,'signingDocumentId',a.signing_document_id,'contentHash',fingerprint,'existing',false);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_prepare_approval(uuid,uuid,text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_approval_read(p_approval uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.contract_shared_approval;d public.document_signing_document;c public.contract_case;s jsonb;pending jsonb;layers jsonb;history jsonb;
BEGIN
 IF app.document_signing_subject_access('contract-approval',p_approval,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This approval is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM public.contract_shared_approval WHERE tenant_id=app.current_tenant_id() AND id=p_approval;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=a.tenant_id AND id=a.signing_document_id;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=a.tenant_id AND id=a.case_id;
 s:=app.contract_source(c.employment_id);
 SELECT step INTO pending FROM app.document_signing_pending_steps(d.data) step ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',step->>'id','label',step->>'label','stage',(step->>'stage')::integer,
 'assigneeName',p.full_name,'fulfilled',app.document_signing_step_fulfilled(d.data,step)) ORDER BY n),'[]'::jsonb) INTO layers
 FROM jsonb_array_elements(d.data->'route'->'steps') WITH ORDINALITY x(step,n)
 LEFT JOIN public.app_user u ON u.tenant_id=a.tenant_id AND u.id::text=step->>'holderId' AND u.person_id::text=step->>'holderPersonId'
 LEFT JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','stepId',x->>'stepId','actorName',x->>'actorName','action',x->>'action','comment',x->>'comment','at',x->>'at') ORDER BY n),'[]'::jsonb) INTO history FROM jsonb_array_elements(d.data->'actions') WITH ORDINALITY actions(x,n);
 RETURN jsonb_build_object('id',a.id,'caseId',a.case_id,'decisionRevision',a.decision_revision,
 'employeeName',s->>'name','employeeCode',s->>'employeeId','company',s->>'company','decision',a.data->'decision','period',a.data->'period',
 'contentRevision',d.data->'contentRevision','contentHash',d.data->>'contentHash','pendingLayerId',pending->>'id','layers',layers,'history',history,
 'canAct',pending IS NOT NULL AND app.contract_shared_decision_current(a.case_id,a.decision_revision) AND app.contract_shared_approval_eligible(a.id,pending->>'id'),
 'status',CASE WHEN app.document_signing_returned(d.data) THEN 'rejected' WHEN NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(d.data)) THEN 'approved' WHEN NOT app.contract_shared_decision_current(a.case_id,a.decision_revision) THEN 'cancelled' ELSE 'pending' END);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_approval_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_approval_read(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Recognize an exact receipt before asking for a pending-layer claim, including a retry after final approval.
CREATE FUNCTION app.contract_shared_approval_action_prepare(p_approval uuid,p_step text,p_action_id text,p_action text,p_comment text,p_hash text,p_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.contract_shared_approval;d public.document_signing_document;receipt jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.document_signing_subject_access('contract-approval',p_approval,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This approval is unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.contract_shared_lock_source((SELECT case_id FROM public.contract_shared_approval WHERE tenant_id=app.current_tenant_id() AND id=p_approval));
 SELECT * INTO a FROM public.contract_shared_approval WHERE tenant_id=app.current_tenant_id() AND id=p_approval FOR UPDATE;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=a.tenant_id AND id=a.signing_document_id FOR UPDATE;
 SELECT x INTO receipt FROM jsonb_array_elements(d.data->'actions') x WHERE x->>'id'=p_action_id;
 IF receipt IS NOT NULL THEN
  IF receipt->>'actorId'=app.current_user_id()::text AND receipt->>'actorPersonId'=app.contract_actor_person(app.current_user_id())::text
  AND receipt->>'stepId'=p_step AND receipt->>'action'=p_action AND receipt->>'comment'=btrim(p_comment) AND receipt->>'contentHash'=p_hash AND receipt->>'contentRevision'=p_revision::text
  THEN RETURN jsonb_build_object('duplicate',true,'signingDocumentId',d.id);END IF;
  RAISE EXCEPTION 'Approval action reference was already used' USING ERRCODE='40001';
 END IF;
 IF p_action NOT IN('approved','returned') OR length(btrim(coalesce(p_comment,'')))>5000 OR p_action='returned' AND btrim(coalesce(p_comment,''))='' THEN RAISE EXCEPTION 'Enter a valid approval or rejection reason' USING ERRCODE='22023';END IF;
 IF d.data->>'contentHash' IS DISTINCT FROM p_hash OR d.data->>'contentRevision' IS DISTINCT FROM p_revision::text THEN RAISE EXCEPTION 'Approval content changed' USING ERRCODE='40001';END IF;
 PERFORM app.contract_shared_approval_claim(p_approval,p_step);
 RETURN jsonb_build_object('duplicate',false,'signingDocumentId',d.id);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_approval_action_prepare(uuid,text,text,text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_approval_action_prepare(uuid,text,text,text,text,text,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_signing_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.contract_shared_approval;l public.contract_shared_letter;f public.contract_shared_case;action jsonb;next_data jsonb;complete boolean;snapshot jsonb;flags jsonb;
BEGIN
 IF NEW.subject_type NOT IN('contract','contract-approval') OR jsonb_array_length(NEW.data->'actions')=jsonb_array_length(OLD.data->'actions') THEN RETURN NEW;END IF;
 IF NEW.subject_type='contract' THEN
  SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=NEW.tenant_id AND id=NEW.subject_id FOR UPDATE;
  SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=l.tenant_id AND case_id=l.case_id FOR UPDATE;
  IF l.id IS NULL OR app.contract_shared_decision_current(l.case_id,l.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Letter decision changed' USING ERRCODE='40001';END IF;
  action:=NEW.data->'actions'->-1;
  complete:=NOT app.document_signing_returned(NEW.data) AND NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(NEW.data));
  SELECT content.snapshot INTO snapshot FROM public.contract_shared_letter_content content WHERE content.tenant_id=l.tenant_id AND content.letter_id=l.id
   AND content.content_revision=(NEW.data->>'contentRevision')::integer AND content.content_hash=NEW.data->>'contentHash';
  IF snapshot IS NULL THEN RAISE EXCEPTION 'The action has no exact retained letter snapshot' USING ERRCODE='40001';END IF;
  UPDATE public.contract_shared_letter SET data=data||jsonb_build_object('values',snapshot->'values','valuesFixed',NOT app.document_signing_returned(NEW.data) AND (app.document_signing_locked(NEW.data) OR complete),
   'state',CASE WHEN complete THEN 'released' ELSE 'routing' END,'releasedAt',CASE WHEN complete THEN action->>'at' ELSE NULL END),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
  SELECT coalesce(jsonb_agg(flag),'[]'::jsonb) INTO flags FROM jsonb_array_elements(f.data->'flags') flag WHERE flag#>>'{}'<>'sent_back';
  IF app.document_signing_returned(NEW.data) THEN flags:=flags||'"sent_back"'::jsonb;END IF;
  next_data:=f.data||jsonb_build_object('revision',f.revision+1,'lastActivityAt',now(),'stage',CASE WHEN complete THEN 'workflow' ELSE 'document' END,'flags',flags);
  IF action->>'action'='returned' THEN
   PERFORM app.contract_shared_enqueue_event(l.case_id,'letterSentBack','letter:'||l.id::text||':action:'||(action->>'id'),jsonb_build_object('letterId',l.id,'decision',f.data->'decision','period',f.data->'period','sentBackBy',action->>'actorName','sentBackReason',action->>'comment'));
  ELSIF complete THEN
   PERFORM app.contract_shared_enqueue_event(l.case_id,'letterReleased','letter:'||l.id::text||':action:'||(action->>'id'),jsonb_build_object('letterId',l.id,'decision',f.data->'decision','period',f.data->'period'));
  ELSE
   PERFORM app.contract_shared_enqueue_event(l.case_id,'letterActionNeeded','letter:'||l.id::text||':action:'||(action->>'id'),jsonb_build_object('letterId',l.id,'decision',f.data->'decision','period',f.data->'period'));
  END IF;
  UPDATE public.contract_shared_case SET data=next_data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
  RETURN NEW;
 END IF;
 SELECT * INTO a FROM public.contract_shared_approval WHERE tenant_id=NEW.tenant_id AND id=NEW.subject_id;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=a.tenant_id AND case_id=a.case_id FOR UPDATE;
 IF a.id IS NULL OR app.contract_shared_decision_current(a.case_id,a.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Approval decision changed' USING ERRCODE='40001';END IF;
 action:=NEW.data->'actions'->-1;
 complete:=NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(NEW.data));
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'lastActivityAt',now(),'stage',CASE WHEN complete THEN 'workflow' ELSE 'approval' END);
 IF action->>'action'='returned' THEN
  PERFORM app.contract_shared_enqueue_event(a.case_id,'approvalRejected','approval:'||a.id::text,jsonb_build_object('approvalId',a.id,'decision',f.data->'decision','period',f.data->'period','reason',action->>'comment'));
  next_data:=next_data||jsonb_build_object('stage','open','decision',NULL,'decisionHistory',(f.data->'decisionHistory')||jsonb_build_array(f.data->'decision'),'flags','[]'::jsonb,'posting',NULL,'payConfirmation',NULL);
 ELSIF complete THEN
  PERFORM app.contract_shared_enqueue_event(a.case_id,'approvalsComplete','approval:'||a.id::text,jsonb_build_object('approvalId',a.id,'decision',f.data->'decision','period',f.data->'period'));
 END IF;
 UPDATE public.contract_shared_case SET data=next_data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_signing_progress() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_shared_signing_progress AFTER UPDATE OF data ON public.document_signing_document FOR EACH ROW EXECUTE FUNCTION app.contract_shared_signing_progress();
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_event_check(p_event uuid,p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.contract_shared_event e JOIN public.bulk_job j ON j.tenant_id=e.tenant_id AND j.id=e.job_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.id=p_event AND e.job_id=p_job AND j.kind='contract_automation' AND j.input->>'eventId'=e.id::text
 AND e.actor_user_id=app.current_user_id() AND e.actor_person_id=app.contract_actor_person(app.current_user_id()) AND j.created_by=e.actor_user_id AND e.processed_at IS NULL)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_event_check(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_event_check(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_event_finish(p_event uuid,p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.contract_shared_event;
BEGIN
 SELECT * INTO e FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event AND job_id=p_job FOR UPDATE;
 IF e.id IS NULL OR app.contract_shared_worker_event_held(e.case_id,e.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Protected Contract event required' USING ERRCODE='42501';END IF;
 UPDATE public.contract_shared_event SET processed_at=now() WHERE tenant_id=e.tenant_id AND id=e.id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_event_finish(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_execution_attention(p_event uuid,p_reason text,p_flag text DEFAULT 'template_stopped') RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.contract_shared_event;f public.contract_shared_case;next_data jsonb;
BEGIN
 SELECT * INTO e FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 IF e.id IS NULL OR e.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR app.contract_shared_worker_event_held(e.case_id,e.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Protected Contract event required' USING ERRCODE='42501';END IF;
 IF p_flag NOT IN('template_stopped','no_workflow') OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid workflow attention state' USING ERRCODE='22023';END IF;
 UPDATE public.contract_shared_event SET error=p_reason WHERE tenant_id=e.tenant_id AND id=e.id;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=e.tenant_id AND case_id=e.case_id FOR UPDATE;
 IF coalesce((f.data->'decision'->>'revision')::integer,0)<>e.decision_revision OR (f.data->'flags') ? p_flag THEN RETURN;END IF;
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'lastActivityAt',now(),'flags',(f.data->'flags')||to_jsonb(p_flag));
 UPDATE public.contract_shared_case SET data=next_data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_execution_attention(uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_enqueue_child_event(p_parent uuid,p_trigger text,p_occurrence text,p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent public.contract_shared_event;versions jsonb;event_id uuid;
BEGIN
 SELECT * INTO parent FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_parent;
 IF parent.id IS NULL OR parent.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR app.contract_shared_worker_event_held(parent.case_id,parent.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Protected causative event required' USING ERRCODE='42501';END IF;
 IF p_trigger NOT IN('letterActionNeeded','letterReleased') THEN RAISE EXCEPTION 'Invalid owner event' USING ERRCODE='22023';END IF;
 SELECT id INTO event_id FROM public.contract_shared_event WHERE tenant_id=parent.tenant_id AND case_id=parent.case_id AND trigger_event=p_trigger AND occurrence=p_occurrence;
 IF event_id IS NOT NULL THEN RETURN event_id;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('workflowId',workflow_id,'revision',revision) ORDER BY workflow_id),'[]'::jsonb) INTO versions FROM
 (SELECT DISTINCT ON(v.workflow_id) workflow_id,revision,status,definition FROM public.automation_workflow_version v WHERE tenant_id=parent.tenant_id AND module='contract_staff' ORDER BY workflow_id,revision DESC) latest
 WHERE status='live' AND definition->'trigger'->>'event'=p_trigger;
 INSERT INTO public.contract_shared_event(tenant_id,case_id,trigger_event,occurrence,decision_revision,actor_user_id,actor_person_id,workflow_versions,data,job_id,root_event_id)
 VALUES(parent.tenant_id,parent.case_id,p_trigger,p_occurrence,parent.decision_revision,parent.actor_user_id,parent.actor_person_id,versions,p_data,parent.job_id,coalesce(parent.root_event_id,parent.id)) RETURNING id INTO event_id;
 RETURN event_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_enqueue_child_event(uuid,text,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_prepare_letter(p_case uuid,p_run uuid,p_step text,p_template uuid,p_version integer,p_route jsonb,p_routing jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f public.contract_shared_case;c public.contract_case;definition jsonb;expected_template text;blocks jsonb;snapshot jsonb;fingerprint text;next_data jsonb;employee_person uuid;
BEGIN
 PERFORM app.contract_shared_lock_source(p_case);
 IF app.contract_shared_effect_held(p_case,p_run,p_step,'generateDocument') IS NOT TRUE THEN RAISE EXCEPTION 'Protected letter intent required' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case FOR UPDATE;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=f.tenant_id AND id=f.case_id;
 SELECT s->'params'->>'letterTemplateId' INTO expected_template FROM public.automation_run r JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision
 CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') s WHERE r.tenant_id=c.tenant_id AND r.id=p_run AND s->>'id'=p_step;
 IF expected_template IS DISTINCT FROM p_template::text OR f.data->'declined' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Letter purpose changed' USING ERRCODE='40001';END IF;
 SELECT v.definition INTO definition FROM public.automation_document_template h JOIN public.automation_document_template_version v ON v.tenant_id=h.tenant_id AND v.template_id=h.id AND v.version=h.live_version
 WHERE h.tenant_id=c.tenant_id AND h.id=p_template AND h.module='contract_staff' AND NOT h.retired AND h.live_version=p_version;
 IF definition IS NULL THEN RAISE EXCEPTION 'Published Contract template changed' USING ERRCODE='40001';END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=c.tenant_id AND case_id=c.id AND decision_revision=(f.data->'decision'->>'revision')::integer AND purpose='outcome';
 IF l.id IS NOT NULL THEN
  IF l.data->>'templateId'<>p_template::text THEN RAISE EXCEPTION 'This decision already has a different outcome letter' USING ERRCODE='40001';END IF;
  RETURN jsonb_build_object('id',l.id,'signingDocumentId',l.signing_document_id,'contentHash',(SELECT d.data->>'contentHash' FROM public.document_signing_document d WHERE d.tenant_id=l.tenant_id AND d.id=l.signing_document_id),'state',l.data->>'state','existing',true);
 END IF;
 IF p_routing->>'templateId' IS DISTINCT FROM p_template::text OR p_routing->>'templateVersion' IS DISTINCT FROM p_version::text OR p_routing->'liveMergeReviews' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Invalid pinned template routing' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(p_route->'steps')<>jsonb_array_length(definition->'routing') OR EXISTS(SELECT 1 FROM jsonb_array_elements(definition->'routing') s WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') t WHERE t->>'id'=s->>'id' AND t->>'kind'=s->>'action' AND t->'stage'=s->'order' AND coalesce(t->'owner','false')=coalesce(s->'owner','false'))) THEN RAISE EXCEPTION 'Letter route differs from its published template' USING ERRCODE='22023';END IF;
 SELECT e.person_id INTO employee_person FROM public.employment e WHERE e.tenant_id=c.tenant_id AND e.id=c.employment_id;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='employee' AND s->>'holderId' IS NOT NULL AND s->>'holderPersonId' IS DISTINCT FROM employee_person::text) THEN RAISE EXCEPTION 'An employee step cannot use a substitute signer' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_object_agg(b->>'id',CASE WHEN b->>'type'='table' THEN coalesce(b->>'rows','') ELSE coalesce(b->>'text','') END),'{}'::jsonb) INTO blocks FROM jsonb_array_elements(definition->'blocks') b WHERE b->>'type' IN('heading','subheading','text','table');
 l.id:=gen_random_uuid();l.signing_document_id:=gen_random_uuid();
 INSERT INTO public.contract_shared_letter(tenant_id,id,case_id,signing_document_id,decision_revision,workflow_run_id,workflow_step_id,purpose,data)
 VALUES(c.tenant_id,l.id,c.id,l.signing_document_id,(f.data->'decision'->>'revision')::integer,p_run,p_step,'outcome',jsonb_build_object('id',l.id,'templateId',p_template,'templateVersion',p_version,'generatedOn',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'state','routing','values','{}'::jsonb,'valuesFixed',false,'blocks',blocks,'definition',jsonb_build_object('name',definition->>'name','blocks',definition->'blocks','fields',definition->'fields'),'releasedAt',NULL,'contentRevision',1,
 'signingPolicy',jsonb_build_object('route',p_route,'routing',p_routing,'guardrails',jsonb_build_object('requiredRoles','[]'::jsonb))));
 snapshot:=app.contract_shared_letter_snapshot(l.id);fingerprint:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{values}',snapshot->'values') WHERE tenant_id=c.tenant_id AND id=l.id;
 INSERT INTO public.contract_shared_letter_content(tenant_id,letter_id,content_revision,content_hash,snapshot) VALUES(c.tenant_id,l.id,1,fingerprint,snapshot);
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'stage','document','lastActivityAt',now());
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='employee' AND s->>'kind'='sign' AND s->>'holderId' IS NULL) THEN next_data:=jsonb_set(next_data,'{flags}',(next_data->'flags')||'"employee_cannot_sign"'::jsonb);END IF;
 UPDATE public.contract_shared_case SET data=next_data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 RETURN jsonb_build_object('id',l.id,'signingDocumentId',l.signing_document_id,'contentHash',fingerprint,'state','routing','existing',false);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_prepare_letter(uuid,uuid,text,uuid,integer,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_action_prepare(p_letter uuid,p_step text,p_action_id text,p_action text,p_comment text,p_hash text,p_revision integer,p_signature jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;d public.document_signing_document;receipt jsonb;snapshot jsonb;fingerprint text;next_document jsonb;
BEGIN
 IF app.document_signing_subject_access('contract',p_letter,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This letter is unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.contract_shared_lock_source((SELECT case_id FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter));
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter FOR UPDATE;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id FOR UPDATE;
 SELECT x INTO receipt FROM jsonb_array_elements(d.data->'actions') x WHERE x->>'id'=p_action_id;
 IF receipt IS NOT NULL THEN
  IF receipt->>'actorId'=app.current_user_id()::text AND receipt->>'actorPersonId'=app.contract_actor_person(app.current_user_id())::text AND receipt->>'stepId'=p_step
  AND receipt->>'action'=p_action AND receipt->>'comment'=btrim(p_comment) AND receipt->>'contentHash'=p_hash AND receipt->>'contentRevision'=p_revision::text AND receipt->'signature'=p_signature
  THEN RETURN jsonb_build_object('duplicate',true,'signingDocumentId',d.id);END IF;
  RAISE EXCEPTION 'Letter action reference was already used' USING ERRCODE='40001';
 END IF;
 IF app.contract_shared_signing_access('contract',p_letter,'sign') IS NOT TRUE OR app.document_signing_content_visible(d.id,false) IS NOT TRUE THEN RAISE EXCEPTION 'Only the current letter actor may act' USING ERRCODE='42501';END IF;
 IF p_action NOT IN('signed','reviewed','approved','returned','resent') OR length(coalesce(p_action_id,'')) NOT BETWEEN 1 AND 200 OR length(coalesce(p_comment,''))>5000 THEN RAISE EXCEPTION 'Invalid letter action' USING ERRCODE='22023';END IF;
 IF l.data->>'contentRevision' IS DISTINCT FROM p_revision::text THEN RAISE EXCEPTION 'Letter wording changed' USING ERRCODE='40001';END IF;
 snapshot:=app.contract_shared_letter_snapshot(l.id);fingerprint:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 IF fingerprint IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'Live letter fields changed; review them before acting' USING ERRCODE='40001';END IF;
 UPDATE public.contract_shared_letter SET data=data||jsonb_build_object('values',snapshot->'values','valuesFixed',data->'valuesFixed'='true'::jsonb OR p_action='signed'),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
 INSERT INTO public.contract_shared_letter_content(tenant_id,letter_id,content_revision,content_hash,snapshot) VALUES(l.tenant_id,l.id,p_revision,fingerprint,snapshot) ON CONFLICT DO NOTHING;
 IF d.data->>'contentHash' IS DISTINCT FROM fingerprint THEN
  next_document:=jsonb_set(d.data,'{contentHash}',to_jsonb(fingerprint));
  PERFORM app.document_signing_store(d.id,d.employment_id,d.company_id,d.subject_id,next_document,d.guardrails,d.revision,'live_refresh','Refreshed live Contract fields before action');
 END IF;
 RETURN jsonb_build_object('duplicate',false,'signingDocumentId',d.id);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_action_prepare(uuid,text,text,text,text,text,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_letter_action_prepare(uuid,text,text,text,text,text,integer,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_edit(p_letter uuid,p_expected integer,p_hash text,p_patch jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;d public.document_signing_document;blocks jsonb;snapshot jsonb;fingerprint text;next_document jsonb;
BEGIN
 IF app.document_signing_subject_access('contract',p_letter,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This letter is unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.contract_shared_lock_source((SELECT case_id FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter));
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter FOR UPDATE;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id FOR UPDATE;
 IF app.contract_shared_signing_access('contract',p_letter,'revise') IS NOT TRUE THEN RAISE EXCEPTION 'Only the owner or current reviewer may edit before signing' USING ERRCODE='42501';END IF;
 IF l.data->>'contentRevision' IS DISTINCT FROM p_expected::text OR encode(sha256(convert_to(app.contract_shared_letter_snapshot(l.id)::text,'UTF8')),'hex') IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'Letter content changed' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR octet_length(p_patch::text)>1048576 THEN RAISE EXCEPTION 'Invalid case letter edits' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_patch) x WHERE NOT (l.data->'blocks') ? x.key OR jsonb_typeof(x.value)<>'string') THEN RAISE EXCEPTION 'Only existing wording blocks may be edited' USING ERRCODE='22023';END IF;
 blocks:=(l.data->'blocks')||p_patch;
 IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(blocks) x WHERE btrim(x.value)<>'') THEN RAISE EXCEPTION 'The letter cannot be empty' USING ERRCODE='22023';END IF;
 IF blocks=l.data->'blocks' THEN RETURN;END IF;
 UPDATE public.contract_shared_letter SET data=data||jsonb_build_object('blocks',blocks,'contentRevision',p_expected+1),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
 snapshot:=app.contract_shared_letter_snapshot(l.id);fingerprint:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 INSERT INTO public.contract_shared_letter_content(tenant_id,letter_id,content_revision,content_hash,snapshot) VALUES(l.tenant_id,l.id,p_expected+1,fingerprint,snapshot);
 next_document:=d.data||jsonb_build_object('contentRevision',p_expected+1,'contentHash',fingerprint);
 PERFORM app.document_signing_store(d.id,d.employment_id,d.company_id,d.subject_id,next_document,d.guardrails,d.revision,'revise','Edited case wording; retained the published template');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_edit(uuid,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_letter_edit(uuid,integer,text,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_read(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;d public.document_signing_document;visible boolean;is_current boolean;snapshot jsonb;fingerprint text;layers jsonb;history jsonb;receipts jsonb;pending jsonb;
BEGIN
 IF app.document_signing_subject_access('contract',p_letter,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This letter is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id;
 visible:=app.document_signing_content_visible(d.id,l.data->>'state'='released');
 is_current:=app.contract_shared_decision_current(l.case_id,l.decision_revision);
 SELECT step INTO pending FROM app.document_signing_pending_steps(d.data) step WHERE step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',step->>'id','label',step->>'label','stage',(step->>'stage')::integer,'kind',step->>'kind','owner',coalesce(step->'owner','false'),
 'assigneeName',p.full_name,'unavailable',step->>'holderId' IS NULL OR NOT app.contract_verified_human(u.id),'fulfilled',app.document_signing_step_fulfilled(d.data,step)) ORDER BY n),'[]'::jsonb) INTO layers
 FROM jsonb_array_elements(d.data->'route'->'steps') WITH ORDINALITY x(step,n)
 LEFT JOIN public.app_user u ON u.tenant_id=l.tenant_id AND u.id::text=step->>'holderId' AND u.person_id::text=step->>'holderPersonId'
 LEFT JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','stepId',x->>'stepId','actorName',x->>'actorName','action',x->>'action','comment',x->>'comment','at',x->>'at','revision',x->'contentRevision','hash',x->>'contentHash') ORDER BY n),'[]'::jsonb) INTO history FROM jsonb_array_elements(d.data->'actions') WITH ORDINALITY actions(x,n);
 IF visible THEN
  snapshot:=app.contract_shared_letter_snapshot(l.id);fingerprint:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
  SELECT coalesce(jsonb_agg(jsonb_build_object('stepId',x->>'stepId','role',x->>'role','actorId',x->>'actorId','actorName',x->>'actorName','at',x->>'at','signature',x->'signature') ORDER BY n),'[]'::jsonb) INTO receipts
  FROM app.document_signing_round_actions(d.data) WITH ORDINALITY actions(x,n) WHERE x->>'action'='signed' AND NOT app.document_signing_returned(d.data) AND x->>'contentHash'=fingerprint;
 END IF;
 RETURN jsonb_build_object('id',l.id,'caseId',l.case_id,'decisionRevision',l.decision_revision,'templateId',l.data->>'templateId','templateVersion',l.data->'templateVersion','name',l.data->'definition'->>'name',
 'generatedOn',l.data->>'generatedOn','state',l.data->>'state','valuesFixed',l.data->'valuesFixed','releasedAt',l.data->>'releasedAt','contentRevision',l.data->'contentRevision','contentHash',fingerprint,
 'layers',layers,'history',history,'returned',app.document_signing_returned(d.data),
 'canEdit',visible AND is_current AND l.data->>'state'='routing' AND app.document_signing_can_edit(d.data,app.current_user_id()),
 'canResend',visible AND is_current AND l.data->>'state'='routing' AND app.document_signing_returned(d.data) AND app.document_signing_owner(d.data)=app.current_user_id(),
 'pendingAction',CASE WHEN visible AND is_current AND l.data->>'state'='routing' AND pending IS NOT NULL AND NOT app.document_signing_returned(d.data) THEN jsonb_build_object('stepId',pending->>'id','kind',pending->>'kind') ELSE NULL END,
 'body',CASE WHEN visible THEN jsonb_build_object('definition',snapshot->'definition','blocks',snapshot->'blocks','values',snapshot->'values','receipts',receipts,'fingerprintSource',snapshot::text) ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_letter_read(uuid) TO ai_hr_app;
--> statement-breakpoint

-- Builder dry runs read the canonical signing owner, never a copied Contract route.
CREATE OR REPLACE FUNCTION app.contract_shared_preview_references(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.automation_can_manage('contract_staff','workflows') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE THEN RAISE EXCEPTION 'Contract preview is unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object(
  'participants',app.contract_shared_participants(p_case),
  'templates',app.automation_template_choices('contract_staff'),
  'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g->>'id','name',g->>'name','members',coalesce(g->'members','[]'::jsonb))) FROM
   (SELECT g FROM public.lc_v9_config c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'groups','[]'::jsonb)) g WHERE c.tenant_id=app.current_tenant_id() LIMIT 200) groups),'[]'::jsonb),
  'people',coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id,'personId',u.person_id,'name',p.full_name)) FROM
   (SELECT id,person_id FROM public.app_user WHERE tenant_id=app.current_tenant_id() AND app.contract_verified_human(id) ORDER BY id LIMIT 2000) u
   JOIN public.person p ON p.id=u.person_id AND p.tenant_id=app.current_tenant_id()),'[]'::jsonb),
  'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.routing_id,'name',r.name,'rows',r.routing_rows)) FROM
   (SELECT DISTINCT ON(v.routing_id) v.routing_id,v.name,v.routing_rows,v.retired FROM public.automation_routing_version v WHERE v.tenant_id=app.current_tenant_id() ORDER BY v.routing_id,v.revision DESC LIMIT 500) r WHERE NOT r.retired),'[]'::jsonb),
  'fallbackGroupId',coalesce((SELECT fallback_group_id FROM public.contract_shared_settings s JOIN public.contract_case c ON c.tenant_id=s.tenant_id AND c.company_id=s.company_id WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case),(SELECT data->>'peopleOpsGroup' FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id())),
  'postingApproverGroupId',coalesce((SELECT posting_group_id FROM public.contract_shared_settings s JOIN public.contract_case c ON c.tenant_id=s.tenant_id AND c.company_id=s.company_id WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case),(SELECT data->>'peopleOpsGroup' FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id())),
  'documents',coalesce((SELECT jsonb_agg(jsonb_set(d.document,'{actions}',coalesce((SELECT jsonb_agg(a||jsonb_build_object('signature',NULL)) FROM jsonb_array_elements(d.document->'actions') a),'[]'::jsonb))) FROM
   (SELECT signing.data AS document FROM public.contract_shared_letter letter JOIN public.document_signing_document signing ON signing.tenant_id=letter.tenant_id AND signing.id=letter.signing_document_id WHERE letter.tenant_id=app.current_tenant_id() AND letter.case_id=p_case AND letter.data->>'state'='routing' ORDER BY letter.updated_at DESC,letter.id LIMIT 50) d),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END $$;

--> statement-breakpoint
