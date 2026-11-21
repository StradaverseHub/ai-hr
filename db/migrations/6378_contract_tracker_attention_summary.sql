-- Handoff status semantics, independent attention filter and full authorized pre-page summary.
CREATE OR REPLACE FUNCTION app.contract_shared_tracker(p_search text,p_company uuid,p_status text,p_limit integer,p_offset integer,p_attention boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 rights AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_subjects() WHERE can_view),
 intake_holds AS MATERIALIZED(SELECT * FROM app.contract_shared_native_intake_holds(ARRAY(SELECT employment_id FROM rights))),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.* FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 managers AS MATERIALIZED(SELECT DISTINCT ON(r.subordinate_employment_id) r.subordinate_employment_id,p.full_name FROM public.reporting_line r JOIN public.employment e ON e.tenant_id=r.tenant_id AND e.id=r.manager_employment_id JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.line_type='administrative' AND r.superseded_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>today) ORDER BY r.subordinate_employment_id,r.valid_from DESC,r.id),
 eligible AS MATERIALIZED(SELECT e.id,coalesce(a.employment_type='contract' AND e.hired_on<=today AND e.voided_at IS NULL AND e.blacklisted_at IS NULL AND co.archived_at IS NULL AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>today),false) AS qualifies FROM public.employment e LEFT JOIN placement a ON a.employment_id=e.id JOIN public.company co ON co.tenant_id=e.tenant_id AND co.id=e.company_id CROSS JOIN clock WHERE e.tenant_id=app.current_tenant_id()),
 current_cases AS MATERIALIZED(SELECT DISTINCT ON(c.employment_id) c.* FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id JOIN eligible q ON q.id=e.id LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
  WHERE c.tenant_id=app.current_tenant_id() AND (c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text OR NOT q.qualifies OR f.case_id IS NOT NULL AND f.data->>'stage' NOT IN('renewed','converted','offboarding','superseded','pay') OR f.case_id IS NULL AND c.data->>'state' NOT IN('renewed','handed_off','cancelled'))
  ORDER BY c.employment_id,(c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text) DESC NULLS LAST,c.created_at DESC,c.id),
 pending_pay AS MATERIALIZED(SELECT DISTINCT ON(c.employment_id) c.employment_id,c.id AS case_id FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id WHERE f.tenant_id=app.current_tenant_id() AND f.data->>'stage'='pay' ORDER BY c.employment_id,f.updated_at DESC,c.id),
 workflow_latest AS MATERIALIZED(SELECT DISTINCT ON(workflow_id) workflow_id,status,definition FROM public.automation_workflow_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' ORDER BY workflow_id,revision DESC),
 reminder_definitions AS MATERIALIZED(SELECT workflow_id,definition,
  CASE WHEN coalesce(definition->'trigger'->>'days','')~'^[0-9]{1,3}$' THEN (definition->'trigger'->>'days')::integer ELSE NULL END AS days,
  definition->'trigger'->'workdays'='true'::jsonb AS workdays FROM workflow_latest
  WHERE status='live' AND definition->'trigger'->>'event'='beforeContractEnd' AND jsonb_typeof(definition->'conditions')='array'),
 reminder_inputs AS MATERIALIZED(SELECT e.id,e.contract_end_date AS anchor,extract(isodow FROM e.contract_end_date)::integer AS weekday,w.days,coalesce(w.workdays,false) AS workdays
  FROM rights JOIN public.employment e ON e.id=rights.employment_id AND e.tenant_id=app.current_tenant_id() JOIN eligible q ON q.id=e.id AND q.qualifies JOIN public.company co ON co.tenant_id=e.tenant_id AND co.id=e.company_id CROSS JOIN clock CROSS JOIN reminder_definitions w
  WHERE e.contract_end_date IS NOT NULL AND w.days BETWEEN 0 AND 365 AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(w.definition->'conditions') condition
   CROSS JOIN LATERAL(SELECT CASE WHEN jsonb_typeof(condition->'values')='array' THEN condition->'values' ELSE '[]'::jsonb END AS values,
    CASE condition->>'field' WHEN 'businessGroup' THEN coalesce(co.parent_company_id,co.id)::text WHEN 'daysToEnd' THEN (e.contract_end_date-today)::text END AS actual) fact
   WHERE NOT coalesce(CASE WHEN condition->>'field' NOT IN('businessGroup','daysToEnd') OR jsonb_array_length(fact.values)=0 THEN false
    WHEN condition->>'op'='is' THEN fact.values ? fact.actual
    WHEN condition->>'op'='isNot' THEN NOT (fact.values ? fact.actual)
    WHEN condition->>'op' IN('lt','lte','gte') THEN CASE WHEN jsonb_array_length(fact.values)=1 AND length(fact.values->>0)<=1000 AND fact.values->>0~'^-?[0-9]+(\.[0-9]+)?$' AND fact.actual~'^-?[0-9]+(\.[0-9]+)?$' THEN
     CASE condition->>'op' WHEN 'lt' THEN fact.actual::numeric<(fact.values->>0)::numeric WHEN 'lte' THEN fact.actual::numeric<=(fact.values->>0)::numeric ELSE fact.actual::numeric>=(fact.values->>0)::numeric END ELSE false END
    ELSE false END,false))),
 reminder_dates AS MATERIALIZED(SELECT id,CASE WHEN NOT workdays OR days=0 THEN anchor-days ELSE
  anchor-CASE WHEN weekday>=6 THEN weekday-5 ELSE 0 END
  -((days-CASE WHEN weekday>=6 THEN 1 ELSE 0 END)/5*7)
  -((days-CASE WHEN weekday>=6 THEN 1 ELSE 0 END)%5)
  -CASE WHEN (days-CASE WHEN weekday>=6 THEN 1 ELSE 0 END)%5>=least(weekday,5) THEN 2 ELSE 0 END END AS due FROM reminder_inputs),
 reminders AS MATERIALIZED(SELECT id,min(due)::text AS first_due FROM reminder_dates GROUP BY id),
 visible AS MATERIALIZED(SELECT e.id,e.id AS "employmentId",c.id AS "caseId",c.number AS "caseNumber",e.company_id AS "companyId",p.full_name AS "employeeName",e.employee_code AS "employeeCode",co.legal_name AS company,bg.legal_name AS "businessGroup",coalesce(dep.name,'') AS department,coalesce(pos.title,'') AS position,coalesce(manager.full_name,'') AS manager,
  coalesce(e.contract_start_date::text,c.data->'term'->>'startOn') AS "startOn",coalesce(e.contract_end_date::text,c.data->'term'->>'endOn') AS "endOn",e.contract_number AS "contractNumber",
  encode(sha256(convert_to(jsonb_build_array(e.id,e.person_id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,a.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex') AS "sourceRevision",
  CASE WHEN NOT q.qualifies AND coalesce(f.data->>'stage','') NOT IN('renewed','converted','offboarding','superseded','pay') THEN 'superseded' ELSE coalesce(f.data->>'stage',CASE c.data->>'state' WHEN 'upcoming' THEN 'open' WHEN 'decision_pending' THEN 'open' WHEN 'in_approval' THEN 'approval' WHEN 'e_acceptance' THEN 'document' WHEN 'records_pending' THEN 'workflow' WHEN 'ending' THEN 'workflow' WHEN 'renewed' THEN 'renewed' WHEN 'handed_off' THEN 'offboarding' WHEN 'cancelled' THEN 'superseded' END) END AS stage,c.data->>'state' AS "legacyState",f.revision AS "sharedRevision",coalesce(f.data->'flags','[]'::jsonb) AS flags,f.updated_at::text AS "lastActivityAt",
  coalesce((f.data->'decision'->>'payChanges')::boolean,false) AS "payChanges",f.data->'payConfirmation' IS NOT NULL AND f.data->'payConfirmation'<>'null'::jsonb AS "payConfirmed",
  pending.employment_id IS NOT NULL AND coalesce(f.data->>'stage','')<>'pay' AS "previousPayPending",pending.case_id AS "payPendingCaseId",reminders.first_due AS "firstReminderOn",
  coalesce(e.contract_end_date<today,false) OR coalesce(reminders.first_due<=today::text,false) OR coalesce(c.data->>'state'='decision_pending',false) OR coalesce(jsonb_array_length(f.data->'decisionHistory'),0)>0 AS "decisionNeeded",
  coalesce(e.contract_end_date<today,false) AS "endPassed",
  CASE WHEN f.data->>'stage' IN('approval','workflow','document','posting','pay') AND coalesce(settings.stall_enabled,true) AND today-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date>=coalesce(settings.stall_days,5) THEN today-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date ELSE NULL END AS "stalledDays",
  rights.can_decide AND intake_hold.employment_id IS NULL AND q.qualifies AND c.id IS NULL AND e.contract_number IS NOT NULL AND e.contract_start_date IS NOT NULL AND e.contract_end_date IS NOT NULL AND e.contract_end_date>=e.contract_start_date AS "canOpen",
  CASE WHEN q.qualifies AND intake_hold.employment_id IS NOT NULL THEN 'native_intake_required' WHEN q.qualifies AND (e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL OR e.contract_end_date<e.contract_start_date) THEN 'verify_period'
   WHEN q.qualifies AND c.id IS NOT NULL AND (c.data->'term'->>'startOn' IS DISTINCT FROM e.contract_start_date::text OR c.data->'term'->>'endOn' IS DISTINCT FROM e.contract_end_date::text) THEN 'period_changed'
   WHEN q.qualifies AND f.case_id IS NOT NULL AND f.data->'period'->>'sourceRevision' IS DISTINCT FROM encode(sha256(convert_to(jsonb_build_array(e.id,e.person_id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,a.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex') THEN 'period_changed'
   WHEN q.qualifies AND c.id IS NOT NULL AND f.case_id IS NULL AND (c.data->>'state' NOT IN('upcoming','decision_pending') OR c.data->'decision' IS DISTINCT FROM 'null'::jsonb OR coalesce(c.data->'decisionDraft','null'::jsonb)<>'null'::jsonb) THEN 'legacy_in_progress' END AS "sourceIssue"
  FROM rights JOIN public.employment e ON e.id=rights.employment_id AND e.tenant_id=app.current_tenant_id() JOIN eligible q ON q.id=e.id LEFT JOIN placement a ON a.employment_id=e.id JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id JOIN public.company bg ON bg.id=coalesce(co.parent_company_id,co.id) AND bg.tenant_id=co.tenant_id
  LEFT JOIN public.department dep ON dep.id=a.department_id AND dep.tenant_id=e.tenant_id LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id LEFT JOIN managers manager ON manager.subordinate_employment_id=e.id LEFT JOIN current_cases c ON c.employment_id=e.id LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id LEFT JOIN pending_pay pending ON pending.employment_id=e.id LEFT JOIN reminders ON reminders.id=e.id LEFT JOIN intake_holds intake_hold ON intake_hold.employment_id=e.id LEFT JOIN public.contract_shared_settings settings ON settings.tenant_id=e.tenant_id AND settings.company_id=e.company_id CROSS JOIN clock
  WHERE (q.qualifies OR c.id IS NOT NULL)
  AND (p_company IS NULL OR e.company_id=p_company)
  AND (coalesce(p_search,'')='' OR concat_ws(' ',p.full_name,e.employee_code,c.number,co.legal_name,bg.legal_name,dep.name,pos.title) ILIKE '%'||left(p_search,100)||'%')
 ), classified AS MATERIALIZED(SELECT visible.*,
  (jsonb_array_length(flags)>0 OR "sourceIssue" IS NOT NULL OR "previousPayPending" OR "stalledDays" IS NOT NULL OR "endPassed" AND (stage IS NULL OR stage IN('open','document'))) AS attention
 FROM visible), filtered AS MATERIALIZED(SELECT * FROM classified WHERE (NOT p_attention OR attention) AND ( coalesce(p_status,'all')='all'
  OR p_status='attention' AND (jsonb_array_length(flags)>0 OR "sourceIssue" IS NOT NULL OR "previousPayPending" OR "stalledDays" IS NOT NULL OR "endPassed" AND (stage IS NULL OR stage IN('open','document')))
  OR p_status='decision' AND (stage IS NULL OR stage='open') AND "decisionNeeded"
  OR p_status='upcoming' AND (stage IS NULL OR stage='open') AND NOT "decisionNeeded"
  OR p_status='progress' AND stage IN('approval','workflow','document','posting','pay')
  OR p_status='closed' AND stage IN('renewed','converted','offboarding','superseded'))),
 page AS MATERIALIZED(SELECT * FROM filtered ORDER BY "endOn" NULLS LAST,"employeeName",id LIMIT least(greatest(coalesce(p_limit,50),1),100) OFFSET least(greatest(coalesce(p_offset,0),0),100000))
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(page)||jsonb_build_object('scheduledPeriod',scheduled.value) ORDER BY "endOn" NULLS LAST,"employeeName",page.id)
  FROM page LEFT JOIN LATERAL(
   SELECT jsonb_build_object('postingId',p.id,'label','PP-'||p.number::text,'eventType',p.event_type,
    'startOn',p.applied->>'effectiveDate','endOn',p.applied->>'endDate','contractNumber',(p.applied->>'contractNumber')::integer,
    'status',CASE WHEN (p.applied->>'effectiveDate')::date>clock.today THEN 'scheduled' ELSE 'awaiting_application' END) AS value
   FROM public.contract_case c JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
   JOIN public.personnel_posting p ON p.tenant_id=c.tenant_id AND p.source_ref=c.id AND p.source='contract_staff' AND p.status='approved'
    AND p.company_id=c.company_id AND p.employment_id=c.employment_id
   JOIN public.contract_shared_posting receipt ON receipt.tenant_id=p.tenant_id AND receipt.posting_id=p.id AND receipt.case_id=c.id
    AND receipt.decision_revision=(f.data->'decision'->>'revision')::integer AND receipt.applied_at IS NULL AND receipt.movement_group_id IS NOT NULL
   JOIN public.employment e ON e.tenant_id=p.tenant_id AND e.id=p.employment_id AND e.company_id=p.company_id AND e.person_id=receipt.subject_person_id
   JOIN public.domain_event d ON d.tenant_id=p.tenant_id AND d.id=CASE WHEN p.movement_id~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p.movement_id::uuid END
    AND d.subject_employment_id=p.employment_id AND d.event_type='employment.movement.scheduled'
    AND d.payload->'input'->>'contractPostingId'=p.id::text AND d.payload->'movement'->>'groupId'=receipt.movement_group_id::text
    AND d.payload->'movement'->>'type'=CASE p.event_type WHEN 'contractConversion' THEN 'employmentTypeChange' ELSE 'contractRenewal' END
    AND d.payload->>'effectiveDate'=p.applied->>'effectiveDate' AND (d.payload->>'endDate') IS NOT DISTINCT FROM (p.applied->>'endDate')
   CROSS JOIN clock
   WHERE c.tenant_id=app.current_tenant_id() AND c.id=page."caseId" AND c.company_id=page."companyId" AND c.employment_id=page."employmentId"
    AND NOT EXISTS(SELECT 1 FROM public.domain_event finished WHERE finished.tenant_id=p.tenant_id AND finished.subject_employment_id=p.employment_id
     AND (finished.event_type='employment.movement.applied' AND finished.payload->>'scheduledId'=d.id::text
      OR finished.event_type='employment.movement.reversed' AND finished.payload->>'movementId'=d.id::text))
   ORDER BY p.approved_at DESC,p.id LIMIT 1
  ) scheduled ON true),'[]'::jsonb),'total',(SELECT count(*) FROM filtered),'summary',(SELECT jsonb_build_object('total',count(*),'upcoming',count(*) FILTER(WHERE (stage IS NULL OR stage='open') AND NOT "decisionNeeded"),'decision',count(*) FILTER(WHERE (stage IS NULL OR stage='open') AND "decisionNeeded"),'inProgress',count(*) FILTER(WHERE stage IN('approval','workflow','document','posting','pay')),'closed',count(*) FILTER(WHERE stage IN('renewed','converted','offboarding','superseded')),'attention',count(*) FILTER(WHERE attention)) FROM classified))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_tracker(text,uuid,text,integer,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_tracker(text,uuid,text,integer,integer,boolean) TO ai_hr_app;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_tracker(p_search text DEFAULT '',p_company uuid DEFAULT NULL,p_status text DEFAULT 'all',p_limit integer DEFAULT 50,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_tracker(p_search,p_company,p_status,p_limit,p_offset,false)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_tracker(text,uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_tracker(text,uuid,text,integer,integer) TO ai_hr_app;
--> statement-breakpoint
-- One scoped statement for case screens and other bounded projections; no per-case permission definer calls.
CREATE FUNCTION app.contract_shared_case_attention(p_cases uuid[]) RETURNS TABLE("caseId" uuid,"stalledDays" integer,attention boolean,flags jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH rights AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_subjects() WHERE can_view),
 facts AS MATERIALIZED(SELECT f.case_id,f.data,
  CASE WHEN f.data->>'stage' IN('approval','workflow','document','posting','pay') AND coalesce(s.stall_enabled,true)
   AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date>=coalesce(s.stall_days,5)
   THEN (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date END AS stalled,
  coalesce(f.data->'flags','[]'::jsonb)||CASE WHEN f.data->>'stage'='pay' AND NOT (coalesce(f.data->'flags','[]'::jsonb)?'pay_pending') THEN '["pay_pending"]'::jsonb ELSE '[]'::jsonb END AS flags
 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id JOIN rights ON rights.employment_id=c.employment_id
 LEFT JOIN public.contract_shared_settings s ON s.tenant_id=c.tenant_id AND s.company_id=c.company_id
 WHERE f.tenant_id=app.current_tenant_id() AND f.case_id=ANY(p_cases))
 SELECT case_id,stalled,stalled IS NOT NULL OR jsonb_array_length(flags)>0,flags FROM facts ORDER BY case_id
$$;
REVOKE ALL ON FUNCTION app.contract_shared_case_attention(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_case_attention(uuid[]) TO ai_hr_app;
