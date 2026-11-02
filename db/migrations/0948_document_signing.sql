-- Provisional source allocation; no existing Onboarding/Offboarding signing is changed.
CREATE TABLE document_signing_document (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id), employment_id uuid NOT NULL REFERENCES employment(id),
 subject_type text NOT NULL CHECK(subject_type='probation'), subject_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), data jsonb NOT NULL, guardrails jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,subject_type,subject_id), UNIQUE(tenant_id,id),
 CHECK(data->>'tenantId'=tenant_id::text), CHECK(data->>'companyId'=company_id::text),
 CHECK(data->>'subjectId'=subject_id::text), CHECK(data->>'subjectType'=subject_type),
 CHECK(data->>'contentHash' ~ '^[a-f0-9]{64}$'), CHECK((data->>'contentRevision')::integer>0)
);
CREATE TABLE document_signing_revision (
 document_id uuid NOT NULL REFERENCES document_signing_document(id),tenant_id uuid NOT NULL REFERENCES tenant(id),
 revision integer NOT NULL,data jsonb NOT NULL,actor_user_id uuid NOT NULL REFERENCES app_user(id),
 reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(document_id,revision)
);
-- Fixed dispatch: the subject owner supplies actual case/part permissions. Missing adapter fails closed.
CREATE FUNCTION app.document_signing_subject_access(p_type text,p_subject uuid,p_operation text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE allowed boolean;
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR app.login_blocked(app.current_user_id())
 OR app.principal_snapshot_current() IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id() AND archived_at IS NULL) THEN RETURN false; END IF;
 IF p_type<>'probation' OR p_operation NOT IN ('create','read','sign','decline','revise','reroute') OR to_regprocedure('app.probation_signing_access(uuid,text)') IS NULL THEN RETURN false; END IF;
 EXECUTE 'SELECT app.probation_signing_access($1,$2)' INTO allowed USING p_subject,p_operation;
 RETURN coalesce(allowed,false);
END $$;
ALTER TABLE document_signing_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_signing_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY signing_document_read ON document_signing_document FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.document_signing_subject_access(subject_type,subject_id,'read'));
CREATE POLICY signing_revision_read ON document_signing_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM document_signing_document d WHERE d.id=document_id AND d.tenant_id=document_signing_revision.tenant_id AND app.document_signing_subject_access(d.subject_type,d.subject_id,'read')));
REVOKE ALL ON document_signing_document,document_signing_revision FROM PUBLIC,ai_hr_app;
GRANT SELECT ON document_signing_document,document_signing_revision TO ai_hr_app;
CREATE FUNCTION app.document_signing_validate(p_data jsonb,p_rules jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE step jsonb;role text;manager uuid;
BEGIN
 IF jsonb_typeof(p_data->'route'->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'route'->'steps') NOT BETWEEN 1 AND 30
 OR jsonb_typeof(p_data->'actions') IS DISTINCT FROM 'array' OR jsonb_typeof(p_rules->'requiredRoles') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid signing route'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_data->'route'->'steps'))<>(SELECT count(DISTINCT s->>'id') FROM jsonb_array_elements(p_data->'route'->'steps') s) THEN RAISE EXCEPTION 'Duplicate signing steps'; END IF;
 FOR step IN SELECT * FROM jsonb_array_elements(p_data->'route'->'steps') LOOP
  IF coalesce(step->>'id','')='' OR coalesce(step->>'role','')='' OR coalesce(step->>'kind','') NOT IN ('sign','acknowledge','approve') OR jsonb_typeof(step->'stage') IS DISTINCT FROM 'number' OR (step->>'stage')::integer<0 OR jsonb_typeof(step->'required') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid signing step'; END IF;
  IF step->>'holderId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=(step->>'holderId')::uuid AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND u.person_id IS NOT NULL AND step->>'holderPersonId'=u.person_id::text AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Invalid signer'; END IF;
 END LOOP;
 FOR role IN SELECT jsonb_array_elements_text(p_rules->'requiredRoles') LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') s WHERE s->>'role'=role AND s->>'required'='true') THEN RAISE EXCEPTION 'Required signing role cannot be removed'; END IF;
 END LOOP;
 IF p_rules->>'independentApprovalFromRole' IS NOT NULL THEN
  SELECT (s->>'holderPersonId')::uuid INTO manager FROM jsonb_array_elements(p_data->'route'->'steps') s WHERE s->>'role'=p_rules->>'independentApprovalFromRole' AND s->>'required'='true' LIMIT 1;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') s WHERE s->>'kind'='approve' AND s->>'required'='true' AND s->>'role'<>p_rules->>'independentApprovalFromRole' AND (s->>'holderId' IS NULL OR manager IS NULL OR (s->>'holderPersonId')::uuid<>manager)) THEN RAISE EXCEPTION 'A distinct approving person is required'; END IF;
 END IF;
END $$;
CREATE FUNCTION app.document_signing_store(p_id uuid,p_employment uuid,p_company uuid,p_subject uuid,p_data jsonb,p_rules jsonb,p_expected integer,p_operation text,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old document_signing_document;new_revision integer;expected_rules jsonb;route_allowed boolean;content jsonb;
BEGIN
 IF coalesce(p_operation,'') NOT IN ('create','revise','reroute') OR NOT app.document_signing_subject_access('probation',p_subject,p_operation) THEN RAISE EXCEPTION 'Signing operation not permitted'; END IF;
 IF NOT EXISTS(SELECT 1 FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() AND company_id=p_company) THEN RAISE EXCEPTION 'Invalid signing subject'; END IF;
 IF p_data->>'tenantId' IS DISTINCT FROM app.current_tenant_id()::text OR p_data->>'companyId' IS DISTINCT FROM p_company::text OR p_data->>'subjectId' IS DISTINCT FROM p_subject::text OR p_data->>'subjectType' IS DISTINCT FROM 'probation' THEN RAISE EXCEPTION 'Signing subject mismatch'; END IF;
 IF to_regprocedure('app.probation_signing_guardrails(uuid)') IS NULL OR to_regprocedure('app.probation_signing_route_allowed(uuid,jsonb)') IS NULL OR to_regprocedure('app.probation_signing_content(uuid)') IS NULL THEN RAISE EXCEPTION 'Signing subject adapter is unavailable'; END IF;
 EXECUTE 'SELECT app.probation_signing_content($1)' INTO content USING p_subject;
 IF content IS NULL OR content->>'companyId' IS DISTINCT FROM p_company::text OR content->>'employmentId' IS DISTINCT FROM p_employment::text OR content->>'contentHash' IS DISTINCT FROM p_data->>'contentHash' OR content->>'contentRevision' IS DISTINCT FROM p_data->>'contentRevision' THEN RAISE EXCEPTION 'Signing content changed'; END IF;
 EXECUTE 'SELECT app.probation_signing_guardrails($1)' INTO expected_rules USING p_subject;
 EXECUTE 'SELECT app.probation_signing_route_allowed($1,$2)' INTO route_allowed USING p_subject,p_data->'route';
 IF expected_rules IS NULL OR expected_rules<>p_rules OR NOT coalesce(route_allowed,false) THEN RAISE EXCEPTION 'Signing subject policy or current route changed'; END IF;
 IF coalesce(p_data->>'contentHash','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_data->'contentRevision') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid content fingerprint or revision'; END IF;
 PERFORM app.document_signing_validate(p_data,p_rules);
 SELECT * INTO old FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF p_operation='create' THEN
  IF FOUND OR p_expected IS DISTINCT FROM 0 OR p_data->'actions' IS DISTINCT FROM '[]'::jsonb OR p_data->>'contentRevision' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'Invalid initial signing revision'; END IF;
  INSERT INTO document_signing_document(id,tenant_id,company_id,employment_id,subject_type,subject_id,data,guardrails) VALUES(p_id,app.current_tenant_id(),p_company,p_employment,'probation',p_subject,p_data,p_rules);
  new_revision:=1;
 ELSE
  IF NOT FOUND OR old.subject_id<>p_subject OR old.employment_id<>p_employment OR old.company_id<>p_company OR old.revision IS DISTINCT FROM p_expected OR old.guardrails<>p_rules OR btrim(coalesce(p_reason,''))='' THEN RAISE EXCEPTION 'Signing revision changed or reason missing'; END IF;
  IF p_data->'actions' IS DISTINCT FROM old.data->'actions' THEN RAISE EXCEPTION 'Signing history is immutable'; END IF;
  IF p_operation='revise' THEN
   IF (p_data->>'contentRevision')::integer<>(old.data->>'contentRevision')::integer+1 OR p_data->>'contentHash'=old.data->>'contentHash' THEN RAISE EXCEPTION 'Invalid content revision'; END IF;
  ELSE
   IF p_data->>'contentRevision'<>old.data->>'contentRevision' OR p_data->>'contentHash'<>old.data->>'contentHash' THEN RAISE EXCEPTION 'Rerouting cannot change signed content'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(old.data->'route'->'steps') s WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') n WHERE (n-'holderId'-'holderPersonId'-'representedId')=(s-'holderId'-'holderPersonId'-'representedId'))) OR jsonb_array_length(p_data->'route'->'steps')<>jsonb_array_length(old.data->'route'->'steps') THEN RAISE EXCEPTION 'Rerouting cannot remove or change required steps'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(old.data->'actions') a WHERE a->>'action' IN ('signed','declined') AND a->>'contentRevision'=old.data->>'contentRevision' AND a->>'contentHash'=old.data->>'contentHash' AND EXISTS(SELECT 1 FROM jsonb_array_elements(old.data->'route'->'steps') s JOIN jsonb_array_elements(p_data->'route'->'steps') n ON s->>'id'=n->>'id' WHERE s->>'id'=a->>'stepId' AND s<>n)) THEN RAISE EXCEPTION 'Completed signatures cannot be reassigned'; END IF;
  END IF;
  new_revision:=old.revision+1;
  UPDATE document_signing_document SET data=p_data,revision=new_revision,updated_at=now() WHERE id=old.id;
 END IF;
 INSERT INTO document_signing_revision(document_id,tenant_id,revision,data,actor_user_id,reason) VALUES(p_id,app.current_tenant_id(),new_revision,p_data,app.current_user_id(),coalesce(nullif(btrim(p_reason),''),'Created signing route'));
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(app.current_tenant_id(),'document-signing',p_id,CASE p_operation WHEN 'create' THEN 'document-signing.created' WHEN 'revise' THEN 'document-signing.revised' ELSE 'document-signing.rerouted' END,'user',app.current_user_id(),p_employment,jsonb_build_object('documentId',p_id,'revision',new_revision));
 RETURN p_id;
END $$;
CREATE FUNCTION app.document_signing_act(p_id uuid,p_action jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;step jsonb;prior jsonb;stage integer;v_action jsonb;v_name text;v_person uuid;new_data jsonb;content jsonb;route_allowed boolean;v_png bytea;v_width bigint;v_height bigint;
BEGIN
 -- All subject writers lock the source part before the signing document.
 SELECT * INTO d FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR to_regprocedure('app.probation_signing_content(uuid)') IS NULL OR to_regprocedure('app.probation_signing_route_allowed(uuid,jsonb)') IS NULL THEN RAISE EXCEPTION 'Signing subject unavailable'; END IF;
 EXECUTE 'SELECT app.probation_signing_content($1)' INTO content USING d.subject_id;
 SELECT * INTO d FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.document_signing_subject_access(d.subject_type,d.subject_id,CASE WHEN p_action->>'action'='declined' THEN 'decline' ELSE 'sign' END) THEN RAISE EXCEPTION 'Signing action not permitted'; END IF;
 IF jsonb_typeof(p_action) IS DISTINCT FROM 'object' OR jsonb_typeof(p_action->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(p_action->'stepId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_action->'contentRevision') IS DISTINCT FROM 'number' OR coalesce(p_action->>'id','')='' OR coalesce(p_action->>'stepId','')='' OR length(p_action->>'id')>200 OR jsonb_typeof(p_action->'comment') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid signing action shape'; END IF;
 IF content IS NULL OR content->>'companyId' IS DISTINCT FROM d.company_id::text OR content->>'employmentId' IS DISTINCT FROM d.employment_id::text OR content->>'contentHash' IS DISTINCT FROM d.data->>'contentHash' OR content->>'contentRevision' IS DISTINCT FROM d.data->>'contentRevision' THEN RAISE EXCEPTION 'Signing content changed'; END IF;
 EXECUTE 'SELECT app.probation_signing_route_allowed($1,$2)' INTO route_allowed USING d.subject_id,d.data->'route';
 IF route_allowed IS NOT TRUE THEN RAISE EXCEPTION 'Current signing holders changed'; END IF;
 SELECT person_id INTO v_person FROM app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id();
 IF v_person IS NULL OR p_action->>'actorPersonId' IS DISTINCT FROM v_person::text THEN RAISE EXCEPTION 'Verified signer person changed'; END IF;
 IF p_action->>'actorId' IS DISTINCT FROM app.current_user_id()::text OR p_action->>'contentHash' IS DISTINCT FROM d.data->>'contentHash' OR p_action->'contentRevision' IS DISTINCT FROM d.data->'contentRevision' THEN RAISE EXCEPTION 'Signer or document revision changed'; END IF;
 SELECT a INTO prior FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'id'=p_action->>'id';
 IF prior IS NOT NULL THEN
  IF (prior-'at'-'actorName')=(p_action-'at'-'actorName') THEN RETURN d.data; END IF;
  RAISE EXCEPTION 'Signing action reference already used';
 END IF;
 SELECT min((s->>'stage')::integer) INTO stage FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=s->>'id' AND a->>'action' IN ('signed','declined') AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash');
 SELECT s INTO step FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'id'=p_action->>'stepId' AND (s->>'stage')::integer=stage;
 IF step IS NULL OR (p_action->>'action'<>'declined' AND step->>'holderId' IS DISTINCT FROM app.current_user_id()::text) OR p_action->>'role' IS DISTINCT FROM step->>'role' OR p_action->>'representedId' IS DISTINCT FROM coalesce(step->>'representedId',step->>'holderId') THEN RAISE EXCEPTION 'Only the assigned pending signer may act'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=step->>'id' AND a->>'action' IN ('signed','declined') AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN RAISE EXCEPTION 'Signature already recorded'; END IF;
 IF p_action->>'action'='declined' THEN
  IF step->>'kind'<>'acknowledge' OR step->>'holderPersonId'=v_person::text OR btrim(coalesce(p_action->>'comment',''))='' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'An independent recorded refusal confirmation is required'; END IF;
 ELSIF p_action->>'action'='returned' THEN
  IF btrim(coalesce(p_action->>'comment',''))='' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'A return reason is required'; END IF;
 ELSIF p_action->>'action'='signed' THEN
  IF p_action->'signature'->'consent' IS DISTINCT FROM 'true'::jsonb OR coalesce(p_action->'signature'->>'method','') NOT IN ('typed','drawn') OR jsonb_typeof(p_action->'signature'->'value') IS DISTINCT FROM 'string' OR length(btrim(coalesce(p_action->'signature'->>'value','')))=0 OR length(p_action->'signature'->>'value')>500000 THEN RAISE EXCEPTION 'A valid signature and consent are required'; END IF;
  IF p_action->'signature'->>'method'='typed' AND (length(p_action->'signature'->>'value')>200 OR p_action->'signature'->>'value' ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'Invalid typed signature'; END IF;
  IF p_action->'signature'->>'method'='drawn' AND p_action->'signature'->>'value' !~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$' THEN RAISE EXCEPTION 'Invalid drawn signature'; END IF;
  IF p_action->'signature'->>'method'='drawn' THEN
   v_png:=decode(split_part(p_action->'signature'->>'value',',',2),'base64');
   IF octet_length(v_png)<24 OR encode(substring(v_png from 1 for 16),'hex')<>'89504e470d0a1a0a0000000d49484452' THEN RAISE EXCEPTION 'Invalid drawn signature header'; END IF;
   v_width:=get_byte(v_png,16)::bigint*16777216+get_byte(v_png,17)::bigint*65536+get_byte(v_png,18)::bigint*256+get_byte(v_png,19);
   v_height:=get_byte(v_png,20)::bigint*16777216+get_byte(v_png,21)::bigint*65536+get_byte(v_png,22)::bigint*256+get_byte(v_png,23);
   IF v_width NOT BETWEEN 1 AND 2048 OR v_height NOT BETWEEN 1 AND 1024 OR v_width*v_height>2097152 THEN RAISE EXCEPTION 'Invalid drawn signature dimensions'; END IF;
  END IF;
  IF step->>'kind'='approve' AND d.guardrails->>'independentApprovalFromRole' IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'=d.guardrails->>'independentApprovalFromRole' AND a->>'action'='signed' AND a->>'actorPersonId'=v_person::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') other_step WHERE other_step->>'kind'='approve' AND other_step->>'required'='true' AND other_step->>'holderPersonId'<>v_person::text) THEN RAISE EXCEPTION 'A distinct approving person is required'; END IF;
 ELSE RAISE EXCEPTION 'Invalid signing action'; END IF;
 SELECT p.full_name INTO v_name FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id();
 IF v_name IS NULL THEN RAISE EXCEPTION 'Verified signer name is missing'; END IF;
 v_action:=p_action||jsonb_build_object('actorName',v_name,'actorPersonId',v_person,'at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 new_data:=jsonb_set(d.data,'{actions}',(d.data->'actions')||jsonb_build_array(v_action));
 UPDATE document_signing_document SET data=new_data,revision=revision+1,updated_at=now() WHERE id=d.id;
 INSERT INTO document_signing_revision(document_id,tenant_id,revision,data,actor_user_id,reason) VALUES(d.id,d.tenant_id,d.revision+1,new_data,app.current_user_id(),'Recorded signing action');
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(d.tenant_id,'document-signing',d.id,CASE p_action->>'action' WHEN 'signed' THEN 'document-signing.signed' WHEN 'declined' THEN 'document-signing.acknowledgement-declined' ELSE 'document-signing.returned' END,'user',app.current_user_id(),d.employment_id,jsonb_build_object('documentId',d.id,'revision',d.revision+1,'stepId',step->>'id'));
 RETURN new_data;
END $$;
REVOKE ALL ON FUNCTION app.document_signing_subject_access(text,uuid,text),app.document_signing_validate(jsonb,jsonb),app.document_signing_store(uuid,uuid,uuid,uuid,jsonb,jsonb,integer,text,text),app.document_signing_act(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.document_signing_subject_access(text,uuid,text),app.document_signing_store(uuid,uuid,uuid,uuid,jsonb,jsonb,integer,text,text),app.document_signing_act(uuid,jsonb) TO ai_hr_app;
