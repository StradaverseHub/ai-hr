-- Bound pure signing-helper evaluation to the exact current approval/document join.
-- The 1,000-case native profile showed the planner scanning all tenant documents once per period.
-- Only join materialization changes; tenant/company/identity/period/pending-step predicates are preserved.
-- Assigned work is an owner page, never an inferred decision task or a capped generic-provider array.
-- Candidate accounts/groups are resolved before native period validation; tracker reads are bounded to requested cases.
CREATE OR REPLACE FUNCTION app.contract_shared_pending_work_page_source(p_cases uuid[],p_assigned_only boolean) RETURNS TABLE(case_id uuid,employment_id uuid,company_id uuid,subject_id uuid,kind text,step_id text,label text,assigned_name text,eligible boolean,updated_at timestamptz,action_code text)
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
   JOIN public.contract_shared_letter l ON l.tenant_id=target.tenant_id AND l.signing_document_id=target.document_id WHERE p_assigned_only AND target.tenant_id=app.current_tenant_id() AND l.data->>'state'='routing'
  UNION SELECT a.case_id FROM public.contract_shared_approval a CROSS JOIN LATERAL jsonb_array_elements(a.data->'assignments') assignment
   JOIN actor_groups g ON g.id=assignment->>'groupId' WHERE p_assigned_only AND a.tenant_id=app.current_tenant_id() AND assignment->'layer'->>'pick'='any'
 ),
 periods AS MATERIALIZED(SELECT c.id AS case_id,c.employment_id,c.company_id,e.person_id,f.data,f.updated_at FROM candidate_cases candidate JOIN public.contract_shared_case f ON f.case_id=candidate.id AND f.tenant_id=app.current_tenant_id() JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
  JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id JOIN companies co ON co.id=c.company_id CROSS JOIN clock LEFT JOIN LATERAL(SELECT a.employment_type FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.valid_from DESC,a.id LIMIT 1) p ON true
  JOIN public.contract_shared_event event ON event.tenant_id=f.tenant_id AND event.case_id=f.case_id AND event.trigger_event='decisionSubmitted' AND event.decision_revision=(f.data->'decision'->>'revision')::integer
  JOIN public.app_user submitter ON submitter.tenant_id=event.tenant_id AND submitter.id=event.actor_user_id AND submitter.person_id=event.actor_person_id
  WHERE f.tenant_id=app.current_tenant_id() AND c.source_conflict IS NULL AND e.voided_at IS NULL AND e.blacklisted_at IS NULL
   AND (least(e.terminated_on,e.last_working_date,e.resignation_date) IS NULL OR least(e.terminated_on,e.last_working_date,e.resignation_date)>today)
   AND f.data->'period'->>'sourceRevision'=encode(sha256(convert_to(jsonb_build_array(e.id,e.person_id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,p.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex')),
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
  FROM periods f JOIN public.contract_shared_letter l ON l.tenant_id=app.current_tenant_id() AND l.case_id=f.case_id AND l.decision_revision=(f.data->'decision'->>'revision')::integer AND l.data->>'state'='routing'
  JOIN public.document_signing_document d ON d.tenant_id=l.tenant_id AND d.id=l.signing_document_id CROSS JOIN actor
  CROSS JOIN LATERAL(SELECT step AS s FROM app.document_signing_pending_steps(d.data) step WHERE NOT app.document_signing_returned(d.data)
   UNION ALL SELECT app.document_signing_owner_step(d.data) WHERE app.document_signing_returned(d.data)) pending
  LEFT JOIN public.app_user holder ON holder.tenant_id=l.tenant_id AND holder.id::text=s->>'holderId' AND holder.person_id::text=s->>'holderPersonId'
  LEFT JOIN public.person person ON person.tenant_id=holder.tenant_id AND person.id=holder.person_id)
 SELECT * FROM approval_steps UNION ALL SELECT * FROM letter_steps
$$;
REVOKE ALL ON FUNCTION app.contract_shared_pending_work_page_source(uuid[],boolean) FROM PUBLIC,ai_hr_app;
