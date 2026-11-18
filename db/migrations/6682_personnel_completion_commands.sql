-- One canonical saved-document command. Inputs are values/intent, never a policy or arbitrary case blob.
CREATE FUNCTION app.v9_personnel_completion_sources(p_case uuid) RETURNS TABLE(case_id uuid,revision integer,company_id uuid,employment_id uuid,person_id uuid,is_native boolean,state text,document jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT c.id,c.revision,c.company_id,c.employment_id,e.person_id,false,c.data->>'state',d FROM lc_v9_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'documents','[]'::jsonb)) d WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case
 UNION ALL
 SELECT c.id,c.revision,c.company_id,c.employment_id,(c.data->>'personId')::uuid,true,c.data->>'state',d FROM lc_onboarding_case c JOIN lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.data->'lifecycleV9'->'documents','[]'::jsonb)) d WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case
 AND p.data->'lifecycleV9Subject'->>'personId' IS NOT DISTINCT FROM c.data->>'personId' AND p.data->'lifecycleV9Subject'->>'employmentId' IS NOT DISTINCT FROM c.employment_id::text
 AND (c.employment_id IS NULL OR EXISTS(SELECT 1 FROM employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id AND e.person_id::text=c.data->>'personId'))
$$;
REVOKE ALL ON FUNCTION app.v9_personnel_completion_sources(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.personnel_completion_preparation_projection(d jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app AS $$
 WITH allowed AS(SELECT f FROM jsonb_array_elements(d->'fields') f WHERE
 (app.personnel_completion_owner(d,f)='employee' OR f->>'owner'='pmLocked' AND (app.personnel_completion_group(f->>'pmKey')='personal' OR d->'personnelCompletion'->'fields'->(f->>'id')->'override'->>'owner'='employee' OR d->'personnelCompletion'->'fields'->(f->>'id')->'draft'?'by'))
 AND (f->'when' IS NULL OR f->'when'='null'::jsonb OR d->'values'->>(f->'when'->>'field')=f->'when'->>'value')),
 projection AS(SELECT coalesce(jsonb_agg(f||jsonb_build_object('when',NULL)),'[]'::jsonb) fields,
 coalesce(jsonb_agg(jsonb_build_object('id','preparation:'||(f->>'id'),'type','field','fieldId',f->>'id','text','','section',f->>'section')),'[]'::jsonb) blocks,
 coalesce(jsonb_object_agg(f->>'id',coalesce(d->'values'->(f->>'id'),'""'::jsonb)),'{}'::jsonb) values,
 coalesce(jsonb_object_agg(f->>'id',d->'personnelCompletion'->'fields'->(f->>'id')) FILTER(WHERE f->>'owner'='pmLocked'),'{}'::jsonb) entries FROM allowed)
 SELECT jsonb_build_object('id',d->'id','templateId',d->'templateId','version',d->'version','name',d->'name','status',d->'status','createdAt',d->'createdAt','sentAt',NULL,'employeeSignature',NULL,'hrSignature',NULL,'templateType',d->'templateType','hrStep',d->'hrStep','employeeAck',d->'employeeAck','blocks',blocks,'fields',fields,'values',values,'edits','{}'::jsonb,'mergeValues','{}'::jsonb,
 'personnelCompletion',(d->'personnelCompletion')||jsonb_build_object('fields',entries,'history',coalesce((SELECT jsonb_agg(item) FROM jsonb_array_elements(d->'personnelCompletion'->'history') item WHERE entries ? (item->>'fieldId')),'[]'::jsonb))) FROM projection
$$;
CREATE FUNCTION app.v9_personnel_completion_read(p_case uuid,p_document text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN hr.allowed OR jsonb_typeof(s.document->'signing')='object' AND app.v9_document_route_content_visible(s.document) OR s.document->>'sentAt' IS NOT NULL THEN app.personnel_completion_document_projection(s.document) ELSE app.personnel_completion_preparation_projection(s.document) END
 FROM app.v9_personnel_completion_sources(p_case) s
 CROSS JOIN LATERAL(SELECT app.is_admin_for(s.company_id) AND CASE WHEN s.is_native THEN app.onboarding_v9_case_actor() AND coalesce(app.onboarding_v9_sections()->>'hr'='view',false) ELSE app.lc_v9_off_access(s.company_id) END AS allowed) hr
 WHERE app.v9_signing_current_actor() AND app.probation_company_entitled(s.company_id) AND s.document->>'id'=p_document AND s.state='submitted' AND s.document->>'status' NOT IN('withdrawn','superseded') AND s.document?'personnelCompletion'
 AND (hr.allowed OR EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.person_id=s.person_id AND (s.document->'personnelCompletion'?'preparation' OR s.document->>'sentAt' IS NOT NULL OR jsonb_typeof(s.document->'signing')='object' AND app.v9_document_route_content_visible(s.document))))
$$;
REVOKE ALL ON FUNCTION app.personnel_completion_preparation_projection(jsonb),app.v9_personnel_completion_read(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_completion_preparation_projection(jsonb),app.v9_personnel_completion_read(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.v9_personnel_completion_update(p_case uuid,p_revision integer,p_document text,p_values jsonb,p_operation text,p_override jsonb DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s record;c lc_v9_case;n lc_onboarding_case;private_data jsonb;case_data jsonb;before_doc jsonb;d jsonb;source jsonb;official jsonb;fingerprint text;policy jsonb;entries jsonb;entry jsonb;prior_entry jsonb;field jsonb;key text;value jsonb;answer text;old_value text;owner text;hr boolean;own boolean;actor jsonb;stamp text;history jsonb;changes jsonb;docs jsonb;log jsonb;reason text;before_owner text;after_owner text;recorded boolean:=false;target_revision integer;
BEGIN
 IF NOT app.v9_signing_current_actor() OR p_operation NOT IN('save','submit','refresh','override','adopt') OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR octet_length(p_values::text)>1048576 OR (SELECT count(*) FROM jsonb_each(p_values))>200 THEN RAISE EXCEPTION 'Invalid completion command' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-v9:'||app.current_tenant_id()::text,0));
 SELECT * INTO c FROM lc_v9_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL THEN
  SELECT * INTO n FROM lc_onboarding_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
  SELECT data INTO private_data FROM lc_onboarding_private WHERE case_id=n.id AND tenant_id=n.tenant_id FOR UPDATE;
  IF n.id IS NULL OR private_data->'lifecycleV9' IS NULL THEN RAISE EXCEPTION 'Completion document unavailable';END IF;case_data:=private_data->'lifecycleV9';
 ELSE case_data:=c.data;END IF;
 SELECT * INTO s FROM app.v9_personnel_completion_sources(p_case) WHERE document->>'id'=p_document;
 IF NOT FOUND OR app.probation_company_entitled(s.company_id) IS NOT TRUE OR s.revision IS DISTINCT FROM p_revision OR s.state IS DISTINCT FROM 'submitted' THEN RAISE EXCEPTION 'The case changed. Refresh before trying again';END IF;
 hr:=app.is_admin_for(s.company_id) AND CASE WHEN s.is_native THEN app.onboarding_v9_case_actor() AND coalesce(app.onboarding_v9_sections()->>'hr'='view',false) ELSE app.lc_v9_off_access(s.company_id) END;
 SELECT jsonb_build_object('id',u.id,'name',coalesce(p.full_name,'User')),u.person_id=s.person_id INTO actor,own FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 before_doc:=s.document;d:=before_doc;
 IF NOT coalesce(hr,false) AND NOT coalesce(own,false) OR app.personnel_completion_locked(d) OR d->>'status' IN('withdrawn','superseded') OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(case_data->'mails','[]'::jsonb)) mail WHERE coalesce(mail->>'test','false')<>'true' AND mail->>'status' IN('pending','sending','uncertain') AND mail->'documentIds'?p_document) THEN RAISE EXCEPTION 'Completion is locked or outside your current authority' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(d->'signing')='object' AND NOT (app.document_signing_can_edit(d->'signing',app.current_user_id()) OR own AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'signing'->'route'->'steps') st WHERE st->>'role'='employee' AND st->>'holderId'=app.current_user_id()::text)) THEN RAISE EXCEPTION 'The current document owner or employee preparation holder is required' USING ERRCODE='42501';END IF;
 IF NOT hr AND (NOT own OR NOT(d->'personnelCompletion'?'preparation' OR d->>'sentAt' IS NOT NULL OR jsonb_typeof(d->'signing')='object')) THEN RAISE EXCEPTION 'Employee preparation is not open' USING ERRCODE='42501';END IF;
 IF p_operation IN('override','adopt') AND NOT hr OR p_operation='submit' AND NOT own THEN RAISE EXCEPTION 'Completion action belongs to another owner' USING ERRCODE='42501';END IF;
 source:=app.v9_document_personnel_source_unchecked(p_case);official:=app.personnel_completion_official(d,source);stamp:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 IF source IS NULL THEN RAISE EXCEPTION 'Current Personnel source is unavailable';END IF;
 IF hr AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'pmKey' IN('personalEmail','employee.icNo','employee.passportNo')) AND NOT EXISTS(SELECT 1 FROM company co WHERE co.tenant_id=app.current_tenant_id() AND app.personnel_identity_search_permitted(co.id)) THEN RAISE EXCEPTION 'Protected Personnel identity permission is required';END IF;
 IF p_operation='adopt' THEN
  IF d?'personnelCompletion' OR d->>'status'<>'draft' OR d->>'sentAt' IS NOT NULL THEN RAISE EXCEPTION 'Only an unsigned unreleased legacy draft can adopt completion';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'owner'='pmLocked' AND btrim(coalesce(official->>(f->>'id'),''))='' AND btrim(coalesce(d->'values'->>(f->>'id'),''))<>'') THEN RAISE EXCEPTION 'Existing case answers need manual review before adoption';END IF;
  fingerprint:=app.personnel_completion_fingerprint(official,source->>'_country');entries:='{}';
  FOR field IN SELECT item FROM jsonb_array_elements(d->'fields') item WHERE item->>'owner'='pmLocked' LOOP entries:=entries||jsonb_build_object(field->>'id',jsonb_build_object('key',field->'pmKey','group',app.personnel_completion_group(field->>'pmKey'),'sourceValue',official->>(field->>'id'),'sourceFingerprint',fingerprint));d:=jsonb_set(d,ARRAY['values',field->>'id'],official->(field->>'id'),true);END LOOP;
  policy:=jsonb_build_object('version',1,'classification','2026-11-18','country',source->'_country','sourceFingerprint',fingerprint,'adoptedAt',stamp,'adoptedBy',actor,'fields',entries,'history','[]'::jsonb);d:=d||jsonb_build_object('personnelCompletion',policy);
 ELSE
  policy:=d->'personnelCompletion';IF policy IS NULL OR policy->>'version'<>'1' THEN RAISE EXCEPTION 'This document uses its saved completion rules';END IF;
  fingerprint:=app.personnel_completion_fingerprint(official,policy->>'country');entries:=policy->'fields';history:=policy->'history';
  FOR field IN SELECT item FROM jsonb_array_elements(d->'fields') item WHERE item->>'owner'='pmLocked' LOOP
   key:=field->>'id';entry:=entries->key;answer:=coalesce(official->>key,'');old_value:=coalesce(entry->>'sourceValue','');
   IF answer IS DISTINCT FROM old_value THEN
    IF btrim(answer)<>'' THEN
     IF btrim(coalesce(d->'values'->>key,''))<>'' AND d->'values'->>key IS DISTINCT FROM old_value AND d->'values'->>key IS DISTINCT FROM answer THEN entry:=entry||jsonb_build_object('conflict',jsonb_build_object('draft',d->'values'->>key,'official',answer,'at',stamp));END IF;
     d:=jsonb_set(d,ARRAY['values',key],to_jsonb(answer),true);
    ELSIF btrim(old_value)<>'' THEN d:=jsonb_set(d,ARRAY['values',key],to_jsonb(coalesce(entry->'answer'->>'value',entry->'draft'->>'value','')),true);END IF;
    history:=history||jsonb_build_array(jsonb_build_object('fieldId',key,'action','reconciled','by',actor,'at',stamp,'before',old_value,'after',answer,'reason','Current authorized Personnel source'));
    entry:=entry||jsonb_build_object('sourceValue',answer,'sourceFingerprint',fingerprint);entries:=jsonb_set(entries,ARRAY[key],entry);policy:=policy-'submitted';
   END IF;
  END LOOP;
  policy:=policy||jsonb_build_object('fields',entries,'history',history,'sourceFingerprint',fingerprint);d:=jsonb_set(d,'{personnelCompletion}',policy);
 END IF;
 IF p_operation='override' THEN
  IF jsonb_typeof(p_override) IS DISTINCT FROM 'object' OR p_override-ARRAY['fieldId','owner','reason']<>'{}'::jsonb OR coalesce(p_override->>'owner' IN('employee','hr'),false) IS NOT TRUE OR length(btrim(coalesce(p_override->>'reason',''))) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'Record a bounded reason and completion owner';END IF;
  key:=p_override->>'fieldId';SELECT item INTO field FROM jsonb_array_elements(d->'fields') item WHERE item->>'id'=key AND item->>'owner'='pmLocked';entry:=policy->'fields'->key;
  IF field IS NULL OR entry IS NULL OR btrim(coalesce(entry->>'sourceValue',''))<>'' THEN RAISE EXCEPTION 'Only a missing Personnel field can change owner';END IF;
  IF p_override->>'owner'='employee' AND app.personnel_completion_group(field->>'pmKey')='unknown' THEN RAISE EXCEPTION 'Unclassified Personnel fields remain with HR';END IF;
  before_owner:=app.personnel_completion_owner(d,field);after_owner:=p_override->>'owner';
  IF before_owner<>after_owner THEN entry:=entry-'answer';d:=jsonb_set(d,ARRAY['values',key],'""'::jsonb,true);END IF;
  entry:=entry||jsonb_build_object('override',jsonb_build_object('owner',after_owner,'by',actor,'at',stamp,'reason',btrim(p_override->>'reason')));
  policy:=jsonb_set(policy,ARRAY['fields',key],entry)-'submitted';policy:=jsonb_set(policy,'{history}',(policy->'history')||jsonb_build_array(jsonb_build_object('fieldId',key,'action','override','by',actor,'at',stamp,'before',before_owner,'after',after_owner,'reason',btrim(p_override->>'reason'))));d:=jsonb_set(d,'{personnelCompletion}',policy);
 ELSIF p_override IS NOT NULL THEN RAISE EXCEPTION 'Unexpected owner override';END IF;
 IF p_operation NOT IN('save','submit') AND p_values<>'{}'::jsonb THEN RAISE EXCEPTION 'Unexpected completion values';END IF;
 FOR key,value IN SELECT * FROM jsonb_each(p_values) LOOP
  SELECT item INTO field FROM jsonb_array_elements(d->'fields') item WHERE item->>'id'=key;owner:=app.personnel_completion_owner(d,field);
  IF field IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'string' OR owner IS NULL OR owner NOT IN('employee','hr') OR owner='employee' AND NOT own OR owner='hr' AND NOT hr THEN RAISE EXCEPTION 'This field belongs to another owner or Personnel Management' USING ERRCODE='42501';END IF;
  -- HR acting on their own case still edits HR answers through save; submit is always the employee role.
  IF p_operation='submit' AND owner<>'employee' THEN RAISE EXCEPTION 'Only employee answers can be submitted';END IF;
  PERFORM app.personnel_completion_scalar(field,value#>>'{}');d:=jsonb_set(d,ARRAY['values',key],value,true);
  IF field->>'owner'='pmLocked' THEN
   entry:=policy->'fields'->key;entry:=entry||jsonb_build_object('answer',jsonb_build_object('value',value,'owner',owner,'by',actor,'at',stamp));
   IF owner='employee' THEN entry:=entry||jsonb_build_object('draft',jsonb_build_object('value',value,'by',actor,'at',stamp));END IF;
   policy:=jsonb_set(policy,ARRAY['fields',key],entry)-'submitted';
  END IF;
 END LOOP;
 d:=jsonb_set(d,'{personnelCompletion}',policy);changes:=coalesce(case_data->'pmChanges','[]'::jsonb);
 SELECT coalesce(jsonb_agg(CASE WHEN proposal->>'documentId'=p_document AND proposal->>'status'='proposed' AND proposal->'provenance'->>'kind'='missing-personnel' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'pmKey'=proposal->>'field' AND app.personnel_completion_owner(d,f)='employee' AND policy->'fields'->(f->>'id')->'answer'->>'owner'='employee' AND policy->'fields'->(f->>'id')->'answer'->>'value'=proposal->>'after' AND d->'values'->>(f->>'id')=proposal->>'after' AND policy->'fields'->(f->>'id')->'answer'->'by' IS NOT DISTINCT FROM proposal->'provenance'->'by') THEN proposal||jsonb_build_object('status','rejected','superseded',jsonb_build_object('at',stamp,'by',actor,'reason','The active employee answer changed or completion moved to another owner')) ELSE proposal END ORDER BY ordinal),'[]'::jsonb) INTO changes FROM jsonb_array_elements(changes) WITH ORDINALITY x(proposal,ordinal);
 IF p_operation='submit' THEN
  FOR field IN SELECT item FROM jsonb_array_elements(d->'fields') item WHERE app.personnel_completion_owner(d,item)='employee' LOOP
   IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb AND d->'values'->>(field->'when'->>'field') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;
   answer:=coalesce(d->'values'->>(field->>'id'),'');IF field->>'required'='true' AND (btrim(answer)='' OR field->>'type'='checkbox' AND answer<>'true' OR field->>'type'='table' AND answer='[]') THEN RAISE EXCEPTION 'Complete required employee answers';END IF;
   PERFORM app.personnel_completion_scalar(field,answer);entry:=policy->'fields'->(field->>'id');
   IF field->>'owner'='pmLocked' AND entry->'answer'->>'owner'='employee' AND entry->'answer'->'by'->>'id'=app.current_user_id()::text AND entry->'answer'->>'value'=answer AND btrim(answer)<>'' AND field->>'pmKey' NOT LIKE 'case.%' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(changes) item WHERE item->>'documentId'=p_document AND item->>'field'=field->>'pmKey' AND item->>'status'='proposed' AND item->>'after'=answer AND item->'provenance'->'by' IS NOT DISTINCT FROM entry->'answer'->'by') THEN
    changes:=changes||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'documentId',p_document,'field',field->>'pmKey','before','','after',answer,'sourceRevision',CASE WHEN s.is_native THEN n.data->>'sourceVersion' ELSE case_data->>'sourceRevision' END,'status','proposed','provenance',jsonb_build_object('kind','missing-personnel','version',1,'by',entry->'answer'->'by','at',entry->'answer'->>'at')));
   END IF;
  END LOOP;
  policy:=policy||jsonb_build_object('submitted',jsonb_build_object('at',stamp,'by',actor,'sourceFingerprint',fingerprint));d:=jsonb_set(d,'{personnelCompletion}',policy);
 END IF;
 IF p_operation='adopt' AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'required'='true' AND app.personnel_completion_owner(d,f)='employee') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE app.personnel_completion_owner(d,f)='hr' AND btrim(coalesce(d->'values'->>(f->>'id'),''))='') THEN d:=jsonb_set(d,'{personnelCompletion,preparation}',jsonb_build_object('at',stamp,'by',actor));END IF;
 IF NOT(policy?'preparation') AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'required'='true' AND app.personnel_completion_owner(d,f)='employee') THEN policy:=policy||jsonb_build_object('preparation',jsonb_build_object('at',stamp,'by',actor));d:=jsonb_set(d,'{personnelCompletion}',policy);END IF;
 d:=app.personnel_completion_document_projection(d);
 IF d IS NOT DISTINCT FROM before_doc AND changes IS NOT DISTINCT FROM coalesce(case_data->'pmChanges','[]'::jsonb) THEN RETURN s.revision;END IF;
 IF jsonb_typeof(d->'signing')='object' THEN
  d:=jsonb_set(d,'{signing,contentRevision}',to_jsonb((d->'signing'->>'contentRevision')::integer+1));d:=jsonb_set(d,'{signing,contentHash}',to_jsonb(app.v9_document_content_hash(d)));
 END IF;
 target_revision:=s.revision+1;
 INSERT INTO lifecycle_personnel_completion_custody(tenant_id,case_id,document_id,case_revision,actor_user_id,transaction_id,operation,before_hash,after_hash) VALUES(app.current_tenant_id(),p_case,p_document,target_revision,app.current_user_id(),pg_current_xact_id(),p_operation,encode(sha256(convert_to(before_doc::text,'UTF8')),'hex'),encode(sha256(convert_to(d::text,'UTF8')),'hex'));
 SELECT jsonb_agg(CASE WHEN item->>'id'=p_document THEN d ELSE item END ORDER BY ordinal) INTO docs FROM jsonb_array_elements(case_data->'documents') WITH ORDINALITY x(item,ordinal);
 log:=coalesce(case_data->'log','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',stamp,'actor',actor,'action','document.completion.'||p_operation,'detail',d->>'name'));
 IF s.is_native THEN
  INSERT INTO lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data) VALUES(n.tenant_id,n.id,n.company_id,n.revision,n.data);
  INSERT INTO lc_onboarding_private_revision(tenant_id,case_id,company_id,revision,data) VALUES(n.tenant_id,n.id,n.company_id,n.revision,private_data);
  UPDATE lc_onboarding_case SET revision=target_revision,updated_at=now(),data=n.data||jsonb_build_object('history',coalesce(n.data->'history','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',stamp,'by',app.current_user_id(),'name',actor->>'name','action','document.completion.'||p_operation,'detail',d->>'name'))) WHERE id=n.id AND tenant_id=n.tenant_id;
  UPDATE lc_onboarding_private SET data=jsonb_set(private_data,'{lifecycleV9}',case_data||jsonb_build_object('documents',docs,'pmChanges',changes,'log',log)) WHERE case_id=n.id AND tenant_id=n.tenant_id;
 ELSE
  INSERT INTO lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id) VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data,app.current_user_id());
  UPDATE lc_v9_case SET revision=target_revision,updated_at=now(),data=case_data||jsonb_build_object('revision',target_revision,'documents',docs,'pmChanges',changes,'log',log) WHERE id=c.id AND tenant_id=c.tenant_id;
 END IF;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(app.current_tenant_id(),'lifecycle-v9-case',p_case,'lifecycle-v9.personnelCompletion.'||p_operation,'user',app.current_user_id(),s.employment_id,jsonb_build_object('caseId',p_case,'documentId',p_document,'revision',target_revision));
 RETURN target_revision;
END $$;
REVOKE ALL ON FUNCTION app.v9_personnel_completion_update(uuid,integer,text,jsonb,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.v9_personnel_completion_update(uuid,integer,text,jsonb,text,jsonb) TO ai_hr_app;
