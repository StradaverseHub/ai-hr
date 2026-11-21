-- Fixed system provenance must match the held job frame and immutable sender input.
CREATE OR REPLACE FUNCTION app.contract_shared_system_job_held(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_job::text=current_setting('app.bulk_job',true) AND app.contract_shared_storage_runner() AND app.bulk_job_capability_held(p_job) AND EXISTS(
 SELECT 1 FROM public.bulk_job j JOIN public.bulk_job_kind k ON k.kind=j.kind AND k.finalize_owner JOIN app.contract_system_job_source source ON source.job_id=j.id AND source.tenant_id=j.tenant_id AND source.kind=j.kind
 JOIN public.tenant tenant ON tenant.id=j.tenant_id AND tenant.status IN('active','trial')
 WHERE j.id=p_job AND j.tenant_id=app.current_tenant_id() AND j.created_by IS NULL AND j.kind IN('contract_schedule','contract_scheduled_automation')
 AND j.state IN('queued','preparing','finalizing') AND j.lease_expires_at>clock_timestamp() AND j.cancel_requested_at IS NULL
 AND j.context=jsonb_build_object('tenantId',j.tenant_id,'roles','[]'::jsonb) AND source.input_digest=app.bulk_job_value_digest(j.input)
 AND source.source_date<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=j.tenant_id AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.expires_at IS NULL OR module.expires_at>now()))
 AND (j.kind<>'contract_schedule' OR source.source_date=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND (j.kind='contract_schedule' OR EXISTS(SELECT 1 FROM public.contract_case c JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
 JOIN public.contract_shared_event event ON event.tenant_id=c.tenant_id AND event.case_id=c.id AND event.id=source.event_id AND event.actor_type='system' AND event.actor_user_id IS NULL AND event.actor_person_id IS NULL AND event.job_id=j.id AND event.trigger_event=source.cause
 WHERE c.tenant_id=j.tenant_id AND c.id=source.case_id AND c.employment_id=source.employment_id AND source.period_revision=app.contract_shared_period_revision(c.employment_id)
 AND f.data->'period'->>'sourceRevision'=source.period_revision AND c.source_conflict IS NULL AND app.contract_case_company_current(c.id)
 AND app.contract_company_writable(c.company_id) AND app.contract_shared_native_intake_hold(c.employment_id) IS NULL
 AND j.input=jsonb_build_object('eventId',event.id))) )
$$;
REVOKE ALL ON FUNCTION app.contract_shared_system_job_held(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_delivery_eligible(p_tenant uuid,p_case uuid,p_context jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(
 SELECT 1 FROM app.contract_system_digest digest JOIN app.contract_system_job_source source ON source.job_id=digest.job_id AND source.tenant_id=digest.tenant_id AND source.kind='contract_schedule' AND source.cause='morning'
 JOIN public.bulk_job job ON job.id=source.job_id AND job.tenant_id=source.tenant_id AND job.created_by IS NULL AND job.kind=source.kind AND source.input_digest=app.bulk_job_value_digest(job.input)
 JOIN public.tenant tenant ON tenant.id=digest.tenant_id AND tenant.status IN('active','trial') JOIN public.company company ON company.tenant_id=digest.tenant_id AND company.id=digest.company_id AND company.archived_at IS NULL
 WHERE digest.tenant_id=p_tenant AND digest.case_id=p_case AND digest.mail_key=p_context->>'digestKey' AND digest.context->>'systemJobId'=p_context->>'systemJobId'
 AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=p_tenant AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.company_id IS NULL OR module.company_id=digest.company_id) AND (module.expires_at IS NULL OR module.expires_at>now()))
 AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(p_context->'recipientPeople') binding WHERE binding.key::uuid NOT IN(SELECT app.contract_shared_digest_recipients(p_tenant,digest.company_id)))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(digest.context->'cases') item WHERE NOT EXISTS(SELECT 1 FROM public.contract_case c JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id WHERE c.tenant_id=p_tenant AND c.id::text=item->>'caseId' AND c.company_id=digest.company_id AND employment.company_id=digest.company_id AND employment.person_id::text=item->>'personId')))
 OR EXISTS(
 SELECT 1 FROM public.contract_shared_event event JOIN app.contract_system_job_source source ON source.event_id=event.id AND source.tenant_id=event.tenant_id AND source.job_id=event.job_id AND source.kind='contract_scheduled_automation'
 JOIN public.bulk_job job ON job.id=source.job_id AND job.tenant_id=source.tenant_id AND job.created_by IS NULL AND job.kind=source.kind AND source.input_digest=app.bulk_job_value_digest(job.input)
 JOIN public.contract_case c ON c.tenant_id=event.tenant_id AND c.id=event.case_id JOIN public.contract_shared_case flow ON flow.tenant_id=c.tenant_id AND flow.case_id=c.id JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 JOIN public.tenant tenant ON tenant.id=c.tenant_id AND tenant.status IN('active','trial') JOIN public.company company ON company.tenant_id=c.tenant_id AND company.id=c.company_id AND company.archived_at IS NULL
 WHERE event.tenant_id=p_tenant AND event.case_id=p_case AND event.id::text=p_context->>'eventId' AND event.job_id::text=p_context->>'systemJobId' AND event.actor_type='system' AND event.trigger_event IN('caseOpened','beforeContractEnd','afterContractEnd')
 AND employment.person_id::text=p_context->>'subjectPersonId' AND flow.data->'period'->>'sourceRevision'=p_context->>'periodRevision' AND c.source_conflict IS NULL
 AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=p_tenant AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.company_id IS NULL OR module.company_id=c.company_id) AND (module.expires_at IS NULL OR module.expires_at>now()))
 AND flow.data->'decision' IS NOT DISTINCT FROM CASE WHEN event.decision_revision=0 THEN 'null'::jsonb ELSE flow.data->'decision' END
 AND coalesce((flow.data->'decision'->>'revision')::integer,0)=event.decision_revision AND app.contract_shared_delivery_period_current(p_tenant,p_case))
 OR EXISTS(SELECT 1 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
 JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 JOIN public.contract_shared_event event ON event.tenant_id=f.tenant_id AND event.case_id=f.case_id AND event.id::text=p_context->>'eventId'
 JOIN public.app_user origin ON origin.tenant_id=event.tenant_id AND origin.id=event.actor_user_id AND origin.person_id=event.actor_person_id
 JOIN public.tenant tenant ON tenant.id=f.tenant_id JOIN public.company company ON company.tenant_id=c.tenant_id AND company.id=c.company_id
 WHERE f.tenant_id=p_tenant AND f.case_id=p_case AND employment.person_id::text=p_context->>'subjectPersonId' AND f.data->'period'->>'sourceRevision'=p_context->>'periodRevision'
 AND event.decision_revision::text=p_context->>'decisionRevision' AND tenant.status IN('active','trial') AND company.archived_at IS NULL
 AND (f.data->'declined'='null'::jsonb OR event.trigger_event='employeeDeclined' OR EXISTS(SELECT 1 FROM public.contract_shared_letter declined_letter WHERE declined_letter.tenant_id=f.tenant_id AND declined_letter.case_id=f.case_id AND declined_letter.id::text=event.data->>'letterId' AND declined_letter.purpose='declined'))
 AND (event.trigger_event<>'approvalActionNeeded' OR EXISTS(SELECT 1 FROM public.contract_shared_approval approval JOIN public.document_signing_document signing ON signing.tenant_id=approval.tenant_id AND signing.id=approval.signing_document_id
 WHERE approval.tenant_id=f.tenant_id AND approval.case_id=f.case_id AND approval.id::text=p_context->>'approvalId' AND signing.revision::text=p_context->>'documentRevision'
 AND NOT app.document_signing_returned(signing.data) AND EXISTS(SELECT 1 FROM app.document_signing_pending_steps(signing.data))))
 AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=f.tenant_id AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.expires_at IS NULL OR module.expires_at>now()) AND (module.company_id IS NULL OR module.company_id=c.company_id))
 AND (event.trigger_event NOT IN('letterActionNeeded','letterSentBack') OR EXISTS(SELECT 1 FROM public.contract_shared_letter letter JOIN public.document_signing_document signing ON signing.tenant_id=letter.tenant_id AND signing.id=letter.signing_document_id
 WHERE letter.tenant_id=f.tenant_id AND letter.case_id=f.case_id AND letter.id::text=p_context->>'letterId' AND letter.data->>'state'='routing' AND signing.revision::text=p_context->>'documentRevision'))
 AND CASE WHEN event.decision_revision=0 THEN f.data->'decision'='null'::jsonb AND f.data->>'stage'='open' AND app.contract_shared_delivery_period_current(p_tenant,p_case)
 ELSE ((f.data->'decision'->>'revision')=event.decision_revision::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(f.data->'decisionHistory') decision WHERE decision->>'revision'=event.decision_revision::text))
 AND EXISTS(SELECT 1 FROM public.contract_shared_event original JOIN public.app_user actor ON actor.tenant_id=original.tenant_id AND actor.id=original.actor_user_id AND actor.person_id=original.actor_person_id
 WHERE original.tenant_id=f.tenant_id AND original.case_id=f.case_id AND original.trigger_event='decisionSubmitted' AND original.decision_revision=event.decision_revision)
 AND (app.contract_shared_delivery_period_current(p_tenant,p_case)
 OR EXISTS(SELECT 1 FROM public.contract_shared_letter letter WHERE letter.tenant_id=f.tenant_id AND letter.case_id=f.case_id AND letter.decision_revision=event.decision_revision AND letter.data->>'state'='released' AND letter.data->'valuesFixed'='true'::jsonb)
 OR EXISTS(SELECT 1 FROM public.personnel_posting posting WHERE posting.tenant_id=f.tenant_id AND posting.id::text=f.data->'posting'->>'id' AND posting.source='contract_staff' AND posting.source_ref=f.case_id AND posting.employment_id=c.employment_id AND posting.status='approved')) END)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_delivery_eligible(uuid,uuid,jsonb) FROM PUBLIC,ai_hr_app;


--> statement-breakpoint
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
  CASE WHEN NOT q.qualifies AND coalesce(f.data->>'stage','') NOT IN('renewed','converted','offboarding','superseded','pay') THEN 'superseded' ELSE coalesce(f.data->>'stage',CASE c.data->>'state' WHEN 'upcoming' THEN 'open' WHEN 'decision_pending' THEN 'open' WHEN 'in_approval' THEN 'approval' WHEN 'e_acceptance' THEN 'document' WHEN 'records_pending' THEN 'workflow' WHEN 'ending' THEN 'workflow' WHEN 'renewed' THEN 'renewed' WHEN 'handed_off' THEN 'offboarding' WHEN 'cancelled' THEN 'superseded' END) END AS stage,c.data->>'state' AS "legacyState",f.revision AS "sharedRevision",coalesce(f.data->'flags','[]'::jsonb)||CASE WHEN (f.data->>'stage'='pay' OR pending.employment_id IS NOT NULL) AND NOT(coalesce(f.data->'flags','[]'::jsonb)?'pay_pending') THEN '["pay_pending"]'::jsonb ELSE '[]'::jsonb END AS flags,f.updated_at::text AS "lastActivityAt",
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
CREATE OR REPLACE FUNCTION app.contract_shared_digest_cases(p_company uuid,p_after uuid DEFAULT NULL) RETURNS TABLE("caseId" uuid,name text,flags jsonb,"stalledDays" integer,"personId" uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT c.id,p.full_name,coalesce(f.data->'flags','[]'::jsonb)||CASE WHEN f.data->>'stage'='pay' AND NOT(coalesce(f.data->'flags','[]'::jsonb)?'pay_pending') THEN '["pay_pending"]'::jsonb ELSE '[]'::jsonb END,
 CASE WHEN coalesce(settings.stall_enabled,true) AND f.data->>'stage' IN('approval','workflow','document','posting','pay') AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date>=coalesce(settings.stall_days,5) THEN (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date END,
 e.person_id
 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id
 LEFT JOIN public.contract_shared_settings settings ON settings.tenant_id=c.tenant_id AND settings.company_id=c.company_id
 WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=p_company AND (p_after IS NULL OR c.id>p_after)
 AND (jsonb_array_length(coalesce(f.data->'flags','[]'::jsonb))>0 OR f.data->>'stage'='pay' OR c.source_conflict IS NOT NULL
 OR coalesce(settings.stall_enabled,true) AND f.data->>'stage' IN('approval','workflow','document','posting','pay') AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date>=coalesce(settings.stall_days,5))
 ORDER BY c.id LIMIT 50
$$;
REVOKE ALL ON FUNCTION app.contract_shared_digest_cases(uuid,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_digest_recipients(p_tenant uuid,p_company uuid,p_after uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT id FROM app.contract_shared_digest_recipients(p_tenant,p_company) AS recipients(id) WHERE p_after IS NULL OR id>p_after ORDER BY id LIMIT 100
$$;
REVOKE ALL ON FUNCTION app.contract_shared_digest_recipients(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
