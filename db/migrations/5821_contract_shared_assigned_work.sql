-- Shared task metadata comes from the current signing/approval owner. Pure JSON signing functions are reused;
-- company entitlement, source periods, actor person and group membership resolve once as sets, never per subject.
CREATE FUNCTION app.contract_shared_pending_work() RETURNS TABLE(case_id uuid,employment_id uuid,company_id uuid,subject_id uuid,kind text,step_id text,label text,assigned_name text,eligible boolean,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 actor AS MATERIALIZED(SELECT u.id,u.person_id,app.contract_verified_human(u.id) AS verified FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()),
 companies AS MATERIALIZED(SELECT c.id FROM public.company c JOIN public.tenant t ON t.id=c.tenant_id WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND t.status IN('active','trial')
  AND EXISTS(SELECT 1 FROM public.tenant_module m WHERE m.tenant_id=c.tenant_id AND m.module_code='lifecycle' AND m.status IN('active','trial') AND (m.expires_at IS NULL OR m.expires_at>now()) AND (m.company_id IS NULL OR m.company_id=c.id))),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.employment_id,a.employment_type FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 groups AS MATERIALIZED(SELECT g->>'id' AS id,g->>'name' AS name,g->'members' AS members FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()),
 periods AS MATERIALIZED(SELECT c.id AS case_id,c.employment_id,c.company_id,e.person_id,f.data,f.updated_at FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
  JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id JOIN companies co ON co.id=c.company_id LEFT JOIN placement p ON p.employment_id=e.id CROSS JOIN clock
  JOIN public.contract_shared_event event ON event.tenant_id=f.tenant_id AND event.case_id=f.case_id AND event.trigger_event='decisionSubmitted' AND event.decision_revision=(f.data->'decision'->>'revision')::integer
  JOIN public.app_user submitter ON submitter.tenant_id=event.tenant_id AND submitter.id=event.actor_user_id AND submitter.person_id=event.actor_person_id
  WHERE f.tenant_id=app.current_tenant_id() AND c.source_conflict IS NULL AND e.voided_at IS NULL AND e.blacklisted_at IS NULL
   AND (least(e.terminated_on,e.last_working_date,e.resignation_date) IS NULL OR least(e.terminated_on,e.last_working_date,e.resignation_date)>today)
   AND f.data->'period'->>'sourceRevision'=encode(sha256(convert_to(jsonb_build_array(e.id,e.person_id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,p.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex')),
 approval_steps AS(SELECT f.case_id,f.employment_id,f.company_id,a.id AS subject_id,'approval'::text AS kind,s->>'id' AS step_id,s->>'label' AS label,
  coalesce(person.full_name,g.name,s->>'label','Assigned approver') AS assigned_name,
  actor.verified AND actor.person_id<>f.person_id AND CASE WHEN assignment->'layer'->>'pick'='any' AND nullif(assignment->>'groupId','') IS NOT NULL THEN coalesce(g.members ? actor.id::text,false)
   ELSE assignment->'candidatePersonIds'->>actor.id::text=actor.person_id::text AND (assignment->'layer'->>'pick'<>'roundRobin' OR assignment->>'selectedUserId'=actor.id::text) END AS eligible,a.updated_at
  FROM periods f JOIN public.contract_shared_approval a ON a.tenant_id=app.current_tenant_id() AND a.case_id=f.case_id AND a.decision_revision=(f.data->'decision'->>'revision')::integer
  JOIN public.document_signing_document d ON d.tenant_id=a.tenant_id AND d.id=a.signing_document_id
  CROSS JOIN LATERAL app.document_signing_pending_steps(d.data) s CROSS JOIN actor
  JOIN LATERAL(SELECT x AS assignment FROM jsonb_array_elements(a.data->'assignments') x WHERE x->'layer'->>'id'=s->>'id' LIMIT 1) ass ON true
  LEFT JOIN groups g ON g.id=assignment->>'groupId'
  LEFT JOIN public.app_user holder ON holder.tenant_id=a.tenant_id AND holder.id::text=s->>'holderId' AND holder.person_id::text=s->>'holderPersonId'
  LEFT JOIN public.person person ON person.tenant_id=holder.tenant_id AND person.id=holder.person_id
  WHERE NOT app.document_signing_returned(d.data)),
 letter_steps AS(SELECT f.case_id,f.employment_id,f.company_id,l.id AS subject_id,'letter'::text AS kind,s->>'id' AS step_id,s->>'label' AS label,coalesce(person.full_name,s->>'label','Linked account needed') AS assigned_name,
  actor.verified AND s->>'holderId'=actor.id::text AND s->>'holderPersonId'=actor.person_id::text AS eligible,l.updated_at
  FROM periods f JOIN public.contract_shared_letter l ON l.tenant_id=app.current_tenant_id() AND l.case_id=f.case_id AND l.decision_revision=(f.data->'decision'->>'revision')::integer AND l.data->>'state'='routing'
  JOIN public.document_signing_document d ON d.tenant_id=l.tenant_id AND d.id=l.signing_document_id CROSS JOIN actor
  CROSS JOIN LATERAL(SELECT step AS s FROM app.document_signing_pending_steps(d.data) step WHERE NOT app.document_signing_returned(d.data)
   UNION ALL SELECT app.document_signing_owner_step(d.data) WHERE app.document_signing_returned(d.data)) pending
  LEFT JOIN public.app_user holder ON holder.tenant_id=l.tenant_id AND holder.id::text=s->>'holderId' AND holder.person_id::text=s->>'holderPersonId'
  LEFT JOIN public.person person ON person.tenant_id=holder.tenant_id AND person.id=holder.person_id)
 SELECT * FROM approval_steps UNION ALL SELECT * FROM letter_steps
$$;
REVOKE ALL ON FUNCTION app.contract_shared_pending_work() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_task_metadata(p_companies uuid[] DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.employment_id,a.employment_type FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 assigned AS MATERIALIZED(SELECT DISTINCT ON(w.kind,w.subject_id) w.*,p.full_name FROM app.contract_shared_pending_work() w JOIN public.employment e ON e.tenant_id=app.current_tenant_id() AND e.id=w.employment_id JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id
  WHERE w.eligible AND (p_companies IS NULL OR w.company_id=ANY(p_companies)) ORDER BY w.kind,w.subject_id,w.step_id),
 decisions AS MATERIALIZED(SELECT c.id AS subject_id,p.full_name,f.updated_at FROM app.contract_shared_tracker_subjects() rights JOIN public.contract_case c ON c.tenant_id=app.current_tenant_id() AND c.employment_id=rights.employment_id
  JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id LEFT JOIN placement assignment ON assignment.employment_id=e.id
  WHERE rights.can_view AND rights.can_decide AND f.data->>'stage'='open' AND f.data->'decision'='null'::jsonb AND f.data->'period'->>'startOn'=e.contract_start_date::text AND f.data->'period'->>'endOn'=e.contract_end_date::text AND f.data->'period'->>'number'=e.contract_number::text
  AND e.voided_at IS NULL AND e.blacklisted_at IS NULL AND (least(e.terminated_on,e.last_working_date,e.resignation_date) IS NULL OR least(e.terminated_on,e.last_working_date,e.resignation_date)>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND c.source_conflict IS NULL AND f.data->'period'->>'sourceRevision'=encode(sha256(convert_to(jsonb_build_array(e.id,e.person_id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,assignment.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex')
  AND (p_companies IS NULL OR c.company_id=ANY(p_companies))),
 tasks AS(SELECT subject_id::text AS id,CASE kind WHEN 'approval' THEN 'contractApproval' ELSE 'contractLetter' END AS kind,full_name AS "subjectName",updated_at::text AS "createdAt",
   '/lifecycle/contracts/'||CASE kind WHEN 'approval' THEN 'approvals/' ELSE 'letters/' END||subject_id::text AS "linkPath" FROM assigned
  UNION ALL SELECT subject_id::text,'contractDecision',full_name,updated_at::text,'/lifecycle/contracts/'||subject_id::text FROM decisions)
 SELECT coalesce(jsonb_agg(to_jsonb(tasks) ORDER BY "createdAt" DESC,kind,id),'[]'::jsonb) FROM tasks
$$;
REVOKE ALL ON FUNCTION app.contract_shared_task_metadata(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_task_metadata(uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_tracker_waiting(p_cases uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH rights AS MATERIALIZED(SELECT employment_id FROM app.contract_shared_tracker_subjects() WHERE can_view),
 waiting AS(SELECT w.case_id,string_agg(DISTINCT w.label,' · ' ORDER BY w.label) AS "waitingOn",string_agg(DISTINCT w.assigned_name,', ' ORDER BY w.assigned_name) AS "waitingFor"
 FROM app.contract_shared_pending_work() w JOIN rights r ON r.employment_id=w.employment_id WHERE w.case_id=ANY(p_cases[1:100]) GROUP BY w.case_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('caseId',case_id,'waitingOn',"waitingOn",'waitingFor',"waitingFor") ORDER BY case_id),'[]'::jsonb) FROM waiting
$$;
REVOKE ALL ON FUNCTION app.contract_shared_tracker_waiting(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_tracker_waiting(uuid[]) TO ai_hr_app;
