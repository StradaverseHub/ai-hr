-- Reuse the native tenant/year human reference counter. It is never the Personnel contract ordinal.
CREATE OR REPLACE FUNCTION app.contract_shared_period_open(p_employment uuid,p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE case_number text;reference_number bigint;e public.employment;existing public.contract_case;new_case uuid:=gen_random_uuid();new_term uuid:=gen_random_uuid();term_version integer;flow jsonb;source jsonb;period text;queued jsonb;actor uuid:=app.current_user_id();
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.contract_verified_human(actor) IS NOT TRUE THEN RAISE EXCEPTION 'Verified Contract principal required' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=app.current_tenant_id() AND id=p_employment FOR UPDATE;
 IF e.id IS NULL OR app.contract_shared_permitted('view',e.company_id,NULL,e.id) IS NOT TRUE OR app.contract_shared_permitted('decide',e.company_id,NULL,e.id) IS NOT TRUE THEN RAISE EXCEPTION 'Contract case opening unavailable' USING ERRCODE='42501';END IF;
 IF e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL OR e.contract_end_date<e.contract_start_date
 OR e.hired_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR e.voided_at IS NOT NULL OR e.blacklisted_at IS NOT NULL
 OR least(e.terminated_on,e.resignation_date,e.last_working_date)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=e.tenant_id AND c.id=e.company_id AND c.archived_at IS NULL)
 OR (SELECT a.employment_type FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) IS DISTINCT FROM 'contract'
 THEN RAISE EXCEPTION 'Verify the active fixed-term Personnel period before opening a case' USING ERRCODE='22023';END IF;
 period:=app.contract_shared_period_revision(e.id);
 IF p_source IS DISTINCT FROM period THEN RAISE EXCEPTION 'Personnel period changed; reload' USING ERRCODE='40001';END IF;
 SELECT * INTO existing FROM public.contract_case c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id
 AND c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text ORDER BY c.created_at DESC,c.id LIMIT 1 FOR UPDATE;
 IF existing.id IS NOT NULL THEN
  IF existing.data->'sourceSnapshot'->>'personId' IS NOT NULL AND existing.data->'sourceSnapshot'->>'personId' IS DISTINCT FROM e.person_id::text
   OR EXISTS(SELECT 1 FROM public.contract_shared_case f WHERE f.tenant_id=e.tenant_id AND f.case_id=existing.id AND f.data->'period'->>'sourceRevision' IS DISTINCT FROM period)
  THEN RAISE EXCEPTION 'The existing period source changed; reconcile it before continuing' USING ERRCODE='40001';END IF;
  -- Opening never adopts, rewrites or restarts a legacy case. Its pinned WIP remains on the legacy route.
  RETURN jsonb_build_object('caseId',existing.id,'legacy',NOT EXISTS(SELECT 1 FROM public.contract_shared_case f WHERE f.tenant_id=e.tenant_id AND f.case_id=existing.id));
 END IF;
 -- Never bypass unfinished work for a prior period by manufacturing a second active case.
 IF EXISTS(SELECT 1 FROM public.contract_case c LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id
  AND (f.case_id IS NULL AND c.data->>'state' NOT IN('renewed','handed_off','cancelled') OR f.case_id IS NOT NULL AND f.data->>'stage' NOT IN('renewed','converted','offboarding','superseded','pay')))
 THEN RAISE EXCEPTION 'Finish or reconcile the prior Contract case before opening the new Personnel period' USING ERRCODE='40001';END IF;
 source:=app.contract_source(e.id);
 SELECT coalesce(max(version),0)+1 INTO term_version FROM public.contract_term WHERE tenant_id=e.tenant_id AND employment_id=e.id;
 INSERT INTO public.contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision)
 VALUES(new_term,e.tenant_id,e.company_id,e.id,term_version,'fixed_term',e.contract_start_date,e.contract_end_date,period);
 INSERT INTO public.tenant_counter(tenant_id,kind,value) VALUES(e.tenant_id,'contract-'||to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY'),1)
 ON CONFLICT(tenant_id,kind) DO UPDATE SET value=tenant_counter.value+1 RETURNING value INTO reference_number;
 case_number:='CT-'||to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY')||'-'||lpad(reference_number::text,greatest(4,length(reference_number::text)),'0');
 INSERT INTO public.contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data)
 VALUES(new_case,e.tenant_id,e.company_id,e.id,new_term,case_number,1,
  jsonb_build_object('id',new_case,'number',case_number,'revision',1,'state','upcoming','term',jsonb_build_object('id',new_term,'kind','fixed_term','startOn',e.contract_start_date,'endOn',e.contract_end_date,'sourceRevision',period),'sourceSnapshot',source,'decision',NULL,'decisionDraft',NULL));
 flow:=jsonb_build_object('version',2,'revision',1,'stage','open','period',jsonb_build_object('id',new_term,'startOn',e.contract_start_date,'endOn',e.contract_end_date,'number',e.contract_number::text,'sourceRevision',period),
  'decision',NULL,'decisionHistory','[]'::jsonb,'flags','[]'::jsonb,'lastActivityAt',now(),'posting',NULL,'payConfirmation',NULL,'offboardingId',NULL,'declined',NULL);
 INSERT INTO public.contract_shared_case(tenant_id,case_id,revision,data) VALUES(e.tenant_id,new_case,1,flow);
 PERFORM app.contract_audit(new_case,'shared.opened',jsonb_build_object('periodId',new_term,'contractNumber',e.contract_number));
 queued:=app.contract_shared_enqueue_event(new_case,'caseOpened','period:'||new_term::text,jsonb_build_object('period',flow->'period'));
 RETURN queued||jsonb_build_object('caseId',new_case,'legacy',false);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_period_open(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_period_open(uuid,text) TO ai_hr_app;

--> statement-breakpoint
-- A definition identity in another module is not a Contract starting configuration.
CREATE OR REPLACE FUNCTION app.contract_shared_setup_read(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.contract_shared_permitted('access',p_company) IS NOT TRUE THEN RAISE EXCEPTION 'Contract setup is unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('v9Ready',EXISTS(SELECT 1 FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()),'installed',EXISTS(SELECT 1 FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()) AND EXISTS(SELECT 1 FROM public.contract_shared_settings WHERE tenant_id=app.current_tenant_id() AND company_id=p_company) AND 21=(SELECT count(*) FROM(
  SELECT id FROM public.automation_document_template WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' AND id BETWEEN 'c017ac70-0000-4000-8000-000000000001'::uuid AND 'c017ac70-0000-4000-8000-000000000005'::uuid
  UNION SELECT template_id AS id FROM public.automation_email_template_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' AND template_id BETWEEN 'c017ac70-0000-4000-8000-000000000101'::uuid AND 'c017ac70-0000-4000-8000-000000000104'::uuid
  UNION SELECT workflow_id AS id FROM public.automation_workflow_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' AND workflow_id BETWEEN 'c017ac70-0000-4000-8000-000000000201'::uuid AND 'c017ac70-0000-4000-8000-000000000212'::uuid) definitions),
 'jobId',(SELECT id FROM public.bulk_job WHERE tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND kind='contract_setup' AND company_ids @> ARRAY[p_company] ORDER BY created_at DESC,id LIMIT 1),
 'canInstall',app.automation_can_manage('contract_staff','workflows') AND app.automation_can_manage('contract_staff','templates') AND app.contract_company_writable(p_company),
 'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g->>'id','name',g->>'name') ORDER BY g->>'name',g->>'id') FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()),'[]'::jsonb),
 'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',routing_id,'name',name) ORDER BY name,routing_id) FROM(SELECT DISTINCT ON(routing_id) routing_id,name,retired FROM public.automation_routing_version WHERE tenant_id=app.current_tenant_id() ORDER BY routing_id,revision DESC) latest WHERE NOT retired),'[]'::jsonb),
 'missing',CASE WHEN NOT EXISTS(SELECT 1 FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()) THEN jsonb_build_array('Contract group projection is not initialized. Ask an authorized On/Off Boarding administrator to complete native setup; shared groups are retained.') WHEN NOT EXISTS(SELECT 1 FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()) THEN jsonb_build_array('Create the real assignment groups in HR Automation first.') ELSE jsonb_build_array('Map populated People Ops and posting approver groups, and BP and CEO routings before installing the starting configuration.') END) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_setup_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_setup_read(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Display scheduling uses the same catalogue facts and Monday–Friday offsets as the shared runtime.
CREATE OR REPLACE FUNCTION app.contract_shared_tracker(p_search text DEFAULT '',p_company uuid DEFAULT NULL,p_status text DEFAULT 'all',p_limit integer DEFAULT 50,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 rights AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_subjects() WHERE can_view),
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
  coalesce(reminders.first_due<=today::text,false) OR coalesce(c.data->>'state'='decision_pending',false) OR coalesce(jsonb_array_length(f.data->'decisionHistory'),0)>0 AS "decisionNeeded",
  coalesce(e.contract_end_date<today,false) AS "endPassed",
  CASE WHEN f.data->>'stage' IN('approval','workflow','document','posting') AND coalesce(settings.stall_enabled,true) AND today-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date>=coalesce(settings.stall_days,5) THEN today-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date ELSE NULL END AS "stalledDays",
  rights.can_decide AND q.qualifies AND c.id IS NULL AND e.contract_number IS NOT NULL AND e.contract_start_date IS NOT NULL AND e.contract_end_date IS NOT NULL AND e.contract_end_date>=e.contract_start_date AS "canOpen",
  CASE WHEN q.qualifies AND (e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL OR e.contract_end_date<e.contract_start_date) THEN 'verify_period'
   WHEN q.qualifies AND c.id IS NOT NULL AND (c.data->'term'->>'startOn' IS DISTINCT FROM e.contract_start_date::text OR c.data->'term'->>'endOn' IS DISTINCT FROM e.contract_end_date::text) THEN 'period_changed'
   WHEN q.qualifies AND f.case_id IS NOT NULL AND f.data->'period'->>'sourceRevision' IS DISTINCT FROM encode(sha256(convert_to(jsonb_build_array(e.id,e.person_id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,a.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex') THEN 'period_changed'
   WHEN q.qualifies AND c.id IS NOT NULL AND f.case_id IS NULL AND (c.data->>'state' NOT IN('upcoming','decision_pending') OR c.data->'decision' IS DISTINCT FROM 'null'::jsonb OR coalesce(c.data->'decisionDraft','null'::jsonb)<>'null'::jsonb) THEN 'legacy_in_progress' END AS "sourceIssue"
  FROM rights JOIN public.employment e ON e.id=rights.employment_id AND e.tenant_id=app.current_tenant_id() JOIN eligible q ON q.id=e.id LEFT JOIN placement a ON a.employment_id=e.id JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id JOIN public.company bg ON bg.id=coalesce(co.parent_company_id,co.id) AND bg.tenant_id=co.tenant_id
  LEFT JOIN public.department dep ON dep.id=a.department_id AND dep.tenant_id=e.tenant_id LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id LEFT JOIN managers manager ON manager.subordinate_employment_id=e.id LEFT JOIN current_cases c ON c.employment_id=e.id LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id LEFT JOIN pending_pay pending ON pending.employment_id=e.id LEFT JOIN reminders ON reminders.id=e.id LEFT JOIN public.contract_shared_settings settings ON settings.tenant_id=e.tenant_id AND settings.company_id=e.company_id CROSS JOIN clock
  WHERE (q.qualifies OR c.id IS NOT NULL)
  AND (p_company IS NULL OR e.company_id=p_company)
  AND (coalesce(p_search,'')='' OR concat_ws(' ',p.full_name,e.employee_code,c.number,co.legal_name,bg.legal_name,dep.name,pos.title) ILIKE '%'||left(p_search,100)||'%')
 ), filtered AS MATERIALIZED(SELECT * FROM visible WHERE coalesce(p_status,'all')='all'
  OR p_status='attention' AND (jsonb_array_length(flags)>0 OR "sourceIssue" IS NOT NULL OR "previousPayPending" OR "stalledDays" IS NOT NULL OR "endPassed" AND (stage IS NULL OR stage IN('open','document')))
  OR p_status='decision' AND (stage IS NULL OR stage='open') AND "decisionNeeded"
  OR p_status='upcoming' AND (stage IS NULL OR stage='open') AND NOT "decisionNeeded"
  OR p_status='progress' AND stage IN('approval','workflow','document','posting','pay')
  OR p_status='closed' AND stage IN('renewed','converted','offboarding','superseded')),
 page AS(SELECT * FROM filtered ORDER BY "endOn" NULLS LAST,"employeeName",id LIMIT least(greatest(coalesce(p_limit,50),1),100) OFFSET least(greatest(coalesce(p_offset,0),0),100000))
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "endOn" NULLS LAST,"employeeName",id) FROM page),'[]'::jsonb),'total',(SELECT count(*) FROM filtered))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_tracker(text,uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_tracker(text,uuid,text,integer,integer) TO ai_hr_app;
