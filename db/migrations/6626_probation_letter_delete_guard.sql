-- Delete from future selection with a retained tombstone; every prior version and audit identity remains intact.
CREATE FUNCTION app.probation_letter_template_delete(p_company uuid,p_key text,p_expected integer,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior probation_builder_definition;result uuid;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_config_admin(p_company) OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Template administrator and deletion reason required' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||p_company::text||'template'||p_key,0));
 SELECT * INTO prior FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='template' AND definition_key=p_key ORDER BY version DESC LIMIT 1;
 IF prior.id IS NULL OR prior.version IS DISTINCT FROM p_expected OR prior.data->'deleted'='true'::jsonb THEN RAISE EXCEPTION 'Read the current template before deleting' USING ERRCODE='40001';END IF;
 IF EXISTS(SELECT 1 FROM probation_builder_definition version JOIN probation_part p ON p.tenant_id=version.tenant_id AND p.data->>'letterTemplateId'=version.id::text WHERE version.tenant_id=prior.tenant_id AND version.company_id=p_company AND version.kind='template' AND version.definition_key=p_key)
 OR EXISTS(SELECT 1 FROM probation_builder_definition version JOIN probation_outcome o ON o.tenant_id=version.tenant_id AND o.template_id=version.id::text WHERE version.tenant_id=prior.tenant_id AND version.company_id=p_company AND version.kind='template' AND version.definition_key=p_key) THEN RAISE EXCEPTION 'This template is in use. Retire its publication; retain every generated document and version.' USING ERRCODE='22023';END IF;
 INSERT INTO probation_builder_definition(tenant_id,company_id,definition_key,kind,version,state,data,created_by,retirement_reason) VALUES(prior.tenant_id,p_company,p_key,'template',prior.version+1,'retired',prior.data||jsonb_build_object('deleted',true,'deletedReason',btrim(p_reason)),app.current_user_id(),btrim(p_reason)) RETURNING id INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_template_delete(uuid,text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_template_delete(uuid,text,integer,text) TO ai_hr_app;
