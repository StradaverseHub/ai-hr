-- Answers remain case proposals. Only existing Personnel writers may change official records after HR review.
CREATE TABLE probation_letter_personnel_proposal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),part_id uuid NOT NULL,field_id text NOT NULL,
 field_key text NOT NULL,before_value text NOT NULL DEFAULT '',after_value text NOT NULL,source_fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN('proposed','pushed','conflict','rejected')),provenance jsonb NOT NULL,history jsonb NOT NULL DEFAULT '[]',
 reviewed_by uuid REFERENCES app_user(id),reviewed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,part_id,field_id),FOREIGN KEY(tenant_id,part_id) REFERENCES probation_part(tenant_id,id),FOREIGN KEY(tenant_id,reviewed_by) REFERENCES app_user(tenant_id,id)
);
ALTER TABLE probation_letter_personnel_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE probation_letter_personnel_proposal FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_letter_personnel_proposal_tenant ON probation_letter_personnel_proposal USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
REVOKE ALL ON probation_letter_personnel_proposal FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_completion_hr(p_part uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_active_user() AND app.probation_case_access(c.id) AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR app.probation_case_permitted(c.employment_id,'cases.letters'))
 FROM probation_part p JOIN probation_case c ON c.id=p.case_id AND c.tenant_id=p.tenant_id WHERE p.id=p_part AND p.tenant_id=app.current_tenant_id()
$$;
CREATE FUNCTION app.probation_letter_completion_own(p_part uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_active_user() AND app.probation_case_access(c.id) AND EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 FROM probation_part p JOIN probation_case c ON c.id=p.case_id AND c.tenant_id=p.tenant_id WHERE p.id=p_part AND p.tenant_id=app.current_tenant_id()
$$;
CREATE FUNCTION app.probation_letter_completion_reconcile(d jsonb,source jsonb,actor jsonb,stamp text,p_history boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,app AS $$
DECLARE policy jsonb:=d->'personnelCompletion';entry jsonb;field jsonb;official jsonb;value text;draft text;fingerprint text;changed boolean:=false;
BEGIN
 IF policy IS NULL OR app.personnel_completion_locked(d) THEN RETURN d;END IF;
 IF policy->>'country' IS DISTINCT FROM source->>'_country' THEN RAISE EXCEPTION 'The Personnel jurisdiction changed. Prepare a new letter';END IF;
 official:=app.personnel_completion_official(jsonb_set(d,'{fields}',coalesce((SELECT jsonb_agg(f) FROM jsonb_array_elements(d->'fields') f WHERE policy->'fields' ? (f->>'id')),'[]')),source);
 fingerprint:=app.personnel_completion_fingerprint(official,policy->>'country');
 FOR field IN SELECT item FROM jsonb_array_elements(d->'fields') item LOOP
  entry:=policy->'fields'->(field->>'id');IF entry IS NULL THEN CONTINUE;END IF;value:=coalesce(official->>(field->>'id'),'');
  IF value IS NOT DISTINCT FROM entry->>'sourceValue' THEN CONTINUE;END IF;
  draft:=coalesce(d->'values'->>(field->>'id'),'');
  IF btrim(value)<>'' THEN
   IF draft<>'' AND draft IS DISTINCT FROM entry->>'sourceValue' AND draft IS DISTINCT FROM value THEN entry:=entry||jsonb_build_object('conflict',jsonb_build_object('draft',draft,'official',value,'at',stamp));END IF;
   d:=jsonb_set(d,ARRAY['values',field->>'id'],to_jsonb(value),true);
  ELSIF btrim(coalesce(entry->>'sourceValue',''))<>'' THEN d:=jsonb_set(d,ARRAY['values',field->>'id'],to_jsonb(coalesce(entry->'answer'->>'value',entry->'draft'->>'value','')),true);END IF;
  IF p_history THEN policy:=jsonb_set(policy,'{history}',coalesce(policy->'history','[]')||jsonb_build_array(jsonb_build_object('fieldId',field->>'id','action','reconciled','by',actor,'at',stamp,'before',coalesce(entry->>'sourceValue',''),'after',value,'reason','Current authorized Personnel source')));END IF;
  entry:=entry||jsonb_build_object('sourceValue',value,'sourceFingerprint',fingerprint);policy:=jsonb_set(policy,ARRAY['fields',field->>'id'],entry,true);changed:=true;
 END LOOP;
 IF changed THEN policy:=(policy-'submitted')||jsonb_build_object('sourceFingerprint',fingerprint);END IF;
 RETURN jsonb_set(d,'{personnelCompletion}',policy,true);
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_completion_hr(uuid),app.probation_letter_completion_own(uuid),app.probation_letter_completion_reconcile(jsonb,jsonb,jsonb,text,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_completion_read(p_case uuid,p_part uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;o probation_outcome;d jsonb;policy jsonb;source jsonb;hr boolean;own boolean;editable boolean;runtime boolean;review boolean;locked boolean;fields jsonb;entries jsonb;visible_values jsonb;proposals jsonb;who jsonb:=app.probation_letter_completion_actor();
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=p_case AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 hr:=coalesce(app.probation_letter_completion_hr(p.id),false);own:=coalesce(app.probation_letter_completion_own(p.id),false);
 IF p.id IS NULL OR who IS NULL OR NOT(hr OR own) THEN RAISE EXCEPTION 'This preparation is unavailable in your current scope' USING ERRCODE='42501';END IF;
 IF NOT p.data?'personnelCompletion' THEN RETURN NULL;END IF;
 IF (app.probation_letter_completion_requested(jsonb_build_object('fields',p.data->'letterFields','blocks',p.data->'letterBlocks'))&&ARRAY['personalEmail','employee.icNo','employee.passportNo']) AND app.probation_letter_completion_identity(p.id) IS NOT TRUE THEN RAISE EXCEPTION 'Protected Personnel identity permission is required' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM probation_outcome WHERE id=(p.data->>'letterOutcomeId')::uuid AND tenant_id=p.tenant_id;
 runtime:=app.probation_case_company_current(c.id) AND app.probation_owns_legacy(c.employment_id) AND app.probation_company_entitled(c.company_id) AND EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled AND activation_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND c.data->>'state' NOT IN('withdrawn','confirmed','not_confirmed') AND o.letter_part_id=p.id AND o.released_at IS NULL;
 d:=app.probation_letter_completion_document(p.id);locked:=app.personnel_completion_locked(d);editable:=runtime AND NOT locked AND (hr OR NOT coalesce(app.document_signing_returned(d->'signing'),false) OR app.document_signing_owner(d->'signing')=app.current_user_id());review:=runtime AND hr;
 IF editable THEN source:=app.probation_letter_completion_source(p.id);d:=app.probation_letter_completion_reconcile(d,source,who,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),false);END IF;
 policy:=d->'personnelCompletion';
 -- The pre-signing subject receives only assigned personal preparation, never private wording, route comments or unused PM values.
 WITH selected AS(SELECT f,n FROM jsonb_array_elements(d->'fields') WITH ORDINALITY original(f,n) WHERE policy->'fields' ? (f->>'id') AND (hr OR app.personnel_completion_owner(d,f)='employee' OR policy->'fields'->(f->>'id')->>'group'='personal' OR policy->'fields'->(f->>'id')->'draft'->'by'->>'id'=app.current_user_id()::text OR policy->'fields'->(f->>'id')->'override'->>'owner'='employee')),
 visible AS(SELECT candidate.n,CASE WHEN candidate.f->'when' IS NOT NULL AND candidate.f->'when'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM selected control WHERE control.f->>'id'=candidate.f->'when'->>'field') THEN jsonb_set(candidate.f,'{when}','null'::jsonb) ELSE candidate.f END AS f
 FROM selected candidate WHERE candidate.f->'when' IS NULL OR candidate.f->'when'='null'::jsonb OR EXISTS(SELECT 1 FROM selected control WHERE control.f->>'id'=candidate.f->'when'->>'field') OR d->'values'->>(candidate.f->'when'->>'field')=candidate.f->'when'->>'value')
 SELECT coalesce(jsonb_agg(f ORDER BY n),'[]'),coalesce(jsonb_object_agg(f->>'id',policy->'fields'->(f->>'id')),'{}'),coalesce(jsonb_object_agg(f->>'id',d->'values'->(f->>'id')),'{}') INTO fields,entries,visible_values FROM visible;
 policy:=policy||jsonb_build_object('fields',entries,'history',coalesce((SELECT jsonb_agg(item ORDER BY n) FROM jsonb_array_elements(policy->'history') WITH ORDINALITY event(item,n) WHERE entries ? (item->>'fieldId')),'[]'));
 d:=jsonb_build_object('id',p.id,'templateId',p.data->>'letterTemplateId','version',p.data->'letterTemplateVersion','name',p.data->>'letterTemplateName','createdAt',p.created_at,'status',CASE WHEN locked THEN to_jsonb('completed'::text) ELSE d->'status' END,'sentAt',d->'sentAt','blocks','[]'::jsonb,'fields',fields,'values',visible_values,'edits','{}'::jsonb,'mergeValues','{}'::jsonb,'hrSignature',NULL,'employeeSignature',NULL,'hrStep','before','employeeAck',true,'templateType','Letter','personnelCompletion',policy);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'documentId',p.id,'field',r.field_key,'before',r.before_value,'after',r.after_value,'sourceRevision',r.source_fingerprint,'status',r.status,'provenance',r.provenance) ORDER BY r.created_at,r.id),'[]') INTO proposals FROM probation_letter_personnel_proposal r WHERE r.tenant_id=p.tenant_id AND r.part_id=p.id AND hr;
 RETURN jsonb_build_object('partId',p.id,'caseId',c.id,'employmentId',c.employment_id,'storageRevision',p.revision,'document',d,'fieldOwner',CASE WHEN own THEN 'employee' ELSE 'hr' END,'canEdit',editable,'canRefresh',editable,'canSubmit',editable AND own AND EXISTS(SELECT 1 FROM jsonb_array_elements(fields) f WHERE app.personnel_completion_owner(d,f)='employee'),'canOverride',editable AND hr,'canReview',review,'proposals',proposals,'canWritePersonnel',review AND app.is_admin_for(c.company_id));
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_completion_read(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_completion_read(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_completion_sync(p_part uuid,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s document_signing_document;next jsonb;fingerprint text;
BEGIN
 SELECT * INTO s FROM document_signing_document WHERE subject_type='probation' AND subject_id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RETURN;END IF;
 IF app.personnel_completion_locked(app.probation_letter_completion_document(p_part)) THEN RAISE EXCEPTION 'Signed completion content is immutable';END IF;
 fingerprint:=encode(sha256(convert_to(app.probation_content(p_part)::text,'UTF8')),'hex');IF fingerprint=s.data->>'contentHash' THEN RETURN;END IF;
 -- This private subject custodian may revise only its newly checked source content. Routes and every historical action stay byte-for-byte unchanged.
 next:=s.data||jsonb_build_object('contentHash',fingerprint,'contentRevision',(s.data->>'contentRevision')::integer+1);
 UPDATE document_signing_document SET data=next,revision=revision+1,updated_at=now() WHERE id=s.id;
 INSERT INTO document_signing_revision(document_id,tenant_id,revision,data,actor_user_id,actor_kind,reason) VALUES(s.id,s.tenant_id,s.revision+1,next,app.current_user_id(),'user',p_reason);
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(s.tenant_id,'document-signing',s.id,'document-signing.revised','user',app.current_user_id(),s.employment_id,jsonb_build_object('documentId',s.id,'revision',s.revision+1,'operation','native-personnel-completion'));
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_completion_sync(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_completion_update(p_case uuid,p_part uuid,p_expected integer,p_values jsonb,p_operation text,p_reason text,p_override jsonb DEFAULT NULL,p_edits jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;o probation_outcome;s document_signing_document;prior jsonb;d jsonb;source jsonb;policy jsonb;entry jsonb;old_entry jsonb;field jsonb;block jsonb;blocks jsonb;merged jsonb;next_data jsonb;key text;value jsonb;answer text;owner text;before_owner text;field_key text;who jsonb:=app.probation_letter_completion_actor();stamp text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');hr boolean;own boolean;full_edit boolean;receipt_operation text;
BEGIN
 IF who IS NULL OR coalesce(p_operation,'') NOT IN('save','submit','refresh','override','edit') OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR jsonb_typeof(p_edits) IS DISTINCT FROM 'object' OR octet_length(p_values::text)>1048576 OR octet_length(p_edits::text)>1048576 OR (SELECT count(*) FROM jsonb_each(p_values))>200 OR (SELECT count(*) FROM jsonb_each(p_edits))>500 OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 5000 THEN RAISE EXCEPTION 'Use a bounded native completion command and reason' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 hr:=coalesce(app.probation_letter_completion_hr(p.id),false);own:=coalesce(app.probation_letter_completion_own(p.id),false);
 IF p.id IS NULL OR p.revision IS DISTINCT FROM p_expected OR NOT p.data?'personnelCompletion' OR NOT(hr OR own) THEN RAISE EXCEPTION 'Read the current authorized preparation revision' USING ERRCODE='40001';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);SELECT * INTO o FROM probation_outcome WHERE id=(p.data->>'letterOutcomeId')::uuid AND tenant_id=p.tenant_id FOR UPDATE;
 IF o.letter_part_id IS DISTINCT FROM p.id OR o.released_at IS NOT NULL OR o.state='release_requested' THEN RAISE EXCEPTION 'Released and replaced letters are immutable';END IF;
 IF (app.probation_letter_completion_requested(jsonb_build_object('fields',p.data->'letterFields','blocks',p.data->'letterBlocks'))&&ARRAY['personalEmail','employee.icNo','employee.passportNo']) AND app.probation_letter_completion_identity(p.id) IS NOT TRUE THEN RAISE EXCEPTION 'Protected Personnel identity permission is required' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id FOR UPDATE;
 prior:=app.probation_letter_completion_document(p.id);IF app.personnel_completion_locked(prior) THEN RAISE EXCEPTION 'Signed completion content is immutable';END IF;
 IF NOT hr AND own AND app.document_signing_returned(s.data) AND app.document_signing_owner(s.data) IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'The returned letter is held by its owner' USING ERRCODE='42501';END IF;
 full_edit:=coalesce(p_operation='edit' AND app.probation_part_access(p.id) AND app.document_signing_can_edit(s.data,app.current_user_id()) AND app.probation_signing_access(p.id,'revise'),false);
 IF p_operation='edit' AND NOT full_edit OR p_operation<>'edit' AND p_edits<>'{}'::jsonb OR p_operation='submit' AND NOT own OR p_operation='override' AND NOT hr THEN RAISE EXCEPTION 'This completion operation belongs to another actor' USING ERRCODE='42501';END IF;
 PERFORM app.probation_letter_completion_lock_person((SELECT person_id FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id));
 source:=app.probation_letter_completion_source(p.id);d:=app.probation_letter_completion_reconcile(prior,source,who,stamp,true);policy:=d->'personnelCompletion';owner:=CASE WHEN own THEN 'employee' ELSE 'hr' END;
 IF p_operation='override' THEN
  IF jsonb_typeof(p_override) IS DISTINCT FROM 'object' OR p_override-ARRAY['fieldId','owner']<>'{}'::jsonb OR coalesce(p_override->>'owner','') NOT IN('employee','hr') THEN RAISE EXCEPTION 'Choose a completion owner';END IF;
  SELECT f INTO field FROM jsonb_array_elements(d->'fields') f WHERE f->>'id'=p_override->>'fieldId';entry:=policy->'fields'->(field->>'id');
  IF entry IS NULL OR btrim(coalesce(entry->>'sourceValue',''))<>'' OR p_override->>'owner'='employee' AND app.personnel_completion_group(field->>'pmKey')='unknown' THEN RAISE EXCEPTION 'Only a classified missing Personnel field can change who completes it';END IF;
  before_owner:=app.personnel_completion_owner(d,field);
  IF before_owner IS DISTINCT FROM p_override->>'owner' THEN d:=jsonb_set(d,ARRAY['values',field->>'id'],'""'::jsonb,true);entry:=entry-'answer';END IF;
  entry:=entry||jsonb_build_object('override',jsonb_build_object('owner',p_override->>'owner','by',who,'at',stamp,'reason',btrim(p_reason)));
  policy:=(policy-'submitted')||jsonb_build_object('fields',(policy->'fields')||jsonb_build_object(field->>'id',entry),'history',coalesce(policy->'history','[]')||jsonb_build_array(jsonb_build_object('fieldId',field->>'id','action','override','by',who,'at',stamp,'before',before_owner,'after',p_override->>'owner','reason',btrim(p_reason))));
  d:=jsonb_set(d,'{personnelCompletion}',policy,true);
  IF before_owner IS DISTINCT FROM p_override->>'owner' THEN UPDATE probation_letter_personnel_proposal SET status='rejected',history=history||jsonb_build_array(jsonb_build_object('status',status,'after',after_value,'reason','Completion owner changed','by',who,'at',stamp)),updated_at=now() WHERE tenant_id=p.tenant_id AND part_id=p.id AND field_id=field->>'id' AND status IN('proposed','conflict');END IF;
 END IF;
 FOR key,value IN SELECT * FROM jsonb_each(p_values) LOOP
  SELECT f INTO field FROM jsonb_array_elements(d->'fields') f WHERE f->>'id'=key;
  IF field IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'string' OR p_operation NOT IN('save','submit','edit') THEN RAISE EXCEPTION 'Only declared fields may be saved';END IF;
  entry:=d->'personnelCompletion'->'fields'->key;old_entry:=prior->'personnelCompletion'->'fields'->key;answer:=value#>>'{}';
  IF entry IS NULL THEN
   IF NOT full_edit OR field->>'owner' IS DISTINCT FROM owner OR field->>'pmKey' IS NOT NULL OR key=ANY(app.probation_letter_protected_keys_before_completion_6686()) THEN RAISE EXCEPTION 'This field belongs to another owner' USING ERRCODE='42501';END IF;
  ELSIF app.personnel_completion_owner(d,field) IS DISTINCT FROM owner THEN
   -- A newly arrived official value wins. Preserve an authorized employee's stale posted answer for review, never overwrite Personnel.
   IF app.personnel_completion_owner(prior,field)=owner AND btrim(coalesce(entry->>'sourceValue',''))<>'' AND entry->>'sourceValue' IS DISTINCT FROM old_entry->>'sourceValue' THEN
    IF owner='employee' AND answer<>'' AND answer IS DISTINCT FROM entry->>'sourceValue' THEN
     PERFORM app.personnel_completion_scalar(field,answer);entry:=entry||jsonb_build_object('draft',jsonb_build_object('value',answer,'by',who,'at',stamp),'conflict',jsonb_build_object('draft',answer,'official',entry->>'sourceValue','at',stamp));d:=jsonb_set(d,ARRAY['personnelCompletion','fields',key],entry,true);
    END IF;CONTINUE;
   END IF;RAISE EXCEPTION 'The Personnel field is locked or belongs to another owner' USING ERRCODE='42501';
  END IF;
  PERFORM app.personnel_completion_scalar(field,answer);d:=jsonb_set(d,ARRAY['values',key],to_jsonb(answer),true);
  IF entry IS NOT NULL THEN
   entry:=entry||jsonb_build_object('answer',jsonb_build_object('value',answer,'owner',owner,'by',who,'at',stamp));IF owner='employee' THEN entry:=entry||jsonb_build_object('draft',jsonb_build_object('value',answer,'by',who,'at',stamp));END IF;
   d:=jsonb_set(d,ARRAY['personnelCompletion','fields',key],entry,true);
  END IF;
 END LOOP;
 UPDATE probation_letter_personnel_proposal proposal SET status='conflict',history=history||jsonb_build_array(jsonb_build_object('status',status,'after',after_value,'reason','Official Personnel source changed','by',who,'at',stamp)),updated_at=now() WHERE proposal.tenant_id=p.tenant_id AND proposal.part_id=p.id AND proposal.status='proposed' AND btrim(coalesce(d->'personnelCompletion'->'fields'->proposal.field_id->>'sourceValue',''))<>'';
 policy:=d->'personnelCompletion';IF p_operation IN('save','edit') AND p_values<>'{}'::jsonb THEN policy:=policy-'submitted';END IF;
 IF p_operation='submit' THEN
  FOR field IN SELECT f FROM jsonb_array_elements(d->'fields') f WHERE app.personnel_completion_owner(d,f)='employee' LOOP
   IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb AND d->'values'->>(field->'when'->>'field') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;
   answer:=coalesce(d->'values'->>(field->>'id'),'');IF field->>'required'='true' AND (btrim(answer)='' OR field->>'type'='checkbox' AND answer<>'true' OR field->>'type'='table' AND answer='[]') THEN RAISE EXCEPTION 'Complete every required assigned field before submitting';END IF;PERFORM app.personnel_completion_scalar(field,answer);
   entry:=policy->'fields'->(field->>'id');
   IF entry IS NOT NULL AND entry->'answer'->>'owner'='employee' AND entry->'answer'->'by'->>'id'=app.current_user_id()::text AND entry->'answer'->>'value'=answer AND btrim(answer)<>'' AND btrim(coalesce(entry->>'sourceValue',''))='' THEN
    INSERT INTO probation_letter_personnel_proposal(tenant_id,part_id,field_id,field_key,after_value,source_fingerprint,provenance) VALUES(p.tenant_id,p.id,field->>'id',field->>'pmKey',answer,policy->>'sourceFingerprint',jsonb_build_object('kind','missing-personnel','version',1,'by',entry->'answer'->'by','at',entry->'answer'->>'at'))
    ON CONFLICT(tenant_id,part_id,field_id) DO UPDATE SET after_value=EXCLUDED.after_value,source_fingerprint=EXCLUDED.source_fingerprint,provenance=EXCLUDED.provenance,status='proposed',reviewed_by=NULL,reviewed_at=NULL,history=probation_letter_personnel_proposal.history||jsonb_build_array(jsonb_build_object('after',probation_letter_personnel_proposal.after_value,'status',probation_letter_personnel_proposal.status,'provenance',probation_letter_personnel_proposal.provenance,'reviewedBy',probation_letter_personnel_proposal.reviewed_by,'reviewedAt',probation_letter_personnel_proposal.reviewed_at)),updated_at=now() WHERE probation_letter_personnel_proposal.after_value IS DISTINCT FROM EXCLUDED.after_value OR probation_letter_personnel_proposal.status='pushed' OR probation_letter_personnel_proposal.status='rejected' AND probation_letter_personnel_proposal.reviewed_by IS NULL;
   END IF;
  END LOOP;
  policy:=policy||jsonb_build_object('submitted',jsonb_build_object('at',stamp,'by',who,'sourceFingerprint',policy->>'sourceFingerprint'));
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'required'='true' AND d->'personnelCompletion'->'fields' ? (f->>'id') AND app.personnel_completion_owner(jsonb_set(d,'{personnelCompletion}',policy),f)='employee') AND NOT policy?'preparation' THEN policy:=policy||jsonb_build_object('preparation',jsonb_build_object('at',stamp,'by',who));END IF;
 d:=jsonb_set(d,'{personnelCompletion}',policy,true);merged:=p.data->'letterMerge';blocks:=p.data->'letterBlocks';
 FOR field IN SELECT f FROM jsonb_array_elements(d->'fields') f LOOP
  field_key:=coalesce(field->>'pmKey',field->>'id');IF d->'values'->(field->>'id') IS DISTINCT FROM prior->'values'->(field->>'id') THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') other WHERE coalesce(other->>'pmKey',other->>'id')=field_key AND other->>'id'<>field->>'id' AND d->'values'->(other->>'id') IS DISTINCT FROM d->'values'->(field->>'id')) THEN RAISE EXCEPTION 'Linked duplicate fields must have the same value';END IF;
   merged:=jsonb_set(merged,ARRAY[field_key],d->'values'->(field->>'id'),true);
  END IF;
 END LOOP;
 -- Unbound PM tokens remain read-only source values; refreshing cannot supply a case answer for a nonexistent field.
 FOR field_key IN SELECT key0 FROM unnest(app.probation_letter_completion_requested(jsonb_build_object('fields',d->'fields','blocks',blocks))) key0 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'pmKey'=key0) LOOP merged:=jsonb_set(merged,ARRAY[field_key],to_jsonb(coalesce(source->>field_key,'')),true);END LOOP;
 FOR key,value IN SELECT * FROM jsonb_each(p_edits) LOOP
  SELECT b INTO block FROM jsonb_array_elements(blocks) b WHERE b->>'id'=key AND b->>'type' IN('heading','subheading','text');
  IF NOT full_edit OR block IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'string' OR length(value#>>'{}')>20000 OR (value#>>'{}')~'[{][{]|[}][}]' OR EXISTS(SELECT 1 FROM regexp_matches(value#>>'{}','[{]([^{}]+)[}]','g') token WHERE NOT (token[1]=ANY(app.probation_letter_protected_keys())) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'id'=token[1])) THEN RAISE EXCEPTION 'Use existing editable wording and registered merge fields';END IF;
  SELECT jsonb_agg(CASE WHEN b->>'id'=key THEN jsonb_set(b,'{text}',value) ELSE b END ORDER BY n) INTO blocks FROM jsonb_array_elements(blocks) WITH ORDINALITY item(b,n);
 END LOOP;
 IF app.probation_letter_completion_requested(jsonb_build_object('fields',d->'fields','blocks',blocks))&&ARRAY['personalEmail','employee.icNo','employee.passportNo'] AND app.probation_letter_completion_identity(p.id) IS NOT TRUE THEN RAISE EXCEPTION 'Protected Personnel identity permission is required' USING ERRCODE='42501';END IF;
 FOR field_key IN SELECT key0 FROM unnest(app.probation_letter_completion_requested(jsonb_build_object('fields',d->'fields','blocks',blocks))) key0 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'pmKey'=key0) LOOP merged:=jsonb_set(merged,ARRAY[field_key],to_jsonb(coalesce(source->>field_key,'')),true);END LOOP;
 PERFORM app.probation_validate_letter_fields(d->'fields',merged,false);
 next_data:=p.data||jsonb_build_object('personnelCompletion',policy,'letterMerge',merged,'letterBlocks',blocks);
 IF next_data IS NOT DISTINCT FROM p.data THEN RETURN jsonb_build_object('changed',false,'revision',p.revision);END IF;
 receipt_operation:=CASE WHEN p_operation='edit' THEN 'save' ELSE p_operation END;
 PERFORM app.probation_letter_completion_receipt(p.id,p.data,next_data,p.revision+1,receipt_operation);
 UPDATE probation_part SET data=next_data,revision=revision+1,content_revision=content_revision+1,updated_at=now() WHERE id=p.id;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision+1,next_data,app.current_user_id(),btrim(p_reason));
 PERFORM app.probation_letter_completion_sync(p.id,btrim(p_reason));PERFORM app.probation_audit(c.id,p.id,'letter_personnel_completion_'||p_operation,btrim(p_reason));
 RETURN jsonb_build_object('changed',true,'revision',p.revision+1);
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_completion_update(uuid,uuid,integer,jsonb,text,text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_completion_update(uuid,uuid,integer,jsonb,text,text,jsonb,jsonb) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE probation_letter_personnel_proposal ADD COLUMN review_transaction xid8,ADD COLUMN review_actor uuid,ADD COLUMN review_source_before text,ADD COLUMN review_part_revision integer,ADD COLUMN review_mode text;
ALTER TABLE probation_letter_personnel_proposal ADD FOREIGN KEY(tenant_id,review_actor) REFERENCES app_user(tenant_id,id);
CREATE FUNCTION app.probation_letter_personnel_review_claim(p_case uuid,p_part uuid,p_expected integer,p_ids jsonb,p_mode text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;o probation_outcome;source jsonb;ids uuid[];result jsonb;
BEGIN
 IF coalesce(p_mode,'') NOT IN('push','keep') OR jsonb_typeof(p_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ids) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Choose bounded Personnel proposals';END IF;
 SELECT array_agg((value#>>'{}')::uuid) INTO ids FROM jsonb_array_elements(p_ids);IF cardinality(ids)<>(SELECT count(DISTINCT value) FROM unnest(ids) value) THEN RAISE EXCEPTION 'Review each proposal once';END IF;
 PERFORM app.probation_write_lock();SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR p.revision IS DISTINCT FROM p_expected OR app.probation_letter_completion_hr(p.id) IS NOT TRUE OR app.probation_part_access(p.id) IS NOT TRUE OR NOT p.data?'personnelCompletion' THEN RAISE EXCEPTION 'Current scoped HR review is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);SELECT * INTO o FROM probation_outcome WHERE id=(p.data->>'letterOutcomeId')::uuid AND tenant_id=p.tenant_id;
 IF o.letter_part_id IS DISTINCT FROM p.id OR o.released_at IS NOT NULL OR o.state='release_requested' OR p_mode='push' AND app.is_admin_for(c.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'The current unreleased case and Personnel write authority are required' USING ERRCODE='42501';END IF;
 -- Lock the real Personnel subject before capturing the source. A fake pushed receipt cannot be manufactured without an actual same-transaction source change.
 PERFORM app.probation_letter_completion_lock_person((SELECT person_id FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id));
 PERFORM 1 FROM person WHERE id=(SELECT person_id FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id) AND tenant_id=c.tenant_id FOR UPDATE;
 PERFORM 1 FROM probation_letter_personnel_proposal WHERE tenant_id=p.tenant_id AND part_id=p.id AND id=ANY(ids) FOR UPDATE;
 IF cardinality(ids)<>(SELECT count(*) FROM probation_letter_personnel_proposal WHERE tenant_id=p.tenant_id AND part_id=p.id AND id=ANY(ids) AND status IN('proposed','conflict')) THEN RAISE EXCEPTION 'A proposal changed or belongs to another document';END IF;
 IF p_mode='push' AND EXISTS(SELECT 1 FROM probation_letter_personnel_proposal proposal WHERE proposal.tenant_id=p.tenant_id AND proposal.part_id=p.id AND proposal.id=ANY(ids) AND (p.data->'personnelCompletion'->'submitted' IS NULL OR p.data->'personnelCompletion'->'submitted'->>'sourceFingerprint' IS DISTINCT FROM p.data->'personnelCompletion'->>'sourceFingerprint' OR p.data->'personnelCompletion'->'fields'->proposal.field_id->'answer'->>'owner' IS DISTINCT FROM 'employee' OR p.data->'personnelCompletion'->'fields'->proposal.field_id->'answer'->>'value' IS DISTINCT FROM proposal.after_value OR p.data->'letterMerge'->>proposal.field_key IS DISTINCT FROM proposal.after_value)) THEN RAISE EXCEPTION 'Review only the employee current submitted answer';END IF;
 source:=app.probation_letter_completion_source(p.id);
 UPDATE probation_letter_personnel_proposal SET review_transaction=pg_current_xact_id(),review_actor=app.current_user_id(),review_part_revision=p.revision,review_mode=p_mode,review_source_before=coalesce(source->>field_key,'') WHERE tenant_id=p.tenant_id AND part_id=p.id AND id=ANY(ids);
 SELECT jsonb_build_object('employmentId',c.employment_id,'proposals',jsonb_agg(jsonb_build_object('id',r.id,'field',r.field_key,'before',r.before_value,'after',r.after_value) ORDER BY r.id)) INTO result FROM probation_letter_personnel_proposal r WHERE r.tenant_id=p.tenant_id AND r.part_id=p.id AND r.id=ANY(ids);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_personnel_review_claim(uuid,uuid,integer,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_personnel_review_claim(uuid,uuid,integer,jsonb,text) TO ai_hr_app;
CREATE FUNCTION app.probation_letter_personnel_review_finish(p_case uuid,p_part uuid,p_expected integer,p_decisions jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;r probation_letter_personnel_proposal;item jsonb;source jsonb;seen uuid[]:='{}';target uuid;state text;
BEGIN
 IF jsonb_typeof(p_decisions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_decisions) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Choose bounded Personnel proposals';END IF;
 SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.revision IS DISTINCT FROM p_expected OR app.probation_letter_completion_hr(p.id) IS NOT TRUE OR app.probation_part_access(p.id) IS NOT TRUE THEN RAISE EXCEPTION 'Current scoped HR review is required' USING ERRCODE='42501';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 source:=app.probation_letter_completion_source(p.id);
 FOR item IN SELECT value FROM jsonb_array_elements(p_decisions) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['id','status']<>'{}'::jsonb OR coalesce(item->>'status','') NOT IN('pushed','conflict','rejected') THEN RAISE EXCEPTION 'Use a verified Personnel decision';END IF;
  target:=(item->>'id')::uuid;state:=item->>'status';IF target=ANY(seen) THEN RAISE EXCEPTION 'Review each proposal once';END IF;seen:=array_append(seen,target);
  SELECT * INTO r FROM probation_letter_personnel_proposal WHERE id=target AND part_id=p.id AND tenant_id=p.tenant_id FOR UPDATE;
  IF r.id IS NULL OR r.status NOT IN('proposed','conflict') OR r.review_transaction IS DISTINCT FROM pg_current_xact_id() OR r.review_actor IS DISTINCT FROM app.current_user_id() OR r.review_part_revision IS DISTINCT FROM p.revision THEN RAISE EXCEPTION 'A native review custody receipt is required' USING ERRCODE='42501';END IF;
  IF state='rejected' AND r.review_mode IS DISTINCT FROM 'keep' OR state IN('pushed','conflict') AND (r.review_mode IS DISTINCT FROM 'push' OR app.is_admin_for(c.company_id) IS NOT TRUE) THEN RAISE EXCEPTION 'The Personnel decision belongs to another operation' USING ERRCODE='42501';END IF;
  IF state='pushed' AND (r.review_source_before IS DISTINCT FROM r.before_value OR coalesce(source->>r.field_key,'') IS DISTINCT FROM r.after_value) THEN RAISE EXCEPTION 'The official Personnel change was not verified';END IF;
  IF state='conflict' AND r.review_source_before IS NOT DISTINCT FROM r.before_value AND coalesce(source->>r.field_key,'') IS NOT DISTINCT FROM r.before_value THEN RAISE EXCEPTION 'The reported Personnel source conflict was not verified';END IF;
  UPDATE probation_letter_personnel_proposal SET status=state,reviewed_by=app.current_user_id(),reviewed_at=now(),updated_at=now(),history=history||jsonb_build_array(jsonb_build_object('status',status,'after',after_value,'reviewedBy',app.current_user_id(),'at',now())),review_transaction=NULL,review_actor=NULL,review_source_before=NULL,review_part_revision=NULL,review_mode=NULL WHERE id=r.id;
 END LOOP;
 UPDATE probation_part SET revision=revision+1,updated_at=now() WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'letter_personnel_reviewed','Reviewed selected Personnel proposals');
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_personnel_review_finish(uuid,uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_personnel_review_finish(uuid,uuid,integer,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_completion_assert(p_part uuid,p_fresh boolean,p_final boolean) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d jsonb;policy jsonb;source jsonb;official jsonb;field jsonb;entry jsonb;value text;key text;employee uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT p.data?'personnelCompletion' THEN RETURN;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;d:=app.probation_letter_completion_document(p.id);policy:=d->'personnelCompletion';
 IF (app.probation_letter_completion_requested(jsonb_build_object('fields',p.data->'letterFields','blocks',p.data->'letterBlocks'))&&ARRAY['personalEmail','employee.icNo','employee.passportNo']) AND app.probation_letter_completion_identity(p.id) IS NOT TRUE THEN RAISE EXCEPTION 'Protected Personnel identity permission is required' USING ERRCODE='42501';END IF;
 IF p_fresh THEN
  source:=app.probation_letter_completion_source(p.id);
  official:=app.personnel_completion_official(jsonb_set(d,'{fields}',coalesce((SELECT jsonb_agg(f) FROM jsonb_array_elements(d->'fields') f WHERE policy->'fields' ? (f->>'id')),'[]')),source);
  IF policy->>'country' IS DISTINCT FROM source->>'_country' OR policy->>'sourceFingerprint' IS DISTINCT FROM app.personnel_completion_fingerprint(official,source->>'_country') THEN RAISE EXCEPTION 'Personnel values changed. Refresh before continuing';END IF;
  FOR key IN SELECT value0 FROM unnest(app.probation_letter_completion_requested(jsonb_build_object('fields',d->'fields','blocks',p.data->'letterBlocks'))) value0 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'pmKey'=value0) LOOP
   IF btrim(coalesce(source->>key,''))='' OR p.data->'letterMerge'->>key IS DISTINCT FROM source->>key THEN RAISE EXCEPTION 'Complete or refresh missing unbound Personnel values';END IF;
  END LOOP;
 END IF;
 SELECT u.id INTO employee FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND u.id::text=policy->'submitted'->'by'->>'id' AND (NOT p_fresh OR u.archived_at IS NULL AND NOT app.login_blocked(u.id));
 FOR field IN SELECT f FROM jsonb_array_elements(d->'fields') f LOOP
  entry:=policy->'fields'->(field->>'id');IF entry IS NULL THEN CONTINUE;END IF;
  IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb AND d->'values'->>(field->'when'->>'field') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;
  value:=coalesce(d->'values'->>(field->>'id'),'');
  IF p_fresh AND entry->>'sourceValue' IS DISTINCT FROM official->>(field->>'id') THEN RAISE EXCEPTION 'The current Personnel source changed';END IF;
  IF btrim(coalesce(entry->>'sourceValue',''))<>'' AND value IS DISTINCT FROM entry->>'sourceValue' THEN RAISE EXCEPTION 'Personnel values are locked';END IF;
  IF app.personnel_completion_owner(d,field)<>'pmLocked' THEN PERFORM app.personnel_completion_scalar(field,value);END IF;
  IF p_final AND field->>'required'='true' THEN
   IF btrim(value)='' OR field->>'type'='checkbox' AND value<>'true' OR field->>'type'='table' AND value='[]' THEN RAISE EXCEPTION 'Complete required document fields before signing';END IF;
   IF app.personnel_completion_owner(d,field)='employee' AND (employee IS NULL OR policy->'submitted'->'by'->>'id' IS DISTINCT FROM employee::text OR policy->'submitted'->>'sourceFingerprint' IS DISTINCT FROM policy->>'sourceFingerprint' OR entry->'answer'->>'owner' IS DISTINCT FROM 'employee' OR entry->'answer'->'by'->>'id' IS DISTINCT FROM employee::text OR entry->'answer'->>'value' IS DISTINCT FROM value) THEN RAISE EXCEPTION 'The employee must submit their assigned preparation before the first signature';END IF;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_completion_assert(uuid,boolean,boolean) FROM PUBLIC,ai_hr_app;
ALTER FUNCTION app.probation_signing_action_allowed(uuid,jsonb) RENAME TO probation_signing_action_before_completion_6687;
REVOKE ALL ON FUNCTION app.probation_signing_action_before_completion_6687(uuid,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_signing_action_allowed(p_subject uuid,p_action jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;d jsonb;
BEGIN
 IF app.probation_signing_action_before_completion_6687(p_subject,p_action) IS NOT TRUE THEN RETURN false;END IF;
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();
 IF p.data?'personnelCompletion' AND p_action->>'action'='signed' THEN
  d:=app.probation_letter_completion_document(p.id);IF NOT app.personnel_completion_locked(d) THEN PERFORM app.probation_letter_completion_lock_person((SELECT e.person_id FROM employment e JOIN probation_case c ON c.employment_id=e.id AND c.tenant_id=e.tenant_id WHERE c.id=p.case_id AND c.tenant_id=p.tenant_id));END IF;PERFORM app.probation_letter_completion_assert(p.id,NOT app.personnel_completion_locked(d),true);
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.probation_signing_action_allowed(uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.probation_release_signed_letter(uuid,uuid,integer,text) RENAME TO probation_release_signed_letter_before_completion_6687;
REVOKE ALL ON FUNCTION app.probation_release_signed_letter_before_completion_6687(uuid,uuid,integer,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_release_signed_letter(p_outcome uuid,p_part uuid,p_expected integer,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d jsonb;
BEGIN
 d:=app.probation_letter_completion_document(p_part);
 IF d?'personnelCompletion' THEN
  IF app.probation_letter_completion_hr(p_part) IS NOT TRUE THEN RAISE EXCEPTION 'Current scoped reviewer required' USING ERRCODE='42501';END IF;
  PERFORM app.probation_letter_completion_assert(p_part,false,true);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE d->'personnelCompletion'->'fields' ? (f->>'id') AND app.personnel_completion_owner(d,f)='hr' AND btrim(coalesce(d->'values'->>(f->>'id'),''))='' AND (f->'when' IS NULL OR f->'when'='null'::jsonb OR d->'values'->>(f->'when'->>'field')=f->'when'->>'value')) THEN RAISE EXCEPTION 'Complete missing HR Personnel values before release';END IF;
 END IF;
 RETURN app.probation_release_signed_letter_before_completion_6687(p_outcome,p_part,p_expected,p_reason);
END $$;
REVOKE ALL ON FUNCTION app.probation_release_signed_letter(uuid,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_release_signed_letter(uuid,uuid,integer,text) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.probation_letter_tasks(uuid) RENAME TO probation_letter_tasks_before_completion_6687;
REVOKE ALL ON FUNCTION app.probation_letter_tasks_before_completion_6687(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_letter_tasks(p_case uuid) RETURNS TABLE("partId" uuid,label text,state text,"waitingRole" text,"waitingName" text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH candidates AS(
  SELECT task.*,p.data,c.data AS case_data,c.company_id=e.company_id AS same_company,person.full_name AS subject_name,s.data AS signing,
   jsonb_build_object('fields',p.data->'letterFields','personnelCompletion',p.data->'personnelCompletion','values',coalesce((SELECT jsonb_object_agg(f->>'id',coalesce(p.data->'letterMerge'->>coalesce(f->>'pmKey',f->>'id'),'')) FROM jsonb_array_elements(coalesce(p.data->'letterFields','[]')) f),'{}')) AS document
  FROM app.probation_letter_tasks_before_completion_6687(p_case) WITH ORDINALITY task("partId",label,state,"waitingRole","waitingName",task_order) JOIN probation_part p ON p.id=task."partId" AND p.tenant_id=app.current_tenant_id()
  JOIN probation_case c ON c.id=p.case_id AND c.tenant_id=p.tenant_id JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id JOIN person ON person.id=e.person_id AND person.tenant_id=e.tenant_id
  LEFT JOIN document_signing_document s ON s.subject_type='probation' AND s.subject_id=p.id AND s.tenant_id=p.tenant_id
 ), projected AS(
  SELECT candidates.*,data?'personnelCompletion' AND same_company AND case_data->>'state' NOT IN('withdrawn','confirmed','not_confirmed') AND data->>'state' NOT IN('locked','cancelled','release_requested') AND state NOT IN('released','awaiting_owner_seal','awaiting_revision') AND NOT coalesce(app.document_signing_locked(signing),false) AND NOT coalesce(app.document_signing_returned(signing),false)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(data->'letterFields','[]')) f WHERE data->'personnelCompletion'->'fields' ? (f->>'id') AND f->>'required'='true' AND app.personnel_completion_owner(document,f)='employee'
    AND (f->'when' IS NULL OR f->'when'='null'::jsonb OR document->'values'->>(f->'when'->>'field')=f->'when'->>'value')
    AND (data->'personnelCompletion'->'submitted' IS NULL OR data->'personnelCompletion'->'submitted'->>'sourceFingerprint' IS DISTINCT FROM data->'personnelCompletion'->>'sourceFingerprint' OR btrim(coalesce(document->'values'->>(f->>'id'),''))='')) AS preparing
  FROM candidates
 )
 SELECT "partId",label,CASE WHEN preparing THEN 'awaiting_preparation' ELSE state END,CASE WHEN preparing THEN 'employee' ELSE "waitingRole" END,CASE WHEN preparing THEN subject_name ELSE "waitingName" END FROM projected ORDER BY task_order
$$;
REVOKE ALL ON FUNCTION app.probation_letter_tasks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_tasks(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Preserve the existing bounded queue, category and task identity. Only assigned unsigned preparation adds a task kind.
CREATE OR REPLACE FUNCTION app.probation_task_list(p_category text,p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();me uuid:=app.current_user_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 my_person uuid;usable boolean:=false;ops boolean:=false;visible uuid[];lim integer:=least(greatest(coalesce(p_limit,20),1),200);result jsonb;
BEGIN
 IF p_category IS NOT NULL AND p_category NOT IN('approval','task') THEN RAISE EXCEPTION 'Unknown Probation task category';END IF;
 IF t IS NULL OR me IS NULL OR app.probation_active_user() IS NOT TRUE THEN RETURN jsonb_build_object('count',0,'capped',false,'items','[]'::jsonb);END IF;
 SELECT u.person_id,(u.archived_at IS NULL AND NOT app.login_blocked(u.id)) INTO my_person,usable FROM public.app_user u WHERE u.id=me AND u.tenant_id=t;
 IF EXISTS(SELECT 1 FROM public.probation_access m WHERE m.tenant_id=t AND m.user_id=me AND m.role='gbs') THEN
  ops:=coalesce(usable,false) AND coalesce(app.lifecycle_canonical_people_ops_member((SELECT co.id FROM public.company co WHERE co.tenant_id=t ORDER BY co.id LIMIT 1),me),false);
 END IF;
 visible:=ARRAY(SELECT app.probation_visible_among(NULL));
 WITH cs AS MATERIALIZED (
  SELECT c.id,c.employment_id,c.company_id,c.data FROM public.probation_case c
  WHERE c.tenant_id=t AND c.id=ANY(visible)
   AND EXISTS(SELECT 1 FROM public.probation_activation a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled)
   AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id)
   AND c.data->>'sourceCompanyMoved' IS DISTINCT FROM 'true'),
 h AS MATERIALIZED (SELECT * FROM app.probation_holders_set(ARRAY(SELECT cs.employment_id FROM cs))),
 gbs AS MATERIALIZED (SELECT m.* FROM public.probation_access m WHERE ops AND m.tenant_id=t AND m.user_id=me AND m.role='gbs' AND m.valid_from<=day AND (m.valid_to IS NULL OR m.valid_to>=day)),
 anc AS MATERIALIZED (SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT h.company_id FROM h WHERE EXISTS(SELECT 1 FROM gbs)))),
 gbs_cover AS MATERIALIZED (SELECT DISTINCT anc.company_id,m.department_id,m.business_unit_id FROM gbs m JOIN anc ON anc.ancestor_id=m.company_id),
 -- Holders whose Head of Department / PBP / GBS steps move to me under a general delegation with Probation ticked.
 general AS MATERIALIZED (
  SELECT DISTINCT hu.id AS holder_id FROM public.reporting_line d
  JOIN public.employment de ON de.id=d.manager_employment_id AND de.tenant_id=d.tenant_id AND de.person_id=my_person
  JOIN public.employment he ON he.id=d.subordinate_employment_id AND he.tenant_id=d.tenant_id
  JOIN public.app_user hu ON hu.person_id=he.person_id AND hu.tenant_id=d.tenant_id
  WHERE d.tenant_id=t AND d.line_type::text='delegate' AND d.superseded_at IS NULL AND d.valid_from<=current_date AND (d.valid_to IS NULL OR d.valid_to>current_date)
   AND EXISTS(SELECT 1 FROM public.reporting_line_scope s WHERE s.reporting_line_id=d.id AND s.tenant_id=d.tenant_id AND s.module='probation')),
 parts AS MATERIALIZED (
  SELECT p.id,p.case_id,p.data,p.updated_at,p.content_revision,cs.data AS case_data,h.employee,h.lm,h.hod,h.pbp,
   EXISTS(SELECT 1 FROM gbs_cover g WHERE g.company_id=h.company_id AND (g.department_id IS NULL OR g.department_id=h.department_id) AND (g.business_unit_id IS NULL OR g.business_unit_id=h.business_unit_id)) AS gbs,
   d.data AS doc
  FROM cs JOIN public.probation_part p ON p.case_id=cs.id AND p.tenant_id=t AND coalesce(p.data->>'documentKind','review')='review'
  LEFT JOIN h ON h.employment_id=cs.employment_id
  LEFT JOIN public.document_signing_document d ON d.tenant_id=t AND d.subject_type='probation' AND d.subject_id=p.id
  WHERE cs.data->>'state' NOT IN('withdrawn','confirmed','not_confirmed') AND p.data->>'state'<>'cancelled'),
 -- A superset of the parts on which app.probation_commands can offer me a queue command; cheap tests only.
 candidates AS MATERIALIZED (
  SELECT parts.id,parts.case_id,parts.updated_at,coalesce(nullif(parts.data->>'dueOn','')::date,nullif(parts.case_data->>'endOn','')::date) AS due_on FROM parts
  WHERE
   -- Employee, Line Manager and route steps (Head of Department, PBP, GBS, a delegate or escalated signer) on an open part.
   (parts.data->>'state' NOT IN('not_issued','locked','recorded','completed_offline') AND (
     me=parts.employee OR me=parts.lm OR me=parts.hod OR me=parts.pbp
     OR parts.hod IN(SELECT general.holder_id FROM general) OR parts.pbp IN(SELECT general.holder_id FROM general)
     OR EXISTS(SELECT 1 FROM public.probation_delegate x WHERE x.tenant_id=t AND x.part_id=parts.id AND x.holder_id=me AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day))
     -- 5756: a step assigned on the Part to a person whose Probation work moves to me (general delegation).
     OR EXISTS(SELECT 1 FROM public.probation_delegate x WHERE x.tenant_id=t AND x.part_id=parts.id AND x.kind IN('missing_holder','holder_changed') AND x.holder_id IN(SELECT general.holder_id FROM general) AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day))
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(parts.doc->'route'->'steps','[]'::jsonb)) s WHERE s->>'holderId'=me::text AND NOT app.document_signing_step_fulfilled(parts.doc,s))))
   -- PBP tasks that do not depend on an open route step: KPI exception, employee wait exception, extension and refusal confirmations.
   OR me=parts.pbp AND (
     parts.data->>'state'='not_issued' AND parts.data->>'type'<>'1' AND parts.data->>'kpiException' IS NULL AND parts.case_data->>'kpiAcknowledged' IS DISTINCT FROM 'true' AND parts.case_data->'config'->>'kpiGate'='block'
      -- 5760: only once the gate actually holds the review back (started case, issue date reached), not for every case
      -- still at Part 1 or waiting for its start date.
      AND nullif(parts.case_data->>'startOn','')::date<=day AND nullif(parts.data->>'issueOn','')::date<=day
     OR parts.data->>'state' IN('issued','returned') AND parts.data->>'type'<>'1' AND parts.data->>'staffSubmittedAt' IS NULL AND parts.data->>'employeeWaitException' IS NULL AND parts.data->>'managerSubmittedAt' IS NULL AND parts.case_data->'config'->>'lmWaitsForEmployee'='true'
     OR parts.data->>'managerSubmittedAt' IS NOT NULL AND (EXISTS(SELECT 1 FROM public.probation_rater_draft r WHERE r.part_id=parts.id AND r.rater='lm' AND r.data->>'outcome'='extend')
      OR EXISTS(SELECT 1 FROM public.probation_followup f WHERE f.tenant_id=t AND f.part_id=parts.id AND f.kind='refusal_request')))
   -- GBS People Ops: recording a completed signature set or an offline final.
   OR parts.gbs AND (parts.data->>'state'='pending_approval' OR parts.data->>'state'='completed_offline' AND parts.data->>'type'='3')),
 bounded AS MATERIALIZED (SELECT * FROM candidates ORDER BY due_on,case_id,id LIMIT 201),
 review AS MATERIALIZED (
  SELECT b.case_id,b.id AS part_id,b.due_on,b.updated_at,k.kind,CASE WHEN k.kind='approve' THEN 'approval' ELSE 'task' END AS category,
   '/lifecycle/probation/'||b.case_id::text||'/'||b.id::text AS href
  FROM (SELECT * FROM bounded ORDER BY due_on,case_id,id LIMIT 200) b
  CROSS JOIN LATERAL (SELECT value AS kind FROM unnest(app.probation_commands(b.id)) value
   WHERE value IN('submit_employee','submit_manager','acknowledge','approve','record','confirm_extension','confirm_refusal','kpi_exception','employee_wait_exception') LIMIT 1) k),
 -- Letter Sign / revise / release: only cases with a letter that is not yet released.
 letter_cases AS MATERIALIZED (
  SELECT DISTINCT cs.id FROM cs JOIN public.probation_part l ON l.case_id=cs.id AND l.tenant_id=t AND l.data->>'documentKind'='letter'
  WHERE NOT EXISTS(SELECT 1 FROM public.probation_outcome o WHERE o.tenant_id=t AND o.letter_part_id=l.id AND o.released_at IS NOT NULL)),
 letters AS MATERIALIZED (
  SELECT c.id AS case_id,lt."partId" AS part_id,(c.data->>'endOn')::date AS due_on,lp.updated_at,
   -- 5760 (handoff B5): my pending step's kind decides the queue. Review and Approve go to Approval Items, Sign to the
   -- tasks; revising (the owner) and releasing stay tasks.
   CASE WHEN lt.state='awaiting_preparation' THEN 'letter_prepare' WHEN lt.state='awaiting_revision' THEN 'letter_revise' WHEN lt.state='awaiting_release' THEN 'letter_release'
    WHEN mine.kind='review' THEN 'letter_review' WHEN mine.kind='approve' THEN 'letter_approve' ELSE 'letter_sign' END AS kind,
   CASE WHEN lt.state NOT IN('awaiting_preparation','awaiting_revision','awaiting_release') AND mine.kind IN('review','approve') THEN 'approval' ELSE 'task' END AS category,
   '/lifecycle/probation/'||c.id::text||'/letters/'||lt."partId"::text AS href
  FROM letter_cases lc JOIN public.probation_case c ON c.id=lc.id AND c.tenant_id=t CROSS JOIN LATERAL app.probation_letter_tasks(c.id) lt
  JOIN public.probation_part lp ON lp.id=lt."partId" AND lp.tenant_id=t
  LEFT JOIN LATERAL (SELECT signer.kind FROM app.probation_pending_signer_kinds(lt."partId") signer WHERE signer.user_id=me
   ORDER BY (signer.kind IN('review','approve')) DESC LIMIT 1) mine ON true
  WHERE (mine.kind IS NOT NULL AND lt.state<>'awaiting_preparation'
   OR lt.state='awaiting_preparation' AND EXISTS(SELECT 1 FROM public.employment own_subject WHERE own_subject.id=c.employment_id AND own_subject.tenant_id=t AND own_subject.person_id=my_person)
   OR lt.state IN('awaiting_revision','awaiting_release') AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')))),
 -- 5760 (handoff B5, §6): the PBP's own tasks that no route step carries. A low result (Band at or below the case's
 -- pinned low band) until the action taken with the Line Manager is recorded for this content revision, and an Other
 -- outcome until the PBP chooses the real one. Cheap tests on the visible parts, bounded.
 pbp_work AS MATERIALIZED (
  SELECT parts.case_id,parts.id AS part_id,coalesce(nullif(parts.data->>'dueOn','')::date,nullif(parts.case_data->>'endOn','')::date) AS due_on,parts.updated_at,w.kind,'task'::text AS category,w.href
  FROM parts CROSS JOIN LATERAL (
   SELECT 'low_result_action'::text AS kind,'/lifecycle/probation/'||parts.case_id::text AS href
   WHERE parts.data->>'managerSubmittedAt' IS NOT NULL AND parts.data->>'type'<>'1'
    AND CASE WHEN parts.data->>'scoreBand' ~ '^[1-5]$' THEN (parts.data->>'scoreBand')::integer END
     <=coalesce(CASE WHEN parts.case_data->'config'->>'lowBand' ~ '^[1-5]$' THEN (parts.case_data->'config'->>'lowBand')::integer END,2)
    AND NOT EXISTS(SELECT 1 FROM public.probation_followup f WHERE f.tenant_id=t AND f.part_id=parts.id AND f.kind='low_result_action' AND f.content_revision=parts.content_revision)
   UNION ALL
   SELECT 'choose_outcome'::text,'/lifecycle/probation/'||parts.case_id::text||'/outcomes/'||o.id::text FROM public.probation_outcome o
   WHERE o.tenant_id=t AND o.part_id=parts.id AND o.outcome='other' AND o.released_at IS NULL AND o.state<>'completed') w
  WHERE me=parts.pbp
  ORDER BY 3,1,2 LIMIT 200),
 tasks AS MATERIALIZED (
  SELECT * FROM review WHERE p_category IS NULL OR review.category=p_category
  UNION ALL SELECT * FROM letters WHERE p_category IS NULL OR letters.category=p_category
  UNION ALL SELECT * FROM pbp_work WHERE p_category IS NULL OR pbp_work.category=p_category),
 named AS (
  SELECT tasks.*,person.full_name AS employee_name,c.company_id,(SELECT p.data->>'type' FROM public.probation_part p WHERE p.id=tasks.part_id AND p.tenant_id=t) AS part_type FROM tasks JOIN public.probation_case c ON c.id=tasks.case_id AND c.tenant_id=t
  JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id JOIN public.person person ON person.id=e.person_id AND person.tenant_id=e.tenant_id)
 SELECT jsonb_build_object('count',(SELECT count(*) FROM tasks),'capped',(SELECT count(*) FROM bounded)>200,
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object('caseId',x.case_id,'partId',x.part_id,'employeeName',x.employee_name,'kind',x.kind,'category',x.category,'href',x.href,'dueOn',x.due_on,'updatedAt',x.updated_at,'companyId',x.company_id,'partType',x.part_type) ORDER BY x.due_on,x.case_id,x.part_id)
   FROM (SELECT * FROM named ORDER BY due_on,case_id,part_id LIMIT lim) x),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
