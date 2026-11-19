-- Per-definition reviewed conversion. No tenant-wide switch, historical rewrite or inferred organisation mapping.
CREATE OR REPLACE FUNCTION app.probation_definition_save_before_unified_letters_6622(p_company uuid,p_key text,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior text;m text;k text;v jsonb;item jsonb;review jsonb;source probation_builder_definition;mapping jsonb;target text;codes jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_config_admin(p_company) THEN RAISE EXCEPTION 'Probation template administration required';END IF;
 IF p_expected>0 THEN SELECT coalesce(data->>'organisationMapping','legacy-v1') INTO prior FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind=p_kind AND definition_key=p_key AND version=p_expected;END IF;
 m:=coalesce(p_data->>'organisationMapping',prior,app.probation_organisation_mapping());review:=p_data->'organisationMigration';
 IF p_kind='template' AND review IS NOT NULL THEN
  IF m<>'personnel-v2' OR review->'reviewed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(review->'mappings') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Review the saved matching inventory';END IF;
  IF review->>'sourceVersionId' IS NOT NULL THEN
   SELECT * INTO source FROM probation_builder_definition WHERE id=(review->>'sourceVersionId')::uuid AND tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='template' AND definition_key=p_key AND version=(review->>'sourceVersion')::integer;
   IF source.id IS NULL THEN RAISE EXCEPTION 'The reviewed source version is unavailable';END IF;
   FOR k,v IN SELECT key,value FROM jsonb_each(coalesce(source.data->'rules','{}')) WHERE key IN('businessGroup','businessUnit','company','department','grade') LOOP
    FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
     IF (SELECT count(*) FROM jsonb_array_elements(review->'mappings') row WHERE row->>'sourceField'=k AND row->'sourceValue'=item)<>1 THEN RAISE EXCEPTION 'Review every saved rule value exactly once';END IF;
    END LOOP;
   END LOOP;
   FOR mapping IN SELECT value FROM jsonb_array_elements(review->'mappings') LOOP
    k:=mapping->>'sourceField';target:=CASE WHEN k='businessGroup' AND coalesce(source.data->>'organisationMapping','legacy-v1')='legacy-v1' THEN 'company' WHEN k='businessUnit' AND coalesce(source.data->>'organisationMapping','legacy-v1')='legacy-v1' THEN 'businessGroup' WHEN k='businessUnit' THEN 'company' ELSE k END;
    IF mapping->>'targetField' IS DISTINCT FROM target OR NOT coalesce(source.data->'rules'->k,'[]'::jsonb)?(mapping->>'sourceValue') OR jsonb_typeof(mapping->'targetValues') IS DISTINCT FROM 'array' OR jsonb_array_length(mapping->'targetValues')=0 THEN RAISE EXCEPTION 'Keep each source rule and its actual identity kind in the review';END IF;
    IF k='businessGroup' AND coalesce(source.data->>'organisationMapping','legacy-v1')='legacy-v1' AND NOT EXISTS(SELECT 1 FROM company WHERE id=p_company AND tenant_id=app.current_tenant_id() AND coalesce(parent_company_id,id)::text=mapping->>'sourceValue') THEN RAISE EXCEPTION 'The saved parent company does not contain this template company';END IF;
    IF (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(mapping->'targetValues'))<>jsonb_array_length(mapping->'targetValues') THEN RAISE EXCEPTION 'Review unique target identities';END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(mapping->'targetValues') LOOP
     IF target='company' AND item#>>'{}'<>p_company::text
      OR target='businessGroup' AND NOT EXISTS(SELECT 1 FROM business_unit WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND id::text=item#>>'{}' AND archived_at IS NULL)
      OR target='department' AND NOT EXISTS(SELECT 1 FROM department WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND id::text=item#>>'{}' AND archived_at IS NULL)
      OR target='grade' AND NOT EXISTS(SELECT 1 FROM job_grade WHERE tenant_id=app.current_tenant_id() AND id::text=item#>>'{}' AND archived_at IS NULL AND (scope_company_ids IS NULL OR p_company=any(scope_company_ids))) THEN RAISE EXCEPTION 'Resolve each reviewed target to an active identity in this company';END IF;
    END LOOP;
   END LOOP;
  ELSIF p_expected<>0 OR coalesce((review->>'sourceVersion')::integer,-1)<>0 OR jsonb_array_length(review->'mappings')<>0 THEN
   -- Subsequent versions of a canonical definition retain the original new-definition review.
   IF NOT EXISTS(SELECT 1 FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='template' AND definition_key=p_key AND data->'organisationMigration'=review) THEN RAISE EXCEPTION 'Name the original matching source version';END IF;
  END IF;
  IF p_publish THEN
   IF coalesce(p_data->'rules'->'company','[]'::jsonb)<>jsonb_build_array(p_company::text) THEN RAISE EXCEPTION 'Keep the explicit template Company scope';END IF;
   FOR k,v IN SELECT key,value FROM jsonb_each(coalesce(p_data->'rules','{}')) LOOP
    FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
     IF k='businessGroup' AND NOT EXISTS(SELECT 1 FROM business_unit WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND id::text=item#>>'{}' AND archived_at IS NULL)
      OR k='department' AND NOT EXISTS(SELECT 1 FROM department WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND id::text=item#>>'{}' AND archived_at IS NULL)
      OR k='grade' AND NOT EXISTS(SELECT 1 FROM job_grade WHERE tenant_id=app.current_tenant_id() AND id::text=item#>>'{}' AND archived_at IS NULL AND (scope_company_ids IS NULL OR p_company=any(scope_company_ids)))
      OR k='title' AND NOT EXISTS(SELECT 1 FROM position WHERE tenant_id=app.current_tenant_id() AND (company_id=p_company OR is_global) AND id::text=item#>>'{}' AND archived_at IS NULL)
      OR k='employmentType' AND item#>>'{}' NOT IN('Permanent','Contract','Probation') OR k='businessUnit' AND jsonb_array_length(v)>0 THEN RAISE EXCEPTION 'Resolve every unknown or archived matching value before publication';END IF;
    END LOOP;
   END LOOP;
  END IF;
  SELECT coalesce(jsonb_object_agg(g.id::text,regexp_replace(upper(g.code),'^(JG|GRADE)[ -]*','','g')),'{}'::jsonb) INTO codes FROM job_grade g WHERE g.tenant_id=app.current_tenant_id() AND coalesce(p_data->'rules'->'grade','[]'::jsonb)?g.id::text AND g.archived_at IS NULL AND (SELECT count(*) FROM job_grade duplicate WHERE duplicate.tenant_id=g.tenant_id AND duplicate.archived_at IS NULL AND regexp_replace(upper(duplicate.code),'^(JG|GRADE)[ -]*','','g')=regexp_replace(upper(g.code),'^(JG|GRADE)[ -]*','','g'))=1;
  p_data:=p_data||jsonb_build_object('gradeAtStartCodes',codes);
 ELSIF m NOT IN('legacy-v1','personnel-v2') OR p_publish AND m='personnel-v2' AND app.probation_organisation_mapping()<>'personnel-v2' THEN RAISE EXCEPTION 'Review the organisation mapping inventory before publishing replacement scopes';
 ELSIF p_kind='workflow' THEN PERFORM app.probation_assert_organisation_scope(coalesce(p_data->'conditions','{}'),m,p_company);
 ELSIF p_kind='template' THEN
  FOR k,v IN SELECT key,value FROM jsonb_each(coalesce(p_data->'rules','{}')) WHERE key IN('businessGroup','businessUnit') LOOP FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP PERFORM app.probation_assert_organisation_scope(jsonb_build_object(k||'Id',item),m,p_company);END LOOP;END LOOP;
 END IF;
 RETURN app.probation_definition_save_legacy_organisation(p_company,p_key,p_kind,p_data||jsonb_build_object('organisationMapping',m),p_publish,p_expected);
END $$;
--> statement-breakpoint
ALTER FUNCTION app.probation_letter_template_score(uuid,uuid) RENAME TO probation_letter_template_score_legacy_6625;
REVOKE ALL ON FUNCTION app.probation_letter_template_score_legacy_6625(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_letter_template_score(p_outcome uuid,p_template uuid) RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;source jsonb;placement assignment;employee employment;k text;rule_values jsonb;actual text;score integer:=0;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=app.current_tenant_id();
 IF t.data->'organisationMigration' IS NULL THEN RETURN app.probation_letter_template_score_legacy_6625(p_outcome,p_template);END IF;
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF t.company_id IS DISTINCT FROM c.company_id OR t.kind<>'template' OR t.state<>'published' OR t.data->>'unfinished'<>'false' OR t.data->>'outcome'<>o.outcome OR EXISTS(SELECT 1 FROM probation_builder_definition later WHERE later.tenant_id=t.tenant_id AND later.company_id=t.company_id AND later.kind=t.kind AND later.definition_key=t.definition_key AND later.version>t.version AND later.state IN('published','retired')) THEN RETURN NULL;END IF;
 source:=app.probation_organisation_facts(app.probation_personnel_source(c.employment_id),t.data);
 SELECT * INTO placement FROM assignment WHERE employment_id=c.employment_id AND tenant_id=c.tenant_id AND superseded_at IS NULL AND valid_from<=greatest(day,(source->>'startOn')::date) AND (valid_to IS NULL OR valid_to>greatest(day,(source->>'startOn')::date)) ORDER BY valid_from DESC,id LIMIT 1;
 SELECT * INTO employee FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id;
 FOR k,rule_values IN SELECT key,value FROM jsonb_each(t.data->'rules') LOOP
  IF jsonb_array_length(rule_values)=0 THEN CONTINUE;END IF;
  actual:=CASE k WHEN 'businessGroup' THEN source->>'businessGroupId' WHEN 'company' THEN c.company_id::text WHEN 'department' THEN source->>'departmentId' WHEN 'title' THEN placement.position_id::text WHEN 'grade' THEN c.data->'facts'->>'gradeId' WHEN 'employmentType' THEN initcap(app.lc_v9_employment_class(jsonb_build_object('employmentType',placement.employment_type,'joinDate',source->>'startOn','finalConfirmationDate',employee.final_confirmation_date,'confirmationDate',employee.confirmation_date,'probationEndDate',employee.probation_end_date,'provisionalEndOn',employee.provisional_end_on))) WHEN 'outcome' THEN o.outcome WHEN 'extensionNumber' THEN CASE WHEN o.outcome='extend' THEN ((c.data->>'extensionCount')::integer+1)::text ELSE c.data->>'extensionCount' END END;
  IF k='grade' AND actual IS NULL THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(coalesce(t.data->'gradeAtStartCodes','{}'::jsonb)) code WHERE rule_values?code.key AND code.value=c.data->>'gradeAtStart') THEN RETURN NULL;END IF;
  ELSIF (rule_values?actual) IS NOT TRUE THEN RETURN NULL;END IF;
  score:=score+1;
 END LOOP;
 RETURN score;
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_template_score(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Legacy ties retain their explicit selection hold. Reviewed native ties expose the stable first choice already shown.
ALTER FUNCTION app.probation_letter_template_choices(uuid) RENAME TO probation_letter_template_choices_before_6625;
REVOKE ALL ON FUNCTION app.probation_letter_template_choices_before_6625(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_letter_template_choices(p_outcome uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;first_id uuid;
BEGIN
 result:=app.probation_letter_template_choices_before_6625(p_outcome);first_id:=(result->'templates'->0->>'id')::uuid;
 IF first_id IS NOT NULL AND result->'suggestedTemplateId'='null'::jsonb AND EXISTS(SELECT 1 FROM probation_builder_definition WHERE id=first_id AND tenant_id=app.current_tenant_id() AND data->'organisationMigration' IS NOT NULL) THEN result:=result||jsonb_build_object('suggestedTemplateId',first_id);END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_template_choices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_template_choices(uuid) TO ai_hr_app;
