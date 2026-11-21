-- Explicit owner approval: actual routed UID+PID Form read/save/init and response-bound signing only.
CREATE FUNCTION app.contract_shared_form_source_current(p_letter uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_letter l JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id
 JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id
 WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter AND e.person_id::text=l.data->>'subjectPersonId' AND e.voided_at IS NULL
 AND app.contract_company_entitled(c.company_id) AND CASE WHEN l.purpose='email' THEN app.contract_shared_email_document_current(l.id) ELSE app.contract_shared_decision_current(l.case_id,l.decision_revision) END)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_form_source_current(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_lock(p_letter uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;
BEGIN
 IF app.contract_shared_document_kind(p_letter) IS DISTINCT FROM 'Form' THEN RETURN false;END IF;
 IF app.contract_shared_form_body_visible(p_letter) IS NOT TRUE THEN RAISE EXCEPTION 'This Form is unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.contract_shared_lock_source((SELECT case_id FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter));
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter FOR UPDATE;
 PERFORM 1 FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id FOR UPDATE;
 PERFORM 1 FROM public.document_form_response WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id FOR UPDATE;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_form_lock(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_form_lock(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_initialize(p_letter uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;hash text;snapshot jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter FOR UPDATE;
 IF app.contract_shared_document_kind(p_letter) IS DISTINCT FROM 'Form' THEN RETURN NULL;END IF;
 IF app.contract_shared_effect_held(l.case_id,l.workflow_run_id,l.workflow_step_id,CASE WHEN l.purpose='email' THEN 'sendEmail' ELSE 'generateDocument' END) IS NOT TRUE THEN RAISE EXCEPTION 'Protected document preparation required' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id) THEN RAISE EXCEPTION 'Form is already initialized' USING ERRCODE='40001';END IF;
 INSERT INTO public.document_form_response(tenant_id,document_id,subject_id,source_person_id) VALUES(l.tenant_id,l.signing_document_id,l.id,(l.data->>'subjectPersonId')::uuid) ON CONFLICT DO NOTHING;
 INSERT INTO public.document_form_response_revision(tenant_id,document_id,revision,answers) VALUES(l.tenant_id,l.signing_document_id,1,'{}'::jsonb) ON CONFLICT DO NOTHING;
 UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{formProtocol}','1'::jsonb) WHERE tenant_id=l.tenant_id AND id=l.id;
 snapshot:=app.contract_shared_letter_snapshot(l.id);hash:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 INSERT INTO public.contract_shared_letter_content(tenant_id,letter_id,content_revision,content_hash,snapshot) VALUES(l.tenant_id,l.id,(l.data->>'contentRevision')::integer,hash,snapshot) ON CONFLICT DO NOTHING;
 RETURN hash;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_form_initialize(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_values(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;r public.document_form_response;defaults jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO r FROM public.document_form_response WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id;
 IF r.document_id IS NULL OR r.source_person_id::text IS DISTINCT FROM l.data->>'subjectPersonId' THEN RAISE EXCEPTION 'Initialize the actual Form before continuing' USING ERRCODE='40001';END IF;
 IF r.locked_values IS NOT NULL THEN defaults:=r.locked_values;
 ELSE
  defaults:=coalesce(l.data->'values','{}'::jsonb)||app.contract_shared_form_personnel(p_letter);
  SELECT coalesce(jsonb_object_agg(field->>'id',coalesce(defaults->>coalesce(nullif(field->>'pmKey',''),field->>'id'),'')),'{}'::jsonb) INTO defaults FROM jsonb_array_elements(l.data->'definition'->'fields') field;
 END IF;
 RETURN defaults||r.answers;
END $$;
CREATE FUNCTION app.contract_shared_form_hash(p_letter uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('letterId',l.id,'revision',r.revision,'values',app.contract_shared_form_values(l.id))::text,'UTF8')),'hex') FROM public.contract_shared_letter l JOIN public.document_form_response r ON r.tenant_id=l.tenant_id AND r.document_id=l.signing_document_id WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter
$$;
REVOKE ALL ON FUNCTION app.contract_shared_form_values(uuid),app.contract_shared_form_hash(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_scope(p_letter uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;document jsonb;person uuid;
BEGIN
 IF app.contract_shared_form_body_visible(p_letter) IS NOT TRUE OR app.contract_shared_form_source_current(p_letter) IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.data->>'state'<>'routing' THEN RETURN NULL;END IF;
 SELECT data INTO document FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id;
 person:=app.contract_actor_person(app.current_user_id());
 IF person::text=l.data->>'subjectPersonId' THEN
  IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'role'='employee' AND step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=person::text) THEN RETURN 'employee';END IF;
 ELSE
  IF NOT app.document_signing_locked(document) AND (EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=person::text)
  OR app.document_signing_returned(document) AND app.document_signing_owner(document)=app.current_user_id() AND app.document_signing_owner_step(document)->>'holderPersonId'=person::text) THEN RETURN 'hr';END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_form_scope(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_read(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;r public.document_form_response;values jsonb;scope text;editable jsonb;missing jsonb;receipts jsonb;
BEGIN
 IF app.contract_shared_document_kind(p_letter) IS DISTINCT FROM 'Form' THEN RETURN NULL;END IF;
 IF app.contract_shared_form_body_visible(p_letter) IS NOT TRUE THEN RETURN jsonb_build_object('letterId',p_letter,'kind','Form','visible',false);END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF app.contract_shared_form_source_current(p_letter) IS NOT TRUE AND l.data->>'state'<>'released' THEN RAISE EXCEPTION 'The Form source changed' USING ERRCODE='40001';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id WHERE c.tenant_id=l.tenant_id AND c.id=l.case_id AND e.person_id::text=l.data->>'subjectPersonId') THEN RAISE EXCEPTION 'The Form identity changed' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM public.document_form_response WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id;
 values:=app.contract_shared_form_values(p_letter);scope:=app.contract_shared_form_scope(p_letter);
 SELECT coalesce(jsonb_agg(field->>'id') FILTER(WHERE field->>'owner'=scope),'[]'::jsonb),coalesce(jsonb_agg(field->>'label') FILTER(WHERE field->>'owner'='pmLocked' AND coalesce(values->>(field->>'id'),'')=''),'[]'::jsonb) INTO editable,missing FROM jsonb_array_elements(l.data->'definition'->'fields') field;
 SELECT coalesce(jsonb_agg(data ORDER BY recorded_at,action_id),'[]'::jsonb) INTO receipts FROM public.document_form_action_receipt WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id;
 RETURN jsonb_build_object('letterId',l.id,'kind','Form','visible',true,'responseRevision',r.revision,'responseHash',app.contract_shared_form_hash(l.id),'values',values,'editableFieldIds',editable,'missingLockedFields',missing,'receipts',receipts,'legalBaseHash',encode(sha256(convert_to(app.contract_shared_letter_snapshot(l.id)::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_form_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_form_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_save(p_letter uuid,p_base_revision integer,p_base_hash text,p_revision integer,p_hash text,p_patch jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;r public.document_form_response;scope text;field jsonb;patch record;
BEGIN
 PERFORM app.contract_shared_form_lock(p_letter);
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO r FROM public.document_form_response WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id;
 IF l.data->>'contentRevision' IS DISTINCT FROM p_base_revision::text OR encode(sha256(convert_to(app.contract_shared_letter_snapshot(l.id)::text,'UTF8')),'hex') IS DISTINCT FROM p_base_hash OR r.revision IS DISTINCT FROM p_revision OR app.contract_shared_form_hash(l.id) IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'The Form changed; review it again' USING ERRCODE='40001';END IF;
 scope:=app.contract_shared_form_scope(l.id);
 IF scope IS NULL OR jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR octet_length(p_patch::text)>1048576 THEN RAISE EXCEPTION 'These Form fields are unavailable' USING ERRCODE='42501';END IF;
 FOR patch IN SELECT * FROM jsonb_each(p_patch) LOOP
  SELECT value INTO field FROM jsonb_array_elements(l.data->'definition'->'fields') WHERE value->>'id'=patch.key;
  IF field IS NULL OR field->>'owner' IS DISTINCT FROM scope OR jsonb_typeof(patch.value)<>'string' THEN RAISE EXCEPTION 'This Form field cannot be changed' USING ERRCODE='42501';END IF;
  PERFORM app.document_form_field_validate(field,patch.value#>>'{}');
 END LOOP;
 IF r.answers||p_patch IS DISTINCT FROM r.answers THEN
  UPDATE public.document_form_response SET answers=answers||p_patch,revision=revision+1,updated_at=now() WHERE tenant_id=r.tenant_id AND document_id=r.document_id;
  INSERT INTO public.document_form_response_revision(tenant_id,document_id,revision,answers,actor_user_id,actor_person_id) VALUES(r.tenant_id,r.document_id,r.revision+1,r.answers||p_patch,app.current_user_id(),app.contract_actor_person(app.current_user_id()));
 END IF;
 RETURN app.contract_shared_form_read(l.id);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_form_save(uuid,integer,text,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_form_save(uuid,integer,text,integer,text,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- Only newly initialized Forms use this projection. Earlier legal snapshots remain immutable.
ALTER FUNCTION app.contract_shared_letter_values(uuid) RENAME TO contract_shared_letter_values_before_form_protocol;
CREATE FUNCTION app.contract_shared_letter_values(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;values jsonb;referenced text[];
BEGIN
 values:=app.contract_shared_letter_values_before_form_protocol(p_letter);
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.data->>'formProtocol' IS DISTINCT FROM '1' THEN RETURN values;END IF;
 IF l.data->'valuesFixed'='true'::jsonb OR app.contract_shared_form_source_current(l.id) IS NOT TRUE THEN RETURN values;END IF;
 values:=values||app.contract_shared_form_personnel(l.id);
 SELECT coalesce(array_agg(DISTINCT key),'{}'::text[]) INTO referenced FROM(
  SELECT field->>'pmKey' AS key FROM jsonb_array_elements(l.data->'definition'->'fields') field WHERE nullif(field->>'pmKey','') IS NOT NULL
  UNION ALL SELECT match[1] FROM jsonb_array_elements(l.data->'definition'->'blocks') block CROSS JOIN LATERAL regexp_matches(coalesce(l.data->'blocks'->>(block->>'id'),block->>'text','')||' '||coalesce(block->>'rows','')||' '||coalesce(block->>'label',''),'\{([a-zA-Z][a-zA-Z0-9_.]*)\}','g') match
 ) refs;
 RETURN coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(values) WHERE key=ANY(referenced) OR starts_with(key,'signingStep.')),'{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_values_before_form_protocol(uuid),app.contract_shared_letter_values(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.contract_shared_letter_read(uuid) RENAME TO contract_shared_letter_read_before_form_protocol;
CREATE FUNCTION app.contract_shared_letter_read(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=app.contract_shared_letter_read_before_form_protocol(p_letter);
 IF app.contract_shared_document_kind(p_letter)='Form' AND app.contract_shared_form_body_visible(p_letter) IS NOT TRUE THEN result:=result||jsonb_build_object('body',NULL,'contentHash',NULL,'canEdit',false,'canResend',false,'pendingAction',NULL);END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_letter_read_before_form_protocol(uuid),app.contract_shared_letter_read(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.contract_shared_letter_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_action_prepare(p_letter uuid,p_action_id text,p_step text,p_action text,p_base_revision integer,p_base_hash text,p_revision integer,p_hash text,p_signature jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;r public.document_form_response;document jsonb;scope text;values jsonb;field jsonb;value text;scope_ids jsonb;scope_values jsonb;intent public.document_form_action_intent;validate_all boolean;
BEGIN
 IF app.contract_shared_document_kind(p_letter) IS DISTINCT FROM 'Form' THEN RETURN NULL;END IF;
 PERFORM app.contract_shared_form_lock(p_letter);
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO r FROM public.document_form_response WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id;
 SELECT data INTO document FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id;
 IF p_action NOT IN('signed','reviewed','approved') THEN RETURN NULL;END IF;
 SELECT * INTO intent FROM public.document_form_action_intent WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id AND action_id=p_action_id;
 IF intent.action_id IS NOT NULL THEN
  IF intent.actor_user_id=app.current_user_id() AND intent.actor_person_id=app.contract_actor_person(app.current_user_id()) AND intent.base_revision=p_base_revision AND intent.base_hash=p_base_hash AND intent.response_revision=p_revision AND intent.response_hash=p_hash AND intent.step_id=p_step AND intent.action_kind=p_action AND intent.signature_hash=encode(sha256(convert_to(coalesce(p_signature,'null'::jsonb)::text,'UTF8')),'hex') AND EXISTS(SELECT 1 FROM jsonb_array_elements(document->'actions') receipt WHERE receipt->>'id'=p_action_id AND receipt->>'actorId'=app.current_user_id()::text AND receipt->>'actorPersonId'=app.contract_actor_person(app.current_user_id())::text AND receipt->>'contentHash'=intent.base_hash AND receipt->>'contentRevision'=intent.base_revision::text AND receipt->>'stepId'=intent.step_id AND receipt->>'action'=intent.action_kind) THEN RETURN jsonb_build_object('responseRevision',intent.response_revision,'responseHash',intent.response_hash);END IF;
  RAISE EXCEPTION 'Form action reference was already used' USING ERRCODE='40001';
 END IF;
 IF app.contract_shared_form_source_current(l.id) IS NOT TRUE OR app.contract_shared_signing_access('contract',l.id,'sign') IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'id'=p_step AND step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text) THEN RAISE EXCEPTION 'Only the pending Form actor can complete this step' USING ERRCODE='42501';END IF;
 IF l.data->>'contentRevision' IS DISTINCT FROM p_base_revision::text OR encode(sha256(convert_to(app.contract_shared_letter_snapshot(l.id)::text,'UTF8')),'hex') IS DISTINCT FROM p_base_hash OR r.revision IS DISTINCT FROM p_revision OR app.contract_shared_form_hash(l.id) IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'The Form changed; review its current answers' USING ERRCODE='40001';END IF;
 scope:=CASE WHEN app.contract_actor_person(app.current_user_id())=r.source_person_id THEN 'employee' ELSE 'hr' END;values:=app.contract_shared_form_values(l.id);
 validate_all:=scope='employee' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(document->'route'->'steps') step WHERE step->>'required'='true' AND step->>'id'<>p_step AND NOT app.document_signing_step_fulfilled(document,step));
 FOR field IN SELECT * FROM jsonb_array_elements(l.data->'definition'->'fields') LOOP
  IF NOT validate_all AND field->>'owner'='employee' THEN CONTINUE;END IF;
  IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb AND values->>(field->'when'->>'field') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;
  value:=coalesce(values->>(field->>'id'),'');PERFORM app.document_form_field_validate(field,value);
  IF field->'required'='true'::jsonb AND (btrim(value)='' OR field->>'type'='checkbox' AND value<>'true' OR field->>'type'='table' AND value='[]') OR field->>'owner'='pmLocked' AND value='' THEN RAISE EXCEPTION 'Complete % before signing; Personnel-locked fields require source correction',field->>'label' USING ERRCODE='22023';END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(field->>'id'),'[]'::jsonb),coalesce(jsonb_object_agg(field->>'id',values->(field->>'id')),'{}'::jsonb) INTO scope_ids,scope_values FROM jsonb_array_elements(l.data->'definition'->'fields') field WHERE scope='employee' AND field->>'owner'='employee' OR scope='hr' AND field->>'owner'<>'employee';
 INSERT INTO public.document_form_action_intent(tenant_id,document_id,action_id,step_id,actor_user_id,actor_person_id,action_kind,base_revision,base_hash,response_revision,response_hash,signature_hash,scope,field_ids,values_snapshot) VALUES(l.tenant_id,l.signing_document_id,p_action_id,p_step,app.current_user_id(),app.contract_actor_person(app.current_user_id()),p_action,p_base_revision,p_base_hash,r.revision,p_hash,encode(sha256(convert_to(coalesce(p_signature,'null'::jsonb)::text,'UTF8')),'hex'),scope,scope_ids,scope_values);
 RETURN jsonb_build_object('responseRevision',r.revision,'responseHash',p_hash);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_form_action_prepare(uuid,text,text,text,integer,text,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_form_action_prepare(uuid,text,text,text,integer,text,integer,text,jsonb) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.document_signing_subject_action_allowed(text,uuid,jsonb) RENAME TO document_signing_subject_action_allowed_before_forms;
CREATE FUNCTION app.document_signing_subject_action_allowed(p_type text,p_subject uuid,p_action jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;intent public.document_form_action_intent;
BEGIN
 IF app.document_signing_subject_action_allowed_before_forms(p_type,p_subject,p_action) IS NOT TRUE THEN RETURN false;END IF;
 IF p_type<>'contract' OR app.contract_shared_document_kind(p_subject) IS DISTINCT FROM 'Form' OR p_action->>'action' NOT IN('signed','reviewed','approved') THEN RETURN true;END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_subject;
 SELECT * INTO intent FROM public.document_form_action_intent WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id AND action_id=p_action->>'id';
 RETURN intent.actor_user_id=app.current_user_id() AND intent.actor_person_id=app.contract_actor_person(app.current_user_id()) AND intent.step_id=p_action->>'stepId' AND intent.action_kind=p_action->>'action' AND intent.base_revision::text=p_action->>'contentRevision' AND intent.base_hash=p_action->>'contentHash' AND intent.signature_hash=encode(sha256(convert_to(coalesce(p_action->'signature','null'::jsonb)::text,'UTF8')),'hex')
 AND intent.response_revision=(SELECT revision FROM public.document_form_response WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id) AND intent.response_hash=app.contract_shared_form_hash(l.id);
END $$;
REVOKE ALL ON FUNCTION app.document_signing_subject_action_allowed_before_forms(text,uuid,jsonb),app.document_signing_subject_action_allowed(text,uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_receipt_progress() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;intent public.document_form_action_intent;action jsonb;evidence jsonb;values jsonb;
BEGIN
 IF NEW.subject_type<>'contract' OR jsonb_array_length(NEW.data->'actions')=jsonb_array_length(OLD.data->'actions') OR app.contract_shared_document_kind(NEW.subject_id) IS DISTINCT FROM 'Form' THEN RETURN NEW;END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=NEW.tenant_id AND id=NEW.subject_id;
 action:=NEW.data->'actions'->-1;
 IF action->>'action'='returned' THEN UPDATE public.document_form_response SET locked_values=NULL WHERE tenant_id=NEW.tenant_id AND document_id=NEW.id;RETURN NEW;END IF;
 SELECT * INTO intent FROM public.document_form_action_intent WHERE tenant_id=NEW.tenant_id AND document_id=NEW.id AND action_id=action->>'id';
 IF action->>'action' IN('signed','reviewed','approved') THEN
  IF intent.action_id IS NULL OR intent.actor_user_id::text IS DISTINCT FROM action->>'actorId' OR intent.actor_person_id::text IS DISTINCT FROM action->>'actorPersonId' THEN RAISE EXCEPTION 'Exact Form action evidence required' USING ERRCODE='42501';END IF;
  INSERT INTO public.document_form_action_receipt(tenant_id,document_id,action_id,data) VALUES(NEW.tenant_id,NEW.id,intent.action_id,jsonb_build_object('actionId',intent.action_id,'actorUserId',intent.actor_user_id,'actorPersonId',intent.actor_person_id,'legalBaseHash',intent.base_hash,'responseRevision',intent.response_revision,'responseHash',intent.response_hash,'scope',intent.scope,'fieldIds',intent.field_ids,'values',intent.values_snapshot));
 END IF;
 IF action->>'action'='signed' OR NOT app.document_signing_returned(NEW.data) AND NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(NEW.data)) THEN
  values:=app.contract_shared_form_values(l.id);
  UPDATE public.document_form_response SET locked_values=coalesce(locked_values,values) WHERE tenant_id=NEW.tenant_id AND document_id=NEW.id;
 END IF;
 IF NOT app.document_signing_returned(NEW.data) AND NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(NEW.data)) THEN
  SELECT jsonb_build_object('protocol',1,'legalBaseHash',NEW.data->>'contentHash','responseRevision',r.revision,'responseHash',app.contract_shared_form_hash(l.id),'values',app.contract_shared_form_values(l.id),'receipts',(SELECT coalesce(jsonb_agg(data ORDER BY recorded_at,action_id),'[]'::jsonb) FROM public.document_form_action_receipt WHERE tenant_id=NEW.tenant_id AND document_id=NEW.id)) INTO evidence FROM public.document_form_response r WHERE r.tenant_id=NEW.tenant_id AND r.document_id=NEW.id;
  INSERT INTO public.document_form_release(tenant_id,document_id,fingerprint,data) VALUES(NEW.tenant_id,NEW.id,encode(sha256(convert_to(jsonb_build_object('legal',app.contract_shared_letter_snapshot(l.id),'form',evidence,'actions',NEW.data->'actions')::text,'UTF8')),'hex'),evidence);
  UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{formReleaseEvidence}',evidence) WHERE tenant_id=NEW.tenant_id AND id=l.id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_form_receipt_progress() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_form_response_receipt BEFORE UPDATE OF data ON public.document_signing_document FOR EACH ROW EXECUTE FUNCTION app.contract_shared_form_receipt_progress();
