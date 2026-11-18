-- Private explicit-tenant extraction of the EXISTING canonical source/read leaves, same predicate bodies and old OID/ACL wrappers. No app grants, role/actor changes, GUC impersonation or duplicate PM/Payroll reader.
CREATE FUNCTION app.contract_source(p_tenant uuid,wanted_employment uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('employmentId',e.id,'companyId',e.company_id,'employmentType',a.employment_type,'eligible',a.employment_type='contract' AND c.pay_mode='monthly' AND c.payment_term='monthly' AND e.resignation_date IS NULL AND e.last_working_date IS NULL AND e.terminated_on IS NULL AND (fx.id IS NULL OR fx.currency='MYR') AND e.blacklisted_at IS NULL AND e.voided_at IS NULL AND co.archived_at IS NULL,'personId',e.person_id,'name',p.full_name,'employeeId',coalesce(e.employee_code,''),'startOn',e.contract_start_date,'endOn',e.contract_end_date,'businessGroupId',a.business_unit_id,'businessGroup',coalesce(bu.name,''),'manager',coalesce((SELECT mp.full_name FROM public.reporting_line rl JOIN public.employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id WHERE rl.tenant_id=e.tenant_id AND rl.subordinate_employment_id=e.id AND rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (rl.valid_to IS NULL OR rl.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY rl.valid_from DESC,rl.id LIMIT 1),''),'designation',coalesce(pos.title,''),'department',coalesce(dep.name,''),'grade',coalesce(g.code,''),'company',co.legal_name,'sourceIssue',CASE WHEN c.id IS NOT NULL AND (c.pay_mode<>'monthly' OR c.payment_term<>'monthly') THEN 'unsupported_pay_basis' WHEN c.id IS NOT NULL AND c.currency IS DISTINCT FROM 'MYR' OR fx.id IS NOT NULL AND fx.currency IS DISTINCT FROM 'MYR' THEN 'unsupported_currency' END,'salaryCents',CASE WHEN c.pay_mode='monthly' AND c.payment_term='monthly' THEN (c.basic_salary*100)::bigint::text END,'allowanceCents',CASE WHEN pc.id IS NOT NULL AND (fx.id IS NULL OR fx.currency='MYR') THEN (coalesce(fx.amount,0)*100)::bigint::text END,'allowanceComponentId',pc.id,'fixedAllowanceId',fx.id,'compensationId',c.id,'currency',c.currency,'sourceRevision',encode(sha256(convert_to(jsonb_build_array(e.id,e.company_id,e.contract_start_date,e.contract_end_date,e.terminated_on,e.resignation_date,e.last_working_date,e.blacklisted_at,e.grade_id,p.full_name,co.legal_name,(SELECT jsonb_agg(jsonb_build_array(r.id,r.manager_employment_id) ORDER BY r.id) FROM public.reporting_line r WHERE r.tenant_id=e.tenant_id AND r.subordinate_employment_id=e.id AND r.line_type='administrative' AND r.manager_employment_id<>r.subordinate_employment_id AND r.superseded_at IS NULL AND r.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (r.valid_to IS NULL OR r.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)),a.id,a.business_unit_id,c.id,c.basic_salary,pc.id,fx.id,fx.amount,fx.currency,c.currency,c.pay_mode,c.payment_term,c.rate_amount)::text,'UTF8')),'hex'),'ended',least(e.resignation_date,e.last_working_date,e.terminated_on)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT x.* FROM public.assignment x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.superseded_at IS NULL AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY x.valid_from DESC,x.id LIMIT 1) a ON true
 LEFT JOIN public.business_unit bu ON bu.id=a.business_unit_id AND bu.tenant_id=e.tenant_id
 LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id LEFT JOIN public.department dep ON dep.id=a.department_id AND dep.tenant_id=e.tenant_id LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT x.* FROM public.compensation x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.superseded_at IS NULL AND x.valid_from<=greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date) AND (x.valid_to IS NULL OR x.valid_to>greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date)) ORDER BY x.valid_from DESC,x.id LIMIT 1) c ON true
 LEFT JOIN public.contract_configuration cfg ON cfg.company_id=e.company_id AND cfg.tenant_id=e.tenant_id
 LEFT JOIN public.pay_component pc ON pc.id=(cfg.data->>'allowanceComponentId')::uuid AND pc.tenant_id=e.tenant_id AND pc.kind='allowance' AND pc.archived_at IS NULL AND pc.pending_input_kind IS NULL AND (pc.rule IS NULL OR pc.rule->>'kind'='fixed')
 LEFT JOIN LATERAL(SELECT x.* FROM public.employment_pay_component x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.component_id=pc.id AND x.superseded_at IS NULL AND x.valid_from<=greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date) AND (x.valid_to IS NULL OR x.valid_to>=greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date)) ORDER BY x.valid_from DESC,x.id LIMIT 1) fx ON true
 WHERE e.id=wanted_employment AND e.tenant_id=p_tenant; $$;
REVOKE ALL ON FUNCTION app.contract_source(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_source(wanted_employment uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_source(app.current_tenant_id(),wanted_employment) $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_binding_person(p_tenant uuid,wanted_user uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT u.person_id FROM public.app_user u WHERE u.id=wanted_user AND u.tenant_id=p_tenant; $$;
REVOKE ALL ON FUNCTION app.contract_binding_person(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_binding_person(wanted_user uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_binding_person(app.current_tenant_id(),wanted_user) $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_company_entitled(p_tenant uuid,wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM public.company co JOIN public.tenant t ON t.id=co.tenant_id WHERE co.id=wanted_company AND co.tenant_id=p_tenant AND t.status IN('active','trial') AND EXISTS(SELECT 1 FROM public.tenant_module tm WHERE tm.tenant_id=co.tenant_id AND tm.module_code='lifecycle' AND tm.status IN('active','trial') AND (tm.expires_at IS NULL OR tm.expires_at>now()) AND (tm.company_id IS NULL OR tm.company_id=co.id))); $$;
REVOKE ALL ON FUNCTION app.contract_company_entitled(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_company_entitled(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_company_entitled(app.current_tenant_id(),wanted_company) $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_case_company_current(p_tenant uuid,wanted_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM public.contract_case c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id WHERE c.id=wanted_case AND c.tenant_id=p_tenant); $$;
REVOKE ALL ON FUNCTION app.contract_case_company_current(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_case_company_current(wanted_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_case_company_current(app.current_tenant_id(),wanted_case) $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_period_revision(p_tenant uuid,p_employment uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(e.id,e.person_id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,a.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex')
 FROM public.employment e LEFT JOIN LATERAL(SELECT employment_type FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) a ON true
 WHERE e.tenant_id=p_tenant AND e.id=p_employment
$$;
REVOKE ALL ON FUNCTION app.contract_shared_period_revision(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_period_revision(p_employment uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_shared_period_revision(app.current_tenant_id(),p_employment) $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_native_intake_hold(p_tenant uuid,p_employment uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH source AS MATERIALIZED(SELECT app.contract_source(p_tenant,p_employment) AS data)
 SELECT CASE WHEN custody.verified_at IS NULL THEN 'health_pending' ELSE 'intake_required' END
 FROM source JOIN public.contract_retirement_custody custody ON custody.tenant_id=p_tenant
 AND custody.employment_id=p_employment AND custody.company_id::text=source.data->>'companyId'
 AND custody.source_revision=source.data->>'sourceRevision' AND custody.withdrawn_at IS NULL
 ORDER BY custody.captured_at DESC,custody.id LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.contract_shared_native_intake_hold(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_native_intake_hold(p_employment uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_shared_native_intake_hold(app.current_tenant_id(),p_employment) $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_decision_current(p_tenant uuid,p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
 JOIN public.contract_shared_event e ON e.tenant_id=f.tenant_id AND e.case_id=f.case_id AND e.trigger_event='decisionSubmitted' AND e.decision_revision=p_revision
 WHERE f.tenant_id=p_tenant AND f.case_id=p_case AND (f.data->'decision'->>'revision')::integer=p_revision
 AND f.data->'period'->>'sourceRevision'=app.contract_shared_period_revision(p_tenant,c.employment_id)
 AND app.contract_case_company_current(p_tenant,c.id) AND c.source_conflict IS NULL
 AND e.actor_person_id=app.contract_binding_person(p_tenant,e.actor_user_id)
 AND app.contract_shared_native_intake_hold(p_tenant,c.employment_id) IS NULL)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_decision_current(uuid,uuid,integer) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_decision_current(p_case uuid,p_revision integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_shared_decision_current(app.current_tenant_id(),p_case,p_revision) $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_document_current(p_tenant uuid,p_letter uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_letter l JOIN public.contract_shared_case f ON f.tenant_id=l.tenant_id AND f.case_id=l.case_id
 JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id AND employment.company_id=c.company_id
 JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=l.tenant_id AND pin.case_id=l.case_id AND pin.workflow_run_id=l.workflow_run_id AND pin.workflow_step_id=l.workflow_step_id AND pin.company_id=c.company_id AND pin.subject_person_id=employment.person_id AND pin.decision_revision=l.decision_revision AND pin.email_template_id::text=l.data->'emailTemplateRef'->>'id' AND pin.email_revision::text=l.data->'emailTemplateRef'->>'revision'
 WHERE l.tenant_id=p_tenant AND l.id=p_letter AND l.purpose='email' AND app.contract_company_entitled(p_tenant,c.company_id) AND employment.person_id::text=l.data->>'subjectPersonId' AND employment.voided_at IS NULL
 AND (pin.documents->>(l.data->>'templateId')=l.id::text OR NOT EXISTS(SELECT 1 FROM public.document_signing_document d WHERE d.tenant_id=l.tenant_id AND d.id=l.signing_document_id) AND app.contract_shared_effect_held(l.case_id,l.workflow_run_id,l.workflow_step_id,'sendEmail'))
 AND (l.decision_revision=0 OR (f.data->'decision'->>'revision')::integer=l.decision_revision OR EXISTS(SELECT 1 FROM jsonb_array_elements(f.data->'decisionHistory') decision WHERE (decision->>'revision')::integer=l.decision_revision)))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_document_current(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_email_document_current(p_letter uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_shared_email_document_current(app.current_tenant_id(),p_letter) $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_signer_values(p_tenant uuid,p_letter uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH letter AS MATERIALIZED(
 SELECT l.data,c.company_id,employment.person_id FROM public.contract_shared_letter l JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id
 JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id WHERE l.tenant_id=p_tenant AND l.id=p_letter),
 steps AS MATERIALIZED(SELECT step FROM letter CROSS JOIN LATERAL jsonb_array_elements(letter.data->'signingPolicy'->'route'->'steps') step LIMIT 30),
 holders AS MATERIALIZED(
 SELECT step->>'id' AS step_id,coalesce(step->>'label','Authorised signatory') AS label,person.id AS person_id,person.full_name
 FROM steps CROSS JOIN letter LEFT JOIN public.app_user account ON account.tenant_id=p_tenant AND account.id::text=step->>'holderId' AND account.person_id::text=step->>'holderPersonId'
 LEFT JOIN public.person person ON person.tenant_id=p_tenant AND person.id=coalesce(account.person_id,CASE WHEN step->>'role'='employee' AND step->>'holderId' IS NULL THEN letter.person_id END)),
 titles AS MATERIALIZED(
 SELECT DISTINCT ON(employment.person_id) employment.person_id,left(position.title,200) AS title
 FROM public.employment employment JOIN public.assignment assignment ON assignment.tenant_id=employment.tenant_id AND assignment.employment_id=employment.id
 JOIN public.position position ON position.tenant_id=assignment.tenant_id AND position.id=assignment.position_id CROSS JOIN letter
 WHERE employment.tenant_id=p_tenant AND employment.person_id IN(SELECT person_id FROM holders) AND employment.voided_at IS NULL AND employment.blacklisted_at IS NULL
 AND employment.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (least(employment.terminated_on,employment.resignation_date,employment.last_working_date) IS NULL OR least(employment.terminated_on,employment.resignation_date,employment.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND assignment.superseded_at IS NULL AND assignment.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (assignment.valid_to IS NULL OR assignment.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 ORDER BY employment.person_id,(employment.company_id=letter.company_id) DESC,employment.hired_on DESC,assignment.valid_from DESC,employment.id,assignment.id)
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM holders LEFT JOIN titles ON titles.person_id=holders.person_id
 CROSS JOIN LATERAL(VALUES('signingStep.'||holders.step_id||'.name',coalesce(holders.full_name,'')),('signingStep.'||holders.step_id||'.title',coalesce(titles.title,'')),('signingStep.'||holders.step_id||'.label',holders.label)) fields(key,value)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_signer_values(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_letter_signer_values(p_letter uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_shared_letter_signer_values(app.current_tenant_id(),p_letter) $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_values_before_form_protocol(p_tenant uuid,p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f jsonb;s jsonb;amount text;values jsonb;signers jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=p_letter;
 IF l.id IS NULL THEN RETURN NULL;END IF;
 IF l.data->'valuesFixed'='true'::jsonb OR (app.contract_shared_decision_current(p_tenant,l.case_id,l.decision_revision) IS NOT TRUE AND NOT (l.purpose='email' AND l.decision_revision=0 AND app.contract_shared_email_document_current(p_tenant,l.id) AND app.contract_shared_delivery_period_current(l.tenant_id,l.case_id))) THEN RETURN l.data->'values';END IF;
 SELECT c.data,app.contract_source(p_tenant,k.employment_id) INTO f,s FROM public.contract_shared_case c JOIN public.contract_case k ON k.tenant_id=c.tenant_id AND k.id=c.case_id WHERE c.tenant_id=l.tenant_id AND c.case_id=l.case_id;
 IF l.purpose='email' AND l.decision_revision=0 THEN f:=jsonb_set(f,'{decision}','null'::jsonb);END IF;
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
 IF l.purpose='email' AND l.decision_revision=0 THEN values:=values||jsonb_build_object('contract.newStart','','contract.newEnd','','contract.term','','contract.salary','','contract.reason','');END IF;
 RETURN values||signers||app.contract_shared_letter_signer_values(p_tenant,l.id);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_values_before_form_protocol(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_letter_values_before_form_protocol(p_letter uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_shared_letter_values_before_form_protocol(app.current_tenant_id(),p_letter) $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_personnel_source(p_tenant uuid,p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;subject uuid;country text;profile jsonb;statutory jsonb:='{}'::jsonb;requested text[];stat_keys text[];source_values jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=p_letter;
 IF l.id IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(l.data->'definition'->'blocks') block WHERE block->>'type' IN('field','fields')) THEN RETURN '{}'::jsonb;END IF;

 requested:=app.contract_shared_form_published_keys(p_tenant,p_letter);
 IF NOT EXISTS(SELECT 1 FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id JOIN public.company company ON company.tenant_id=c.tenant_id AND company.id=c.company_id JOIN public.tenant tenant ON tenant.id=c.tenant_id WHERE c.tenant_id=p_tenant AND c.id=l.case_id AND e.person_id::text=l.data->>'subjectPersonId' AND e.voided_at IS NULL AND company.archived_at IS NULL AND tenant.status IN('active','trial') AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=p_tenant AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.company_id IS NULL OR module.company_id=c.company_id) AND (module.expires_at IS NULL OR module.expires_at>now()))) THEN RAISE EXCEPTION 'The Form source is unavailable' USING ERRCODE='42501';END IF;
 IF l.data->'valuesFixed'='true'::jsonb OR app.contract_shared_delivery_period_current(l.tenant_id,l.case_id) IS NOT TRUE THEN RETURN coalesce((SELECT jsonb_object_agg(key,l.data->'values'->key) FROM unnest(requested) key WHERE l.data->'values' ? key),'{}'::jsonb);END IF;
 SELECT p.id,company.country,jsonb_build_object('name',p.full_name,'email',p.primary_email,'mobile',coalesce(p.phone,''),'homePhone',coalesce(p.home_phone,''),
 'personalEmail',coalesce(p.personal_email,''),'address',coalesce(nullif(p.address,''),concat_ws(', ',p.permanent_address_line1,p.permanent_address_line2,p.permanent_address_line3,p.permanent_postcode,p.permanent_city,p.permanent_state,p.permanent_country)),
 'race',coalesce(p.race,''),'religion',coalesce(p.religion,''),'nationality',coalesce(p.nationality,''),'gender',initcap(coalesce(p.gender::text,'')),'marital',initcap(coalesce(p.marital_status::text,'')),
 'emName',coalesce(ec.full_name,''),'emRel',coalesce(ec.relationship,''),'emPhone',coalesce(ec.mobile_phone,'')) INTO subject,country,profile
 FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id
 JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id JOIN public.company company ON company.tenant_id=e.tenant_id AND company.id=e.company_id
 LEFT JOIN LATERAL(SELECT * FROM public.person_emergency_contact contact WHERE contact.tenant_id=p.tenant_id AND contact.person_id=p.id AND contact.archived_at IS NULL ORDER BY CASE contact.priority WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END,contact.created_at,contact.id LIMIT 1) ec ON true
 WHERE c.tenant_id=l.tenant_id AND c.id=l.case_id AND e.person_id::text=l.data->>'subjectPersonId' AND e.voided_at IS NULL;
 IF subject IS NULL THEN RAISE EXCEPTION 'The Form employee or company changed' USING ERRCODE='40001';END IF;

 SELECT coalesce(array_agg(key),'{}'::text[]) INTO stat_keys FROM(SELECT DISTINCT CASE requested_key WHEN 'employee.icNo' THEN 'icNo' WHEN 'employee.passportNo' THEN 'passportNo' ELSE requested_key END AS key FROM unnest(requested) requested_key) sources WHERE key=ANY(ARRAY['icNo','passportNo','bankName','bankAcc','epfNo','taxNo']);
 IF cardinality(stat_keys)>0 THEN statutory:=app.document_country_merge_values(p_tenant,country,subject,stat_keys);END IF;
 source_values:=coalesce(app.contract_shared_letter_values_before_form_protocol(p_tenant,l.id),'{}'::jsonb)||profile||statutory||jsonb_build_object('employee.name',profile->>'name','employee.icNo',coalesce(statutory->>'icNo',''),'employee.passportNo',coalesce(statutory->>'passportNo',''));
 RETURN coalesce((SELECT jsonb_object_agg(key,source_values->key) FROM unnest(requested) key WHERE source_values ? key),'{}'::jsonb);
END $$;