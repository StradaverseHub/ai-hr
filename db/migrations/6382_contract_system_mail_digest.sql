-- Owner-private digest receipts share the established OneHR queue, sender, recipient binding and uncertain-send rules.
CREATE TABLE app.contract_system_digest(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),mail_key text NOT NULL,job_id uuid NOT NULL REFERENCES public.bulk_job(id),company_id uuid NOT NULL REFERENCES public.company(id),
 case_id uuid NOT NULL,source_date date NOT NULL,context jsonb NOT NULL,recipient_ids uuid[] NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,mail_key),
 FOREIGN KEY(tenant_id,case_id) REFERENCES public.contract_shared_case(tenant_id,case_id)
);
REVOKE ALL ON app.contract_system_digest FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Recipients need current company-wide viewing authority, in addition to real membership in the actual People Ops group.
CREATE FUNCTION app.contract_shared_digest_recipients(p_tenant uuid,p_company uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE ancestors AS(SELECT id,parent_company_id FROM public.company WHERE tenant_id=p_tenant AND id=p_company UNION ALL SELECT c.id,c.parent_company_id FROM public.company c JOIN ancestors a ON a.parent_company_id=c.id WHERE c.tenant_id=p_tenant),
 people AS MATERIALIZED(SELECT DISTINCT u.id FROM public.lc_v9_config config CROSS JOIN LATERAL jsonb_array_elements(config.data->'groups') g
 CROSS JOIN LATERAL jsonb_array_elements_text(g->'members') member JOIN public.app_user u ON u.tenant_id=config.tenant_id AND u.id::text=member JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id
 WHERE config.tenant_id=p_tenant AND g->>'id'=config.data->>'peopleOpsGroup' AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND length(btrim(p.full_name))>0)
 SELECT people.id FROM people WHERE EXISTS(SELECT 1 FROM public.role_assignment role WHERE role.tenant_id=p_tenant AND role.app_user_id=people.id AND role.role IN('super_admin','hr_admin') AND (role.company_id IS NULL OR role.company_id IN(SELECT id FROM ancestors)))
 OR EXISTS(SELECT 1 FROM public.contract_role_assignment role WHERE role.tenant_id=p_tenant AND role.user_id=people.id AND role.role='gbs' AND role.company_id=p_company AND role.business_unit_id IS NULL AND role.revoked_at IS NULL AND role.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (role.valid_to IS NULL OR role.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
 OR EXISTS(SELECT 1 FROM public.contract_access_member member JOIN public.contract_access_role role ON role.tenant_id=member.tenant_id AND role.id=member.role_id JOIN public.company company ON company.tenant_id=member.tenant_id AND company.id=p_company
 WHERE member.tenant_id=p_tenant AND member.user_id=people.id AND role.permissions @> ARRAY['view']::text[] AND member.revoked_at IS NULL AND (member.company_id IS NULL OR member.company_id=p_company)
 AND (member.business_group_id IS NULL OR member.business_group_id=coalesce(company.parent_company_id,company.id)) AND member.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (member.valid_to IS NULL OR member.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
 ORDER BY id
$$;
REVOKE ALL ON FUNCTION app.contract_shared_digest_recipients(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_digest_cases(p_company uuid,p_after uuid DEFAULT NULL) RETURNS TABLE("caseId" uuid,name text,flags jsonb,"stalledDays" integer,"personId" uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT c.id,p.full_name,coalesce(f.data->'flags','[]'::jsonb)||CASE WHEN f.data->>'stage'='pay' AND NOT(coalesce(f.data->'flags','[]'::jsonb)?'pay_pending') THEN '["pay_pending"]'::jsonb ELSE '[]'::jsonb END,
 CASE WHEN coalesce(settings.stall_enabled,true) AND f.data->>'stage' IN('approval','workflow','document','posting','pay') AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date>=coalesce(settings.stall_days,5) THEN (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date END,
 e.person_id
 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id
 LEFT JOIN public.contract_shared_settings settings ON settings.tenant_id=c.tenant_id AND settings.company_id=c.company_id
 WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=p_company AND (p_after IS NULL OR c.id>p_after)
 AND (jsonb_array_length(coalesce(f.data->'flags','[]'::jsonb))>0 OR f.data->>'stage'='pay' OR c.source_conflict IS NOT NULL
 OR coalesce(settings.stall_enabled,true) AND f.data->>'stage' IN('approval','workflow','document','posting','pay') AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date>=coalesce(settings.stall_days,5))
 ORDER BY c.id LIMIT 100
$$;
REVOKE ALL ON FUNCTION app.contract_shared_digest_cases(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_mail_context(p_case uuid,p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin public.contract_shared_event;run_id uuid;step_id text;step_type text;context jsonb;
BEGIN
 IF app.contract_shared_system_job_held(nullif(current_setting('app.bulk_job',true),'')::uuid) AND p_key LIKE 'digest:%' THEN
  SELECT digest.context INTO context FROM app.contract_system_digest digest WHERE digest.tenant_id=app.current_tenant_id() AND digest.case_id=p_case AND digest.mail_key=p_key AND digest.job_id::text=current_setting('app.bulk_job',true);
  IF context IS NULL THEN RAISE EXCEPTION 'Native digest receipt required' USING ERRCODE='42501';END IF;RETURN context;
 END IF;
 SELECT * INTO origin FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND case_id=p_case AND id::text=current_setting('app.contract_event',true);
 IF origin.id IS NULL OR app.contract_shared_worker_event_held(p_case,origin.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Protected Contract email intent required' USING ERRCODE='42501';END IF;
 IF origin.trigger_event='approvalActionNeeded' AND p_key LIKE 'approval:'||(origin.data->>'approvalId')||':'||(origin.data->>'documentRevision')||':%' THEN
  IF NOT EXISTS(SELECT 1 FROM public.contract_shared_approval approval JOIN public.document_signing_document signing ON signing.tenant_id=approval.tenant_id AND signing.id=approval.signing_document_id
  WHERE approval.tenant_id=origin.tenant_id AND approval.case_id=p_case AND approval.id::text=origin.data->>'approvalId' AND signing.revision::text=origin.data->>'documentRevision'
  AND NOT app.document_signing_returned(signing.data) AND EXISTS(SELECT 1 FROM app.document_signing_pending_steps(signing.data))) THEN RAISE EXCEPTION 'This approval notification is no longer pending' USING ERRCODE='40001';END IF;
 ELSE
 SELECT run.id,step->>'id',step->>'type' INTO run_id,step_id,step_type FROM public.automation_run run
 JOIN public.automation_workflow_version version ON version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision
 CROSS JOIN LATERAL jsonb_array_elements(version.definition->'steps') step WHERE run.tenant_id=origin.tenant_id AND run.subject_id=p_case AND run.module='contract_staff'
 AND p_key=run.id::text||':'||(step->>'id') AND step->>'type' IN('notify','sendEmail');
 IF run_id IS NULL OR app.contract_shared_effect_held(p_case,run_id,step_id,step_type) IS NOT TRUE THEN RAISE EXCEPTION 'This accepted step cannot queue an email' USING ERRCODE='42501';END IF;
 END IF;
 SELECT jsonb_build_object('eventId',origin.id,'decisionRevision',origin.decision_revision,'periodRevision',f.data->'period'->>'sourceRevision','subjectPersonId',coalesce(origin.data->>'sourcePersonId',employment.person_id::text),'employmentId',employment.id,
 'letterId',origin.data->>'letterId','approvalId',CASE WHEN origin.trigger_event='approvalActionNeeded' THEN origin.data->>'approvalId' END,'documentRevision',origin.data->'documentRevision') INTO context
 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 WHERE f.tenant_id=origin.tenant_id AND f.case_id=p_case;
 IF origin.actor_type='system' THEN context:=context||jsonb_build_object('systemJobId',origin.job_id);END IF;
 RETURN context;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_mail_context(uuid,text) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_delivery_eligible(p_tenant uuid,p_case uuid,p_context jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(
 SELECT 1 FROM app.contract_system_digest digest JOIN app.contract_system_job_source source ON source.job_id=digest.job_id AND source.tenant_id=digest.tenant_id AND source.kind='contract_schedule' AND source.cause='morning'
 JOIN public.bulk_job job ON job.id=source.job_id AND job.tenant_id=source.tenant_id AND job.created_by IS NULL AND job.kind=source.kind
 JOIN public.tenant tenant ON tenant.id=digest.tenant_id AND tenant.status IN('active','trial') JOIN public.company company ON company.tenant_id=digest.tenant_id AND company.id=digest.company_id AND company.archived_at IS NULL
 WHERE digest.tenant_id=p_tenant AND digest.case_id=p_case AND digest.mail_key=p_context->>'digestKey' AND digest.context->>'systemJobId'=p_context->>'systemJobId'
 AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=p_tenant AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.company_id IS NULL OR module.company_id=digest.company_id) AND (module.expires_at IS NULL OR module.expires_at>now()))
 AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(p_context->'recipientPeople') binding WHERE binding.key::uuid NOT IN(SELECT app.contract_shared_digest_recipients(p_tenant,digest.company_id)))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(digest.context->'cases') item WHERE NOT EXISTS(SELECT 1 FROM public.contract_case c JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id WHERE c.tenant_id=p_tenant AND c.id::text=item->>'caseId' AND c.company_id=digest.company_id AND employment.company_id=digest.company_id AND employment.person_id::text=item->>'personId')))
 OR EXISTS(
 SELECT 1 FROM public.contract_shared_event event JOIN app.contract_system_job_source source ON source.event_id=event.id AND source.tenant_id=event.tenant_id AND source.job_id=event.job_id AND source.kind='contract_scheduled_automation'
 JOIN public.bulk_job job ON job.id=source.job_id AND job.tenant_id=source.tenant_id AND job.created_by IS NULL AND job.kind=source.kind
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
CREATE OR REPLACE FUNCTION app.contract_shared_delivery_link(p_tenant uuid,p_case uuid,p_user uuid,p_context jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid;
BEGIN
 IF p_context->>'digestKey' IS NOT NULL AND EXISTS(SELECT 1 FROM app.contract_system_digest WHERE tenant_id=p_tenant AND case_id=p_case AND mail_key=p_context->>'digestKey') THEN RETURN '/lifecycle/contracts?attention=true&companyId='||(p_context->>'digestCompanyId');END IF;
 SELECT letter.id INTO target FROM public.contract_shared_letter letter WHERE letter.tenant_id=p_tenant AND letter.case_id=p_case AND letter.id::text=p_context->>'letterId';
 IF target IS NOT NULL THEN RETURN '/lifecycle/contracts/letters/'||target::text;END IF;
 SELECT approval.id INTO target FROM public.contract_shared_approval approval JOIN public.document_signing_document signing ON signing.tenant_id=approval.tenant_id AND signing.id=approval.signing_document_id
 WHERE approval.tenant_id=p_tenant AND approval.case_id=p_case AND approval.decision_revision::text=p_context->>'decisionRevision'
 AND EXISTS(SELECT 1 FROM app.document_signing_pending_steps(signing.data) step WHERE app.contract_shared_approval_eligible_user(p_tenant,approval.id,step->>'id',p_user))
 ORDER BY approval.created_at DESC,approval.id LIMIT 1;
 RETURN CASE WHEN target IS NOT NULL THEN '/lifecycle/contracts/approvals/'||target::text ELSE '/lifecycle/contracts/'||p_case::text END;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_delivery_link(uuid,uuid,uuid,jsonb) FROM PUBLIC,ai_hr_app;
