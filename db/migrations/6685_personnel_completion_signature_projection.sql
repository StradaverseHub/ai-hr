-- Resolve per-document answers at the existing signature boundaries without changing the official source snapshot.
CREATE OR REPLACE FUNCTION app.lc_v9_self_document(p_id uuid,p_revision integer,p_document text,p_values jsonb,p_signature jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c lc_v9_case%ROWTYPE; native_case lc_onboarding_case%ROWTYPE; native_private jsonb; is_native boolean:=false; d jsonb; f jsonb; t jsonb; cfg jsonb; actor_name text;
 key text; value jsonb; vals jsonb; next_docs jsonb:='[]'::jsonb; next_tasks jsonb:='[]'::jsonb;
 next_pm jsonb; signing boolean:=p_signature IS NOT NULL; next_status text; changes jsonb; own_user uuid:=app.current_user_id();
BEGIN
 IF own_user IS NULL OR app.login_blocked(own_user) OR p_values IS NULL OR jsonb_typeof(p_values)<>'object' OR octet_length(p_values::text)>1048576 THEN RAISE EXCEPTION 'Invalid document command'; END IF;
 SELECT x.* INTO c FROM lc_v9_case x JOIN employment e ON e.id=x.employment_id AND e.tenant_id=x.tenant_id
 JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.id=own_user AND u.archived_at IS NULL
 WHERE x.id=p_id AND x.tenant_id=app.current_tenant_id() FOR UPDATE OF x;
 IF NOT FOUND THEN
  SELECT x.* INTO native_case FROM lc_onboarding_case x
  JOIN employment e ON e.id=x.employment_id AND e.person_id::text=x.data->>'personId' AND e.tenant_id=x.tenant_id AND e.company_id=x.company_id
  JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.id=own_user AND u.archived_at IS NULL
  WHERE x.id=p_id AND x.tenant_id=app.current_tenant_id() FOR UPDATE OF x;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document not available'; END IF;
  SELECT data INTO native_private FROM lc_onboarding_private WHERE case_id=native_case.id AND tenant_id=native_case.tenant_id FOR UPDATE;
  IF native_private->'lifecycleV9' IS NULL OR native_private->'lifecycleV9Subject'->>'employmentId' IS DISTINCT FROM native_case.employment_id::text OR native_private->'lifecycleV9Subject'->>'personId' IS DISTINCT FROM native_case.data->>'personId' THEN RAISE EXCEPTION 'Document not available'; END IF;
  is_native:=true; c.id:=native_case.id; c.tenant_id:=native_case.tenant_id; c.company_id:=native_case.company_id; c.employment_id:=native_case.employment_id; c.revision:=native_case.revision;
  c.data:=(native_private->'lifecycleV9')||jsonb_build_object('state',native_case.data->>'state','tasks',native_case.data->'tasks','sourceRevision',native_case.data->>'sourceVersion');
 END IF;
 IF c.data->>'state'<>'submitted' THEN RAISE EXCEPTION 'Document not available'; END IF;
 IF c.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This case changed. Refresh before trying again.'; END IF;
 SELECT x INTO d FROM jsonb_array_elements(c.data->'documents') x WHERE x->>'id'=p_document AND x->>'status' IN ('sent','opened');
 IF d IS NULL THEN RAISE EXCEPTION 'Document is not open for completion'; END IF;
 SELECT x INTO cfg FROM lc_v9_config conf,jsonb_array_elements(conf.data->'templates') x WHERE conf.tenant_id=c.tenant_id AND x->>'id'=d->>'templateId';
 IF coalesce(d->>'templateType',cfg->>'type')='Attachment' THEN RAISE EXCEPTION 'Attachments are read-only PDFs'; END IF;
 vals:=coalesce(d->'values','{}'::jsonb);
 FOR key,value IN SELECT * FROM jsonb_each(p_values) LOOP
  SELECT x INTO f FROM jsonb_array_elements(d->'fields') x WHERE x->>'id'=key AND x->>'owner'='employee';
  IF f IS NULL OR jsonb_typeof(value)<>'string' OR length(value#>>'{}')>20000 THEN RAISE EXCEPTION 'This field cannot be changed'; END IF;
  IF f->>'type'='select' AND value#>>'{}'<>'' AND NOT (f->'options' ? (value#>>'{}')) THEN RAISE EXCEPTION 'Choose a valid option'; END IF;
  IF value#>>'{}'<>'' THEN
   IF f->>'type'='date' AND ((value#>>'{}') !~ '^\d{4}-\d{2}-\d{2}$' OR to_char((value#>>'{}')::date,'YYYY-MM-DD')<>value#>>'{}') THEN RAISE EXCEPTION 'Enter a valid date'; END IF;
   IF f->>'type'='checkbox' AND value#>>'{}' NOT IN ('true','false') THEN RAISE EXCEPTION 'Choose a valid checkbox value'; END IF;
   IF f->>'type'='number' AND value#>>'{}' !~ '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN RAISE EXCEPTION 'Enter a valid number'; END IF;
   IF f->>'type'='email' AND value#>>'{}' !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN RAISE EXCEPTION 'Enter a valid email'; END IF;
   IF f->>'type'='table' THEN
    changes:=(value#>>'{}')::jsonb;
    IF jsonb_typeof(changes)<>'array' OR jsonb_array_length(changes)>50 THEN RAISE EXCEPTION 'Enter valid table rows'; END IF;
    FOR t IN SELECT * FROM jsonb_array_elements(changes) LOOP
     IF jsonb_typeof(t)<>'array' OR jsonb_array_length(t)<>jsonb_array_length(coalesce(f->'columns','[]'::jsonb)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(t) cell WHERE jsonb_typeof(cell)<>'string' OR length(cell#>>'{}')>1000) THEN RAISE EXCEPTION 'Enter valid table cells'; END IF;
    END LOOP;
   END IF;
  END IF;
  vals:=jsonb_set(vals,ARRAY[key],value,true);
 END LOOP;
 d:=jsonb_set(d,'{values}',vals);
 SELECT coalesce(p.full_name,'Employee') INTO actor_name FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=own_user AND u.tenant_id=c.tenant_id;
 next_pm:=coalesce(c.data->'pmChanges','[]'::jsonb);
 IF signing THEN
  IF NOT app.lc_v9_signature_valid(p_signature) OR octet_length(p_signature::text)>524288 THEN RAISE EXCEPTION 'Confirm consent and provide your signature'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'blocks') b CROSS JOIN LATERAL regexp_matches(coalesce(b->>'text',''),'\{([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?)\}','g') AS token(parts) WHERE coalesce(vals->>(parts[1]),app.personnel_completion_render_values(d)->>(parts[1]),d->'mergeValues'->>(parts[1]),'')='') THEN RAISE EXCEPTION 'Complete missing document fields before signing'; END IF;
  FOR f IN SELECT * FROM jsonb_array_elements(d->'fields') LOOP
   IF coalesce((f->>'required')::boolean,false) AND (f->'when' IS NULL OR f->'when'='null'::jsonb OR vals->>(f->'when'->>'field')=f->'when'->>'value') AND (length(trim(coalesce(vals->>(f->>'id'),'')))=0 OR f->>'type'='checkbox' AND vals->>(f->>'id')<>'true' OR f->>'type'='table' AND vals->>(f->>'id')='[]') THEN RAISE EXCEPTION 'Complete required fields before signing'; END IF;
   IF f->>'owner'='employee' AND f->>'pmKey' IS NOT NULL AND (f->'when' IS NULL OR f->'when'='null'::jsonb OR vals->>(f->'when'->>'field')=f->'when'->>'value') AND coalesce(vals->>(f->>'id'),'')<>coalesce(d->'mergeValues'->>(f->>'pmKey'),'')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(next_pm) x WHERE x->>'documentId'=p_document AND x->>'field'=f->>'pmKey') THEN
    next_pm:=next_pm||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'documentId',p_document,'field',f->>'pmKey','before',coalesce(d->'mergeValues'->>(f->>'pmKey'),''),'after',coalesce(vals->>(f->>'id'),''),'status','proposed','sourceRevision',c.data->>'sourceRevision'));
   END IF;
  END LOOP;
  SELECT x INTO cfg FROM lc_v9_config conf,jsonb_array_elements(conf.data->'templates') x WHERE conf.tenant_id=c.tenant_id AND x->>'id'=d->>'templateId';
  IF cfg IS NULL THEN RAISE EXCEPTION 'Template not available'; END IF;
  next_status:=CASE WHEN coalesce(d->>'hrStep',cfg->>'hrStep')='after' THEN 'countersign' WHEN coalesce(d->>'employeeAck',cfg->>'employeeAck')='true' THEN 'acknowledged' ELSE 'signed' END;
  d:=d||jsonb_build_object('status',next_status,'employeeSignature',jsonb_build_object('by',jsonb_build_object('id',own_user,'name',actor_name),'at',now(),'method',p_signature->>'method','value',p_signature->>'value','consent',true));
 END IF;
 FOR changes IN SELECT * FROM jsonb_array_elements(c.data->'documents') LOOP next_docs:=next_docs||jsonb_build_array(CASE WHEN changes->>'id'=p_document THEN d ELSE changes END); END LOOP;
 FOR t IN SELECT * FROM jsonb_array_elements(c.data->'tasks') LOOP
  IF signing AND next_status IN ('signed','acknowledged') AND t->>'documentTemplate'=d->>'templateId' AND t->>'documentAction' IN ('signed','completed') THEN t:=t||jsonb_build_object('status','done')||CASE WHEN is_native THEN jsonb_build_object('completedAt',now(),'completedBy',own_user) ELSE '{}'::jsonb END; END IF;
  next_tasks:=next_tasks||jsonb_build_array(t);
 END LOOP;
 changes:=jsonb_build_object('id',gen_random_uuid(),'at',now(),'actor',jsonb_build_object('id',own_user,'name',actor_name),'action',CASE WHEN signing THEN 'document.signed' ELSE 'document.saved' END,'detail',d->>'name');
 IF is_native THEN
  INSERT INTO lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data) VALUES(c.tenant_id,c.id,c.company_id,c.revision,native_case.data);
  INSERT INTO lc_onboarding_private_revision(tenant_id,case_id,company_id,revision,data) VALUES(c.tenant_id,c.id,c.company_id,c.revision,native_private);
  UPDATE lc_onboarding_case SET revision=c.revision+1,updated_at=now(),data=native_case.data||jsonb_build_object('tasks',next_tasks,'history',coalesce(native_case.data->'history','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',now(),'by',own_user,'name',actor_name,'action',CASE WHEN signing THEN 'document.signed' ELSE 'document.saved' END,'detail',d->>'name'))) WHERE id=c.id AND tenant_id=c.tenant_id;
  UPDATE lc_onboarding_private SET data=jsonb_set(native_private,'{lifecycleV9}',(native_private->'lifecycleV9')||jsonb_build_object('documents',next_docs,'pmChanges',next_pm,'log',coalesce(c.data->'log','[]'::jsonb)||jsonb_build_array(changes))) WHERE case_id=c.id AND tenant_id=c.tenant_id;
 ELSE
  INSERT INTO lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id) VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data,own_user);
  UPDATE lc_v9_case SET revision=c.revision+1,updated_at=now(),data=c.data||jsonb_build_object('revision',c.revision+1,'documents',next_docs,'tasks',next_tasks,'pmChanges',next_pm,'log',(c.data->'log')||jsonb_build_array(changes)) WHERE id=c.id;
 END IF;
 RETURN c.employment_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.v9_document_route_validate_append(p_before jsonb,p_after jsonb,p_document jsonb) RETURNS void
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
   IF coalesce(nullif(p_document->'values'->>token,''),nullif(app.personnel_completion_render_values(p_document)->>token,''),nullif(p_document->'mergeValues'->>token,'')) IS NULL THEN RAISE EXCEPTION 'A document merge field is missing';END IF;
  END LOOP;
 ELSE RAISE EXCEPTION 'Unsupported signing action';END IF;
END $$;

--> statement-breakpoint
-- Administrative return custody falls back only to the case owner already frozen by the subject adapter.
-- A null step holder stays null and cannot act on its pending Review/Sign step.
CREATE OR REPLACE FUNCTION app.document_signing_owner(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s jsonb:=app.document_signing_owner_step(p_data);
BEGIN
 IF s IS NOT NULL AND nullif(s->>'holderId','') IS NOT NULL THEN RETURN (s->>'holderId')::uuid;END IF;
 IF jsonb_typeof(p_data->'routing') IS DISTINCT FROM 'object' THEN RETURN NULL;END IF;
 RETURN nullif(p_data->'routing'->>'caseOwnerId','')::uuid;
END $$;
