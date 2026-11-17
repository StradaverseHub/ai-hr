-- Keep event records distinct from native employment aliases in the protected context adapter.
CREATE FUNCTION app.contract_shared_letter_binding_actor(p_letter uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.contract_shared_letter l
 JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 JOIN public.document_signing_document signing ON signing.tenant_id=l.tenant_id AND signing.id=l.signing_document_id
 WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter AND l.data->>'state'='routing' AND app.contract_shared_decision_current(l.case_id,l.decision_revision)
 AND (employment.person_id=app.contract_actor_person(app.current_user_id())
 OR app.document_signing_owner(signing.data)=app.current_user_id() AND app.document_signing_owner_step(signing.data)->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text
 OR app.contract_shared_case_permitted(c.id,'view') AND app.contract_shared_case_permitted(c.id,'manual')))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_binding_actor(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_bind_employee(p_letter uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;d public.document_signing_document;f public.contract_shared_case;employee_person uuid;account_id uuid;account_count integer;route jsonb;snapshot jsonb;fingerprint text;next_document jsonb;flags jsonb;
BEGIN
 IF app.contract_shared_letter_binding_actor(p_letter) IS NOT TRUE THEN RAISE EXCEPTION 'This employee sign-in cannot be checked from this account' USING ERRCODE='42501';END IF;
 PERFORM app.contract_shared_lock_source((SELECT case_id FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter));
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter FOR UPDATE;
 SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id FOR UPDATE;
 IF app.contract_shared_letter_binding_actor(p_letter) IS NOT TRUE THEN RAISE EXCEPTION 'Letter source changed' USING ERRCODE='40001';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') step WHERE step->>'role'='employee' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(d.data,step)) THEN RETURN;END IF;
 SELECT employment.person_id INTO employee_person FROM public.contract_case c JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id WHERE c.tenant_id=l.tenant_id AND c.id=l.case_id;
 SELECT count(*)::integer,min(account.id::text)::uuid INTO account_count,account_id FROM public.app_user account WHERE account.tenant_id=l.tenant_id AND account.person_id=employee_person AND app.contract_verified_human(account.id);
 IF account_count<>1 THEN RAISE EXCEPTION 'One verified active employee account is required; no email linking or substitute is allowed' USING ERRCODE='22023';END IF;
 snapshot:=app.contract_shared_letter_snapshot(l.id);fingerprint:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 IF d.data->>'contentHash' IS DISTINCT FROM fingerprint THEN
  IF app.document_signing_locked(d.data) THEN RAISE EXCEPTION 'Signed values changed' USING ERRCODE='40001';END IF;
  UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{values}',snapshot->'values'),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
  INSERT INTO public.contract_shared_letter_content(tenant_id,letter_id,content_revision,content_hash,snapshot) VALUES(l.tenant_id,l.id,(d.data->>'contentRevision')::integer,fingerprint,snapshot) ON CONFLICT DO NOTHING;
  next_document:=jsonb_set(d.data,'{contentHash}',to_jsonb(fingerprint));
  PERFORM app.document_signing_store(d.id,d.employment_id,d.company_id,d.subject_id,next_document,d.guardrails,d.revision,'live_refresh','Refreshed live fields before verified employee sign-in binding');
  SELECT * INTO d FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id;
 END IF;
 SELECT jsonb_set(d.data->'route','{steps}',jsonb_agg(CASE WHEN step->>'role'='employee' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(d.data,step) THEN step||jsonb_build_object('holderId',account_id,'holderPersonId',employee_person) ELSE step END ORDER BY n)) INTO route FROM jsonb_array_elements(d.data->'route'->'steps') WITH ORDINALITY x(step,n);
 UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{signingPolicy,route}',route),revision=revision+1,updated_at=now() WHERE tenant_id=l.tenant_id AND id=l.id;
 next_document:=jsonb_set(d.data,'{route}',route);
 PERFORM app.document_signing_store(d.id,d.employment_id,d.company_id,d.subject_id,next_document,d.guardrails,d.revision,'reroute','Bound the unique verified employee login to the existing employee steps');
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=l.tenant_id AND case_id=l.case_id FOR UPDATE;
 SELECT coalesce(jsonb_agg(flag),'[]'::jsonb) INTO flags FROM jsonb_array_elements(f.data->'flags') flag WHERE flag#>>'{}'<>'employee_cannot_sign';
 UPDATE public.contract_shared_case SET data=f.data||jsonb_build_object('revision',f.revision+1,'flags',flags,'lastActivityAt',now()),revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(next_document) step WHERE step->>'role'='employee' AND step->>'holderId'=account_id::text) THEN
  PERFORM app.contract_shared_enqueue_event(l.case_id,'letterActionNeeded','letter:'||l.id::text||':employee-login:'||account_id::text,jsonb_build_object('letterId',l.id,'decision',f.data->'decision','period',f.data->'period'));
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_bind_employee(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_letter_bind_employee(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_worker_context(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;f public.contract_shared_case;e public.contract_shared_event;s jsonb;participants jsonb;documents jsonb;
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;
 SELECT * INTO e FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND case_id=p_case AND id::text=current_setting('app.contract_event',true);
 IF c.id IS NULL OR f.case_id IS NULL OR e.id IS NULL OR app.contract_shared_worker_event_held(p_case,e.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Protected Contract event required' USING ERRCODE='42501';END IF;
 IF e.trigger_event='approvalRejected' THEN f.data:=jsonb_set(f.data,'{decision}',e.data->'decision');END IF;
 s:=app.contract_source(c.employment_id)-ARRAY['salaryCents','allowanceCents','allowanceComponentId','fixedAllowanceId','compensationId'];
 s:=s||jsonb_build_object('contractNumber',(SELECT period_employment.contract_number FROM public.employment period_employment WHERE period_employment.tenant_id=c.tenant_id AND period_employment.id=c.employment_id),'periodRevision',app.contract_shared_period_revision(c.employment_id),
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
-- USER is not PERSON: existing system Access authority may administer roles without an employment identity.
-- Contract role grants still require a verified person and tenant-wide scope. Business/signing gates stay unchanged.
CREATE OR REPLACE FUNCTION app.contract_shared_access_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.contract_active_user(app.current_user_id()) AND app.principal_snapshot_current() AND (
 app.access_capability_allowed('access.system_admin',NULL) OR app.access_capability_allowed('access.configure',NULL)
 OR app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.contract_access_member m JOIN public.contract_access_role r ON r.tenant_id=m.tenant_id AND r.id=m.role_id
 WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND m.revoked_at IS NULL AND m.company_id IS NULL AND m.business_group_id IS NULL
 AND 'access'=ANY(r.permissions) AND m.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (m.valid_to IS NULL OR m.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))),false)
$$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_signer_values(p_letter uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH letter AS MATERIALIZED(
 SELECT l.data,c.company_id,employment.person_id FROM public.contract_shared_letter l JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id
 JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter),
 steps AS MATERIALIZED(SELECT step FROM letter CROSS JOIN LATERAL jsonb_array_elements(letter.data->'signingPolicy'->'route'->'steps') step LIMIT 30),
 holders AS MATERIALIZED(
 SELECT step->>'id' AS step_id,coalesce(step->>'label','Authorised signatory') AS label,person.id AS person_id,person.full_name
 FROM steps CROSS JOIN letter LEFT JOIN public.app_user account ON account.tenant_id=app.current_tenant_id() AND account.id::text=step->>'holderId' AND account.person_id::text=step->>'holderPersonId'
 LEFT JOIN public.person person ON person.tenant_id=app.current_tenant_id() AND person.id=coalesce(account.person_id,CASE WHEN step->>'role'='employee' AND step->>'holderId' IS NULL THEN letter.person_id END)),
 titles AS MATERIALIZED(
 SELECT DISTINCT ON(employment.person_id) employment.person_id,left(position.title,200) AS title
 FROM public.employment employment JOIN public.assignment assignment ON assignment.tenant_id=employment.tenant_id AND assignment.employment_id=employment.id
 JOIN public.position position ON position.tenant_id=assignment.tenant_id AND position.id=assignment.position_id CROSS JOIN letter
 WHERE employment.tenant_id=app.current_tenant_id() AND employment.person_id IN(SELECT person_id FROM holders) AND employment.voided_at IS NULL AND employment.blacklisted_at IS NULL
 AND employment.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (least(employment.terminated_on,employment.resignation_date,employment.last_working_date) IS NULL OR least(employment.terminated_on,employment.resignation_date,employment.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND assignment.superseded_at IS NULL AND assignment.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (assignment.valid_to IS NULL OR assignment.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 ORDER BY employment.person_id,(employment.company_id=letter.company_id) DESC,employment.hired_on DESC,assignment.valid_from DESC,employment.id,assignment.id)
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM holders LEFT JOIN titles ON titles.person_id=holders.person_id
 CROSS JOIN LATERAL(VALUES('signingStep.'||holders.step_id||'.name',coalesce(holders.full_name,'')),('signingStep.'||holders.step_id||'.title',coalesce(titles.title,'')),('signingStep.'||holders.step_id||'.label',holders.label)) fields(key,value)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_signer_values(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

-- A changed Personnel identity never refreshes an earlier letter with another person's private values.
CREATE OR REPLACE FUNCTION app.contract_shared_letter_values(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f jsonb;s jsonb;amount text;values jsonb;signers jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.id IS NULL THEN RETURN NULL;END IF;
 IF l.data->'valuesFixed'='true'::jsonb OR app.contract_shared_decision_current(l.case_id,l.decision_revision) IS NOT TRUE THEN RETURN l.data->'values';END IF;
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
 RETURN values||signers||app.contract_shared_letter_signer_values(l.id);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_values(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

-- Only the native employee-binding command can change its private expected route.
CREATE OR REPLACE FUNCTION app.contract_shared_signing_access(p_type text,p_subject uuid,p_operation text) RETURNS boolean
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
 IF p_operation='live_refresh' THEN RETURN (assigned OR app.contract_shared_letter_binding_actor(p_subject)) AND NOT app.document_signing_locked(document);END IF;
 IF p_operation='reroute' THEN RETURN app.contract_shared_letter_binding_actor(p_subject);END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_signing_access(text,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
