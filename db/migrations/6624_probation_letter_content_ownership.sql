-- Editable employee/HR fields use the same immutable Personnel keys and content fingerprint owner.
CREATE OR REPLACE FUNCTION app.probation_validate_letter_fields(p_fields jsonb,p_merge jsonb,p_preparing boolean DEFAULT true) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field jsonb;control jsonb;key text;value text;rows jsonb;number numeric;required boolean;
BEGIN
 IF jsonb_typeof(p_fields) IS DISTINCT FROM 'array' OR jsonb_array_length(p_fields)>200 OR (SELECT count(DISTINCT f->>'id') FROM jsonb_array_elements(p_fields) f)<>jsonb_array_length(p_fields) THEN RAISE EXCEPTION 'Use bounded uniquely identified letter fields';END IF;
 FOR field IN SELECT item FROM jsonb_array_elements(p_fields) items(item) LOOP
 IF nullif(field->>'id','') IS NULL OR coalesce(field->>'type','') NOT IN('text','textarea','select','date','checkbox','phone','email','number','table') OR coalesce(field->>'owner','') NOT IN('employee','hr','pmLocked') OR field->>'owner'='pmLocked' AND NOT(coalesce(field->>'pmKey','')=ANY(app.probation_letter_protected_keys())) OR field->>'owner' IN('employee','hr') AND (field->>'pmKey' IS NOT NULL OR field->>'id'=ANY(app.probation_letter_protected_keys())) THEN RAISE EXCEPTION 'Use declared HR fields or registered immutable Personnel fields';END IF;
 key:=coalesce(field->>'pmKey',field->>'id');value:=coalesce(p_merge->>key,'');
 IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb THEN SELECT item INTO control FROM jsonb_array_elements(p_fields) items(item) WHERE item->>'id'=field->'when'->>'field';IF control IS NULL THEN RAISE EXCEPTION 'Conditional field source is missing';END IF;IF coalesce(p_merge->>coalesce(control->>'pmKey',control->>'id'),'') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;END IF;
 IF key IN('acknowledgedBy','acknowledgedOn') THEN IF field->>'type' NOT IN('text','textarea') THEN RAISE EXCEPTION 'Authenticated acknowledgement fields use a read-only text value';END IF;CONTINUE;END IF;
 required:=p_preparing AND field->>'owner'<>'employee' AND coalesce((field->>'required')::boolean,false);IF length(value)>20000 OR required AND length(btrim(value))=0 OR required AND field->>'type'='checkbox' AND value<>'true' THEN RAISE EXCEPTION 'Complete every required visible letter field';END IF;
 IF value='' THEN CONTINUE;END IF;
 IF field->>'type'='select' AND NOT(coalesce(field->'options','[]')?value) OR field->>'type'='checkbox' AND value NOT IN('true','false') OR field->>'type'='email' AND value!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN RAISE EXCEPTION 'Use valid declared letter field values';END IF;
 IF field->>'type'='date' THEN IF value!~'^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Use an ISO calendar date';END IF;PERFORM value::date;END IF;
 IF field->>'type'='number' THEN IF value~*'^(NaN|[+-]?Infinity)$' THEN RAISE EXCEPTION 'Use a finite letter field number';END IF;number:=value::numeric;END IF;
 IF field->>'type'='table' THEN rows:=value::jsonb;IF jsonb_typeof(rows) IS DISTINCT FROM 'array' OR jsonb_array_length(rows)>50 OR required AND jsonb_array_length(rows)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(rows) records(item) WHERE jsonb_typeof(item) IS DISTINCT FROM 'array' OR jsonb_array_length(item) IS DISTINCT FROM coalesce(jsonb_array_length(field->'columns'),0) OR EXISTS(SELECT 1 FROM jsonb_array_elements(item) cells(cell) WHERE jsonb_typeof(cell) IS DISTINCT FROM 'string' OR length(cell#>>'{}')>1000)) THEN RAISE EXCEPTION 'Use valid bounded letter table rows';END IF;END IF;
 END LOOP;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN RAISE EXCEPTION 'Use valid declared letter field values';
END $$;

--> statement-breakpoint
CREATE FUNCTION app.probation_letter_edit_content(p_part uuid,p_expected integer,p_edits jsonb,p_values jsonb,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE part probation_part;subject_case probation_case;signing document_signing_document;blocks jsonb;merged jsonb;field jsonb;key text;value jsonb;block jsonb;owner text;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO part FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;
 SELECT * INTO subject_case FROM probation_case WHERE id=part.case_id AND tenant_id=part.tenant_id;
 SELECT * INTO signing FROM document_signing_document WHERE subject_type='probation' AND subject_id=part.id AND tenant_id=part.tenant_id FOR UPDATE;
 IF part.id IS NULL OR part.data->>'documentKind' IS DISTINCT FROM 'letter' OR part.revision IS DISTINCT FROM p_expected OR part.data->>'state' IN('locked','cancelled','release_requested') OR signing.id IS NULL
  OR app.document_signing_can_edit(signing.data,app.current_user_id()) IS NOT TRUE OR app.probation_signing_access(part.id,'revise') IS NOT TRUE THEN RAISE EXCEPTION 'Current owner or Review step and unsigned editable content are required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_assert_case_runtime(subject_case.id);
 IF length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 5000 OR jsonb_typeof(p_edits) IS DISTINCT FROM 'object' OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_each(p_edits))>500 OR (SELECT count(*) FROM jsonb_each(p_values))>200 THEN RAISE EXCEPTION 'Supply bounded document changes and a reason';END IF;
 blocks:=part.data->'letterBlocks';merged:=part.data->'letterMerge';
 FOR key,value IN SELECT * FROM jsonb_each(p_edits) LOOP
  SELECT item INTO block FROM jsonb_array_elements(blocks) item WHERE item->>'id'=key AND item->>'type' IN('heading','subheading','text');
  IF block IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'string' OR length(value#>>'{}')>20000 THEN RAISE EXCEPTION 'Only existing editable wording blocks can change';END IF;
  IF (value#>>'{}') ~ '[{][{]|[}][}]' OR EXISTS(SELECT 1 FROM regexp_matches(value#>>'{}','[{]([^{}]+)[}]','g') token WHERE NOT((token[1])=ANY(app.probation_letter_protected_keys())) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(part.data->'letterFields','[]'::jsonb)) declared WHERE declared->>'id'=token[1])) THEN RAISE EXCEPTION 'Use a registered letter merge field';END IF;
  SELECT jsonb_agg(CASE WHEN item->>'id'=key THEN jsonb_set(item,'{text}',value) ELSE item END ORDER BY n) INTO blocks FROM jsonb_array_elements(blocks) WITH ORDINALITY x(item,n);
 END LOOP;
 owner:=CASE WHEN app.probation_role(subject_case.employment_id,'employee') THEN 'employee' ELSE 'hr' END;
 FOR key,value IN SELECT * FROM jsonb_each(p_values) LOOP
  SELECT item INTO field FROM jsonb_array_elements(coalesce(part.data->'letterFields','[]'::jsonb)) item WHERE item->>'id'=key;
  IF field IS NULL OR field->>'owner' IS DISTINCT FROM owner OR field->>'pmKey' IS NOT NULL OR key=ANY(app.probation_letter_protected_keys()) OR jsonb_typeof(value) IS DISTINCT FROM 'string' OR length(value#>>'{}')>20000 THEN RAISE EXCEPTION 'This field belongs to another owner or Personnel Management' USING ERRCODE='42501';END IF;
  merged:=jsonb_set(merged,ARRAY[key],value,true);
 END LOOP;
 PERFORM app.probation_validate_letter_fields(coalesce(part.data->'letterFields','[]'::jsonb),merged,false);
 IF blocks IS NOT DISTINCT FROM part.data->'letterBlocks' AND merged IS NOT DISTINCT FROM part.data->'letterMerge' THEN RETURN app.probation_signing_content(part.id)||jsonb_build_object('changed',false,'documentId',signing.id);END IF;
 UPDATE probation_part SET data=data||jsonb_build_object('letterBlocks',blocks,'letterMerge',merged),revision=revision+1,content_revision=content_revision+1,updated_at=now() WHERE id=part.id;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(part.tenant_id,part.id,'meta',part.revision+1,(SELECT data FROM probation_part WHERE id=part.id),app.current_user_id(),p_reason);
 PERFORM app.probation_audit(part.case_id,part.id,'letter_content_edited',p_reason);
 RETURN app.probation_signing_content(part.id)||jsonb_build_object('changed',true,'documentId',signing.id);
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_edit_content(uuid,integer,jsonb,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_edit_content(uuid,integer,jsonb,jsonb,text) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.probation_signing_action_allowed(uuid,jsonb) RENAME TO probation_signing_action_before_letter_fields_6624;
REVOKE ALL ON FUNCTION app.probation_signing_action_before_letter_fields_6624(uuid,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_signing_action_allowed(p_subject uuid,p_action jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE part probation_part;fields jsonb;
BEGIN
 IF app.probation_signing_action_before_letter_fields_6624(p_subject,p_action) IS NOT TRUE THEN RETURN false;END IF;
 SELECT * INTO part FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();
 IF part.data->>'documentKind'='letter' AND p_action->>'action'='signed' THEN
  -- Final signature validation requires employee values too; preparation only required HR/Personnel values.
  SELECT coalesce(jsonb_agg(CASE WHEN field->>'owner'='employee' THEN field||jsonb_build_object('owner','hr') ELSE field END),'[]'::jsonb) INTO fields FROM jsonb_array_elements(coalesce(part.data->'letterFields','[]'::jsonb)) field;
  PERFORM app.probation_validate_letter_fields(fields,part.data->'letterMerge',true);
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.probation_signing_action_allowed(uuid,jsonb) FROM PUBLIC,ai_hr_app;
