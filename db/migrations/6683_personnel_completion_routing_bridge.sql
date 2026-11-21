-- The exact protected completion receipt admits a bounded content delta; all other signing custody stays unchanged.
CREATE OR REPLACE FUNCTION app.v9_document_content_hash(d jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to((jsonb_build_object('templateId',d->'templateId','version',d->'version','blocks',d->'blocks','fields',d->'fields','values',d->'values','edits',d->'edits','mergeValues',coalesce(d->'mergeValues','{}'::jsonb))||CASE WHEN jsonb_typeof(d->'personnelSourceReference')='object' THEN jsonb_build_object('personnelSourceReference',d->'personnelSourceReference') ELSE '{}'::jsonb END||CASE WHEN jsonb_typeof(d->'personnelCompletion')='object' THEN jsonb_build_object('personnelCompletion',d->'personnelCompletion') ELSE '{}'::jsonb END)::text,'UTF8')),'hex')
$$;
--> statement-breakpoint
-- The trigger invokes private kernel validators as its owner; caller authority remains the session actor.
-- A SECURITY DEFINER source writer cannot impersonate a true owner session.
CREATE OR REPLACE FUNCTION app.v9_document_route_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_docs jsonb;new_docs jsonb;d jsonb;prior jsonb;definition jsonb;version jsonb;cfg jsonb;native_cfg jsonb;c lc_onboarding_case;facts jsonb;company uuid;subject_person uuid;admin boolean;step jsonb;spec jsonb;who jsonb;group_row jsonb;routing jsonb;candidate_row jsonb;selected_group text;possible text[];holder text;employee_user text;supervisor_user text;signature jsonb;body_changed boolean;content_edit boolean;source_case uuid;source_employment uuid;personnel_source jsonb;field jsonb;source_key text;expected text;completion_custody boolean;target_revision integer;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT (session_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper)) THEN RAISE EXCEPTION 'Document tenant mismatch';END IF;
 IF TG_TABLE_NAME='lc_onboarding_private' THEN
  source_case:=NEW.case_id;
  old_docs:=CASE WHEN TG_OP='INSERT' THEN '[]'::jsonb ELSE coalesce(OLD.data->'lifecycleV9'->'documents','[]'::jsonb) END;new_docs:=coalesce(NEW.data->'lifecycleV9'->'documents','[]'::jsonb);
  SELECT * INTO c FROM lc_onboarding_case WHERE id=NEW.case_id AND tenant_id=NEW.tenant_id;
  target_revision:=c.revision;source_employment:=c.employment_id;company:=c.company_id;facts:=coalesce(c.data->'local','{}'::jsonb)||coalesce(c.data->'source','{}'::jsonb);subject_person:=(c.data->>'personId')::uuid;
  admin:=app.is_admin_for(company) AND (app.onboarding_page_access() OR app.onboarding_v9_case_actor() OR app.is_group_admin());
 ELSE
  source_case:=NEW.id;target_revision:=NEW.revision;source_employment:=NEW.employment_id;
  old_docs:=CASE WHEN TG_OP='INSERT' THEN '[]'::jsonb ELSE coalesce(OLD.data->'documents','[]'::jsonb) END;new_docs:=coalesce(NEW.data->'documents','[]'::jsonb);company:=NEW.company_id;facts:=NEW.data->'facts';subject_person:=(facts->>'personId')::uuid;admin:=app.lc_v9_off_access(company);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(old_docs||new_docs) candidate WHERE jsonb_typeof(candidate->'signing')='object') THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='lc_onboarding_private' THEN
  IF NEW.data->'lifecycleV9Subject'->>'personId' IS DISTINCT FROM c.data->>'personId' OR NEW.data->'lifecycleV9Subject'->>'employmentId' IS DISTINCT FROM c.employment_id::text THEN RAISE EXCEPTION 'Frozen document subject mismatch';END IF;
 ELSE
  IF facts->>'company' IS DISTINCT FROM company::text OR facts->>'employmentId' IS DISTINCT FROM NEW.employment_id::text OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND e.person_id=subject_person AND e.company_id=company) THEN RAISE EXCEPTION 'Frozen document subject mismatch';END IF;
 END IF;
 SELECT data INTO cfg FROM lc_v9_config WHERE tenant_id=NEW.tenant_id;
 SELECT data INTO native_cfg FROM lc_onboarding_config WHERE tenant_id=NEW.tenant_id;
 FOR prior IN SELECT value FROM jsonb_array_elements(old_docs) WHERE jsonb_typeof(value->'signing')='object' LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(new_docs) n WHERE n->>'id'=prior->>'id') AND (jsonb_array_length(prior->'signing'->'actions')>0 OR prior->>'sentAt' IS NOT NULL OR NOT admin) THEN RAISE EXCEPTION 'Routed document history cannot be removed';END IF;
 END LOOP;
 FOR d IN SELECT value FROM jsonb_array_elements(new_docs) LOOP
  SELECT value INTO prior FROM jsonb_array_elements(old_docs) WHERE value->>'id'=d->>'id';
  IF jsonb_typeof(d->'signing') IS DISTINCT FROM 'object' THEN
   IF jsonb_typeof(prior->'signing')='object' THEN RAISE EXCEPTION 'A saved document keeps its signing route';END IF;CONTINUE;
  END IF;
  signature:=d->'signing';
  IF signature->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text OR signature->>'companyId' IS DISTINCT FROM company::text OR signature->>'subjectId' IS DISTINCT FROM d->>'id' OR signature->>'subjectType' IS DISTINCT FROM 'lifecycle_v9'
   OR signature->>'contentHash' IS DISTINCT FROM app.v9_document_content_hash(d) OR d->'hrSignature' IS DISTINCT FROM 'null'::jsonb OR d->'employeeSignature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Routed signing source mismatch';END IF;
  -- Preserve a byte-identical frozen route when a former holder later becomes unavailable.
  -- Tenant/case/subject checks above and removed-document history checks still apply.
  IF d IS NOT DISTINCT FROM prior THEN CONTINUE;END IF;
  PERFORM app.document_signing_validate(signature,'{"requiredRoles":[]}'::jsonb);
  IF coalesce(d->'stepSignatures','{}'::jsonb) IS DISTINCT FROM app.v9_document_route_signatures(d) OR (d->>'status'='signed') IS DISTINCT FROM app.v9_document_route_complete(d) AND d->>'status' NOT IN('withdrawn','superseded') THEN RAISE EXCEPTION 'Routed signature/status projection mismatch';END IF;
  IF jsonb_typeof(prior->'signing')='object' THEN
   IF d->'personnelSourceReference' IS DISTINCT FROM prior->'personnelSourceReference' OR d->'routing' IS DISTINCT FROM prior->'routing' OR signature-ARRAY['contentRevision','contentHash','actions'] IS DISTINCT FROM (prior->'signing')-ARRAY['contentRevision','contentHash','actions'] THEN RAISE EXCEPTION 'Generated routes are frozen';END IF;
   body_changed:=app.v9_document_content_hash(prior) IS DISTINCT FROM app.v9_document_content_hash(d);
   IF body_changed THEN
    completion_custody:=app.personnel_completion_custody(prior,d,source_case,target_revision);
    IF d->'fields' IS DISTINCT FROM prior->'fields' OR d->'blocks' IS DISTINCT FROM prior->'blocks' OR d->'mergeValues' IS DISTINCT FROM prior->'mergeValues' AND NOT completion_custody OR d->>'templateId' IS DISTINCT FROM prior->>'templateId' OR d->'version' IS DISTINCT FROM prior->'version' THEN RAISE EXCEPTION 'Frozen source fields and document structure cannot be replaced';END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(prior->'fields') configured_field WHERE configured_field->>'owner'='pmLocked' AND d->'values'->(configured_field->>'id') IS DISTINCT FROM prior->'values'->(configured_field->>'id')) AND NOT completion_custody THEN RAISE EXCEPTION 'Personnel source fields are locked';END IF;
    content_edit:=completion_custody OR app.document_signing_can_edit(prior->'signing',app.current_user_id());
    IF NOT content_edit AND NOT app.document_signing_locked(prior->'signing')
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(prior->'signing'->'route'->'steps') st WHERE st->>'role'='employee' AND st->>'holderId'=app.current_user_id()::text)
     AND d-ARRAY['values','signing','stepSignatures','status'] IS NOT DISTINCT FROM prior-ARRAY['values','signing','stepSignatures','status'] THEN
     content_edit:=NOT EXISTS(SELECT 1 FROM jsonb_each(coalesce(d->'values','{}'::jsonb)||coalesce(prior->'values','{}'::jsonb)) v WHERE d->'values'->v.key IS DISTINCT FROM prior->'values'->v.key AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'id'=v.key AND f->>'owner'='employee'));
    END IF;
    IF NOT content_edit OR (signature->>'contentRevision')::integer<>(prior->'signing'->>'contentRevision')::integer+1 OR signature->'actions' IS DISTINCT FROM prior->'signing'->'actions' THEN RAISE EXCEPTION 'Only the current reviewer/owner can revise unsigned content';END IF;
   ELSIF signature->'contentRevision' IS DISTINCT FROM prior->'signing'->'contentRevision' OR signature->>'contentHash' IS DISTINCT FROM prior->'signing'->>'contentHash' THEN RAISE EXCEPTION 'Signing content revision mismatch';END IF;
   IF signature->'actions' IS DISTINCT FROM prior->'signing'->'actions' THEN PERFORM app.v9_document_route_validate_append(prior->'signing',signature,d);END IF;
   CONTINUE;
  END IF;
  IF NOT (admin AND app.v9_signing_current_actor() OR app.current_user_id() IS NULL AND (session_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper))) OR signature->'actions' IS DISTINCT FROM '[]'::jsonb OR signature->>'contentRevision' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'A scoped document preparer must initialize signing';END IF;
  SELECT value INTO definition FROM jsonb_array_elements(cfg->'templates') WHERE value->>'id'=d->>'templateId';
  SELECT value INTO version FROM jsonb_array_elements(definition->'versions') WHERE value->'version'=d->'version' AND value->>'state'='published';
  IF d->'blocks' IS DISTINCT FROM version->'blocks' OR d->'fields' IS DISTINCT FROM version->'fields' OR d->>'templateType' IS DISTINCT FROM definition->>'type' OR d->'edits' IS DISTINCT FROM '{}'::jsonb OR signature->'route'->'version' IS DISTINCT FROM '1'::jsonb OR version IS NULL OR d->'routing' IS DISTINCT FROM version->'routing' OR jsonb_array_length(d->'routing')<>jsonb_array_length(signature->'route'->'steps') OR signature->'routing'->>'templateId' IS DISTINCT FROM d->>'templateId' OR signature->'routing'->'templateVersion' IS DISTINCT FROM d->'version' THEN RAISE EXCEPTION 'Signing route must come from the published saved version';END IF;
  IF personnel_source IS NULL THEN personnel_source:=app.v9_document_personnel_values(source_case);END IF;
  IF personnel_source IS NULL OR personnel_source->>'_companyId' IS DISTINCT FROM company::text OR personnel_source->>'_employmentId' IS DISTINCT FROM source_employment::text OR personnel_source->>'_personId' IS DISTINCT FROM subject_person::text THEN RAISE EXCEPTION 'The authoritative Personnel subject changed';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(coalesce(d->'mergeValues','{}'::jsonb)) used(key) WHERE used.key IN('employee.department','employee.position','employee.supervisor','case.dept','case.position','case.supervisor','case.group','employee.businessUnit')) THEN
   IF personnel_source->>'_sourceBasis'='unresolved-exit' OR d->'personnelSourceReference' IS DISTINCT FROM app.v9_document_personnel_reference(personnel_source) THEN RAISE EXCEPTION 'The dated Personnel source requires review';END IF;
  ELSIF d ? 'personnelSourceReference' THEN RAISE EXCEPTION 'Unused Personnel source evidence is not permitted';END IF;
  IF personnel_source->>'_identityFieldsWithheld'='true' AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') configured WHERE configured->>'pmKey' IN('personalEmail','employee.icNo','employee.passportNo','icNo','passportNo','case.icNo','case.passportNo')) THEN RAISE EXCEPTION 'Permission to view protected Personnel identity fields is required';END IF;
  FOR source_key IN SELECT jsonb_object_keys(coalesce(d->'mergeValues','{}'::jsonb)) LOOP
   IF personnel_source->>'_identityFieldsWithheld'='true' AND source_key IN('personalEmail','employee.icNo','employee.passportNo','icNo','passportNo','case.icNo','case.passportNo') THEN RAISE EXCEPTION 'Permission to view protected Personnel identity fields is required';END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(version->'fields') configured WHERE configured->>'pmKey'=source_key)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(version->'blocks') block CROSS JOIN LATERAL regexp_matches(coalesce(block->>'text','')||' '||coalesce(block->>'rows','')||' '||coalesce(block->>'label',''),'\{([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)?)\}','g') AS token(parts) WHERE parts[1]=source_key)
    AND NOT(source_key IN('company.name','company.regNo','company.address','company.color') AND EXISTS(SELECT 1 FROM jsonb_array_elements(version->'blocks') block WHERE block->>'type'='letterhead')) THEN RAISE EXCEPTION 'Generated documents cannot expose unused source values';END IF;
   IF left(source_key,1)<>'_' AND personnel_source ? source_key AND d->'mergeValues'->source_key IS DISTINCT FROM personnel_source->source_key THEN RAISE EXCEPTION 'Generated Personnel source values must match their canonical owner';END IF;
  END LOOP;
  FOR field IN SELECT value FROM jsonb_array_elements(d->'fields') WHERE value->>'owner'='pmLocked' LOOP
   source_key:=field->>'pmKey';expected:=CASE WHEN left(source_key,1)<>'_' THEN coalesce(personnel_source->>source_key,'') ELSE '' END;
   IF field->>'type'='date' AND expected<>'' THEN expected:=CASE WHEN expected ~ '^\d{2}/\d{2}/\d{4}$' THEN to_char(to_date(expected,'DD/MM/YYYY'),'YYYY-MM-DD') WHEN expected ~ '^\d{4}-\d{2}-\d{2}$' THEN expected ELSE '' END;END IF;
   IF coalesce(d->'values'->>(field->>'id'),'') IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Locked Personnel fields must match their canonical source';END IF;
  END LOOP;
  IF signature->'routing'->>'caseOwnerId' IS DISTINCT FROM coalesce(CASE WHEN TG_TABLE_NAME='lc_onboarding_private' THEN c.data->>'submittedBy' ELSE facts->>'starterUserId' END,app.current_user_id()::text) THEN RAISE EXCEPTION 'Document owner does not match the case owner';END IF;
  SELECT CASE WHEN count(*)=1 THEN min(u.id::text) END INTO employee_user FROM app_user u WHERE u.person_id=subject_person AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
  IF TG_TABLE_NAME='lc_onboarding_private' THEN
   SELECT CASE WHEN count(*)=1 THEN min(u.id::text) END INTO supervisor_user FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id::text=facts->>'supervisor' AND e.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
  ELSE
   SELECT CASE WHEN count(DISTINCT u.id)=1 THEN min(u.id::text) END INTO supervisor_user FROM reporting_line r
   JOIN employment e ON e.id=r.manager_employment_id AND e.tenant_id=r.tenant_id
   JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   WHERE r.tenant_id=NEW.tenant_id AND r.subordinate_employment_id=NEW.employment_id AND r.line_type='administrative' AND r.superseded_at IS NULL
    AND r.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (r.valid_to IS NULL OR r.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
  END IF;
  FOR step IN SELECT value FROM jsonb_array_elements(signature->'route'->'steps') LOOP
   SELECT value INTO spec FROM jsonb_array_elements(d->'routing') WHERE value->>'id'=step->>'id';who:=spec->'who';holder:=step->>'holderId';possible:='{}';selected_group:=NULL;
   IF step ?| ARRAY['coveredStepIds','coveredByStepId','representedId','signature'] OR spec IS NULL OR step->>'kind' IS DISTINCT FROM spec->>'action' OR step->'stage' IS DISTINCT FROM spec->'order' OR step->'required' IS DISTINCT FROM coalesce(spec->'required','true'::jsonb) OR coalesce(step->'owner','false'::jsonb) IS DISTINCT FROM spec->'owner' OR step->>'role' IS DISTINCT FROM (CASE who->>'kind' WHEN 'employee' THEN 'employee' WHEN 'directSuperior' THEN 'lm' WHEN 'group' THEN 'group:'||(who->>'groupId') WHEN 'routing' THEN 'routing:'||(who->>'routingId') ELSE 'people' END) THEN RAISE EXCEPTION 'Frozen step differs from its template';END IF;
   IF who->>'kind'='employee' THEN possible:=ARRAY[employee_user];
   ELSIF who->>'kind'='directSuperior' THEN possible:=ARRAY[supervisor_user];
   ELSIF who->>'kind'='people' THEN SELECT coalesce(array_agg(value),'{}') INTO possible FROM jsonb_array_elements_text(who->'userIds');
   ELSIF who->>'kind'='group' THEN selected_group:=who->>'groupId';
   ELSIF who->>'kind'='routing' AND TG_TABLE_NAME='lc_v9_case' AND NEW.data->>'module'='off' THEN
    SELECT CASE WHEN r.retired THEN NULL ELSE jsonb_build_object('id',r.routing_id,'rows',r.routing_rows) END INTO routing FROM public.automation_routing_version r WHERE r.tenant_id=NEW.tenant_id AND r.routing_id::text=who->>'routingId' ORDER BY r.revision DESC LIMIT 1;
    candidate_row:=app.v9_document_shared_routing_row(routing->'rows',facts||jsonb_build_object('businessGroupCompany',(SELECT coalesce(company_row.parent_company_id,company_row.id)::text FROM public.company company_row WHERE company_row.id=company AND company_row.tenant_id=NEW.tenant_id)));
    IF candidate_row->'assignTo'->>'kind'='group' THEN selected_group:=candidate_row->'assignTo'->>'groupId';ELSE SELECT coalesce(array_agg(value),'{}') INTO possible FROM jsonb_array_elements_text(candidate_row->'assignTo'->'userIds');END IF;
   ELSIF who->>'kind'='routing' THEN
    SELECT value INTO routing FROM jsonb_array_elements(native_cfg->'routings') WHERE value->>'id'=who->>'routingId';
    SELECT r.value INTO candidate_row FROM jsonb_array_elements(routing->'rows') WITH ORDINALITY r(value,n) WHERE app.v9_document_native_rules_match(r.value->'rules',facts)
     ORDER BY (SELECT count(*) FROM jsonb_each(r.value->'rules') e WHERE jsonb_array_length(e.value)>0) DESC,r.n LIMIT 1;
    selected_group:=candidate_row->>'group';
    -- Native default applies only when no active member of the selected group is available today.
    IF holder IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(native_cfg->'groups') g WHERE g->>'id'=selected_group AND g->'members' ? holder) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(native_cfg->'groups') g CROSS JOIN LATERAL jsonb_array_elements_text(g->'members') member
      JOIN app_user u ON u.id::text=member AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
      WHERE g->>'id'=selected_group AND NOT EXISTS(SELECT 1 FROM app.onboarding_unavailable(ARRAY[(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date]) absent WHERE absent.user_id=u.id)) THEN
     SELECT r.value INTO candidate_row FROM jsonb_array_elements(routing->'rows') WITH ORDINALITY r(value,n) WHERE NOT EXISTS(SELECT 1 FROM jsonb_each(r.value->'rules') e WHERE jsonb_array_length(e.value)>0) ORDER BY r.n LIMIT 1;selected_group:=candidate_row->>'group';
    END IF;
   END IF;
   IF selected_group IS NOT NULL THEN SELECT coalesce(array_agg(member),'{}') INTO possible FROM jsonb_array_elements(native_cfg->'groups') g CROSS JOIN LATERAL jsonb_array_elements_text(g->'members') member WHERE g->>'id'=selected_group;END IF;
   IF holder IS NOT NULL AND ((holder=ANY(possible)) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id::text=holder AND u.tenant_id=NEW.tenant_id AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))) THEN RAISE EXCEPTION 'Frozen holder is not a permitted template recipient';END IF;
  END LOOP;
 END LOOP;
 RETURN NEW;
END $$;
