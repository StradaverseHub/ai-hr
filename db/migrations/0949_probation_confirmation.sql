-- Approved probation domain. Additive; no existing onb/off rows, definitions or history are rewritten.
CREATE TABLE probation_access (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 user_id uuid NOT NULL REFERENCES app_user(id),company_id uuid NOT NULL REFERENCES company(id),
 business_unit_id uuid REFERENCES business_unit(id),department_id uuid REFERENCES department(id),
 role text NOT NULL CHECK(role IN('admin','pbp','gbs')),valid_from date NOT NULL,valid_to date,
 reason text NOT NULL CHECK(length(btrim(reason))>=3),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(valid_to IS NULL OR valid_to>=valid_from),UNIQUE(tenant_id,id)
);
CREATE TABLE probation_configuration (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 kind text NOT NULL CHECK(kind IN('settings','form','route')),version integer NOT NULL CHECK(version>0),
 state text NOT NULL CHECK(state IN('draft','published','retired')),data jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_user(id),published_by uuid REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,
 UNIQUE(tenant_id,company_id,kind,version),UNIQUE(tenant_id,id)
);
CREATE TABLE probation_activation (
 tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 enabled boolean NOT NULL DEFAULT false,activation_on date,dry_run_digest text,approved_by uuid REFERENCES app_user(id),
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,company_id),CHECK(NOT enabled OR activation_on IS NOT NULL AND approved_by IS NOT NULL AND dry_run_digest~'^[a-f0-9]{64}$')
);
CREATE TABLE probation_case (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 employment_id uuid NOT NULL REFERENCES employment(id),source_key text NOT NULL,revision integer NOT NULL DEFAULT 1,
 settings_id uuid NOT NULL REFERENCES probation_configuration(id),form_id uuid NOT NULL REFERENCES probation_configuration(id),route_id uuid NOT NULL REFERENCES probation_configuration(id),
 data jsonb NOT NULL CHECK(NOT data?'parts'),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,employment_id),UNIQUE(tenant_id,source_key),UNIQUE(tenant_id,id),CHECK(revision>0),CHECK(data->>'id'=id::text AND data->>'employmentId'=employment_id::text AND data->>'companyId'=company_id::text)
);
CREATE TABLE probation_part (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES probation_case(id),
 revision integer NOT NULL DEFAULT 1,content_revision integer NOT NULL DEFAULT 1,
 data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),CHECK(revision>0 AND content_revision>0),CHECK(data->>'id'=id::text),
 CHECK(NOT(data ?| ARRAY['employee','manager','employeeComments','kpis','support','strengths','development','managerComments','outcome','midpointStatus','justification','extensionMonths']))
);
-- Separate physical payloads prevent direct SELECT from exposing the other rater's drafts.
CREATE TABLE probation_rater_draft (
 part_id uuid NOT NULL REFERENCES probation_part(id),tenant_id uuid NOT NULL REFERENCES tenant(id),rater text NOT NULL CHECK(rater IN('employee','lm')),
 data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(part_id,rater)
);
CREATE TABLE probation_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),part_id uuid NOT NULL REFERENCES probation_part(id),
 rater text NOT NULL CHECK(rater IN('employee','lm','meta')),revision integer NOT NULL,data jsonb NOT NULL,
 actor_user_id uuid REFERENCES app_user(id),reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(part_id,rater,revision)
);
CREATE TABLE probation_followup (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES probation_case(id),
 actor_user_id uuid NOT NULL REFERENCES app_user(id),content_revision integer NOT NULL DEFAULT 1,kind text NOT NULL CHECK(kind IN('followup','development','extension_recommendation','nonconfirmation_recommendation','refusal_request','refusal_confirmed')),
 note text NOT NULL CHECK(length(btrim(note))>=3),part_id uuid REFERENCES probation_part(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE probation_file (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES probation_case(id),part_id uuid REFERENCES probation_part(id),
 kind text NOT NULL CHECK(kind IN('offline','completed_part','letter_draft','letter_released')),revision integer NOT NULL,
 name text NOT NULL,mime_type text NOT NULL DEFAULT 'application/pdf' CHECK(mime_type='application/pdf'),content bytea NOT NULL,
 content_hash text NOT NULL CHECK(content_hash~'^[a-f0-9]{64}$'),employee_document_id uuid REFERENCES employee_document(id),
 created_by uuid REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,case_id,part_id,kind,revision)
);
CREATE TABLE probation_outcome (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),case_id uuid NOT NULL REFERENCES probation_case(id),tenant_id uuid NOT NULL REFERENCES tenant(id),part_id uuid NOT NULL UNIQUE REFERENCES probation_part(id),
 outcome text NOT NULL CHECK(outcome IN('confirm','extend','not_confirm','other')),revision integer NOT NULL,
 template_id text,template_version integer,merge_data jsonb,letter_file_id uuid REFERENCES probation_file(id),
 state text NOT NULL CHECK(state IN('pending','draft','awaiting_release','released','movement_done','handoff_done','completed','failed')),
 released_by uuid REFERENCES app_user(id),released_at timestamptz,movement_ref text,handoff_ref uuid,
 failure text,source_key text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,source_key)
);
CREATE TABLE probation_occurrence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES probation_case(id),part_id uuid REFERENCES probation_part(id),
 source_key text NOT NULL,kind text NOT NULL,due_on date NOT NULL,recipient_user_ids jsonb NOT NULL,state text NOT NULL CHECK(state IN('ready','scheduled','cancelled','delivered','review')),
 source_revision integer NOT NULL,delivery_ref text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,source_key)
);
CREATE TABLE probation_cutover (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 data jsonb NOT NULL,digest text NOT NULL,actor_user_id uuid NOT NULL REFERENCES app_user(id),applied_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION app.probation_active_user() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id));
$$;
CREATE FUNCTION app.probation_config_admin(p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_active_user() AND EXISTS(SELECT 1 FROM probation_access a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.role='admin' AND app.is_company_descendant(p_company,a.company_id) AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) AND app.is_admin_for(p_company);
$$;
CREATE FUNCTION app.probation_user_for(p_employment uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN count(*)=1 THEN (array_agg(u.id))[1] ELSE NULL END FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
$$;
CREATE FUNCTION app.probation_holders(p_employment uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;a assignment;v_lm uuid;v_hod uuid;v_pbp uuid;v_pbp_count integer;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 SELECT * INTO e FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN '{}'::jsonb;END IF;
 SELECT * INTO a FROM assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND superseded_at IS NULL AND valid_from<=day AND (valid_to IS NULL OR valid_to>day) ORDER BY valid_from DESC,id LIMIT 1;
 v_lm:=app.probation_user_for(app.performance_current_admin_manager(e.tenant_id,e.id));
 SELECT app.probation_user_for(d.head_employment_id) INTO v_hod FROM department d WHERE d.id=a.department_id AND d.tenant_id=e.tenant_id;
 WITH candidates AS(SELECT p.user_id,CASE WHEN p.department_id IS NOT NULL THEN 3 WHEN p.business_unit_id IS NOT NULL THEN 2 ELSE 1 END AS specificity FROM probation_access p JOIN app_user u ON u.id=p.user_id AND u.tenant_id=p.tenant_id WHERE p.tenant_id=e.tenant_id AND p.role='pbp' AND app.is_company_descendant(e.company_id,p.company_id) AND (p.department_id IS NULL OR p.department_id=a.department_id) AND (p.business_unit_id IS NULL OR p.business_unit_id=a.business_unit_id) AND p.valid_from<=day AND (p.valid_to IS NULL OR p.valid_to>=day) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)), winners AS(SELECT DISTINCT user_id FROM candidates WHERE specificity=(SELECT max(specificity) FROM candidates)) SELECT count(*),CASE WHEN count(*)=1 THEN (array_agg(user_id))[1] ELSE NULL END INTO v_pbp_count,v_pbp FROM winners;
 RETURN jsonb_build_object('employee',app.probation_user_for(e.id),'lm',v_lm,'hod',v_hod,'pbp',v_pbp,'pbpAmbiguous',v_pbp_count>1,'companyId',e.company_id,'departmentId',a.department_id,'businessUnitId',a.business_unit_id);
END $$;
CREATE FUNCTION app.probation_role(p_employment uuid,p_role text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h jsonb;co uuid;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF NOT app.probation_active_user() THEN RETURN false;END IF;
 h:=app.probation_holders(p_employment);co:=(h->>'companyId')::uuid;IF co IS NULL THEN RETURN false;END IF;
 IF p_role IN('employee','lm','hod','pbp') THEN RETURN h->>p_role=app.current_user_id()::text;END IF;
 IF p_role='gbs' THEN RETURN app.is_admin_for(co) AND EXISTS(SELECT 1 FROM probation_access a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.role='gbs' AND app.is_company_descendant(co,a.company_id) AND a.valid_from<=day AND (a.valid_to IS NULL OR a.valid_to>=day));END IF;
 RETURN false;
END $$;
CREATE FUNCTION app.probation_storage_runner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NULL AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolname='ai_hr_owner' OR rolsuper));
$$;
CREATE FUNCTION app.probation_case_access(p_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM probation_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND (app.probation_storage_runner() OR app.probation_role(c.employment_id,'employee') OR app.probation_role(c.employment_id,'lm') OR app.probation_role(c.employment_id,'hod') OR app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')));
$$;
CREATE FUNCTION app.probation_part_access(p_part uuid,p_rater text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;e uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RETURN false;END IF;
 SELECT employment_id INTO e FROM probation_case WHERE id=p.case_id AND tenant_id=app.current_tenant_id();
 IF p.data->>'documentKind'='letter' THEN RETURN app.probation_storage_runner() OR app.probation_role(e,'pbp') OR app.probation_role(e,'gbs') OR EXISTS(SELECT 1 FROM document_signing_document d CROSS JOIN LATERAL jsonb_array_elements(d.data->'route'->'steps') st WHERE d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id AND st->>'holderId'=app.current_user_id()::text AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') prior WHERE (prior->>'stage')::integer<(st->>'stage')::integer AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=prior->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash')));END IF;
 IF p_rater IS NULL OR app.probation_role(e,'pbp') OR app.probation_role(e,'gbs') THEN RETURN true;END IF;
 IF p_rater='employee' THEN RETURN app.probation_role(e,'employee') OR p.data->>'staffSubmittedAt' IS NOT NULL;END IF;
 IF p_rater='lm' THEN RETURN app.probation_role(e,'lm') OR p.data->>'managerSubmittedAt' IS NOT NULL;END IF;
 RETURN false;
END $$;
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['probation_access','probation_configuration','probation_activation','probation_case','probation_part','probation_rater_draft','probation_revision','probation_followup','probation_file','probation_outcome','probation_occurrence','probation_cutover'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY probation_owner ON %I FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner())',n);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,ai_hr_app',n);EXECUTE format('GRANT SELECT ON %I TO ai_hr_app',n);
 END LOOP;END $$;
CREATE POLICY probation_access_read ON probation_access FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (user_id=app.current_user_id() OR app.probation_config_admin(company_id)));
CREATE POLICY probation_config_read ON probation_configuration FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (app.probation_config_admin(company_id) OR state='published' AND EXISTS(SELECT 1 FROM probation_case c WHERE c.tenant_id=probation_configuration.tenant_id AND (c.settings_id=probation_configuration.id OR c.form_id=probation_configuration.id OR c.route_id=probation_configuration.id) AND app.probation_case_access(c.id))));
CREATE POLICY probation_activation_read ON probation_activation FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (enabled OR app.probation_config_admin(company_id)));
CREATE POLICY probation_case_read ON probation_case FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_case_access(id));
CREATE POLICY probation_part_read ON probation_part FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_part_access(id));
CREATE POLICY probation_rater_read ON probation_rater_draft FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_part_access(part_id,rater));
CREATE POLICY probation_revision_read ON probation_revision FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (rater='meta' AND app.probation_part_access(part_id) OR rater<>'meta' AND app.probation_part_access(part_id,rater)));
CREATE POLICY probation_followup_read ON probation_followup FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_case_access(case_id));
CREATE POLICY probation_file_read ON probation_file FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_case_access(case_id) AND (kind<>'letter_draft' OR EXISTS(SELECT 1 FROM probation_case c WHERE c.id=case_id AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')))));
CREATE POLICY probation_outcome_read ON probation_outcome FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_case_access(case_id) AND (state IN('released','movement_done','handoff_done','completed') OR EXISTS(SELECT 1 FROM probation_case c WHERE c.id=case_id AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')))));
CREATE POLICY probation_occurrence_read ON probation_occurrence FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_case_access(case_id));
CREATE POLICY probation_cutover_read ON probation_cutover FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_config_admin(company_id));
CREATE TABLE probation_delegate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),part_id uuid NOT NULL REFERENCES probation_part(id),
 step_id text NOT NULL,holder_id uuid NOT NULL REFERENCES app_user(id),represented_id uuid REFERENCES app_user(id),kind text NOT NULL CHECK(kind IN('delegation','holder_changed','missing_holder')),
 reason text NOT NULL,created_by uuid NOT NULL REFERENCES app_user(id),valid_from date NOT NULL,valid_to date,created_at timestamptz NOT NULL DEFAULT now(),CHECK(length(btrim(reason))>=3)
);
ALTER TABLE probation_delegate ENABLE ROW LEVEL SECURITY;ALTER TABLE probation_delegate FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_owner ON probation_delegate FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY probation_delegate_read ON probation_delegate FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_part_access(part_id));
REVOKE ALL ON probation_delegate FROM PUBLIC,ai_hr_app;GRANT SELECT ON probation_delegate TO ai_hr_app;
CREATE FUNCTION app.probation_assert_runtime(p_company uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND enabled AND activation_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) THEN RAISE EXCEPTION 'Probation runtime is not activated for this company';END IF;
END $$;
CREATE FUNCTION app.probation_audit(p_case uuid,p_part uuid,p_action text,p_reason text DEFAULT '') RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e uuid;
BEGIN
 SELECT employment_id INTO e FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RAISE EXCEPTION 'Probation case unavailable';END IF;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(app.current_tenant_id(),'probation',p_case,'probation.'||p_action,CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),e,jsonb_build_object('caseId',p_case,'partId',p_part,'action',p_action));
END $$;
-- Field-level readers never expose the counterpart's draft, including old revision payloads.
CREATE FUNCTION app.probation_assessment_ready(p_form jsonb,p_values jsonb,p_kpi_evidence boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c jsonb;r jsonb;n numeric;
BEGIN
 IF p_values IS NULL OR jsonb_typeof(p_values)<>'object' THEN RETURN false;END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p_form->'criteria') LOOP
 r:=p_values->(c->>'id');IF r IS NULL OR r->>'rating' IS NULL OR r->>'rating' !~ '^[1-5]$' THEN RETURN false;END IF;n:=(r->>'rating')::numeric;
 IF (n<=2 OR p_kpi_evidence AND c->>'id'='kpi') AND length(btrim(coalesce(r->>'evidence','')))=0 THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION app.probation_score(p_form jsonb,p_values jsonb) RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c jsonb;total integer:=0;
BEGIN
 FOR c IN SELECT value FROM jsonb_array_elements(p_form->'criteria') LOOP
 IF p_values->(c->>'id')->>'rating' IS NULL OR p_values->(c->>'id')->>'rating' !~ '^[1-5]$' THEN RETURN NULL;END IF;
 total:=total+(p_values->(c->>'id')->>'rating')::integer*(c->>'weight')::integer;
 END LOOP;RETURN total;
END $$;
CREATE FUNCTION app.probation_submission_ready(p_part uuid,p_role text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;form jsonb;v jsonb;k jsonb;score integer;band integer;suggestion text;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;SELECT data INTO form FROM probation_configuration WHERE id=c.form_id AND tenant_id=c.tenant_id;
 SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=p.tenant_id AND rater=p_role;
 IF p_role='employee' THEN RETURN (p.data->>'type')::integer<>1 AND app.probation_assessment_ready(form,v->'employee',false) AND (NOT coalesce((form->>'employeeCommentsRequired')::boolean,false) OR length(btrim(coalesce(v->>'employeeComments','')))>0);END IF;
 IF p_role<>'lm' OR v IS NULL THEN RETURN false;END IF;
 IF p.data->>'type'='1' THEN
 IF jsonb_typeof(v->'kpis')<>'array' OR jsonb_array_length(v->'kpis') NOT BETWEEN 1 AND 5 THEN RETURN false;END IF;
 FOR k IN SELECT value FROM jsonb_array_elements(v->'kpis') LOOP IF length(btrim(coalesce(k->>'accountability','')))=0 OR length(btrim(coalesce(k->>'measure','')))=0 OR length(btrim(coalesce(k->>'target','')))=0 OR k->>'targetDate' !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN false;END IF;PERFORM (k->>'targetDate')::date;END LOOP;
 RETURN length(btrim(coalesce(v->'support'->>'coaching','')))>0 AND length(btrim(coalesce(v->'support'->>'access','')))>0 AND length(btrim(coalesce(v->'support'->>'checkins','')))>0 AND length(btrim(coalesce(v->'support'->>'other','')))>0;
 END IF;
 IF NOT app.probation_assessment_ready(form,v->'manager',c.data->>'kpiAcknowledged'<>'true' AND c.data->'config'->>'kpiGate'='warn') OR coalesce(p.data->>'reviewOn','') !~ '^\d{4}-\d{2}-\d{2}$' OR p.data->>'conductedBy' IS NULL THEN RETURN false;END IF;
 PERFORM (p.data->>'reviewOn')::date;
 IF c.data->'config'->>'lmWaitsForEmployee'='true' AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'employeeWaitException' IS NULL THEN RETURN false;END IF;
 score:=app.probation_score(form,v->'manager');SELECT (b->>'band')::integer INTO band FROM jsonb_array_elements(form->'bands') b WHERE score>=(b->>'min')::integer ORDER BY (b->>'min')::integer DESC LIMIT 1;
 IF p.data->>'type'='2' THEN
 IF length(btrim(coalesce(v->>'strengths','')))=0 OR length(btrim(coalesce(v->>'development','')))=0 OR length(btrim(coalesce(v->>'managerComments','')))=0 OR coalesce(v->>'midpointStatus','') NOT IN('satisfactory','development','at_risk') THEN RETURN false;END IF;
 suggestion:=CASE WHEN band>=3 THEN 'satisfactory' WHEN band=2 THEN 'development' ELSE 'at_risk' END;
 RETURN v->>'midpointStatus'=suggestion OR length(btrim(coalesce(v->>'justification','')))>0;
 END IF;
 IF coalesce(v->>'outcome','') NOT IN('confirm','extend','not_confirm','other') OR length(btrim(coalesce(v->>'justification','')))=0 THEN RETURN false;END IF;
 IF v->>'outcome'='extend' AND ((c.data->>'extensionCount')::integer>=2 OR coalesce(v->>'extensionMonths','') NOT IN('3','6')) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN RETURN false;
END $$;
CREATE FUNCTION app.probation_content(p_part uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p.data->>'documentKind'='letter' THEN jsonb_build_object('partId',p.id,'caseId',p.case_id,'generation',p.content_revision,'templateId',p.data->'letterTemplateId','templateVersion',p.data->'letterTemplateVersion','blocks',p.data->'letterBlocks','fields',p.data->'letterFields','merge',p.data->'letterMerge','baseHash',p.data->'letterBaseHash') ELSE jsonb_build_object('caseId',p.case_id,'partId',p.id,'generation',p.content_revision,'formId',c.form_id,'type',p.data->'type','cycle',p.data->'cycle','reviewOn',p.data->'reviewOn','conductedBy',p.data->'conductedBy','personnel',p.data->'signingFacts','period',p.data->'signingPeriod','acknowledgedKpis',p.data->'signingKpis','manager',(SELECT data FROM probation_rater_draft WHERE part_id=p.id AND rater='lm'),'employeeAssessment',(SELECT data->'employee' FROM probation_rater_draft WHERE part_id=p.id AND rater='employee')) END FROM probation_part p JOIN probation_case c ON c.id=p.case_id AND c.tenant_id=p.tenant_id WHERE p.id=p_part AND p.tenant_id=app.current_tenant_id();
$$;
CREATE FUNCTION app.probation_signing_guardrails(p_subject uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN data->>'documentKind'='letter' THEN data->'letterGuardrails' ELSE jsonb_build_object('requiredRoles',jsonb_build_array('lm','employee'))||CASE WHEN data->>'type'='3' THEN jsonb_build_object('independentApprovalFromRole','lm') ELSE '{}'::jsonb END END FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();
$$;
CREATE FUNCTION app.probation_signing_route_allowed(p_subject uuid,p_route jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;h jsonb;step jsonb;expected uuid;delegate probation_delegate;stored document_signing_document;old_step jsonb;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN false;END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;h:=app.probation_holders(c.employment_id);
 IF jsonb_typeof(p_route->'steps')<>'array' OR jsonb_array_length(p_route->'steps')<>jsonb_array_length(p.data->'route'->'steps') THEN RETURN false;END IF;
 SELECT * INTO stored FROM document_signing_document WHERE subject_id=p.id AND subject_type='probation' AND tenant_id=p.tenant_id;
 FOR step IN SELECT value FROM jsonb_array_elements(p_route->'steps') LOOP
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.data->'route'->'steps') old WHERE old->>'id'=step->>'id' AND (old-'holderId'-'representedId'-'holderPersonId')=(step-'holderId'-'representedId'-'holderPersonId')) THEN RETURN false;END IF;
 SELECT old INTO old_step FROM jsonb_array_elements(stored.data->'route'->'steps') old WHERE old->>'id'=step->>'id' AND EXISTS(SELECT 1 FROM jsonb_array_elements(stored.data->'actions') a WHERE a->>'stepId'=old->>'id' AND a->>'action' IN('signed','declined') AND a->>'contentRevision'=stored.data->>'contentRevision' AND a->>'contentHash'=stored.data->>'contentHash') AND stored.data->>'contentHash'=encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex');
 IF old_step IS NOT NULL THEN IF (old_step-'holderPersonId')<>(step-'holderPersonId') THEN RETURN false;END IF;CONTINUE;END IF;
 expected:=(h->>(step->>'role'))::uuid;
 SELECT * INTO delegate FROM probation_delegate WHERE tenant_id=p.tenant_id AND part_id=p.id AND step_id=step->>'id' AND valid_from<=day AND (valid_to IS NULL OR valid_to>=day) ORDER BY created_at DESC,id DESC LIMIT 1;
 IF FOUND THEN expected:=delegate.holder_id;IF step->>'representedId' IS DISTINCT FROM delegate.represented_id::text THEN RETURN false;END IF;END IF;
 IF step->>'holderId' IS DISTINCT FROM expected::text THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION app.probation_signing_access(p_subject uuid,p_operation text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;step jsonb;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_active_user() OR NOT app.probation_case_access(p.case_id) THEN RETURN false;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p_operation='read' THEN RETURN app.probation_part_access(p.id);END IF;
 IF NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled','not_issued') THEN RETURN false;END IF;
 IF p.data->>'documentKind'='letter' THEN
 IF p_operation IN('create','revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs');END IF;
 IF p_operation='sign' THEN RETURN EXISTS(SELECT 1 FROM document_signing_document doc CROSS JOIN LATERAL jsonb_array_elements(doc.data->'route'->'steps') st WHERE doc.tenant_id=p.tenant_id AND doc.subject_type='probation' AND doc.subject_id=p.id AND st->>'holderId'=app.current_user_id()::text AND (app.probation_role(c.employment_id,st->>'role') OR EXISTS(SELECT 1 FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=st->>'id' AND x.holder_id=app.current_user_id() AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))));END IF;RETURN false;END IF;
 IF p_operation='create' THEN RETURN app.probation_role(c.employment_id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation IN('revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR p.data->>'managerSubmittedAt' IS NULL AND app.probation_role(c.employment_id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation='decline' THEN RETURN app.probation_role(c.employment_id,'pbp') AND EXISTS(SELECT 1 FROM probation_followup WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='refusal_request' AND content_revision=p.content_revision) AND p.data->>'managerSubmittedAt' IS NOT NULL;END IF;
 IF p_operation<>'sign' THEN RETURN false;END IF;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 FOR step IN SELECT value FROM jsonb_array_elements(d.data->'route'->'steps') LOOP
 IF step->>'holderId'=app.current_user_id()::text AND (step->>'role' IN('hod','pbp') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='employee' AND app.probation_role(c.employment_id,'employee') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='lm' AND app.probation_role(c.employment_id,'lm') AND p.data->>'managerSubmittedAt' IS NULL AND app.probation_submission_ready(p.id,'lm')) THEN
 IF EXISTS(SELECT 1 FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=step->>'id' AND x.holder_id=app.current_user_id() AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) OR step->>'holderId'=app.probation_holders(c.employment_id)->>(step->>'role') THEN RETURN true;END IF;
 END IF;END LOOP;RETURN false;
END $$;
-- Internal helpers are never callable to manufacture audit/provenance or read private hashes.
REVOKE ALL ON FUNCTION app.probation_audit(uuid,uuid,text,text),app.probation_content(uuid),app.probation_submission_ready(uuid,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_effective_settings(p_settings jsonb,p_facts jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_settings||coalesce((SELECT jsonb_build_object('kpiGate',r->>'kpiGate') FROM jsonb_array_elements(coalesce(p_settings->'overrides','[]')) WITH ORDINALITY rules(r,n) WHERE (r->>'businessGroupId' IS NULL OR r->>'businessGroupId'=p_facts->>'businessGroupId') AND (r->>'businessUnitId' IS NULL OR r->>'businessUnitId'=p_facts->>'businessUnitId') AND (r->>'grade' IS NULL OR r->>'grade'=p_facts->>'grade') AND (r->>'months' IS NULL OR (r->>'months')::integer=coalesce((p_facts->>'probationMonths')::integer,(SELECT n FROM generate_series(1,120) n WHERE ((p_facts->>'startOn')::date+(n::text||' months')::interval-interval '1 day')::date=(p_facts->>'endOn')::date LIMIT 1),CASE WHEN p_facts->>'grade'='H' THEN 3 ELSE (p_settings->>'defaultMonths')::integer END)) ORDER BY num_nonnulls(r->>'businessGroupId',r->>'businessUnitId',r->>'grade',r->>'months') DESC,n DESC LIMIT 1),'{}'::jsonb);
$$;
CREATE FUNCTION app.probation_config_write(p_company uuid,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n integer;v_id uuid;route jsonb;part integer;
BEGIN
 IF NOT app.probation_config_admin(p_company) OR p_kind NOT IN('settings','form','route') OR jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Named probation administrator required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||p_company::text||p_kind,0));
 IF p_expected IS NULL OR p_expected<>(SELECT coalesce(max(version),0) FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind=p_kind) THEN RAISE EXCEPTION 'Probation configuration changed; reload before saving';END IF;
 IF p_publish AND p_kind='form' THEN
 IF p_data?'targetGrades' AND (jsonb_typeof(p_data->'targetGrades')<>'array' OR jsonb_array_length(p_data->'targetGrades')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_data->'targetGrades') g WHERE g NOT IN('12','13','14','15','16','17','18','19','20','21','22','23','H'))) THEN RAISE EXCEPTION 'Choose explicit supported form grades';END IF;
 IF EXISTS(SELECT 1 FROM probation_configuration f WHERE f.tenant_id=app.current_tenant_id() AND f.company_id=p_company AND f.kind='form' AND f.state='published' AND coalesce(f.data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]')<>coalesce(p_data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]') AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(f.data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]')) g WHERE coalesce(p_data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]')?g)) THEN RAISE EXCEPTION 'Form grade variants must be disjoint; revise the same grade set or publish a distinct H form';END IF;
 IF jsonb_typeof(p_data->'criteria') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'criteria') NOT BETWEEN 1 AND 30 OR jsonb_typeof(p_data->'ratingLabels') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'ratingLabels') IS DISTINCT FROM 5 OR jsonb_typeof(p_data->'bands') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'bands') IS DISTINCT FROM 5 THEN RAISE EXCEPTION 'Complete the form criteria, rating labels and bands';END IF;
 IF (SELECT sum((c->>'weight')::integer) FROM jsonb_array_elements(p_data->'criteria') c)<>100 OR (SELECT sum((c->>'weight')::integer) FROM jsonb_array_elements(p_data->'criteria') c WHERE c->>'section'='role')<>50 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'criteria') c WHERE c->>'id' !~ '^[a-z][a-z0-9_]{0,39}$' OR (c->>'weight')::integer NOT BETWEEN 1 AND 100 OR length(btrim(coalesce(c->>'title','')))=0 OR length(btrim(coalesce(c->>'standard','')))=0 OR length(btrim(coalesce(c->>'prompt','')))=0) OR (SELECT count(DISTINCT c->>'id') FROM jsonb_array_elements(p_data->'criteria') c)<>jsonb_array_length(p_data->'criteria') THEN RAISE EXCEPTION 'Form weights, identities and guidance are invalid';END IF;
 END IF;
 IF p_publish AND p_kind='settings' THEN
 IF coalesce(p_data->>'kpiGate','') NOT IN('block','warn','off') OR p_data->>'maxExtensions' IS DISTINCT FROM '2' OR p_data->'extensionMonths' IS DISTINCT FROM '[3,6]'::jsonb OR p_data->>'gradeHEnabled'='true' AND NOT EXISTS(SELECT 1 FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='form' AND state='published' AND data->'targetGrades'?'H') THEN RAISE EXCEPTION 'Check probation settings and Grade H form readiness';END IF;
 END IF;
 IF p_publish AND p_kind='route' THEN
 FOR part IN 1..3 LOOP route:=p_data->'parts'->part::text;IF (SELECT count(*) FROM jsonb_array_elements(route->'steps') s WHERE s->>'role'='lm' AND s->>'kind'='sign')<>1 OR (SELECT count(*) FROM jsonb_array_elements(route->'steps') s WHERE s->>'role'='employee' AND s->>'kind'='acknowledge')<>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') s WHERE s->>'role'='employee' AND (s->>'stage')::integer<=(SELECT (m->>'stage')::integer FROM jsonb_array_elements(route->'steps') m WHERE m->>'role'='lm')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') s WHERE s->>'role' NOT IN('lm','employee') AND (s->>'stage')::integer<=(SELECT (m->>'stage')::integer FROM jsonb_array_elements(route->'steps') m WHERE m->>'role'='lm')) THEN RAISE EXCEPTION 'Probation routes must sign as manager before employee acknowledgement and later approvers';END IF;PERFORM app.document_signing_validate(jsonb_build_object('route',route,'actions','[]'::jsonb),jsonb_build_object('requiredRoles',jsonb_build_array('lm','employee'))||CASE WHEN part=3 THEN jsonb_build_object('independentApprovalFromRole','lm') ELSE '{}'::jsonb END);END LOOP;
 END IF;
 SELECT coalesce(max(version),0)+1 INTO n FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind=p_kind;
 INSERT INTO probation_configuration(tenant_id,company_id,kind,version,state,data,created_by,published_by,published_at) VALUES(app.current_tenant_id(),p_company,p_kind,n,CASE WHEN p_publish THEN 'published' ELSE 'draft' END,jsonb_set(p_data,'{version}',to_jsonb(n)),app.current_user_id(),CASE WHEN p_publish THEN app.current_user_id() END,CASE WHEN p_publish THEN now() END) RETURNING probation_configuration.id INTO v_id;
 RETURN v_id;
END $$;
CREATE FUNCTION app.probation_assign_access(p_company uuid,p_user uuid,p_role text,p_from date,p_to date,p_business_unit uuid,p_department uuid,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
 IF NOT app.probation_config_admin(p_company) OR p_role NOT IN('admin','pbp','gbs') OR p_from IS NULL OR p_to<p_from OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Probation access assignment denied';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_user AND tenant_id=app.current_tenant_id() AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RAISE EXCEPTION 'Choose one active existing login';END IF;
 IF p_business_unit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business_unit WHERE id=p_business_unit AND tenant_id=app.current_tenant_id()) OR p_department IS NOT NULL AND NOT EXISTS(SELECT 1 FROM department WHERE id=p_department AND tenant_id=app.current_tenant_id()) THEN RAISE EXCEPTION 'Invalid probation assignment scope';END IF;
 INSERT INTO probation_access(tenant_id,user_id,company_id,role,valid_from,valid_to,business_unit_id,department_id,reason) VALUES(app.current_tenant_id(),p_user,p_company,p_role,p_from,p_to,p_business_unit,p_department,p_reason) RETURNING probation_access.id INTO v_id;RETURN v_id;
END $$;
CREATE FUNCTION app.probation_blank_assessment(p_form jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_object_agg(c->>'id',jsonb_build_object('rating',NULL,'evidence','')) FROM jsonb_array_elements(p_form->'criteria') c;
$$;
CREATE FUNCTION app.probation_admit(p_record jsonb,p_parts jsonb,p_settings uuid,p_form uuid,p_route uuid,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;c probation_case;part jsonb;form jsonb;settings jsonb;route jsonb;source jsonb;pid uuid;case_uuid uuid:=(p_record->>'id')::uuid;
BEGIN
 SELECT * INTO e FROM employment WHERE id=(p_record->>'employmentId')::uuid AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT(app.probation_role(e.id,'gbs') OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'GBS People Ops authority required for probation intake';END IF;
 SELECT * INTO c FROM probation_case WHERE tenant_id=e.tenant_id AND employment_id=e.id;IF FOUND THEN RETURN c.id;END IF;
 SELECT data INTO settings FROM probation_configuration WHERE id=p_settings AND tenant_id=e.tenant_id AND company_id=e.company_id AND kind='settings' AND state='published';
 SELECT data INTO form FROM probation_configuration WHERE id=p_form AND tenant_id=e.tenant_id AND company_id=e.company_id AND kind='form' AND state='published';
 SELECT data INTO route FROM probation_configuration WHERE id=p_route AND tenant_id=e.tenant_id AND company_id=e.company_id AND kind='route' AND state='published';
 source:=app.probation_personnel_source(e.id);
 IF source->>'explicitNoProbation'='true' OR p_record->>'gradeAtStart' IS DISTINCT FROM source->>'grade' THEN RAISE EXCEPTION 'Personnel eligibility changed';END IF;
 IF NOT(settings->'eligibleGrades'?(source->>'grade')) AND NOT(source->>'grade'='H' AND settings->>'gradeHEnabled'='true' AND settings->>'gradeHFormPublished'='true') THEN RAISE EXCEPTION 'This start-date grade is not eligible';END IF;
 settings:=app.probation_effective_settings(settings,source);
 IF settings IS NULL OR form IS NULL OR route IS NULL OR p_record->>'companyId'<>e.company_id::text OR p_record->'config'<>settings OR p_record->>'startOn'<>coalesce(e.join_date,e.hired_on)::text OR p_record->>'endOn' IS DISTINCT FROM coalesce(e.extended_confirmation_date,e.normal_confirmation_date,e.probation_end_date,e.provisional_end_on,(coalesce(e.join_date,e.hired_on)+(CASE WHEN source->>'grade'='H' THEN '3' ELSE settings->>'defaultMonths' END||' months')::interval-interval '1 day')::date)::text OR e.confirmation_date IS NOT NULL OR e.terminated_on IS NOT NULL OR e.resignation_date IS NOT NULL OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Personnel dates, published versions or eligibility changed; review intake again';END IF;
 IF jsonb_typeof(p_parts)<>'array' OR jsonb_array_length(p_parts) NOT BETWEEN 2 AND 3 OR (SELECT count(*) FROM jsonb_array_elements(p_parts) p WHERE p->>'type'='1')<>1 OR (SELECT count(*) FROM jsonb_array_elements(p_parts) p WHERE p->>'type'='3')<>1 THEN RAISE EXCEPTION 'Invalid probation review plan';END IF;
 INSERT INTO probation_case(id,tenant_id,company_id,employment_id,source_key,settings_id,form_id,route_id,data) VALUES(case_uuid,e.tenant_id,e.company_id,e.id,'employment:'||e.id::text,p_settings,p_form,p_route,(p_record-'parts')||jsonb_build_object('facts',source,'sourceKey','employment:'||e.id::text,'revision',1,'state','kpi_setting','extensionCount',0,'kpiAcknowledged',false,'pendingOutcome',NULL,'workflowIds',coalesce((SELECT jsonb_agg(x.id) FROM (SELECT DISTINCT ON(definition_key) id FROM probation_builder_definition WHERE tenant_id=e.tenant_id AND company_id=e.company_id AND kind='workflow' AND state='published' ORDER BY definition_key,version DESC) x),'[]')));
 FOR part IN SELECT value FROM jsonb_array_elements(p_parts) LOOP
 pid:=(part->>'id')::uuid;
 INSERT INTO probation_part(id,tenant_id,case_id,data) VALUES(pid,e.tenant_id,case_uuid,(part-ARRAY['employee','manager','employeeComments','kpis','support','strengths','development','managerComments','outcome','midpointStatus','justification','extensionMonths'])||jsonb_build_object('state','not_issued','staffSubmittedAt',NULL,'managerSubmittedAt',NULL,'acknowledgedAt',NULL,'cycle',0,'revision',1,'kpiException',NULL,'employeeWaitException',NULL,'pbpExtensionConfirmed',false,'route',route->'parts'->(part->>'type')));
 INSERT INTO probation_rater_draft(part_id,tenant_id,rater,data) VALUES(pid,e.tenant_id,'employee',jsonb_build_object('employee',app.probation_blank_assessment(form),'employeeComments','')),(pid,e.tenant_id,'lm',jsonb_build_object('manager',app.probation_blank_assessment(form),'kpis','[]'::jsonb,'support',jsonb_build_object('coaching','','access','','checkins','','other',''),'strengths','','development','','managerComments','','outcome',NULL,'midpointStatus',NULL,'justification','','extensionMonths',NULL));
 END LOOP;PERFORM app.probation_audit(case_uuid,NULL,'admitted',p_reason);RETURN case_uuid;
END $$;
CREATE FUNCTION app.probation_save_draft(p_part uuid,p_rater text,p_patch jsonb,p_expected integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;previous jsonb;allowed text[];meta jsonb;key text;value jsonb;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Probation review unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;PERFORM app.probation_assert_runtime(c.company_id);
 IF p.revision<>p_expected OR NOT app.probation_role(c.employment_id,p_rater) OR p.data->>'state' IN('not_issued','recorded','locked','completed_offline','cancelled') OR c.data->>'state'='withdrawn' THEN RAISE EXCEPTION 'Only the current field owner can edit this open revision';END IF;
 IF p_rater='employee' THEN
 allowed:=ARRAY['employee','employeeComments'];IF p.data->>'staffSubmittedAt' IS NOT NULL AND p.data->>'managerSubmittedAt' IS NULL THEN RAISE EXCEPTION 'Wait for the manager to submit before acknowledgement';END IF;IF p.data->>'acknowledgedAt' IS NOT NULL OR p.data->>'staffSubmittedAt' IS NOT NULL AND p_patch?'employee' THEN RAISE EXCEPTION 'Submitted self-assessment is locked';END IF;
 ELSE
 IF p.data->>'type'<>'1' AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'employeeWaitException' IS NULL THEN RAISE EXCEPTION 'Wait for the employee self-assessment or a reasoned PBP release';END IF;allowed:=ARRAY['manager','kpis','support','reviewOn','conductedBy','strengths','development','managerComments','outcome','midpointStatus','justification','extensionMonths'];IF p.data->>'managerSubmittedAt' IS NOT NULL OR p.data->>'type'='1' AND c.data->>'kpiAcknowledged'='true' THEN RAISE EXCEPTION 'Submitted manager fields are locked';END IF;
 END IF;
 IF jsonb_typeof(p_patch)<>'object' OR p_patch-allowed<>'{}'::jsonb OR octet_length(p_patch::text)>1000000 THEN RAISE EXCEPTION 'Only fields owned by this rater may change';END IF;
 SELECT data INTO previous FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=p.tenant_id AND rater=p_rater FOR UPDATE;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,p_rater,p.revision,previous,app.current_user_id(),'Draft changed');
 meta:=p.data;
 IF p_patch?'reviewOn' THEN meta:=jsonb_set(meta,'{reviewOn}',p_patch->'reviewOn');END IF;
 IF p_patch?'conductedBy' THEN IF p_patch->>'conductedBy' IS DISTINCT FROM app.current_user_id()::text THEN RAISE EXCEPTION 'Conducted by must be the verified manager';END IF;meta:=jsonb_set(meta,'{conductedBy}',p_patch->'conductedBy');END IF;
 IF p_patch?'manager' AND jsonb_typeof(p_patch->'manager')<>'object' OR p_patch?'employee' AND jsonb_typeof(p_patch->'employee')<>'object' THEN RAISE EXCEPTION 'Invalid assessment';END IF;
 UPDATE probation_rater_draft SET data=data||(p_patch-ARRAY['reviewOn','conductedBy']),updated_at=now() WHERE part_id=p.id AND rater=p_rater AND tenant_id=p.tenant_id;
 UPDATE probation_part SET data=meta,revision=revision+1,content_revision=content_revision+CASE WHEN p_patch-'employeeComments'<>'{}'::jsonb THEN 1 ELSE 0 END,updated_at=now() WHERE id=p.id;
 UPDATE probation_case SET revision=revision+1,updated_at=now() WHERE id=c.id;PERFORM app.probation_audit(c.id,p.id,'draft_saved');RETURN p.revision+1;
END $$;
CREATE FUNCTION app.probation_signing_content(p_subject uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;d document_signing_document;fingerprint text;next_revision integer:=1;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.probation_case_access(p.case_id) OR coalesce(p.data->>'documentKind','review')='review' AND NOT(p.data?'signingFacts') THEN RETURN NULL;END IF;
 fingerprint:=encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex');
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 IF FOUND THEN next_revision:=(d.data->>'contentRevision')::integer+CASE WHEN d.data->>'contentHash'=fingerprint THEN 0 ELSE 1 END;END IF;
 RETURN jsonb_build_object('contentHash',fingerprint,'contentRevision',next_revision,'companyId',(SELECT company_id FROM probation_case WHERE id=p.case_id),'employmentId',(SELECT employment_id FROM probation_case WHERE id=p.case_id));
END $$;
CREATE FUNCTION app.probation_signatures_complete(p_part uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;manager_person text;required jsonb;step jsonb;
BEGIN
 SELECT * INTO d FROM document_signing_document WHERE subject_type='probation' AND subject_id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN false;END IF;
 IF d.data->>'contentHash'<>encode(sha256(convert_to(app.probation_content(p_part)::text,'UTF8')),'hex') THEN RETURN false;END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(d.data->'route'->'steps') WHERE value->>'required'='true' LOOP
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=step->>'id' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash' AND (a->>'action'='signed' OR a->>'action'='declined' AND step->>'role'='employee' AND step->>'kind'='acknowledge')) THEN RETURN false;END IF;
 END LOOP;
 IF d.guardrails->>'independentApprovalFromRole' IS NOT NULL THEN
 SELECT a->>'actorPersonId' INTO manager_person FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'=d.guardrails->>'independentApprovalFromRole' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash';
 IF manager_person IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a JOIN jsonb_array_elements(d.data->'route'->'steps') s ON s->>'id'=a->>'stepId' WHERE s->>'kind'='approve' AND a->>'action'='signed' AND a->>'actorPersonId'<>manager_person AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN RETURN false;END IF;
 END IF;RETURN true;
END $$;
CREATE FUNCTION app.probation_part_command(p_part uuid,p_expected integer,p_command text,p_args jsonb DEFAULT '{}') RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;v jsonb;meta jsonb;reason text:=btrim(coalesce(p_args->>'reason',''));signed jsonb;form jsonb;score integer;band integer;suggestion text;actor uuid:=app.current_user_id();changed_content boolean:=false;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RAISE EXCEPTION 'Probation review unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id FOR UPDATE;PERFORM app.probation_assert_runtime(c.company_id);
 IF p.revision<>p_expected OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN RAISE EXCEPTION 'This probation revision changed or is closed';END IF;
 meta:=p.data;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 IF p_command='submit_employee' THEN
 IF NOT app.probation_role(c.employment_id,'employee') OR p.data->>'state' NOT IN('issued','returned') OR p.data->>'staffSubmittedAt' IS NOT NULL OR NOT app.probation_submission_ready(p.id,'employee') THEN RAISE EXCEPTION 'Complete and submit your own self-assessment first';END IF;
 meta:=meta||jsonb_build_object('staffSubmittedAt',now(),'state','staff_submitted');
 ELSIF p_command='submit_manager' THEN
 IF NOT app.probation_role(c.employment_id,'lm') OR p.data->>'state' IN('not_issued','locked','recorded','completed_offline','cancelled') OR p.data->>'managerSubmittedAt' IS NOT NULL OR NOT app.probation_submission_ready(p.id,'lm') THEN RAISE EXCEPTION 'Complete the manager fields before signing and submitting';END IF;
 IF d.id IS NULL OR d.data->>'contentHash'<>encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'='lm' AND a->>'actorId'=actor::text AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN RAISE EXCEPTION 'The current manager signature is required';END IF;
 meta:=meta||jsonb_build_object('managerSubmittedAt',now(),'state','pending_ack');
 IF p.data->>'type'<>'1' THEN SELECT data INTO form FROM probation_configuration WHERE id=c.form_id;SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND rater='lm';score:=app.probation_score(form,v->'manager');SELECT (b->>'band')::integer INTO band FROM jsonb_array_elements(form->'bands') b WHERE score>=(b->>'min')::integer ORDER BY (b->>'min')::integer DESC LIMIT 1;suggestion:=CASE WHEN p.data->>'type'='2' THEN CASE WHEN band>=3 THEN 'satisfactory' WHEN band=2 THEN 'development' ELSE 'at_risk' END ELSE CASE WHEN band>=3 THEN 'confirm' WHEN band=2 THEN 'extend' ELSE 'not_confirm' END END;meta:=meta||jsonb_build_object('scoreBand',band,'scoreHundredths',score,'override',coalesce(v->>'midpointStatus',v->>'outcome')<>suggestion);END IF;
 UPDATE probation_case SET data=data||jsonb_build_object('state','pending_approval'),revision=revision+1 WHERE id=c.id;
 ELSIF p_command IN('acknowledge','confirm_refusal') THEN
 IF p.data->>'managerSubmittedAt' IS NULL OR p.data->>'acknowledgedAt' IS NOT NULL THEN RAISE EXCEPTION 'Manager submission is required before acknowledgement';END IF;
 IF p_command='acknowledge' AND NOT app.probation_role(c.employment_id,'employee') OR p_command='confirm_refusal' AND NOT app.probation_role(c.employment_id,'pbp') THEN RAISE EXCEPTION 'Acknowledgement authority required';END IF;
 SELECT a INTO signed FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'='employee' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash' AND (p_command='acknowledge' AND a->>'action'='signed' AND a->>'actorId'=actor::text OR p_command='confirm_refusal' AND a->>'action'='declined') ORDER BY a->>'at' DESC LIMIT 1;
 IF signed IS NULL OR d.data->>'contentHash'<>encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'The current signed acknowledgement or recorded refusal is required';END IF;
 UPDATE probation_rater_draft SET data=jsonb_set(data,'{employeeComments}',coalesce(signed->'comment','""'::jsonb)) WHERE part_id=p.id AND rater='employee';
 meta:=meta||jsonb_build_object('acknowledgedAt',now(),'state',CASE WHEN p.data->>'type'='1' THEN 'locked' ELSE 'pending_approval' END,'pdfPending',p.data->>'type'='1');
 IF p.data->>'type'='1' THEN UPDATE probation_case SET data=data||jsonb_build_object('kpiAcknowledged',true,'state','in_review'),revision=revision+1 WHERE id=c.id;END IF;
 ELSIF p_command='return' THEN
 IF length(reason)<3 OR p.data->>'managerSubmittedAt' IS NULL THEN RAISE EXCEPTION 'A return needs comments and a submitted review';END IF;
 IF p.data->>'type'='1' AND NOT app.probation_role(c.employment_id,'employee') OR p.data->>'type'<>'1' AND NOT(app.probation_role(c.employment_id,'employee') OR app.probation_role(c.employment_id,'hod') OR app.probation_role(c.employment_id,'pbp')) THEN RAISE EXCEPTION 'Only a current reviewer may return this part';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'action'='returned' AND a->>'actorId'=actor::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN RAISE EXCEPTION 'The current signing step must record this return';END IF;
 meta:=(meta-ARRAY['scoreBand','scoreHundredths','override','signingFacts','signingPeriod','signingKpis'])||jsonb_build_object('state','returned','managerSubmittedAt',NULL,'acknowledgedAt',NULL);changed_content:=true;
 ELSIF p_command='record' THEN
 IF NOT app.probation_role(c.employment_id,'gbs') OR p.data->>'state'<>'pending_approval' OR NOT app.probation_signatures_complete(p.id) THEN RAISE EXCEPTION 'GBS may record only a fully signed current review';END IF;
 SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND rater='lm';
 IF p.data->>'type'='3' AND v->>'outcome'='extend' AND p.data->>'pbpExtensionConfirmed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PBP must confirm the extension length';END IF;
 meta:=meta||jsonb_build_object('state','locked','recordedAt',now(),'recordedBy',actor,'pdfPending',true);
 IF p.data->>'type'='3' THEN
 UPDATE probation_case SET data=data||jsonb_build_object('state','outcome_pending','pendingOutcome',v->>'outcome'),revision=revision+1 WHERE id=c.id;
 INSERT INTO probation_outcome(case_id,tenant_id,part_id,outcome,revision,state,source_key) VALUES(c.id,c.tenant_id,p.id,v->>'outcome',(p.data->>'cycle')::integer+1,'pending','probation:'||c.id::text||':'||p.id::text) ON CONFLICT(part_id) DO NOTHING;
 ELSE UPDATE probation_case SET data=data||jsonb_build_object('state','in_review'),revision=revision+1 WHERE id=c.id;END IF;
 ELSIF p_command='kpi_exception' THEN
 IF NOT app.probation_role(c.employment_id,'pbp') OR length(reason)<3 THEN RAISE EXCEPTION 'PBP reason required to release the KPI gate';END IF;meta:=meta||jsonb_build_object('kpiException',reason);
 ELSIF p_command='employee_wait_exception' THEN
 IF NOT app.probation_role(c.employment_id,'pbp') OR length(reason)<3 OR (p.data->>'dueOn')::date>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR p.data->>'staffSubmittedAt' IS NOT NULL THEN RAISE EXCEPTION 'Only PBP may release an overdue employee step with a reason';END IF;meta:=meta||jsonb_build_object('employeeWaitException',reason);
 ELSIF p_command='confirm_extension' THEN
 IF NOT app.probation_role(c.employment_id,'pbp') OR coalesce(p_args->>'months','') NOT IN('3','6') OR (c.data->>'extensionCount')::integer>=2 OR p.data->>'managerSubmittedAt' IS NULL THEN RAISE EXCEPTION 'PBP may confirm only a submitted valid extension';END IF;
 SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND rater='lm' FOR UPDATE;IF v->>'outcome'<>'extend' THEN RAISE EXCEPTION 'The manager has not recommended an extension';END IF;
 IF v->>'extensionMonths'<>p_args->>'months' THEN
 IF length(reason)<3 THEN RAISE EXCEPTION 'Explain the changed extension length';END IF;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'lm',p.revision,v,actor,reason);
 UPDATE probation_rater_draft SET data=jsonb_set(data,'{extensionMonths}',p_args->'months') WHERE part_id=p.id AND rater='lm';
 meta:=(meta-ARRAY['scoreBand','scoreHundredths','override','signingFacts','signingPeriod','signingKpis'])||jsonb_build_object('state','returned','managerSubmittedAt',NULL,'acknowledgedAt',NULL);changed_content:=true;
 END IF;meta:=meta||jsonb_build_object('pbpExtensionConfirmed',true,'pbpExtensionConfirmedBy',actor);
 ELSIF p_command='unlock' THEN
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR length(reason)<3 OR coalesce(p_args->>'owner','') NOT IN('employee','lm') THEN RAISE EXCEPTION 'A field owner and PBP/GBS unlock reason are required';END IF;
 IF EXISTS(SELECT 1 FROM probation_outcome WHERE tenant_id=p.tenant_id AND part_id=p.id AND (released_at IS NOT NULL OR movement_ref IS NOT NULL OR handoff_ref IS NOT NULL)) THEN RAISE EXCEPTION 'This outcome has been acted on; use the authorised employment correction process';END IF;
 meta:=meta||jsonb_build_object('state','returned','managerSubmittedAt',NULL,'acknowledgedAt',NULL,'unlockOwner',p_args->>'owner');IF p_args->>'owner'='employee' THEN meta:=jsonb_set(meta,'{staffSubmittedAt}','null'::jsonb);END IF;changed_content:=true;
 IF p.data->>'type'='1' THEN UPDATE probation_case SET data=jsonb_set(data,'{kpiAcknowledged}','false'::jsonb),revision=revision+1 WHERE id=c.id;END IF;
 ELSIF p_command='request_refusal' THEN
 IF NOT app.probation_role(c.employment_id,'lm') OR length(reason)<3 OR p.data->>'managerSubmittedAt' IS NULL OR p.data->>'acknowledgedAt' IS NOT NULL THEN RAISE EXCEPTION 'The current manager must explain the employee refusal';END IF;
 INSERT INTO probation_followup(tenant_id,case_id,part_id,actor_user_id,kind,note,content_revision) VALUES(p.tenant_id,c.id,p.id,actor,'refusal_request',reason,p.content_revision);
 ELSE RAISE EXCEPTION 'Unknown probation command';END IF;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision,p.data,actor,coalesce(nullif(reason,''),p_command));
 UPDATE probation_part SET data=meta,revision=revision+1,content_revision=content_revision+CASE WHEN changed_content THEN 1 ELSE 0 END,updated_at=now() WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,p_command,reason);RETURN p.revision+1;
END $$;
CREATE TABLE probation_builder_definition (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 definition_key text NOT NULL,kind text NOT NULL CHECK(kind IN('workflow','template')),version integer NOT NULL,
 state text NOT NULL CHECK(state IN('draft','published','retired')),data jsonb NOT NULL CHECK(data->>'module'='probation'),
 created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,company_id,kind,definition_key,version)
);
ALTER TABLE probation_builder_definition ENABLE ROW LEVEL SECURITY;ALTER TABLE probation_builder_definition FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_owner ON probation_builder_definition FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY probation_builder_read ON probation_builder_definition FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (app.probation_config_admin(company_id) OR state='published' AND EXISTS(SELECT 1 FROM probation_case c WHERE c.tenant_id=probation_builder_definition.tenant_id AND c.company_id=probation_builder_definition.company_id AND app.probation_case_access(c.id))));
REVOKE ALL ON probation_builder_definition FROM PUBLIC,ai_hr_app;GRANT SELECT ON probation_builder_definition TO ai_hr_app;
CREATE FUNCTION app.probation_definition_save(p_company uuid,p_key text,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid;n integer;
BEGIN
 IF NOT app.probation_config_admin(p_company) OR p_kind NOT IN('workflow','template') OR p_data->>'module' IS DISTINCT FROM 'probation' OR p_key !~ '^[a-zA-Z0-9_-]{1,100}$' THEN RAISE EXCEPTION 'Named probation builder administrator required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||p_company::text||p_kind||p_key,0));
 IF p_expected IS NULL OR p_expected<>(SELECT coalesce(max(version),0) FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND definition_key=p_key AND kind=p_kind) THEN RAISE EXCEPTION 'Probation builder definition changed; reload before saving';END IF;
 IF p_publish AND length(btrim(coalesce(p_data->>'name','')))=0 THEN RAISE EXCEPTION 'Name this probation definition';END IF;
 IF p_publish AND p_kind='workflow' AND (jsonb_typeof(p_data->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'steps')=0) THEN RAISE EXCEPTION 'Add workflow steps before publishing';END IF;
 IF p_publish AND p_kind='workflow' AND (p_data->'trigger'->>'event' IS NULL OR p_data->'trigger'->>'event' NOT IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending','letter_released','overdue_summary') OR jsonb_array_length(p_data->'steps')>10 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'steps') step WHERE step->>'type' IS DISTINCT FROM 'notify' OR length(btrim(coalesce(step->>'subject',''))) NOT BETWEEN 1 AND 200 OR step->>'subject'~E'[\r\n]' OR length(btrim(coalesce(step->>'body',''))) NOT BETWEEN 1 AND 20000 OR coalesce(step->>'id','')='' OR jsonb_typeof(step->'to') IS DISTINCT FROM 'array' OR jsonb_array_length(step->'to') NOT BETWEEN 1 AND 5 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(step->'to') r WHERE r NOT IN('employee','lm','hod','pbp','gbs')))) THEN RAISE EXCEPTION 'Complete bounded messages, supported events and scoped recipients';END IF;
 IF p_publish AND p_kind='template' AND (jsonb_typeof(p_data->'blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'blocks')=0 OR p_data->>'unfinished' IS DISTINCT FROM 'false') THEN RAISE EXCEPTION 'HR must finish and approve letter wording before publishing';END IF;
 SELECT coalesce(max(version),0)+1 INTO n FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND definition_key=p_key AND kind=p_kind;
 INSERT INTO probation_builder_definition(tenant_id,company_id,definition_key,kind,version,state,data,created_by) VALUES(app.current_tenant_id(),p_company,p_key,p_kind,n,CASE WHEN p_publish THEN 'published' ELSE 'draft' END,p_data,app.current_user_id()) RETURNING id INTO v_id;RETURN v_id;
END $$;
CREATE FUNCTION app.probation_followup_add(p_case uuid,p_part uuid,p_kind text,p_note text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;v_id uuid;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR p_kind NOT IN('followup','development','extension_recommendation','nonconfirmation_recommendation') OR length(btrim(coalesce(p_note,'')))<3 OR p_part IS NOT NULL AND NOT EXISTS(SELECT 1 FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id) THEN RAISE EXCEPTION 'Scoped PBP or GBS follow-up required';END IF;
 INSERT INTO probation_followup(tenant_id,case_id,part_id,actor_user_id,kind,note) VALUES(c.tenant_id,c.id,p_part,app.current_user_id(),p_kind,p_note) RETURNING id INTO v_id;PERFORM app.probation_audit(c.id,p_part,'followup_recorded');RETURN v_id;
END $$;
CREATE FUNCTION app.probation_delegate_add(p_part uuid,p_step text,p_holder uuid,p_kind text,p_from date,p_to date,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;h jsonb;represented uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR length(btrim(coalesce(p_reason,'')))<3 OR p_kind NOT IN('delegation','holder_changed','missing_holder') OR p_from IS NULL OR p_to<p_from THEN RAISE EXCEPTION 'A current PBP/GBS must record the replacement and reason';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_holder AND tenant_id=p.tenant_id AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RAISE EXCEPTION 'Choose an active existing login';END IF;
 SELECT (app.probation_holders(c.employment_id)->>(s->>'role'))::uuid INTO represented FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step;
 IF NOT FOUND THEN RAISE EXCEPTION 'Signing step unavailable';END IF;
 INSERT INTO probation_delegate(tenant_id,part_id,step_id,holder_id,represented_id,kind,reason,created_by,valid_from,valid_to) VALUES(p.tenant_id,p.id,p_step,p_holder,CASE WHEN p_kind='delegation' THEN represented END,p_kind,p_reason,app.current_user_id(),p_from,p_to);
 PERFORM app.probation_audit(c.id,p.id,'signer_replaced',p_reason);
END $$;
CREATE FUNCTION app.probation_route_override(p_part uuid,p_route jsonb,p_reason text,p_expected integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;rules jsonb;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.revision<>p_expected OR NOT app.probation_role(c.employment_id,'pbp') OR length(btrim(coalesce(p_reason,'')))<3 OR p.data->>'managerSubmittedAt' IS NOT NULL OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled') THEN RAISE EXCEPTION 'PBP may change only an unsubmitted route with a reason';END IF;
 rules:=app.probation_signing_guardrails(p.id);PERFORM app.document_signing_validate(jsonb_build_object('route',p_route,'actions','[]'::jsonb),rules);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role' NOT IN('lm','employee','hod','pbp') OR s->>'holderId' IS NOT NULL OR s->>'representedId' IS NOT NULL) THEN RAISE EXCEPTION 'Routes choose roles; use recorded delegation for named replacements';END IF;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision,p.data,app.current_user_id(),p_reason);
 UPDATE probation_part SET data=data||jsonb_build_object('route',p_route,'routeOverride',true,'routeReason',p_reason),revision=revision+1,content_revision=content_revision+1 WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'route_changed',p_reason);
END $$;
CREATE FUNCTION app.probation_personnel_source(p_employment uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;a assignment;g job_grade;p person;h jsonb;original_grade uuid;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 SELECT * INTO e FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT(app.probation_role(e.id,'gbs') OR app.probation_role(e.id,'pbp') OR app.probation_role(e.id,'lm') OR app.probation_role(e.id,'employee') OR app.probation_role(e.id,'hod') OR app.probation_config_admin(e.company_id) OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'Personnel record unavailable for probation';END IF;
 SELECT * INTO a FROM assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND superseded_at IS NULL AND valid_from<=day AND (valid_to IS NULL OR valid_to>day) ORDER BY valid_from DESC,id LIMIT 1;
 SELECT (payload->>'gradeId')::uuid INTO original_grade FROM domain_event WHERE tenant_id=e.tenant_id AND subject_employment_id=e.id AND event_type='employment.hired' AND payload->>'gradeId' IS NOT NULL ORDER BY sequence LIMIT 1;
 SELECT * INTO g FROM job_grade WHERE id=coalesce(original_grade,e.grade_id) AND tenant_id=e.tenant_id;
 SELECT * INTO p FROM person WHERE id=e.person_id AND tenant_id=e.tenant_id;h:=app.probation_holders(e.id);
 RETURN jsonb_build_object('employmentId',e.id,'personId',e.person_id,'companyId',e.company_id,'employeeName',p.full_name,'employeeCode',e.employee_code,'companyName',(SELECT legal_name FROM company WHERE id=e.company_id AND tenant_id=e.tenant_id),'startOn',coalesce(e.join_date,e.hired_on),'endOn',coalesce(e.extended_confirmation_date,e.normal_confirmation_date,e.probation_end_date,e.provisional_end_on),'grade',regexp_replace(upper(coalesce(g.code,'')),'^(JG|GRADE)[ -]*','','g'),'gradeId',coalesce(original_grade,e.grade_id),'currentGradeId',e.grade_id,'employmentType',a.employment_type,'explicitNoProbation',(coalesce(e.probation_value,-1)=0 OR coalesce(e.probation_months,-1)=0 OR coalesce(e.extended_confirmation_date,e.normal_confirmation_date,e.probation_end_date,e.provisional_end_on) IS NULL AND e.probation_value IS NULL AND e.probation_months IS NULL AND EXISTS(SELECT 1 FROM domain_event de WHERE de.tenant_id=e.tenant_id AND de.subject_employment_id=e.id AND de.event_type='employment.hired' AND de.payload?'provisionalEndOn' AND de.payload->>'provisionalEndOn' IS NULL)),'unknownPeriod',(coalesce(e.extended_confirmation_date,e.normal_confirmation_date,e.probation_end_date,e.provisional_end_on) IS NULL AND e.probation_value IS NULL AND e.probation_months IS NULL),'probationMonths',CASE WHEN e.probation_unit='month' THEN e.probation_value ELSE e.probation_months END,'probationUnit',e.probation_unit,'probationValue',e.probation_value,'confirmationOn',e.confirmation_date,'terminatedOn',e.terminated_on,'resignationOn',e.resignation_date,'departmentId',a.department_id,'businessGroupId',(SELECT coalesce(parent_company_id,id) FROM company WHERE id=e.company_id AND tenant_id=e.tenant_id),'businessGroup',(SELECT bg.legal_name FROM company co JOIN company bg ON bg.id=coalesce(co.parent_company_id,co.id) AND bg.tenant_id=co.tenant_id WHERE co.id=e.company_id AND co.tenant_id=e.tenant_id),'businessUnitId',a.business_unit_id,'department',(SELECT name FROM department WHERE id=a.department_id),'businessUnit',(SELECT name FROM business_unit WHERE id=a.business_unit_id),'title',(SELECT title FROM position WHERE id=a.position_id),'division',e.org_division,'holders',h-ARRAY['companyId','departmentId','businessUnitId','pbpAmbiguous']);
END $$;
CREATE FUNCTION app.probation_resolved_route(p_part uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;h jsonb;route jsonb;steps jsonb:='[]';s jsonb;d probation_delegate;holder uuid;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;stored document_signing_document;historic jsonb;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RAISE EXCEPTION 'Signing route unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;h:=app.probation_holders(c.employment_id);route:=p.data->'route';
 SELECT * INTO stored FROM document_signing_document WHERE subject_id=p.id AND subject_type='probation' AND tenant_id=p.tenant_id;
 FOR s IN SELECT value FROM jsonb_array_elements(route->'steps') LOOP
 holder:=(h->>(s->>'role'))::uuid;
 SELECT * INTO d FROM probation_delegate WHERE tenant_id=p.tenant_id AND part_id=p.id AND step_id=s->>'id' AND valid_from<=day AND (valid_to IS NULL OR valid_to>=day) ORDER BY created_at DESC,id DESC LIMIT 1;
 IF FOUND THEN holder:=d.holder_id;s:=s||jsonb_build_object('representedId',d.represented_id);END IF;
 SELECT old INTO historic FROM jsonb_array_elements(stored.data->'route'->'steps') old WHERE old->>'id'=s->>'id' AND EXISTS(SELECT 1 FROM jsonb_array_elements(stored.data->'actions') a WHERE a->>'stepId'=old->>'id' AND a->>'action' IN('signed','declined') AND a->>'contentRevision'=stored.data->>'contentRevision' AND a->>'contentHash'=stored.data->>'contentHash') AND stored.data->>'contentHash'=encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex');
 IF historic IS NOT NULL THEN steps:=steps||jsonb_build_array(historic);ELSE steps:=steps||jsonb_build_array(s||jsonb_build_object('holderId',holder));END IF;
 END LOOP;RETURN jsonb_set(route,'{steps}',steps);
END $$;
REVOKE ALL ON FUNCTION app.probation_holders(uuid),app.probation_user_for(uuid),app.probation_signatures_complete(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_bootstrap_admin(p_company uuid,p_user uuid,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
 IF NOT app.probation_active_user() OR NOT app.is_admin_for(p_company) OR NOT app.is_group_admin() OR length(btrim(coalesce(p_reason,'')))<3 OR EXISTS(SELECT 1 FROM probation_access WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND role='admin' AND valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (valid_to IS NULL OR valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN RAISE EXCEPTION 'Only group HR administration may nominate the first named preparer';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_user AND tenant_id=app.current_tenant_id() AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RAISE EXCEPTION 'Choose an active existing login';END IF;
 INSERT INTO probation_access(tenant_id,user_id,company_id,role,valid_from,reason) VALUES(app.current_tenant_id(),p_user,p_company,'admin',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,p_reason) RETURNING id INTO v_id;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(app.current_tenant_id(),'probation-setup',v_id,'probation.preparer-nominated','user',app.current_user_id(),jsonb_build_object('companyId',p_company,'userId',p_user));
 RETURN v_id;
END $$;
CREATE FUNCTION app.probation_issue(p_part uuid,p_today date) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RETURN false;END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs')) OR p_today<>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Verified current-day probation scheduling required';END IF;
 PERFORM app.probation_assert_runtime(c.company_id);
 IF p.data->>'state'<>'not_issued' OR (p.data->>'issueOn')::date>p_today OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN RETURN false;END IF;
 IF p.data->>'type'<>'1' AND c.data->'config'->>'kpiGate'='block' AND c.data->>'kpiAcknowledged'<>'true' AND p.data->>'kpiException' IS NULL THEN RETURN false;END IF;
 UPDATE probation_part SET data=jsonb_set(data,'{state}','"issued"'::jsonb),revision=revision+1 WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'form_issued');RETURN true;
END $$;
CREATE FUNCTION app.probation_withdraw(p_case uuid,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp')) THEN RAISE EXCEPTION 'Probation withdrawal authority required';END IF;
 IF NOT EXISTS(SELECT 1 FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id AND (resignation_date IS NOT NULL OR terminated_on IS NOT NULL)) THEN RAISE EXCEPTION 'Record the resignation or exit in Personnel first';END IF;
 UPDATE probation_case SET data=jsonb_set(data,'{state}','"withdrawn"'),revision=revision+1 WHERE id=c.id;
 UPDATE probation_occurrence SET state='cancelled' WHERE tenant_id=c.tenant_id AND case_id=c.id AND state IN('ready','scheduled');
 PERFORM app.probation_audit(c.id,NULL,'withdrawn',p_reason);
END $$;
ALTER TABLE probation_occurrence ADD COLUMN recipient_roles jsonb NOT NULL DEFAULT '[]',ADD COLUMN source_event_id uuid UNIQUE REFERENCES domain_event(id);
CREATE FUNCTION app.probation_enqueue(p_case uuid,p_part uuid,p_kind text,p_due date,p_roles jsonb,p_source_key text,p_revision integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;o probation_occurrence;h jsonb;users jsonb:='[]';r text;u uuid;v_event uuid;v_id uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp')) THEN RAISE EXCEPTION 'Probation notification scheduling denied';END IF;PERFORM app.probation_assert_runtime(c.company_id);
 IF p_due<>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled AND activation_on<=p_due) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') AND p_kind<>'letter_released' THEN RETURN NULL;END IF;
 IF p_part IS NOT NULL THEN SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id;IF NOT FOUND OR p.revision<>p_revision THEN RAISE EXCEPTION 'Scheduled source changed';END IF;END IF;
 IF jsonb_typeof(p_roles)<>'array' OR jsonb_array_length(p_roles)>10 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_roles) role WHERE role NOT IN('employee','lm','hod','pbp','gbs')) THEN RAISE EXCEPTION 'Choose probation-scoped recipients';END IF;
 h:=app.probation_holders(c.employment_id);
 FOR r IN SELECT value FROM jsonb_array_elements_text(p_roles) LOOP
 IF r='gbs' THEN SELECT users||coalesce(jsonb_agg(DISTINCT a.user_id),'[]') INTO users FROM probation_access a JOIN app_user u ON u.id=a.user_id AND u.tenant_id=a.tenant_id WHERE a.tenant_id=c.tenant_id AND a.role='gbs' AND app.is_company_descendant(c.company_id,a.company_id) AND a.valid_from<=p_due AND (a.valid_to IS NULL OR a.valid_to>=p_due) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 ELSE u:=(h->>r)::uuid;IF u IS NOT NULL THEN users:=users||jsonb_build_array(u);END IF;END IF;
 END LOOP;
 SELECT * INTO o FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=p_source_key;
 IF FOUND THEN RETURN o.id;END IF;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',v_id,'probation.notification-due',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'kind',p_kind)) RETURNING id INTO v_event;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id) VALUES(v_id,c.tenant_id,c.id,p.id,p_source_key,p_kind,p_due,users,p_roles,'scheduled',coalesce(p.revision,c.revision),v_event);
 RETURN v_id;
END $$;
CREATE FUNCTION app.probation_notification_recipients(p_occurrence uuid,p_event uuid) RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_occurrence;c probation_case;p probation_part;h jsonb;
BEGIN
 SELECT * INTO o FROM probation_occurrence WHERE id=p_occurrence AND tenant_id=app.current_tenant_id() AND source_event_id=p_event AND state='scheduled';IF NOT FOUND THEN RETURN;END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled AND activation_on<=o.due_on) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') AND o.kind<>'letter_released' THEN RETURN;END IF;
 SELECT * INTO p FROM probation_part WHERE id=o.part_id AND tenant_id=o.tenant_id;h:=app.probation_holders(c.employment_id);
 RETURN QUERY SELECT DISTINCT e.id FROM jsonb_array_elements_text(o.recipient_user_ids) ids(user_id) JOIN app_user u ON u.id=ids.user_id::uuid AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND (
 EXISTS(SELECT 1 FROM jsonb_array_elements_text(o.recipient_roles) role WHERE role<>'gbs' AND h->>role=u.id::text AND NOT(o.kind='review_reminder' AND role='employee' AND p.data->>'staffSubmittedAt' IS NOT NULL) AND NOT(o.kind='review_reminder' AND role='lm' AND p.data->>'managerSubmittedAt' IS NOT NULL))
 OR o.recipient_roles?'gbs' AND EXISTS(SELECT 1 FROM probation_access a WHERE a.tenant_id=o.tenant_id AND a.user_id=u.id AND a.role='gbs' AND app.is_company_descendant(c.company_id,a.company_id) AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)));
END $$;
CREATE FUNCTION app.probation_file_save(p_case uuid,p_part uuid,p_kind text,p_name text,p_content bytea,p_revision integer,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;v_id uuid;existing uuid;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR app.probation_storage_runner()) OR p_kind NOT IN('offline','completed_part','letter_draft') OR octet_length(p_content) NOT BETWEEN 5 AND 10485760 OR substring(p_content FROM 1 FOR 5)<>convert_to('%PDF-','UTF8') OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'A scoped PBP/GBS and valid PDF evidence are required';END IF;
 PERFORM app.probation_assert_runtime(c.company_id);
 IF p_part IS NOT NULL THEN SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;END IF;
 IF p_kind='completed_part' AND (p.data->>'state'<>'locked' OR NOT app.probation_signatures_complete(p.id)) THEN RAISE EXCEPTION 'Only a current completed signed part can be filed';END IF;
 IF p_kind='offline' AND (p.id IS NULL OR p.data->>'state' NOT IN('not_issued','issued') OR p.data->>'managerSubmittedAt' IS NOT NULL OR p.data->>'staffSubmittedAt' IS NOT NULL) THEN RAISE EXCEPTION 'Offline intake cannot replace an electronic submission';END IF;
 IF p_kind='letter_draft' AND NOT EXISTS(SELECT 1 FROM probation_outcome o WHERE o.case_id=c.id AND o.tenant_id=c.tenant_id AND o.part_id=p.id AND o.released_at IS NULL AND o.outcome<>'other') THEN RAISE EXCEPTION 'A recorded final outcome is required';END IF;
 SELECT id INTO existing FROM probation_file WHERE tenant_id=c.tenant_id AND case_id=c.id AND part_id=p_part AND kind=p_kind AND revision=p_revision;
 IF existing IS NOT NULL THEN RETURN existing;END IF;
 INSERT INTO probation_file(tenant_id,case_id,part_id,kind,revision,name,content,content_hash,created_by) VALUES(c.tenant_id,c.id,p_part,p_kind,p_revision,left(p_name,200),p_content,encode(sha256(p_content),'hex'),app.current_user_id()) RETURNING id INTO v_id;
 IF p_kind='completed_part' THEN UPDATE probation_part SET data=jsonb_set(data,'{pdfPending}','false'::jsonb) WHERE id=p.id;END IF;
 IF p_kind IN('offline','completed_part') THEN
 INSERT INTO employee_document(tenant_id,employment_id,title,category,description,content,file_name,mime_type,size_bytes,uploaded_by_user_id,updated_by_user_id) VALUES(c.tenant_id,c.employment_id,CASE WHEN p_kind='offline' THEN 'Completed offline probation review' ELSE 'Completed probation review' END,'Probation',p_reason,p_content,left(p_name,200),'application/pdf',octet_length(p_content),app.current_user_id(),app.current_user_id()) RETURNING id INTO existing;
 UPDATE probation_file SET employee_document_id=existing WHERE id=v_id;
 END IF;
 IF p_kind='offline' THEN
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision,p.data,app.current_user_id(),p_reason);
 UPDATE probation_part SET data=data||jsonb_build_object('state','completed_offline','offlinePdfId',v_id,'offlineRecordedBy',app.current_user_id(),'offlineRecordedAt',now()),revision=revision+1 WHERE id=p.id;
 IF p.data->>'type'='1' THEN UPDATE probation_case SET data=data||jsonb_build_object('kpiAcknowledged',true,'state','in_review'),revision=revision+1 WHERE id=c.id;END IF;
 END IF;
 PERFORM app.probation_audit(c.id,p.id,'file_saved',p_reason);RETURN v_id;
END $$;
CREATE FUNCTION app.probation_outcome_draft(p_outcome uuid,p_template uuid,p_file uuid,p_merge jsonb,p_expected integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;f probation_file;source jsonb;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;PERFORM app.probation_assert_runtime(c.company_id);
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR o.revision<>p_expected OR o.released_at IS NOT NULL OR o.outcome='other' THEN RAISE EXCEPTION 'Only an unreleased recorded outcome may be drafted';END IF;
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND definition_key=o.outcome AND state='published';
 SELECT * INTO f FROM probation_file WHERE id=p_file AND tenant_id=o.tenant_id AND case_id=c.id AND part_id=o.part_id AND kind='letter_draft';IF t.id IS NULL OR f.id IS NULL THEN RAISE EXCEPTION 'Use the pinned published probation template and this case draft';END IF;
 source:=app.probation_personnel_source(c.employment_id);
 UPDATE probation_outcome SET template_id=t.id::text,template_version=t.version,letter_file_id=f.id,merge_data=p_merge||jsonb_build_object('employeeName',source->>'employeeName','employeeCode',source->>'employeeCode','startOn',c.data->>'startOn','endOn',c.data->>'endOn','outcome',o.outcome),state='awaiting_release',updated_at=now() WHERE id=o.id;
 PERFORM app.probation_audit(c.id,o.part_id,'letter_generated');
END $$;
CREATE FUNCTION app.probation_letter_release(p_outcome uuid,p_expected integer,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;f probation_file;doc uuid;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;PERFORM app.probation_assert_runtime(c.company_id);
 IF o.released_at IS NOT NULL THEN RETURN;END IF;
 IF o.revision<>p_expected OR o.state<>'awaiting_release' OR o.letter_file_id IS NULL OR length(btrim(coalesce(p_reason,'')))<3 OR o.outcome IN('extend','not_confirm') AND NOT app.probation_role(c.employment_id,'pbp') OR o.outcome='confirm' AND NOT(app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp') OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'The current authorised reviewer must release the prepared letter';END IF;
 IF NOT app.probation_signatures_complete(o.part_id) THEN RAISE EXCEPTION 'The evaluation route must be complete before letter release';END IF;
 SELECT * INTO f FROM probation_file WHERE id=o.letter_file_id AND tenant_id=o.tenant_id AND kind='letter_draft' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Draft letter unavailable';END IF;
 INSERT INTO employee_document(tenant_id,employment_id,title,category,description,content,file_name,mime_type,size_bytes,uploaded_by_user_id,updated_by_user_id) VALUES(c.tenant_id,c.employment_id,'Probation outcome letter','Probation',p_reason,f.content,f.name,'application/pdf',octet_length(f.content),app.current_user_id(),app.current_user_id()) RETURNING id INTO doc;
 UPDATE probation_file SET kind='letter_released',employee_document_id=doc WHERE id=f.id;
 UPDATE probation_outcome SET state='released',released_by=app.current_user_id(),released_at=now(),updated_at=now() WHERE id=o.id;
 PERFORM app.probation_audit(c.id,o.part_id,'letter_released',p_reason);
END $$;
CREATE FUNCTION app.probation_record_effect(p_outcome uuid,p_movement text,p_handoff uuid,p_next jsonb,p_new_part jsonb DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;e employment;part jsonb;pid uuid;form jsonb;route jsonb;start_day date;end_day date;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id FOR UPDATE;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id;
 IF NOT(app.probation_role(e.id,'gbs') OR app.probation_storage_runner()) OR o.released_at IS NULL THEN RAISE EXCEPTION 'GBS may apply only a released approved outcome';END IF;PERFORM app.probation_assert_runtime(c.company_id);
 IF o.state='completed' THEN RETURN;END IF;
 IF o.outcome='confirm' AND e.confirmation_date::text IS DISTINCT FROM c.data->>'endOn' THEN RAISE EXCEPTION 'The canonical confirmation movement has not completed';END IF;
 IF o.outcome='extend' AND (e.extended_confirmation_date::text IS DISTINCT FROM p_next->>'endOn' OR (c.data->>'extensionCount')::integer>=2 OR p_new_part IS NULL) THEN RAISE EXCEPTION 'The canonical extension movement has not completed';END IF;
 IF o.outcome='not_confirm' AND (p_handoff IS NULL OR NOT EXISTS(SELECT 1 FROM lc_v9_case x WHERE x.id=p_handoff AND x.tenant_id=c.tenant_id AND x.employment_id=e.id AND x.module='off' AND x.data->'facts'->>'caseType'='Non-confirmation' AND x.data->'facts'->>'lastDay'=c.data->>'endOn' AND x.data->>'probationSourceCaseId'=c.id::text)) THEN RAISE EXCEPTION 'The canonical company-initiated offboarding handoff has not completed';END IF;
 UPDATE probation_outcome SET state='completed',movement_ref=p_movement,handoff_ref=p_handoff,failure=NULL,updated_at=now() WHERE id=o.id;
 IF o.outcome='extend' THEN
 part:=p_new_part;pid:=(part->>'id')::uuid;SELECT data INTO form FROM probation_configuration WHERE id=c.form_id;SELECT data INTO route FROM probation_configuration WHERE id=c.route_id;
 IF part->>'type'<>'3' OR (part->>'cycle')::integer<>(c.data->>'extensionCount')::integer+1 THEN RAISE EXCEPTION 'An extension schedules only the next final review';END IF;
 INSERT INTO probation_part(id,tenant_id,case_id,data) VALUES(pid,c.tenant_id,c.id,(part-ARRAY['employee','manager','employeeComments','kpis','support','strengths','development','managerComments','outcome','midpointStatus','justification','extensionMonths'])||jsonb_build_object('state','not_issued','route',route->'parts'->'3'));
 INSERT INTO probation_rater_draft(part_id,tenant_id,rater,data) VALUES(pid,c.tenant_id,'employee',jsonb_build_object('employee',app.probation_blank_assessment(form),'employeeComments','')),(pid,c.tenant_id,'lm',jsonb_build_object('manager',app.probation_blank_assessment(form),'kpis','[]'::jsonb,'support',jsonb_build_object('coaching','','access','','checkins','','other',''),'strengths','','development','','managerComments','','outcome',NULL,'midpointStatus',NULL,'justification','','extensionMonths',NULL));
 UPDATE probation_case SET data=data||jsonb_build_object('state','extended','endOn',p_next->>'endOn','extensionCount',(data->>'extensionCount')::integer+1,'pendingOutcome',NULL),revision=revision+1 WHERE id=c.id;
 ELSE UPDATE probation_case SET data=data||jsonb_build_object('state',CASE WHEN o.outcome='confirm' THEN 'confirmed' ELSE 'not_confirmed' END,'pendingOutcome',NULL),revision=revision+1 WHERE id=c.id;END IF;
 PERFORM app.probation_audit(c.id,o.part_id,'outcome_applied');
END $$;
CREATE FUNCTION app.probation_outcome_failure(p_outcome uuid,p_message text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;o probation_outcome;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF NOT(app.probation_role(c.employment_id,'gbs') OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'Outcome retry authority required';END IF;
 UPDATE probation_outcome SET failure=left(p_message,1000),updated_at=now() WHERE id=o.id AND state<>'completed';
END $$;
CREATE FUNCTION app.probation_prepare_signing(p_part uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;kpis jsonb;source jsonb;policy jsonb;scoped_route jsonb;manager jsonb;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF NOT app.probation_role(c.employment_id,'lm') OR p.data->>'managerSubmittedAt' IS NOT NULL OR NOT app.probation_submission_ready(p.id,'lm') THEN RAISE EXCEPTION 'Only the ready current manager submission may freeze content';END IF;
 IF p.data?'signingFacts' THEN RETURN;END IF;
 source:=app.probation_personnel_source(c.employment_id);
 IF coalesce(p.data->>'routeOverride','false')<>'true' THEN
 SELECT data INTO policy FROM probation_configuration WHERE id=c.route_id AND tenant_id=c.tenant_id;SELECT data INTO manager FROM probation_rater_draft WHERE part_id=p.id AND rater='lm' AND tenant_id=p.tenant_id;
 SELECT r->'route' INTO scoped_route FROM jsonb_array_elements(coalesce(policy->'rules','[]')) WITH ORDINALITY rules(r,n) WHERE r->>'part'=p.data->>'type' AND (r->>'businessGroupId' IS NULL OR r->>'businessGroupId'=source->>'businessGroupId') AND (r->>'businessUnitId' IS NULL OR r->>'businessUnitId'=source->>'businessUnitId') AND (r->>'grade' IS NULL OR r->>'grade'=c.data->>'gradeAtStart') AND (r->>'outcome' IS NULL OR r->>'outcome'=manager->>'outcome') ORDER BY num_nonnulls(r->>'businessGroupId',r->>'businessUnitId',r->>'grade',r->>'outcome') DESC,n DESC LIMIT 1;
 UPDATE probation_part SET data=jsonb_set(data,'{route}',coalesce(scoped_route,policy->'parts'->(p.data->>'type'))) WHERE id=p.id;END IF;
 SELECT d.data->'kpis' INTO kpis FROM probation_part k JOIN probation_rater_draft d ON d.part_id=k.id AND d.tenant_id=k.tenant_id AND d.rater='lm' WHERE k.case_id=c.id AND k.tenant_id=c.tenant_id AND k.data->>'type'='1' AND k.data->>'state' IN('locked','completed_offline') ORDER BY k.created_at DESC LIMIT 1;
 UPDATE probation_part SET data=data||jsonb_build_object('signingFacts',source,'signingPeriod',jsonb_build_object('startOn',c.data->>'startOn','endOn',c.data->>'endOn','gradeAtStart',c.data->>'gradeAtStart'),'signingKpis',coalesce(kpis,'[]')) WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'content_frozen');
END $$;
CREATE FUNCTION app.probation_case_holder_names(p_case uuid) RETURNS TABLE(user_id uuid,role text,name text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_case_access(c.id) THEN RETURN;END IF;
 RETURN QUERY SELECT u.id,h.key,p.full_name FROM jsonb_each_text(app.probation_holders(c.employment_id)) h JOIN app_user u ON u.id=CASE WHEN h.key IN('employee','lm','hod','pbp') THEN h.value::uuid ELSE NULL END AND u.tenant_id=c.tenant_id JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE h.key IN('employee','lm','hod','pbp')
 UNION SELECT u.id,x.step_id,p.full_name FROM probation_delegate x JOIN probation_part r ON r.id=x.part_id AND r.tenant_id=x.tenant_id JOIN app_user u ON u.id=x.holder_id AND u.tenant_id=x.tenant_id JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE r.case_id=c.id AND x.tenant_id=c.tenant_id AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
END $$;
CREATE FUNCTION app.probation_commands(p_part uuid) RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;v jsonb;commands text[]:='{}';is_employee boolean;is_lm boolean;is_pbp boolean;is_gbs boolean;open boolean;pending_role text;current_holder uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RETURN commands;END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN RETURN commands;END IF;
 is_employee:=app.probation_role(c.employment_id,'employee');is_lm:=app.probation_role(c.employment_id,'lm');is_pbp:=app.probation_role(c.employment_id,'pbp');is_gbs:=app.probation_role(c.employment_id,'gbs');open:=p.data->>'state' NOT IN('not_issued','locked','recorded','completed_offline','cancelled');
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 SELECT s->>'role',(s->>'holderId')::uuid INTO pending_role,current_holder FROM jsonb_array_elements(app.probation_resolved_route(p.id)->'steps') s WHERE s->>'required'='true' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=s->>'id' AND a->>'action' IN('signed','declined') AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') ORDER BY (s->>'stage')::integer,s->>'id' LIMIT 1;
 IF open AND is_employee AND p.data->>'type'<>'1' AND p.data->>'staffSubmittedAt' IS NULL THEN commands:=array_append(commands,'submit_employee');END IF;
 IF open AND is_lm AND p.data->>'managerSubmittedAt' IS NULL AND (p.data->>'type'='1' OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'employeeWaitException' IS NOT NULL) THEN commands:=array_append(commands,'submit_manager');END IF;
 IF open AND p.data->>'managerSubmittedAt' IS NOT NULL AND current_holder=app.current_user_id() THEN
 IF pending_role='employee' AND is_employee THEN commands:=array_append(commands,'acknowledge');ELSIF pending_role IN('hod','pbp') THEN commands:=array_append(commands,'approve');END IF;
 IF pending_role IN('employee','hod','pbp') THEN commands:=array_append(commands,'return');END IF;
 END IF;
 IF is_gbs AND p.data->>'state'='pending_approval' AND app.probation_signatures_complete(p.id) THEN
 SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND rater='lm';
 IF v->>'outcome' IS DISTINCT FROM 'extend' OR p.data->>'pbpExtensionConfirmed'='true' THEN commands:=array_append(commands,'record');END IF;END IF;
 IF (is_pbp OR is_gbs) AND (p.data->>'state' IN('locked','recorded','completed_offline') OR p.data->>'managerSubmittedAt' IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM probation_outcome WHERE part_id=p.id AND tenant_id=p.tenant_id AND (released_at IS NOT NULL OR movement_ref IS NOT NULL OR handoff_ref IS NOT NULL)) THEN commands:=array_append(commands,'unlock');END IF;
 IF is_pbp AND p.data->>'type'<>'1' AND p.data->>'state'='not_issued' AND c.data->>'kpiAcknowledged'<>'true' AND p.data->>'kpiException' IS NULL THEN commands:=array_append(commands,'kpi_exception');END IF;
 IF is_pbp AND p.data->>'type'<>'1' AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'employeeWaitException' IS NULL AND (p.data->>'dueOn')::date<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN commands:=array_append(commands,'employee_wait_exception');END IF;
 IF is_pbp AND p.data->>'managerSubmittedAt' IS NOT NULL AND (c.data->>'extensionCount')::integer<2 AND EXISTS(SELECT 1 FROM probation_rater_draft WHERE part_id=p.id AND rater='lm' AND data->>'outcome'='extend') THEN commands:=array_append(commands,'confirm_extension');END IF;
 IF is_lm AND p.data->>'managerSubmittedAt' IS NOT NULL AND p.data->>'acknowledgedAt' IS NULL AND pending_role='employee' THEN commands:=array_append(commands,'request_refusal');END IF;
 IF is_pbp AND p.data->>'managerSubmittedAt' IS NOT NULL AND p.data->>'acknowledgedAt' IS NULL AND pending_role='employee' AND EXISTS(SELECT 1 FROM probation_followup WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='refusal_request' AND content_revision=p.content_revision) THEN commands:=array_append(commands,'confirm_refusal');END IF;
 RETURN commands;
END $$;

-- Authored lifecycle text stays private: reference-only events use the existing leased SMTP owner.
-- Fixed module dispatch only; callers cannot select arbitrary functions, source events or recipients.
CREATE FUNCTION app.private_workflow_mail(p_delivery uuid,p_token uuid,p_origin text,p_compatibility boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target record;d notification_delivery;e domain_event;message jsonb;
BEGIN
 IF p_compatibility THEN
  SELECT * INTO target FROM identity_email.delivery_target(p_delivery,p_token,p_origin);
 ELSE
  SELECT * INTO target FROM app.internal_auth_notification_target(p_delivery,p_token,p_origin);
 END IF;
 IF NOT FOUND THEN RETURN jsonb_build_object('required',true,'message',NULL);END IF;
 SELECT * INTO d FROM notification_delivery WHERE id=p_delivery AND recipient_user_id=target.user_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('required',true,'message',NULL);END IF;
 SELECT * INTO e FROM domain_event WHERE id=d.source_event_id AND tenant_id=d.tenant_id;
 IF e.event_type='probation.notification-due' THEN
  IF to_regprocedure('app.probation_notification_content(uuid,uuid,uuid)') IS NOT NULL THEN
   EXECUTE 'SELECT app.probation_notification_content($1,$2,$3)' INTO message USING d.tenant_id,e.id,target.user_id;
  END IF;
 ELSIF e.event_type='contract.notification-due' THEN
  IF to_regprocedure('app.contract_notification_content(uuid,uuid,uuid)') IS NOT NULL THEN
   EXECUTE 'SELECT app.contract_notification_content($1,$2,$3)' INTO message USING d.tenant_id,e.id,target.user_id;
  END IF;
 ELSE RETURN jsonb_build_object('required',false,'message',NULL);
 END IF;
 RETURN jsonb_build_object('required',true,'message',message);
END $$;
REVOKE ALL ON FUNCTION app.private_workflow_mail(uuid,uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.private_workflow_mail(uuid,uuid,text,boolean) TO ai_hr_app;

ALTER TABLE probation_occurrence ADD COLUMN workflow_id uuid REFERENCES probation_builder_definition(id),ADD COLUMN workflow_step_id text;
CREATE FUNCTION app.probation_workflow_run(p_case uuid,p_part uuid,p_workflow uuid,p_expected integer,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;w probation_builder_definition;s jsonb;v_id uuid;first_id uuid;f jsonb;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp')) OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Scoped workflow run authority and reason required';END IF;
 PERFORM app.probation_assert_runtime(c.company_id);
 SELECT * INTO w FROM probation_builder_definition WHERE id=p_workflow AND tenant_id=c.tenant_id AND company_id=c.company_id AND kind='workflow' AND state='published' AND c.data->'workflowIds'?id::text;
 IF NOT FOUND THEN RAISE EXCEPTION 'Use this case pinned published workflow';END IF;
 IF p_part IS NOT NULL THEN SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id;IF NOT FOUND OR p.revision<>p_expected THEN RAISE EXCEPTION 'Workflow source changed';END IF;
 ELSIF c.revision<>p_expected THEN RAISE EXCEPTION 'Workflow source changed';END IF;
 f:=c.data->'facts';
 IF coalesce(w.data->'conditions'->>'businessGroupId',f->>'businessGroupId') IS DISTINCT FROM f->>'businessGroupId' OR coalesce(w.data->'conditions'->>'businessUnitId',f->>'businessUnitId') IS DISTINCT FROM f->>'businessUnitId' OR coalesce(w.data->'conditions'->>'departmentId',f->>'departmentId') IS DISTINCT FROM f->>'departmentId' OR coalesce(w.data->'conditions'->>'grade',c.data->>'gradeAtStart') IS DISTINCT FROM c.data->>'gradeAtStart' OR w.data->'conditions'?'part' AND w.data->'conditions'->>'part' IS DISTINCT FROM p.data->>'type' THEN RETURN NULL;END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(w.data->'steps') LOOP
  IF s->>'type'<>'notify' THEN RAISE EXCEPTION 'Unsupported probation workflow operation';END IF;
  v_id:=app.probation_enqueue(c.id,p.id,w.data->'trigger'->>'event',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,s->'to','probation-workflow:'||w.id::text||':'||c.id::text||':'||coalesce(p.id::text,'case')||':'||(s->>'id')||':'||(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text,coalesce(p.revision,c.revision));
  IF v_id IS NOT NULL THEN UPDATE probation_occurrence SET workflow_id=w.id,workflow_step_id=s->>'id' WHERE id=v_id AND tenant_id=c.tenant_id AND workflow_id IS NULL;first_id:=coalesce(first_id,v_id);END IF;
 END LOOP;
 PERFORM app.probation_audit(c.id,p.id,'workflow_run',p_reason);RETURN first_id;
END $$;
CREATE FUNCTION app.probation_notification_content(p_tenant uuid,p_event uuid,p_user uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_occurrence;c probation_case;p probation_part;w probation_builder_definition;s jsonb;words jsonb;h jsonb;subject text;body text;k text;value text;roles jsonb;eligible boolean:=false;prior_tenant text:=current_setting('app.tenant_id',true);
BEGIN
 SELECT * INTO o FROM probation_occurrence WHERE tenant_id=p_tenant AND source_event_id=p_event AND state='scheduled' AND recipient_user_ids?p_user::text;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=p_tenant;
 IF c.id IS NULL OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') AND o.kind<>'letter_released' OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=p_tenant AND company_id=c.company_id AND enabled AND activation_on<=o.due_on) OR NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_user AND tenant_id=p_tenant AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RETURN NULL;END IF;
 SELECT * INTO p FROM probation_part WHERE id=o.part_id AND tenant_id=p_tenant;
 SELECT * INTO w FROM probation_builder_definition WHERE id=o.workflow_id AND tenant_id=p_tenant AND company_id=c.company_id AND kind='workflow' AND state='published' AND c.data->'workflowIds'?id::text;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT value INTO s FROM jsonb_array_elements(w.data->'steps') WHERE value->>'id'=o.workflow_step_id AND value->>'type'='notify';IF s IS NULL THEN RETURN NULL;END IF;
 -- Resolve authority using explicit source tenant, never caller-supplied identity/role GUCs.
 -- Existing holder resolver is tenant-bound, so derive temporary scope only inside this non-callable helper.
 PERFORM set_config('app.tenant_id',p_tenant::text,true);h:=app.probation_holders(c.employment_id);
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements_text(o.recipient_roles) r WHERE r<>'gbs' AND h->>r=p_user::text AND NOT(o.kind='review_reminder' AND r='employee' AND p.data->>'staffSubmittedAt' IS NOT NULL) AND NOT(o.kind='review_reminder' AND r='lm' AND p.data->>'managerSubmittedAt' IS NOT NULL)) OR o.recipient_roles?'gbs' AND EXISTS(SELECT 1 FROM probation_access a WHERE a.tenant_id=p_tenant AND a.user_id=p_user AND a.role='gbs' AND app.is_company_descendant(c.company_id,a.company_id) AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) INTO eligible;
 PERFORM set_config('app.tenant_id',coalesce(prior_tenant,''),true);IF NOT eligible THEN RETURN NULL;END IF;
 subject:=s->>'subject';body:=s->>'body';words:=jsonb_build_object('employeeName',c.data->'facts'->>'employeeName','employeeCode',c.data->'facts'->>'employeeCode','companyName',c.data->'facts'->>'companyName','part',p.data->>'type','dueOn',p.data->>'dueOn','endOn',c.data->>'endOn');
 FOR k,value IN SELECT key,coalesce(v,'') FROM jsonb_each_text(words) e(key,v) LOOP subject:=replace(subject,'{{'||k||'}}',value);body:=replace(body,'{{'||k||'}}',value);END LOOP;
 IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR subject~E'[\r\n]' OR body IS NULL OR length(body) NOT BETWEEN 1 AND 20000 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('subject',subject,'body',body);
END $$;
REVOKE ALL ON FUNCTION app.probation_notification_content(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.probation_personnel_intent(p_outcome uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;v jsonb;months integer;new_end date;e employment;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Released outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR UPDATE;
 IF NOT(app.probation_role(e.id,'gbs') OR app.probation_storage_runner()) OR o.released_at IS NULL OR o.outcome NOT IN('confirm','extend') OR NOT app.probation_signatures_complete(o.part_id) THEN RAISE EXCEPTION 'Released signed GBS outcome authority required';END IF;PERFORM app.probation_assert_runtime(c.company_id);
 SELECT data INTO v FROM probation_rater_draft WHERE part_id=o.part_id AND tenant_id=o.tenant_id AND rater='lm';
 IF v->>'outcome' IS DISTINCT FROM o.outcome OR e.terminated_on IS NOT NULL OR e.resignation_date IS NOT NULL THEN RAISE EXCEPTION 'Personnel outcome source changed';END IF;
 IF o.outcome='extend' THEN months:=(v->>'extensionMonths')::integer;IF months NOT IN(3,6) OR (c.data->>'extensionCount')::integer>=2 OR NOT EXISTS(SELECT 1 FROM probation_part WHERE id=o.part_id AND data->>'pbpExtensionConfirmed'='true') THEN RAISE EXCEPTION 'Current PBP confirmed extension required';END IF;new_end:=((c.data->>'endOn')::date+interval '1 day'+(months::text||' months')::interval-interval '1 day')::date;END IF;
 RETURN jsonb_build_object('outcomeId',o.id,'employmentId',e.id,'kind',CASE WHEN o.outcome='confirm' THEN 'confirmation' ELSE 'probationExtension' END,'effectiveDate',CASE WHEN o.outcome='confirm' THEN c.data->>'endOn' ELSE (o.released_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text END,'endDate',new_end,'sourceKey',o.source_key,'completed',o.state='completed');
END $$;
CREATE FUNCTION app.probation_offboarding_intent(p_case uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;o probation_outcome;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT(app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp') OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'Scoped probation handoff authority required';END IF;PERFORM app.probation_assert_runtime(c.company_id);
 SELECT * INTO o FROM probation_outcome WHERE case_id=c.id AND tenant_id=c.tenant_id AND outcome='not_confirm' AND released_at IS NOT NULL ORDER BY released_at DESC,id DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR NOT app.probation_signatures_complete(o.part_id) OR c.data->>'state' NOT IN('outcome_pending','not_confirmed') THEN RAISE EXCEPTION 'Released current nonconfirmation letter and signed decision required';END IF;
 RETURN jsonb_build_object('caseId',c.id,'employmentId',c.employment_id,'type','Non-confirmation','noticeDate',(o.released_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date,'lastDay',c.data->>'endOn','manualHandoff',false,'letterDocumentId',o.letter_file_id,'offboardingCaseId',o.handoff_ref);
END $$;
CREATE FUNCTION app.probation_offboarding_sequence(p_case uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent jsonb;result bigint;
BEGIN
 intent:=app.probation_offboarding_intent(p_case);IF intent->>'offboardingCaseId' IS NOT NULL OR (intent->>'noticeDate')::date>(intent->>'lastDay')::date THEN RAISE EXCEPTION 'Probation handoff completed or requires actual date reconciliation';END IF;
 INSERT INTO tenant_counter(tenant_id,kind,value) VALUES(app.current_tenant_id(),'OFB9',1) ON CONFLICT(tenant_id,kind) DO UPDATE SET value=tenant_counter.value+1 RETURNING value INTO result;RETURN result;
END $$;

CREATE FUNCTION app.probation_cutover_snapshot(p_company uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT(app.probation_config_admin(p_company) OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'Named cutover preparer required';END IF;
 SELECT jsonb_build_object('companyId',p_company,'personnel',coalesce(jsonb_agg(jsonb_build_object('id',e.id,'joinDate',e.join_date,'hiredOn',e.hired_on,'endOn',coalesce(e.extended_confirmation_date,e.normal_confirmation_date,e.probation_end_date,e.provisional_end_on),'gradeId',e.grade_id,'confirmation',e.confirmation_date,'resignation',e.resignation_date,'termination',e.terminated_on) ORDER BY e.id),'[]'),'configurations',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'kind',kind) ORDER BY kind,version),'[]') FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND state='published'),'cases',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'revision',c.revision,'state',c.data->>'state') ORDER BY c.id),'[]') FROM probation_case c WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=p_company)) INTO result FROM employment e WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=p_company;
 RETURN result;
END $$;
CREATE FUNCTION app.probation_prepare_cutover(p_company uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE data jsonb;fingerprint text;v_id uuid;
BEGIN
 data:=app.probation_cutover_snapshot(p_company);fingerprint:=encode(sha256(convert_to(data::text,'UTF8')),'hex');
 INSERT INTO probation_cutover(tenant_id,company_id,data,digest,actor_user_id) VALUES(app.current_tenant_id(),p_company,data,fingerprint,app.current_user_id()) RETURNING id INTO v_id;
 RETURN jsonb_build_object('id',v_id,'digest',fingerprint,'snapshot',data,'sends',false);
END $$;
ALTER TABLE probation_cutover ADD COLUMN approved_by uuid REFERENCES app_user(id),ADD COLUMN approved_at timestamptz,ADD COLUMN reason text;
CREATE FUNCTION app.probation_approve_cutover(p_id uuid,p_digest text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_cutover;
BEGIN
 SELECT * INTO c FROM probation_cutover WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.probation_config_admin(c.company_id) OR c.applied_at IS NOT NULL OR c.digest<>p_digest OR length(btrim(coalesce(p_reason,'')))<3 OR encode(sha256(convert_to(app.probation_cutover_snapshot(c.company_id)::text,'UTF8')),'hex')<>c.digest THEN RAISE EXCEPTION 'Review and approve the unchanged current cutover dry run';END IF;
 UPDATE probation_cutover SET approved_by=app.current_user_id(),approved_at=now(),reason=p_reason WHERE id=c.id;
END $$;
-- Activation is deliberately an owner/deployment operation, never an application-user permission.
-- Approval records review intent; it does not silently activate production or replay missed dates.
CREATE FUNCTION app.probation_activate_cutover(p_id uuid,p_day date) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_cutover;
BEGIN
 IF NOT app.probation_storage_runner() OR p_day<>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Explicit owner current-day activation required';END IF;
 SELECT * INTO c FROM probation_cutover WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR c.approved_by IS NULL OR c.applied_at IS NOT NULL OR c.created_at<now()-interval '1 day' OR c.digest<>encode(sha256(convert_to(app.probation_cutover_snapshot(c.company_id)::text,'UTF8')),'hex') OR NOT EXISTS(SELECT 1 FROM probation_access a JOIN app_user u ON u.id=a.user_id AND u.tenant_id=a.tenant_id WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.role='admin' AND a.user_id=c.approved_by AND a.valid_from<=p_day AND (a.valid_to IS NULL OR a.valid_to>=p_day) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'A fresh named approved cutover is required';END IF;
 INSERT INTO probation_activation(tenant_id,company_id,enabled,activation_on,dry_run_digest,approved_by) VALUES(c.tenant_id,c.company_id,true,p_day,c.digest,c.approved_by) ON CONFLICT(tenant_id,company_id) DO UPDATE SET enabled=true,activation_on=p_day,dry_run_digest=c.digest,approved_by=c.approved_by,updated_at=now();
 UPDATE probation_cutover SET applied_at=now() WHERE id=c.id;
END $$;
CREATE FUNCTION app.probation_owns_legacy(p_employment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM probation_case c JOIN probation_activation a ON a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled WHERE c.employment_id=p_employment AND c.tenant_id=app.current_tenant_id());
$$;

ALTER TABLE probation_outcome ADD COLUMN letter_part_id uuid REFERENCES probation_part(id);
CREATE FUNCTION app.probation_prepare_letter(p_outcome uuid,p_template uuid,p_merge jsonb,p_base bytea,p_expected integer,p_source_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;p probation_part;source jsonb;merged jsonb;rules jsonb;v_part uuid:=gen_random_uuid();basehash text;descriptor jsonb;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Recorded outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;PERFORM app.probation_assert_runtime(c.company_id);
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR o.revision<>p_expected OR o.released_at IS NOT NULL OR o.outcome='other' OR NOT app.probation_signatures_complete(o.part_id) THEN RAISE EXCEPTION 'Scoped reviewer and current signed recorded outcome required';END IF;
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND state='published' AND definition_key=o.outcome AND data->>'unfinished'='false';
 IF NOT FOUND OR octet_length(p_base) NOT BETWEEN 5 AND 10485760 OR substring(p_base FROM 1 FOR 5)<>convert_to('%PDF-','UTF8') THEN RAISE EXCEPTION 'Use a complete published matching template and server rendered PDF';END IF;
 PERFORM 1 FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR SHARE;descriptor:=app.probation_letter_preview(o.id,t.id,p_merge,p_expected);IF descriptor->>'sourceDigest' IS DISTINCT FROM p_source_digest THEN RAISE EXCEPTION 'The letter source changed; preview and render it again';END IF;merged:=descriptor->'merge';
 SELECT jsonb_build_object('requiredRoles',jsonb_agg(DISTINCT s->>'role')) INTO rules FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'required'='true';
 IF rules->'requiredRoles' IS NULL OR jsonb_array_length(rules->'requiredRoles')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'role' NOT IN('pbp','lm','hod','employee') OR s->>'holderId' IS NOT NULL OR s->>'representedId' IS NOT NULL) THEN RAISE EXCEPTION 'Letter routes need current source roles and required signers';END IF;
 PERFORM app.document_signing_validate(jsonb_build_object('route',t.data->'route','actions','[]'::jsonb),rules);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(t.data->'route'->'steps') staff CROSS JOIN jsonb_array_elements(t.data->'route'->'steps') hr WHERE staff->>'role'='employee' AND hr->>'role'<>'employee' AND (staff->>'stage')::integer<=(hr->>'stage')::integer) THEN RAISE EXCEPTION 'HR signing must precede employee acknowledgement';END IF;
 basehash:=encode(sha256(p_base),'hex');
 -- A new draft has its own immutable signing subject; previous signed subjects remain readable history.
 INSERT INTO probation_part(id,tenant_id,case_id,data) VALUES(v_part,c.tenant_id,c.id,jsonb_build_object('id',v_part,'documentKind','letter','evaluationPartId',o.part_id,'letterOutcomeId',o.id,'letterTemplateId',t.id,'letterTemplateVersion',t.version,'letterMerge',merged,'letterBlocks',t.data->'blocks','letterFields',coalesce(t.data->'fields','[]'),'letterBaseHash',basehash,'letterGuardrails',rules,'route',t.data->'route','state','pending_approval','type',0,'cycle',o.revision));
 IF o.letter_part_id IS NOT NULL THEN UPDATE probation_part SET data=jsonb_set(data,'{state}','"cancelled"'),revision=revision+1 WHERE id=o.letter_part_id AND tenant_id=o.tenant_id;END IF;
 UPDATE probation_outcome SET template_id=t.id::text,template_version=t.version,merge_data=merged,letter_part_id=v_part,state='awaiting_release',revision=revision+1,updated_at=now() WHERE id=o.id;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(c.tenant_id,v_part,'meta',1,(SELECT data FROM probation_part WHERE id=v_part),app.current_user_id(),'Prepared outcome letter');
 PERFORM app.probation_audit(c.id,v_part,'letter_prepared');
 RETURN app.probation_signing_content(v_part)||jsonb_build_object('partId',v_part,'outcomeRevision',o.revision+1,'route',app.probation_resolved_route(v_part),'guardrails',rules,'merge',merged,'blocks',t.data->'blocks','fields',coalesce(t.data->'fields','[]'));
END $$;
CREATE FUNCTION app.probation_release_signed_letter(p_outcome uuid,p_part uuid,p_expected integer,p_final bytea,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;p probation_part;v_id uuid;doc uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF o.letter_part_id IS DISTINCT FROM p.id OR p.case_id IS DISTINCT FROM c.id OR p.data->>'letterOutcomeId' IS DISTINCT FROM o.id::text OR p.data->>'documentKind'<>'letter' OR o.revision<>p_expected OR length(btrim(coalesce(p_reason,'')))<3 OR NOT app.probation_signatures_complete(p.id) OR NOT app.probation_signatures_complete(o.part_id) OR o.outcome IN('extend','not_confirm') AND NOT app.probation_role(c.employment_id,'pbp') OR o.outcome='confirm' AND NOT(app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp')) THEN RAISE EXCEPTION 'Current authorised release and complete matching letter signatures required';END IF;
 PERFORM app.probation_assert_runtime(c.company_id);IF o.released_at IS NOT NULL THEN RETURN o.letter_file_id;END IF;
 IF octet_length(p_final) NOT BETWEEN 5 AND 10485760 OR substring(p_final FROM 1 FOR 5)<>convert_to('%PDF-','UTF8') THEN RAISE EXCEPTION 'Final server rendered signed PDF required';END IF;
 INSERT INTO employee_document(tenant_id,employment_id,title,category,description,content,file_name,mime_type,size_bytes,uploaded_by_user_id,updated_by_user_id) VALUES(c.tenant_id,c.employment_id,'Probation outcome letter','Probation',p_reason,p_final,'probation-outcome-'||o.revision::text||'.pdf','application/pdf',octet_length(p_final),app.current_user_id(),app.current_user_id()) RETURNING id INTO doc;
 INSERT INTO probation_file(tenant_id,case_id,part_id,kind,revision,name,content,content_hash,employee_document_id,created_by) VALUES(c.tenant_id,c.id,p.id,'letter_released',p.content_revision,'probation-outcome-'||o.revision::text||'.pdf',p_final,encode(sha256(p_final),'hex'),doc,app.current_user_id()) RETURNING id INTO v_id;
 UPDATE probation_outcome SET state='released',letter_file_id=v_id,released_by=app.current_user_id(),released_at=now(),updated_at=now() WHERE id=o.id;
 UPDATE probation_part SET data=jsonb_set(data,'{state}','"locked"'),revision=revision+1 WHERE id=p.id;PERFORM app.probation_audit(c.id,p.id,'letter_released',p_reason);RETURN v_id;
END $$;
CREATE FUNCTION identity_email.private_workflow_mail(p_delivery uuid,p_token uuid,p_issuer text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.private_workflow_mail(p_delivery,p_token,p_issuer,true);
$$;
REVOKE ALL ON FUNCTION identity_email.private_workflow_mail(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='aihr_identity_email') THEN GRANT EXECUTE ON FUNCTION identity_email.private_workflow_mail(uuid,uuid,text) TO aihr_identity_email;END IF;END $$;

-- Close every native boundary, including helper functions created earlier in this migration.
DO $$ DECLARE fn regprocedure;name text;BEGIN
 FOR fn,name IN SELECT p.oid::regprocedure,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'probation\_%' ESCAPE '\' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,ai_hr_app',fn);
  IF name=ANY(ARRAY['probation_config_admin','probation_role','probation_storage_runner','probation_case_access','probation_part_access','probation_signing_guardrails','probation_signing_content','probation_config_write','probation_assign_access','probation_admit','probation_save_draft','probation_part_command','probation_definition_save','probation_followup_add','probation_delegate_add','probation_route_override','probation_personnel_source','probation_resolved_route','probation_bootstrap_admin','probation_issue','probation_withdraw','probation_notification_recipients','probation_file_save','probation_record_effect','probation_outcome_failure','probation_prepare_signing','probation_case_holder_names','probation_commands','probation_workflow_run','probation_personnel_intent','probation_offboarding_intent','probation_offboarding_sequence','probation_prepare_cutover','probation_approve_cutover','probation_owns_legacy','probation_prepare_letter','probation_release_signed_letter']) THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ai_hr_app',fn);END IF;
 END LOOP;
END $$;
CREATE INDEX probation_case_company_state ON probation_case(tenant_id,company_id,(data->>'state'));
CREATE INDEX probation_part_case ON probation_part(tenant_id,case_id);
CREATE INDEX probation_occurrence_event ON probation_occurrence(tenant_id,source_event_id);
CREATE INDEX probation_access_holder ON probation_access(tenant_id,user_id,company_id,role,valid_from);

CREATE FUNCTION app.probation_letter_preview(p_outcome uuid,p_template uuid,p_edits jsonb,p_expected integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;source jsonb;merged jsonb;descriptor jsonb;rules jsonb;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF o.id IS NULL OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR o.revision<>p_expected OR o.released_at IS NOT NULL OR o.outcome='other' OR NOT app.probation_signatures_complete(o.part_id) THEN RAISE EXCEPTION 'Scoped reviewer and current signed outcome required for letter preview';END IF;PERFORM app.probation_assert_runtime(c.company_id);
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND state='published' AND definition_key=o.outcome AND data->>'unfinished'='false';IF NOT FOUND THEN RAISE EXCEPTION 'Matching approved published letter template required';END IF;
 IF jsonb_typeof(coalesce(p_edits,'{}'))<>'object' OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(p_edits,'{}')) e WHERE jsonb_typeof(e.value)<>'string' OR length(e.value#>>'{}')>10000 OR e.key IN('employeeName','employeeCode','companyName','startOn','endOn','outcome','extensionMonths') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(t.data->'fields','[]')) f WHERE f->>'id'=e.key AND f->>'owner'='hr' AND f->>'pmKey' IS NULL)) THEN RAISE EXCEPTION 'Only declared editable HR fields may be supplied';END IF;
 source:=app.probation_personnel_source(c.employment_id);merged:=coalesce(p_edits,'{}')||jsonb_build_object('employeeName',source->>'employeeName','employeeCode',source->>'employeeCode','companyName',source->>'companyName','startOn',c.data->>'startOn','endOn',c.data->>'endOn','outcome',o.outcome,'extensionMonths',(SELECT data->>'extensionMonths' FROM probation_rater_draft WHERE part_id=o.part_id AND tenant_id=o.tenant_id AND rater='lm'));
 SELECT jsonb_build_object('requiredRoles',jsonb_agg(DISTINCT s->>'role')) INTO rules FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'required'='true';
 descriptor:=jsonb_build_object('merge',merged,'blocks',t.data->'blocks','fields',coalesce(t.data->'fields','[]'),'route',t.data->'route','guardrails',rules,'companyId',c.company_id,'employmentId',c.employment_id,'templateId',t.id,'templateVersion',t.version,'outcomeRevision',o.revision);
 RETURN descriptor||jsonb_build_object('sourceDigest',encode(sha256(convert_to(descriptor::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_preview(uuid,uuid,jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_preview(uuid,uuid,jsonb,integer) TO ai_hr_app;
