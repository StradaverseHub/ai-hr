-- Finite existing-HR source aliases and actual employment dates; only selected published sources. Required/conditional/ownership/signature/privacy gates remain canonical. Fixed snapshots receive no new alias interpretation.
CREATE OR REPLACE FUNCTION app.contract_source(p_tenant uuid,wanted_employment uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('employmentId',e.id,'hiredOn',e.hired_on,'lastWorkingDate',e.last_working_date,'companyId',e.company_id,'employmentType',a.employment_type,'eligible',a.employment_type='contract' AND c.pay_mode='monthly' AND c.payment_term='monthly' AND e.resignation_date IS NULL AND e.last_working_date IS NULL AND e.terminated_on IS NULL AND (fx.id IS NULL OR fx.currency='MYR') AND e.blacklisted_at IS NULL AND e.voided_at IS NULL AND co.archived_at IS NULL,'personId',e.person_id,'name',p.full_name,'employeeId',coalesce(e.employee_code,''),'startOn',e.contract_start_date,'endOn',e.contract_end_date,'businessGroupId',a.business_unit_id,'businessGroup',coalesce(bu.name,''),'manager',coalesce((SELECT mp.full_name FROM public.reporting_line rl JOIN public.employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id WHERE rl.tenant_id=e.tenant_id AND rl.subordinate_employment_id=e.id AND rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (rl.valid_to IS NULL OR rl.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY rl.valid_from DESC,rl.id LIMIT 1),''),'designation',coalesce(pos.title,''),'department',coalesce(dep.name,''),'grade',coalesce(g.code,''),'company',co.legal_name,'sourceIssue',CASE WHEN c.id IS NOT NULL AND (c.pay_mode<>'monthly' OR c.payment_term<>'monthly') THEN 'unsupported_pay_basis' WHEN c.id IS NOT NULL AND c.currency IS DISTINCT FROM 'MYR' OR fx.id IS NOT NULL AND fx.currency IS DISTINCT FROM 'MYR' THEN 'unsupported_currency' END,'salaryCents',CASE WHEN c.pay_mode='monthly' AND c.payment_term='monthly' THEN (c.basic_salary*100)::bigint::text END,'allowanceCents',CASE WHEN pc.id IS NOT NULL AND (fx.id IS NULL OR fx.currency='MYR') THEN (coalesce(fx.amount,0)*100)::bigint::text END,'allowanceComponentId',pc.id,'fixedAllowanceId',fx.id,'compensationId',c.id,'currency',c.currency,'sourceRevision',encode(sha256(convert_to(jsonb_build_array(e.id,e.company_id,e.contract_start_date,e.contract_end_date,e.terminated_on,e.resignation_date,e.last_working_date,e.blacklisted_at,e.grade_id,p.full_name,co.legal_name,(SELECT jsonb_agg(jsonb_build_array(r.id,r.manager_employment_id) ORDER BY r.id) FROM public.reporting_line r WHERE r.tenant_id=e.tenant_id AND r.subordinate_employment_id=e.id AND r.line_type='administrative' AND r.manager_employment_id<>r.subordinate_employment_id AND r.superseded_at IS NULL AND r.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (r.valid_to IS NULL OR r.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)),a.id,a.business_unit_id,c.id,c.basic_salary,pc.id,fx.id,fx.amount,fx.currency,c.currency,c.pay_mode,c.payment_term,c.rate_amount)::text,'UTF8')),'hex'),'ended',least(e.resignation_date,e.last_working_date,e.terminated_on)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT x.* FROM public.assignment x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.superseded_at IS NULL AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY x.valid_from DESC,x.id LIMIT 1) a ON true
 LEFT JOIN public.business_unit bu ON bu.id=a.business_unit_id AND bu.tenant_id=e.tenant_id
 LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id LEFT JOIN public.department dep ON dep.id=a.department_id AND dep.tenant_id=e.tenant_id LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT x.* FROM public.compensation x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.superseded_at IS NULL AND x.valid_from<=greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date) AND (x.valid_to IS NULL OR x.valid_to>greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date)) ORDER BY x.valid_from DESC,x.id LIMIT 1) c ON true
 LEFT JOIN public.contract_configuration cfg ON cfg.company_id=e.company_id AND cfg.tenant_id=e.tenant_id
 LEFT JOIN public.pay_component pc ON pc.id=(cfg.data->>'allowanceComponentId')::uuid AND pc.tenant_id=e.tenant_id AND pc.kind='allowance' AND pc.archived_at IS NULL AND pc.pending_input_kind IS NULL AND (pc.rule IS NULL OR pc.rule->>'kind'='fixed')
 LEFT JOIN LATERAL(SELECT x.* FROM public.employment_pay_component x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.component_id=pc.id AND x.superseded_at IS NULL AND x.valid_from<=greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date) AND (x.valid_to IS NULL OR x.valid_to>=greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date)) ORDER BY x.valid_from DESC,x.id LIMIT 1) fx ON true
 WHERE e.id=wanted_employment AND e.tenant_id=p_tenant; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_source(wanted_employment uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_source(app.current_tenant_id(),wanted_employment)-'hiredOn'-'lastWorkingDate' $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_reference_key(p_token text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$ SELECT CASE lower(btrim(p_token)) WHEN 'agreed basic salary' THEN 'contract.salary' WHEN 'basic salary' THEN 'contract.salary' WHEN 'business group' THEN 'org.businessGroup' WHEN 'case.link' THEN 'case.link' WHEN 'company' THEN 'org.company' WHEN 'contract end date' THEN 'contract.end' WHEN 'contract number' THEN 'contract.number' WHEN 'contract start date' THEN 'contract.start' WHEN 'contract.end' THEN 'contract.end' WHEN 'contract.lastday' THEN 'contract.end' WHEN 'contract.newend' THEN 'contract.newEnd' WHEN 'contract.newstart' THEN 'contract.newStart' WHEN 'contract.number' THEN 'contract.number' WHEN 'contract.reason' THEN 'contract.reason' WHEN 'contract.salary' THEN 'contract.salary' WHEN 'contract.start' THEN 'contract.start' WHEN 'contract.term' THEN 'contract.term' WHEN 'current contract end' THEN 'contract.end' WHEN 'current contract start' THEN 'contract.start' WHEN 'decision notes' THEN 'contract.reason' WHEN 'decision reason' THEN 'contract.reason' WHEN 'department' THEN 'org.department' WHEN 'direct superior' THEN 'people.lineManager' WHEN 'document name' THEN 'letter.documentName' WHEN 'employee id' THEN 'employee.id' WHEN 'employee name' THEN 'employee.name' WHEN 'employee number' THEN 'employee.id' WHEN 'employee.bg' THEN 'org.businessGroup' WHEN 'employee.company' THEN 'org.company' WHEN 'employee.dept' THEN 'org.department' WHEN 'employee.id' THEN 'employee.id' WHEN 'employee.jobtitle' THEN 'employee.jobTitle' WHEN 'employee.name' THEN 'employee.name' WHEN 'employee.no' THEN 'employee.id' WHEN 'employee.position' THEN 'employee.jobTitle' WHEN 'employee.supervisor' THEN 'people.lineManager' WHEN 'full name' THEN 'employee.name' WHEN 'job title' THEN 'employee.jobTitle' WHEN 'letter.documentname' THEN 'letter.documentName' WHEN 'letter.sentbackby' THEN 'letter.sentBackBy' WHEN 'letter.sentbackreason' THEN 'letter.sentBackReason' WHEN 'letter.signingstep' THEN 'letter.signingStep' WHEN 'link to case' THEN 'case.link' WHEN 'new end date' THEN 'contract.newEnd' WHEN 'new start date' THEN 'contract.newStart' WHEN 'org.businessgroup' THEN 'org.businessGroup' WHEN 'org.company' THEN 'org.company' WHEN 'org.department' THEN 'org.department' WHEN 'people.linemanager' THEN 'people.lineManager' WHEN 'position' THEN 'employee.jobTitle' WHEN 'reason sent back' THEN 'letter.sentBackReason' WHEN 'sent back by' THEN 'letter.sentBackBy' WHEN 'signing step' THEN 'letter.signingStep' WHEN 'term' THEN 'contract.term' WHEN 'today' THEN 'today' WHEN 'today''s date' THEN 'today' WHEN 'today’s date' THEN 'today' WHEN 'employee.empno' THEN 'employee.id' WHEN 'empno' THEN 'employee.id' WHEN 'employee.department' THEN 'org.department' WHEN 'company.name' THEN 'org.company' WHEN 'employee.businessunit' THEN 'group' WHEN 'joiner.joindate' THEN 'joiner.joinDate' WHEN 'join date' THEN 'joiner.joinDate' WHEN 'leaver.lastday' THEN 'leaver.lastDay' WHEN 'last working date' THEN 'leaver.lastDay' WHEN 'name' THEN 'name' WHEN 'email' THEN 'email' WHEN 'work email' THEN 'email' WHEN 'mobile' THEN 'mobile' WHEN 'mobile phone number' THEN 'mobile' WHEN 'homephone' THEN 'homePhone' WHEN 'home phone number' THEN 'homePhone' WHEN 'personalemail' THEN 'personalEmail' WHEN 'personal email' THEN 'personalEmail' WHEN 'race' THEN 'race' WHEN 'religion' THEN 'religion' WHEN 'nationality' THEN 'nationality' WHEN 'gender' THEN 'gender' WHEN 'marital' THEN 'marital' WHEN 'marital status' THEN 'marital' WHEN 'address' THEN 'address' WHEN 'emname' THEN 'emName' WHEN 'emrel' THEN 'emRel' WHEN 'emphone' THEN 'emPhone' WHEN 'group' THEN 'group' WHEN 'icno' THEN 'icNo' WHEN 'passportno' THEN 'passportNo' WHEN 'bankname' THEN 'bankName' WHEN 'bankacc' THEN 'bankAcc' WHEN 'epfno' THEN 'epfNo' WHEN 'taxno' THEN 'taxNo' WHEN 'employee.icno' THEN 'employee.icNo' WHEN 'employee.passportno' THEN 'employee.passportNo' WHEN 'ic number' THEN 'employee.icNo' WHEN 'identity card number' THEN 'icNo' WHEN 'employee identity card number' THEN 'employee.icNo' WHEN 'passport number' THEN 'passportNo' WHEN 'employee passport number' THEN 'employee.passportNo' WHEN 'bank name' THEN 'bankName' WHEN 'bank account number' THEN 'bankAcc' WHEN 'epf number' THEN 'epfNo' WHEN 'tax number' THEN 'taxNo' ELSE btrim(p_token) END $$;
--> statement-breakpoint
-- New human display aliases do not themselves request additional PM data. Explicit published pmKey fields
-- and canonical PM tokens select sources; a display alias may only copy an already-selected canonical value.
CREATE FUNCTION app.contract_shared_form_published_token_key(p_token text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN lower(btrim(p_token))=ANY(ARRAY['join date','last working date','work email','mobile phone number','home phone number','personal email','marital status','ic number','identity card number','employee identity card number','passport number','employee passport number','bank name','bank account number','epf number','tax number']) THEN NULL ELSE app.contract_shared_form_reference_key(p_token) END
$$;
REVOKE ALL ON FUNCTION app.contract_shared_form_published_token_key(text) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_form_published_keys(p_tenant uuid,p_letter uuid) RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(DISTINCT key) FILTER(WHERE nullif(key,'') IS NOT NULL),'{}'::text[]) FROM(
 SELECT app.contract_shared_form_reference_key(field->>'pmKey') AS key FROM public.contract_shared_letter l CROSS JOIN LATERAL jsonb_array_elements(l.data->'definition'->'fields') field WHERE l.tenant_id=p_tenant AND l.id=p_letter
 UNION ALL SELECT app.contract_shared_form_published_token_key(match[1]) FROM public.contract_shared_letter l CROSS JOIN LATERAL jsonb_array_elements(l.data->'definition'->'blocks') block CROSS JOIN LATERAL regexp_matches(coalesce(block->>'text','')||' '||coalesce(block->>'rows','')||' '||coalesce(block->>'label',''),'\{([^{}]+)\}','g') match WHERE l.tenant_id=p_tenant AND l.id=p_letter
 ) selected
$$;

--> statement-breakpoint
-- Exact existing V9 personnelFieldSourceValue semantics: text preserves the source, date controls receive ISO.
CREATE FUNCTION app.document_form_personnel_field_value(p_field jsonb,p_value text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE candidate text:=coalesce(p_value,'');parsed date;
BEGIN
 IF p_field->>'type'<>'date' THEN RETURN candidate;END IF;
 IF candidate ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' THEN candidate:=substr(candidate,7,4)||'-'||substr(candidate,4,2)||'-'||substr(candidate,1,2);END IF;
 IF candidate !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN '';END IF;
 BEGIN parsed:=make_date(substr(candidate,1,4)::integer,substr(candidate,6,2)::integer,substr(candidate,9,2)::integer);EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN '';END;
 RETURN CASE WHEN to_char(parsed,'YYYY-MM-DD')=candidate THEN candidate ELSE '' END;
END $$;
CREATE FUNCTION app.document_form_required_missing(p_field jsonb,p_value text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p_field->'required'='true'::jsonb AND (btrim(coalesce(p_value,''))='' OR p_field->>'type'='checkbox' AND p_value<>'true' OR p_field->>'type'='table' AND p_value='[]'),false)
$$;
REVOKE ALL ON FUNCTION app.document_form_personnel_field_value(jsonb,text),app.document_form_required_missing(jsonb,text) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_letter_context_aliases(p_tenant uuid,p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f jsonb;source jsonb;amount text;aliases jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=p_letter;
 IF l.id IS NULL OR l.data->'letterheadSnapshot' IS NULL OR l.data->'valuesFixed'='true'::jsonb OR app.contract_shared_decision_current(p_tenant,l.case_id,l.decision_revision) IS NOT TRUE THEN RETURN '{}'::jsonb;END IF;
 SELECT flow.data,app.contract_source(p_tenant,c.employment_id) INTO f,source FROM public.contract_shared_case flow JOIN public.contract_case c ON c.tenant_id=flow.tenant_id AND c.id=flow.case_id WHERE flow.tenant_id=l.tenant_id AND flow.case_id=l.case_id;
 amount:=source->>'allowanceCents';
 aliases:=jsonb_build_object('decision.type',CASE f->'decision'->>'kind' WHEN 'renew' THEN 'Renew' WHEN 'convert' THEN 'Convert to permanent' WHEN 'end' THEN 'End' ELSE '' END,'decision.reason',coalesce(f->'decision'->>'reason',''),'decision.endReason',coalesce(f->'decision'->>'endReason',''),'decision.declineReason',coalesce(f->'declined'->>'reason',''),'contract.lastDay',coalesce(f->'period'->>'endOn',''),'contract.allowance',CASE WHEN amount ~ '^[0-9]+$' THEN (amount::bigint/100)::text||'.'||lpad((amount::bigint%100)::text,2,'0') ELSE '' END);
 RETURN aliases;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_context_aliases(uuid,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_values(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;values jsonb;aliases jsonb;definition text;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 values:=app.contract_shared_letter_values_before_shared_letterhead(p_letter)||coalesce(l.data->'letterheadSnapshot','{}'::jsonb);
 IF l.data->>'formProtocol'='1' AND app.contract_shared_form_source_current(l.id) IS NOT TRUE THEN RETURN values;END IF;
 IF l.data->'letterheadSnapshot' IS NULL OR l.data->'valuesFixed'='true'::jsonb OR app.contract_shared_decision_current(l.case_id,l.decision_revision) IS NOT TRUE THEN RETURN values;END IF;
 aliases:=app.contract_shared_letter_context_aliases(l.tenant_id,p_letter);
 definition:=(l.data->'definition')::text||coalesce(l.data->'blocks','{}'::jsonb)::text;
 RETURN values||coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(aliases) WHERE (strpos(definition,'{'||key||'}')>0 OR strpos(definition,'"'||key||'"')>0) AND (l.data->>'formProtocol' IS DISTINCT FROM '1' OR key=ANY(app.contract_shared_form_published_keys(p_letter)))),'{}'::jsonb);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_personnel_source(p_tenant uuid,p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;subject uuid;country text;profile jsonb;statutory jsonb:='{}'::jsonb;requested text[];stat_keys text[];source_values jsonb;native_source jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=p_letter;
 IF l.id IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(l.data->'definition'->'blocks') block WHERE block->>'type' IN('field','fields')) THEN RETURN '{}'::jsonb;END IF;

 requested:=app.contract_shared_form_published_keys(p_tenant,p_letter);
 IF NOT EXISTS(SELECT 1 FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id JOIN public.company company ON company.tenant_id=c.tenant_id AND company.id=c.company_id JOIN public.tenant tenant ON tenant.id=c.tenant_id WHERE c.tenant_id=p_tenant AND c.id=l.case_id AND e.person_id::text=l.data->>'subjectPersonId' AND e.voided_at IS NULL AND company.archived_at IS NULL AND tenant.status IN('active','trial') AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=p_tenant AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.company_id IS NULL OR module.company_id=c.company_id) AND (module.expires_at IS NULL OR module.expires_at>now()))) THEN RAISE EXCEPTION 'The Form source is unavailable' USING ERRCODE='42501';END IF;
 IF l.data->'valuesFixed'='true'::jsonb OR (app.contract_shared_delivery_period_current(l.tenant_id,l.case_id) IS NOT TRUE AND NOT (l.purpose='email' AND app.contract_shared_email_document_native_current(p_tenant,l.id))) THEN RETURN coalesce((SELECT jsonb_object_agg(key,l.data->'values'->key) FROM unnest(requested) key WHERE l.data->'values' ? key),'{}'::jsonb);END IF;
 SELECT p.id,company.country,jsonb_build_object('name',p.full_name,'email',p.primary_email,'mobile',coalesce(p.phone,''),'homePhone',coalesce(p.home_phone,''),
 'personalEmail',coalesce(p.personal_email,''),'address',coalesce(nullif(p.address,''),concat_ws(', ',p.permanent_address_line1,p.permanent_address_line2,p.permanent_address_line3,p.permanent_postcode,p.permanent_city,p.permanent_state,p.permanent_country)),
 'race',coalesce(p.race,''),'religion',coalesce(p.religion,''),'nationality',coalesce(p.nationality,''),'gender',initcap(coalesce(p.gender::text,'')),'marital',initcap(coalesce(p.marital_status::text,'')),
 'emName',coalesce(ec.full_name,''),'emRel',coalesce(ec.relationship,''),'emPhone',coalesce(ec.mobile_phone,'')),app.contract_source(p_tenant,e.id) INTO subject,country,profile,native_source
 FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id
 JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id JOIN public.company company ON company.tenant_id=e.tenant_id AND company.id=e.company_id
 LEFT JOIN LATERAL(SELECT * FROM public.person_emergency_contact contact WHERE contact.tenant_id=p.tenant_id AND contact.person_id=p.id AND contact.archived_at IS NULL ORDER BY CASE contact.priority WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END,contact.created_at,contact.id LIMIT 1) ec ON true
 WHERE c.tenant_id=l.tenant_id AND c.id=l.case_id AND e.person_id::text=l.data->>'subjectPersonId' AND e.voided_at IS NULL;
 IF subject IS NULL THEN RAISE EXCEPTION 'The Form employee or company changed' USING ERRCODE='40001';END IF;

 SELECT coalesce(array_agg(key),'{}'::text[]) INTO stat_keys FROM(SELECT DISTINCT CASE requested_key WHEN 'employee.icNo' THEN 'icNo' WHEN 'employee.passportNo' THEN 'passportNo' ELSE requested_key END AS key FROM unnest(requested) requested_key) sources WHERE key=ANY(ARRAY['icNo','passportNo','bankName','bankAcc','epfNo','taxNo']);
 IF cardinality(stat_keys)>0 THEN statutory:=app.document_country_merge_values(p_tenant,country,subject,stat_keys);END IF;
 source_values:=coalesce(app.contract_shared_letter_values_before_form_protocol(p_tenant,l.id),'{}'::jsonb)||app.contract_shared_letter_context_aliases(p_tenant,l.id)||jsonb_build_object('joiner.joinDate',coalesce(to_char((native_source->>'hiredOn')::date,'DD/MM/YYYY'),''),'leaver.lastDay',coalesce(to_char((native_source->>'lastWorkingDate')::date,'DD/MM/YYYY'),''),'group',coalesce(native_source->>'businessGroup',''))||profile||statutory||jsonb_build_object('employee.name',profile->>'name','employee.icNo',coalesce(statutory->>'icNo',''),'employee.passportNo',coalesce(statutory->>'passportNo',''));
 RETURN coalesce((SELECT jsonb_object_agg(key,source_values->key) FROM unnest(requested) key WHERE source_values ? key),'{}'::jsonb);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_values(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;r public.document_form_response;defaults jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO r FROM public.document_form_response WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id;
 IF r.document_id IS NULL OR r.source_person_id::text IS DISTINCT FROM l.data->>'subjectPersonId' THEN RAISE EXCEPTION 'Initialize the actual Form before continuing' USING ERRCODE='40001';END IF;
 IF r.locked_values IS NOT NULL THEN defaults:=r.locked_values;
 ELSE
  defaults:=coalesce(l.data->'values','{}'::jsonb)||app.contract_shared_form_personnel(p_letter);
  SELECT coalesce(jsonb_object_agg(field->>'id',app.document_form_personnel_field_value(field,coalesce(defaults->>app.contract_shared_form_reference_key(coalesce(nullif(field->>'pmKey',''),field->>'id')),''))),'{}'::jsonb) INTO defaults FROM jsonb_array_elements(l.data->'definition'->'fields') field;
 END IF;
 RETURN defaults||r.answers;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_resolved_values(p_tenant uuid,p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;r public.document_form_response;defaults jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=p_letter;
 SELECT * INTO r FROM public.document_form_response WHERE tenant_id=p_tenant AND document_id=l.signing_document_id AND source_person_id::text=l.data->>'subjectPersonId';
 IF r.document_id IS NULL THEN RETURN NULL;END IF;
 IF r.locked_values IS NOT NULL THEN defaults:=r.locked_values;
 ELSE
  defaults:=coalesce(l.data->'values','{}'::jsonb)||app.contract_shared_form_personnel_source(p_tenant,p_letter);
  SELECT coalesce(jsonb_object_agg(field->>'id',app.document_form_personnel_field_value(field,coalesce(defaults->>app.contract_shared_form_reference_key(coalesce(nullif(field->>'pmKey',''),field->>'id')),''))),'{}'::jsonb) INTO defaults FROM jsonb_array_elements(l.data->'definition'->'fields') field;
 END IF;
 RETURN defaults||r.answers;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_read(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;r public.document_form_response;values jsonb;scope text;editable jsonb;missing jsonb;receipts jsonb;
BEGIN
 IF app.contract_shared_document_kind(p_letter) IS DISTINCT FROM 'Form' THEN RETURN NULL;END IF;
 IF app.contract_shared_form_body_visible(p_letter) IS NOT TRUE THEN RETURN jsonb_build_object('letterId',p_letter,'kind','Form','visible',false);END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF app.contract_shared_form_source_current(p_letter) IS NOT TRUE AND l.data->>'state'<>'released' THEN RAISE EXCEPTION 'The Form source changed' USING ERRCODE='40001';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id WHERE c.tenant_id=l.tenant_id AND c.id=l.case_id AND e.person_id::text=l.data->>'subjectPersonId') THEN RAISE EXCEPTION 'The Form identity changed' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM public.document_form_response WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id;
 values:=app.contract_shared_form_values(p_letter);scope:=app.contract_shared_form_scope(p_letter);
 SELECT coalesce(jsonb_agg(field->>'id') FILTER(WHERE field->>'owner'=scope),'[]'::jsonb),coalesce(jsonb_agg(field->>'id') FILTER(WHERE field->>'owner'='pmLocked' AND app.document_form_required_missing(field,values->>(field->>'id')) AND (field->'when' IS NULL OR field->'when'='null'::jsonb OR values->>(field->'when'->>'field')=field->'when'->>'value')),'[]'::jsonb) INTO editable,missing FROM jsonb_array_elements(l.data->'definition'->'fields') field;
 SELECT coalesce(jsonb_agg(receipt.data||jsonb_build_object('actorName',action->>'actorName','at',action->>'at') ORDER BY receipt.recorded_at,receipt.action_id),'[]'::jsonb) INTO receipts FROM public.document_form_action_receipt receipt JOIN public.document_signing_document d ON d.tenant_id=receipt.tenant_id AND d.id=receipt.document_id CROSS JOIN LATERAL jsonb_array_elements(d.data->'actions') action WHERE receipt.tenant_id=l.tenant_id AND receipt.document_id=l.signing_document_id AND action->>'id'=receipt.action_id AND action->>'actorId'=receipt.data->>'actorUserId' AND action->>'actorPersonId'=receipt.data->>'actorPersonId';
 RETURN jsonb_build_object('letterId',l.id,'kind','Form','visible',true,'responseRevision',r.revision,'responseHash',app.contract_shared_form_hash(l.id),'values',values,'editableFieldIds',editable,'missingLockedFields',missing,'receipts',receipts,'legalBaseHash',encode(sha256(convert_to(app.contract_shared_letter_snapshot(l.id)::text,'UTF8')),'hex'));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_action_prepare(p_letter uuid,p_action_id text,p_step text,p_action text,p_base_revision integer,p_base_hash text,p_revision integer,p_hash text,p_signature jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;r public.document_form_response;document jsonb;scope text;values jsonb;field jsonb;value text;scope_ids jsonb;scope_values jsonb;intent public.document_form_action_intent;validate_all boolean;
BEGIN
 IF app.contract_shared_document_kind(p_letter) IS DISTINCT FROM 'Form' THEN RETURN NULL;END IF;
 PERFORM app.contract_shared_form_lock(p_letter);
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO r FROM public.document_form_response WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id;
 SELECT data INTO document FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id;
 IF p_action NOT IN('signed','reviewed','approved') THEN RETURN NULL;END IF;
 SELECT * INTO intent FROM public.document_form_action_intent WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id AND action_id=p_action_id;
 IF intent.action_id IS NOT NULL THEN
  IF intent.actor_user_id=app.current_user_id() AND intent.actor_person_id=app.contract_actor_person(app.current_user_id()) AND intent.base_revision=p_base_revision AND intent.base_hash=p_base_hash AND intent.response_revision=p_revision AND intent.response_hash=p_hash AND intent.step_id=p_step AND intent.action_kind=p_action AND intent.signature_hash=encode(sha256(convert_to(coalesce(p_signature,'null'::jsonb)::text,'UTF8')),'hex') AND EXISTS(SELECT 1 FROM jsonb_array_elements(document->'actions') receipt WHERE receipt->>'id'=p_action_id AND receipt->>'actorId'=app.current_user_id()::text AND receipt->>'actorPersonId'=app.contract_actor_person(app.current_user_id())::text AND receipt->>'contentHash'=intent.base_hash AND receipt->>'contentRevision'=intent.base_revision::text AND receipt->>'stepId'=intent.step_id AND receipt->>'action'=intent.action_kind) THEN RETURN jsonb_build_object('responseRevision',intent.response_revision,'responseHash',intent.response_hash);END IF;
  RAISE EXCEPTION 'Form action reference was already used' USING ERRCODE='40001';
 END IF;
 IF app.contract_shared_form_source_current(l.id) IS NOT TRUE OR app.contract_shared_signing_access('contract',l.id,'sign') IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'id'=p_step AND step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text) THEN RAISE EXCEPTION 'Only the pending Form actor can complete this step' USING ERRCODE='42501';END IF;
 IF l.data->>'contentRevision' IS DISTINCT FROM p_base_revision::text OR encode(sha256(convert_to(app.contract_shared_letter_snapshot(l.id)::text,'UTF8')),'hex') IS DISTINCT FROM p_base_hash OR r.revision IS DISTINCT FROM p_revision OR app.contract_shared_form_hash(l.id) IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'The Form changed; review its current answers' USING ERRCODE='40001';END IF;
 scope:=CASE WHEN app.contract_actor_person(app.current_user_id())=r.source_person_id THEN 'employee' ELSE 'hr' END;values:=app.contract_shared_form_values(l.id);
 validate_all:=scope='employee' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(document->'route'->'steps') step WHERE step->>'required'='true' AND step->>'id'<>p_step AND NOT app.document_signing_step_fulfilled(document,step));
 FOR field IN SELECT * FROM jsonb_array_elements(l.data->'definition'->'fields') LOOP
  IF NOT validate_all AND field->>'owner'='employee' THEN CONTINUE;END IF;
  IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb AND values->>(field->'when'->>'field') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;
  value:=coalesce(values->>(field->>'id'),'');PERFORM app.document_form_field_validate(field,value);
  IF app.document_form_required_missing(field,value) THEN RAISE EXCEPTION 'Complete % before signing; Personnel-locked fields require source correction',field->>'label' USING ERRCODE='22023';END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(definition_field->>'id'),'[]'::jsonb),coalesce(jsonb_object_agg(definition_field->>'id',values->(definition_field->>'id')),'{}'::jsonb) INTO scope_ids,scope_values FROM jsonb_array_elements(l.data->'definition'->'fields') definition_field WHERE scope='employee' AND definition_field->>'owner'='employee' OR scope='hr' AND definition_field->>'owner'<>'employee';
 INSERT INTO public.document_form_action_intent(tenant_id,document_id,action_id,step_id,actor_user_id,actor_person_id,action_kind,base_revision,base_hash,response_revision,response_hash,signature_hash,scope,field_ids,values_snapshot) VALUES(l.tenant_id,l.signing_document_id,p_action_id,p_step,app.current_user_id(),app.contract_actor_person(app.current_user_id()),p_action,p_base_revision,p_base_hash,r.revision,p_hash,encode(sha256(convert_to(coalesce(p_signature,'null'::jsonb)::text,'UTF8')),'hex'),scope,scope_ids,scope_values);
 RETURN jsonb_build_object('responseRevision',r.revision,'responseHash',p_hash);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.document_form_field_validate(p_field jsonb,p_value text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row jsonb;table_rows jsonb;
BEGIN
 IF p_value IS NULL OR length(p_value)>20000 THEN RAISE EXCEPTION 'A Form field exceeds the allowed length' USING ERRCODE='22023';END IF;
 IF p_value='' THEN RETURN;END IF;
 IF p_field->>'type'='select' AND NOT(p_field->'options' ? p_value) THEN RAISE EXCEPTION 'Choose a valid option for %',p_field->>'label' USING ERRCODE='22023';END IF;
 IF p_field->>'type'='date' AND (app.document_form_personnel_field_value(p_field,p_value)='' OR app.document_form_personnel_field_value(p_field,p_value)<>p_value) THEN RAISE EXCEPTION 'Enter a valid date for %',p_field->>'label' USING ERRCODE='22023';END IF;
 IF p_field->>'type'='checkbox' AND p_value NOT IN('true','false') THEN RAISE EXCEPTION 'Choose a valid checkbox value' USING ERRCODE='22023';END IF;
 IF p_field->>'type'='number' AND (p_value !~ '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)$' OR lower(p_value) IN('nan','infinity','-infinity')) THEN RAISE EXCEPTION 'Enter a valid number' USING ERRCODE='22023';END IF;
 IF p_field->>'type'='email' AND p_value !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN RAISE EXCEPTION 'Enter a valid email' USING ERRCODE='22023';END IF;
 IF p_field->>'type'='table' THEN
  BEGIN table_rows:=p_value::jsonb;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Enter valid table rows' USING ERRCODE='22023';END;
  IF jsonb_typeof(table_rows)<>'array' OR jsonb_array_length(table_rows)>50 THEN RAISE EXCEPTION 'Enter valid table rows' USING ERRCODE='22023';END IF;
  FOR row IN SELECT * FROM jsonb_array_elements(table_rows) LOOP
   IF jsonb_typeof(row)<>'array' OR jsonb_array_length(row)<>jsonb_array_length(coalesce(p_field->'columns','[]'::jsonb)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(row) cell WHERE jsonb_typeof(cell)<>'string' OR length(cell#>>'{}')>1000) THEN RAISE EXCEPTION 'Enter valid table cells' USING ERRCODE='22023';END IF;
  END LOOP;
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_document_readiness(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE letter public.contract_shared_letter;document jsonb;subject_person uuid;values jsonb;field jsonb;
BEGIN
 -- Private helper; only the held-step owner and the authenticated canonical progression trigger call it.
 -- No application EXECUTE grant. A human-origin trigger retains its real actor, without impersonating owner.
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT data INTO document FROM public.document_signing_document WHERE tenant_id=letter.tenant_id AND id=letter.signing_document_id;
 SELECT employment.person_id INTO subject_person FROM public.contract_case c JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id AND employment.company_id=c.company_id WHERE c.tenant_id=letter.tenant_id AND c.id=letter.case_id;
 IF letter.id IS NULL OR document IS NULL OR app.contract_shared_email_document_native_current(letter.tenant_id,letter.id) IS NOT TRUE OR subject_person::text IS DISTINCT FROM letter.data->>'subjectPersonId' THEN RETURN jsonb_build_object('ready',false,'reason','source_changed');END IF;
 IF letter.data->>'state' IN('declined','withdrawn','superseded') THEN RETURN jsonb_build_object('ready',false,'reason','stopped');END IF;
 IF app.document_signing_returned(document) THEN RETURN jsonb_build_object('ready',false,'reason','returned');END IF;
 IF letter.data->>'state'='released' THEN RETURN jsonb_build_object('ready',true,'reason','released');END IF;
 IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'role'<>'employee') THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
 IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'role'='employee') THEN
  IF app.contract_shared_document_kind(letter.id)='Form' THEN
   values:=app.contract_shared_form_resolved_values(letter.tenant_id,letter.id);
   IF values IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
   FOR field IN SELECT * FROM jsonb_array_elements(letter.data->'definition'->'fields') WHERE value->>'owner'<>'employee' LOOP
    IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb AND values->>(field->'when'->>'field') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;
    IF app.document_form_required_missing(field,values->>(field->>'id')) THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
   END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step JOIN public.app_user account ON account.tenant_id=letter.tenant_id AND account.id::text=step->>'holderId' AND account.person_id::text=step->>'holderPersonId'
    WHERE step->>'role'='employee' AND account.person_id=subject_person AND app.contract_verified_human(account.id)) THEN RETURN jsonb_build_object('ready',true,'reason','employee');END IF;
  RETURN jsonb_build_object('ready',false,'reason','employee_account');
 END IF;
 RETURN jsonb_build_object('ready',false,'reason','hr_steps');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_document_readiness(p_delivery uuid,p_token uuid,p_origin text,p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;p_tenant uuid;letter public.contract_shared_letter;document jsonb;subject_person uuid;values jsonb;field jsonb;
BEGIN
 target:=app.automation_email_target(p_delivery,p_token,p_origin);
 IF target IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(target->'payload'->'mail'->'delivery'->'documents','[]'::jsonb)) doc WHERE doc->>'id'=p_letter::text) THEN RETURN jsonb_build_object('ready',false,'reason','source_changed');END IF;
 p_tenant:=(target->>'tenantId')::uuid;
 -- Private helper; only the held-step owner and the authenticated canonical progression trigger call it.
 -- No application EXECUTE grant. A human-origin trigger retains its real actor, without impersonating owner.
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=p_letter;
 SELECT data INTO document FROM public.document_signing_document WHERE tenant_id=letter.tenant_id AND id=letter.signing_document_id;
 SELECT employment.person_id INTO subject_person FROM public.contract_case c JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id AND employment.company_id=c.company_id WHERE c.tenant_id=letter.tenant_id AND c.id=letter.case_id;
 IF letter.id IS NULL OR document IS NULL OR app.contract_shared_email_document_native_current(letter.tenant_id,letter.id) IS NOT TRUE OR subject_person::text IS DISTINCT FROM letter.data->>'subjectPersonId' THEN RETURN jsonb_build_object('ready',false,'reason','source_changed');END IF;
 IF letter.data->>'state' IN('declined','withdrawn','superseded') THEN RETURN jsonb_build_object('ready',false,'reason','stopped');END IF;
 IF app.document_signing_returned(document) THEN RETURN jsonb_build_object('ready',false,'reason','returned');END IF;
 IF letter.data->>'state'='released' THEN RETURN jsonb_build_object('ready',true,'reason','released');END IF;
 IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'role'<>'employee') THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
 IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'role'='employee') THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(letter.data->'definition'->'blocks') block WHERE block->>'type' IN('field','fields')) THEN
   values:=app.contract_shared_form_resolved_values(letter.tenant_id,letter.id);
   IF values IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
   FOR field IN SELECT * FROM jsonb_array_elements(letter.data->'definition'->'fields') WHERE value->>'owner'<>'employee' LOOP
    IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb AND values->>(field->'when'->>'field') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;
    IF app.document_form_required_missing(field,values->>(field->>'id')) THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
   END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step JOIN public.app_user account ON account.tenant_id=letter.tenant_id AND account.id::text=step->>'holderId' AND account.person_id::text=step->>'holderPersonId'
    WHERE step->>'role'='employee' AND account.person_id=subject_person AND account.archived_at IS NULL AND NOT app.login_blocked(account.id) AND EXISTS(SELECT 1 FROM public.person person WHERE person.tenant_id=account.tenant_id AND person.id=account.person_id AND length(btrim(person.full_name))>0)) THEN RETURN jsonb_build_object('ready',true,'reason','employee');END IF;
  RETURN jsonb_build_object('ready',false,'reason','employee_account');
 END IF;
 RETURN jsonb_build_object('ready',false,'reason','hr_steps');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_values_before_shared_letterhead(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;values jsonb;referenced text[];aliases jsonb;allowed text[];
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.data->>'formProtocol' IS DISTINCT FROM '1' THEN RETURN app.contract_shared_letter_values_before_form_protocol(p_letter);END IF;
 IF l.data->'valuesFixed'='true'::jsonb THEN RETURN coalesce(l.data->'values','{}'::jsonb);END IF;
 IF app.contract_shared_form_source_current(l.id) IS NOT TRUE THEN values:=coalesce(l.data->'values','{}'::jsonb);
 ELSE values:=app.contract_shared_letter_values_before_form_protocol(p_letter)||app.contract_shared_form_personnel(l.id);END IF;
 SELECT coalesce(array_agg(DISTINCT key),'{}'::text[]) INTO referenced FROM(
  SELECT app.contract_shared_form_reference_key(field->>'pmKey') AS key FROM jsonb_array_elements(l.data->'definition'->'fields') field WHERE nullif(field->>'pmKey','') IS NOT NULL
  UNION ALL SELECT app.contract_shared_form_reference_key(match[1]) FROM jsonb_array_elements(l.data->'definition'->'blocks') block CROSS JOIN LATERAL regexp_matches(coalesce(l.data->'blocks'->>(block->>'id'),block->>'text','')||' '||coalesce(block->>'rows','')||' '||coalesce(block->>'label',''),'\{([^{}]+)\}','g') match
 ) refs;
 allowed:=app.contract_shared_form_published_keys(p_letter);
 values:=coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(values) WHERE key=ANY(referenced) AND key=ANY(allowed) OR starts_with(key,'signingStep.')),'{}'::jsonb);
 -- Display aliases copy only an already selected published source. Mutable wording never expands that source allowlist.
 SELECT coalesce(jsonb_object_agg(raw_key,values->app.contract_shared_form_reference_key(raw_key)),'{}'::jsonb) INTO aliases FROM(
  SELECT field->>'pmKey' AS raw_key FROM jsonb_array_elements(l.data->'definition'->'fields') field
  UNION SELECT match[1] FROM jsonb_array_elements(l.data->'definition'->'blocks') block CROSS JOIN LATERAL regexp_matches(coalesce(l.data->'blocks'->>(block->>'id'),block->>'text','')||' '||coalesce(block->>'rows','')||' '||coalesce(block->>'label',''),'\{([^{}]+)\}','g') match
 ) refs WHERE nullif(raw_key,'') IS NOT NULL AND app.contract_shared_form_reference_key(raw_key)=ANY(allowed) AND values ? app.contract_shared_form_reference_key(raw_key);
 RETURN values||aliases;

END $$;
