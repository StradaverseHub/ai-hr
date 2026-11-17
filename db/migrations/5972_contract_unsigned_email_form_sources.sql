-- First SIGNATURE freezes an independent email Form; a different agreement posting does not. Original Contract/decision/pin facts stay frozen. No outcome/current-business gate, actor, role or grant changes.
CREATE OR REPLACE FUNCTION app.contract_shared_letter_values_before_form_protocol(p_tenant uuid,p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f jsonb;s jsonb;amount text;values jsonb;signers jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=p_letter;
 IF l.id IS NULL THEN RETURN NULL;END IF;
 IF l.data->'valuesFixed'='true'::jsonb OR (CASE WHEN l.purpose='email' THEN app.contract_shared_email_document_current(p_tenant,l.id) IS NOT TRUE ELSE app.contract_shared_decision_current(p_tenant,l.case_id,l.decision_revision) IS NOT TRUE END) THEN RETURN l.data->'values';END IF;
 SELECT c.data,app.contract_source(p_tenant,k.employment_id) INTO f,s FROM public.contract_shared_case c JOIN public.contract_case k ON k.tenant_id=c.tenant_id AND k.id=c.case_id WHERE c.tenant_id=l.tenant_id AND c.case_id=l.case_id;
 IF l.purpose='email' THEN
  IF l.decision_revision=0 THEN f:=jsonb_set(f,'{decision}','null'::jsonb);
  ELSIF f->'decision'->>'revision' IS DISTINCT FROM l.decision_revision::text THEN f:=jsonb_set(f,'{decision}',coalesce((SELECT history FROM jsonb_array_elements(f->'decisionHistory') history WHERE history->>'revision'=l.decision_revision::text),'null'::jsonb));END IF;
 END IF;
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
 -- An independent unsigned email document keeps its ORIGINAL Contract/decision facts; only its actual
 -- employee Personnel/org sources remain live after another agreement advances the employment period.
 IF l.purpose='email' AND app.contract_shared_delivery_period_current(p_tenant,l.case_id) IS NOT TRUE THEN
  values:=coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(values) WHERE NOT starts_with(key,'contract.') AND NOT starts_with(key,'decision.')),'{}'::jsonb)
   ||coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(coalesce(l.data->'values','{}'::jsonb)) WHERE starts_with(key,'contract.') OR starts_with(key,'decision.')),'{}'::jsonb);
 END IF;
 RETURN values||signers||app.contract_shared_letter_signer_values(p_tenant,l.id);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_personnel_source(p_tenant uuid,p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;subject uuid;country text;profile jsonb;statutory jsonb:='{}'::jsonb;requested text[];stat_keys text[];source_values jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=p_letter;
 IF l.id IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(l.data->'definition'->'blocks') block WHERE block->>'type' IN('field','fields')) THEN RETURN '{}'::jsonb;END IF;

 requested:=app.contract_shared_form_published_keys(p_tenant,p_letter);
 IF NOT EXISTS(SELECT 1 FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id JOIN public.company company ON company.tenant_id=c.tenant_id AND company.id=c.company_id JOIN public.tenant tenant ON tenant.id=c.tenant_id WHERE c.tenant_id=p_tenant AND c.id=l.case_id AND e.person_id::text=l.data->>'subjectPersonId' AND e.voided_at IS NULL AND company.archived_at IS NULL AND tenant.status IN('active','trial') AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=p_tenant AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.company_id IS NULL OR module.company_id=c.company_id) AND (module.expires_at IS NULL OR module.expires_at>now()))) THEN RAISE EXCEPTION 'The Form source is unavailable' USING ERRCODE='42501';END IF;
 IF l.data->'valuesFixed'='true'::jsonb OR (app.contract_shared_delivery_period_current(l.tenant_id,l.case_id) IS NOT TRUE AND NOT (l.purpose='email' AND app.contract_shared_email_document_native_current(p_tenant,l.id))) THEN RETURN coalesce((SELECT jsonb_object_agg(key,l.data->'values'->key) FROM unnest(requested) key WHERE l.data->'values' ? key),'{}'::jsonb);END IF;
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
