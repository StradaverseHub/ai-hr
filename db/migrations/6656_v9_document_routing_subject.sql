-- V9 embeds the shared signing kernel on its existing saved-document owner.
-- No historical template/document is rewritten and a Personnel draft never needs a fake employment.
CREATE FUNCTION app.v9_signing_current_actor() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND EXISTS(
  SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
$$;
CREATE FUNCTION app.v9_document_content_hash(d jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('templateId',d->'templateId','version',d->'version','blocks',d->'blocks','fields',d->'fields','values',d->'values','edits',d->'edits','mergeValues',coalesce(d->'mergeValues','{}'::jsonb))::text,'UTF8')),'hex')
$$;
CREATE FUNCTION app.v9_document_route_complete(d jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_typeof(d->'signing')='object' AND NOT app.document_signing_returned(d->'signing') AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(d->'signing'->'route'->'steps') s WHERE s->>'required'='true' AND NOT app.document_signing_step_fulfilled(d->'signing',s))
$$;
CREATE FUNCTION app.v9_document_route_signatures(d jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.document_signing_returned(d->'signing') THEN '{}'::jsonb ELSE coalesce((SELECT jsonb_object_agg(a->>'stepId',jsonb_build_object('by',jsonb_build_object('id',a->>'actorId','name',a->>'actorName'),'at',a->>'at')||(a->'signature')) FROM app.document_signing_round_actions(d->'signing') a WHERE a->>'action'='signed'),'{}'::jsonb) END
$$;
CREATE FUNCTION app.v9_document_route_participant(d jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.v9_signing_current_actor() AND (app.document_signing_owner(d->'signing')=app.current_user_id()
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'signing'->'route'->'steps') s WHERE s->>'holderId'=app.current_user_id()::text)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'signing'->'actions') a WHERE a->>'actorId'=app.current_user_id()::text))
$$;
CREATE FUNCTION app.v9_document_route_content_visible(d jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.v9_document_route_participant(d) AND (d->>'sentAt' IS NOT NULL OR app.document_signing_owner(d->'signing')=app.current_user_id()
  OR NOT app.document_signing_locked(d->'signing') AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'signing'->'route'->'steps') employee WHERE employee->>'role'='employee' AND employee->>'holderId'=app.current_user_id()::text)
  OR EXISTS(SELECT 1 FROM app.document_signing_pending_steps(d->'signing') s WHERE s->>'holderId'=app.current_user_id()::text)
  OR EXISTS(SELECT 1 FROM app.document_signing_round_actions(d->'signing') a WHERE a->>'actorId'=app.current_user_id()::text))
$$;
-- Private set-based source seam. Callers never receive a case's private blob.
CREATE FUNCTION app.v9_document_route_sources() RETURNS TABLE(case_id uuid,revision integer,company_id uuid,employment_id uuid,person_id uuid,is_native boolean,number text,state text,document jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT c.id,c.revision,c.company_id,c.employment_id,e.person_id,false,c.number,c.data->>'state',d
 FROM lc_v9_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'documents','[]'::jsonb)) d
 WHERE c.tenant_id=app.current_tenant_id() AND jsonb_typeof(d->'signing')='object'
 UNION ALL
 SELECT c.id,c.revision,c.company_id,c.employment_id,(c.data->>'personId')::uuid,true,c.data->>'number',c.data->>'state',d
 FROM lc_onboarding_case c JOIN lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.data->'lifecycleV9'->'documents','[]'::jsonb)) d
 WHERE c.tenant_id=app.current_tenant_id() AND jsonb_typeof(d->'signing')='object'
  AND p.data->'lifecycleV9Subject'->>'personId' IS NOT DISTINCT FROM c.data->>'personId'
  AND p.data->'lifecycleV9Subject'->>'employmentId' IS NOT DISTINCT FROM c.employment_id::text
$$;
CREATE FUNCTION app.v9_document_signing_work(p_search text DEFAULT '',p_offset integer DEFAULT 0,p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH visible AS (
  SELECT * FROM app.v9_document_route_sources() s WHERE app.v9_signing_current_actor()
   AND app.v9_document_route_participant(s.document) AND s.document->>'status' NOT IN('withdrawn','superseded')
   AND position(lower(left(coalesce(p_search,''),100)) IN lower(s.number||' '||(s.document->>'name')))>0
 ), page AS(SELECT * FROM visible ORDER BY document->>'createdAt',case_id,document->>'id' LIMIT least(50,greatest(1,p_limit)) OFFSET greatest(0,least(1000000,p_offset)))
 SELECT jsonb_build_object('total',(SELECT count(*) FROM visible),'items',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'caseId',case_id,'caseRevision',revision,'number',number,'state',state,'documentId',document->>'id','name',document->>'name',
  'signing',document->'signing','document',CASE WHEN app.v9_document_route_content_visible(document) THEN document ELSE NULL END)
  ORDER BY document->>'createdAt',case_id,document->>'id') FROM page),'[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION app.v9_signing_current_actor(),app.v9_document_content_hash(jsonb),app.v9_document_route_complete(jsonb),app.v9_document_route_signatures(jsonb),app.v9_document_route_participant(jsonb),app.v9_document_route_content_visible(jsonb),app.v9_document_route_sources(),app.v9_document_signing_work(text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.v9_signing_current_actor(),app.v9_document_content_hash(jsonb),app.v9_document_route_complete(jsonb),app.v9_document_route_signatures(jsonb),app.v9_document_route_participant(jsonb),app.v9_document_route_content_visible(jsonb),app.v9_document_signing_work(text,integer,integer) TO ai_hr_app;
--> statement-breakpoint
-- Mirror the native registry's six-dimensional match and canonical employment category.
CREATE FUNCTION app.v9_document_native_rules_match(p_rules jsonb,f jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;v jsonb;kind text;confirmation text;anchor text;
BEGIN
 IF f->>'employmentType'='contract' THEN kind:='contract';
 ELSIF f->>'employmentType'='full_time' THEN
  confirmation:=coalesce(nullif(f->>'finalConfirmationDate',''),nullif(f->>'confirmationDate',''),nullif(f->>'probationEndDate',''),nullif(f->>'provisionalEndOn',''));
  anchor:=coalesce(nullif(f->>'noticeDate',''),nullif(f->>'joinDate',''));
  kind:=CASE WHEN confirmation IS NULL THEN 'permanent' WHEN anchor IS NULL THEN NULL WHEN anchor<confirmation THEN 'probation' ELSE 'permanent' END;
 END IF;
 FOR k,v IN SELECT * FROM jsonb_each(coalesce(p_rules,'{}'::jsonb)) LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR k NOT IN('businessGroup','company','department','title','grade','employmentType') THEN RETURN false;END IF;
  IF jsonb_array_length(v)=0 THEN CONTINUE;END IF;
  IF k='employmentType' THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(v) candidate WHERE CASE WHEN lower(candidate) IN('permanent','contract','probation') THEN lower(candidate)=kind ELSE candidate=f->>k END) THEN RETURN false;END IF;
  ELSIF NOT v ? coalesce(f->>k,'') THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.v9_document_native_rules_match(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.v9_document_native_rules_match(jsonb,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- Every source writer, including pre-existing SECURITY DEFINER RPCs, must prove the exact append.
CREATE FUNCTION app.v9_document_route_validate_append(p_before jsonb,p_after jsonb,p_document jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a jsonb;step jsonb;uid uuid:=app.current_user_id();person uuid;actor_name text;i integer;n integer:=jsonb_array_length(p_before->'actions');kind text;f jsonb;value text;token text;
BEGIN
 IF jsonb_array_length(p_after->'actions')<>n+1 THEN RAISE EXCEPTION 'Signing history is append-only';END IF;
 FOR i IN 0..n-1 LOOP IF p_after->'actions'->i IS DISTINCT FROM p_before->'actions'->i THEN RAISE EXCEPTION 'Signing history is immutable';END IF;END LOOP;
 a:=p_after->'actions'->n;kind:=a->>'action';
 SELECT u.person_id,p.full_name INTO person,actor_name FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=uid AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT app.v9_signing_current_actor() OR person IS NULL OR actor_name IS NULL OR a->>'actorId' IS DISTINCT FROM uid::text OR a->>'actorPersonId' IS DISTINCT FROM person::text OR a->>'actorName' IS DISTINCT FROM actor_name
  OR a->'contentRevision' IS DISTINCT FROM p_before->'contentRevision' OR a->>'contentHash' IS DISTINCT FROM p_before->>'contentHash'
  OR length(coalesce(a->>'id','')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(a->'comment') IS DISTINCT FROM 'string' OR length(a->>'comment')>4000
  OR a-ARRAY['id','stepId','contentRevision','contentHash','actorId','actorPersonId','actorName','representedId','role','at','action','comment','signature'] IS DISTINCT FROM '{}'::jsonb
  OR coalesce(a->>'at','') !~ '^\d{4}-\d{2}-\d{2}T' OR abs(extract(epoch FROM ((a->>'at')::timestamptz-now())))>10
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_before->'actions') previous WHERE previous->>'id'=a->>'id') THEN RAISE EXCEPTION 'Signing actor, action reference or source binding is invalid';END IF;
 IF kind='resent' THEN
  IF NOT app.document_signing_returned(p_before) OR app.document_signing_owner(p_before) IS DISTINCT FROM uid OR a->>'role' IS DISTINCT FROM 'owner' OR a->>'representedId' IS DISTINCT FROM uid::text OR a->'signature' IS DISTINCT FROM 'null'::jsonb OR a->>'stepId' IS DISTINCT FROM coalesce(app.document_signing_owner_step(p_before)->>'id','owner') THEN RAISE EXCEPTION 'Only the recorded owner can resend';END IF;
  RETURN;
 END IF;
 IF app.document_signing_returned(p_before) THEN RAISE EXCEPTION 'Returned document is held by its owner';END IF;
 IF kind='returned' THEN SELECT value INTO step FROM jsonb_array_elements(p_before->'route'->'steps') value WHERE value->>'id'=a->>'stepId' AND value->>'holderId'=uid::text;
 ELSE SELECT value INTO step FROM app.document_signing_pending_steps(p_before) value WHERE value->>'id'=a->>'stepId' AND value->>'holderId'=uid::text;END IF;
 IF step IS NULL OR a->>'role' IS DISTINCT FROM step->>'role' OR a->>'representedId' IS DISTINCT FROM coalesce(step->>'representedId',step->>'holderId') THEN RAISE EXCEPTION 'Only the assigned frozen route holder can act';END IF;
 IF kind='returned' THEN IF btrim(a->>'comment')='' OR a->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'A send-back comment is required';END IF;
 ELSIF kind='reviewed' THEN IF step->>'kind'<>'review' OR a->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'This step requires a review';END IF;
 ELSIF kind='approved' THEN IF step->>'kind'<>'approve' OR a->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'This step requires approval';END IF;
 ELSIF kind='signed' THEN
  IF step->>'kind' NOT IN('sign','acknowledge') OR app.document_signature_valid(a->'signature') IS NOT TRUE THEN RAISE EXCEPTION 'Valid signature and consent required';END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(p_document->'fields') LOOP
   IF f->'when' IS NOT NULL AND jsonb_typeof(f->'when')='object' AND p_document->'values'->>(f->'when'->>'field') IS DISTINCT FROM f->'when'->>'value' THEN CONTINUE;END IF;
   value:=coalesce(p_document->'values'->>(f->>'id'),'');
   IF f->>'required'='true' AND (btrim(value)='' OR f->>'type'='checkbox' AND value<>'true' OR f->>'type'='table' AND value='[]') THEN RAISE EXCEPTION 'Required document fields are incomplete';END IF;
   IF value<>'' AND (f->>'type'='select' AND NOT f->'options' ? value OR f->>'type'='checkbox' AND value NOT IN('true','false') OR f->>'type'='number' AND value !~ '^-?[0-9]+(\.[0-9]+)?$' OR f->>'type'='email' AND value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') THEN RAISE EXCEPTION 'A document field has an invalid value';END IF;
  END LOOP;
  FOR token IN SELECT DISTINCT m[1] FROM jsonb_array_elements(p_document->'blocks') b CROSS JOIN LATERAL regexp_matches(coalesce(p_document->'edits'->>(b->>'id'),b->>'text','')||' '||coalesce(b->>'rows','')||' '||coalesce(b->>'label',''),'\{([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)?)\}','g') m LOOP
   IF coalesce(nullif(p_document->'values'->>token,''),nullif(p_document->'mergeValues'->>token,'')) IS NULL THEN RAISE EXCEPTION 'A document merge field is missing';END IF;
  END LOOP;
 ELSE RAISE EXCEPTION 'Unsupported signing action';END IF;
END $$;
REVOKE ALL ON FUNCTION app.v9_document_route_validate_append(jsonb,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.v9_document_route_validate_append(jsonb,jsonb,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.v9_document_route_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_docs jsonb;new_docs jsonb;d jsonb;prior jsonb;definition jsonb;version jsonb;cfg jsonb;native_cfg jsonb;c lc_onboarding_case;facts jsonb;company uuid;subject_person uuid;admin boolean;step jsonb;spec jsonb;who jsonb;group_row jsonb;routing jsonb;candidate_row jsonb;selected_group text;possible text[];holder text;employee_user text;supervisor_user text;signature jsonb;body_changed boolean;content_edit boolean;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.acting_as_owner() THEN RAISE EXCEPTION 'Document tenant mismatch';END IF;
 IF TG_TABLE_NAME='lc_onboarding_private' THEN
  old_docs:=CASE WHEN TG_OP='INSERT' THEN '[]'::jsonb ELSE coalesce(OLD.data->'lifecycleV9'->'documents','[]'::jsonb) END;new_docs:=coalesce(NEW.data->'lifecycleV9'->'documents','[]'::jsonb);
  SELECT * INTO c FROM lc_onboarding_case WHERE id=NEW.case_id AND tenant_id=NEW.tenant_id;
  company:=c.company_id;facts:=coalesce(c.data->'local','{}'::jsonb)||coalesce(c.data->'source','{}'::jsonb);subject_person:=(c.data->>'personId')::uuid;
  admin:=app.is_admin_for(company) AND (app.onboarding_page_access() OR app.onboarding_v9_case_actor() OR app.is_group_admin());
 ELSE
  old_docs:=CASE WHEN TG_OP='INSERT' THEN '[]'::jsonb ELSE coalesce(OLD.data->'documents','[]'::jsonb) END;new_docs:=coalesce(NEW.data->'documents','[]'::jsonb);company:=NEW.company_id;facts:=NEW.data->'facts';subject_person:=(facts->>'personId')::uuid;admin:=app.lc_v9_off_access(company);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(old_docs||new_docs) d WHERE jsonb_typeof(d->'signing')='object') THEN RETURN NEW;END IF;
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
  PERFORM app.document_signing_validate(signature,'{"requiredRoles":[]}'::jsonb);
  IF coalesce(d->'stepSignatures','{}'::jsonb) IS DISTINCT FROM app.v9_document_route_signatures(d) OR (d->>'status'='signed') IS DISTINCT FROM app.v9_document_route_complete(d) AND d->>'status' NOT IN('withdrawn','superseded') THEN RAISE EXCEPTION 'Routed signature/status projection mismatch';END IF;
  IF jsonb_typeof(prior->'signing')='object' THEN
   IF d->'routing' IS DISTINCT FROM prior->'routing' OR signature-ARRAY['contentRevision','contentHash','actions'] IS DISTINCT FROM (prior->'signing')-ARRAY['contentRevision','contentHash','actions'] THEN RAISE EXCEPTION 'Generated routes are frozen';END IF;
   body_changed:=app.v9_document_content_hash(prior) IS DISTINCT FROM app.v9_document_content_hash(d);
   IF body_changed THEN
    IF d->'fields' IS DISTINCT FROM prior->'fields' OR d->'blocks' IS DISTINCT FROM prior->'blocks' OR d->'mergeValues' IS DISTINCT FROM prior->'mergeValues' OR d->>'templateId' IS DISTINCT FROM prior->>'templateId' OR d->'version' IS DISTINCT FROM prior->'version' THEN RAISE EXCEPTION 'Frozen source fields and document structure cannot be replaced';END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(prior->'fields') field WHERE field->>'owner'='pmLocked' AND d->'values'->(field->>'id') IS DISTINCT FROM prior->'values'->(field->>'id')) THEN RAISE EXCEPTION 'Personnel source fields are locked';END IF;
    content_edit:=app.document_signing_can_edit(prior->'signing',app.current_user_id());
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
  IF NOT (admin AND app.v9_signing_current_actor() OR app.acting_as_owner() AND app.current_user_id() IS NULL) OR signature->'actions' IS DISTINCT FROM '[]'::jsonb OR signature->>'contentRevision' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'A scoped document preparer must initialize signing';END IF;
  SELECT value INTO definition FROM jsonb_array_elements(cfg->'templates') WHERE value->>'id'=d->>'templateId';
  SELECT value INTO version FROM jsonb_array_elements(definition->'versions') WHERE value->'version'=d->'version' AND value->>'state'='published';
  IF d->'blocks' IS DISTINCT FROM version->'blocks' OR d->'fields' IS DISTINCT FROM version->'fields' OR d->>'templateType' IS DISTINCT FROM definition->>'type' OR d->'edits' IS DISTINCT FROM '{}'::jsonb OR signature->'route'->'version' IS DISTINCT FROM '1'::jsonb OR version IS NULL OR d->'routing' IS DISTINCT FROM version->'routing' OR jsonb_array_length(d->'routing')<>jsonb_array_length(signature->'route'->'steps') OR signature->'routing'->>'templateId' IS DISTINCT FROM d->>'templateId' OR signature->'routing'->'templateVersion' IS DISTINCT FROM d->'version' THEN RAISE EXCEPTION 'Signing route must come from the published saved version';END IF;
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
   IF step ?| ARRAY['coveredStepIds','coveredByStepId','representedId','signature'] OR spec IS NULL OR step->>'kind' IS DISTINCT FROM spec->>'action' OR step->'stage' IS DISTINCT FROM spec->'order' OR step->'required' IS DISTINCT FROM coalesce(spec->'required','true'::jsonb) OR coalesce(step->'owner','false'::jsonb) IS DISTINCT FROM spec->'owner' OR step->>'role' IS DISTINCT FROM CASE who->>'kind' WHEN 'employee' THEN 'employee' WHEN 'directSuperior' THEN 'lm' WHEN 'group' THEN 'group:'||(who->>'groupId') WHEN 'routing' THEN 'routing:'||(who->>'routingId') ELSE 'people' END THEN RAISE EXCEPTION 'Frozen step differs from its template';END IF;
   IF who->>'kind'='employee' THEN possible:=ARRAY[employee_user];
   ELSIF who->>'kind'='directSuperior' THEN possible:=ARRAY[supervisor_user];
   ELSIF who->>'kind'='people' THEN SELECT coalesce(array_agg(value),'{}') INTO possible FROM jsonb_array_elements_text(who->'userIds');
   ELSIF who->>'kind'='group' THEN selected_group:=who->>'groupId';
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
REVOKE ALL ON FUNCTION app.v9_document_route_guard() FROM PUBLIC;
CREATE TRIGGER v9_routed_document_source_guard BEFORE INSERT OR UPDATE ON lc_v9_case FOR EACH ROW EXECUTE FUNCTION app.v9_document_route_guard();
CREATE TRIGGER native_routed_document_source_guard BEFORE INSERT OR UPDATE ON lc_onboarding_private FOR EACH ROW EXECUTE FUNCTION app.v9_document_route_guard();
