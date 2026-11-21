-- Source selection belongs to the immutable published Form, never editable case wording.
CREATE FUNCTION app.contract_shared_form_published_keys(p_letter uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(DISTINCT key) FILTER(WHERE nullif(key,'') IS NOT NULL),'{}'::text[]) FROM(
 SELECT app.contract_shared_form_reference_key(field->>'pmKey') AS key FROM public.contract_shared_letter l CROSS JOIN LATERAL jsonb_array_elements(l.data->'definition'->'fields') field WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter
 UNION ALL SELECT app.contract_shared_form_reference_key(match[1]) FROM public.contract_shared_letter l CROSS JOIN LATERAL jsonb_array_elements(l.data->'definition'->'blocks') block CROSS JOIN LATERAL regexp_matches(coalesce(block->>'text','')||' '||coalesce(block->>'rows','')||' '||coalesce(block->>'label',''),'\{([^{}]+)\}','g') match WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter
 ) selected
$$;
REVOKE ALL ON FUNCTION app.contract_shared_form_published_keys(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_personnel(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;subject uuid;country text;profile jsonb;statutory jsonb:='{}'::jsonb;requested text[];stat_keys text[];source_values jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.id IS NULL OR app.contract_shared_document_kind(l.id)<>'Form' THEN RETURN '{}'::jsonb;END IF;
 IF app.contract_shared_form_body_visible(l.id) IS NOT TRUE AND app.contract_shared_effect_held(l.case_id,l.workflow_run_id,l.workflow_step_id,CASE WHEN l.purpose='email' THEN 'sendEmail' ELSE 'generateDocument' END) IS NOT TRUE THEN RAISE EXCEPTION 'This Form is unavailable' USING ERRCODE='42501';END IF;
 requested:=app.contract_shared_form_published_keys(p_letter);
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
 IF cardinality(stat_keys)>0 THEN statutory:=app.document_country_merge_values(country,subject,stat_keys);END IF;
 source_values:=coalesce(l.data->'values','{}'::jsonb)||coalesce(app.contract_shared_letter_values_before_form_protocol(l.id),'{}'::jsonb)||profile||statutory||jsonb_build_object('employee.icNo',coalesce(statutory->>'icNo',''),'employee.passportNo',coalesce(statutory->>'passportNo',''));
 RETURN coalesce((SELECT jsonb_object_agg(key,source_values->key) FROM unnest(requested) key WHERE source_values ? key),'{}'::jsonb);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_values_before_shared_letterhead(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;values jsonb;referenced text[];
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.data->>'formProtocol' IS DISTINCT FROM '1' THEN RETURN app.contract_shared_letter_values_before_form_protocol(p_letter);END IF;
 IF l.data->'valuesFixed'='true'::jsonb OR app.contract_shared_form_source_current(l.id) IS NOT TRUE THEN values:=coalesce(l.data->'values','{}'::jsonb);
 ELSE values:=app.contract_shared_letter_values_before_form_protocol(p_letter)||app.contract_shared_form_personnel(l.id);END IF;
 SELECT coalesce(array_agg(DISTINCT key),'{}'::text[]) INTO referenced FROM(
  SELECT app.contract_shared_form_reference_key(field->>'pmKey') AS key FROM jsonb_array_elements(l.data->'definition'->'fields') field WHERE nullif(field->>'pmKey','') IS NOT NULL
  UNION ALL SELECT app.contract_shared_form_reference_key(match[1]) FROM jsonb_array_elements(l.data->'definition'->'blocks') block CROSS JOIN LATERAL regexp_matches(coalesce(l.data->'blocks'->>(block->>'id'),block->>'text','')||' '||coalesce(block->>'rows','')||' '||coalesce(block->>'label',''),'\{([^{}]+)\}','g') match
 ) refs;
 RETURN coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(values) WHERE key=ANY(referenced) AND key=ANY(app.contract_shared_form_published_keys(p_letter)) OR starts_with(key,'signingStep.')),'{}'::jsonb);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_documents_prepare(p_case uuid,p_run uuid,p_step text,p_email uuid,p_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pin public.contract_shared_email_document_step;f public.contract_shared_case;c public.contract_case;definition jsonb;expected text;document_ids jsonb;person uuid;
BEGIN
 IF app.contract_shared_effect_held(p_case,p_run,p_step,'sendEmail') IS NOT TRUE THEN RAISE EXCEPTION 'Protected Send email step required' USING ERRCODE='42501';END IF;
 PERFORM app.contract_shared_lock_source(p_case);
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=f.tenant_id AND id=p_case;
 SELECT employment.person_id INTO person FROM public.employment employment WHERE tenant_id=c.tenant_id AND id=c.employment_id AND company_id=c.company_id;
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=f.tenant_id AND workflow_run_id=p_run AND workflow_step_id=p_step FOR UPDATE;
 IF pin.workflow_run_id IS NULL THEN
  SELECT step->'params'->>'emailTemplateId' INTO expected FROM public.automation_run run JOIN public.automation_workflow_version workflow ON workflow.tenant_id=run.tenant_id AND workflow.workflow_id=run.workflow_id AND workflow.revision=run.workflow_revision
  CROSS JOIN LATERAL jsonb_array_elements(workflow.definition->'steps') step WHERE run.tenant_id=f.tenant_id AND run.id=p_run AND step->>'id'=p_step AND step->>'type'='sendEmail';
  IF expected IS DISTINCT FROM p_email::text THEN RAISE EXCEPTION 'The frozen email step changed' USING ERRCODE='40001';END IF;
  SELECT to_jsonb(version) INTO definition FROM public.automation_email_template_version version WHERE tenant_id=f.tenant_id AND template_id=p_email AND revision=p_revision AND module='contract_staff' AND active AND NOT retired
  AND revision=(SELECT max(latest.revision) FROM public.automation_email_template_version latest WHERE latest.tenant_id=f.tenant_id AND latest.template_id=p_email);
  IF definition IS NULL THEN RAISE EXCEPTION 'Review the current email definition before preparing documents' USING ERRCODE='40001';END IF;
  INSERT INTO public.contract_shared_email_document_step(tenant_id,case_id,workflow_run_id,workflow_step_id,email_template_id,email_revision,subject_person_id,decision_revision,phase,company_id,source_period_revision)
  VALUES(f.tenant_id,p_case,p_run,p_step,p_email,p_revision,person,coalesce((f.data->'decision'->>'revision')::integer,0),CASE WHEN f.data->'declined'='null'::jsonb THEN 'outcome' ELSE 'declined' END,c.company_id,f.data->'period'->>'sourceRevision') RETURNING * INTO pin;
 ELSE
  IF pin.case_id<>p_case OR pin.subject_person_id<>person OR pin.company_id<>c.company_id OR NOT (pin.decision_revision=0 OR (f.data->'decision'->>'revision')::integer=pin.decision_revision OR EXISTS(SELECT 1 FROM jsonb_array_elements(f.data->'decisionHistory') history WHERE (history->>'revision')::integer=pin.decision_revision)) THEN RAISE EXCEPTION 'The prepared email source changed' USING ERRCODE='40001';END IF;
  SELECT to_jsonb(version) INTO definition FROM public.automation_email_template_version version WHERE tenant_id=pin.tenant_id AND template_id=pin.email_template_id AND revision=pin.email_revision AND module='contract_staff';
 END IF;
 document_ids:=coalesce(nullif(definition->'document_ids','null'::jsonb),'[]'::jsonb);
 IF jsonb_typeof(document_ids)<>'array' OR jsonb_array_length(document_ids)>100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(document_ids) id WHERE jsonb_typeof(id)<>'string' OR id#>>'{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN RAISE EXCEPTION 'The email document list is invalid' USING ERRCODE='22023';END IF;
 RETURN jsonb_build_object('prerequisiteId',pin.id,'sourcePeriodRevision',pin.source_period_revision,'reference',jsonb_build_object('id',pin.email_template_id,'revision',pin.email_revision),'template',definition,'documentTemplateIds',document_ids,'documents',pin.documents);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_document_current(p_letter uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_letter l JOIN public.contract_shared_case f ON f.tenant_id=l.tenant_id AND f.case_id=l.case_id
 JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id AND employment.company_id=c.company_id
 JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=l.tenant_id AND pin.case_id=l.case_id AND pin.workflow_run_id=l.workflow_run_id AND pin.workflow_step_id=l.workflow_step_id AND pin.company_id=c.company_id AND pin.subject_person_id=employment.person_id AND pin.decision_revision=l.decision_revision AND pin.email_template_id::text=l.data->'emailTemplateRef'->>'id' AND pin.email_revision::text=l.data->'emailTemplateRef'->>'revision'
 WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter AND l.purpose='email' AND app.contract_company_entitled(c.company_id) AND employment.person_id::text=l.data->>'subjectPersonId' AND employment.voided_at IS NULL
 AND (pin.documents->>(l.data->>'templateId')=l.id::text OR NOT EXISTS(SELECT 1 FROM public.document_signing_document d WHERE d.tenant_id=l.tenant_id AND d.id=l.signing_document_id) AND app.contract_shared_effect_held(l.case_id,l.workflow_run_id,l.workflow_step_id,'sendEmail'))
 AND (l.decision_revision=0 OR (f.data->'decision'->>'revision')::integer=l.decision_revision OR EXISTS(SELECT 1 FROM jsonb_array_elements(f.data->'decisionHistory') decision WHERE (decision->>'revision')::integer=l.decision_revision)))
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_prepare_letter_before_shared_letterhead(p_case uuid,p_run uuid,p_step text,p_template uuid,p_version integer,p_route jsonb,p_routing jsonb,p_email_ref jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f public.contract_shared_case;c public.contract_case;definition jsonb;expected_template text;blocks jsonb;snapshot jsonb;fingerprint text;next_data jsonb;employee_person uuid;letter_purpose text;run_trigger text;step_type text;email_documents jsonb;expected_email text;
BEGIN
 PERFORM app.contract_shared_lock_source(p_case);
 IF app.contract_shared_effect_held(p_case,p_run,p_step,'generateDocument') IS NOT TRUE AND app.contract_shared_effect_held(p_case,p_run,p_step,'sendEmail') IS NOT TRUE THEN RAISE EXCEPTION 'Protected letter intent required' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case FOR UPDATE;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=f.tenant_id AND id=f.case_id;
 SELECT s->>'type',s->'params'->>'letterTemplateId',s->'params'->>'emailTemplateId' INTO step_type,expected_template,expected_email FROM public.automation_run r JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision
 CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') s WHERE r.tenant_id=c.tenant_id AND r.id=p_run AND s->>'id'=p_step;
 SELECT trigger_event INTO run_trigger FROM public.automation_run WHERE tenant_id=c.tenant_id AND id=p_run;
 letter_purpose:=CASE WHEN f.data->'declined' IS DISTINCT FROM 'null'::jsonb THEN 'declined' ELSE 'outcome' END;
 IF step_type='sendEmail' THEN
  IF p_email_ref->>'id' IS DISTINCT FROM expected_email OR coalesce(p_email_ref->>'revision','') !~ '^[1-9][0-9]{0,5}$' THEN RAISE EXCEPTION 'The actual email definition receipt is required' USING ERRCODE='40001';END IF;
  -- 5827 owns the nullable document_ids extension; this query resolves only when that shared owner is installed.
  EXECUTE 'SELECT document_ids FROM public.automation_email_template_version WHERE tenant_id=$1 AND template_id=$2 AND revision=$3 AND module=''contract_staff'' AND active AND NOT retired'
   INTO email_documents USING c.tenant_id,(p_email_ref->>'id')::uuid,(p_email_ref->>'revision')::integer;
  IF email_documents IS NULL OR NOT email_documents ? p_template::text THEN RAISE EXCEPTION 'This immutable email definition does not include the document' USING ERRCODE='40001';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.contract_shared_email_document_step pin WHERE pin.tenant_id=c.tenant_id AND pin.case_id=c.id AND pin.workflow_run_id=p_run AND pin.workflow_step_id=p_step AND pin.company_id=c.company_id AND pin.email_template_id=(p_email_ref->>'id')::uuid AND pin.email_revision=(p_email_ref->>'revision')::integer AND pin.source_period_revision=f.data->'period'->>'sourceRevision' AND pin.decision_revision=coalesce((f.data->'decision'->>'revision')::integer,0)) THEN RAISE EXCEPTION 'Prepare the immutable email step before its documents' USING ERRCODE='42501';END IF;
  letter_purpose:='email';
 ELSIF step_type<>'generateDocument' OR p_email_ref IS NOT NULL OR expected_template IS DISTINCT FROM p_template::text OR (letter_purpose='declined' AND run_trigger<>'employeeDeclined') THEN RAISE EXCEPTION 'Letter purpose changed' USING ERRCODE='40001';END IF;
 SELECT v.definition INTO definition FROM public.automation_document_template h JOIN public.automation_document_template_version v ON v.tenant_id=h.tenant_id AND v.template_id=h.id AND v.version=h.live_version
 WHERE h.tenant_id=c.tenant_id AND h.id=p_template AND h.module='contract_staff' AND NOT h.retired AND h.live_version=p_version;
 IF definition IS NULL THEN RAISE EXCEPTION 'Published Contract template changed' USING ERRCODE='40001';END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=c.tenant_id AND case_id=c.id AND decision_revision=CASE WHEN letter_purpose='email' THEN coalesce((f.data->'decision'->>'revision')::integer,0) ELSE (f.data->'decision'->>'revision')::integer END AND workflow_run_id=p_run AND workflow_step_id=p_step AND data->>'templateId'=p_template::text;
 IF l.id IS NOT NULL THEN
  IF l.data->>'templateId'<>p_template::text THEN RAISE EXCEPTION 'This decision already has a different outcome letter' USING ERRCODE='40001';END IF;
  RETURN jsonb_build_object('id',l.id,'signingDocumentId',l.signing_document_id,'contentHash',(SELECT d.data->>'contentHash' FROM public.document_signing_document d WHERE d.tenant_id=l.tenant_id AND d.id=l.signing_document_id),'state',l.data->>'state','existing',true);
 END IF;
 IF p_routing->>'templateId' IS DISTINCT FROM p_template::text OR p_routing->>'templateVersion' IS DISTINCT FROM p_version::text OR p_routing->'liveMergeReviews' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Invalid pinned template routing' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(p_route->'steps')<>jsonb_array_length(definition->'routing') OR EXISTS(SELECT 1 FROM jsonb_array_elements(definition->'routing') s WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') t WHERE t->>'id'=s->>'id' AND t->>'kind'=s->>'action' AND t->'stage'=s->'order' AND coalesce(t->'owner','false')=coalesce(s->'owner','false'))) THEN RAISE EXCEPTION 'Letter route differs from its published template' USING ERRCODE='22023';END IF;
 SELECT e.person_id INTO employee_person FROM public.employment e WHERE e.tenant_id=c.tenant_id AND e.id=c.employment_id;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='employee' AND s->>'holderId' IS NOT NULL AND s->>'holderPersonId' IS DISTINCT FROM employee_person::text) THEN RAISE EXCEPTION 'An employee step cannot use a substitute signer' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_object_agg(b->>'id',CASE WHEN b->>'type'='table' THEN coalesce(b->>'rows','') ELSE coalesce(b->>'text','') END),'{}'::jsonb) INTO blocks FROM jsonb_array_elements(definition->'blocks') b WHERE b->>'type' IN('heading','subheading','text','table');
 l.id:=gen_random_uuid();l.signing_document_id:=gen_random_uuid();
 INSERT INTO public.contract_shared_letter(tenant_id,id,case_id,signing_document_id,decision_revision,workflow_run_id,workflow_step_id,purpose,data)
 VALUES(c.tenant_id,l.id,c.id,l.signing_document_id,CASE WHEN letter_purpose='email' THEN coalesce((f.data->'decision'->>'revision')::integer,0) ELSE (f.data->'decision'->>'revision')::integer END,p_run,p_step,letter_purpose,jsonb_build_object('id',l.id,'templateId',p_template,'templateVersion',p_version,'generatedOn',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'subjectPersonId',employee_person,'emailTemplateRef',p_email_ref,'state','routing','values','{}'::jsonb,'valuesFixed',false,'blocks',blocks,'definition',jsonb_build_object('name',definition->>'name','blocks',definition->'blocks','fields',definition->'fields'),'releasedAt',NULL,'contentRevision',1,
 'signingPolicy',jsonb_build_object('route',p_route,'routing',p_routing,'guardrails',jsonb_build_object('requiredRoles','[]'::jsonb))));
 snapshot:=app.contract_shared_letter_snapshot(l.id);fingerprint:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{values}',snapshot->'values') WHERE tenant_id=c.tenant_id AND id=l.id;
 INSERT INTO public.contract_shared_letter_content(tenant_id,letter_id,content_revision,content_hash,snapshot) VALUES(c.tenant_id,l.id,1,fingerprint,snapshot);
 IF letter_purpose='email' THEN RETURN jsonb_build_object('id',l.id,'signingDocumentId',l.signing_document_id,'contentHash',fingerprint,'state','routing','existing',false);END IF;
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'stage','document','lastActivityAt',now());
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='employee' AND s->>'kind'='sign' AND s->>'holderId' IS NULL) THEN next_data:=jsonb_set(next_data,'{flags}',(next_data->'flags')||'"employee_cannot_sign"'::jsonb);END IF;
 UPDATE public.contract_shared_case SET data=next_data,revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 RETURN jsonb_build_object('id',l.id,'signingDocumentId',l.signing_document_id,'contentHash',fingerprint,'state','routing','existing',false);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_values_before_form_protocol(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f jsonb;s jsonb;amount text;values jsonb;signers jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.id IS NULL THEN RETURN NULL;END IF;
 IF l.data->'valuesFixed'='true'::jsonb OR (app.contract_shared_decision_current(l.case_id,l.decision_revision) IS NOT TRUE AND NOT (l.purpose='email' AND l.decision_revision=0 AND app.contract_shared_email_document_current(l.id) AND app.contract_shared_delivery_period_current(l.tenant_id,l.case_id))) THEN RETURN l.data->'values';END IF;
 SELECT c.data,app.contract_source(k.employment_id) INTO f,s FROM public.contract_shared_case c JOIN public.contract_case k ON k.tenant_id=c.tenant_id AND k.id=c.case_id WHERE c.tenant_id=l.tenant_id AND c.case_id=l.case_id;
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
 RETURN values||signers||app.contract_shared_letter_signer_values(l.id);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.document_form_field_validate(p_field jsonb,p_value text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row jsonb;table_rows jsonb;
BEGIN
 IF p_value IS NULL OR length(p_value)>20000 THEN RAISE EXCEPTION 'A Form field exceeds the allowed length' USING ERRCODE='22023';END IF;
 IF p_value='' THEN RETURN;END IF;
 IF p_field->>'type'='select' AND NOT(p_field->'options' ? p_value) THEN RAISE EXCEPTION 'Choose a valid option for %',p_field->>'label' USING ERRCODE='22023';END IF;
 IF p_field->>'type'='date' AND (p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR to_char(p_value::date,'YYYY-MM-DD')<>p_value) THEN RAISE EXCEPTION 'Enter a valid date for %',p_field->>'label' USING ERRCODE='22023';END IF;
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
CREATE OR REPLACE FUNCTION app.contract_shared_letter_values(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f jsonb;source jsonb;values jsonb;aliases jsonb;amount text;definition text;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 values:=app.contract_shared_letter_values_before_shared_letterhead(p_letter)||coalesce(l.data->'letterheadSnapshot','{}'::jsonb);
 IF l.data->>'formProtocol'='1' AND app.contract_shared_form_source_current(l.id) IS NOT TRUE THEN RETURN values;END IF;
 IF l.data->'letterheadSnapshot' IS NULL OR l.data->'valuesFixed'='true'::jsonb OR app.contract_shared_decision_current(l.case_id,l.decision_revision) IS NOT TRUE THEN RETURN values;END IF;
 SELECT flow.data,app.contract_source(c.employment_id) INTO f,source FROM public.contract_shared_case flow JOIN public.contract_case c ON c.tenant_id=flow.tenant_id AND c.id=flow.case_id WHERE flow.tenant_id=l.tenant_id AND flow.case_id=l.case_id;
 amount:=source->>'allowanceCents';
 aliases:=jsonb_build_object('decision.type',CASE f->'decision'->>'kind' WHEN 'renew' THEN 'Renew' WHEN 'convert' THEN 'Convert to permanent' WHEN 'end' THEN 'End' ELSE '' END,'decision.reason',coalesce(f->'decision'->>'reason',''),'decision.endReason',coalesce(f->'decision'->>'endReason',''),'decision.declineReason',coalesce(f->'declined'->>'reason',''),'contract.lastDay',coalesce(f->'period'->>'endOn',''),'contract.allowance',CASE WHEN amount ~ '^[0-9]+$' THEN (amount::bigint/100)::text||'.'||lpad((amount::bigint%100)::text,2,'0') ELSE '' END);
 definition:=(l.data->'definition')::text||coalesce(l.data->'blocks','{}'::jsonb)::text;
 RETURN values||coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(aliases) WHERE (strpos(definition,'{'||key||'}')>0 OR strpos(definition,'"'||key||'"')>0) AND (l.data->>'formProtocol' IS DISTINCT FROM '1' OR key=ANY(app.contract_shared_form_published_keys(p_letter)))),'{}'::jsonb);
END $$;
