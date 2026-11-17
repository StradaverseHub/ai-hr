-- Capture Shared letterhead at generation and retain visible fallback facts on the real Contract case.
CREATE FUNCTION app.contract_shared_fallback_record(p_case uuid,p_run uuid,p_step text,p_type text,p_details jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;entry jsonb;
BEGIN
 IF p_type NOT IN('generateDocument','requestApproval','sendEmail','notify') OR app.contract_shared_effect_held(p_case,p_run,p_step,p_type) IS NOT TRUE THEN RAISE EXCEPTION 'Protected actual workflow step required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_details) IS DISTINCT FROM 'array' OR jsonb_array_length(p_details)>100 OR octet_length(p_details::text)>100000 THEN RAISE EXCEPTION 'Invalid fallback details' USING ERRCODE='22023';END IF;
 IF p_details='[]'::jsonb THEN RETURN;END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case FOR UPDATE;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(f.data->'fallbacks','[]'::jsonb)) x WHERE x->>'runId'=p_run::text AND x->>'stepId'=p_step) THEN RETURN;END IF;
 entry:=jsonb_build_object('runId',p_run,'stepId',p_step,'stepType',p_type,'at',now(),'details',p_details);
 UPDATE public.contract_shared_case SET data=f.data||jsonb_build_object('revision',f.revision+1,'lastActivityAt',now(),'flags',CASE WHEN f.data->'flags' ? 'fallback' THEN f.data->'flags' ELSE f.data->'flags'||'"fallback"'::jsonb END,'fallbacks',coalesce(f.data->'fallbacks','[]'::jsonb)||jsonb_build_array(entry)),revision=f.revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_fallback_record(uuid,uuid,text,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.contract_shared_letter_values(uuid) RENAME TO contract_shared_letter_values_before_shared_letterhead;
CREATE FUNCTION app.contract_shared_letter_values(p_letter uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_letter_values_before_shared_letterhead(p_letter)||coalesce((SELECT data->'letterheadSnapshot' FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter),'{}'::jsonb)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_values_before_shared_letterhead(uuid),app.contract_shared_letter_values(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.contract_shared_prepare_letter(uuid,uuid,text,uuid,integer,jsonb,jsonb,jsonb) RENAME TO contract_shared_prepare_letter_before_shared_letterhead;
CREATE FUNCTION app.contract_shared_prepare_letter(p_case uuid,p_run uuid,p_step text,p_template uuid,p_version integer,p_route jsonb,p_routing jsonb,p_email_ref jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;letter public.contract_shared_letter;head jsonb;details jsonb;snapshot jsonb;hash text;
BEGIN
 result:=app.contract_shared_prepare_letter_before_shared_letterhead(p_case,p_run,p_step,p_template,p_version,p_route,p_routing,p_email_ref);
 IF result->'existing'='true'::jsonb THEN RETURN result;END IF;
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=(result->>'id')::uuid;
 SELECT jsonb_build_object('company.name',coalesce(nullif(setting->'letterhead'->>'name',''),company.legal_name),
 'company.regNo',coalesce(setting->'letterhead'->>'registrationNo',company.registration_no,''),'company.address',coalesce(setting->'letterhead'->>'address',company.address,''),
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
ALTER FUNCTION app.contract_shared_prepare_approval(uuid,uuid,text,jsonb,jsonb) RENAME TO contract_shared_prepare_approval_before_fallback;
CREATE FUNCTION app.contract_shared_prepare_approval(p_case uuid,p_run uuid,p_step text,p_assignments jsonb,p_route jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;details jsonb;
BEGIN
 result:=app.contract_shared_prepare_approval_before_fallback(p_case,p_run,p_step,p_assignments,p_route);
 SELECT coalesce(jsonb_agg(jsonb_build_object('layerId',a->'layer'->>'id','meantFor',a->'layer'->>'name','reason',a->>'missingReason','fallbackGroupId',a->>'groupId')),'[]'::jsonb) INTO details FROM jsonb_array_elements(p_assignments) a WHERE a->'fallbackUsed'='true'::jsonb;
 PERFORM app.contract_shared_fallback_record(p_case,p_run,p_step,'requestApproval',details);RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_prepare_approval_before_fallback(uuid,uuid,text,jsonb,jsonb),app.contract_shared_prepare_approval(uuid,uuid,text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
