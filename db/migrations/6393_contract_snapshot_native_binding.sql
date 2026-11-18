-- Forward repair for actual canonical Shared company address columns; frozen 5944 remains unchanged.
CREATE OR REPLACE FUNCTION app.contract_shared_prepare_letter(p_case uuid,p_run uuid,p_step text,p_template uuid,p_version integer,p_route jsonb,p_routing jsonb,p_email_ref jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;letter public.contract_shared_letter;head jsonb;details jsonb;snapshot jsonb;hash text;
BEGIN
 result:=app.contract_shared_prepare_letter_before_shared_letterhead(p_case,p_run,p_step,p_template,p_version,p_route,p_routing,p_email_ref);
 IF result->'existing'='true'::jsonb THEN RETURN result;END IF;
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=(result->>'id')::uuid;
 SELECT jsonb_build_object('company.name',coalesce(nullif(setting->'letterhead'->>'name',''),company.legal_name),
 'company.regNo',coalesce(setting->'letterhead'->>'registrationNo',company.registration_no,''),'company.address',coalesce(setting->'letterhead'->>'address',concat_ws(', ',nullif(trim(company.address_line1),''),nullif(trim(company.address_line2),''),nullif(trim(company.address_line3),''),nullif(trim(company.postcode),''),nullif(trim(company.city),''),nullif(trim(company.state),''),nullif(trim(company.address_country),'')),''),
 'company.color',coalesce(setting->'letterhead'->>'color','#4F46E5')) INTO head
 FROM public.contract_case c JOIN public.company company ON company.tenant_id=c.tenant_id AND company.id=c.company_id
 LEFT JOIN public.lc_v9_config cfg ON cfg.tenant_id=c.tenant_id LEFT JOIN LATERAL(SELECT x AS setting FROM jsonb_array_elements(coalesce(cfg.data->'companies','[]'::jsonb)) x WHERE x->>'companyId'=company.id::text LIMIT 1) selected ON true WHERE c.tenant_id=letter.tenant_id AND c.id=letter.case_id;
 UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{letterheadSnapshot}',head) WHERE tenant_id=letter.tenant_id AND id=letter.id;
 snapshot:=app.contract_shared_letter_snapshot(letter.id);hash:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{values}',snapshot->'values') WHERE tenant_id=letter.tenant_id AND id=letter.id;
 INSERT INTO public.contract_shared_letter_content(tenant_id,letter_id,content_revision,content_hash,snapshot) VALUES(letter.tenant_id,letter.id,(letter.data->>'contentRevision')::integer,hash,snapshot) ON CONFLICT DO NOTHING;
 IF letter.purpose<>'email' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('stepId',s->>'id','meantFor',s->>'meantFor','fallbackGroupId',p_routing->>'fallbackGroupId','assignedUserId',s->>'holderId')),'[]'::jsonb) INTO details FROM jsonb_array_elements(p_route->'steps') s WHERE nullif(s->>'meantFor','') IS NOT NULL AND s->>'holderId' IS NOT NULL AND s->>'role'<>'employee';
  PERFORM app.contract_shared_fallback_record(p_case,p_run,p_step,'generateDocument',details);
 END IF;
 RETURN result||jsonb_build_object('contentHash',hash);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_prepare_letter_before_shared_letterhead(uuid,uuid,text,uuid,integer,jsonb,jsonb,jsonb),app.contract_shared_prepare_letter(uuid,uuid,text,uuid,integer,jsonb,jsonb,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Re-parse both existing SQL call sites after wrapping, preserving their OIDs and ACLs.
CREATE OR REPLACE FUNCTION app.contract_shared_prepare_letter(p_case uuid,p_run uuid,p_step text,p_template uuid,p_version integer,p_route jsonb,p_routing jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_prepare_letter(p_case,p_run,p_step,p_template,p_version,p_route,p_routing,NULL)
$$;
CREATE OR REPLACE FUNCTION app.contract_shared_letter_snapshot(p_letter uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',l.id,'caseId',l.case_id,'decisionRevision',l.decision_revision,'contentRevision',(l.data->>'contentRevision')::integer,
 'templateId',l.data->>'templateId','templateVersion',l.data->'templateVersion','generatedOn',l.data->>'generatedOn','definition',l.data->'definition','blocks',l.data->'blocks','values',app.contract_shared_letter_values(l.id))
 FROM public.contract_shared_letter l WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_values(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f jsonb;source jsonb;values jsonb;aliases jsonb;amount text;definition text;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 values:=app.contract_shared_letter_values_before_shared_letterhead(p_letter)||coalesce(l.data->'letterheadSnapshot','{}'::jsonb);
 IF l.data->'letterheadSnapshot' IS NULL OR l.data->'valuesFixed'='true'::jsonb OR app.contract_shared_decision_current(l.case_id,l.decision_revision) IS NOT TRUE THEN RETURN values;END IF;
 SELECT flow.data,app.contract_source(c.employment_id) INTO f,source FROM public.contract_shared_case flow JOIN public.contract_case c ON c.tenant_id=flow.tenant_id AND c.id=flow.case_id WHERE flow.tenant_id=l.tenant_id AND flow.case_id=l.case_id;
 amount:=source->>'allowanceCents';
 aliases:=jsonb_build_object('decision.type',CASE f->'decision'->>'kind' WHEN 'renew' THEN 'Renew' WHEN 'convert' THEN 'Convert to permanent' WHEN 'end' THEN 'End' ELSE '' END,'decision.reason',coalesce(f->'decision'->>'reason',''),'decision.endReason',coalesce(f->'decision'->>'endReason',''),'decision.declineReason',coalesce(f->'declined'->>'reason',''),'contract.lastDay',coalesce(f->'period'->>'endOn',''),'contract.allowance',CASE WHEN amount ~ '^[0-9]+$' THEN (amount::bigint/100)::text||'.'||lpad((amount::bigint%100)::text,2,'0') ELSE '' END);
 definition:=(l.data->'definition')::text||coalesce(l.data->'blocks','{}'::jsonb)::text;
 RETURN values||coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(aliases) WHERE strpos(definition,'{'||key||'}')>0 OR strpos(definition,'"'||key||'"')>0),'{}'::jsonb);
END $$;
