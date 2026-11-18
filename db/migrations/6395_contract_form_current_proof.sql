CREATE FUNCTION app.contract_shared_form_reference_key(p_token text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$ SELECT CASE lower(btrim(p_token)) WHEN 'agreed basic salary' THEN 'contract.salary' WHEN 'basic salary' THEN 'contract.salary' WHEN 'business group' THEN 'org.businessGroup' WHEN 'case.link' THEN 'case.link' WHEN 'company' THEN 'org.company' WHEN 'contract end date' THEN 'contract.end' WHEN 'contract number' THEN 'contract.number' WHEN 'contract start date' THEN 'contract.start' WHEN 'contract.end' THEN 'contract.end' WHEN 'contract.lastday' THEN 'contract.end' WHEN 'contract.newend' THEN 'contract.newEnd' WHEN 'contract.newstart' THEN 'contract.newStart' WHEN 'contract.number' THEN 'contract.number' WHEN 'contract.reason' THEN 'contract.reason' WHEN 'contract.salary' THEN 'contract.salary' WHEN 'contract.start' THEN 'contract.start' WHEN 'contract.term' THEN 'contract.term' WHEN 'current contract end' THEN 'contract.end' WHEN 'current contract start' THEN 'contract.start' WHEN 'decision notes' THEN 'contract.reason' WHEN 'decision reason' THEN 'contract.reason' WHEN 'department' THEN 'org.department' WHEN 'direct superior' THEN 'people.lineManager' WHEN 'document name' THEN 'letter.documentName' WHEN 'employee id' THEN 'employee.id' WHEN 'employee name' THEN 'employee.name' WHEN 'employee number' THEN 'employee.id' WHEN 'employee.bg' THEN 'org.businessGroup' WHEN 'employee.company' THEN 'org.company' WHEN 'employee.dept' THEN 'org.department' WHEN 'employee.id' THEN 'employee.id' WHEN 'employee.jobtitle' THEN 'employee.jobTitle' WHEN 'employee.name' THEN 'employee.name' WHEN 'employee.no' THEN 'employee.id' WHEN 'employee.position' THEN 'employee.jobTitle' WHEN 'employee.supervisor' THEN 'people.lineManager' WHEN 'full name' THEN 'employee.name' WHEN 'job title' THEN 'employee.jobTitle' WHEN 'letter.documentname' THEN 'letter.documentName' WHEN 'letter.sentbackby' THEN 'letter.sentBackBy' WHEN 'letter.sentbackreason' THEN 'letter.sentBackReason' WHEN 'letter.signingstep' THEN 'letter.signingStep' WHEN 'link to case' THEN 'case.link' WHEN 'new end date' THEN 'contract.newEnd' WHEN 'new start date' THEN 'contract.newStart' WHEN 'org.businessgroup' THEN 'org.businessGroup' WHEN 'org.company' THEN 'org.company' WHEN 'org.department' THEN 'org.department' WHEN 'people.linemanager' THEN 'people.lineManager' WHEN 'position' THEN 'employee.jobTitle' WHEN 'reason sent back' THEN 'letter.sentBackReason' WHEN 'sent back by' THEN 'letter.sentBackBy' WHEN 'signing step' THEN 'letter.signingStep' WHEN 'term' THEN 'contract.term' WHEN 'today' THEN 'today' WHEN 'today''s date' THEN 'today' WHEN 'today’s date' THEN 'today' ELSE btrim(p_token) END $$;
REVOKE ALL ON FUNCTION app.contract_shared_form_reference_key(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Forward native Form source/receipt hardening. Frozen earlier migration bytes stay unchanged.
CREATE OR REPLACE FUNCTION app.contract_shared_form_personnel(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;subject uuid;country text;profile jsonb;statutory jsonb:='{}'::jsonb;requested text[];stat_keys text[];source_values jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.id IS NULL OR app.contract_shared_document_kind(l.id)<>'Form' THEN RETURN '{}'::jsonb;END IF;
 IF app.contract_shared_form_body_visible(l.id) IS NOT TRUE AND app.contract_shared_effect_held(l.case_id,l.workflow_run_id,l.workflow_step_id,CASE WHEN l.purpose='email' THEN 'sendEmail' ELSE 'generateDocument' END) IS NOT TRUE THEN RAISE EXCEPTION 'This Form is unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT key) FILTER(WHERE nullif(key,'') IS NOT NULL),'{}'::text[]) INTO requested FROM(SELECT app.contract_shared_form_reference_key(field->>'pmKey') AS key FROM jsonb_array_elements(l.data->'definition'->'fields') field UNION ALL SELECT app.contract_shared_form_reference_key(match[1]) FROM jsonb_array_elements(l.data->'definition'->'blocks') block CROSS JOIN LATERAL regexp_matches(coalesce(l.data->'blocks'->>(block->>'id'),block->>'text','')||' '||coalesce(block->>'label',''),'\{([^{}]+)\}','g') match) refs;
 IF l.data->'valuesFixed'='true'::jsonb OR app.contract_shared_delivery_period_current(l.tenant_id,l.case_id) IS NOT TRUE THEN RETURN coalesce((SELECT jsonb_object_agg(key,l.data->'values'->key) FROM unnest(requested) key WHERE l.data->'values' ? key),'{}'::jsonb);END IF;
 SELECT p.id,company.country,jsonb_build_object('name',p.full_name,'email',p.primary_email,'mobile',coalesce(p.phone,''),'homePhone',coalesce(p.home_phone,''),
 'personalEmail',coalesce(p.personal_email,''),'address',coalesce(nullif(p.address,''),concat_ws(', ',p.permanent_address_line1,p.permanent_address_line2,p.permanent_address_line3,p.permanent_postcode,p.permanent_city,p.permanent_state,p.permanent_country)),
 'race',coalesce(p.race,''),'religion',coalesce(p.religion,''),'nationality',coalesce(p.nationality,''),'gender',initcap(coalesce(p.gender::text,'')),'marital',initcap(coalesce(p.marital_status::text,'')),
 'emName',coalesce(ec.full_name,''),'emRel',coalesce(ec.relationship,''),'emPhone',coalesce(ec.mobile_phone,'')) INTO subject,country,profile
 FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id
 JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id JOIN public.company company ON company.tenant_id=e.tenant_id AND company.id=e.company_id
 LEFT JOIN LATERAL(SELECT * FROM public.person_emergency_contact contact WHERE contact.tenant_id=p.tenant_id AND contact.person_id=p.id AND contact.archived_at IS NULL ORDER BY CASE contact.priority WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END,contact.created_at,contact.id LIMIT 1) ec ON true
 WHERE c.tenant_id=l.tenant_id AND c.id=l.case_id AND e.person_id::text=l.data->>'subjectPersonId' AND e.voided_at IS NULL;
 IF subject IS NULL THEN RAISE EXCEPTION 'The Form employee or company changed' USING ERRCODE='40001';END IF;

 SELECT coalesce(array_agg(key),'{}'::text[]) INTO stat_keys FROM(SELECT DISTINCT CASE requested_key WHEN 'employee.icNo' THEN 'icNo' WHEN 'employee.passportNo' THEN 'passportNo' ELSE requested_key END AS key FROM unnest(requested) requested_key) sources WHERE key=ANY(ARRAY['icNo','passportNo','bankName','bankAcc','epfNo','taxNo']);
 IF cardinality(stat_keys)>0 THEN statutory:=app.document_country_merge_values(country,subject,stat_keys);END IF;
 source_values:=coalesce(l.data->'values','{}'::jsonb)||coalesce(app.contract_shared_letter_values_before_form_protocol(l.id),'{}'::jsonb)||profile||statutory||jsonb_build_object('employee.icNo',coalesce(statutory->>'icNo',''),'employee.passportNo',coalesce(statutory->>'passportNo',''));
 RETURN coalesce((SELECT jsonb_object_agg(key,source_values->key) FROM unnest(requested) key WHERE source_values ? key),'{}'::jsonb);
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_initialize(p_letter uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
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
 UPDATE public.contract_shared_letter SET data=jsonb_set(data,'{values}',snapshot->'values') WHERE tenant_id=l.tenant_id AND id=l.id;
 INSERT INTO public.contract_shared_letter_content(tenant_id,letter_id,content_revision,content_hash,snapshot) VALUES(l.tenant_id,l.id,(l.data->>'contentRevision')::integer,hash,snapshot) ON CONFLICT DO NOTHING;
 RETURN hash;
END $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_form_action_proof(p_letter uuid,p_action jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_letter l JOIN public.document_form_response response ON response.tenant_id=l.tenant_id AND response.document_id=l.signing_document_id
 JOIN public.document_form_action_intent intent ON intent.tenant_id=response.tenant_id AND intent.document_id=response.document_id AND intent.action_id=p_action->>'id'
 WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter AND app.contract_shared_form_source_current(l.id) AND app.contract_shared_form_body_visible(l.id)
 AND response.source_person_id::text=l.data->>'subjectPersonId' AND intent.actor_user_id=app.current_user_id() AND intent.actor_person_id=app.contract_actor_person(app.current_user_id())
 AND intent.actor_user_id::text=p_action->>'actorId' AND intent.actor_person_id::text=p_action->>'actorPersonId' AND intent.step_id=p_action->>'stepId' AND intent.action_kind=p_action->>'action'
 AND intent.base_hash=p_action->>'contentHash' AND intent.base_revision::text=p_action->>'contentRevision' AND intent.base_revision::text=l.data->>'contentRevision'
 AND intent.base_hash=encode(sha256(convert_to(app.contract_shared_letter_snapshot(l.id)::text,'UTF8')),'hex')
 AND intent.response_revision=response.revision AND intent.response_hash=app.contract_shared_form_hash(l.id)
 AND intent.signature_hash=encode(sha256(convert_to(coalesce(p_action->'signature','null'::jsonb)::text,'UTF8')),'hex'))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_form_action_proof(uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.document_signing_subject_action_allowed_form_base(p_type text,p_subject uuid,p_action jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result boolean;
BEGIN
 IF p_type='probation' AND to_regprocedure('app.probation_signing_action_allowed(uuid,jsonb)') IS NOT NULL THEN EXECUTE 'SELECT app.probation_signing_action_allowed($1,$2)' INTO result USING p_subject,p_action;
 ELSIF p_type='contract' AND to_regprocedure('app.contract_shared_letter_action_allowed(uuid,jsonb)') IS NOT NULL THEN EXECUTE 'SELECT app.contract_shared_letter_action_allowed($1,$2)' INTO result USING p_subject,p_action;
 ELSIF p_type='contract-approval' AND to_regprocedure('app.contract_shared_approval_action_allowed(uuid,jsonb)') IS NOT NULL THEN EXECUTE 'SELECT app.contract_shared_approval_action_allowed($1,$2)' INTO result USING p_subject,p_action;
 END IF;RETURN result IS TRUE;
END $$;
REVOKE ALL ON FUNCTION app.document_signing_subject_action_allowed_form_base(text,uuid,jsonb) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.document_signing_subject_action_allowed_before_forms(p_type text,p_subject uuid,p_action jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.document_signing_subject_action_allowed_form_base(p_type,p_subject,p_action) IS NOT TRUE THEN RETURN false;END IF;
 IF p_type<>'contract' OR app.contract_shared_document_kind(p_subject) IS DISTINCT FROM 'Form' OR p_action->>'action' NOT IN('signed','reviewed','approved') THEN RETURN true;END IF;
 RETURN app.contract_shared_form_action_proof(p_subject,p_action);
END $$;
CREATE OR REPLACE FUNCTION app.document_signing_subject_action_allowed(p_type text,p_subject uuid,p_action jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.document_signing_subject_action_allowed_before_forms(p_type,p_subject,p_action) $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_receipt_progress() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;intent public.document_form_action_intent;action jsonb;evidence jsonb;values jsonb;
BEGIN
 IF NEW.subject_type<>'contract' OR jsonb_array_length(NEW.data->'actions')=jsonb_array_length(OLD.data->'actions') OR app.contract_shared_document_kind(NEW.subject_id) IS DISTINCT FROM 'Form' THEN RETURN NEW;END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=NEW.tenant_id AND id=NEW.subject_id;
 action:=NEW.data->'actions'->-1;
 IF action->>'action'='returned' THEN UPDATE public.document_form_response SET locked_values=NULL WHERE tenant_id=NEW.tenant_id AND document_id=NEW.id;RETURN NEW;END IF;
 SELECT * INTO intent FROM public.document_form_action_intent WHERE tenant_id=NEW.tenant_id AND document_id=NEW.id AND action_id=action->>'id';
 IF action->>'action' IN('signed','reviewed','approved') THEN
  IF app.contract_shared_form_action_proof(l.id,action) IS NOT TRUE THEN RAISE EXCEPTION 'Exact current Form content, answer and signature proof required' USING ERRCODE='42501';END IF;
  IF intent.action_id IS NULL OR intent.actor_user_id::text IS DISTINCT FROM action->>'actorId' OR intent.actor_person_id::text IS DISTINCT FROM action->>'actorPersonId' THEN RAISE EXCEPTION 'Exact Form action evidence required' USING ERRCODE='42501';END IF;
  INSERT INTO public.document_form_action_receipt(tenant_id,document_id,action_id,data) VALUES(NEW.tenant_id,NEW.id,intent.action_id,jsonb_build_object('actionId',intent.action_id,'actorName',action->>'actorName','at',action->>'at','actorUserId',intent.actor_user_id,'actorPersonId',intent.actor_person_id,'legalBaseHash',intent.base_hash,'responseRevision',intent.response_revision,'responseHash',intent.response_hash,'scope',intent.scope,'fieldIds',intent.field_ids,'values',intent.values_snapshot));
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

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_read(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;r public.document_form_response;values jsonb;scope text;editable jsonb;missing jsonb;receipts jsonb;
BEGIN
 IF app.contract_shared_document_kind(p_letter) IS DISTINCT FROM 'Form' THEN RETURN NULL;END IF;
 IF app.contract_shared_form_body_visible(p_letter) IS NOT TRUE THEN RETURN jsonb_build_object('letterId',p_letter,'kind','Form','visible',false);END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF app.contract_shared_form_source_current(p_letter) IS NOT TRUE AND l.data->>'state'<>'released' THEN RAISE EXCEPTION 'The Form source changed' USING ERRCODE='40001';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id WHERE c.tenant_id=l.tenant_id AND c.id=l.case_id AND e.person_id::text=l.data->>'subjectPersonId') THEN RAISE EXCEPTION 'The Form identity changed' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM public.document_form_response WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id;
 values:=app.contract_shared_form_values(p_letter);scope:=app.contract_shared_form_scope(p_letter);
 SELECT coalesce(jsonb_agg(field->>'id') FILTER(WHERE field->>'owner'=scope),'[]'::jsonb),coalesce(jsonb_agg(field->>'id') FILTER(WHERE field->>'owner'='pmLocked' AND coalesce(values->>(field->>'id'),'')='' AND (field->'when' IS NULL OR field->'when'='null'::jsonb OR values->>(field->'when'->>'field')=field->'when'->>'value')),'[]'::jsonb) INTO editable,missing FROM jsonb_array_elements(l.data->'definition'->'fields') field;
 SELECT coalesce(jsonb_agg(receipt.data||jsonb_build_object('actorName',action->>'actorName','at',action->>'at') ORDER BY receipt.recorded_at,receipt.action_id),'[]'::jsonb) INTO receipts FROM public.document_form_action_receipt receipt JOIN public.document_signing_document d ON d.tenant_id=receipt.tenant_id AND d.id=receipt.document_id CROSS JOIN LATERAL jsonb_array_elements(d.data->'actions') action WHERE receipt.tenant_id=l.tenant_id AND receipt.document_id=l.signing_document_id AND action->>'id'=receipt.action_id AND action->>'actorId'=receipt.data->>'actorUserId' AND action->>'actorPersonId'=receipt.data->>'actorPersonId';
 RETURN jsonb_build_object('letterId',l.id,'kind','Form','visible',true,'responseRevision',r.revision,'responseHash',app.contract_shared_form_hash(l.id),'values',values,'editableFieldIds',editable,'missingLockedFields',missing,'receipts',receipts,'legalBaseHash',encode(sha256(convert_to(app.contract_shared_letter_snapshot(l.id)::text,'UTF8')),'hex'));
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_values(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;r public.document_form_response;defaults jsonb;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO r FROM public.document_form_response WHERE tenant_id=l.tenant_id AND document_id=l.signing_document_id;
 IF r.document_id IS NULL OR r.source_person_id::text IS DISTINCT FROM l.data->>'subjectPersonId' THEN RAISE EXCEPTION 'Initialize the actual Form before continuing' USING ERRCODE='40001';END IF;
 IF r.locked_values IS NOT NULL THEN defaults:=r.locked_values;
 ELSE
  defaults:=coalesce(l.data->'values','{}'::jsonb)||app.contract_shared_form_personnel(p_letter);
  SELECT coalesce(jsonb_object_agg(field->>'id',coalesce(defaults->>app.contract_shared_form_reference_key(coalesce(nullif(field->>'pmKey',''),field->>'id')),'')),'{}'::jsonb) INTO defaults FROM jsonb_array_elements(l.data->'definition'->'fields') field;
 END IF;
 RETURN defaults||r.answers;
END $$;
CREATE OR REPLACE FUNCTION app.contract_shared_form_hash(p_letter uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('letterId',l.id,'revision',r.revision,'values',app.contract_shared_form_values(l.id))::text,'UTF8')),'hex') FROM public.contract_shared_letter l JOIN public.document_form_response r ON r.tenant_id=l.tenant_id AND r.document_id=l.signing_document_id WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_values_before_shared_letterhead(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;values jsonb;referenced text[];
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 IF l.data->>'formProtocol' IS DISTINCT FROM '1' THEN RETURN app.contract_shared_letter_values_before_form_protocol(p_letter);END IF;
 IF l.data->'valuesFixed'='true'::jsonb OR app.contract_shared_form_source_current(l.id) IS NOT TRUE THEN values:=coalesce(l.data->'values','{}'::jsonb);
 ELSE values:=app.contract_shared_letter_values_before_form_protocol(p_letter)||app.contract_shared_form_personnel(l.id);END IF;
 SELECT coalesce(array_agg(DISTINCT key),'{}'::text[]) INTO referenced FROM(
  SELECT app.contract_shared_form_reference_key(field->>'pmKey') AS key FROM jsonb_array_elements(l.data->'definition'->'fields') field WHERE nullif(field->>'pmKey','') IS NOT NULL
  UNION ALL SELECT app.contract_shared_form_reference_key(match[1]) FROM jsonb_array_elements(l.data->'definition'->'blocks') block CROSS JOIN LATERAL regexp_matches(coalesce(l.data->'blocks'->>(block->>'id'),block->>'text','')||' '||coalesce(block->>'rows','')||' '||coalesce(block->>'label',''),'\{([^{}]+)\}','g') match
 ) refs;
 RETURN coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(values) WHERE key=ANY(referenced) OR starts_with(key,'signingStep.')),'{}'::jsonb);
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_form_action_prepare(p_letter uuid,p_action_id text,p_step text,p_action text,p_base_revision integer,p_base_hash text,p_revision integer,p_hash text,p_signature jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
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
 SELECT coalesce(jsonb_agg(definition_field->>'id'),'[]'::jsonb),coalesce(jsonb_object_agg(definition_field->>'id',values->(definition_field->>'id')),'{}'::jsonb) INTO scope_ids,scope_values FROM jsonb_array_elements(l.data->'definition'->'fields') definition_field WHERE scope='employee' AND definition_field->>'owner'='employee' OR scope='hr' AND definition_field->>'owner'<>'employee';
 INSERT INTO public.document_form_action_intent(tenant_id,document_id,action_id,step_id,actor_user_id,actor_person_id,action_kind,base_revision,base_hash,response_revision,response_hash,signature_hash,scope,field_ids,values_snapshot) VALUES(l.tenant_id,l.signing_document_id,p_action_id,p_step,app.current_user_id(),app.contract_actor_person(app.current_user_id()),p_action,p_base_revision,p_base_hash,r.revision,p_hash,encode(sha256(convert_to(coalesce(p_signature,'null'::jsonb)::text,'UTF8')),'hex'),scope,scope_ids,scope_values);
 RETURN jsonb_build_object('responseRevision',r.revision,'responseHash',p_hash);
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_letter_values(p_letter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;f jsonb;source jsonb;values jsonb;aliases jsonb;amount text;definition text;
BEGIN
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 values:=app.contract_shared_letter_values_before_shared_letterhead(p_letter)||coalesce(l.data->'letterheadSnapshot','{}'::jsonb);
 IF l.data->>'formProtocol'='1' AND app.contract_shared_form_source_current(l.id) IS NOT TRUE THEN RETURN values;END IF;
 IF l.data->'letterheadSnapshot' IS NULL OR l.data->'valuesFixed'='true'::jsonb OR app.contract_shared_decision_current(l.case_id,l.decision_revision) IS NOT TRUE THEN RETURN values;END IF;
 SELECT flow.data,app.contract_source(c.employment_id) INTO f,source FROM public.contract_shared_case flow JOIN public.contract_case c ON c.tenant_id=flow.tenant_id AND c.id=flow.case_id WHERE flow.tenant_id=l.tenant_id AND flow.case_id=l.case_id;
 amount:=source->>'allowanceCents';
 aliases:=jsonb_build_object('decision.type',CASE f->'decision'->>'kind' WHEN 'renew' THEN 'Renew' WHEN 'convert' THEN 'Convert to permanent' WHEN 'end' THEN 'End' ELSE '' END,'decision.reason',coalesce(f->'decision'->>'reason',''),'decision.endReason',coalesce(f->'decision'->>'endReason',''),'decision.declineReason',coalesce(f->'declined'->>'reason',''),'contract.lastDay',coalesce(f->'period'->>'endOn',''),'contract.allowance',CASE WHEN amount ~ '^[0-9]+$' THEN (amount::bigint/100)::text||'.'||lpad((amount::bigint%100)::text,2,'0') ELSE '' END);
 definition:=(l.data->'definition')::text||coalesce(l.data->'blocks','{}'::jsonb)::text;
 RETURN values||coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(aliases) WHERE strpos(definition,'{'||key||'}')>0 OR strpos(definition,'"'||key||'"')>0),'{}'::jsonb);
END $$;
