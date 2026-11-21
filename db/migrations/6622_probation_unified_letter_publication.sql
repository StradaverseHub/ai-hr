-- Unified letter builder publication: explicit Publish owns wording review. Historical versions remain immutable.
CREATE OR REPLACE FUNCTION app.probation_definition_save_legacy_organisation(p_company uuid,p_key text,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid;n integer;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_config_admin(p_company) OR p_kind NOT IN('workflow','template') OR p_data->>'module' IS DISTINCT FROM 'probation' OR p_key !~ '^[a-zA-Z0-9_-]{1,100}$' THEN RAISE EXCEPTION 'Named probation builder administrator required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||p_company::text||p_kind||p_key,0));
 IF p_expected IS NULL OR p_expected<>(SELECT coalesce(max(version),0) FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND definition_key=p_key AND kind=p_kind) THEN RAISE EXCEPTION 'Probation builder definition changed; reload before saving';END IF;
 IF p_publish AND length(btrim(coalesce(p_data->>'name','')))=0 THEN RAISE EXCEPTION 'Name this probation definition';END IF;
 IF p_publish AND p_kind='workflow' AND (jsonb_typeof(p_data->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'steps')=0) THEN RAISE EXCEPTION 'Add workflow steps before publishing';END IF;
 IF p_publish AND p_kind='workflow' AND (p_data->'trigger'->>'event' IS NULL OR p_data->'trigger'->>'event' NOT IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending','letter_released','letter_signing_pending','letter_release_pending','letter_returned','overdue_summary') OR jsonb_array_length(p_data->'steps')>10 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'steps') step WHERE step->>'type' IS DISTINCT FROM 'notify' OR length(btrim(coalesce(step->>'subject',''))) NOT BETWEEN 1 AND 200 OR step->>'subject'~E'[\r\n]' OR length(btrim(coalesce(step->>'body',''))) NOT BETWEEN 1 AND 20000 OR coalesce(step->>'id','')='' OR jsonb_typeof(step->'to') IS DISTINCT FROM 'array' OR jsonb_array_length(step->'to') NOT BETWEEN 1 AND 5 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(step->'to') r WHERE r NOT IN('employee','lm','hod','pbp','gbs')))) THEN RAISE EXCEPTION 'Complete bounded messages, supported events and scoped recipients';END IF;
 IF p_publish AND p_kind='template' AND (jsonb_typeof(p_data->'blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'blocks')=0 OR p_data->>'unfinished' IS DISTINCT FROM 'false') THEN RAISE EXCEPTION 'HR must finish and approve letter wording before publishing';END IF;
 IF p_kind='template' AND (jsonb_typeof(coalesce(p_data->'rules','{}')) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(p_data->'rules','{}')) rule WHERE rule.key NOT IN('businessGroup','businessUnit','company','department','grade','employmentType','title','outcome','extensionNumber') OR jsonb_typeof(rule.value) IS DISTINCT FROM 'array' OR jsonb_array_length(rule.value)>200 OR EXISTS(SELECT 1 FROM jsonb_array_elements(rule.value) item WHERE jsonb_typeof(item)<>'string'))) THEN RAISE EXCEPTION 'Use supported bounded probation letter matching rules';END IF;
 -- 5752: a template version may carry signing and review routing (lib/document-signing-routing.ts). Empty or absent
 -- routing keeps every rule below exactly as before.
 IF p_kind='template' AND p_data ? 'routing' AND app.probation_letter_routing_valid(p_data->'routing') IS NOT TRUE THEN RAISE EXCEPTION 'Complete every step of the signing and review routing';END IF;
 IF p_publish AND p_kind='template' THEN PERFORM app.probation_validate_letter_fields(coalesce(p_data->'fields','[]'),'{}'::jsonb,false);IF coalesce(p_data->>'outcome','') NOT IN('confirm','extend','not_confirm') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') block WHERE block->>'type'='text' AND length(btrim(coalesce(block->>'text','')))>0) OR (CASE WHEN app.probation_letter_routed(p_data) THEN app.probation_letter_routing_signatures_ok(p_data) IS NOT TRUE ELSE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') block WHERE block->>'type'='signature' AND block->>'role'='hr') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') block WHERE block->>'type'='signature' AND block->>'role'='employee') END) THEN RAISE EXCEPTION 'Complete the outcome wording and both actual signature blocks';END IF;END IF;
 SELECT coalesce(max(version),0)+1 INTO n FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND definition_key=p_key AND kind=p_kind;
 INSERT INTO probation_builder_definition(tenant_id,company_id,definition_key,kind,version,state,data,created_by) VALUES(app.current_tenant_id(),p_company,p_key,p_kind,n,CASE WHEN p_publish THEN 'published' ELSE 'draft' END,p_data,app.current_user_id()) RETURNING id INTO v_id;RETURN v_id;
END $$;

--> statement-breakpoint
ALTER FUNCTION app.probation_definition_save(uuid,text,text,jsonb,boolean,integer) RENAME TO probation_definition_save_before_unified_letters_6622;
REVOKE ALL ON FUNCTION app.probation_definition_save_before_unified_letters_6622(uuid,text,text,jsonb,boolean,integer) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_definition_save(p_company uuid,p_key text,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior probation_builder_definition;source_version probation_builder_definition;cfg jsonb;step jsonb;
BEGIN
 IF p_kind='template' THEN
  PERFORM app.probation_write_lock();
  IF NOT app.probation_config_admin(p_company) THEN RAISE EXCEPTION 'Probation template administration is required' USING ERRCODE='42501';END IF;
  IF coalesce(p_data->>'routingRegistry','shared') NOT IN('shared','on-off-boarding') THEN RAISE EXCEPTION 'Choose a registered document routing source';END IF;
  -- Publish itself is the affirmative review. Content/schema/signature checks in the canonical writer remain.
  p_data:=p_data||jsonb_build_object('unfinished',false);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'fields','[]'::jsonb)) field WHERE field->>'owner'='employee') AND p_data->>'routingRegistry' IS DISTINCT FROM 'on-off-boarding' THEN RAISE EXCEPTION 'Employee fields require the native reviewed document route';END IF;
  IF p_publish AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'fields','[]'::jsonb)) field WHERE field->>'owner'='employee' AND field->'required'='true'::jsonb)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'routing','[]'::jsonb)) review WHERE review->'who'->>'kind'='employee' AND review->>'action'='review' AND coalesce(review->'required','true'::jsonb)='true'::jsonb
    AND (review->>'order')::integer<(SELECT min((signer->>'order')::integer) FROM jsonb_array_elements(coalesce(p_data->'routing','[]'::jsonb)) signer WHERE signer->>'action' IN('sign','acknowledge'))) THEN RAISE EXCEPTION 'Required Employee Review must precede signing so employee fields are completed before content locks';END IF;
  IF p_data->>'routingRegistry'='on-off-boarding' THEN
   SELECT * INTO prior FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND definition_key=p_key AND kind='template' ORDER BY version DESC LIMIT 1;
   IF prior.id IS NOT NULL AND coalesce(prior.data->>'routingRegistry','shared')<>'on-off-boarding' THEN
    SELECT * INTO source_version FROM probation_builder_definition WHERE id=(p_data->'routingMigration'->>'sourceVersionId')::uuid AND tenant_id=app.current_tenant_id() AND company_id=p_company AND definition_key=p_key AND kind='template' AND version=(p_data->'routingMigration'->>'sourceVersion')::integer;
    IF source_version.id IS NULL OR p_data->'routingMigration'->'reviewed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Review every saved signing role before switching its routing registry';END IF;
   END IF;
   IF p_publish AND (jsonb_typeof(p_data->'routing') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'routing')=0) THEN RAISE EXCEPTION 'Complete the native signing route before publishing';END IF;
   SELECT data INTO cfg FROM lc_onboarding_config WHERE tenant_id=app.current_tenant_id();
   FOR step IN SELECT value FROM jsonb_array_elements(coalesce(p_data->'routing','[]'::jsonb)) LOOP
    IF step->'who'->>'kind'='routing' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(cfg->'routings','[]'::jsonb)) r WHERE r->>'id'=step->'who'->>'routingId')
     OR step->'who'->>'kind'='group' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(cfg->'groups','[]'::jsonb)) g WHERE g->>'id'=step->'who'->>'groupId') THEN RAISE EXCEPTION 'Choose an existing On/Off Boarding routing or assignment group';END IF;
   END LOOP;
  END IF;
 END IF;
 RETURN app.probation_definition_save_before_unified_letters_6622(p_company,p_key,p_kind,p_data,p_publish,p_expected);
END $$;
REVOKE ALL ON FUNCTION app.probation_definition_save(uuid,text,text,jsonb,boolean,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_definition_save(uuid,text,text,jsonb,boolean,integer) TO ai_hr_app;
