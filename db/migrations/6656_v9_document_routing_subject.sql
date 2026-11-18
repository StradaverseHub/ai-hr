-- V9 embeds the shared signing kernel on its existing saved-document owner.
-- No historical template/document is rewritten and a Personnel draft never needs a fake employment.
CREATE FUNCTION app.v9_signing_current_actor() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND EXISTS(
  SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
$$;
CREATE FUNCTION app.v9_document_content_hash(d jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to((jsonb_build_object('templateId',d->'templateId','version',d->'version','blocks',d->'blocks','fields',d->'fields','values',d->'values','edits',d->'edits','mergeValues',coalesce(d->'mergeValues','{}'::jsonb))||CASE WHEN jsonb_typeof(d->'personnelSourceReference')='object' THEN jsonb_build_object('personnelSourceReference',d->'personnelSourceReference') ELSE '{}'::jsonb END)::text,'UTF8')),'hex')
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
CREATE FUNCTION app.v9_document_route_sources(p_case uuid DEFAULT NULL) RETURNS TABLE(case_id uuid,revision integer,company_id uuid,employment_id uuid,person_id uuid,is_native boolean,number text,state text,document jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT c.id,c.revision,c.company_id,c.employment_id,e.person_id,false,c.number,c.data->>'state',d
 FROM lc_v9_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'documents','[]'::jsonb)) d
 WHERE c.tenant_id=app.current_tenant_id() AND (p_case IS NULL OR c.id=p_case) AND jsonb_typeof(d->'signing')='object'
 UNION ALL
 SELECT c.id,c.revision,c.company_id,c.employment_id,(c.data->>'personId')::uuid,true,c.data->>'number',c.data->>'state',d
 FROM lc_onboarding_case c JOIN lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.data->'lifecycleV9'->'documents','[]'::jsonb)) d
 WHERE c.tenant_id=app.current_tenant_id() AND (p_case IS NULL OR c.id=p_case) AND jsonb_typeof(d->'signing')='object'
  AND p.data->'lifecycleV9Subject'->>'personId' IS NOT DISTINCT FROM c.data->>'personId'
  AND p.data->'lifecycleV9Subject'->>'employmentId' IS NOT DISTINCT FROM c.employment_id::text
$$;
CREATE FUNCTION app.v9_document_signing_work(p_search text DEFAULT '',p_offset integer DEFAULT 0,p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH actor AS MATERIALIZED(SELECT app.current_user_id() AS uid,app.v9_signing_current_actor() AS allowed),
 entitled AS MATERIALIZED(SELECT m.company_id FROM tenant_module m JOIN tenant t ON t.id=m.tenant_id WHERE m.tenant_id=app.current_tenant_id() AND m.module_code='lifecycle' AND m.status IN('active','trial') AND m.activated_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now()) AND t.status IN('active','trial')),
 visible AS (
  SELECT s.* FROM app.v9_document_route_sources() s CROSS JOIN actor WHERE actor.allowed
   AND EXISTS(SELECT 1 FROM entitled WHERE entitled.company_id IS NULL OR entitled.company_id=s.company_id)
   AND (app.document_signing_owner(s.document->'signing')=actor.uid OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.document->'signing'->'route'->'steps') frozen WHERE frozen->>'holderId'=actor.uid::text) OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.document->'signing'->'actions') receipt WHERE receipt->>'actorId'=actor.uid::text)) AND s.document->>'status' NOT IN('withdrawn','superseded')
   AND position(lower(left(coalesce(p_search,''),100)) IN lower(s.number||' '||(s.document->>'name')))>0
 ), page AS(SELECT * FROM visible ORDER BY document->>'createdAt',case_id,document->>'id' LIMIT least(50,greatest(1,p_limit)) OFFSET greatest(0,least(1000000,p_offset)))
 SELECT jsonb_build_object('total',(SELECT count(*) FROM visible),'items',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'caseId',case_id,'caseRevision',revision,'number',number,'state',state,'documentId',document->>'id','name',document->>'name',
  'signing',document->'signing','document',CASE WHEN app.v9_document_route_content_visible(document) THEN document ELSE NULL END)
  ORDER BY document->>'createdAt',case_id,document->>'id') FROM page),'[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION app.v9_signing_current_actor(),app.v9_document_content_hash(jsonb),app.v9_document_route_complete(jsonb),app.v9_document_route_signatures(jsonb),app.v9_document_route_participant(jsonb),app.v9_document_route_content_visible(jsonb),app.v9_document_route_sources(uuid),app.v9_document_signing_work(text,integer,integer) FROM PUBLIC;
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
DECLARE a jsonb;step jsonb;uid uuid:=app.current_user_id();person uuid;actor_name text;i integer;n integer:=jsonb_array_length(p_before->'actions');kind text;f jsonb;field_value text;token text;
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
   field_value:=coalesce(p_document->'values'->>(f->>'id'),'');
   IF f->>'required'='true' AND (btrim(field_value)='' OR f->>'type'='checkbox' AND field_value<>'true' OR f->>'type'='table' AND field_value='[]') THEN RAISE EXCEPTION 'Required document fields are incomplete';END IF;
   IF field_value<>'' AND (f->>'type'='select' AND NOT f->'options' ? field_value OR f->>'type'='checkbox' AND field_value NOT IN('true','false') OR f->>'type'='number' AND field_value !~ '^-?[0-9]+(\.[0-9]+)?$' OR f->>'type'='email' AND field_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') THEN RAISE EXCEPTION 'A document field has an invalid value';END IF;
  END LOOP;
  FOR token IN SELECT DISTINCT m[1] FROM jsonb_array_elements(p_document->'blocks') b CROSS JOIN LATERAL regexp_matches(coalesce(p_document->'edits'->>(b->>'id'),b->>'text','')||' '||coalesce(b->>'rows','')||' '||coalesce(b->>'label',''),'\{([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)?)\}','g') m LOOP
   IF coalesce(nullif(p_document->'values'->>token,''),nullif(p_document->'mergeValues'->>token,'')) IS NULL THEN RAISE EXCEPTION 'A document merge field is missing';END IF;
  END LOOP;
 ELSE RAISE EXCEPTION 'Unsupported signing action';END IF;
END $$;
REVOKE ALL ON FUNCTION app.v9_document_route_validate_append(jsonb,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.v9_document_route_validate_append(jsonb,jsonb,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- Private canonical source owner for the offered Personnel fields. No case payload supplies an official value.
CREATE FUNCTION app.v9_document_personnel_source_unchecked(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c lc_v9_case;n lc_onboarding_case;e employment;p person;draft employee_draft;a assignment;co company;st employee_statutory_my;
 native boolean:=false;f jsonb;profile jsonb;source_values jsonb;case_values jsonb;cfg jsonb;company_config jsonb;field jsonb;k text;v text;supervisor_id uuid;reporting_id uuid;business_unit_id uuid;source_day date;source_basis text:='current';exit_event uuid;exit_sequence bigint;exit_count integer;supervisor_name text;join_day date;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 SELECT * INTO c FROM lc_v9_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN
  SELECT * INTO n FROM lc_onboarding_case WHERE id=p_case AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN NULL;END IF;
  native:=true;c.company_id:=n.company_id;c.employment_id:=n.employment_id;c.tenant_id:=n.tenant_id;c.data:=n.data;f:=coalesce(n.data->'local','{}'::jsonb)||coalesce(n.data->'source','{}'::jsonb);
 ELSE f:=c.data->'facts';END IF;
 SELECT * INTO co FROM company WHERE id=c.company_id AND tenant_id=c.tenant_id;
 SELECT data INTO cfg FROM lc_v9_config WHERE tenant_id=c.tenant_id;
 IF c.employment_id IS NOT NULL THEN
  SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id;IF NOT FOUND OR e.company_id IS DISTINCT FROM co.id THEN RAISE EXCEPTION 'Personnel source no longer belongs to this case company';END IF;
  SELECT * INTO p FROM person WHERE id=e.person_id AND tenant_id=c.tenant_id;
  source_day:=greatest(day,e.hired_on);
  SELECT * INTO a FROM assignment WHERE employment_id=e.id AND tenant_id=c.tenant_id AND superseded_at IS NULL AND valid_from<=greatest(day,e.hired_on) AND (valid_to IS NULL OR valid_to>greatest(day,e.hired_on)) ORDER BY valid_from DESC,id LIMIT 1;
  business_unit_id:=(nullif(app.company_org_employment_unchecked(e.id,greatest(day,e.hired_on))->>'businessUnitId',''))::uuid;
  SELECT r.manager_employment_id,r.id INTO supervisor_id,reporting_id FROM reporting_line r WHERE r.tenant_id=c.tenant_id AND r.subordinate_employment_id=e.id AND r.line_type='administrative' AND r.superseded_at IS NULL AND r.valid_from<=day AND (r.valid_to IS NULL OR r.valid_to>day) ORDER BY r.valid_from DESC,r.id LIMIT 1;
  -- The movement owner closes versions on the exact exit date. Sequence ties mirror movementExitVersion;
  -- ambiguous/replaced exit lineage fails closed instead of choosing a UUID or an unrelated later version.
  IF e.terminated_on IS NOT NULL AND e.terminated_on<=day THEN
   source_day:=e.terminated_on;source_basis:='unresolved-exit';
   SELECT count(*)::integer,min(id::text)::uuid,min(sequence) INTO exit_count,exit_event,exit_sequence FROM domain_event WHERE tenant_id=c.tenant_id AND aggregate_type='employment' AND aggregate_id=e.id AND event_type='employment.terminated' AND payload->>'terminationDate'=e.terminated_on::text;
   a:=NULL;supervisor_id:=NULL;reporting_id:=NULL;business_unit_id:=NULL;
   IF exit_count<>1 THEN exit_event:=NULL;exit_sequence:=NULL;END IF;
   IF exit_count=1 THEN
    WITH candidates AS(SELECT av.*,(SELECT max(ev.sequence) FROM domain_event ev WHERE ev.tenant_id=av.tenant_id AND ev.aggregate_id=av.id AND ev.event_type IN('employment.assignment.changed','assignment.transferred')) AS start_sequence FROM assignment av WHERE av.tenant_id=c.tenant_id AND av.employment_id=e.id AND av.superseded_at IS NULL AND av.valid_from<=e.terminated_on AND av.valid_to=e.terminated_on),
     eligible AS(SELECT * FROM candidates WHERE start_sequence IS NULL OR start_sequence<=exit_sequence),latest AS(SELECT * FROM eligible WHERE valid_from=(SELECT max(valid_from) FROM eligible))
    SELECT av.* INTO a FROM assignment av JOIN latest ON latest.id=av.id WHERE (SELECT count(*) FROM latest WHERE start_sequence IS NULL)<=1 ORDER BY latest.start_sequence DESC NULLS LAST LIMIT 1;
    WITH candidates AS(SELECT rv.*,(SELECT max(ev.sequence) FROM domain_event ev WHERE ev.tenant_id=rv.tenant_id AND ev.aggregate_id=rv.id AND ev.event_type='reporting-line.set') AS start_sequence FROM reporting_line rv WHERE rv.tenant_id=c.tenant_id AND rv.subordinate_employment_id=e.id AND rv.line_type='administrative' AND rv.superseded_at IS NULL AND rv.valid_from<=e.terminated_on AND rv.valid_to=e.terminated_on),
     eligible AS(SELECT * FROM candidates WHERE start_sequence IS NULL OR start_sequence<=exit_sequence),latest AS(SELECT * FROM eligible WHERE valid_from=(SELECT max(valid_from) FROM eligible))
    SELECT manager_employment_id,id INTO supervisor_id,reporting_id FROM latest WHERE (SELECT count(*) FROM latest WHERE start_sequence IS NULL)<=1 ORDER BY start_sequence DESC NULLS LAST LIMIT 1;
    IF a.id IS NOT NULL THEN source_basis:='exit-boundary';business_unit_id:=a.business_unit_id;END IF;
   END IF;
  END IF;
  IF co.country='MY' THEN SELECT * INTO st FROM employee_statutory_my WHERE person_id=p.id AND tenant_id=c.tenant_id;END IF;
  profile:=jsonb_build_object('fullName',p.full_name,'primaryEmail',p.primary_email,'icNumber',st.ic_number,'passportNumber',st.passport_number,'race',p.race,'religion',p.religion,'nationality',p.nationality,'gender',p.gender,'maritalStatus',p.marital_status,'phone',p.phone,'homePhone',p.home_phone,'personalEmail',p.personal_email,
   'address',coalesce(nullif(p.address,''),concat_ws(', ',nullif(p.permanent_address_line1,''),nullif(p.permanent_address_line2,''),nullif(p.permanent_address_line3,''),nullif(p.permanent_postcode,''),nullif(p.permanent_city,''),nullif(p.permanent_state,''),nullif(p.permanent_country,''))));
  join_day:=CASE WHEN native THEN coalesce(e.join_date,e.hired_on) ELSE e.hired_on END;
 ELSE
  SELECT * INTO draft FROM employee_draft WHERE id=n.source_draft_id AND tenant_id=n.tenant_id AND company_id=n.company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'The authoritative Personnel draft is unavailable';END IF;
  source_basis:='draft';source_day:=day;
  profile:=coalesce(draft.data->'profile','{}'::jsonb);profile:=profile||jsonb_build_object('address',concat_ws(', ',nullif(profile->>'permanentAddressLine1',''),nullif(profile->>'permanentAddressLine2',''),nullif(profile->>'permanentAddressLine3',''),nullif(profile->>'permanentPostcode',''),nullif(profile->>'permanentCity',''),nullif(profile->>'permanentState',''),nullif(profile->>'permanentCountry','')));
  a.department_id:=(nullif(draft.data->'employment'->>'departmentId',''))::uuid;a.position_id:=(nullif(draft.data->'employment'->>'positionId',''))::uuid;supervisor_id:=(nullif(draft.data->'employment'->>'reportingManagerEmploymentId',''))::uuid;
  join_day:=(nullif(draft.data->'employment'->>'hiredOn',''))::date;
  SELECT d.business_unit_id INTO business_unit_id FROM department d WHERE d.id=a.department_id AND d.tenant_id=c.tenant_id;
 END IF;
 SELECT mp.full_name INTO supervisor_name FROM employment me JOIN person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id WHERE me.id=supervisor_id AND me.tenant_id=c.tenant_id;
 source_values:=jsonb_build_object('employee.empNo',coalesce(e.employee_code,draft.reserved_employee_code,profile->>'employeeCode',''),'employee.name',coalesce(profile->>'fullName',''),'employee.icNo',coalesce(profile->>'icNumber',''),'employee.passportNo',coalesce(profile->>'passportNumber',''),
  'race',coalesce(profile->>'race',''),'religion',coalesce(profile->>'religion',''),'nationality',coalesce(profile->>'nationality',''),'gender',upper(left(coalesce(profile->>'gender',''),1))||substring(coalesce(profile->>'gender','') from 2),'marital',upper(left(coalesce(profile->>'maritalStatus',''),1))||substring(coalesce(profile->>'maritalStatus','') from 2),
  'mobile',coalesce(profile->>'phone',''),'homePhone',coalesce(profile->>'homePhone',''),'personalEmail',coalesce(profile->>'personalEmail',''),'address',coalesce(profile->>'address',''),'email',coalesce(profile->>'primaryEmail',''),
  'company.name',coalesce(co.legal_name,''),'employee.department',coalesce((SELECT name FROM department WHERE id=a.department_id AND tenant_id=c.tenant_id),''),'employee.position',coalesce((SELECT title FROM position WHERE id=a.position_id AND tenant_id=c.tenant_id),''),'employee.supervisor',coalesce(supervisor_name,''),'joiner.joinDate',coalesce(to_char(join_day,'DD/MM/YYYY'),''),'leaver.lastDay',CASE WHEN native THEN '' ELSE coalesce(to_char(nullif(f->>'lastDay','')::date,'DD/MM/YYYY'),'') END);
 SELECT value INTO company_config FROM jsonb_array_elements(coalesce(cfg->'companies','[]'::jsonb)) configured WHERE configured->>'companyId'=co.id::text;
 source_values:=source_values||jsonb_build_object('company.regNo',coalesce(company_config->'letterhead'->>'registrationNo',co.registration_no,''),'company.address',coalesce(company_config->'letterhead'->>'address',concat_ws(', ',nullif(trim(co.address_line1),''),nullif(trim(co.address_line2),''),nullif(trim(co.address_line3),''),nullif(trim(co.postcode),''),nullif(trim(co.city),''),nullif(trim(co.state),''),nullif(trim(co.address_country),''))),'company.color',coalesce(company_config->'letterhead'->>'color','#4F46E5'),
 'signatory.name',coalesce((SELECT mp.full_name FROM app_user u JOIN person mp ON mp.id=u.person_id AND mp.tenant_id=u.tenant_id WHERE u.id::text=company_config->>'signatoryUserId' AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)),''),'signatory.title',coalesce(cfg->'signatoryTitles'->>(company_config->>'signatoryUserId'),company_config->>'signatoryTitle',''));
 source_values:=source_values||jsonb_build_object('name',source_values->>'employee.name','empNo',source_values->>'employee.empNo','icNo',source_values->>'employee.icNo','passportNo',source_values->>'employee.passportNo','company',source_values->>'company.name','position',source_values->>'employee.position');
 case_values:=coalesce(c.data->'caseValues','{}'::jsonb)||CASE WHEN native THEN jsonb_build_object('name',source_values->>'employee.name','empNo',source_values->>'employee.empNo','joinInput',join_day,'position',source_values->>'employee.position','dept',source_values->>'employee.department','company',co.legal_name,'group',coalesce((SELECT name FROM business_unit WHERE id=business_unit_id AND tenant_id=c.tenant_id),''),'supervisor',supervisor_name,'ta',coalesce((SELECT mp.full_name FROM app_user u JOIN person mp ON mp.id=u.person_id AND mp.tenant_id=u.tenant_id WHERE u.id::text=c.data->'local'->>'taUserId' AND u.tenant_id=c.tenant_id),''),'hireType',c.data->>'hiring','replacing',c.data->>'replacedEmployee','email',coalesce(c.data->>'caseContactEmail',source_values->>'email'),'floor',c.data->>'floor','costCentre',f->>'costCentre','icNo',source_values->>'employee.icNo','passportNo',source_values->>'employee.passportNo','notes',c.data->>'notes')
 ELSE jsonb_build_object('empNo',source_values->>'employee.empNo','lastDay',f->>'lastDay','supervisor',supervisor_name,'type',f->>'caseType','notice',f->>'noticeDate','revokeMode',coalesce(c.data->>'revokeMode',CASE WHEN c.data->>'revokeDate'=f->>'lastDay' THEN 'lastday' ELSE 'date' END),'revokeDate',c.data->>'revokeDate') END;
 SELECT data INTO cfg FROM lc_v9_config WHERE tenant_id=c.tenant_id;
 FOR k,v IN SELECT key,value FROM jsonb_each_text(case_values) LOOP
  IF k IN('joinInput','lastDay','notice','revokeDate') OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(cfg->'caseForms'->CASE WHEN native THEN 'onb' ELSE 'off' END,'[]'::jsonb)) AS cf(configured) WHERE cf.configured->>'key'=k AND cf.configured->>'type'='date') THEN
   IF v ~ '^\d{4}-\d{2}-\d{2}$' THEN v:=to_char(v::date,'DD/MM/YYYY');ELSE v:='';END IF;
  END IF;
  source_values:=source_values||jsonb_build_object('case.'||k,coalesce(v,''));
 END LOOP;
 RETURN source_values||jsonb_build_object('_companyId',co.id,'_employmentId',c.employment_id,'_personId',coalesce(e.person_id,(nullif(n.data->>'personId',''))::uuid),'_country',co.country,'_sourceBasis',source_basis,'_sourceAsOf',source_day,'_assignmentId',a.id,'_reportingLineId',reporting_id,'_exitEventId',exit_event);
END $$;
REVOKE ALL ON FUNCTION app.v9_document_personnel_source_unchecked(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.v9_document_personnel_values(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE company_id uuid;native boolean:=false;owner_call boolean:=app.current_user_id() IS NULL AND (session_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper));
BEGIN
 SELECT c.company_id INTO company_id FROM lc_v9_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN SELECT c.company_id INTO company_id FROM lc_onboarding_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id();native:=true;END IF;
 IF company_id IS NULL OR NOT(owner_call OR app.v9_signing_current_actor() AND app.is_admin_for(company_id) AND CASE WHEN native THEN app.onboarding_v9_case_actor() AND coalesce(app.onboarding_v9_sections()->>'hr'='view',false) ELSE app.lc_v9_off_access(company_id) END) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM lc_v9_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND e.company_id<>c.company_id) OR EXISTS(SELECT 1 FROM lc_onboarding_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND e.company_id<>c.company_id) THEN RETURN NULL;END IF;
 IF NOT owner_call AND (NOT app.access_workforce_projection_company(company_id) OR EXISTS(SELECT 1 FROM employment e WHERE e.id=(SELECT c.employment_id FROM lc_v9_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() UNION ALL SELECT n.employment_id FROM lc_onboarding_case n WHERE n.id=p_case AND n.tenant_id=app.current_tenant_id() LIMIT 1) AND e.tenant_id=app.current_tenant_id() AND NOT app.access_workforce_employment(e.id,'workforce.view'))) THEN RETURN NULL;END IF;
 IF NOT owner_call AND NOT EXISTS(SELECT 1 FROM company visible_company WHERE visible_company.tenant_id=app.current_tenant_id() AND app.personnel_identity_search_permitted(visible_company.id)) THEN RETURN (app.v9_document_personnel_source_unchecked(p_case)-ARRAY['personalEmail','employee.icNo','employee.passportNo','icNo','passportNo','case.icNo','case.passportNo'])||jsonb_build_object('_identityFieldsWithheld','true');END IF;
 RETURN app.v9_document_personnel_source_unchecked(p_case);
END $$;
REVOKE ALL ON FUNCTION app.v9_document_personnel_values(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.v9_document_personnel_values(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.v9_document_personnel_reference(p_source jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('version',1,'basis',p_source->>'_sourceBasis','asOf',p_source->>'_sourceAsOf','assignmentId',p_source->'_assignmentId','reportingLineId',p_source->'_reportingLineId','exitEventId',p_source->'_exitEventId')
$$;
REVOKE ALL ON FUNCTION app.v9_document_personnel_reference(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.v9_document_personnel_reference(jsonb) TO ai_hr_app;
--> statement-breakpoint
-- The trigger invokes private kernel validators as its owner; caller authority remains the session actor.
-- A SECURITY DEFINER source writer cannot impersonate a true owner session.
CREATE FUNCTION app.v9_document_route_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_docs jsonb;new_docs jsonb;d jsonb;prior jsonb;definition jsonb;version jsonb;cfg jsonb;native_cfg jsonb;c lc_onboarding_case;facts jsonb;company uuid;subject_person uuid;admin boolean;step jsonb;spec jsonb;who jsonb;group_row jsonb;routing jsonb;candidate_row jsonb;selected_group text;possible text[];holder text;employee_user text;supervisor_user text;signature jsonb;body_changed boolean;content_edit boolean;source_case uuid;source_employment uuid;personnel_source jsonb;field jsonb;source_key text;expected text;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT (session_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper)) THEN RAISE EXCEPTION 'Document tenant mismatch';END IF;
 IF TG_TABLE_NAME='lc_onboarding_private' THEN
  source_case:=NEW.case_id;
  old_docs:=CASE WHEN TG_OP='INSERT' THEN '[]'::jsonb ELSE coalesce(OLD.data->'lifecycleV9'->'documents','[]'::jsonb) END;new_docs:=coalesce(NEW.data->'lifecycleV9'->'documents','[]'::jsonb);
  SELECT * INTO c FROM lc_onboarding_case WHERE id=NEW.case_id AND tenant_id=NEW.tenant_id;
  source_employment:=c.employment_id;company:=c.company_id;facts:=coalesce(c.data->'local','{}'::jsonb)||coalesce(c.data->'source','{}'::jsonb);subject_person:=(c.data->>'personId')::uuid;
  admin:=app.is_admin_for(company) AND (app.onboarding_page_access() OR app.onboarding_v9_case_actor() OR app.is_group_admin());
 ELSE
  source_case:=NEW.id;source_employment:=NEW.employment_id;
  old_docs:=CASE WHEN TG_OP='INSERT' THEN '[]'::jsonb ELSE coalesce(OLD.data->'documents','[]'::jsonb) END;new_docs:=coalesce(NEW.data->'documents','[]'::jsonb);company:=NEW.company_id;facts:=NEW.data->'facts';subject_person:=(facts->>'personId')::uuid;admin:=app.lc_v9_off_access(company);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(old_docs||new_docs) candidate_document WHERE jsonb_typeof(candidate_document->'signing')='object') THEN RETURN NEW;END IF;
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
    IF d->'fields' IS DISTINCT FROM prior->'fields' OR d->'blocks' IS DISTINCT FROM prior->'blocks' OR d->'mergeValues' IS DISTINCT FROM prior->'mergeValues' OR d->>'templateId' IS DISTINCT FROM prior->>'templateId' OR d->'version' IS DISTINCT FROM prior->'version' THEN RAISE EXCEPTION 'Frozen source fields and document structure cannot be replaced';END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(prior->'fields') configured_field WHERE configured_field->>'owner'='pmLocked' AND d->'values'->(configured_field->>'id') IS DISTINCT FROM prior->'values'->(configured_field->>'id')) THEN RAISE EXCEPTION 'Personnel source fields are locked';END IF;
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
