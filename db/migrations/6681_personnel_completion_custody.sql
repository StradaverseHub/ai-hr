-- Version boundary and private, transaction-bound custody. No participant receives unused Personnel values.
CREATE TABLE lifecycle_personnel_completion_custody (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL,
 document_id text NOT NULL,case_revision integer NOT NULL,actor_user_id uuid REFERENCES app_user(id),
 transaction_id xid8 NOT NULL,operation text NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(operation IN('save','submit','refresh','override','adopt'))
);
ALTER TABLE lifecycle_personnel_completion_custody ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_personnel_completion_custody FORCE ROW LEVEL SECURITY;
CREATE POLICY personnel_completion_custody_tenant ON lifecycle_personnel_completion_custody USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
CREATE INDEX personnel_completion_custody_lookup ON lifecycle_personnel_completion_custody(tenant_id,case_id,document_id,case_revision,transaction_id);
REVOKE ALL ON lifecycle_personnel_completion_custody FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.personnel_completion_group(key text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN key=ANY(ARRAY['employee.icNo','race','religion','nationality','gender','marital','employee.passportNo','mobile','homePhone','personalEmail','address']) THEN 'personal'
 WHEN key=ANY(ARRAY['employee.empNo','employee.name','email','company.name','employee.department','employee.position','employee.supervisor','joiner.joinDate','leaver.lastDay']) THEN 'employment' ELSE 'unknown' END
$$;
CREATE FUNCTION app.personnel_completion_owner(d jsonb,f jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app AS $$
 SELECT CASE WHEN f->>'owner'<>'pmLocked' THEN f->>'owner'
 WHEN d->'personnelCompletion'->'fields'->(f->>'id') IS NULL OR d->'personnelCompletion'->'fields'->(f->>'id')->>'key' IS DISTINCT FROM f->>'pmKey' OR btrim(coalesce(d->'personnelCompletion'->'fields'->(f->>'id')->>'sourceValue',''))<>'' THEN 'pmLocked'
 WHEN app.personnel_completion_group(f->>'pmKey')='unknown' THEN 'hr'
 ELSE coalesce(d->'personnelCompletion'->'fields'->(f->>'id')->'override'->>'owner',CASE app.personnel_completion_group(f->>'pmKey') WHEN 'personal' THEN 'employee' ELSE 'hr' END) END
$$;
CREATE FUNCTION app.personnel_completion_locked(d jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app AS $$
 SELECT coalesce(d->'employeeSignature'<>'null'::jsonb,false) OR coalesce(d->'hrSignature'<>'null'::jsonb,false)
 OR coalesce(app.document_signing_locked(d->'signing'),false) OR coalesce(d->>'status' IN('withdrawn','superseded'),false)
 OR jsonb_typeof(d->'signing') IS DISTINCT FROM 'object' AND coalesce(d->>'status' IN('signed','completed','acknowledged'),false)
$$;
CREATE FUNCTION app.personnel_completion_official(d jsonb,source jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE field jsonb;value text;result jsonb:='{}';
BEGIN
 FOR field IN SELECT item FROM jsonb_array_elements(d->'fields') item WHERE item->>'owner'='pmLocked' AND coalesce(item->>'pmKey','') NOT IN('signatory.name','signatory.title') LOOP
  value:=CASE WHEN left(field->>'pmKey',1)<>'_' THEN coalesce(source->>(field->>'pmKey'),'') ELSE '' END;
  IF field->>'type'='date' AND value<>'' THEN value:=CASE WHEN value~'^\d{2}/\d{2}/\d{4}$' THEN to_char(to_date(value,'DD/MM/YYYY'),'YYYY-MM-DD') WHEN value~'^\d{4}-\d{2}-\d{2}$' THEN value ELSE '' END;END IF;
  result:=result||jsonb_build_object(field->>'id',value);
 END LOOP;RETURN result;
END $$;
CREATE FUNCTION app.personnel_completion_fingerprint(p_values jsonb,p_country text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('values',p_values,'country',p_country)::text,'UTF8')),'hex')
$$;
CREATE FUNCTION app.personnel_completion_custody(prior jsonb,next jsonb,p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM lifecycle_personnel_completion_custody c WHERE c.tenant_id=app.current_tenant_id() AND c.case_id=p_case AND c.document_id=next->>'id'
  AND c.case_revision=p_revision AND c.transaction_id=pg_current_xact_id() AND c.actor_user_id IS NOT DISTINCT FROM app.current_user_id()
  AND c.before_hash=encode(sha256(convert_to(prior::text,'UTF8')),'hex') AND c.after_hash=encode(sha256(convert_to(next::text,'UTF8')),'hex'))
$$;
REVOKE ALL ON FUNCTION app.personnel_completion_custody(jsonb,jsonb,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_completion_custody(jsonb,jsonb,uuid,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.personnel_completion_scalar(field jsonb,value text) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,app AS $$
BEGIN
 IF length(value)>20000 THEN RAISE EXCEPTION 'Keep this value within 20,000 characters';END IF;
 IF value='' THEN RETURN;END IF;
 IF field->>'type'='phone' AND app.personnel_completion_phone_valid(value) IS NOT TRUE THEN RAISE EXCEPTION 'Enter a valid international phone number';END IF;
 IF field->>'type'='email' AND value!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN RAISE EXCEPTION 'Enter a valid email address';END IF;
 IF field->>'type'='number' THEN IF value!~'^-?(\d+([.]\d+)?|[.]\d+)$' THEN RAISE EXCEPTION 'Enter a valid number';END IF;PERFORM value::numeric;IF abs(value::numeric)>=4.9406564584124654e-324 THEN PERFORM value::double precision;END IF;END IF;
 IF field->>'type'='date' THEN IF value!~'^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Enter a valid calendar date';END IF;PERFORM value::date;END IF;
 IF field->>'type'='checkbox' AND value NOT IN('true','false') OR field->>'type'='select' AND NOT coalesce(field->'options','[]'::jsonb)?value THEN RAISE EXCEPTION 'Use a declared field value';END IF;
END $$;
CREATE FUNCTION app.personnel_completion_render_values(d jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app AS $$
 SELECT coalesce(jsonb_object_agg(f->>'pmKey',CASE WHEN f->>'type'='date' AND answer.value~'^\d{4}-\d{2}-\d{2}$' THEN to_char(answer.value::date,'DD/MM/YYYY') WHEN answer.value='' AND f->>'required' IS DISTINCT FROM 'true' THEN '—' ELSE answer.value END ORDER BY ordinal),'{}'::jsonb)
 FROM jsonb_array_elements(coalesce(d->'fields','[]'::jsonb)) WITH ORDINALITY x(f,ordinal)
 CROSS JOIN LATERAL(SELECT CASE WHEN btrim(coalesce(d->'personnelCompletion'->'fields'->(f->>'id')->>'sourceValue',''))<>'' THEN d->'personnelCompletion'->'fields'->(f->>'id')->>'sourceValue' ELSE coalesce(d->'values'->>(f->>'id'),'') END AS value) answer
 WHERE f->>'pmKey' IS NOT NULL AND d->'personnelCompletion'->'fields'?(f->>'id') AND (f->'when' IS NULL OR f->'when'='null'::jsonb OR d->'values'->>(f->'when'->>'field')=f->'when'->>'value')
$$;
REVOKE ALL ON FUNCTION app.personnel_completion_render_values(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_completion_render_values(jsonb) TO ai_hr_app;
CREATE FUNCTION app.personnel_completion_assert_current(d jsonb,p_case uuid,p_final boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;official jsonb;field jsonb;entry jsonb;value text;
BEGIN
 IF NOT d?'personnelCompletion' THEN RETURN;END IF;
 source:=app.v9_document_personnel_source_unchecked(p_case);official:=app.personnel_completion_official(d,source);
 IF source IS NULL OR d->'personnelCompletion'->>'sourceFingerprint' IS DISTINCT FROM app.personnel_completion_fingerprint(official,d->'personnelCompletion'->>'country') THEN RAISE EXCEPTION 'Personnel values changed. Refresh before continuing';END IF;
 FOR field IN SELECT item FROM jsonb_array_elements(d->'fields') item LOOP
  IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb AND d->'values'->>(field->'when'->>'field') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;
  value:=coalesce(d->'values'->>(field->>'id'),'');entry:=d->'personnelCompletion'->'fields'->(field->>'id');
  IF field->>'owner'='pmLocked' AND coalesce(field->>'pmKey','') NOT IN('signatory.name','signatory.title') THEN
   IF entry->>'sourceValue' IS DISTINCT FROM official->>(field->>'id') THEN RAISE EXCEPTION 'The current Personnel source changed';END IF;
   IF btrim(coalesce(entry->>'sourceValue',''))<>'' AND value IS DISTINCT FROM entry->>'sourceValue' THEN RAISE EXCEPTION 'Personnel values are locked';END IF;
  END IF;
  IF app.personnel_completion_owner(d,field)<>'pmLocked' THEN PERFORM app.personnel_completion_scalar(field,value);END IF;
  IF p_final AND field->>'required'='true' AND (btrim(value)='' OR field->>'type'='checkbox' AND value<>'true' OR field->>'type'='table' AND value='[]') THEN RAISE EXCEPTION 'Complete required document fields before signing';END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.personnel_completion_assert_current(jsonb,uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.v9_personnel_completion_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_docs jsonb;new_docs jsonb;d jsonb;prior jsonb;source_case uuid;target_revision integer;source jsonb;signature_source jsonb;official jsonb;policy jsonb;expected_fields jsonb;field jsonb;actor jsonb;company uuid;native lc_onboarding_case;definition jsonb;version jsonb;config jsonb;native_config jsonb;first_signature boolean;new_signature jsonb;signer_person uuid;is_hr boolean;signatory_config jsonb;signatory_name text;signatory_title text;signatory_allowed boolean;company_entitled boolean;
BEGIN
 IF TG_TABLE_NAME='lc_onboarding_private' THEN
  source_case:=NEW.case_id;SELECT * INTO native FROM lc_onboarding_case WHERE id=source_case AND tenant_id=NEW.tenant_id;company:=native.company_id;target_revision:=native.revision;
  old_docs:=CASE WHEN TG_OP='INSERT' THEN '[]'::jsonb ELSE coalesce(OLD.data->'lifecycleV9'->'documents','[]'::jsonb) END;new_docs:=coalesce(NEW.data->'lifecycleV9'->'documents','[]'::jsonb);
 ELSE
  source_case:=NEW.id;company:=NEW.company_id;target_revision:=NEW.revision;
  old_docs:=CASE WHEN TG_OP='INSERT' THEN '[]'::jsonb ELSE coalesce(OLD.data->'documents','[]'::jsonb) END;new_docs:=coalesce(NEW.data->'documents','[]'::jsonb);
 END IF;
 IF NOT(session_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper)) AND EXISTS(SELECT 1 FROM jsonb_array_elements(new_docs) candidate WHERE NOT candidate?'personnelCompletion' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(old_docs) existing_document WHERE existing_document->>'id'=candidate->>'id') AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(candidate->'fields','[]'::jsonb)) configured_field WHERE configured_field->>'owner'='pmLocked' AND coalesce(configured_field->>'pmKey','') NOT IN('signatory.name','signatory.title'))) THEN RAISE EXCEPTION 'New Personnel-linked documents require versioned completion custody';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(old_docs||new_docs) candidate WHERE candidate?'personnelCompletion' OR candidate->'mergeValues'?|ARRAY['signatory.name','signatory.title'] OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(candidate->'fields','[]'::jsonb)) f WHERE f->>'owner'='pmLocked' AND f->>'pmKey' IN('signatory.name','signatory.title'))) THEN RETURN NEW;END IF;
 company_entitled:=app.probation_company_entitled(company);
 SELECT data INTO config FROM lc_v9_config WHERE tenant_id=NEW.tenant_id;
 SELECT data INTO native_config FROM lc_onboarding_config WHERE tenant_id=NEW.tenant_id;
 SELECT jsonb_build_object('id',u.id,'name',coalesce(p.full_name,'User')),u.person_id INTO actor,signer_person FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF actor IS NULL AND app.current_user_id() IS NULL AND (session_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper)) THEN actor:='{"id":"system","name":"System"}'::jsonb;END IF;
 FOR prior IN SELECT item FROM jsonb_array_elements(old_docs) item WHERE item?'personnelCompletion' OR item->'mergeValues'?|ARRAY['signatory.name','signatory.title'] LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(new_docs) item WHERE item->>'id'=prior->>'id') AND (app.personnel_completion_locked(prior) OR prior->>'sentAt' IS NOT NULL OR prior->'personnelCompletion'?'preparation') THEN RAISE EXCEPTION 'Released, prepared and signed completion history cannot be removed';END IF;
 END LOOP;
 FOR d IN SELECT item FROM jsonb_array_elements(new_docs) item LOOP
  SELECT item INTO prior FROM jsonb_array_elements(old_docs) item WHERE item->>'id'=d->>'id';
  IF d?'personnelCompletion' AND d IS DISTINCT FROM prior AND company_entitled IS NOT TRUE THEN RAISE EXCEPTION 'Lifecycle is unavailable for this company' USING ERRCODE='42501';END IF;
  IF prior?'personnelCompletion' AND (d->'mergeValues')-ARRAY['signatory.name','signatory.title'] IS DISTINCT FROM (prior->'mergeValues')-ARRAY['signatory.name','signatory.title'] AND NOT app.personnel_completion_custody(prior,d,source_case,target_revision) THEN RAISE EXCEPTION 'Document source values require canonical completion custody';END IF;
  -- These two aliases belong to the existing case signatory owner, never to missing Personnel completion.
  -- Check field-only forgeries even when the selected user and merge snapshot did not change.
  IF d IS DISTINCT FROM prior AND (d->'mergeValues'?|ARRAY['signatory.name','signatory.title'] OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(d->'fields','[]'::jsonb)||coalesce(prior->'fields','[]'::jsonb)) f WHERE f->>'owner'='pmLocked' AND f->>'pmKey' IN('signatory.name','signatory.title'))) THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(d->'fields','[]'::jsonb)||coalesce(prior->'fields','[]'::jsonb)) f WHERE f->>'owner'='pmLocked' AND f->>'pmKey' IN('signatory.name','signatory.title') AND (NOT coalesce(d->'mergeValues','{}'::jsonb)?(f->>'pmKey') OR coalesce(d->'values'->>(f->>'id'),'') IS DISTINCT FROM coalesce(d->'mergeValues'->>(f->>'pmKey'),''))) THEN RAISE EXCEPTION 'Printed signatory fields must match their canonical merge snapshot';END IF;
   IF prior IS NOT NULL AND app.personnel_completion_locked(prior) AND (d->'values' IS DISTINCT FROM prior->'values' OR d->'edits' IS DISTINCT FROM prior->'edits' OR d->'mergeValues' IS DISTINCT FROM prior->'mergeValues' OR d->'hrSignature' IS DISTINCT FROM prior->'hrSignature' AND coalesce(prior->'hrSignature','null'::jsonb)<>'null'::jsonb OR d->'employeeSignature' IS DISTINCT FROM prior->'employeeSignature' AND coalesce(prior->'employeeSignature','null'::jsonb)<>'null'::jsonb OR jsonb_typeof(prior->'signing') IS DISTINCT FROM 'object' AND prior->>'status' IN('signed','completed','acknowledged') AND d->>'status' IS DISTINCT FROM prior->>'status') THEN RAISE EXCEPTION 'Signed signatory source and receipts are immutable';END IF;
   IF prior IS NULL OR d->'signatoryUserId' IS DISTINCT FROM prior->'signatoryUserId' OR d->'mergeValues'->'signatory.name' IS DISTINCT FROM prior->'mergeValues'->'signatory.name' OR d->'mergeValues'->'signatory.title' IS DISTINCT FROM prior->'mergeValues'->'signatory.title' THEN
    IF prior IS NOT NULL AND app.personnel_completion_locked(prior) THEN RAISE EXCEPTION 'Signed signatory source is immutable';END IF;
    SELECT item INTO signatory_config FROM jsonb_array_elements(config->'companies') item WHERE item->>'companyId'=company::text;
    signatory_name:='';signatory_title:='';signatory_allowed:=d->>'signatoryUserId' IS NULL;
    IF d->>'signatoryUserId' IS NOT NULL THEN
     SELECT coalesce(p.full_name,'') INTO signatory_name FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id::text=d->>'signatoryUserId' AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
      AND EXISTS(SELECT 1 FROM role_assignment r WHERE r.tenant_id=u.tenant_id AND r.app_user_id=u.id AND r.role IN('super_admin','hr_admin') AND (r.company_id IS NULL OR r.company_id=company));
     signatory_title:=coalesce(config->'signatoryTitles'->>(d->>'signatoryUserId'),CASE WHEN signatory_config->>'signatoryUserId'=d->>'signatoryUserId' THEN signatory_config->>'signatoryTitle' ELSE '' END,'');
     -- A company default is a frozen source fact; selecting another signer and signing still require module authority.
     signatory_allowed:=coalesce(signatory_config->'allowedSignatoryUserIds',jsonb_build_array(signatory_config->>'signatoryUserId'))?(d->>'signatoryUserId') AND (prior IS NULL AND d->>'signatoryUserId'=signatory_config->>'signatoryUserId' OR CASE WHEN TG_TABLE_NAME='lc_onboarding_private' THEN
      native_config->'access'->'onboarding'?(d->>'signatoryUserId') OR (
       EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(native_config->'groups','[]'::jsonb)) g WHERE native_config->'access'->'joinerViewGroups'?(g->>'id') AND g->'members'?(d->>'signatoryUserId') AND (native_config->'access'->'joinerSections'->(g->>'id')->>'preset'='full' OR native_config->'access'->'joinerSections'->(g->>'id')->>'preset'='custom' AND native_config->'access'->'joinerSections'->(g->>'id')->'s'->>'actions'='allowed')) AND
       EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(native_config->'groups','[]'::jsonb)) g WHERE native_config->'access'->'joinerViewGroups'?(g->>'id') AND g->'members'?(d->>'signatoryUserId') AND (native_config->'access'->'joinerSections'->(g->>'id')->>'preset'='full' OR native_config->'access'->'joinerSections'->(g->>'id')->>'preset'='custom' AND native_config->'access'->'joinerSections'->(g->>'id')->'s'->>'hr'='view')))
      ELSE native_config->'access'->'offboarding'?(d->>'signatoryUserId') END);
    END IF;
    IF company_entitled IS NOT TRUE OR NOT(coalesce(app.is_admin_for(company) AND CASE WHEN TG_TABLE_NAME='lc_onboarding_private' THEN app.onboarding_v9_case_actor() AND coalesce(app.onboarding_v9_sections()->>'hr'='view',false) ELSE app.lc_v9_off_access(company) END,false) OR app.current_user_id() IS NULL AND (session_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper))) OR signatory_allowed IS NOT TRUE OR signatory_name IS NULL OR d->'mergeValues'?'signatory.name' AND coalesce(d->'mergeValues'->>'signatory.name','') IS DISTINCT FROM signatory_name OR d->'mergeValues'?'signatory.title' AND coalesce(d->'mergeValues'->>'signatory.title','') IS DISTINCT FROM signatory_title THEN RAISE EXCEPTION 'Signatory source requires the current permitted case owner';END IF;
   END IF;
  END IF;
  IF prior IS NOT NULL AND jsonb_typeof(d->'signing') IS DISTINCT FROM 'object' THEN
   is_hr:=app.is_admin_for(company) AND CASE WHEN TG_TABLE_NAME='lc_onboarding_private' THEN app.onboarding_v9_case_actor() AND coalesce(app.onboarding_v9_sections()->>'hr'='view',false) ELSE app.lc_v9_off_access(company) END;
   IF coalesce(d->'employeeSignature','null'::jsonb)<>'null'::jsonb AND d->'employeeSignature' IS DISTINCT FROM prior->'employeeSignature' THEN
    new_signature:=d->'employeeSignature';signature_source:=app.v9_document_personnel_source_unchecked(source_case);
    IF signer_person IS NULL OR signer_person::text IS DISTINCT FROM signature_source->>'_personId' OR prior->>'status' NOT IN('sent','opened') OR new_signature->'by' IS DISTINCT FROM actor OR app.document_signature_valid(new_signature-ARRAY['by','at','printedTitle']) IS NOT TRUE OR jsonb_typeof(new_signature->'at') IS DISTINCT FROM 'string' OR ((new_signature->>'at')::timestamptz BETWEEN transaction_timestamp()-interval '10 seconds' AND clock_timestamp()+interval '10 seconds') IS NOT TRUE THEN RAISE EXCEPTION 'Only the actual released-document employee can append their signature';END IF;
   END IF;
   IF coalesce(d->'hrSignature','null'::jsonb)<>'null'::jsonb AND d->'hrSignature' IS DISTINCT FROM prior->'hrSignature' THEN
    new_signature:=d->'hrSignature';
    IF is_hr IS NOT TRUE OR new_signature->'by' IS DISTINCT FROM actor OR app.document_signature_valid(new_signature-ARRAY['by','at','printedTitle']) IS NOT TRUE OR jsonb_typeof(new_signature->'at') IS DISTINCT FROM 'string' OR ((new_signature->>'at')::timestamptz BETWEEN transaction_timestamp()-interval '10 seconds' AND clock_timestamp()+interval '10 seconds') IS NOT TRUE OR NOT(prior->>'hrStep'='before' AND prior->>'status'='draft' AND prior->>'signatoryUserId'=app.current_user_id()::text OR prior->>'hrStep'='after' AND prior->>'status'='countersign') THEN RAISE EXCEPTION 'Only the current HR signing actor can append a signature at this stage';END IF;
   END IF;
  END IF;
  IF NOT d?'personnelCompletion' THEN IF prior?'personnelCompletion' THEN RAISE EXCEPTION 'The completion version cannot be removed';END IF;CONTINUE;END IF;
  IF prior IS NOT NULL AND prior?'personnelCompletion' AND (prior->'hrSignature' IS DISTINCT FROM 'null'::jsonb AND prior->'hrSignature' IS NOT NULL AND d->'hrSignature' IS DISTINCT FROM prior->'hrSignature' OR prior->'employeeSignature' IS DISTINCT FROM 'null'::jsonb AND prior->'employeeSignature' IS NOT NULL AND d->'employeeSignature' IS DISTINCT FROM prior->'employeeSignature' OR prior->>'sentAt' IS NOT NULL AND d->'sentAt' IS DISTINCT FROM prior->'sentAt' OR jsonb_typeof(prior->'signing') IS DISTINCT FROM 'object' AND prior->>'status' IN('signed','completed','acknowledged') AND d->>'status' IS DISTINCT FROM prior->>'status') THEN RAISE EXCEPTION 'Completion signatures, release and final status cannot be downgraded';END IF;
  IF prior IS NOT NULL AND prior?'personnelCompletion' AND (d->'fields' IS DISTINCT FROM prior->'fields' OR d->'blocks' IS DISTINCT FROM prior->'blocks' OR d->'templateId' IS DISTINCT FROM prior->'templateId' OR d->'version' IS DISTINCT FROM prior->'version' OR d->'templateType' IS DISTINCT FROM prior->'templateType' OR d->'hrStep' IS DISTINCT FROM prior->'hrStep' OR d->'employeeAck' IS DISTINCT FROM prior->'employeeAck') THEN RAISE EXCEPTION 'Saved completion structure and ownership are frozen';END IF;
  IF prior IS NOT NULL AND app.personnel_completion_locked(prior) AND (d->'values' IS DISTINCT FROM prior->'values' OR d->'edits' IS DISTINCT FROM prior->'edits' OR d->'mergeValues' IS DISTINCT FROM prior->'mergeValues' OR d->'personnelCompletion' IS DISTINCT FROM prior->'personnelCompletion') THEN RAISE EXCEPTION 'Signed completion content is immutable';END IF;
  IF prior IS NULL THEN
   IF source IS NULL THEN source:=app.v9_document_personnel_values(source_case);END IF;
   IF source IS NULL THEN RAISE EXCEPTION 'Authorized Personnel values are unavailable';END IF;
   SELECT item INTO definition FROM jsonb_array_elements(config->'templates') item WHERE item->>'id'=d->>'templateId';
   SELECT item INTO version FROM jsonb_array_elements(definition->'versions') item WHERE item->'version'=d->'version' AND item->>'state'='published';
   IF version IS NULL OR d->'fields' IS DISTINCT FROM version->'fields' OR d->'blocks' IS DISTINCT FROM version->'blocks' OR d->>'templateType' IS DISTINCT FROM definition->>'type' OR d->>'hrStep' IS DISTINCT FROM definition->>'hrStep' OR d->'employeeAck' IS DISTINCT FROM definition->'employeeAck' OR d->>'status'<>'draft' OR d->>'sentAt' IS NOT NULL OR app.personnel_completion_locked(d) THEN RAISE EXCEPTION 'Completion starts from a published unsigned draft';END IF;
   IF source->>'_identityFieldsWithheld'='true' AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'pmKey' IN('personalEmail','employee.icNo','employee.passportNo','icNo','passportNo','case.icNo','case.passportNo')) THEN RAISE EXCEPTION 'Protected Personnel identity permission is required';END IF;
   IF d->'mergeValues' IS DISTINCT FROM app.personnel_completion_document_projection(d)->'mergeValues' OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(d->'mergeValues','{}'::jsonb)) used WHERE source?used.key AND used.value IS DISTINCT FROM source->used.key) THEN RAISE EXCEPTION 'Only referenced canonical source values may enter a new completion document';END IF;
   IF source->>'_identityFieldsWithheld'='true' AND coalesce(d->'mergeValues','{}'::jsonb)?|ARRAY['personalEmail','employee.icNo','employee.passportNo','icNo','passportNo','case.icNo','case.passportNo'] THEN RAISE EXCEPTION 'Protected Personnel identity permission is required';END IF;
   official:=app.personnel_completion_official(d,source);policy:=d->'personnelCompletion';expected_fields:='{}'::jsonb;
   IF actor IS NULL OR policy->>'version' IS DISTINCT FROM '1' OR policy->>'classification' IS DISTINCT FROM '2026-11-18' OR policy->>'country' IS DISTINCT FROM source->>'_country' OR policy->>'sourceFingerprint' IS DISTINCT FROM app.personnel_completion_fingerprint(official,source->>'_country') OR policy->'adoptedBy' IS DISTINCT FROM actor OR jsonb_typeof(policy->'adoptedAt') IS DISTINCT FROM 'string' OR ((policy->>'adoptedAt')::timestamptz BETWEEN transaction_timestamp()-interval '10 seconds' AND clock_timestamp()+interval '10 seconds') IS NOT TRUE OR policy->'history' IS DISTINCT FROM '[]'::jsonb OR policy-ARRAY['version','classification','country','sourceFingerprint','adoptedAt','adoptedBy','fields','history','preparation']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid initial completion policy';END IF;
   FOR field IN SELECT item FROM jsonb_array_elements(d->'fields') item WHERE item->>'owner'='pmLocked' AND coalesce(item->>'pmKey','') NOT IN('signatory.name','signatory.title') LOOP
    expected_fields:=expected_fields||jsonb_build_object(field->>'id',jsonb_build_object('key',field->'pmKey','group',app.personnel_completion_group(field->>'pmKey'),'sourceValue',official->>(field->>'id'),'sourceFingerprint',policy->>'sourceFingerprint'));
    IF coalesce(d->'values'->>(field->>'id'),'') IS DISTINCT FROM official->>(field->>'id') THEN RAISE EXCEPTION 'Initial Personnel values must match their source';END IF;
   END LOOP;
   IF policy?'preparation' AND (policy->'preparation'->'by' IS DISTINCT FROM actor OR jsonb_typeof(policy->'preparation'->'at') IS DISTINCT FROM 'string' OR ((policy->'preparation'->>'at')::timestamptz BETWEEN transaction_timestamp()-interval '10 seconds' AND clock_timestamp()+interval '10 seconds') IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'required'='true' AND app.personnel_completion_owner(d,f)='employee')) THEN RAISE EXCEPTION 'Invalid unsigned employee preparation';END IF;
   IF policy->'fields' IS DISTINCT FROM expected_fields THEN RAISE EXCEPTION 'Completion classification and source fields are canonical';END IF;
  ELSIF d->'personnelCompletion' IS DISTINCT FROM prior->'personnelCompletion' OR EXISTS(SELECT 1 FROM jsonb_array_elements(prior->'fields') f WHERE f->>'owner'='pmLocked' AND coalesce(f->>'pmKey','') NOT IN('signatory.name','signatory.title') AND d->'values'->(f->>'id') IS DISTINCT FROM prior->'values'->(f->>'id')) THEN
   IF NOT app.personnel_completion_custody(prior,d,source_case,target_revision) THEN RAISE EXCEPTION 'A protected completion custodian must authorize this exact change' USING ERRCODE='42501';END IF;
   IF app.personnel_completion_locked(prior) THEN RAISE EXCEPTION 'Signed completion content is immutable';END IF;
  END IF;
  IF prior IS NOT NULL THEN
   first_signature:=(coalesce(d->'employeeSignature','null'::jsonb)<>'null'::jsonb AND coalesce(prior->'employeeSignature','null'::jsonb)='null'::jsonb) OR (coalesce(d->'hrSignature','null'::jsonb)<>'null'::jsonb AND coalesce(prior->'hrSignature','null'::jsonb)='null'::jsonb)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(d->'signing'->'actions','[]'::jsonb)) a WHERE a->>'action'='signed' AND NOT coalesce(prior->'signing'->'actions','[]'::jsonb) @> jsonb_build_array(a));
   IF first_signature AND NOT app.v9_signing_current_actor() THEN RAISE EXCEPTION 'Current verified signing actor required';END IF;
   IF first_signature AND NOT app.personnel_completion_locked(prior) THEN PERFORM app.personnel_completion_assert_current(d,source_case,true);END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.v9_personnel_completion_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER v9_personnel_completion_guard BEFORE INSERT OR UPDATE ON lc_v9_case FOR EACH ROW EXECUTE FUNCTION app.v9_personnel_completion_guard();
CREATE TRIGGER native_personnel_completion_guard BEFORE INSERT OR UPDATE ON lc_onboarding_private FOR EACH ROW EXECUTE FUNCTION app.v9_personnel_completion_guard();
REVOKE ALL ON FUNCTION app.personnel_completion_group(text),app.personnel_completion_owner(jsonb,jsonb),app.personnel_completion_locked(jsonb),app.personnel_completion_official(jsonb,jsonb),app.personnel_completion_fingerprint(jsonb,text),app.personnel_completion_scalar(jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_completion_group(text),app.personnel_completion_owner(jsonb,jsonb),app.personnel_completion_locked(jsonb),app.personnel_completion_official(jsonb,jsonb),app.personnel_completion_fingerprint(jsonb,text),app.personnel_completion_scalar(jsonb,text) TO ai_hr_app;

--> statement-breakpoint
-- Reusable bounded document projection: a document carries only its declared fields and referenced source tokens.
CREATE FUNCTION app.personnel_completion_document_projection(d jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 WITH used AS(
 SELECT f->>'pmKey' key FROM jsonb_array_elements(coalesce(d->'fields','[]'::jsonb)) f WHERE f->>'pmKey' IS NOT NULL
 UNION SELECT token[1] FROM jsonb_array_elements(coalesce(d->'blocks','[]'::jsonb)) b CROSS JOIN LATERAL regexp_matches(coalesce(d->'edits'->>(b->>'id'),b->>'text','')||' '||coalesce(b->>'rows','')||' '||coalesce(b->>'label',''),'[{]([A-Za-z][A-Za-z0-9_.-]*)[}]','g') token
 UNION SELECT unnest(ARRAY['company.name','company.regNo','company.address','company.color']) WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(d->'blocks','[]'::jsonb)) b WHERE b->>'type'='letterhead')
 ) SELECT d||jsonb_build_object('mergeValues',coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(coalesce(d->'mergeValues','{}'::jsonb)) entry WHERE entry.key IN(SELECT used.key FROM used)),'{}'::jsonb))
$$;
REVOKE ALL ON FUNCTION app.personnel_completion_document_projection(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_completion_document_projection(jsonb) TO ai_hr_app;

