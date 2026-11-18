-- Native Probation owns its subject, Personnel source and private content. No synthetic V9 case is created.
CREATE TABLE probation_letter_completion_custody (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),part_id uuid NOT NULL REFERENCES probation_part(id),
 actor_user_id uuid NOT NULL REFERENCES app_user(id),transaction_id xid8 NOT NULL,part_revision integer NOT NULL,
 before_hash text NOT NULL,after_hash text NOT NULL,operation text NOT NULL CHECK(operation IN('adopt','save','submit','refresh','override')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,part_id) REFERENCES probation_part(tenant_id,id),FOREIGN KEY(tenant_id,actor_user_id) REFERENCES app_user(tenant_id,id)
);
ALTER TABLE probation_letter_completion_custody ENABLE ROW LEVEL SECURITY;
ALTER TABLE probation_letter_completion_custody FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_letter_completion_custody_tenant ON probation_letter_completion_custody USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
CREATE INDEX probation_letter_completion_custody_lookup ON probation_letter_completion_custody(tenant_id,part_id,part_revision,transaction_id);
REVOKE ALL ON probation_letter_completion_custody FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_completion_actor() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',u.id,'name',coalesce(p.full_name,'User')) FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
$$;
CREATE FUNCTION app.probation_letter_completion_lock_person(p_person uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE saved text;wait_ms bigint;key bigint;
BEGIN
 -- Same policy/subject lock order as the canonical Personnel value writer, bounded at its existing five-second ceiling.
 PERFORM app.access_profile_policy_value_lock();
 SELECT setting||coalesce(unit,''),CASE WHEN setting::bigint=0 THEN 5000 ELSE least(setting::bigint,5000) END INTO saved,wait_ms FROM pg_settings WHERE name='lock_timeout';
 PERFORM set_config('lock_timeout',wait_ms::text||'ms',true);key:=hashtextextended('profile-subject:'||app.current_tenant_id()::text||':'||p_person::text,0);
 IF NOT pg_try_advisory_xact_lock(key) THEN PERFORM pg_advisory_xact_lock(key);END IF;
 PERFORM 1 FROM person WHERE id=p_person AND tenant_id=app.current_tenant_id() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'The Personnel subject is unavailable';END IF;
 PERFORM set_config('lock_timeout',saved,true);
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_completion_lock_person(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_letter_completion_source_unchecked(p_case uuid,p_outcome uuid,p_template uuid,p_subject uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;e employment;p person;co company;a assignment;st employee_statutory_my;legacy jsonb;superior text;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id;SELECT * INTO co FROM company WHERE id=c.company_id AND tenant_id=c.tenant_id;
 IF e.id IS NULL OR e.company_id IS DISTINCT FROM c.company_id OR app.probation_case_company_current(c.id) IS NOT TRUE THEN RAISE EXCEPTION 'The current Personnel subject no longer belongs to this case';END IF;
 SELECT * INTO p FROM person WHERE id=e.person_id AND tenant_id=e.tenant_id;
 SELECT * INTO a FROM assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND superseded_at IS NULL AND valid_from<=greatest(day,e.hired_on) AND (valid_to IS NULL OR valid_to>greatest(day,e.hired_on)) ORDER BY valid_from DESC,id LIMIT 1;
 IF co.country='MY' THEN SELECT * INTO st FROM employee_statutory_my WHERE person_id=p.id AND tenant_id=p.tenant_id;END IF;
 SELECT mp.full_name INTO superior FROM reporting_line r JOIN employment me ON me.id=r.manager_employment_id AND me.tenant_id=r.tenant_id JOIN person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
 WHERE r.tenant_id=e.tenant_id AND r.subordinate_employment_id=e.id AND r.line_type='administrative' AND r.superseded_at IS NULL AND r.valid_from<=day AND (r.valid_to IS NULL OR r.valid_to>day) ORDER BY r.valid_from DESC,r.id LIMIT 1;
 legacy:=app.probation_personnel_source_unchecked(e.id)||app.probation_letter_company_values(c.company_id,c.tenant_id)||coalesce(app.probation_letter_values(p_outcome,p_template,p_subject),'{}')||jsonb_build_object('startOn',c.data->>'startOn','endOn',c.data->>'endOn','outcome',(SELECT outcome FROM probation_outcome WHERE id=p_outcome AND tenant_id=c.tenant_id),'extensionMonths',(SELECT app.probation_evaluation_decision(part_id)->>'extensionMonths' FROM probation_outcome WHERE id=p_outcome AND tenant_id=c.tenant_id));
 -- Legacy keys retain the Probation owner and its dated/outcome semantics. The twenty new keys use their actual Personnel owners.
 RETURN legacy||jsonb_build_object('employee.empNo',coalesce(e.employee_code,''),'employee.name',coalesce(p.full_name,''),'employee.icNo',coalesce(st.ic_number,''),'employee.passportNo',coalesce(st.passport_number,''),
  'race',coalesce(p.race,''),'religion',coalesce(p.religion,''),'nationality',coalesce(p.nationality,''),'gender',initcap(coalesce(p.gender,'')),'marital',initcap(coalesce(p.marital_status,'')),
  'mobile',coalesce(p.phone,''),'homePhone',coalesce(p.home_phone,''),'personalEmail',coalesce(p.personal_email,''),'address',coalesce(nullif(p.address,''),concat_ws(', ',nullif(p.permanent_address_line1,''),nullif(p.permanent_address_line2,''),nullif(p.permanent_address_line3,''),nullif(p.permanent_postcode,''),nullif(p.permanent_city,''),nullif(p.permanent_state,''),nullif(p.permanent_country,''))),
  'email',coalesce(p.primary_email,''),'company.name',coalesce(co.legal_name,''),'employee.department',coalesce((SELECT name FROM department WHERE id=a.department_id AND tenant_id=e.tenant_id),''),'employee.position',coalesce((SELECT title FROM position WHERE id=a.position_id AND tenant_id=e.tenant_id),''),'employee.supervisor',coalesce(superior,''),
  'joiner.joinDate',coalesce(e.hired_on::text,''),'leaver.lastDay',coalesce(e.last_working_date::text,''),'_country',co.country);
END $$;
CREATE FUNCTION app.probation_letter_completion_source(p_part uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_letter_completion_source_unchecked(p.case_id,(p.data->>'letterOutcomeId')::uuid,(p.data->>'letterTemplateId')::uuid,p.id) FROM probation_part p WHERE p.id=p_part AND p.tenant_id=app.current_tenant_id()
$$;
CREATE FUNCTION app.probation_letter_completion_document(p_part uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',p.id,'fields',coalesce(p.data->'letterFields','[]'),'blocks',p.data->'letterBlocks','values',coalesce((SELECT jsonb_object_agg(f->>'id',coalesce(p.data->'letterMerge'->>coalesce(f->>'pmKey',f->>'id'),'')) FROM jsonb_array_elements(coalesce(p.data->'letterFields','[]')) f),'{}'),
 'status',CASE WHEN p.data->>'state' IN('locked','cancelled','release_requested') THEN 'completed' ELSE 'draft' END,'sentAt',o.released_at,'employeeSignature',NULL,'hrSignature',NULL,'signing',s.data)
 ||CASE WHEN p.data?'personnelCompletion' THEN jsonb_build_object('personnelCompletion',p.data->'personnelCompletion') ELSE '{}'::jsonb END
 FROM probation_part p LEFT JOIN document_signing_document s ON s.subject_type='probation' AND s.subject_id=p.id AND s.tenant_id=p.tenant_id LEFT JOIN probation_outcome o ON o.id=(p.data->>'letterOutcomeId')::uuid AND o.tenant_id=p.tenant_id
 WHERE p.id=p_part AND p.tenant_id=app.current_tenant_id() AND p.data->>'documentKind'='letter'
$$;
REVOKE ALL ON FUNCTION app.probation_letter_completion_actor(),app.probation_letter_completion_source_unchecked(uuid,uuid,uuid,uuid),app.probation_letter_completion_source(uuid),app.probation_letter_completion_document(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.probation_letter_protected_keys() RENAME TO probation_letter_protected_keys_before_completion_6686;
REVOKE ALL ON FUNCTION app.probation_letter_protected_keys_before_completion_6686() FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_letter_protected_keys() RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT ARRAY(SELECT DISTINCT key FROM unnest(app.probation_letter_protected_keys_before_completion_6686()||ARRAY['employee.empNo','employee.name','employee.icNo','employee.passportNo','race','religion','nationality','gender','marital','mobile','homePhone','personalEmail','address','email','company.name','employee.department','employee.position','employee.supervisor','joiner.joinDate','leaver.lastDay']) key ORDER BY key)
$$;
REVOKE ALL ON FUNCTION app.probation_letter_protected_keys() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.probation_content(uuid) RENAME TO probation_content_before_completion_6686;
REVOKE ALL ON FUNCTION app.probation_content_before_completion_6686(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_content(p_part uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_content_before_completion_6686(p_part)||CASE WHEN p.data?'personnelCompletion' THEN jsonb_build_object('personnelCompletion',p.data->'personnelCompletion') ELSE '{}'::jsonb END FROM probation_part p WHERE p.id=p_part AND p.tenant_id=app.current_tenant_id()
$$;
REVOKE ALL ON FUNCTION app.probation_content(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_native_personnel_keys() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT ARRAY['employee.empNo','employee.name','employee.icNo','employee.passportNo','race','religion','nationality','gender','marital','mobile','homePhone','personalEmail','address','email','company.name','employee.department','employee.position','employee.supervisor','joiner.joinDate','leaver.lastDay']
$$;
CREATE FUNCTION app.probation_letter_completion_requested(p_definition jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app AS $$
 SELECT ARRAY(SELECT key FROM unnest(app.probation_native_personnel_keys()) key WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_definition->'fields','[]')) f WHERE f->>'owner'='pmLocked' AND f->>'pmKey'=key) OR (p_definition->'blocks')::text LIKE '%{'||key||'}%' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_definition->'fields','[]')) custom WHERE custom->>'id'=key AND custom->>'pmKey' IS NULL) ORDER BY key)
$$;
REVOKE ALL ON FUNCTION app.probation_native_personnel_keys(),app.probation_letter_completion_requested(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_completion_identity(p_part uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_storage_runner() OR app.probation_active_user() AND (EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) OR app.personnel_identity_search_permitted(c.company_id))
 FROM probation_part p JOIN probation_case c ON c.id=p.case_id AND c.tenant_id=p.tenant_id WHERE p.id=p_part AND p.tenant_id=app.current_tenant_id()
$$;
REVOKE ALL ON FUNCTION app.probation_letter_completion_identity(uuid) FROM PUBLIC,ai_hr_app;
ALTER FUNCTION app.probation_part_access(uuid,text) RENAME TO probation_part_access_before_completion_6686;
REVOKE ALL ON FUNCTION app.probation_part_access_before_completion_6686(uuid,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_part_access(p_part uuid,p_rater text DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_part_access_before_completion_6686(p_part,p_rater) AND NOT EXISTS(
  SELECT 1 FROM probation_part p
  WHERE p.id=p_part AND p.tenant_id=app.current_tenant_id() AND p.data?'personnelCompletion' AND (app.probation_letter_completion_requested(jsonb_build_object('fields',p.data->'letterFields','blocks',p.data->'letterBlocks'))&&ARRAY['personalEmail','employee.icNo','employee.passportNo']) AND app.probation_letter_completion_identity(p.id) IS NOT TRUE)
$$;
REVOKE ALL ON FUNCTION app.probation_part_access(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_part_access(uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- RLS expressions retain function OIDs across RENAME. Rebind to the guarded public wrapper;
-- the legacy implementation remains private and cannot bypass the identity boundary.
ALTER POLICY probation_part_read ON probation_part USING(tenant_id=app.current_tenant_id() AND app.probation_part_access(id));
ALTER POLICY probation_rater_read ON probation_rater_draft USING(tenant_id=app.current_tenant_id() AND app.probation_part_access(part_id,rater));
ALTER POLICY probation_revision_read ON probation_revision USING(tenant_id=app.current_tenant_id() AND (rater='meta' AND app.probation_part_access(part_id) OR rater<>'meta' AND EXISTS(SELECT 1 FROM probation_part p JOIN probation_case c ON c.id=p.case_id AND c.tenant_id=p.tenant_id WHERE p.id=part_id AND p.tenant_id=probation_revision.tenant_id AND NOT app.probation_case_source_moved(c.id) AND (app.probation_role(c.employment_id,rater) OR app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')))));
ALTER POLICY probation_delegate_read ON probation_delegate USING(tenant_id=app.current_tenant_id() AND app.probation_part_access(part_id));
--> statement-breakpoint
ALTER FUNCTION app.probation_definition_save(uuid,text,text,jsonb,boolean,integer) RENAME TO probation_definition_save_before_completion_6686;
REVOKE ALL ON FUNCTION app.probation_definition_save_before_completion_6686(uuid,text,text,jsonb,boolean,integer) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_definition_save(p_company uuid,p_key text,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_kind='template' AND p_data->>'routingRegistry' IS DISTINCT FROM 'on-off-boarding' AND EXISTS(SELECT 1 FROM unnest(app.probation_letter_completion_requested(p_data)) key WHERE NOT (key=ANY(app.probation_letter_protected_keys_before_completion_6686()))) THEN RAISE EXCEPTION 'The native Personnel registry requires a converted template version';END IF;
 IF p_kind='template' AND p_publish AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'fields','[]')) linked CROSS JOIN LATERAL jsonb_array_elements(coalesce(p_data->'fields','[]')) custom WHERE linked->>'owner'='pmLocked' AND custom->>'owner'<>'pmLocked' AND linked->>'pmKey'=custom->>'id') THEN RAISE EXCEPTION 'Resolve the ambiguous Personnel link and declared field before publishing';END IF;
 RETURN app.probation_definition_save_before_completion_6686(p_company,p_key,p_kind,p_data,p_publish,p_expected);
END $$;
REVOKE ALL ON FUNCTION app.probation_definition_save(uuid,text,text,jsonb,boolean,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_definition_save(uuid,text,text,jsonb,boolean,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_completion_receipt(p_part uuid,p_before jsonb,p_after jsonb,p_revision integer,p_operation text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO probation_letter_completion_custody(tenant_id,part_id,actor_user_id,transaction_id,part_revision,before_hash,after_hash,operation)
 VALUES(app.current_tenant_id(),p_part,app.current_user_id(),pg_current_xact_id(),p_revision,encode(sha256(convert_to(p_before::text,'UTF8')),'hex'),encode(sha256(convert_to(p_after::text,'UTF8')),'hex'),p_operation);
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_completion_receipt(uuid,jsonb,jsonb,integer,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_letter_completion_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_data jsonb;changed boolean;
BEGIN
 before_data:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE OLD.data END;
 IF NOT(NEW.data?'personnelCompletion' OR before_data?'personnelCompletion') THEN RETURN NEW;END IF;
 IF before_data?'personnelCompletion' AND NOT NEW.data?'personnelCompletion' THEN RAISE EXCEPTION 'The completion version cannot be removed';END IF;
 changed:=NEW.content_revision IS DISTINCT FROM OLD.content_revision OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.data->'letterTemplateId' IS DISTINCT FROM before_data->'letterTemplateId' OR NEW.data->'letterTemplateVersion' IS DISTINCT FROM before_data->'letterTemplateVersion' OR NEW.data->'letterSourceStamp' IS DISTINCT FROM before_data->'letterSourceStamp' OR NEW.data->'letterBaseHash' IS DISTINCT FROM before_data->'letterBaseHash' OR NEW.data->'personnelCompletion' IS DISTINCT FROM before_data->'personnelCompletion' OR NEW.data->'letterMerge' IS DISTINCT FROM before_data->'letterMerge' OR NEW.data->'letterFields' IS DISTINCT FROM before_data->'letterFields' OR NEW.data->'letterBlocks' IS DISTINCT FROM before_data->'letterBlocks';
 IF changed AND NOT EXISTS(SELECT 1 FROM probation_letter_completion_custody r WHERE r.tenant_id=NEW.tenant_id AND r.part_id=NEW.id AND r.actor_user_id=app.current_user_id() AND r.transaction_id=pg_current_xact_id() AND r.part_revision=NEW.revision AND r.before_hash=encode(sha256(convert_to(before_data::text,'UTF8')),'hex') AND r.after_hash=encode(sha256(convert_to(NEW.data::text,'UTF8')),'hex')) THEN RAISE EXCEPTION 'A native completion custodian must authorize this exact change' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_completion_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER probation_letter_completion_guard BEFORE INSERT OR UPDATE ON probation_part FOR EACH ROW EXECUTE FUNCTION app.probation_letter_completion_guard();
--> statement-breakpoint

--> statement-breakpoint
ALTER FUNCTION app.probation_letter_preview(uuid,uuid,jsonb,integer) RENAME TO probation_letter_preview_before_completion_6686;
REVOKE ALL ON FUNCTION app.probation_letter_preview_before_completion_6686(uuid,uuid,jsonb,integer) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_letter_preview(p_outcome uuid,p_template uuid,p_edits jsonb,p_expected integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE descriptor jsonb;t probation_builder_definition;c probation_case;source jsonb;requested text[];extra jsonb;
BEGIN
 descriptor:=app.probation_letter_preview_before_completion_6686(p_outcome,p_template,p_edits,p_expected);
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=app.current_tenant_id();
 IF t.data->>'routingRegistry' IS DISTINCT FROM 'on-off-boarding' THEN RETURN descriptor;END IF;
 SELECT c0.* INTO c FROM probation_case c0 JOIN probation_outcome o ON o.case_id=c0.id AND o.tenant_id=c0.tenant_id WHERE o.id=p_outcome AND o.tenant_id=app.current_tenant_id();
 requested:=app.probation_letter_completion_requested(t.data);
 IF requested&&ARRAY['personalEmail','employee.icNo','employee.passportNo'] AND app.personnel_identity_search_permitted(c.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Protected Personnel identity permission is required' USING ERRCODE='42501';END IF;
 source:=app.probation_letter_completion_source_unchecked(c.id,p_outcome,p_template);
 SELECT coalesce(jsonb_object_agg(key,coalesce(source->>key,'')),'{}') INTO extra FROM unnest(requested) key;
 descriptor:=(descriptor-'sourceDigest')||jsonb_build_object('merge',(descriptor->'merge')||extra,'personnelCompletionEligible',true);
 RETURN descriptor||jsonb_build_object('sourceDigest',encode(sha256(convert_to(descriptor::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_preview(uuid,uuid,jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_preview(uuid,uuid,jsonb,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_completion_initialize(p_part uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;t probation_builder_definition;source jsonb;doc jsonb;official jsonb;fields jsonb:='{}';policy jsonb;next_data jsonb;f jsonb;fingerprint text;who jsonb:=app.probation_letter_completion_actor();at text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO t FROM probation_builder_definition WHERE id=(p.data->>'letterTemplateId')::uuid AND tenant_id=p.tenant_id;
 IF t.data->>'routingRegistry' IS DISTINCT FROM 'on-off-boarding' THEN RETURN;END IF;
 IF p.data?'personnelCompletion' OR who IS NULL OR EXISTS(SELECT 1 FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id) OR EXISTS(SELECT 1 FROM probation_outcome WHERE tenant_id=p.tenant_id AND letter_part_id=p.id AND released_at IS NOT NULL) THEN RAISE EXCEPTION 'Completion starts only on a new unsigned native letter';END IF;
 source:=app.probation_letter_completion_source(p.id);doc:=app.probation_letter_completion_document(p.id);
 -- Only the approved twenty-key registry adopts this policy. Retained outcome/signatory/acknowledgement aliases do not.
 doc:=jsonb_set(doc,'{fields}',coalesce((SELECT jsonb_agg(f0) FROM jsonb_array_elements(doc->'fields') f0 WHERE f0->>'pmKey'=ANY(app.probation_native_personnel_keys())),'[]'));
 official:=app.personnel_completion_official(doc,source);fingerprint:=app.personnel_completion_fingerprint(official,source->>'_country');
 FOR f IN SELECT value FROM jsonb_array_elements(doc->'fields') WHERE value->>'owner'='pmLocked' LOOP
  fields:=fields||jsonb_build_object(f->>'id',jsonb_build_object('key',f->'pmKey','group',app.personnel_completion_group(f->>'pmKey'),'sourceValue',official->>(f->>'id'),'sourceFingerprint',fingerprint));
 END LOOP;
 policy:=jsonb_build_object('version',1,'classification','2026-11-18','country',source->>'_country','sourceFingerprint',fingerprint,'adoptedAt',at,'adoptedBy',who,'fields',fields,'history','[]'::jsonb);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'fields') f0 WHERE f0->>'required'='true' AND app.personnel_completion_owner(jsonb_set(doc,'{personnelCompletion}',policy,true),f0)='employee' AND (f0->'when' IS NULL OR f0->'when'='null'::jsonb OR doc->'values'->>(f0->'when'->>'field')=f0->'when'->>'value')) THEN policy:=policy||jsonb_build_object('preparation',jsonb_build_object('at',at,'by',who));END IF;
 next_data:=p.data||jsonb_build_object('personnelCompletion',policy);
 PERFORM app.probation_letter_completion_receipt(p.id,p.data,next_data,p.revision+1,'adopt');
 UPDATE probation_part SET data=next_data,revision=revision+1,content_revision=content_revision+1,updated_at=now() WHERE id=p.id;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision+1,next_data,app.current_user_id(),'Adopt the approved native Personnel completion policy');
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_completion_initialize(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_validate_letter_fields(p_fields jsonb,p_merge jsonb,p_preparing boolean DEFAULT true) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field jsonb;control jsonb;key text;value text;rows jsonb;number numeric;required boolean;
BEGIN
 IF jsonb_typeof(p_fields) IS DISTINCT FROM 'array' OR jsonb_array_length(p_fields)>200 OR (SELECT count(DISTINCT f->>'id') FROM jsonb_array_elements(p_fields) f)<>jsonb_array_length(p_fields) THEN RAISE EXCEPTION 'Use bounded uniquely identified letter fields';END IF;
 FOR field IN SELECT item FROM jsonb_array_elements(p_fields) items(item) LOOP
 IF nullif(field->>'id','') IS NULL OR coalesce(field->>'type','') NOT IN('text','textarea','select','date','checkbox','phone','email','number','table') OR coalesce(field->>'owner','') NOT IN('employee','hr','pmLocked') OR field->>'owner'='pmLocked' AND NOT(coalesce(field->>'pmKey','')=ANY(app.probation_letter_protected_keys())) OR field->>'owner' IN('employee','hr') AND (field->>'pmKey' IS NOT NULL OR field->>'id'=ANY(app.probation_letter_protected_keys_before_completion_6686())) THEN RAISE EXCEPTION 'Use declared HR fields or registered immutable Personnel fields';END IF;
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
CREATE OR REPLACE FUNCTION app.probation_letter_edit_content(p_part uuid,p_expected integer,p_edits jsonb,p_values jsonb,p_reason text) RETURNS jsonb
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
  IF (value#>>'{}') ~ '[{][{]|[}][}]' OR EXISTS(SELECT 1 FROM regexp_matches(value#>>'{}','[{]([^{}]+)[}]','g') token WHERE NOT((token[1])=ANY(app.probation_letter_protected_keys_before_completion_6686())) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(part.data->'letterFields','[]'::jsonb)) declared WHERE declared->>'id'=token[1])) THEN RAISE EXCEPTION 'Use a registered letter merge field';END IF;
  SELECT jsonb_agg(CASE WHEN item->>'id'=key THEN jsonb_set(item,'{text}',value) ELSE item END ORDER BY n) INTO blocks FROM jsonb_array_elements(blocks) WITH ORDINALITY x(item,n);
 END LOOP;
 owner:=CASE WHEN app.probation_role(subject_case.employment_id,'employee') THEN 'employee' ELSE 'hr' END;
 FOR key,value IN SELECT * FROM jsonb_each(p_values) LOOP
  SELECT item INTO field FROM jsonb_array_elements(coalesce(part.data->'letterFields','[]'::jsonb)) item WHERE item->>'id'=key;
  IF field IS NULL OR field->>'owner' IS DISTINCT FROM owner OR field->>'pmKey' IS NOT NULL OR key=ANY(app.probation_letter_protected_keys_before_completion_6686()) OR jsonb_typeof(value) IS DISTINCT FROM 'string' OR length(value#>>'{}')>20000 THEN RAISE EXCEPTION 'This field belongs to another owner or Personnel Management' USING ERRCODE='42501';END IF;
  merged:=jsonb_set(merged,ARRAY[key],value,true);
 END LOOP;
 PERFORM app.probation_validate_letter_fields(coalesce(part.data->'letterFields','[]'::jsonb),merged,false);
 IF blocks IS NOT DISTINCT FROM part.data->'letterBlocks' AND merged IS NOT DISTINCT FROM part.data->'letterMerge' THEN RETURN app.probation_signing_content(part.id)||jsonb_build_object('changed',false,'documentId',signing.id);END IF;
 UPDATE probation_part SET data=data||jsonb_build_object('letterBlocks',blocks,'letterMerge',merged),revision=revision+1,content_revision=content_revision+1,updated_at=now() WHERE id=part.id;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(part.tenant_id,part.id,'meta',part.revision+1,(SELECT data FROM probation_part WHERE id=part.id),app.current_user_id(),p_reason);
 PERFORM app.probation_audit(part.case_id,part.id,'letter_content_edited',p_reason);
 RETURN app.probation_signing_content(part.id)||jsonb_build_object('changed',true,'documentId',signing.id);
END $$;
--> statement-breakpoint
-- Preserve the current native preparation owner, authority and frozen route; only shared-field draft preparation and policy adoption are added.
CREATE OR REPLACE FUNCTION app.probation_prepare_letter(p_outcome uuid,p_template uuid,p_merge jsonb,p_expected integer,p_source_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;p probation_part;source jsonb;merged jsonb;rules jsonb;v_part uuid:=gen_random_uuid();basehash text;descriptor jsonb;old_pointer uuid;routed boolean;placeholder jsonb;holders jsonb;fallback text;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RAISE EXCEPTION 'Recorded outcome unavailable';END IF;old_pointer:=o.letter_part_id;IF old_pointer IS NOT NULL THEN PERFORM 1 FROM probation_part WHERE id=old_pointer AND tenant_id=o.tenant_id FOR UPDATE;END IF;
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF o.letter_part_id IS DISTINCT FROM old_pointer THEN RAISE EXCEPTION 'The letter revision changed; reload before preparing';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;PERFORM app.probation_assert_case_runtime(c.id);
 IF NOT((app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters')) OR app.probation_role(c.employment_id,'gbs')) OR o.revision IS DISTINCT FROM p_expected OR o.released_at IS NOT NULL OR o.state='release_requested' OR o.outcome='other' OR NOT app.probation_review_complete(o.part_id) THEN RAISE EXCEPTION 'Scoped reviewer and current signed recorded outcome required';END IF;
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND state='published' AND app.probation_letter_template_score(o.id,id) IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Use a complete published matching template';END IF;
 IF t.data->>'routingRegistry'='on-off-boarding' THEN PERFORM app.probation_letter_completion_lock_person((SELECT person_id FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id));END IF;PERFORM 1 FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR SHARE;descriptor:=app.probation_letter_preview(o.id,t.id,p_merge,p_expected);IF descriptor->>'sourceDigest' IS DISTINCT FROM p_source_digest THEN RAISE EXCEPTION 'The letter source changed; preview and render it again';END IF;IF t.data->>'routingRegistry'='on-off-boarding' THEN
  -- Adopted native drafts may collect missing shared Personnel values after generation. Other native/legacy fields keep their existing required rules.
  PERFORM app.probation_validate_letter_fields(coalesce((SELECT jsonb_agg(CASE WHEN f->>'pmKey'=ANY(app.probation_native_personnel_keys()) THEN f||jsonb_build_object('required',false) ELSE f END) FROM jsonb_array_elements(descriptor->'fields') f),'[]'),descriptor->'merge',true);
  IF EXISTS(SELECT 1 FROM unnest(app.probation_letter_completion_requested(t.data)) key WHERE btrim(coalesce(descriptor->'merge'->>key,''))='' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(descriptor->'fields') f WHERE f->>'owner'='pmLocked' AND f->>'pmKey'=key)) THEN RAISE EXCEPTION 'Complete missing unbound Personnel merge values before preparation';END IF;
 ELSE PERFORM app.probation_validate_letter_fields(descriptor->'fields',descriptor->'merge',true);END IF;merged:=descriptor->'merge';
 routed:=app.probation_letter_routed(t.data);
 -- 5752: a routed template version freezes its own routing (resolved by the caller, then app.probation_letter_freeze_route);
 -- the legacy role route below applies only to versions without routing, exactly as before.
 IF routed THEN
 IF app.probation_letter_routing_valid(t.data->'routing') IS NOT TRUE THEN RAISE EXCEPTION 'Complete every step of the signing and review routing';END IF;
 rules:=jsonb_build_object('requiredRoles','[]'::jsonb);
 SELECT jsonb_build_object('version',1,'steps',jsonb_agg(jsonb_build_object('id',s->>'id','role','routing','kind',s->>'action','stage',(s->>'order')::integer,'holderId',NULL,'required',true) ORDER BY (s->>'order')::integer,n)) INTO placeholder FROM jsonb_array_elements(t.data->'routing') WITH ORDINALITY x(s,n);
 ELSE
 SELECT jsonb_build_object('requiredRoles',jsonb_agg(DISTINCT s->>'role')) INTO rules FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'required'='true';
 IF rules->'requiredRoles' IS NULL OR jsonb_array_length(rules->'requiredRoles')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'role' NOT IN('pbp','lm','hod','employee') OR s->>'holderId' IS NOT NULL OR s->>'representedId' IS NOT NULL) THEN RAISE EXCEPTION 'Letter routes need current source roles and required signers';END IF;
 PERFORM app.document_signing_validate(jsonb_build_object('route',t.data->'route','actions','[]'::jsonb),rules);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(t.data->'route'->'steps') staff CROSS JOIN jsonb_array_elements(t.data->'route'->'steps') hr WHERE staff->>'role'='employee' AND hr->>'role'<>'employee' AND (staff->>'stage')::integer<=(hr->>'stage')::integer) THEN RAISE EXCEPTION 'HR signing must precede employee acknowledgement';END IF;
 END IF;
 basehash:=descriptor->>'sourceDigest';
 -- A new draft has its own immutable signing subject; previous signed subjects remain readable history.
 INSERT INTO probation_part(id,tenant_id,case_id,data) VALUES(v_part,c.tenant_id,c.id,jsonb_build_object('id',v_part,'documentKind','letter','evaluationPartId',o.part_id,'letterOutcomeId',o.id,'letterTemplateId',t.id,'letterTemplateVersion',t.version,'letterTemplateName',t.data->>'name','letterMerge',merged,'letterBlocks',t.data->'blocks','letterFields',coalesce(t.data->'fields','[]'),'letterBaseHash',basehash,'letterSourceStamp',descriptor->'sourceStamp','letterGuardrails',rules,'route',CASE WHEN routed THEN placeholder ELSE t.data->'route' END,'state','pending_approval','type',0,'cycle',o.revision)||CASE WHEN routed THEN jsonb_build_object('letterRouting',t.data->'routing','letterRoutingPending',true) ELSE '{}'::jsonb END);
 IF o.letter_part_id IS NOT NULL THEN UPDATE probation_part SET data=jsonb_set(data,'{state}','"cancelled"'),revision=revision+1 WHERE id=o.letter_part_id AND tenant_id=o.tenant_id;END IF;
 UPDATE probation_outcome SET template_id=t.id::text,template_version=t.version,merge_data=merged,letter_part_id=v_part,state='awaiting_release',revision=revision+1,updated_at=now() WHERE id=o.id;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(c.tenant_id,v_part,'meta',1,(SELECT data FROM probation_part WHERE id=v_part),app.current_user_id(),'Prepared outcome letter');
 PERFORM app.probation_audit(c.id,v_part,'letter_prepared');
 holders:=app.probation_holders(c.employment_id);
 fallback:=coalesce(nullif(c.data->'config'->>'fallbackGroupId',''),(SELECT v.data->>'peopleOpsGroup' FROM lc_v9_config v WHERE v.tenant_id=c.tenant_id));
 PERFORM app.probation_letter_completion_initialize(v_part);
 RETURN app.probation_signing_content(v_part)||CASE WHEN routed THEN jsonb_build_object('routing',t.data->'routing','templateKey',t.definition_key,'caseOwnerId',holders->>'pbp','fallbackGroupId',fallback) ELSE '{}'::jsonb END||jsonb_build_object('partId',v_part,'outcomeRevision',o.revision+1,'route',app.probation_resolved_route(v_part),'guardrails',rules,'merge',merged,'blocks',t.data->'blocks','fields',coalesce(t.data->'fields','[]'));
END $$;
