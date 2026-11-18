-- Assigned work is an owner page, never an inferred decision task or a capped generic-provider array.
-- Candidate accounts/groups are resolved before native period validation; tracker reads are bounded to requested cases.
CREATE FUNCTION app.contract_shared_pending_work_page_source(p_cases uuid[],p_assigned_only boolean) RETURNS TABLE(case_id uuid,employment_id uuid,company_id uuid,subject_id uuid,kind text,step_id text,label text,assigned_name text,eligible boolean,updated_at timestamptz,action_code text)
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
 approval_steps AS(SELECT f.case_id,f.employment_id,f.company_id,a.id AS subject_id,'approval'::text AS kind,s->>'id' AS step_id,s->>'label' AS label,
  coalesce(person.full_name,g.name,s->>'label','Assigned approver') AS assigned_name,
  actor.verified AND actor.person_id<>f.person_id AND CASE WHEN assignment->'layer'->>'pick'='any' AND nullif(assignment->>'groupId','') IS NOT NULL THEN coalesce(g.members ? actor.id::text,false)
   ELSE assignment->'candidatePersonIds'->>actor.id::text=actor.person_id::text AND (assignment->'layer'->>'pick'<>'roundRobin' OR assignment->>'selectedUserId'=actor.id::text) END AS eligible,a.updated_at,'approval'::text AS action_code
  FROM periods f JOIN public.contract_shared_approval a ON a.tenant_id=app.current_tenant_id() AND a.case_id=f.case_id AND a.decision_revision=(f.data->'decision'->>'revision')::integer
  JOIN public.document_signing_document d ON d.tenant_id=a.tenant_id AND d.id=a.signing_document_id
  CROSS JOIN LATERAL app.document_signing_pending_steps(d.data) s CROSS JOIN actor
  JOIN LATERAL(SELECT x AS assignment FROM jsonb_array_elements(a.data->'assignments') x WHERE x->'layer'->>'id'=s->>'id' LIMIT 1) ass ON true
  LEFT JOIN groups g ON g.id=assignment->>'groupId'
  LEFT JOIN public.app_user holder ON holder.tenant_id=a.tenant_id AND holder.id::text=s->>'holderId' AND holder.person_id::text=s->>'holderPersonId'
  LEFT JOIN public.person person ON person.tenant_id=holder.tenant_id AND person.id=holder.person_id
  WHERE NOT app.document_signing_returned(d.data)),
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

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_work_page(p_category text DEFAULT 'all',p_companies uuid[] DEFAULT NULL,p_limit integer DEFAULT 20,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_category NOT IN('all','approvals','tasks') OR p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 100000 OR cardinality(p_companies)>500 THEN RAISE EXCEPTION 'Invalid Contract work page' USING ERRCODE='22023'; END IF;
 IF NOT app.contract_verified_human(app.current_user_id()) THEN RETURN jsonb_build_object('items','[]'::jsonb,'total',0,'countsByKind','{}'::jsonb,'approvalTotal',0,'taskTotal',0); END IF;
 WITH assigned AS MATERIALIZED(
  SELECT DISTINCT ON(w.kind,w.subject_id) w.*,p.full_name,CASE WHEN w.kind='letter' AND w.action_code='sign' THEN 'tasks' ELSE 'approvals' END AS category
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
REVOKE ALL ON FUNCTION app.contract_shared_work_page(text,uuid[],integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_work_page(text,uuid[],integer,integer) TO ai_hr_app;
--> statement-breakpoint
-- The old unbounded adapter is deliberately retired. Decision entry remains on the Contract case only.
REVOKE ALL ON FUNCTION app.contract_shared_task_metadata(uuid[]) FROM ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_tracker_waiting(p_cases uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH rights AS MATERIALIZED(SELECT employment_id FROM app.contract_shared_tracker_subjects() WHERE can_view),
 waiting AS(SELECT w.case_id,string_agg(DISTINCT w.label,' · ' ORDER BY w.label) AS "waitingOn",string_agg(DISTINCT w.assigned_name,', ' ORDER BY w.assigned_name) AS "waitingFor"
 FROM app.contract_shared_pending_work_page_source(p_cases,false) w JOIN rights r ON r.employment_id=w.employment_id GROUP BY w.case_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('caseId',case_id,'waitingOn',"waitingOn",'waitingFor',"waitingFor") ORDER BY case_id),'[]'::jsonb) FROM waiting
$$;
