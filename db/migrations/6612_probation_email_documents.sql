-- Read only saved released outcome files. No generation, signature or letter content is changed.
CREATE FUNCTION app.probation_email_document_refs(p_case uuid,p_keys text[]) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.automation_can_run('probation',p_case) IS NOT TRUE THEN RAISE EXCEPTION 'Workflow unavailable' USING ERRCODE='42501';END IF;
 IF coalesce(cardinality(p_keys),0)>100 THEN RAISE EXCEPTION 'Too many document choices' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'templateId',f.definition_key,'name',f.name,'contentHash',f.content_hash,'path','/lifecycle/probation/'||p_case::text||'/files/'||f.id::text) ORDER BY f.definition_key),'[]'::jsonb) INTO result FROM (
  SELECT DISTINCT ON(b.definition_key) f.id,b.definition_key,f.name,f.content_hash FROM probation_file f
  JOIN probation_part p ON p.id=f.part_id AND p.tenant_id=f.tenant_id
  JOIN probation_builder_definition b ON b.id::text=p.data->>'letterTemplateId' AND b.tenant_id=f.tenant_id AND b.kind='template'
  JOIN probation_outcome o ON o.letter_part_id=p.id AND o.tenant_id=p.tenant_id AND o.letter_file_id=f.id AND o.released_at IS NOT NULL
  WHERE f.case_id=p_case AND f.tenant_id=app.current_tenant_id() AND f.kind='letter_released' AND b.definition_key=ANY(p_keys)
  ORDER BY b.definition_key,f.created_at DESC,f.revision DESC,f.id DESC
 ) f;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_email_document_refs(uuid,text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_email_document_refs(uuid,text[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_document_files(p_id uuid,p_token uuid,p_origin text) RETURNS TABLE(id uuid,filename text,mime_type text,bytes text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
 target:=app.automation_email_target(p_id,p_token,p_origin);IF target IS NULL THEN RETURN;END IF;
 RETURN QUERY SELECT f.id,f.name,f.mime_type,encode(f.content,'base64') FROM probation_file f
 JOIN jsonb_array_elements(coalesce(target->'payload'->'mail'->'delivery'->'documents','[]'::jsonb)) r ON r->>'id'=f.id::text AND r->>'contentHash'=f.content_hash AND r->>'attach'='true'
 WHERE f.tenant_id=(target->>'tenantId')::uuid AND f.case_id=(target->>'subjectId')::uuid AND f.kind='letter_released' ORDER BY f.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_document_files(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_email_document_files(uuid,uuid,text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.probation_email_outcome_document(p_case uuid,p_outcome uuid,p_part uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.automation_can_run('probation',p_case) IS NOT TRUE THEN RAISE EXCEPTION 'Workflow unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('id',f.id,'templateId',b.definition_key,'name',f.name,'contentHash',f.content_hash,'path','/lifecycle/probation/'||p_case::text||'/files/'||f.id::text,'outcome',true,'outcomeId',o.id) INTO result
 FROM probation_outcome o JOIN probation_file f ON f.id=o.letter_file_id AND f.tenant_id=o.tenant_id AND f.case_id=o.case_id AND f.kind='letter_released'
 JOIN probation_part part ON part.id=o.letter_part_id AND part.tenant_id=o.tenant_id
 JOIN probation_builder_definition b ON b.id::text=part.data->>'letterTemplateId' AND b.tenant_id=part.tenant_id AND b.kind='template'
 WHERE o.case_id=p_case AND o.tenant_id=app.current_tenant_id() AND o.released_at IS NOT NULL
 AND ((p_outcome IS NOT NULL AND o.id=p_outcome) OR (p_outcome IS NULL AND p_part IS NOT NULL AND o.letter_part_id=p_part));
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_email_outcome_document(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_email_outcome_document(uuid,uuid,uuid) TO ai_hr_app;
