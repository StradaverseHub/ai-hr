-- Import of saved offline Probation Evaluation Forms (form v22.9.26), lane J of the Probation Confirmation build
-- (handoff §5 Part C items 1-2). Tag 5762 / idx 5162 / when 1793330005462, assigned by the build coordinator.
--
-- The application reads only the JSON block script#form-data of the uploaded HTML (lib/probation-intake-html.ts) and
-- hands the validated values here, one file per transaction. Nothing here executes or renders the file.
--
--  1. probation_form_import (owner only, forced row security, no application grant): the original file bytes with their
--     SHA-256, the validated values, and what the import did. One row per employment, file content and case (a
--     re-upload of the same file is answered "unchanged"; the same file uploaded again once the case exists merges).
--  2. app.probation_form_import(company, employee ID, name, bytes, values) (granted to ai_hr_app): under the shared
--     workforce barrier (app.probation_write_lock), finds the employee by Employee ID in the company and requires the
--     existing intake authority on that employment (its actual PBP or GBS reviewer, app.probation_role), as the intake
--     stage and evidence functions do. The file's employee name must match Personnel. Then:
--       - a case exists: "merged". The original file is kept against the case and the import is written to the case
--         history (domain_event probation.html_form_imported). For each Part the file started or signed whose case Part
--         is open, the file's values fill the Line Manager's and the employee's drafts only where those drafts are still
--         blank and unsubmitted (in-system work always wins; prior drafts are kept in probation_revision). No signature,
--         submission, state, outcome or completed-offline record is created: signing stays an in-system human act, and
--         completed offline still needs the original signed PDF (the existing PDF evidence path).
--       - no case: the existing eligibility rules decide (app.probation_intake_exclusion, the Personnel source, published
--         settings; a new starter in a live company opens automatically). An eligible employment is "staged": the file
--         and its values wait in intake, shown to the PBP in the employee's intake review, and the case itself opens
--         only through the reviewed cut-over (the strict activation is unchanged).
--       - otherwise "refused" with a code; nothing is written.
--  3. app.probation_form_imports(company) (granted): the latest imports the reader may review (bounded).
--  4. app.probation_form_import_read(import) (granted): the original bytes for download, with the same authority.
-- No existing table, row, function, grant or purpose-owned object changes.
CREATE TABLE public.probation_form_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  company_id uuid NOT NULL,
  employment_id uuid NOT NULL REFERENCES public.employment(id),
  case_id uuid REFERENCES public.probation_case(id),
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 200),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 2097152),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  form_version text NOT NULL CHECK (form_version = '22.9.26'),
  form_values jsonb NOT NULL CHECK (jsonb_typeof(form_values) = 'object'),
  result text NOT NULL CHECK (result IN ('merged','staged')),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'array'),
  imported_by uuid NOT NULL REFERENCES public.app_user(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((result = 'merged') = (case_id IS NOT NULL)),
  CONSTRAINT probation_form_import_company_tenant_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION
);
--> statement-breakpoint
CREATE UNIQUE INDEX probation_form_import_once ON public.probation_form_import (tenant_id, employment_id, content_hash, coalesce(case_id, '00000000-0000-0000-0000-000000000000'::uuid));
--> statement-breakpoint
CREATE INDEX probation_form_import_company ON public.probation_form_import (tenant_id, company_id, imported_at DESC, id);
--> statement-breakpoint
ALTER TABLE public.probation_form_import ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.probation_form_import FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY probation_form_import_owner ON public.probation_form_import FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.probation_form_import FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_form_import(p_company uuid,p_employee_code text,p_name text,p_content bytea,p_form jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 t uuid:=app.current_tenant_id();e employment;c probation_case;prior probation_form_import;p probation_part;
 v_hash text;v_id uuid;v_person text;v_file text;exclusion text;source jsonb;v_settings jsonb;criteria jsonb;stage jsonb;
 n integer;matches integer;draft jsonb;patch jsonb;meta jsonb;assessed jsonb;applied jsonb:='[]';filled text[];changed boolean;
 v_summary jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 IF app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in intake reviewer is required' USING ERRCODE='42501';END IF;
 IF p_company IS NULL OR p_content IS NULL OR octet_length(p_content) NOT BETWEEN 1 AND 2097152 THEN RAISE EXCEPTION 'Supply one saved form of at most 2 MB' USING ERRCODE='22023';END IF;
 v_file:=btrim(coalesce(p_name,''));
 IF length(v_file) NOT BETWEEN 1 AND 200 OR length(btrim(coalesce(p_employee_code,''))) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'Supply the file name and the Employee ID read from it' USING ERRCODE='22023';END IF;
 IF jsonb_typeof(p_form) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Supply the validated form values' USING ERRCODE='22023';END IF;
 IF octet_length(p_form::text)>1048576 OR p_form->>'formVersion' IS DISTINCT FROM '22.9.26' THEN RAISE EXCEPTION 'Only validated form v22.9.26 values can be imported' USING ERRCODE='22023';END IF;
 IF jsonb_typeof(p_form->'parts') IS DISTINCT FROM 'object' OR jsonb_typeof(p_form->'employee') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Supply the validated form values' USING ERRCODE='22023';END IF;
 IF app.probation_company_entitled(p_company) IS NOT TRUE THEN RETURN jsonb_build_object('result','refused','code','not_entitled');END IF;

 -- The employee: by Employee ID in this company (exact, then one case-insensitive match), within the intake authority.
 SELECT * INTO e FROM employment WHERE tenant_id=t AND company_id=p_company AND employee_code=btrim(p_employee_code) AND voided_at IS NULL AND import_pending_attempt_id IS NULL;
 IF e.id IS NULL THEN
  SELECT count(*) INTO matches FROM (SELECT 1 FROM employment WHERE tenant_id=t AND company_id=p_company AND upper(employee_code)=upper(btrim(p_employee_code)) AND voided_at IS NULL AND import_pending_attempt_id IS NULL LIMIT 2) found;
  IF matches=1 THEN SELECT * INTO e FROM employment WHERE tenant_id=t AND company_id=p_company AND upper(employee_code)=upper(btrim(p_employee_code)) AND voided_at IS NULL AND import_pending_attempt_id IS NULL;END IF;
 END IF;
 IF e.id IS NULL THEN RETURN jsonb_build_object('result','refused','code','no_employee');END IF;
 IF coalesce(app.probation_role(e.id,'pbp'),false) IS NOT TRUE AND coalesce(app.probation_role(e.id,'gbs'),false) IS NOT TRUE THEN RETURN jsonb_build_object('result','refused','code','no_employee');END IF;
 SELECT full_name INTO v_person FROM person WHERE id=e.person_id AND tenant_id=e.tenant_id;
 IF lower(regexp_replace(btrim(coalesce(v_person,'')),'\s+',' ','g')) IS DISTINCT FROM lower(regexp_replace(btrim(coalesce(p_form->'employee'->>'name','')),'\s+',' ','g')) THEN
  RETURN jsonb_build_object('result','refused','code','name_mismatch','employmentId',e.id);
 END IF;

 v_hash:=encode(sha256(p_content),'hex');
 SELECT * INTO c FROM probation_case WHERE tenant_id=t AND employment_id=e.id;
 SELECT * INTO prior FROM probation_form_import WHERE tenant_id=t AND employment_id=e.id AND content_hash=v_hash AND case_id IS NOT DISTINCT FROM c.id ORDER BY imported_at,id LIMIT 1;
 IF prior.id IS NOT NULL THEN RETURN jsonb_build_object('result','unchanged','previous',prior.result,'importId',prior.id,'caseId',prior.case_id,'employmentId',e.id);END IF;

 IF c.id IS NULL THEN
  -- No case: the existing intake eligibility decides; the case opens only through the reviewed cut-over.
  exclusion:=app.probation_intake_exclusion(e.id);
  IF exclusion IS NOT NULL THEN RETURN jsonb_build_object('result','refused','code','excluded','reason',exclusion,'employmentId',e.id);END IF;
  source:=app.probation_personnel_source(e.id);
  IF source->>'explicitNoProbation'='true' OR source->>'confirmationOn' IS NOT NULL OR source->>'resignationOn' IS NOT NULL OR source->>'terminatedOn' IS NOT NULL THEN RETURN jsonb_build_object('result','refused','code','excluded','reason','not_eligible','employmentId',e.id);END IF;
  IF source->>'employmentType' IS NOT NULL AND source->>'employmentType'<>'full_time' THEN RETURN jsonb_build_object('result','refused','code','excluded','reason','employment_type','employmentId',e.id);END IF;
  SELECT data INTO v_settings FROM probation_configuration WHERE tenant_id=t AND company_id=e.company_id AND kind='settings' AND state='published' ORDER BY version DESC LIMIT 1;
  IF v_settings IS NULL THEN RETURN jsonb_build_object('result','refused','code','no_settings','employmentId',e.id);END IF;
  IF EXISTS(SELECT 1 FROM probation_activation a WHERE a.tenant_id=t AND a.company_id=e.company_id AND a.enabled AND coalesce(e.join_date,e.hired_on)>=a.activation_on) THEN
   RETURN jsonb_build_object('result','refused','code','opens_automatically','employmentId',e.id);
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('part',k,'status',coalesce(p_form->'parts'->(k::text)->>'status','not_started'),'applied','staged') ORDER BY k),'[]') INTO v_summary FROM generate_series(1,3) k;
  INSERT INTO probation_form_import(tenant_id,company_id,employment_id,case_id,file_name,content,content_hash,form_version,form_values,result,summary,imported_by)
   VALUES(t,e.company_id,e.id,NULL,v_file,p_content,v_hash,'22.9.26',p_form,'staged',v_summary,app.current_user_id()) RETURNING id INTO v_id;
  INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
   VALUES(t,'probation',v_id,'probation.html_form_staged','user'::actor_type,app.current_user_id(),e.id,jsonb_build_object('importId',v_id,'employmentId',e.id,'fileName',v_file,'contentHash',v_hash,'formVersion','22.9.26','parts',v_summary));
  RETURN jsonb_build_object('result','staged','importId',v_id,'employmentId',e.id,'parts',v_summary);
 END IF;

 -- A case exists: merge into it.
 IF c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN RETURN jsonb_build_object('result','refused','code','case_closed','caseId',c.id,'employmentId',e.id);END IF;
 SELECT CASE WHEN jsonb_typeof(data->'criteria')='array' THEN data->'criteria' ELSE '[]'::jsonb END INTO criteria FROM probation_configuration WHERE id=c.form_id AND tenant_id=t;
 criteria:=coalesce(criteria,'[]'::jsonb);
 FOR n IN 1..3 LOOP
  stage:=p_form->'parts'->(n::text);
  IF jsonb_typeof(stage) IS DISTINCT FROM 'object' THEN CONTINUE;END IF;
  IF coalesce(stage->>'status','not_started') NOT IN('signed','started') THEN applied:=applied||jsonb_build_array(jsonb_build_object('part',n,'status','not_started','applied','nothing'));CONTINUE;END IF;
  SELECT * INTO p FROM probation_part WHERE case_id=c.id AND tenant_id=t AND coalesce(data->>'documentKind','review')='review' AND data->>'type'=n::text
   AND data->>'cycle'=(CASE WHEN n=3 THEN coalesce(c.data->>'extensionCount','0') ELSE '0' END) FOR UPDATE;
  IF p.id IS NULL THEN applied:=applied||jsonb_build_array(jsonb_build_object('part',n,'status',stage->>'status','applied','no_part'));CONTINUE;END IF;
  IF p.data->>'state' IN('not_issued','recorded','locked','completed_offline','cancelled') THEN applied:=applied||jsonb_build_array(jsonb_build_object('part',n,'status',stage->>'status','applied','part_not_open','partId',p.id));CONTINUE;END IF;
  filled:='{}';changed:=false;meta:=p.data;
  -- The employee's self-assessment (Parts 2 and 3) and comments, while unsubmitted and blank.
  SELECT data INTO draft FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=t AND rater='employee' FOR UPDATE;
  patch:='{}'::jsonb;
  IF draft IS NOT NULL AND n>1 AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'managerSubmittedAt' IS NULL
     AND jsonb_typeof(stage->'employee')='object' AND stage->'employee'<>'{}'::jsonb
     AND NOT EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(draft->'employee')='object' THEN draft->'employee' ELSE '{}'::jsonb END) x
      WHERE jsonb_typeof(x.value)='object' AND (x.value->>'rating' IS NOT NULL OR coalesce(x.value->>'evidence','')<>'')) THEN
   SELECT coalesce(jsonb_object_agg(cr->>'id',jsonb_build_object(
     'rating',CASE WHEN coalesce(stage->'employee'->(cr->>'id')->>'rating','')~'^[1-5]$' THEN (stage->'employee'->(cr->>'id')->>'rating')::integer ELSE NULL END,
     'evidence',left(coalesce(stage->'employee'->(cr->>'id')->>'evidence',''),5000))),'{}'::jsonb) INTO assessed
    FROM jsonb_array_elements(criteria) cr WHERE jsonb_typeof(cr)='object' AND cr->>'id' IS NOT NULL;
   patch:=patch||jsonb_build_object('employee',assessed);filled:=filled||'employee_self_assessment'::text;
  END IF;
  IF draft IS NOT NULL AND p.data->>'acknowledgedAt' IS NULL AND coalesce(draft->>'employeeComments','')='' AND coalesce(stage->>'employeeComments','')<>'' THEN
   patch:=patch||jsonb_build_object('employeeComments',left(stage->>'employeeComments',5000));filled:=filled||'employee_comments'::text;
  END IF;
  IF patch<>'{}'::jsonb THEN
   INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(t,p.id,'employee',p.revision,draft,app.current_user_id(),'Filled from an imported saved form') ON CONFLICT DO NOTHING;
   UPDATE probation_rater_draft SET data=data||patch,updated_at=now() WHERE part_id=p.id AND tenant_id=t AND rater='employee';changed:=true;
  END IF;
  -- The Line Manager's fields, while unsubmitted (Part 1: until the KPIs are acknowledged) and blank.
  SELECT data INTO draft FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=t AND rater='lm' FOR UPDATE;
  patch:='{}'::jsonb;
  IF draft IS NOT NULL AND p.data->>'managerSubmittedAt' IS NULL AND NOT(n=1 AND c.data->>'kpiAcknowledged'='true')
     AND NOT EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(draft->'manager')='object' THEN draft->'manager' ELSE '{}'::jsonb END) x
      WHERE jsonb_typeof(x.value)='object' AND (x.value->>'rating' IS NOT NULL OR coalesce(x.value->>'evidence','')<>''))
     AND jsonb_array_length(CASE WHEN jsonb_typeof(draft->'kpis')='array' THEN draft->'kpis' ELSE '[]'::jsonb END)=0
     AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(draft->'support')='object' THEN draft->'support' ELSE '{}'::jsonb END) s WHERE coalesce(s.value,'')<>'')
     AND coalesce(draft->>'strengths','')='' AND coalesce(draft->>'development','')='' AND coalesce(draft->>'managerComments','')='' AND coalesce(draft->>'justification','')=''
     AND draft->>'outcome' IS NULL AND draft->>'midpointStatus' IS NULL THEN
   IF n=1 THEN
    IF jsonb_typeof(stage->'kpis')='array' THEN
     IF jsonb_array_length(stage->'kpis') BETWEEN 1 AND 5 THEN
      SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid()::text,'accountability',left(coalesce(kpi->>'accountability',''),1000),'measure',left(coalesce(kpi->>'measure',''),1000),'target',left(coalesce(kpi->>'target',''),1000),'targetDate',CASE WHEN coalesce(kpi->>'targetDate','')~'^\d{4}-\d{2}-\d{2}$' THEN kpi->>'targetDate' ELSE '' END) ORDER BY pos) INTO assessed
       FROM jsonb_array_elements(stage->'kpis') WITH ORDINALITY AS kpi_rows(kpi,pos) WHERE jsonb_typeof(kpi)='object';
      IF assessed IS NOT NULL THEN patch:=patch||jsonb_build_object('kpis',assessed);filled:=filled||'kpis'::text;END IF;
     END IF;
    END IF;
    IF jsonb_typeof(stage->'support')='object' THEN
     IF EXISTS(SELECT 1 FROM jsonb_each(stage->'support') s WHERE s.key IN('coaching','access','checkins','other') AND jsonb_typeof(s.value)='string' AND s.value<>'""'::jsonb) THEN
      patch:=patch||jsonb_build_object('support',jsonb_build_object('coaching',left(coalesce(stage->'support'->>'coaching',''),2000),'access',left(coalesce(stage->'support'->>'access',''),2000),'checkins',left(coalesce(stage->'support'->>'checkins',''),2000),'other',left(coalesce(stage->'support'->>'other',''),2000)));
      filled:=filled||'support'::text;
     END IF;
    END IF;
   ELSE
    IF jsonb_typeof(stage->'manager')='object' AND stage->'manager'<>'{}'::jsonb THEN
     SELECT coalesce(jsonb_object_agg(cr->>'id',jsonb_build_object(
       'rating',CASE WHEN coalesce(stage->'manager'->(cr->>'id')->>'rating','')~'^[1-5]$' THEN (stage->'manager'->(cr->>'id')->>'rating')::integer ELSE NULL END,
       'evidence',left(coalesce(stage->'manager'->(cr->>'id')->>'evidence',''),5000))),'{}'::jsonb) INTO assessed
      FROM jsonb_array_elements(criteria) cr WHERE jsonb_typeof(cr)='object' AND cr->>'id' IS NOT NULL;
     patch:=patch||jsonb_build_object('manager',assessed);filled:=filled||'manager_assessment'::text;
    END IF;
    IF coalesce(stage->>'strengths','')<>'' THEN patch:=patch||jsonb_build_object('strengths',left(stage->>'strengths',5000));filled:=filled||'strengths'::text;END IF;
    IF coalesce(stage->>'development','')<>'' THEN patch:=patch||jsonb_build_object('development',left(stage->>'development',5000));filled:=filled||'development'::text;END IF;
    IF n=2 AND coalesce(stage->>'managerComments','')<>'' THEN patch:=patch||jsonb_build_object('managerComments',left(stage->>'managerComments',5000));filled:=filled||'manager_comments'::text;END IF;
    IF n=2 AND coalesce(stage->>'midpointStatus','') IN('satisfactory','development','at_risk') THEN patch:=patch||jsonb_build_object('midpointStatus',stage->>'midpointStatus');filled:=filled||'midpoint_status'::text;END IF;
    IF n=3 AND coalesce(stage->>'outcome','') IN('confirm','extend','not_confirm','other') THEN patch:=patch||jsonb_build_object('outcome',stage->>'outcome');filled:=filled||'outcome'::text;END IF;
    IF n=3 AND coalesce(stage->>'justification','')<>'' THEN patch:=patch||jsonb_build_object('justification',left(stage->>'justification',5000));filled:=filled||'justification'::text;END IF;
    IF coalesce(p.data->>'reviewOn','')='' AND coalesce(stage->>'reviewOn','')~'^\d{4}-\d{2}-\d{2}$' THEN meta:=jsonb_set(meta,'{reviewOn}',to_jsonb(stage->>'reviewOn'));filled:=filled||'review_date'::text;END IF;
   END IF;
  END IF;
  IF patch<>'{}'::jsonb THEN
   INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(t,p.id,'lm',p.revision,draft,app.current_user_id(),'Filled from an imported saved form') ON CONFLICT DO NOTHING;
   UPDATE probation_rater_draft SET data=data||patch,updated_at=now() WHERE part_id=p.id AND tenant_id=t AND rater='lm';changed:=true;
  END IF;
  IF changed OR meta IS DISTINCT FROM p.data THEN
   UPDATE probation_part SET data=meta,revision=revision+1,content_revision=content_revision+1,updated_at=now() WHERE id=p.id AND tenant_id=t;
  END IF;
  applied:=applied||jsonb_build_array(jsonb_build_object('part',n,'status',stage->>'status','applied',CASE WHEN cardinality(filled)>0 THEN 'draft_filled' ELSE 'kept_system_values' END,'fields',to_jsonb(filled),'partId',p.id));
 END LOOP;
 INSERT INTO probation_form_import(tenant_id,company_id,employment_id,case_id,file_name,content,content_hash,form_version,form_values,result,summary,imported_by)
  VALUES(t,c.company_id,e.id,c.id,v_file,p_content,v_hash,'22.9.26',p_form,'merged',applied,app.current_user_id()) RETURNING id INTO v_id;
 UPDATE probation_case SET revision=revision+1,updated_at=now() WHERE id=c.id AND tenant_id=t;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(t,'probation',c.id,'probation.html_form_imported','user'::actor_type,app.current_user_id(),e.id,jsonb_build_object('caseId',c.id,'action','html_form_imported','importId',v_id,'fileName',v_file,'contentHash',v_hash,'formVersion','22.9.26','parts',applied));
 RETURN jsonb_build_object('result','merged','importId',v_id,'caseId',c.id,'employmentId',e.id,'parts',applied);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_form_imports(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL OR app.probation_company_entitled(p_company) IS NOT TRUE THEN RETURN '[]'::jsonb;END IF;
 RETURN (SELECT coalesce(jsonb_agg(item ORDER BY imported_at DESC,id),'[]'::jsonb) FROM (
  SELECT jsonb_build_object('id',i.id,'fileName',i.file_name,'contentHash',i.content_hash,'formVersion',i.form_version,'result',i.result,'employmentId',i.employment_id,'caseId',i.case_id,
    'employeeCode',e.employee_code,'employeeName',coalesce(person.full_name,''),'importedAt',i.imported_at,'importedBy',coalesce(actor.full_name,''),'summary',i.summary) AS item,i.imported_at,i.id
  FROM (SELECT * FROM probation_form_import recent WHERE recent.tenant_id=t AND recent.company_id=p_company ORDER BY recent.imported_at DESC,recent.id LIMIT 1000) i
  JOIN employment e ON e.id=i.employment_id AND e.tenant_id=i.tenant_id
  LEFT JOIN person ON person.id=e.person_id AND person.tenant_id=e.tenant_id
  LEFT JOIN app_user u ON u.id=i.imported_by AND u.tenant_id=i.tenant_id
  LEFT JOIN person actor ON actor.id=u.person_id AND actor.tenant_id=u.tenant_id
  WHERE coalesce(app.probation_role(i.employment_id,'pbp'),false) OR coalesce(app.probation_role(i.employment_id,'gbs'),false)
  ORDER BY i.imported_at DESC,i.id LIMIT 200) visible);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_form_import_read(p_import uuid) RETURNS TABLE(original_name text,original_content bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i probation_form_import;
BEGIN
 SELECT * INTO i FROM probation_form_import WHERE id=p_import AND tenant_id=app.current_tenant_id();
 IF i.id IS NULL OR app.current_user_id() IS NULL OR app.probation_company_entitled(i.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'The imported form is unavailable in your scope' USING ERRCODE='42501';END IF;
 IF coalesce(app.probation_role(i.employment_id,'pbp'),false) IS NOT TRUE AND coalesce(app.probation_role(i.employment_id,'gbs'),false) IS NOT TRUE THEN RAISE EXCEPTION 'The imported form is unavailable in your scope' USING ERRCODE='42501';END IF;
 IF i.content_hash IS DISTINCT FROM encode(sha256(i.content),'hex') THEN RAISE EXCEPTION 'The stored original changed' USING ERRCODE='XX001';END IF;
 RETURN QUERY SELECT i.file_name,i.content;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_form_import(uuid,text,text,bytea,jsonb),app.probation_form_imports(uuid),app.probation_form_import_read(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_form_import(uuid,text,text,bytea,jsonb),app.probation_form_imports(uuid),app.probation_form_import_read(uuid) TO ai_hr_app;
