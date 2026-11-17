-- Owner specifically approved these exact shared-Contract date and legacy-owner fixes; no new grants.
CREATE OR REPLACE FUNCTION app.contract_shared_offboarding_intent(p_case uuid,p_run uuid,p_step text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;c public.contract_case;l public.contract_shared_letter;document public.document_signing_document;reason text;
BEGIN
 PERFORM app.contract_shared_lock_source(p_case);
 IF app.contract_shared_effect_held(p_case,p_run,p_step,'startOffboarding') IS NOT TRUE THEN RAISE EXCEPTION 'Protected ending workflow step required' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case FOR UPDATE;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=f.tenant_id AND id=p_case;
 IF f.data->'decision'->>'kind'<>'end' AND f.data->'declined'='null'::jsonb THEN RAISE EXCEPTION 'Only End or a recorded declined renewal can start Offboarding' USING ERRCODE='22023';END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=f.tenant_id AND id=app.contract_shared_released_step_letter(p_case,p_run,p_step);
 IF l.id IS NULL THEN RAISE EXCEPTION 'Release this workflow step letter before handing off' USING ERRCODE='40001';END IF;
 SELECT * INTO document FROM public.document_signing_document WHERE tenant_id=f.tenant_id AND id=l.signing_document_id;
 reason:=CASE WHEN f.data->'declined' IS DISTINCT FROM 'null'::jsonb THEN f.data->'declined'->>'reason' ELSE f.data->'decision'->>'endReason' END;
 RETURN jsonb_build_object('employmentId',c.employment_id,'type',CASE WHEN reason IN('retirement','early_retirement') THEN 'Retirement' ELSE 'Contract end' END,
 'noticeDate',((l.data->>'releasedAt')::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur')::date,'lastDay',f.data->'period'->>'endOn','reason',reason,
 'letterId',l.id,'signingDocumentId',l.signing_document_id,'letterHash',document.data->>'contentHash','offboardingCaseId',f.data->>'offboardingId');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_offboarding_intent(uuid,uuid,text) FROM PUBLIC,ai_hr_app;

-- Same function OID and existing ACL. No new grants. Other subjects retain exactly the old Review-only fallback.
CREATE OR REPLACE FUNCTION app.document_signing_owner_step(p_data jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_data->'route'->'steps')='array' THEN p_data->'route'->'steps' ELSE '[]'::jsonb END) WITH ORDINALITY y(x,n)
 WHERE x->'owner'='true'::jsonb OR x->>'kind'='review' OR p_data->>'subjectType'='contract' AND x->>'kind'='approve'
 ORDER BY coalesce(x->'owner'='true'::jsonb,false) DESC,(x->>'stage')::integer,n LIMIT 1
$$;
