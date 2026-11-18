-- Historical email prerequisites keep their exact pinned person/company/document authority after posting.
-- Ordinary outcome reads retain the complete 5919 current-period source and keyed join fences.
CREATE INDEX contract_email_pending_subject_idx ON public.contract_shared_letter(tenant_id,(data->>'subjectPersonId'),case_id)
 WHERE purpose='email' AND data->>'state'='routing';
--> statement-breakpoint
-- Fence indexed candidate case/flow/employment identity joins before event/company validation.
-- The cold native profile showed tenant event/employment/candidate fanout before their case-key match.
-- This only changes query shape; existing source, company, identity and pending-action predicates remain.
CREATE FUNCTION app.contract_shared_outcome_work_page_source(p_cases uuid[],p_assigned_only boolean) RETURNS TABLE(case_id uuid,employment_id uuid,company_id uuid,subject_id uuid,kind text,step_id text,label text,assigned_name text,eligible boolean,updated_at timestamptz,action_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 actor AS MATERIALIZED(SELECT u.id,u.person_id,app.contract_verified_human(u.id) AS verified FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()),
 companies AS MATERIALIZED(SELECT c.id FROM public.company c JOIN public.tenant t ON t.id=c.tenant_id WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND t.status IN('active','trial')
  AND EXISTS(SELECT 1 FROM public.tenant_module m WHERE m.tenant_id=c.tenant_id AND m.module_code='lifecycle' AND m.status IN('active','trial') AND (m.expires_at IS NULL OR m.expires_at>now()) AND (m.company_id IS NULL OR m.company_id=c.id))),
 groups AS MATERIALIZED(SELECT g->>'id' AS id,g->>'name' AS name,g->'members' AS members FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()),
 actor_groups AS MATERIALIZED(SELECT g.id FROM groups g CROSS JOIN actor WHERE actor.verified AND coalesce(g.members ? actor.id::text,false)),
 candidate_cases AS MATERIALIZED(
  SELECT c.id FROM public.contract_case c WHERE c.tenant_id=app.current_tenant_id() AND NOT p_assigned_only AND c.id=ANY(p_cases[1:100])
  UNION SELECT a.case_id FROM public.document_signing_assignment target JOIN actor ON target.user_id=actor.id AND target.person_id=actor.person_id AND actor.verified
   JOIN public.contract_shared_approval a ON a.tenant_id=target.tenant_id AND a.signing_document_id=target.document_id WHERE p_assigned_only AND target.tenant_id=app.current_tenant_id()
  UNION SELECT l.case_id FROM public.document_signing_assignment target JOIN actor ON target.user_id=actor.id AND target.person_id=actor.person_id AND actor.verified
   JOIN public.contract_shared_letter l ON l.tenant_id=target.tenant_id AND l.signing_document_id=target.document_id WHERE p_assigned_only AND target.tenant_id=app.current_tenant_id() AND l.data->>'state'='routing' AND l.purpose<>'email'
  UNION SELECT a.case_id FROM public.contract_shared_approval a CROSS JOIN LATERAL jsonb_array_elements(a.data->'assignments') assignment
   JOIN actor_groups g ON g.id=assignment->>'groupId' WHERE p_assigned_only AND a.tenant_id=app.current_tenant_id() AND assignment->'layer'->>'pick'='any'
 ),
 case_period_sources AS MATERIALIZED(
  SELECT c.id AS case_id,c.employment_id,c.company_id,e.person_id,f.data,f.updated_at,
   e.contract_start_date,e.contract_end_date,e.contract_number,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on
  FROM candidate_cases candidate JOIN public.contract_shared_case f ON f.case_id=candidate.id AND f.tenant_id=app.current_tenant_id()
  JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
  JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id
  WHERE c.source_conflict IS NULL AND e.voided_at IS NULL AND e.blacklisted_at IS NULL),
 periods AS MATERIALIZED(SELECT f.case_id,f.employment_id,f.company_id,f.person_id,f.data,f.updated_at
  FROM case_period_sources f JOIN companies co ON co.id=f.company_id CROSS JOIN clock
  LEFT JOIN LATERAL(SELECT a.employment_type FROM public.assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.employment_id=f.employment_id
   AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.valid_from DESC,a.id LIMIT 1) p ON true
  JOIN public.contract_shared_event event ON event.tenant_id=app.current_tenant_id() AND event.case_id=f.case_id AND event.trigger_event='decisionSubmitted' AND event.decision_revision=(f.data->'decision'->>'revision')::integer
  JOIN public.app_user submitter ON submitter.tenant_id=event.tenant_id AND submitter.id=event.actor_user_id AND submitter.person_id=event.actor_person_id
  WHERE (least(f.terminated_on,f.last_working_date,f.resignation_date) IS NULL OR least(f.terminated_on,f.last_working_date,f.resignation_date)>today)
   AND f.data->'period'->>'sourceRevision'=encode(sha256(convert_to(jsonb_build_array(f.employment_id,f.person_id,f.company_id,f.contract_start_date,f.contract_end_date,f.contract_number,p.employment_type,f.voided_at,f.blacklisted_at,f.resignation_date,f.last_working_date,f.terminated_on)::text,'UTF8')),'hex')),
 approval_documents AS MATERIALIZED(
  SELECT f.*,a.id AS approval_id,a.data AS approval_data,a.updated_at AS approval_updated_at,d.data AS signing_data
  FROM periods f JOIN public.contract_shared_approval a ON a.tenant_id=app.current_tenant_id() AND a.case_id=f.case_id AND a.decision_revision=(f.data->'decision'->>'revision')::integer
  JOIN public.document_signing_document d ON d.tenant_id=a.tenant_id AND d.id=a.signing_document_id),
 approval_steps AS(SELECT f.case_id,f.employment_id,f.company_id,f.approval_id AS subject_id,'approval'::text AS kind,s->>'id' AS step_id,s->>'label' AS label,
  coalesce(person.full_name,g.name,s->>'label','Assigned approver') AS assigned_name,
  actor.verified AND actor.person_id<>f.person_id AND CASE WHEN assignment->'layer'->>'pick'='any' AND nullif(assignment->>'groupId','') IS NOT NULL THEN coalesce(g.members ? actor.id::text,false)
   ELSE assignment->'candidatePersonIds'->>actor.id::text=actor.person_id::text AND (assignment->'layer'->>'pick'<>'roundRobin' OR assignment->>'selectedUserId'=actor.id::text) END AS eligible,f.approval_updated_at AS updated_at,'approval'::text AS action_code
  FROM approval_documents f
  CROSS JOIN LATERAL app.document_signing_pending_steps(f.signing_data) s CROSS JOIN actor
  JOIN LATERAL(SELECT x AS assignment FROM jsonb_array_elements(f.approval_data->'assignments') x WHERE x->'layer'->>'id'=s->>'id' LIMIT 1) ass ON true
  LEFT JOIN groups g ON g.id=assignment->>'groupId'
  LEFT JOIN public.app_user holder ON holder.tenant_id=app.current_tenant_id() AND holder.id::text=s->>'holderId' AND holder.person_id::text=s->>'holderPersonId'
  LEFT JOIN public.person person ON person.tenant_id=holder.tenant_id AND person.id=holder.person_id
  WHERE NOT app.document_signing_returned(f.signing_data)),
 letter_steps AS(SELECT f.case_id,f.employment_id,f.company_id,l.id AS subject_id,'letter'::text AS kind,s->>'id' AS step_id,s->>'label' AS label,coalesce(person.full_name,s->>'label','Linked account needed') AS assigned_name,
  actor.verified AND s->>'holderId'=actor.id::text AND s->>'holderPersonId'=actor.person_id::text AS eligible,l.updated_at,CASE WHEN app.document_signing_returned(d.data) THEN 'resend' ELSE s->>'kind' END AS action_code
  FROM periods f JOIN public.contract_shared_letter l ON l.tenant_id=app.current_tenant_id() AND l.case_id=f.case_id AND l.decision_revision=(f.data->'decision'->>'revision')::integer AND l.data->>'state'='routing' AND l.purpose<>'email'
  JOIN public.document_signing_document d ON d.tenant_id=l.tenant_id AND d.id=l.signing_document_id CROSS JOIN actor
  CROSS JOIN LATERAL(SELECT step AS s FROM app.document_signing_pending_steps(d.data) step WHERE NOT app.document_signing_returned(d.data)
   UNION ALL SELECT app.document_signing_owner_step(d.data) WHERE app.document_signing_returned(d.data)) pending
  LEFT JOIN public.app_user holder ON holder.tenant_id=l.tenant_id AND holder.id::text=s->>'holderId' AND holder.person_id::text=s->>'holderPersonId'
  LEFT JOIN public.person person ON person.tenant_id=holder.tenant_id AND person.id=holder.person_id)
 SELECT * FROM approval_steps UNION ALL SELECT * FROM letter_steps
$$;
REVOKE ALL ON FUNCTION app.contract_shared_outcome_work_page_source(uuid[],boolean) FROM PUBLIC,ai_hr_app;


--> statement-breakpoint
-- PL/pgSQL binds the separately approved 5947/5949 email identity helpers at execution after the full tail.
CREATE OR REPLACE FUNCTION app.contract_shared_pending_work_page_source(p_cases uuid[],p_assigned_only boolean) RETURNS TABLE(case_id uuid,employment_id uuid,company_id uuid,subject_id uuid,kind text,step_id text,label text,assigned_name text,eligible boolean,updated_at timestamptz,action_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN QUERY WITH actor AS MATERIALIZED(
  SELECT account.id,account.person_id,person.full_name,app.contract_verified_human(account.id) AS verified
  FROM public.app_user account JOIN public.person person ON person.tenant_id=account.tenant_id AND person.id=account.person_id
  WHERE account.tenant_id=app.current_tenant_id() AND account.id=app.current_user_id()),
 companies AS MATERIALIZED(SELECT company.id FROM public.company company JOIN public.tenant tenant ON tenant.id=company.tenant_id
  WHERE company.tenant_id=app.current_tenant_id() AND company.archived_at IS NULL AND tenant.status IN('active','trial')
  AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=company.tenant_id AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.expires_at IS NULL OR module.expires_at>now()) AND (module.company_id IS NULL OR module.company_id=company.id))),
 email_candidates AS MATERIALIZED(
  SELECT letter.id FROM public.document_signing_assignment target JOIN actor ON actor.verified AND target.user_id=actor.id AND target.person_id=actor.person_id
  JOIN public.contract_shared_letter letter ON letter.tenant_id=target.tenant_id AND letter.signing_document_id=target.document_id
  WHERE p_assigned_only AND target.tenant_id=app.current_tenant_id() AND letter.purpose='email' AND letter.data->>'state'='routing'
  UNION SELECT letter.id FROM actor JOIN public.contract_shared_letter letter ON letter.tenant_id=app.current_tenant_id() AND letter.data->>'subjectPersonId'=actor.person_id::text
  WHERE p_assigned_only AND actor.verified AND letter.purpose='email' AND letter.data->>'state'='routing'
  UNION SELECT letter.id FROM public.contract_shared_letter letter WHERE NOT p_assigned_only AND letter.tenant_id=app.current_tenant_id() AND letter.case_id=ANY(p_cases[1:100]) AND letter.purpose='email' AND letter.data->>'state'='routing'),
 email_documents AS MATERIALIZED(
  SELECT contract.id AS case_id,contract.employment_id,contract.company_id,letter.id AS letter_id,letter.updated_at,document.data AS signing_data
  FROM email_candidates candidate JOIN public.contract_shared_letter letter ON letter.tenant_id=app.current_tenant_id() AND letter.id=candidate.id
  JOIN public.contract_case contract ON contract.tenant_id=letter.tenant_id AND contract.id=letter.case_id
  JOIN public.employment employment ON employment.tenant_id=contract.tenant_id AND employment.id=contract.employment_id AND employment.company_id=contract.company_id AND employment.person_id::text=letter.data->>'subjectPersonId'
  JOIN companies ON companies.id=contract.company_id
  JOIN public.document_signing_document document ON document.tenant_id=letter.tenant_id AND document.id=letter.signing_document_id AND document.subject_type='contract' AND document.subject_id=letter.id AND document.employment_id=contract.employment_id AND document.company_id=contract.company_id
  JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=letter.tenant_id AND pin.workflow_run_id=letter.workflow_run_id AND pin.workflow_step_id=letter.workflow_step_id AND pin.case_id=letter.case_id AND pin.company_id=contract.company_id AND pin.subject_person_id=employment.person_id AND pin.documents @> jsonb_build_object(letter.data->>'templateId',letter.id::text)
  WHERE app.contract_shared_email_document_current(letter.id)),
 pending_email_steps AS MATERIALIZED(
  SELECT document.*,step.s,actor.id AS actor_id,actor.person_id AS actor_person_id,actor.full_name AS actor_name,actor.verified,
   CASE WHEN p_assigned_only AND step.s->>'kind'='sign' AND step.s->>'role'='employee' AND step.s->>'holderId' IS NULL THEN app.contract_shared_email_self_binding_available(document.letter_id) ELSE false END AS self_bind
  FROM email_documents document CROSS JOIN actor
  CROSS JOIN LATERAL(SELECT pending AS s FROM app.document_signing_pending_steps(document.signing_data) pending WHERE NOT app.document_signing_returned(document.signing_data)
   UNION ALL SELECT app.document_signing_owner_step(document.signing_data) WHERE app.document_signing_returned(document.signing_data)) step),
 email_steps AS(SELECT pending.case_id,pending.employment_id,pending.company_id,pending.letter_id AS subject_id,'letter'::text AS kind,pending.s->>'id' AS step_id,pending.s->>'label' AS label,
  CASE WHEN pending.self_bind THEN pending.actor_name ELSE coalesce(person.full_name,pending.s->>'label','Linked account needed') END AS assigned_name,
  pending.verified AND ((pending.s->>'holderId'=pending.actor_id::text AND pending.s->>'holderPersonId'=pending.actor_person_id::text) OR pending.self_bind) AS eligible,
  pending.updated_at,CASE WHEN app.document_signing_returned(pending.signing_data) THEN 'resend' WHEN pending.self_bind THEN 'bindEmployee' ELSE pending.s->>'kind' END AS action_code
  FROM pending_email_steps pending
  LEFT JOIN public.app_user holder ON holder.tenant_id=app.current_tenant_id() AND holder.id::text=pending.s->>'holderId' AND holder.person_id::text=pending.s->>'holderPersonId'
  LEFT JOIN public.person person ON person.tenant_id=holder.tenant_id AND person.id=holder.person_id)
 SELECT ordinary.* FROM app.contract_shared_outcome_work_page_source(p_cases,p_assigned_only) ordinary
 UNION ALL SELECT email.* FROM email_steps email;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_pending_work_page_source(uuid[],boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Explicit SQL NULL must not turn a bounded owner page into an unlimited query.
CREATE OR REPLACE FUNCTION app.contract_shared_work_page(p_category text DEFAULT 'all',p_companies uuid[] DEFAULT NULL,p_limit integer DEFAULT 20,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_category IS NULL OR p_limit IS NULL OR p_offset IS NULL OR p_category NOT IN('all','approvals','tasks') OR p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 100000 OR cardinality(p_companies)>500 THEN RAISE EXCEPTION 'Invalid Contract work page' USING ERRCODE='22023'; END IF;
 IF NOT app.contract_verified_human(app.current_user_id()) THEN RETURN jsonb_build_object('items','[]'::jsonb,'total',0,'countsByKind','{}'::jsonb,'approvalTotal',0,'taskTotal',0); END IF;
 WITH assigned AS MATERIALIZED(
  SELECT DISTINCT ON(w.kind,w.subject_id) w.*,p.full_name,CASE WHEN w.kind='letter' AND w.action_code IN('sign','bindEmployee') THEN 'tasks' ELSE 'approvals' END AS category
  FROM app.contract_shared_pending_work_page_source(NULL,true) w JOIN public.employment e ON e.tenant_id=app.current_tenant_id() AND e.id=w.employment_id JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id
  WHERE w.eligible AND (p_companies IS NULL OR w.company_id=ANY(p_companies)) ORDER BY w.kind,w.subject_id,w.step_id
 ), filtered AS MATERIALIZED(SELECT * FROM assigned WHERE p_category='all' OR category=p_category),
 page AS(SELECT subject_id::text AS id,CASE kind WHEN 'approval' THEN 'contractApproval' ELSE 'contractLetter' END AS kind,full_name AS "subjectName",updated_at AS "createdAt",action_code AS action,
  '/lifecycle/contracts/'||CASE kind WHEN 'approval' THEN 'approvals/' ELSE 'letters/' END||subject_id::text AS "linkPath"
  FROM filtered ORDER BY updated_at DESC,kind,subject_id LIMIT p_limit OFFSET p_offset),
 kinds AS(SELECT CASE kind WHEN 'approval' THEN 'contractApproval' ELSE 'contractLetter' END AS name,count(*) AS total FROM filtered GROUP BY kind)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "createdAt" DESC,kind,id) FROM page),'[]'::jsonb),'total',(SELECT count(*) FROM filtered),
  'countsByKind',coalesce((SELECT jsonb_object_agg(name,total) FROM kinds),'{}'::jsonb),'approvalTotal',(SELECT count(*) FROM assigned WHERE category='approvals'),'taskTotal',(SELECT count(*) FROM assigned WHERE category='tasks')) INTO result;
 RETURN result;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_actions(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE letter public.contract_shared_letter;signing public.document_signing_document;can_bind boolean;pending_role text;company_available boolean;self_actor boolean;
BEGIN
 IF app.document_signing_subject_access('contract',p_letter,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This letter is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO signing FROM public.document_signing_document WHERE tenant_id=letter.tenant_id AND id=letter.signing_document_id;
 SELECT app.contract_company_entitled(contract.company_id),employment.person_id=app.contract_actor_person(app.current_user_id()) INTO company_available,self_actor
 FROM public.contract_case contract JOIN public.employment employment ON employment.tenant_id=contract.tenant_id AND employment.id=contract.employment_id AND employment.company_id=contract.company_id
 WHERE contract.tenant_id=letter.tenant_id AND contract.id=letter.case_id;
 can_bind:=company_available AND app.contract_shared_letter_binding_actor(letter.id) AND EXISTS(SELECT 1 FROM jsonb_array_elements(signing.data->'route'->'steps') step WHERE step->>'role'='employee' AND step->>'kind'='sign' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(signing.data,step));
 IF letter.data->>'state'='routing' AND company_available AND (CASE WHEN letter.purpose='email' THEN app.contract_shared_email_document_current(letter.id) ELSE app.contract_shared_decision_current(letter.case_id,letter.decision_revision) END) AND NOT app.document_signing_returned(signing.data) THEN
  SELECT CASE WHEN step->>'role'='employee' THEN 'employee' ELSE 'company' END INTO pending_role FROM app.document_signing_pending_steps(signing.data) step
  WHERE step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text AND step->>'kind'='sign'
  ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
 END IF;
 RETURN jsonb_build_object('canBindEmployee',coalesce(can_bind,false),'canSelfBind',coalesce(can_bind AND self_actor,false),'companyActionsAvailable',coalesce(company_available,false),'pendingRole',pending_role);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_actions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_letter_actions(uuid) TO ai_hr_app;
