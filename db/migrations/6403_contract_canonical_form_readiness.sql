-- Canonical private explicit-tenant country/Form defaults. Only verified SMTP capability wrapper derives a tenant; no tenant or human GUC is changed and no new app grant is added.
CREATE FUNCTION app.document_merge_values_my(p_tenant uuid,p_person uuid,p_keys text[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_object_agg(source.key,coalesce(source.value,'')),'{}'::jsonb)
 FROM public.employee_statutory_my statutory CROSS JOIN LATERAL(VALUES
 ('icNo',statutory.ic_number),('passportNo',statutory.passport_number),('bankName',statutory.bank_name),
 ('bankAcc',statutory.bank_account_no),('epfNo',statutory.epf_number),('taxNo',statutory.tax_number)) source(key,value)
 WHERE statutory.tenant_id=p_tenant AND statutory.person_id=p_person AND source.key=ANY(p_keys)
 AND p_keys <@ ARRAY['icNo','passportNo','bankName','bankAcc','epfNo','taxNo']::text[]
$$;
ALTER FUNCTION app.document_merge_values_my(uuid,uuid,text[]) OWNER TO ai_hr_owner;
REVOKE ALL ON FUNCTION app.document_merge_values_my(uuid,uuid,text[]) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.document_merge_values_my(p_person uuid,p_keys text[]) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.document_merge_values_my(app.current_tenant_id(),p_person,p_keys) $$;
CREATE FUNCTION app.document_country_merge_values(p_tenant uuid,p_country text,p_person uuid,p_keys text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_keys IS NULL OR cardinality(p_keys)>6 OR NOT p_keys <@ ARRAY['icNo','passportNo','bankName','bankAcc','epfNo','taxNo']::text[] THEN RAISE EXCEPTION 'Unsupported document Personnel source key' USING ERRCODE='22023';END IF;
 CASE p_country WHEN 'MY' THEN RETURN app.document_merge_values_my(p_tenant,p_person,p_keys);
 ELSE RAISE EXCEPTION 'Set up the company country document reader before using this Personnel field' USING ERRCODE='22023';END CASE;
END $$;
ALTER FUNCTION app.document_country_merge_values(uuid,text,uuid,text[]) OWNER TO ai_hr_owner;
REVOKE ALL ON FUNCTION app.document_country_merge_values(uuid,text,uuid,text[]) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.document_country_merge_values(p_country text,p_person uuid,p_keys text[]) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.document_country_merge_values(app.current_tenant_id(),p_country,p_person,p_keys) $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_published_keys(p_tenant uuid,p_letter uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(DISTINCT key) FILTER(WHERE nullif(key,'') IS NOT NULL),'{}'::text[]) FROM(
 SELECT app.contract_shared_form_reference_key(field->>'pmKey') AS key FROM public.contract_shared_letter l CROSS JOIN LATERAL jsonb_array_elements(l.data->'definition'->'fields') field WHERE l.tenant_id=p_tenant AND l.id=p_letter
 UNION ALL SELECT app.contract_shared_form_reference_key(match[1]) FROM public.contract_shared_letter l CROSS JOIN LATERAL jsonb_array_elements(l.data->'definition'->'blocks') block CROSS JOIN LATERAL regexp_matches(coalesce(block->>'text','')||' '||coalesce(block->>'rows','')||' '||coalesce(block->>'label',''),'\{([^{}]+)\}','g') match WHERE l.tenant_id=p_tenant AND l.id=p_letter
 ) selected
$$;
REVOKE ALL ON FUNCTION app.contract_shared_form_published_keys(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_form_published_keys(p_letter uuid) RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_shared_form_published_keys(app.current_tenant_id(),p_letter) $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_personnel_source(p_tenant uuid,p_letter uuid) RETURNS jsonb
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
 source_values:=coalesce(l.data->'values','{}'::jsonb)||profile||statutory||jsonb_build_object('employee.name',profile->>'name','employee.icNo',coalesce(statutory->>'icNo',''),'employee.passportNo',coalesce(statutory->>'passportNo',''));
 RETURN coalesce((SELECT jsonb_object_agg(key,source_values->key) FROM unnest(requested) key WHERE source_values ? key),'{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_form_personnel_source(uuid,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_personnel(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;subject uuid;country text;profile jsonb;statutory jsonb:='{}'::jsonb;requested text[];stat_keys text[];source_values jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.id IS NULL OR app.contract_shared_document_kind(l.id)<>'Form' THEN RETURN '{}'::jsonb;END IF;
 IF app.contract_shared_form_body_visible(l.id) IS NOT TRUE AND app.contract_shared_effect_held(l.case_id,l.workflow_run_id,l.workflow_step_id,CASE WHEN l.purpose='email' THEN 'sendEmail' ELSE 'generateDocument' END) IS NOT TRUE THEN RAISE EXCEPTION 'This Form is unavailable' USING ERRCODE='42501';END IF;
 requested:=app.contract_shared_form_published_keys(p_letter);
 source_values:=coalesce(app.contract_shared_letter_values_before_form_protocol(p_letter),'{}'::jsonb)||app.contract_shared_form_personnel_source(l.tenant_id,p_letter);
 RETURN coalesce((SELECT jsonb_object_agg(key,source_values->key) FROM unnest(requested) key WHERE source_values ? key),'{}'::jsonb);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_resolved_values(p_tenant uuid,p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;r public.document_form_response;defaults jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=p_letter;
 SELECT * INTO r FROM public.document_form_response WHERE tenant_id=p_tenant AND document_id=l.signing_document_id AND source_person_id::text=l.data->>'subjectPersonId';
 IF r.document_id IS NULL THEN RETURN NULL;END IF;
 IF r.locked_values IS NOT NULL THEN defaults:=r.locked_values;
 ELSE
  defaults:=coalesce(l.data->'values','{}'::jsonb)||app.contract_shared_form_personnel_source(p_tenant,p_letter);
  SELECT coalesce(jsonb_object_agg(field->>'id',coalesce(defaults->>app.contract_shared_form_reference_key(coalesce(nullif(field->>'pmKey',''),field->>'id')),'')),'{}'::jsonb) INTO defaults FROM jsonb_array_elements(l.data->'definition'->'fields') field;
 END IF;
 RETURN defaults||r.answers;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_form_resolved_values(uuid,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_document_native_current(p_tenant uuid,p_letter uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_letter l JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id
 JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id AND e.person_id::text=l.data->>'subjectPersonId' AND e.voided_at IS NULL
 JOIN public.company company ON company.tenant_id=c.tenant_id AND company.id=c.company_id AND company.archived_at IS NULL JOIN public.tenant tenant ON tenant.id=c.tenant_id AND tenant.status IN('active','trial')
 WHERE l.tenant_id=p_tenant AND l.id=p_letter AND EXISTS(SELECT 1 FROM public.contract_shared_email_document_step pin WHERE pin.tenant_id=l.tenant_id AND pin.case_id=l.case_id AND pin.company_id=c.company_id AND pin.subject_person_id=e.person_id AND pin.documents->>(l.data->>'templateId')=l.id::text AND l.purpose IN('email',pin.phase))
 AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=p_tenant AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.company_id IS NULL OR module.company_id=c.company_id) AND (module.expires_at IS NULL OR module.expires_at>now())))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_document_native_current(uuid,uuid) FROM PUBLIC,ai_hr_app;

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
    IF field->'required'='true'::jsonb AND (btrim(coalesce(values->>(field->>'id'),''))='' OR field->>'type'='checkbox' AND values->>(field->>'id')<>'true') THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
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
    IF field->'required'='true'::jsonb AND (btrim(coalesce(values->>(field->>'id'),''))='' OR field->>'type'='checkbox' AND values->>(field->>'id')<>'true') THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
   END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step JOIN public.app_user account ON account.tenant_id=letter.tenant_id AND account.id::text=step->>'holderId' AND account.person_id::text=step->>'holderPersonId'
    WHERE step->>'role'='employee' AND account.person_id=subject_person AND account.archived_at IS NULL AND NOT app.login_blocked(account.id) AND EXISTS(SELECT 1 FROM public.person person WHERE person.tenant_id=account.tenant_id AND person.id=account.person_id AND length(btrim(person.full_name))>0)) THEN RETURN jsonb_build_object('ready',true,'reason','employee');END IF;
  RETURN jsonb_build_object('ready',false,'reason','employee_account');
 END IF;
 RETURN jsonb_build_object('ready',false,'reason','hr_steps');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_document_readiness(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Forward actual native binding repair: unambiguous entry alias, not the trigger OLD record.
CREATE OR REPLACE FUNCTION app.contract_shared_email_document_step_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (to_jsonb(NEW)-'documents') IS DISTINCT FROM (to_jsonb(OLD)-'documents')
 OR EXISTS(SELECT 1 FROM jsonb_each(OLD.documents) AS previous_entry(key,value) WHERE NEW.documents->previous_entry.key IS DISTINCT FROM previous_entry.value) THEN RAISE EXCEPTION 'Prepared email references and document bindings are immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
