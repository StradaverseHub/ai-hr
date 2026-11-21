-- Private static country-pack document read port. Callers derive person and finite keys from published Form fields.
CREATE FUNCTION app.document_merge_values_my(p_person uuid,p_keys text[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_object_agg(source.key,coalesce(source.value,'')),'{}'::jsonb)
 FROM public.employee_statutory_my statutory CROSS JOIN LATERAL(VALUES
 ('icNo',statutory.ic_number),('passportNo',statutory.passport_number),('bankName',statutory.bank_name),
 ('bankAcc',statutory.bank_account_no),('epfNo',statutory.epf_number),('taxNo',statutory.tax_number)) source(key,value)
 WHERE statutory.tenant_id=app.current_tenant_id() AND statutory.person_id=p_person AND source.key=ANY(p_keys)
 AND p_keys <@ ARRAY['icNo','passportNo','bankName','bankAcc','epfNo','taxNo']::text[]
$$;
ALTER FUNCTION app.document_merge_values_my(uuid,text[]) OWNER TO ai_hr_owner;
REVOKE ALL ON FUNCTION app.document_merge_values_my(uuid,text[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.document_country_merge_values(p_country text,p_person uuid,p_keys text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_keys IS NULL OR cardinality(p_keys)>6 OR NOT p_keys <@ ARRAY['icNo','passportNo','bankName','bankAcc','epfNo','taxNo']::text[] THEN RAISE EXCEPTION 'Unsupported document Personnel source key' USING ERRCODE='22023';END IF;
 CASE p_country WHEN 'MY' THEN RETURN app.document_merge_values_my(p_person,p_keys);
 ELSE RAISE EXCEPTION 'Set up the company country document reader before using this Personnel field' USING ERRCODE='22023';END CASE;
END $$;
ALTER FUNCTION app.document_country_merge_values(text,uuid,text[]) OWNER TO ai_hr_owner;
REVOKE ALL ON FUNCTION app.document_country_merge_values(text,uuid,text[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_personnel(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;subject uuid;country text;profile jsonb;statutory jsonb:='{}'::jsonb;requested text[];stat_keys text[];source_values jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.id IS NULL OR app.contract_shared_document_kind(l.id)<>'Form' THEN RETURN '{}'::jsonb;END IF;
 IF app.contract_shared_form_body_visible(l.id) IS NOT TRUE AND app.contract_shared_effect_held(l.case_id,l.workflow_run_id,l.workflow_step_id,CASE WHEN l.purpose='email' THEN 'sendEmail' ELSE 'generateDocument' END) IS NOT TRUE THEN RAISE EXCEPTION 'This Form is unavailable' USING ERRCODE='42501';END IF;
 SELECT p.id,company.country,jsonb_build_object('name',p.full_name,'email',p.primary_email,'mobile',coalesce(p.phone,''),'homePhone',coalesce(p.home_phone,''),
 'personalEmail',coalesce(p.personal_email,''),'address',coalesce(nullif(p.address,''),concat_ws(', ',p.permanent_address_line1,p.permanent_address_line2,p.permanent_address_line3,p.permanent_postcode,p.permanent_city,p.permanent_state,p.permanent_country)),
 'race',coalesce(p.race,''),'religion',coalesce(p.religion,''),'nationality',coalesce(p.nationality,''),'gender',initcap(coalesce(p.gender::text,'')),'marital',initcap(coalesce(p.marital_status::text,'')),
 'emName',coalesce(ec.full_name,''),'emRel',coalesce(ec.relationship,''),'emPhone',coalesce(ec.mobile_phone,'')) INTO subject,country,profile
 FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id
 JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id JOIN public.company company ON company.tenant_id=e.tenant_id AND company.id=e.company_id
 LEFT JOIN LATERAL(SELECT * FROM public.person_emergency_contact contact WHERE contact.tenant_id=p.tenant_id AND contact.person_id=p.id AND contact.archived_at IS NULL ORDER BY CASE contact.priority WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END,contact.created_at,contact.id LIMIT 1) ec ON true
 WHERE c.tenant_id=l.tenant_id AND c.id=l.case_id AND e.person_id::text=l.data->>'subjectPersonId' AND e.voided_at IS NULL;
 IF subject IS NULL THEN RAISE EXCEPTION 'The Form employee or company changed' USING ERRCODE='40001';END IF;
 SELECT coalesce(array_agg(DISTINCT key) FILTER(WHERE nullif(key,'') IS NOT NULL),'{}'::text[]) INTO requested FROM(SELECT field->>'pmKey' AS key FROM jsonb_array_elements(l.data->'definition'->'fields') field UNION ALL SELECT match[1] FROM jsonb_array_elements(l.data->'definition'->'blocks') block CROSS JOIN LATERAL regexp_matches(coalesce(l.data->'blocks'->>(block->>'id'),block->>'text','')||' '||coalesce(block->>'label',''),'\{([a-zA-Z][a-zA-Z0-9_.]*)\}','g') match) refs;
 SELECT coalesce(array_agg(key),'{}'::text[]) INTO stat_keys FROM unnest(requested) key WHERE key=ANY(ARRAY['icNo','passportNo','bankName','bankAcc','epfNo','taxNo']);
 IF cardinality(stat_keys)>0 THEN statutory:=app.document_country_merge_values(country,subject,stat_keys);END IF;
 source_values:=profile||statutory||coalesce(l.data->'values','{}'::jsonb);
 RETURN coalesce((SELECT jsonb_object_agg(key,source_values->key) FROM unnest(requested) key WHERE source_values ? key),'{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_form_personnel(uuid) FROM PUBLIC,ai_hr_app;
