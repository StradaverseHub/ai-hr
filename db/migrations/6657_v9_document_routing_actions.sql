-- The canonical commit sealer owns the audit-chain key. Business commands retain
-- their existing Access, lifecycle and source-row locks without taking that key.
-- Narrow source custodian: only a validated document delta is applied to its existing V9 case.
CREATE FUNCTION app.v9_document_route_apply(p_case uuid,p_revision integer,p_document text,p_next jsonb,p_operation text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c lc_v9_case;n lc_onboarding_case;prior jsonb;source jsonb;docs jsonb;tasks jsonb;entry jsonb;is_native boolean:=false;actor_name text;complete boolean:=app.v9_document_route_complete(p_next);before_doc jsonb;next_pm jsonb;f jsonb;last_action jsonb;
BEGIN
 SELECT * INTO c FROM lc_v9_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN
  SELECT * INTO n FROM lc_onboarding_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Signing document unavailable';END IF;
  SELECT data INTO prior FROM lc_onboarding_private WHERE case_id=n.id AND tenant_id=n.tenant_id FOR UPDATE;
  is_native:=true;source:=prior->'lifecycleV9';c.id:=n.id;c.tenant_id:=n.tenant_id;c.company_id:=n.company_id;c.employment_id:=n.employment_id;c.revision:=n.revision;c.data:=n.data;
 ELSE source:=c.data;END IF;
 IF c.revision IS DISTINCT FROM p_revision OR c.data->>'state' IS DISTINCT FROM 'submitted' THEN RAISE EXCEPTION 'The case changed or is no longer open';END IF;
 SELECT value INTO before_doc FROM jsonb_array_elements(source->'documents') WHERE value->>'id'=p_document;
 IF before_doc IS NULL OR p_next->>'id' IS DISTINCT FROM p_document THEN RAISE EXCEPTION 'Signing document unavailable';END IF;
 SELECT jsonb_agg(CASE WHEN d->>'id'=p_document THEN p_next ELSE d END ORDER BY ordinal) INTO docs FROM jsonb_array_elements(source->'documents') WITH ORDINALITY a(d,ordinal);
 SELECT coalesce(jsonb_agg(CASE WHEN t->>'documentTemplate'=p_next->>'templateId' AND coalesce(t->>'documentAction','completed') IN('signed','completed')
  THEN CASE WHEN complete THEN t||jsonb_build_object('status','done','completedAt',now(),'completedBy',app.current_user_id())
   WHEN app.v9_document_route_complete(before_doc) AND t->>'status'='done' THEN t||jsonb_build_object('status','progress','completedAt',NULL,'completedBy',NULL) ELSE t END ELSE t END ORDER BY ordinal),'[]'::jsonb)
 INTO tasks FROM jsonb_array_elements(c.data->'tasks') WITH ORDINALITY a(t,ordinal);
 next_pm:=coalesce(source->'pmChanges','[]'::jsonb);last_action:=p_next->'signing'->'actions'->-1;
 IF p_operation='signed' AND last_action->>'role'='employee' AND last_action->>'actorId'=app.current_user_id()::text THEN
  FOR f IN SELECT value FROM jsonb_array_elements(p_next->'fields') LOOP
   IF f->>'owner'='employee' AND f->>'pmKey' IS NOT NULL AND f->>'pmKey' NOT LIKE 'case.%'
    AND (f->'when' IS NULL OR f->'when'='null'::jsonb OR p_next->'values'->>(f->'when'->>'field')=f->'when'->>'value')
    AND coalesce(p_next->'values'->>(f->>'id'),'')<>coalesce(p_next->'mergeValues'->>(f->>'pmKey'),'')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(next_pm) x WHERE x->>'documentId'=p_document AND x->>'field'=f->>'pmKey') THEN
    next_pm:=next_pm||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'documentId',p_document,'field',f->>'pmKey','before',coalesce(p_next->'mergeValues'->>(f->>'pmKey'),''),'after',coalesce(p_next->'values'->>(f->>'id'),''),'status','proposed','sourceRevision',CASE WHEN is_native THEN n.data->>'sourceVersion' ELSE source->>'sourceRevision' END));
   END IF;
  END LOOP;
 END IF;
 SELECT p.full_name INTO actor_name FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=c.tenant_id;
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'actor',jsonb_build_object('id',app.current_user_id(),'name',actor_name),'action','document.route.'||p_operation,'detail',p_next->>'name');
 IF is_native THEN
  INSERT INTO lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data) VALUES(c.tenant_id,c.id,c.company_id,c.revision,n.data);
  INSERT INTO lc_onboarding_private_revision(tenant_id,case_id,company_id,revision,data) VALUES(c.tenant_id,c.id,c.company_id,c.revision,prior);
  UPDATE lc_onboarding_case SET revision=c.revision+1,updated_at=now(),data=jsonb_set(n.data,'{tasks}',tasks)||jsonb_build_object('history',coalesce(n.data->'history','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',now(),'by',app.current_user_id(),'name',actor_name,'action','document.route.'||p_operation,'detail',p_next->>'name'))) WHERE id=c.id AND tenant_id=c.tenant_id;
  UPDATE lc_onboarding_private SET data=jsonb_set(prior,'{lifecycleV9}',source||jsonb_build_object('documents',docs,'pmChanges',next_pm,'log',coalesce(source->'log','[]'::jsonb)||jsonb_build_array(entry))) WHERE case_id=c.id AND tenant_id=c.tenant_id;
 ELSE
  INSERT INTO lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id) VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data,app.current_user_id());
  UPDATE lc_v9_case SET revision=c.revision+1,updated_at=now(),data=c.data||jsonb_build_object('revision',c.revision+1,'documents',docs,'tasks',tasks,'pmChanges',next_pm,'log',coalesce(source->'log','[]'::jsonb)||jsonb_build_array(entry)) WHERE id=c.id AND tenant_id=c.tenant_id;
 END IF;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(c.tenant_id,'lifecycle-v9-case',c.id,'lifecycle-v9.documentRoute.'||p_operation,'user',app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'documentId',p_document,'caseRevision',c.revision+1,'contentRevision',p_next->'signing'->'contentRevision'));
 RETURN c.revision+1;
END $$;
REVOKE ALL ON FUNCTION app.v9_document_route_apply(uuid,integer,text,jsonb,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.v9_document_route_read(p_case uuid,p_document text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('caseId',case_id,'caseRevision',revision,'number',number,'state',state,'documentId',document->>'id','name',document->>'name','signing',document->'signing','document',CASE WHEN app.v9_document_route_content_visible(document) THEN document ELSE NULL END)
 FROM app.v9_document_route_sources(p_case) s WHERE s.case_id=p_case AND s.document->>'id'=p_document AND app.probation_company_entitled(s.company_id) AND app.v9_document_route_participant(s.document)
$$;
CREATE FUNCTION app.v9_document_route_act(p_case uuid,p_revision integer,p_document text,p_action jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source record;d jsonb;s jsonb;step jsonb;prior_action jsonb;next jsonb;action jsonb;kind text;actor_person uuid;actor_name text;f jsonb;field_value text;
BEGIN
 IF NOT app.v9_signing_current_actor() THEN RAISE EXCEPTION 'Verified signer required' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();

 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-v9:'||app.current_tenant_id()::text,0));
 SELECT * INTO source FROM app.v9_document_route_sources(p_case) WHERE case_id=p_case AND document->>'id'=p_document;
 IF NOT FOUND OR app.probation_company_entitled(source.company_id) IS NOT TRUE OR NOT app.v9_document_route_content_visible(source.document) OR source.state IS DISTINCT FROM 'submitted' OR source.document->>'status' IN('withdrawn','superseded') THEN RAISE EXCEPTION 'Document is unavailable at your signing step' USING ERRCODE='42501';END IF;
 d:=source.document;s:=d->'signing';kind:=p_action->>'action';
 SELECT u.person_id,p.full_name INTO actor_person,actor_name FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id();
 IF actor_person IS NULL OR actor_name IS NULL OR p_action->>'actorId' IS DISTINCT FROM app.current_user_id()::text OR p_action->>'actorPersonId' IS DISTINCT FROM actor_person::text OR p_action->>'contentHash' IS DISTINCT FROM s->>'contentHash' OR p_action->'contentRevision' IS DISTINCT FROM s->'contentRevision' OR s->>'contentHash' IS DISTINCT FROM app.v9_document_content_hash(d) THEN RAISE EXCEPTION 'Signer or document content changed';END IF;
 SELECT a INTO prior_action FROM jsonb_array_elements(s->'actions') a WHERE a->>'id'=p_action->>'id';
 IF prior_action IS NOT NULL THEN IF prior_action-'at'-'actorName'=p_action-'at'-'actorName' THEN RETURN source.revision;END IF;RAISE EXCEPTION 'Action reference already used';END IF;
 IF source.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'The case changed. Refresh before trying again';END IF;
 IF jsonb_typeof(p_action) IS DISTINCT FROM 'object' OR length(coalesce(p_action->>'id','')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(p_action->'comment') IS DISTINCT FROM 'string' OR length(p_action->>'comment')>4000 OR p_action ? 'coveredStepIds' THEN RAISE EXCEPTION 'Invalid signing action';END IF;
 IF kind='resent' THEN
  IF NOT app.document_signing_returned(s) OR app.document_signing_owner(s) IS DISTINCT FROM app.current_user_id() OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb OR p_action->>'role' IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Only the document owner can send it round again';END IF;
 ELSE
  IF app.document_signing_returned(s) THEN RAISE EXCEPTION 'The document was returned to its owner';END IF;
  IF kind='returned' THEN SELECT value INTO step FROM jsonb_array_elements(s->'route'->'steps') WHERE value->>'id'=p_action->>'stepId' AND value->>'holderId'=app.current_user_id()::text;
  ELSE SELECT value INTO step FROM app.document_signing_pending_steps(s) value WHERE value->>'id'=p_action->>'stepId' AND value->>'holderId'=app.current_user_id()::text;END IF;
  IF step IS NULL OR p_action->>'role' IS DISTINCT FROM step->>'role' OR p_action->>'representedId' IS DISTINCT FROM coalesce(step->>'representedId',step->>'holderId') THEN RAISE EXCEPTION 'Only the assigned route holder can act';END IF;
  IF kind='returned' THEN IF btrim(p_action->>'comment')='' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'A send-back comment is required';END IF;
  ELSIF kind='reviewed' THEN IF step->>'kind'<>'review' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'This step requires a review';END IF;
  ELSIF kind='approved' THEN IF step->>'kind'<>'approve' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'This step requires approval';END IF;
  ELSIF kind='signed' THEN
   IF step->>'kind' NOT IN('sign','acknowledge') OR app.document_signature_valid(p_action->'signature') IS NOT TRUE THEN RAISE EXCEPTION 'Valid signature and consent required';END IF;
   FOR f IN SELECT value FROM jsonb_array_elements(d->'fields') LOOP
    IF f->'when' IS NOT NULL AND jsonb_typeof(f->'when')='object' AND d->'values'->>(f->'when'->>'field') IS DISTINCT FROM f->'when'->>'value' THEN CONTINUE;END IF;
    field_value:=coalesce(d->'values'->>(f->>'id'),'');
    IF f->>'required'='true' AND (btrim(field_value)='' OR f->>'type'='checkbox' AND field_value<>'true' OR f->>'type'='table' AND field_value='[]') THEN RAISE EXCEPTION 'Complete required document fields before signing';END IF;
   END LOOP;
  ELSE RAISE EXCEPTION 'Invalid signing action kind';END IF;
 END IF;
 action:=p_action||jsonb_build_object('actorName',actor_name,'at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 next:=jsonb_set(d,'{signing,actions}',(s->'actions')||jsonb_build_array(action));
 next:=next||jsonb_build_object('stepSignatures',app.v9_document_route_signatures(next),'hrSignature',NULL,'employeeSignature',NULL,'status',CASE WHEN app.v9_document_route_complete(next) THEN 'signed' WHEN d->>'sentAt' IS NOT NULL THEN 'opened' ELSE 'draft' END);
 RETURN app.v9_document_route_apply(p_case,p_revision,p_document,next,kind);
END $$;
REVOKE ALL ON FUNCTION app.v9_document_route_read(uuid,text),app.v9_document_route_act(uuid,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.v9_document_route_read(uuid,text),app.v9_document_route_act(uuid,integer,text,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.v9_document_route_edit(p_case uuid,p_revision integer,p_document text,p_edits jsonb,p_values jsonb DEFAULT '{}'::jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source record;d jsonb;next jsonb;k text;v jsonb;block jsonb;cleaned jsonb:='{}'::jsonb;vals jsonb;f jsonb;can_content boolean;can_employee boolean;
BEGIN
 IF NOT app.v9_signing_current_actor() OR p_edits IS NOT NULL AND (jsonb_typeof(p_edits) IS DISTINCT FROM 'object' OR octet_length(p_edits::text)>1048576) OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR octet_length(p_values::text)>1048576 THEN RAISE EXCEPTION 'Invalid document edit';END IF;
 PERFORM app.access_workforce_write_lock();

 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-v9:'||app.current_tenant_id()::text,0));
 SELECT * INTO source FROM app.v9_document_route_sources(p_case) WHERE case_id=p_case AND document->>'id'=p_document;
 IF NOT FOUND OR app.probation_company_entitled(source.company_id) IS NOT TRUE OR source.revision IS DISTINCT FROM p_revision OR source.state IS DISTINCT FROM 'submitted' OR source.document->>'status' IN('withdrawn','superseded') THEN RAISE EXCEPTION 'The document is locked or it is not your turn to edit' USING ERRCODE='42501';END IF;
 d:=source.document;can_content:=app.document_signing_can_edit(d->'signing',app.current_user_id());
 can_employee:=NOT app.document_signing_locked(d->'signing') AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'signing'->'route'->'steps') step WHERE step->>'role'='employee' AND step->>'holderId'=app.current_user_id()::text);
 IF p_edits IS NOT NULL AND NOT can_content THEN RAISE EXCEPTION 'Only the owner or current reviewer can edit wording';END IF;
 FOR k,v IN SELECT * FROM jsonb_each(coalesce(p_edits,'{}'::jsonb)) LOOP
  SELECT value INTO block FROM jsonb_array_elements(d->'blocks') WHERE value->>'id'=k AND value->>'type' IN('heading','subheading','text');
  IF block IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(v#>>'{}')>20000 THEN RAISE EXCEPTION 'Choose an editable document text block';END IF;
  IF v IS DISTINCT FROM block->'text' THEN cleaned:=cleaned||jsonb_build_object(k,v);END IF;
 END LOOP;
 vals:=coalesce(d->'values','{}'::jsonb);
 FOR k,v IN SELECT * FROM jsonb_each(p_values) LOOP
  SELECT value INTO f FROM jsonb_array_elements(d->'fields') WHERE value->>'id'=k;
  IF f IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(v#>>'{}')>20000 OR NOT (can_content AND f->>'owner'='hr' OR can_employee AND f->>'owner'='employee') THEN RAISE EXCEPTION 'This field belongs to another document actor';END IF;
  IF f->>'type'='select' AND v#>>'{}'<>'' AND NOT f->'options' ? (v#>>'{}') THEN RAISE EXCEPTION 'Choose a configured field option';END IF;
  vals:=vals||jsonb_build_object(k,v);
 END LOOP;
 next:=d||jsonb_build_object('values',vals)||CASE WHEN p_edits IS NOT NULL THEN jsonb_build_object('edits',cleaned) ELSE '{}'::jsonb END;
 IF app.v9_document_content_hash(next)=app.v9_document_content_hash(d) THEN RETURN source.revision;END IF;
 next:=jsonb_set(next,'{signing}',(next->'signing')||jsonb_build_object('contentRevision',(d->'signing'->>'contentRevision')::integer+1,'contentHash',app.v9_document_content_hash(next)));
 next:=next||jsonb_build_object('stepSignatures','{}'::jsonb,'status',CASE WHEN d->>'sentAt' IS NOT NULL THEN 'opened' ELSE 'draft' END);
 RETURN app.v9_document_route_apply(p_case,p_revision,p_document,next,'edited');
END $$;
REVOKE ALL ON FUNCTION app.v9_document_route_edit(uuid,integer,text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.v9_document_route_edit(uuid,integer,text,jsonb,jsonb) TO ai_hr_app;
