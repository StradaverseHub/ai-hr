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
 state text NOT NULL CHECK(state IN('pending','draft','awaiting_release','released','release_requested','awaiting_revision','movement_done','handoff_done','completed','failed')),
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
CREATE FUNCTION app.probation_company_entitled(p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM tenant_module m JOIN tenant t ON t.id=m.tenant_id WHERE m.tenant_id=app.current_tenant_id() AND m.module_code='lifecycle' AND (m.company_id IS NULL OR m.company_id=p_company) AND m.status IN('active','trial') AND m.activated_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now()) AND t.status IN('active','trial'));
$$;
CREATE FUNCTION app.probation_active_user() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)),false);
$$;
CREATE FUNCTION app.probation_config_admin(p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_active_user() AND app.probation_company_entitled(p_company) AND EXISTS(SELECT 1 FROM probation_access a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.role='admin' AND app.is_company_descendant(p_company,a.company_id) AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) AND app.is_admin_for(p_company);
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
 v_pbp:=app.lifecycle_canonical_pbp_user(e.id);IF v_pbp IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user signer JOIN person identity ON identity.id=signer.person_id AND identity.tenant_id=signer.tenant_id WHERE signer.id=v_pbp AND signer.tenant_id=e.tenant_id AND length(btrim(identity.full_name))>0) THEN v_pbp:=NULL;END IF;IF v_pbp IS NOT NULL AND NOT EXISTS(SELECT 1 FROM probation_access mapping WHERE mapping.tenant_id=e.tenant_id AND mapping.user_id=v_pbp AND mapping.role='pbp' AND app.is_company_descendant(e.company_id,mapping.company_id) AND (mapping.department_id IS NULL OR mapping.department_id=a.department_id) AND (mapping.business_unit_id IS NULL OR mapping.business_unit_id=a.business_unit_id) AND mapping.valid_from<=day AND (mapping.valid_to IS NULL OR mapping.valid_to>=day)) THEN v_pbp:=NULL;END IF;v_pbp_count:=CASE WHEN v_pbp IS NULL THEN 0 ELSE 1 END;
 RETURN jsonb_build_object('employee',app.probation_user_for(e.id),'lm',v_lm,'hod',v_hod,'pbp',v_pbp,'pbpAmbiguous',v_pbp_count>1,'companyId',e.company_id,'departmentId',a.department_id,'businessUnitId',a.business_unit_id);
END $$;
CREATE FUNCTION app.probation_role(p_employment uuid,p_role text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h jsonb;co uuid;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF NOT app.probation_active_user() THEN RETURN false;END IF;
 h:=app.probation_holders(p_employment);co:=(h->>'companyId')::uuid;IF co IS NULL OR NOT app.probation_company_entitled(co) THEN RETURN false;END IF;
 IF p_role IN('employee','lm','hod','pbp') THEN RETURN coalesce(h->>p_role=app.current_user_id()::text,false);END IF;
 IF p_role='gbs' THEN RETURN app.probation_gbs_user(p_employment,app.current_user_id());END IF;
 RETURN false;
END $$;
CREATE FUNCTION app.probation_storage_runner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NULL AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolname='ai_hr_owner' OR rolsuper));
$$;
CREATE FUNCTION app.probation_case_company_current(p_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM probation_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND c.data->>'sourceCompanyMoved' IS DISTINCT FROM 'true');
$$;
CREATE FUNCTION app.probation_case_access(p_case uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN false;END IF;IF app.probation_storage_runner() THEN RETURN true;END IF;
 IF app.probation_company_entitled(c.company_id) IS NOT TRUE THEN RETURN false;END IF;
 IF app.probation_case_company_current(c.id) IS NOT TRUE THEN RETURN app.probation_active_user() AND EXISTS(SELECT 1 FROM employment e JOIN app_user self ON self.person_id=e.person_id AND self.tenant_id=e.tenant_id WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND self.id=app.current_user_id());END IF;
 RETURN coalesce(app.probation_role(c.employment_id,'employee') OR app.probation_role(c.employment_id,'lm') OR app.probation_role(c.employment_id,'hod') OR app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR app.probation_active_user() AND EXISTS(SELECT 1 FROM probation_delegate d JOIN probation_part p ON p.id=d.part_id AND p.tenant_id=d.tenant_id WHERE p.case_id=c.id AND d.tenant_id=c.tenant_id AND d.holder_id=app.current_user_id() AND d.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (d.valid_to IS NULL OR d.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) OR app.probation_current_escalated_actor(c.id),false);
END $$;
CREATE FUNCTION app.probation_case_source_moved(p_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_case_access(p_case) AND NOT app.probation_case_company_current(p_case);
$$;
CREATE FUNCTION app.probation_part_access(p_part uuid,p_rater text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;e uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RETURN false;END IF;
 SELECT employment_id INTO e FROM probation_case WHERE id=p.case_id AND tenant_id=app.current_tenant_id();
 IF app.probation_case_company_current(p.case_id) IS NOT TRUE THEN IF app.probation_storage_runner() THEN RETURN true;END IF;IF p.data->>'documentKind'='letter' THEN RETURN p.data->>'state'='locked';END IF;RETURN p_rater IS NULL OR p_rater='employee' OR p_rater='lm' AND p.data->>'managerSubmittedAt' IS NOT NULL;END IF;
 IF p.data->>'documentKind'='letter' THEN RETURN app.probation_storage_runner() OR app.probation_role(e,'pbp') OR app.probation_role(e,'gbs') OR EXISTS(SELECT 1 FROM document_signing_document d CROSS JOIN LATERAL jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') st WHERE d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id AND st->>'holderId'=app.current_user_id()::text AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') prior WHERE (prior->>'stage')::integer<(st->>'stage')::integer AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=prior->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash')));END IF;
 IF p_rater IS NULL OR app.probation_role(e,'pbp') OR app.probation_role(e,'gbs') THEN RETURN true;END IF;
 IF p_rater='employee' THEN RETURN app.probation_role(e,'employee') OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'acknowledgedAt' IS NOT NULL;END IF;
 IF p_rater='lm' THEN RETURN app.probation_part_role(p.id,'lm') OR p.data->>'managerSubmittedAt' IS NOT NULL;END IF;
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
CREATE POLICY probation_revision_read ON probation_revision FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (rater='meta' AND app.probation_part_access(part_id) OR rater<>'meta' AND EXISTS(SELECT 1 FROM probation_part p JOIN probation_case c ON c.id=p.case_id AND c.tenant_id=p.tenant_id WHERE p.id=part_id AND p.tenant_id=probation_revision.tenant_id AND NOT app.probation_case_source_moved(c.id) AND (app.probation_role(c.employment_id,rater) OR app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')))));
CREATE POLICY probation_followup_read ON probation_followup FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_case_access(case_id) AND NOT app.probation_case_source_moved(case_id) AND EXISTS(SELECT 1 FROM probation_case c WHERE c.id=case_id AND c.tenant_id=probation_followup.tenant_id AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs'))));
CREATE POLICY probation_file_read ON probation_file FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_case_access(case_id) AND (kind<>'letter_draft' OR EXISTS(SELECT 1 FROM probation_case c WHERE c.id=case_id AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')))));
CREATE POLICY probation_outcome_read ON probation_outcome FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_case_access(case_id) AND (state IN('released','movement_done','handoff_done','completed') OR NOT app.probation_case_source_moved(case_id) AND EXISTS(SELECT 1 FROM probation_case c WHERE c.id=case_id AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')))));
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
 IF NOT app.probation_company_entitled(p_company) OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND enabled AND activation_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) THEN RAISE EXCEPTION 'Probation runtime is not activated for this company';END IF;
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
 IF p_role='employee' THEN RETURN (p.data->>'type')::integer<>1 AND app.probation_assessment_ready(form,v->'employee',false);END IF;
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
 SELECT CASE WHEN p.data->>'documentKind'='letter' THEN jsonb_build_object('partId',p.id,'caseId',p.case_id,'generation',p.content_revision,'templateId',p.data->'letterTemplateId','templateVersion',p.data->'letterTemplateVersion','templateName',p.data->'letterTemplateName','blocks',p.data->'letterBlocks','fields',p.data->'letterFields','merge',p.data->'letterMerge','baseHash',p.data->'letterBaseHash','sourceStamp',p.data->'letterSourceStamp') ELSE jsonb_build_object('caseId',p.case_id,'partId',p.id,'generation',p.content_revision,'formId',c.form_id,'type',p.data->'type','cycle',p.data->'cycle','reviewOn',p.data->'reviewOn','conductedBy',p.data->'conductedBy','personnel',p.data->'signingFacts','period',p.data->'signingPeriod','acknowledgedKpis',p.data->'signingKpis','manager',(SELECT data FROM probation_rater_draft WHERE part_id=p.id AND rater='lm'),'employeeAssessment',CASE WHEN p.data->>'staffSubmittedAt' IS NOT NULL THEN (SELECT data->'employee' FROM probation_rater_draft WHERE part_id=p.id AND rater='employee') ELSE NULL END) END FROM probation_part p JOIN probation_case c ON c.id=p.case_id AND c.tenant_id=p.tenant_id WHERE p.id=p_part AND p.tenant_id=app.current_tenant_id();
$$;
CREATE FUNCTION app.probation_signing_guardrails(p_subject uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN data->>'documentKind'='letter' THEN data->'letterGuardrails' ELSE jsonb_build_object('requiredRoles',jsonb_build_array('lm','employee'))||CASE WHEN data->>'type'='3' THEN jsonb_build_object('independentApprovalFromRole','lm') ELSE '{}'::jsonb END END FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id() AND app.probation_part_access(p_subject);
$$;
CREATE FUNCTION app.probation_signing_route_allowed(p_subject uuid,p_route jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE expected jsonb;actual_steps jsonb;expected_steps jsonb;
BEGIN
 expected:=app.probation_resolve_route_unchecked(p_subject);
 IF expected IS NULL OR jsonb_typeof(p_route->'steps') IS DISTINCT FROM 'array' OR (expected-'steps') IS DISTINCT FROM (p_route-'steps') THEN RETURN false;END IF;
 SELECT jsonb_agg((step-ARRAY['holderPersonId','representedId'])||jsonb_build_object('representedId',step->>'representedId') ORDER BY ordinal)
 INTO actual_steps FROM jsonb_array_elements(p_route->'steps') WITH ORDINALITY AS steps(step,ordinal);
 SELECT jsonb_agg((step-ARRAY['holderPersonId','representedId'])||jsonb_build_object('representedId',step->>'representedId') ORDER BY ordinal)
 INTO expected_steps FROM jsonb_array_elements(expected->'steps') WITH ORDINALITY AS steps(step,ordinal);
 RETURN expected_steps IS NOT NULL AND actual_steps IS NOT DISTINCT FROM expected_steps;
END $$;
CREATE FUNCTION app.probation_signing_access(p_subject uuid,p_operation text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;step jsonb;
BEGIN
 IF coalesce(p_operation,'') NOT IN('create','read','sign','revise','reroute','decline') THEN RETURN false;END IF;
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_active_user() OR NOT app.probation_case_access(p.case_id) THEN RETURN false;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p_operation='read' THEN RETURN app.probation_part_access(p.id);END IF;
 IF app.probation_case_company_current(c.id) IS NOT TRUE OR app.probation_owns_legacy(c.employment_id) IS NOT TRUE OR NOT app.probation_company_entitled(c.company_id) OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled','not_issued','release_requested') THEN RETURN false;END IF;
 IF p.data->>'documentKind'='letter' THEN
 IF p_operation IN('create','revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs');END IF;
 IF p_operation='sign' THEN RETURN p.data->>'state'<>'returned' AND app.probation_letter_source_current(p.id) AND EXISTS(SELECT 1 FROM document_signing_document doc CROSS JOIN LATERAL jsonb_array_elements(doc.data->'route'->'steps') st WHERE doc.tenant_id=p.tenant_id AND doc.subject_type='probation' AND doc.subject_id=p.id AND st->>'holderId'=app.current_user_id()::text AND (app.probation_role(c.employment_id,st->>'role') OR EXISTS(SELECT 1 FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=st->>'id' AND x.holder_id=app.current_user_id() AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))));END IF;RETURN false;END IF;
 IF p_operation='create' THEN RETURN app.probation_part_role(p.id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation IN('revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR p.data->>'managerSubmittedAt' IS NULL AND app.probation_part_role(p.id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation='decline' THEN RETURN app.probation_role(c.employment_id,'pbp') AND EXISTS(SELECT 1 FROM probation_followup WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='refusal_request' AND content_revision=p.content_revision) AND p.data->>'managerSubmittedAt' IS NOT NULL;END IF;
 IF p_operation<>'sign' THEN RETURN false;END IF;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 FOR step IN SELECT value FROM jsonb_array_elements(d.data->'route'->'steps') LOOP
 IF step->>'holderId'=app.current_user_id()::text AND (step->>'role' IN('hod','pbp') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='employee' AND app.probation_role(c.employment_id,'employee') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='lm' AND app.probation_part_role(p.id,'lm') AND p.data->>'managerSubmittedAt' IS NULL AND app.probation_submission_ready(p.id,'lm')) THEN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') current_step WHERE current_step->>'id'=step->>'id' AND current_step->>'holderId'=app.current_user_id()::text) THEN RETURN true;END IF;
 END IF;END LOOP;RETURN false;
END $$;
-- Internal helpers are never callable to manufacture audit/provenance or read private hashes.
REVOKE ALL ON FUNCTION app.probation_audit(uuid,uuid,text,text),app.probation_content(uuid),app.probation_submission_ready(uuid,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_effective_settings(p_settings jsonb,p_facts jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_settings||coalesce((SELECT jsonb_build_object('kpiGate',r->>'kpiGate') FROM jsonb_array_elements(coalesce(p_settings->'overrides','[]')) WITH ORDINALITY rules(r,n) WHERE (r->>'businessGroupId' IS NULL OR r->>'businessGroupId'=p_facts->>'businessGroupId') AND (r->>'businessUnitId' IS NULL OR r->>'businessUnitId'=p_facts->>'businessUnitId') AND (r->>'grade' IS NULL OR r->>'grade'=p_facts->>'grade') AND (r->>'months' IS NULL OR (r->>'months')::integer=coalesce((p_facts->>'probationMonths')::integer,(SELECT n FROM generate_series(1,120) n WHERE ((p_facts->>'startOn')::date+(n::text||' months')::interval-interval '1 day')::date=coalesce((p_facts->>'originalEndOn')::date,(p_facts->>'endOn')::date) LIMIT 1),CASE WHEN p_facts->>'unknownPeriod'='true' THEN CASE WHEN p_facts->>'grade'='H' THEN 3 ELSE (p_settings->>'defaultMonths')::integer END ELSE NULL END)) ORDER BY num_nonnulls(r->>'businessGroupId',r->>'businessUnitId',r->>'grade',r->>'months') DESC,n DESC LIMIT 1),'{}'::jsonb);
$$;
CREATE FUNCTION app.probation_config_write(p_company uuid,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n integer;v_id uuid;route jsonb;part integer;rule jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_config_admin(p_company) OR p_kind NOT IN('settings','form','route') OR jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Named probation administrator required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||p_company::text||p_kind,0));
 IF p_expected IS NULL OR p_expected<>(SELECT coalesce(max(version),0) FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind=p_kind) THEN RAISE EXCEPTION 'Probation configuration changed; reload before saving';END IF;
 IF p_publish AND p_kind='form' THEN
 IF p_data?'targetGrades' AND (jsonb_typeof(p_data->'targetGrades')<>'array' OR jsonb_array_length(p_data->'targetGrades')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_data->'targetGrades') g WHERE g NOT IN('12','13','14','15','16','17','18','19','20','21','22','23','H'))) THEN RAISE EXCEPTION 'Choose explicit supported form grades';END IF;
 IF EXISTS(SELECT 1 FROM probation_configuration f WHERE f.tenant_id=app.current_tenant_id() AND f.company_id=p_company AND f.kind='form' AND f.state='published' AND app.probation_is_current_publication('form',f.id) AND coalesce(f.data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]')<>coalesce(p_data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]') AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(f.data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]')) g WHERE coalesce(p_data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]')?g)) THEN RAISE EXCEPTION 'Form grade variants must be disjoint; revise the same grade set or publish a distinct H form';END IF;
 IF jsonb_typeof(p_data->'criteria') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'criteria') NOT BETWEEN 1 AND 30 OR jsonb_typeof(p_data->'ratingLabels') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'ratingLabels') IS DISTINCT FROM 5 OR jsonb_typeof(p_data->'bands') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'bands') IS DISTINCT FROM 5 THEN RAISE EXCEPTION 'Complete the form criteria, rating labels and bands';END IF;
 IF (SELECT sum((c->>'weight')::integer) FROM jsonb_array_elements(p_data->'criteria') c) IS DISTINCT FROM 100 OR (SELECT sum((c->>'weight')::integer) FROM jsonb_array_elements(p_data->'criteria') c WHERE c->>'section'='role') IS DISTINCT FROM 50 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'criteria') c WHERE c->>'section' NOT IN('role','principles') OR coalesce(c->>'weight','') !~ '^[0-9]+$' OR c->>'id' !~ '^[a-z][a-z0-9_]{0,39}$' OR (c->>'weight')::integer NOT BETWEEN 1 AND 100 OR length(btrim(coalesce(c->>'title','')))=0 OR length(btrim(coalesce(c->>'standard','')))=0 OR length(btrim(coalesce(c->>'prompt','')))=0) OR (SELECT count(DISTINCT c->>'id') FROM jsonb_array_elements(p_data->'criteria') c)<>jsonb_array_length(p_data->'criteria') THEN RAISE EXCEPTION 'Form weights, identities and guidance are invalid';END IF;
 END IF;
 IF p_kind='settings' THEN
  p_data:=p_data||jsonb_build_object('gradeHFormPublished',EXISTS(SELECT 1 FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='form' AND state='published' AND app.probation_is_current_publication('form',id) AND data->'targetGrades'?'H'));
 END IF;
 IF p_publish AND p_kind='settings' THEN
 IF jsonb_typeof(p_data->'eligibleGrades') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'eligibleGrades')=0
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_data->'eligibleGrades') AS grade(code) WHERE grade.code !~ '^(1[2-9]|2[0-3])$')
 OR (SELECT count(DISTINCT grade.code) FROM jsonb_array_elements_text(p_data->'eligibleGrades') AS grade(code))<>jsonb_array_length(p_data->'eligibleGrades') THEN RAISE EXCEPTION 'Choose distinct eligible grades 12 through 23; Grade H requires its separate published-form switch';END IF;
 IF coalesce(p_data->>'kpiGate','') NOT IN('block','warn','off') OR p_data->>'maxExtensions' IS DISTINCT FROM '2' OR p_data->'extensionMonths' IS DISTINCT FROM '[3,6]'::jsonb OR p_data->>'gradeHEnabled'='true' AND NOT EXISTS(SELECT 1 FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='form' AND state='published' AND app.probation_is_current_publication('form',id) AND data->'targetGrades'?'H') THEN RAISE EXCEPTION 'Check probation settings and Grade H form readiness';END IF;
 END IF;
 IF p_publish AND p_kind='route' THEN
 IF p_data?'duplicateRolePolicy' AND (jsonb_typeof(p_data->'duplicateRolePolicy') IS DISTINCT FROM 'object'
  OR coalesce(p_data->'duplicateRolePolicy'->>'mode','') NOT IN('escalate','sign_once','named_alternate')
  OR p_data->'duplicateRolePolicy'->>'mode'='named_alternate' AND NOT EXISTS(
   SELECT 1 FROM app_user alternate JOIN employment employment_scope ON employment_scope.tenant_id=alternate.tenant_id AND employment_scope.person_id=alternate.person_id
   WHERE alternate.id=(p_data->'duplicateRolePolicy'->>'alternateUserId')::uuid AND alternate.tenant_id=app.current_tenant_id()
    AND employment_scope.company_id=p_company AND employment_scope.terminated_on IS NULL AND alternate.archived_at IS NULL AND NOT app.login_blocked(alternate.id))) THEN
  RAISE EXCEPTION 'Select a supported duplicate-role policy and an active scoped alternate when required';
 END IF;
 FOR part IN 1..3 LOOP route:=p_data->'parts'->part::text;PERFORM app.probation_validate_evaluation_route(route,part);IF (SELECT count(*) FROM jsonb_array_elements(route->'steps') s WHERE s->>'role'='lm' AND s->>'kind'='sign')<>1 OR (SELECT count(*) FROM jsonb_array_elements(route->'steps') s WHERE s->>'role'='employee' AND s->>'kind'='acknowledge')<>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') s WHERE s->>'role'='employee' AND (s->>'stage')::integer<=(SELECT (m->>'stage')::integer FROM jsonb_array_elements(route->'steps') m WHERE m->>'role'='lm')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') s WHERE s->>'role' NOT IN('lm','employee') AND (s->>'stage')::integer<=(SELECT (m->>'stage')::integer FROM jsonb_array_elements(route->'steps') m WHERE m->>'role'='lm')) THEN RAISE EXCEPTION 'Probation routes must sign as manager before employee acknowledgement and later approvers';END IF;PERFORM app.document_signing_validate(jsonb_build_object('route',route,'actions','[]'::jsonb),jsonb_build_object('requiredRoles',jsonb_build_array('lm','employee'))||CASE WHEN part=3 THEN jsonb_build_object('independentApprovalFromRole','lm') ELSE '{}'::jsonb END);END LOOP;
 FOR rule IN SELECT value FROM jsonb_array_elements(coalesce(p_data->'rules','[]')) LOOP PERFORM app.probation_validate_evaluation_route(rule->'route',(rule->>'part')::integer);END LOOP;
 END IF;
 SELECT coalesce(max(version),0)+1 INTO n FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind=p_kind;
 INSERT INTO probation_configuration(tenant_id,company_id,kind,version,state,data,created_by,published_by,published_at) VALUES(app.current_tenant_id(),p_company,p_kind,n,CASE WHEN p_publish THEN 'published' ELSE 'draft' END,jsonb_set(p_data,'{version}',to_jsonb(n)),app.current_user_id(),CASE WHEN p_publish THEN app.current_user_id() END,CASE WHEN p_publish THEN now() END) RETURNING probation_configuration.id INTO v_id;
 RETURN v_id;
END $$;
CREATE FUNCTION app.probation_assign_access(p_company uuid,p_user uuid,p_role text,p_from date,p_to date,p_business_unit uuid,p_department uuid,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_config_admin(p_company) OR p_role NOT IN('admin','pbp','gbs') OR p_from IS NULL OR p_to<p_from OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Probation access assignment denied';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_user AND tenant_id=app.current_tenant_id() AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RAISE EXCEPTION 'Choose one active existing login';END IF;
 IF p_role='gbs' AND app.lifecycle_canonical_people_ops_member(p_company,p_user) IS NOT TRUE OR p_role='pbp' AND app.lifecycle_canonical_pbp_scope(p_company,p_business_unit,p_user) IS NOT TRUE THEN RAISE EXCEPTION 'Module opt-in may only constrain the existing canonical PBP or People Ops role';END IF;
 IF p_business_unit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business_unit WHERE id=p_business_unit AND tenant_id=app.current_tenant_id()) OR p_department IS NOT NULL AND NOT EXISTS(SELECT 1 FROM department WHERE id=p_department AND tenant_id=app.current_tenant_id()) THEN RAISE EXCEPTION 'Invalid probation assignment scope';END IF;
 INSERT INTO probation_access(tenant_id,user_id,company_id,role,valid_from,valid_to,business_unit_id,department_id,reason) VALUES(app.current_tenant_id(),p_user,p_company,p_role,p_from,p_to,p_business_unit,p_department,p_reason) RETURNING probation_access.id INTO v_id;RETURN v_id;
END $$;
CREATE FUNCTION app.probation_blank_assessment(p_form jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_object_agg(c->>'id',jsonb_build_object('rating',NULL,'evidence','')) FROM jsonb_array_elements(p_form->'criteria') c;
$$;
CREATE FUNCTION app.probation_admit(p_record jsonb,p_parts jsonb,p_settings uuid,p_form uuid,p_route uuid,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;c probation_case;part jsonb;form jsonb;settings jsonb;route jsonb;source jsonb;pid uuid;case_uuid uuid:=(p_record->>'id')::uuid;extensions integer:=coalesce((p_record->>'extensionCount')::integer,0);required_parts jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO e FROM employment WHERE id=(p_record->>'employmentId')::uuid AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.probation_storage_runner() IS NOT TRUE THEN RAISE EXCEPTION 'Verified owner canonical probation planner required for intake';END IF;PERFORM app.probation_assert_runtime(e.company_id);
 SELECT * INTO c FROM probation_case WHERE tenant_id=e.tenant_id AND employment_id=e.id;IF FOUND THEN RETURN c.id;END IF;
 IF (e.extended_confirmation_date IS NOT NULL OR extensions>0 OR coalesce(e.join_date,e.hired_on)<(SELECT activation_on FROM probation_activation WHERE tenant_id=e.tenant_id AND company_id=e.company_id AND enabled)) AND NOT EXISTS(SELECT 1 FROM probation_cutover batch CROSS JOIN LATERAL jsonb_array_elements(batch.data->'imports') imported WHERE batch.id=(p_record->>'cutoverBatchId')::uuid AND batch.tenant_id=e.tenant_id AND batch.company_id=e.company_id AND batch.approved_by IS NOT NULL AND batch.applied_at IS NOT NULL AND batch.data->>'planComplete'='true' AND imported->>'employmentId'=e.id::text AND imported->'record'=p_record-ARRAY['cutoverBatchId','milestones'] AND imported->'record'->'parts'=p_parts AND imported->>'settingsId'=p_settings::text AND imported->>'formId'=p_form::text AND imported->>'routeId'=p_route::text) THEN RAISE EXCEPTION 'Existing probation requires its exact approved cutover cohort and stage descriptor';END IF;

 SELECT data INTO settings FROM probation_configuration WHERE id=p_settings AND tenant_id=e.tenant_id AND company_id=e.company_id AND kind='settings' AND state='published';
 SELECT data INTO form FROM probation_configuration WHERE id=p_form AND tenant_id=e.tenant_id AND company_id=e.company_id AND kind='form' AND state='published' AND app.probation_is_current_publication('form',id);
 SELECT data INTO route FROM probation_configuration WHERE id=p_route AND tenant_id=e.tenant_id AND company_id=e.company_id AND kind='route' AND state='published';
 source:=app.probation_personnel_source(e.id);
 IF (source->>'unknownPeriod'='true' OR source->>'eligibilityReviewRequired'='true') AND NOT EXISTS(SELECT 1 FROM probation_intake_entry intake WHERE intake.tenant_id=e.tenant_id AND intake.employment_id=e.id AND intake.data->>'validatedUnknown'='true' AND intake.reviewed_by::text=app.probation_holders(e.id)->>'pbp' AND intake.source_digest=app.probation_intake_digest(e.id)) THEN RAISE EXCEPTION 'Missing probation data requires actual scoped PBP validation before admission';END IF;
 IF EXISTS(SELECT 1 FROM probation_intake_entry intake WHERE intake.tenant_id=e.tenant_id AND intake.employment_id=e.id AND (intake.data->>'kind'='exclude' OR EXISTS(SELECT 1 FROM jsonb_each(intake.data->'exclusionFlags') flag WHERE flag.value='true'::jsonb))) THEN RAISE EXCEPTION 'The explicit intake exclusion forbids admission';END IF;
 IF source->>'explicitNoProbation'='true' OR p_record->>'gradeAtStart' IS DISTINCT FROM source->>'grade' THEN RAISE EXCEPTION 'Personnel eligibility changed';END IF;
 IF NOT(settings->'eligibleGrades'?(source->>'grade')) AND NOT(source->>'grade'='H' AND settings->>'gradeHEnabled'='true' AND settings->>'gradeHFormPublished'='true') THEN RAISE EXCEPTION 'This start-date grade is not eligible';END IF;
 settings:=app.probation_effective_settings(settings,source);
 IF settings IS NULL OR form IS NULL OR route IS NULL OR p_record->>'companyId'<>e.company_id::text OR p_record->'config'<>settings OR p_record->>'startOn'<>coalesce(e.join_date,e.hired_on)::text OR p_record->>'endOn' IS DISTINCT FROM coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on,(coalesce(e.join_date,e.hired_on)+(CASE WHEN source->>'grade'='H' THEN '3' ELSE settings->>'defaultMonths' END||' months')::interval-interval '1 day')::date)::text OR e.confirmation_date IS NOT NULL OR e.terminated_on IS NOT NULL OR e.resignation_date IS NOT NULL OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Personnel dates, published versions or eligibility changed; review intake again';END IF;
 required_parts:=app.probation_intake_required_parts(source,settings,extensions);
 IF extensions NOT BETWEEN 0 AND 2 OR jsonb_typeof(p_parts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_parts) IS DISTINCT FROM jsonb_array_length(required_parts) OR EXISTS(SELECT 1 FROM jsonb_array_elements(required_parts) required WHERE (SELECT count(*) FROM jsonb_array_elements(p_parts) mapped WHERE mapped->>'type'=required->>'type' AND mapped->>'cycle'=required->>'cycle' AND (required->>'requiresOffline'<>'true' OR mapped->>'state'='completed_offline'))<>1) THEN RAISE EXCEPTION 'The canonical review plan must keep every required Part and verified historical extension cycle';END IF;
 INSERT INTO probation_case(id,tenant_id,company_id,employment_id,source_key,settings_id,form_id,route_id,data) VALUES(case_uuid,e.tenant_id,e.company_id,e.id,'employment:'||e.id::text,p_settings,p_form,p_route,(p_record-'parts')||jsonb_build_object('facts',source,'sourceKey','employment:'||e.id::text,'revision',1,'state','kpi_setting','extensionCount',extensions,'kpiAcknowledged',false,'pendingOutcome',NULL,'workflowIds',coalesce((SELECT jsonb_agg(x.id) FROM (SELECT DISTINCT ON(definition_key) id FROM probation_builder_definition WHERE tenant_id=e.tenant_id AND company_id=e.company_id AND kind='workflow' AND state='published' AND app.probation_is_current_publication('workflow',id) ORDER BY definition_key,version DESC) x),'[]')));
 FOR part IN SELECT value FROM jsonb_array_elements(p_parts) LOOP
 pid:=(part->>'id')::uuid;
 INSERT INTO probation_part(id,tenant_id,case_id,data) VALUES(pid,e.tenant_id,case_uuid,(part-ARRAY['employee','manager','employeeComments','kpis','support','strengths','development','managerComments','outcome','midpointStatus','justification','extensionMonths'])||jsonb_build_object('state','not_issued','staffSubmittedAt',NULL,'managerSubmittedAt',NULL,'acknowledgedAt',NULL,'cycle',(part->>'cycle')::integer,'revision',1,'kpiException',NULL,'employeeWaitException',NULL,'pbpExtensionConfirmed',false,'route',route->'parts'->(part->>'type')));
 INSERT INTO probation_rater_draft(part_id,tenant_id,rater,data) VALUES(pid,e.tenant_id,'employee',jsonb_build_object('employee',app.probation_blank_assessment(form),'employeeComments','')),(pid,e.tenant_id,'lm',jsonb_build_object('manager',app.probation_blank_assessment(form),'kpis','[]'::jsonb,'support',jsonb_build_object('coaching','','access','','checkins','','other',''),'strengths','','development','','managerComments','','outcome',NULL,'midpointStatus',NULL,'justification','','extensionMonths',NULL));
 END LOOP;PERFORM app.probation_audit(case_uuid,NULL,'admitted',p_reason);RETURN case_uuid;
END $$;
CREATE FUNCTION app.probation_save_draft(p_part uuid,p_rater text,p_patch jsonb,p_expected integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;previous jsonb;allowed text[];meta jsonb;key text;value jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Probation review unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;PERFORM app.probation_assert_case_runtime(c.id);
 IF p.revision IS DISTINCT FROM p_expected OR app.probation_part_role(p.id,p_rater) IS NOT TRUE OR p.data->>'state' IN('not_issued','recorded','locked','completed_offline','cancelled') OR c.data->>'state'='withdrawn' THEN RAISE EXCEPTION 'Only the current field owner can edit this open revision';END IF;
 IF p_rater='employee' THEN
 allowed:=ARRAY['employee','employeeComments'];IF p_patch?'employeeComments' AND NOT EXISTS(SELECT 1 FROM app.probation_pending_signers(p.id) signer WHERE signer.role='employee' AND signer.user_id=app.current_user_id()) THEN RAISE EXCEPTION 'Employee comments are editable only at the current acknowledgement step';END IF;IF p.data->>'staffSubmittedAt' IS NOT NULL AND p.data->>'managerSubmittedAt' IS NULL THEN RAISE EXCEPTION 'Wait for the manager to submit before acknowledgement';END IF;IF p.data->>'acknowledgedAt' IS NOT NULL OR (p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'managerSubmittedAt' IS NOT NULL) AND p_patch?'employee' THEN RAISE EXCEPTION 'Submitted self-assessment is locked';END IF;
 ELSE
 IF p.data->>'type'<>'1' AND c.data->'config'->>'lmWaitsForEmployee'='true' AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'employeeWaitException' IS NULL THEN RAISE EXCEPTION 'Wait for the employee self-assessment or a reasoned PBP release';END IF;allowed:=ARRAY['manager','kpis','support','reviewOn','conductedBy','strengths','development','managerComments','outcome','midpointStatus','justification','extensionMonths'];IF p.data->>'managerSubmittedAt' IS NOT NULL OR p.data->>'type'='1' AND c.data->>'kpiAcknowledged'='true' THEN RAISE EXCEPTION 'Submitted manager fields are locked';END IF;
 END IF;
 IF jsonb_typeof(p_patch)<>'object' OR p_patch-allowed<>'{}'::jsonb OR octet_length(p_patch::text)>1000000 THEN RAISE EXCEPTION 'Only fields owned by this rater may change';END IF;
 SELECT data INTO previous FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=p.tenant_id AND rater=p_rater FOR UPDATE;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,p_rater,p.revision,previous,app.current_user_id(),'Draft changed');
 IF coalesce(p.data->>'documentKind','review')<>'review' OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled') THEN RAISE EXCEPTION 'A completed evaluation requires the reasoned field-owner unlock path';END IF;
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
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.probation_part_access(p.id) IS NOT TRUE OR coalesce(p.data->>'documentKind','review')='review' AND NOT(p.data?'signingFacts') THEN RETURN NULL;END IF;
 PERFORM app.probation_assert_case_runtime(p.case_id);
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
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') returned WHERE returned->>'action'='returned' AND returned->>'contentRevision'=d.data->>'contentRevision' AND returned->>'contentHash'=d.data->>'contentHash') THEN RETURN false;END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(d.data->'route'->'steps') WHERE value->>'required'='true' LOOP
 IF NOT app.document_signing_step_fulfilled(d.data,step) THEN RETURN false;END IF;
 END LOOP;
 IF d.guardrails->>'independentApprovalFromRole' IS NOT NULL THEN
 SELECT a->>'actorPersonId' INTO manager_person FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'=d.guardrails->>'independentApprovalFromRole' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash';
 IF manager_person IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a JOIN jsonb_array_elements(d.data->'route'->'steps') s ON s->>'id'=a->>'stepId' WHERE s->>'kind'='approve' AND a->>'action'='signed' AND a->>'actorPersonId'<>manager_person AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN RETURN false;END IF;
 END IF;RETURN true;
END $$;
CREATE FUNCTION app.probation_part_command(p_part uuid,p_expected integer,p_command text,p_args jsonb DEFAULT '{}') RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;v jsonb;meta jsonb;reason text:=btrim(coalesce(p_args->>'reason',''));signed jsonb;form jsonb;score integer;band integer;suggestion text;actor uuid:=app.current_user_id();changed_content boolean:=false;old_letter uuid;paper record;paper_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RAISE EXCEPTION 'Probation review unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id FOR UPDATE;PERFORM app.probation_assert_case_runtime(c.id);
 IF p.revision IS DISTINCT FROM p_expected OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN RAISE EXCEPTION 'This probation revision changed or is closed';END IF;
 IF p.data->>'state' IN('locked','recorded','completed_offline','cancelled') AND NOT(p_command='unlock' AND p.data->>'state'<>'cancelled' OR p_command='record' AND p.data->>'state'='completed_offline') THEN RAISE EXCEPTION 'This historical review can only be reopened through its authorised route';END IF;
 meta:=p.data;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 IF p_command='submit_employee' THEN
 IF NOT app.probation_role(c.employment_id,'employee') OR p.data->>'state' NOT IN('issued','returned') OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'managerSubmittedAt' IS NOT NULL OR app.probation_submission_ready(p.id,'employee') IS NOT TRUE THEN RAISE EXCEPTION 'Complete and submit your own self-assessment first';END IF;
 meta:=meta||jsonb_build_object('staffSubmittedAt',now(),'state','staff_submitted');
 ELSIF p_command='submit_manager' THEN
 IF app.probation_part_role(p.id,'lm') IS NOT TRUE OR p.data->>'state' IN('not_issued','locked','recorded','completed_offline','cancelled') OR p.data->>'managerSubmittedAt' IS NOT NULL OR app.probation_submission_ready(p.id,'lm') IS NOT TRUE THEN RAISE EXCEPTION 'Complete the manager fields before signing and submitting';END IF;
 IF d.id IS NULL OR d.data->>'contentHash'<>encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'='lm' AND a->>'actorId'=actor::text AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN RAISE EXCEPTION 'The current manager signature is required';END IF;
 meta:=meta||jsonb_build_object('managerSubmittedAt',now(),'state','pending_ack');
 IF p.data->>'type'<>'1' THEN SELECT data INTO form FROM probation_configuration WHERE id=c.form_id;SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND rater='lm';score:=app.probation_score(form,v->'manager');SELECT (b->>'band')::integer INTO band FROM jsonb_array_elements(form->'bands') b WHERE score>=(b->>'min')::integer ORDER BY (b->>'min')::integer DESC LIMIT 1;suggestion:=CASE WHEN p.data->>'type'='2' THEN CASE WHEN band>=3 THEN 'satisfactory' WHEN band=2 THEN 'development' ELSE 'at_risk' END ELSE CASE WHEN band>=3 THEN 'confirm' WHEN band=2 THEN 'extend' ELSE 'not_confirm' END END;meta:=meta||jsonb_build_object('scoreBand',band,'scoreHundredths',score,'override',coalesce(v->>'midpointStatus',v->>'outcome')<>suggestion);END IF;
 UPDATE probation_case SET data=data||jsonb_build_object('state','pending_approval'),revision=revision+1 WHERE id=c.id;
 ELSIF p_command IN('acknowledge','confirm_refusal') THEN
 IF p.data->>'managerSubmittedAt' IS NULL OR p.data->>'acknowledgedAt' IS NOT NULL THEN RAISE EXCEPTION 'Manager submission is required before acknowledgement';END IF;
 IF p_command='acknowledge' AND NOT app.probation_role(c.employment_id,'employee') OR p_command='confirm_refusal' AND NOT app.probation_role(c.employment_id,'pbp') THEN RAISE EXCEPTION 'Acknowledgement authority required';END IF;
 SELECT a INTO signed FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'='employee' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash' AND (p_command='acknowledge' AND a->>'action'='signed' AND a->>'actorId'=actor::text OR p_command='confirm_refusal' AND a->>'action'='declined') ORDER BY a->>'at' DESC LIMIT 1;
 IF signed IS NULL OR d.data->>'contentHash'<>encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'The current signed acknowledgement or recorded refusal is required';END IF;
 IF p_command='acknowledge' THEN SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=p.tenant_id AND rater='employee';SELECT data INTO form FROM probation_configuration WHERE id=c.form_id AND tenant_id=c.tenant_id;IF coalesce(signed->>'comment','') IS DISTINCT FROM coalesce(v->>'employeeComments','') OR p.data->>'type'<>'1' AND form->>'employeeCommentsRequired'='true' AND length(btrim(coalesce(v->>'employeeComments','')))=0 THEN RAISE EXCEPTION 'Acknowledge the exact saved employee comment and complete every required contribution';END IF;END IF;
 meta:=meta||jsonb_build_object('acknowledgedAt',now(),'state',CASE WHEN p.data->>'type'='1' THEN 'locked' ELSE 'pending_approval' END,'pdfPending',p.data->>'type'='1');
 IF p.data->>'type'='1' THEN UPDATE probation_case SET data=data||jsonb_build_object('kpiAcknowledged',true,'state','in_review'),revision=revision+1 WHERE id=c.id;END IF;
 ELSIF p_command='return' THEN
 IF length(reason)<3 OR p.data->>'managerSubmittedAt' IS NULL THEN RAISE EXCEPTION 'A return needs comments and a submitted review';END IF;
 IF p.data->>'type'='1' AND NOT app.probation_role(c.employment_id,'employee') OR p.data->>'type'<>'1' AND NOT(app.probation_part_role(p.id,'employee') OR app.probation_part_role(p.id,'hod') OR app.probation_part_role(p.id,'pbp')) THEN RAISE EXCEPTION 'Only a current reviewer may return this part';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'action'='returned' AND a->>'actorId'=actor::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN RAISE EXCEPTION 'The current signing step must record this return';END IF;
 meta:=(meta-ARRAY['scoreBand','scoreHundredths','override','signingFacts','signingPeriod','signingKpis'])||jsonb_build_object('state','returned','managerSubmittedAt',NULL,'acknowledgedAt',NULL);changed_content:=true;
 ELSIF p_command='record' THEN
 IF p.data->>'state'='completed_offline' THEN
  IF app.probation_role(c.employment_id,'gbs') IS NOT TRUE OR app.probation_offline_record_ready(p.id) IS NOT TRUE THEN RAISE EXCEPTION 'Current GBS may record only the exact filed, PBP-attested original final decision';END IF;
  SELECT * INTO paper FROM probation_offline_final_proposal WHERE part_id=p.id AND tenant_id=p.tenant_id AND superseded_at IS NULL AND accepted_at IS NULL FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM app_user gbs JOIN app_user pbp ON pbp.id=paper.proposed_by AND pbp.tenant_id=gbs.tenant_id WHERE gbs.id=actor AND gbs.tenant_id=p.tenant_id AND gbs.person_id IS NOT NULL AND pbp.person_id IS NOT NULL AND (gbs.person_id IS DISTINCT FROM (SELECT person_id FROM app_user WHERE id=(app.probation_holders(c.employment_id)->>'lm')::uuid) OR pbp.person_id IS DISTINCT FROM (SELECT person_id FROM app_user WHERE id=(app.probation_holders(c.employment_id)->>'lm')::uuid))) THEN RAISE EXCEPTION 'A verified actual HR recorder and an independent approving person are required for paper evidence';END IF;
  UPDATE probation_offline_final_proposal SET accepted_by=actor,accepted_at=now() WHERE id=paper.id;paper_id:=paper.id;v:=jsonb_build_object('outcome',paper.outcome,'extensionMonths',paper.extension_months,'justification',paper.reason);meta:=meta||jsonb_build_object('recordedAt',now(),'recordedBy',actor,'offlineProposalId',paper_id,'pbpExtensionConfirmed',paper.outcome='extend','pdfPending',false);
 ELSE
 IF NOT app.probation_role(c.employment_id,'gbs') OR p.data->>'state'<>'pending_approval' OR NOT app.probation_signatures_complete(p.id) THEN RAISE EXCEPTION 'GBS may record only a fully signed current review';END IF;
 SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND rater='lm';
 IF p.data->>'type'='3' AND (p.data->'signingPeriod'->>'endOn' IS DISTINCT FROM c.data->>'endOn' OR p.data->'signingPeriod'->>'startOn' IS DISTINCT FROM c.data->>'startOn') THEN RAISE EXCEPTION 'A changed final review period requires reasoned PBP unlock and fresh signatures';END IF;
 IF p.data->>'type'='3' AND v->>'outcome'='extend' AND p.data->>'pbpExtensionConfirmed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PBP must confirm the extension length';END IF;
 meta:=meta||jsonb_build_object('state','locked','recordedAt',now(),'recordedBy',actor,'pdfPending',true);END IF;
 IF p.data->>'type'='3' THEN
 UPDATE probation_case SET data=data||jsonb_build_object('state','outcome_pending','pendingOutcome',v->>'outcome'),revision=revision+1 WHERE id=c.id;
 INSERT INTO probation_outcome(case_id,tenant_id,part_id,outcome,revision,state,source_key,offline_proposal_id) VALUES(c.id,c.tenant_id,p.id,v->>'outcome',(p.data->>'cycle')::integer+1,'pending','probation:'||c.id::text||':'||p.id::text,paper_id) ON CONFLICT(part_id) DO UPDATE SET outcome=excluded.outcome,offline_proposal_id=excluded.offline_proposal_id,revision=probation_outcome.revision+1,state='pending',template_id=NULL,template_version=NULL,merge_data=NULL,letter_file_id=NULL,letter_part_id=NULL,failure=NULL,updated_at=now() WHERE probation_outcome.released_at IS NULL AND probation_outcome.movement_ref IS NULL AND probation_outcome.handoff_ref IS NULL;
 ELSE UPDATE probation_case SET data=data||jsonb_build_object('state','in_review'),revision=revision+1 WHERE id=c.id;END IF;
 ELSIF p_command='kpi_exception' THEN
 IF NOT app.probation_role(c.employment_id,'pbp') OR length(reason)<3 OR p.data->>'type'='1' OR p.data->>'state'<>'not_issued' OR c.data->>'kpiAcknowledged'='true' OR c.data->'config'->>'kpiGate' IS DISTINCT FROM 'block' THEN RAISE EXCEPTION 'A current blocked KPI gate and PBP reason are required';END IF;meta:=meta||jsonb_build_object('kpiException',reason);
 ELSIF p_command='employee_wait_exception' THEN
 IF NOT app.probation_role(c.employment_id,'pbp') OR length(reason)<3 OR (p.data->>'dueOn')::date>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'managerSubmittedAt' IS NOT NULL OR p.data->>'type'='1' OR p.data->>'state' NOT IN('issued','returned') OR c.data->'config'->>'lmWaitsForEmployee' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Only PBP may release an overdue employee step with a reason';END IF;meta:=meta||jsonb_build_object('employeeWaitException',reason);
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
 SELECT letter_part_id INTO old_letter FROM probation_outcome WHERE tenant_id=p.tenant_id AND part_id=p.id;IF old_letter IS NOT NULL THEN PERFORM 1 FROM probation_part WHERE id=old_letter AND tenant_id=p.tenant_id FOR UPDATE;IF EXISTS(SELECT 1 FROM probation_outcome WHERE part_id=p.id AND tenant_id=p.tenant_id AND released_at IS NOT NULL) THEN RAISE EXCEPTION 'The letter was released; use the authorised employment correction process';END IF;UPDATE probation_part SET data=jsonb_set(data,'{state}','"cancelled"'),revision=revision+1 WHERE id=old_letter;END IF;
 UPDATE probation_outcome SET state='pending',offline_proposal_id=NULL,letter_part_id=NULL,letter_file_id=NULL,template_id=NULL,template_version=NULL,merge_data=NULL,failure='The evaluation was reopened; a new approved letter generation is required.',revision=revision+1,updated_at=now() WHERE part_id=p.id AND tenant_id=p.tenant_id AND released_at IS NULL;
 IF p_args->>'owner'='lm' AND p.data?'signingPeriod' AND (p.data->'signingPeriod'->>'endOn' IS DISTINCT FROM c.data->>'endOn' OR p.data->'signingPeriod'->>'startOn' IS DISTINCT FROM c.data->>'startOn') THEN RAISE EXCEPTION 'Reopen the employee field owner first when the review period changed';END IF;
 meta:=(meta-ARRAY['scoreBand','scoreHundredths','override','signingFacts','signingPeriod','signingKpis'])||jsonb_build_object('state','returned','managerSubmittedAt',NULL,'acknowledgedAt',NULL,'unlockOwner',p_args->>'owner');IF p_args->>'owner'='employee' THEN meta:=jsonb_set(meta,'{staffSubmittedAt}','null'::jsonb);END IF;changed_content:=true;
 IF p.data->>'type'='1' THEN UPDATE probation_case SET data=jsonb_set(data,'{kpiAcknowledged}','false'::jsonb),revision=revision+1 WHERE id=c.id;END IF;
 ELSIF p_command='request_refusal' THEN
 IF app.probation_part_role(p.id,'lm') IS NOT TRUE OR length(reason)<3 OR p.data->>'managerSubmittedAt' IS NULL OR p.data->>'acknowledgedAt' IS NOT NULL THEN RAISE EXCEPTION 'The current manager must explain the employee refusal';END IF;
 INSERT INTO probation_followup(tenant_id,case_id,part_id,actor_user_id,kind,note,content_revision) VALUES(p.tenant_id,c.id,p.id,actor,'refusal_request',reason,p.content_revision);
 ELSE RAISE EXCEPTION 'Unknown probation command';END IF;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision,p.data,actor,coalesce(nullif(reason,''),p_command));
 UPDATE probation_part SET data=meta,revision=revision+1,content_revision=content_revision+CASE WHEN changed_content THEN 1 ELSE 0 END,updated_at=now() WHERE id=p.id;
 IF meta->>'state'='locked' THEN PERFORM app.probation_enqueue_review_pdf(p.id,'Completed authenticated probation review');END IF;
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
 PERFORM app.probation_write_lock();
 IF NOT app.probation_config_admin(p_company) OR p_kind NOT IN('workflow','template') OR p_data->>'module' IS DISTINCT FROM 'probation' OR p_key !~ '^[a-zA-Z0-9_-]{1,100}$' THEN RAISE EXCEPTION 'Named probation builder administrator required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||p_company::text||p_kind||p_key,0));
 IF p_expected IS NULL OR p_expected<>(SELECT coalesce(max(version),0) FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND definition_key=p_key AND kind=p_kind) THEN RAISE EXCEPTION 'Probation builder definition changed; reload before saving';END IF;
 IF p_publish AND length(btrim(coalesce(p_data->>'name','')))=0 THEN RAISE EXCEPTION 'Name this probation definition';END IF;
 IF p_publish AND p_kind='workflow' AND (jsonb_typeof(p_data->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'steps')=0) THEN RAISE EXCEPTION 'Add workflow steps before publishing';END IF;
 IF p_publish AND p_kind='workflow' AND (p_data->'trigger'->>'event' IS NULL OR p_data->'trigger'->>'event' NOT IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending','letter_released','letter_signing_pending','letter_release_pending','letter_returned','overdue_summary') OR jsonb_array_length(p_data->'steps')>10 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'steps') step WHERE step->>'type' IS DISTINCT FROM 'notify' OR length(btrim(coalesce(step->>'subject',''))) NOT BETWEEN 1 AND 200 OR step->>'subject'~E'[\r\n]' OR length(btrim(coalesce(step->>'body',''))) NOT BETWEEN 1 AND 20000 OR coalesce(step->>'id','')='' OR jsonb_typeof(step->'to') IS DISTINCT FROM 'array' OR jsonb_array_length(step->'to') NOT BETWEEN 1 AND 5 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(step->'to') r WHERE r NOT IN('employee','lm','hod','pbp','gbs')))) THEN RAISE EXCEPTION 'Complete bounded messages, supported events and scoped recipients';END IF;
 IF p_publish AND p_kind='template' AND (jsonb_typeof(p_data->'blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'blocks')=0 OR p_data->>'unfinished' IS DISTINCT FROM 'false') THEN RAISE EXCEPTION 'HR must finish and approve letter wording before publishing';END IF;
 IF p_kind='template' AND (jsonb_typeof(coalesce(p_data->'rules','{}')) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(p_data->'rules','{}')) rule WHERE rule.key NOT IN('businessGroup','businessUnit','company','department','grade','outcome','extensionNumber') OR jsonb_typeof(rule.value) IS DISTINCT FROM 'array' OR jsonb_array_length(rule.value)>200 OR EXISTS(SELECT 1 FROM jsonb_array_elements(rule.value) item WHERE jsonb_typeof(item)<>'string'))) THEN RAISE EXCEPTION 'Use supported bounded probation letter matching rules';END IF;
 IF p_publish AND p_kind='template' THEN PERFORM app.probation_validate_letter_fields(coalesce(p_data->'fields','[]'),'{}'::jsonb,false);IF coalesce(p_data->>'outcome','') NOT IN('confirm','extend','not_confirm') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') block WHERE block->>'type'='text' AND length(btrim(coalesce(block->>'text','')))>0) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') block WHERE block->>'type'='signature' AND block->>'role'='hr') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') block WHERE block->>'type'='signature' AND block->>'role'='employee') THEN RAISE EXCEPTION 'Complete the outcome wording and both actual signature blocks';END IF;END IF;
 SELECT coalesce(max(version),0)+1 INTO n FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND definition_key=p_key AND kind=p_kind;
 INSERT INTO probation_builder_definition(tenant_id,company_id,definition_key,kind,version,state,data,created_by) VALUES(app.current_tenant_id(),p_company,p_key,p_kind,n,CASE WHEN p_publish THEN 'published' ELSE 'draft' END,p_data,app.current_user_id()) RETURNING id INTO v_id;RETURN v_id;
END $$;
CREATE FUNCTION app.probation_followup_add(p_case uuid,p_part uuid,p_kind text,p_note text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR p_kind NOT IN('followup','development','extension_recommendation','nonconfirmation_recommendation') OR length(btrim(coalesce(p_note,'')))<3 OR p_part IS NOT NULL AND NOT EXISTS(SELECT 1 FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id) THEN RAISE EXCEPTION 'Scoped PBP or GBS follow-up required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 INSERT INTO probation_followup(tenant_id,case_id,part_id,actor_user_id,kind,note) VALUES(c.tenant_id,c.id,p_part,app.current_user_id(),p_kind,p_note) RETURNING id INTO v_id;PERFORM app.probation_audit(c.id,p_part,'followup_recorded');RETURN v_id;
END $$;
CREATE FUNCTION app.probation_delegate_add(p_part uuid,p_step text,p_holder uuid,p_kind text,p_from date,p_to date,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;h jsonb;represented uuid;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR length(btrim(coalesce(p_reason,'')))<3 OR p_kind NOT IN('delegation','holder_changed','missing_holder') OR p_from IS NULL OR p_to<p_from THEN RAISE EXCEPTION 'A current PBP/GBS must record the replacement and reason';END IF;
 IF app.probation_signer_candidate(c.id,p_holder) IS NOT TRUE THEN RAISE EXCEPTION 'Choose an active existing signer within this case legitimate company or canonical role scope';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_holder AND tenant_id=p.tenant_id AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RAISE EXCEPTION 'Choose an active existing login';END IF;
 SELECT (app.probation_holders(c.employment_id)->>(s->>'role'))::uuid INTO represented FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step;
 IF NOT FOUND THEN RAISE EXCEPTION 'Signing step unavailable';END IF;IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step AND s->>'role'='employee') THEN RAISE EXCEPTION 'Employee acknowledgement belongs to the employee; use the reasoned refusal route when necessary';END IF;
 IF p_kind='delegation' AND represented IS NULL THEN RAISE EXCEPTION 'Use the explicit missing-holder replacement path when there is no current holder';END IF;
 IF EXISTS(SELECT 1 FROM document_signing_document doc CROSS JOIN LATERAL jsonb_array_elements(doc.data->'route'->'steps') step
  WHERE doc.tenant_id=p.tenant_id AND doc.subject_type='probation' AND doc.subject_id=p.id AND step->>'id'=p_step AND app.document_signing_step_fulfilled(doc.data,step))
 THEN RAISE EXCEPTION 'Completed signatures retain their actual historical holder';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 INSERT INTO probation_delegate(tenant_id,part_id,step_id,holder_id,represented_id,kind,reason,created_by,valid_from,valid_to) VALUES(p.tenant_id,p.id,p_step,p_holder,CASE WHEN p_kind='delegation' THEN represented END,p_kind,p_reason,app.current_user_id(),p_from,p_to);
 PERFORM app.probation_audit(c.id,p.id,'signer_replaced',p_reason);
END $$;
CREATE FUNCTION app.probation_route_override(p_part uuid,p_route jsonb,p_reason text,p_expected integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;rules jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.revision IS DISTINCT FROM p_expected OR NOT app.probation_role(c.employment_id,'pbp') OR length(btrim(coalesce(p_reason,'')))<3 OR p.data->>'managerSubmittedAt' IS NOT NULL OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled') THEN RAISE EXCEPTION 'PBP may change only an unsubmitted route with a reason';END IF;
 rules:=app.probation_signing_guardrails(p.id);IF coalesce(p.data->>'documentKind','review')='review' THEN PERFORM app.probation_validate_evaluation_route(p_route,(p.data->>'type')::integer);END IF;PERFORM app.document_signing_validate(jsonb_build_object('route',p_route,'actions','[]'::jsonb),rules);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role' NOT IN('lm','employee','hod','pbp') OR s->>'holderId' IS NOT NULL OR s->>'representedId' IS NOT NULL) THEN RAISE EXCEPTION 'Routes choose roles; use recorded delegation for named replacements';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision,p.data,app.current_user_id(),p_reason);
 UPDATE probation_part SET data=data||jsonb_build_object('route',p_route,'routeOverride',true,'routeReason',p_reason),revision=revision+1,content_revision=content_revision+1 WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'route_changed',p_reason);
END $$;
CREATE FUNCTION app.probation_personnel_source(p_employment uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;a assignment;g job_grade;p person;h jsonb;original_grade uuid;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 SELECT * INTO e FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_company_entitled(e.company_id) AND (
  app.probation_role(e.id,'gbs') OR app.probation_role(e.id,'pbp') OR app.probation_role(e.id,'lm') OR app.probation_role(e.id,'employee') OR app.probation_role(e.id,'hod') OR app.probation_config_admin(e.company_id)
  OR EXISTS(SELECT 1 FROM probation_case c WHERE c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.company_id=e.company_id AND app.probation_case_company_current(c.id) AND app.probation_case_access(c.id))
 )) THEN RAISE EXCEPTION 'Personnel record unavailable for probation';END IF;
 SELECT * INTO a FROM assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND superseded_at IS NULL AND valid_from<=day AND (valid_to IS NULL OR valid_to>day) ORDER BY valid_from DESC,id LIMIT 1;
 SELECT (payload->>'gradeId')::uuid INTO original_grade FROM domain_event WHERE tenant_id=e.tenant_id AND subject_employment_id=e.id AND event_type='employment.hired' AND payload->>'gradeId' IS NOT NULL ORDER BY sequence LIMIT 1;
 SELECT * INTO g FROM job_grade WHERE id=coalesce(original_grade,e.grade_id) AND tenant_id=e.tenant_id;
 SELECT * INTO p FROM person WHERE id=e.person_id AND tenant_id=e.tenant_id;h:=app.probation_holders(e.id);
 RETURN jsonb_build_object('employmentId',e.id,'personId',e.person_id,'companyId',e.company_id,'employeeName',p.full_name,'employeeCode',e.employee_code,'companyName',(SELECT legal_name FROM company WHERE id=e.company_id AND tenant_id=e.tenant_id),'startOn',coalesce(e.join_date,e.hired_on),'endOn',coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on),'grade',regexp_replace(upper(coalesce(g.code,'')),'^(JG|GRADE)[ -]*','','g'),'gradeId',coalesce(original_grade,e.grade_id),'currentGradeId',e.grade_id,'employmentType',a.employment_type,'explicitNoProbation',(coalesce(e.probation_value,-1)=0 OR coalesce(e.probation_months,-1)=0),'eligibilityReviewRequired',app.probation_intake_eligibility_review(e.id),'unknownPeriod',(coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on) IS NULL AND e.probation_value IS NULL AND e.probation_months IS NULL),'probationMonths',CASE WHEN e.probation_unit='month' THEN e.probation_value WHEN e.probation_unit IS NULL THEN e.probation_months ELSE NULL END,'probationUnit',e.probation_unit,'probationValue',e.probation_value,'extendedEndOn',e.extended_confirmation_date,'originalEndOn',coalesce(e.probation_end_date,e.provisional_end_on),'extensionHistory',app.probation_intake_extension_history(e.id),'confirmationOn',e.confirmation_date,'terminatedOn',e.terminated_on,'resignationOn',e.resignation_date,'departmentId',a.department_id,'businessGroupId',(SELECT coalesce(parent_company_id,id) FROM company WHERE id=e.company_id AND tenant_id=e.tenant_id),'businessGroup',(SELECT bg.legal_name FROM company co JOIN company bg ON bg.id=coalesce(co.parent_company_id,co.id) AND bg.tenant_id=co.tenant_id WHERE co.id=e.company_id AND co.tenant_id=e.tenant_id),'businessUnitId',a.business_unit_id,'department',(SELECT name FROM department WHERE id=a.department_id),'businessUnit',(SELECT name FROM business_unit WHERE id=a.business_unit_id),'title',(SELECT title FROM position WHERE id=a.position_id),'division',e.org_division,'holders',h-ARRAY['companyId','departmentId','businessUnitId','pbpAmbiguous']);
END $$;
CREATE FUNCTION app.probation_escalated_signer(p_case uuid,p_holder uuid,p_seen uuid[]) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;identity uuid;employment_id uuid;visited uuid[]:='{}';next_holder uuid;count integer;depth integer;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 SELECT u.person_id INTO identity FROM app_user u WHERE u.id=p_holder AND u.tenant_id=c.tenant_id;
 SELECT min(e.id::text)::uuid,count(*)::integer INTO employment_id,count FROM employment e
 WHERE e.tenant_id=c.tenant_id AND e.company_id=c.company_id AND e.person_id=identity AND e.terminated_on IS NULL AND coalesce(e.join_date,e.hired_on)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 IF count<>1 THEN RETURN NULL;END IF;
 FOR depth IN 1..8 LOOP
  IF employment_id IS NULL OR employment_id=ANY(visited) THEN RETURN NULL;END IF;
  visited:=array_append(visited,employment_id);
  employment_id:=app.performance_current_admin_manager(c.tenant_id,employment_id);
  IF employment_id IS NULL OR employment_id=ANY(visited) THEN RETURN NULL;END IF;
  next_holder:=app.probation_user_for(employment_id);
  SELECT u.person_id INTO identity FROM app_user u WHERE u.id=next_holder AND u.tenant_id=c.tenant_id;
  IF identity IS NOT NULL AND NOT(identity=ANY(p_seen)) AND app.probation_signer_candidate(c.id,next_holder) THEN RETURN next_holder;END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION app.probation_resolve_route_unchecked(p_part uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;holders jsonb;route jsonb;steps jsonb:='[]';step jsonb;delegated probation_delegate;
 holder uuid;identity uuid;seen uuid[]:='{}';represented uuid;alternate uuid;policy jsonb;mode text;covering jsonb;
 day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;stored document_signing_document;historic jsonb;frozen_hash text;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF app.probation_case_company_current(c.id) IS NOT TRUE THEN RETURN p.data->'route';END IF;
 holders:=app.probation_holders(c.employment_id);route:=p.data->'route';
 SELECT data->'duplicateRolePolicy' INTO policy FROM probation_configuration WHERE id=c.route_id AND tenant_id=c.tenant_id;
 mode:=coalesce(policy->>'mode','escalate');
 SELECT * INTO stored FROM document_signing_document WHERE subject_id=p.id AND subject_type='probation' AND tenant_id=p.tenant_id;
 IF stored.id IS NOT NULL THEN frozen_hash:=encode(sha256(convert_to(app.probation_content(p.id)::text,'UTF8')),'hex');END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(route->'steps') WITH ORDINALITY AS authored(value,ordinal) ORDER BY (value->>'stage')::integer,ordinal LOOP
  step:=step-ARRAY['coveredStepIds','coveredByStepId','holderPersonId','representedId'];
  SELECT original INTO historic FROM jsonb_array_elements(stored.data->'route'->'steps') original
   WHERE original->>'id'=step->>'id' AND stored.data->>'contentHash'=frozen_hash AND app.document_signing_step_fulfilled(stored.data,original);
  IF historic IS NOT NULL THEN
   steps:=steps||jsonb_build_array(historic);
   IF historic->>'required'='true' AND historic->>'holderPersonId' IS NOT NULL THEN seen:=array_append(seen,(historic->>'holderPersonId')::uuid);END IF;
   CONTINUE;
  END IF;
  holder:=(holders->>(step->>'role'))::uuid;
  SELECT * INTO delegated FROM probation_delegate WHERE tenant_id=p.tenant_id AND part_id=p.id AND step_id=step->>'id' AND valid_from<=day AND (valid_to IS NULL OR valid_to>=day)
   AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=probation_delegate.holder_id AND u.tenant_id=probation_delegate.tenant_id AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
   ORDER BY created_at DESC,id DESC LIMIT 1;
  IF delegated.id IS NOT NULL THEN holder:=delegated.holder_id;step:=step||jsonb_build_object('representedId',delegated.represented_id);END IF;
  SELECT u.person_id INTO identity FROM app_user u WHERE u.id=holder AND u.tenant_id=c.tenant_id;
  IF step->>'kind'='approve' AND step->>'required'='true' AND identity=ANY(seen) THEN
   covering:=NULL;
   IF mode='sign_once' AND delegated.id IS NULL THEN
    SELECT previous INTO covering FROM jsonb_array_elements(steps) previous WHERE previous->>'kind'='approve' AND previous->>'required'='true' AND previous->>'holderId'=holder::text
     AND previous->>'role'<>step->>'role' AND previous->>'coveredByStepId' IS NULL AND previous->'coveredStepIds' IS NULL
     AND (previous->>'stage')::integer<(step->>'stage')::integer
     AND (stored.id IS NULL OR NOT app.document_signing_step_fulfilled(stored.data,previous))
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') intervening WHERE intervening->>'required'='true'
      AND intervening->>'id' NOT IN(previous->>'id',step->>'id') AND (intervening->>'stage')::integer BETWEEN (previous->>'stage')::integer AND (step->>'stage')::integer)
     ORDER BY (previous->>'stage')::integer DESC LIMIT 1;
   END IF;
   IF covering IS NOT NULL THEN
    SELECT jsonb_agg(CASE WHEN previous->>'id'=covering->>'id' THEN previous||jsonb_build_object('coveredStepIds',jsonb_build_array(step->>'id')) ELSE previous END ORDER BY ordinal)
    INTO steps FROM jsonb_array_elements(steps) WITH ORDINALITY AS emitted(previous,ordinal);
    step:=step||jsonb_build_object('coveredByStepId',covering->>'id');
   ELSE
    represented:=holder;
    IF mode='named_alternate' THEN
     alternate:=(policy->>'alternateUserId')::uuid;
     SELECT u.person_id INTO identity FROM app_user u WHERE u.id=alternate AND u.tenant_id=c.tenant_id;
     holder:=CASE WHEN identity IS NOT NULL AND NOT(identity=ANY(seen)) AND app.probation_signer_candidate(c.id,alternate) THEN alternate ELSE NULL END;
    ELSE
     holder:=app.probation_escalated_signer(c.id,holder,seen);
    END IF;
    SELECT u.person_id INTO identity FROM app_user u WHERE u.id=holder AND u.tenant_id=c.tenant_id;
    step:=step||jsonb_build_object('representedId',represented);
   END IF;
  END IF;
  steps:=steps||jsonb_build_array(step||jsonb_build_object('holderId',holder));
  IF step->>'required'='true' AND identity IS NOT NULL THEN seen:=array_append(seen,identity);END IF;
 END LOOP;
 RETURN jsonb_set(route,'{steps}',steps);
END $$;
REVOKE ALL ON FUNCTION app.probation_escalated_signer(uuid,uuid,uuid[]) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_resolved_route(p_part uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.probation_part_access(p_part) IS NOT TRUE THEN RAISE EXCEPTION 'Signing route unavailable';END IF;
 RETURN app.probation_resolve_route_unchecked(p_part);
END $$;
REVOKE ALL ON FUNCTION app.probation_resolve_route_unchecked(uuid) FROM PUBLIC,ai_hr_app;

REVOKE ALL ON FUNCTION app.probation_holders(uuid),app.probation_user_for(uuid),app.probation_signatures_complete(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_bootstrap_admin(p_company uuid,p_user uuid,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_active_user() OR NOT app.is_admin_for(p_company) OR NOT app.is_group_admin() OR length(btrim(coalesce(p_reason,'')))<3 OR EXISTS(SELECT 1 FROM probation_access WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND role='admin' AND valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (valid_to IS NULL OR valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN RAISE EXCEPTION 'Only group HR administration may nominate the first named preparer';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_user AND tenant_id=app.current_tenant_id() AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RAISE EXCEPTION 'Choose an active existing login';END IF;
 INSERT INTO probation_access(tenant_id,user_id,company_id,role,valid_from,reason) VALUES(app.current_tenant_id(),p_user,p_company,'admin',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,p_reason) RETURNING id INTO v_id;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(app.current_tenant_id(),'probation-setup',v_id,'probation.preparer-nominated','user',app.current_user_id(),jsonb_build_object('companyId',p_company,'userId',p_user));
 RETURN v_id;
END $$;
CREATE FUNCTION app.probation_issue(p_part uuid,p_today date) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RETURN false;END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs')) OR p_today IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Verified current-day probation scheduling required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF p.data->>'state'<>'not_issued' OR (p.data->>'issueOn')::date>p_today OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN RETURN false;END IF;
 IF p.data->>'type'<>'1' AND c.data->'config'->>'kpiGate'='block' AND c.data->>'kpiAcknowledged'<>'true' AND p.data->>'kpiException' IS NULL THEN RETURN false;END IF;
 UPDATE probation_part SET data=jsonb_set(data,'{state}','"issued"'::jsonb),revision=revision+1 WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'form_issued');RETURN true;
END $$;
CREATE FUNCTION app.probation_withdraw(p_case uuid,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp')) THEN RAISE EXCEPTION 'Probation withdrawal authority required';END IF;
 IF NOT EXISTS(SELECT 1 FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id AND (resignation_date IS NOT NULL OR terminated_on IS NOT NULL)) THEN RAISE EXCEPTION 'Record the resignation or exit in Personnel first';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 UPDATE probation_case SET data=jsonb_set(data,'{state}','"withdrawn"'),revision=revision+1 WHERE id=c.id;
 UPDATE probation_occurrence SET state='cancelled' WHERE tenant_id=c.tenant_id AND case_id=c.id AND state IN('ready','scheduled');
 PERFORM app.probation_audit(c.id,NULL,'withdrawn',p_reason);
END $$;
ALTER TABLE probation_occurrence ADD COLUMN recipient_roles jsonb NOT NULL DEFAULT '[]',ADD COLUMN source_event_id uuid UNIQUE REFERENCES domain_event(id);
CREATE FUNCTION app.probation_enqueue(p_case uuid,p_part uuid,p_kind text,p_due date,p_roles jsonb,p_source_key text,p_revision integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;o probation_occurrence;h jsonb;users jsonb:='[]';r text;u uuid;v_event uuid;v_id uuid:=gen_random_uuid();
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp')) THEN RAISE EXCEPTION 'Probation notification scheduling denied';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF p_due<>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled AND activation_on<=p_due) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') AND p_kind<>'letter_released' THEN RETURN NULL;END IF;
 IF p_part IS NOT NULL THEN SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id;IF NOT FOUND OR p.revision<>p_revision THEN RAISE EXCEPTION 'Scheduled source changed';END IF;END IF;
 IF jsonb_typeof(p_roles)<>'array' OR jsonb_array_length(p_roles)>10 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_roles) role WHERE role NOT IN('employee','lm','hod','pbp','gbs')) THEN RAISE EXCEPTION 'Choose probation-scoped recipients';END IF;
 users:=app.probation_users_for_roles(c.employment_id,p_roles);
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
 IF app.probation_case_company_current(c.id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled AND activation_on<=o.due_on AND o.created_at>=updated_at) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') AND o.kind<>'letter_released' THEN RETURN;END IF;
 SELECT * INTO p FROM probation_part WHERE id=o.part_id AND tenant_id=o.tenant_id;IF o.kind='route_attention' AND coalesce(p.data->>'state','') NOT IN('pending_ack','pending_approval') THEN RETURN;END IF;IF o.kind='letter_returned' AND (p.data->>'state' IS DISTINCT FROM 'returned' OR NOT EXISTS(SELECT 1 FROM probation_outcome x WHERE x.letter_part_id=p.id AND x.tenant_id=p.tenant_id)) OR o.kind='letter_release_pending' AND NOT EXISTS(SELECT 1 FROM probation_outcome x WHERE x.letter_part_id=p.id AND x.tenant_id=p.tenant_id AND x.released_at IS NULL) THEN RETURN;END IF;h:=app.probation_holders(c.employment_id);
 IF o.kind IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending') THEN
 IF o.kind IN('review_reminder','review_due') AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date>(p.data->>'dueOn')::date THEN RETURN;END IF;
 RETURN QUERY SELECT DISTINCT e.id FROM app.probation_pending_parties(p.id) party JOIN app_user u ON u.id=party.user_id AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE o.recipient_user_ids?u.id::text AND o.recipient_roles?party.role AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);RETURN;END IF;
 IF o.kind='letter_signing_pending' THEN
 RETURN QUERY SELECT DISTINCT e.id FROM jsonb_array_elements_text(o.recipient_user_ids) ids(user_id) JOIN app_user u ON u.id=ids.user_id::uuid AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND EXISTS(SELECT 1 FROM document_signing_document d CROSS JOIN LATERAL jsonb_array_elements(d.data->'route'->'steps') st WHERE d.tenant_id=p.tenant_id AND d.subject_id=p.id AND d.subject_type='probation' AND st->>'holderId'=u.id::text AND app.probation_signing_route_allowed(p.id,d.data->'route') AND p.data->>'state'='pending_approval' AND p.data->'letterSourceStamp'=app.probation_letter_stamp_value(p.id,c.tenant_id) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=st->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') prior WHERE (prior->>'stage')::integer<(st->>'stage')::integer AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=prior->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash')));RETURN;END IF;
 RETURN QUERY SELECT DISTINCT e.id FROM jsonb_array_elements_text(o.recipient_user_ids) ids(user_id) JOIN app_user u ON u.id=ids.user_id::uuid AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND (
 EXISTS(SELECT 1 FROM jsonb_array_elements_text(o.recipient_roles) role WHERE role<>'gbs' AND h->>role=u.id::text AND NOT(o.kind='review_reminder' AND role='employee' AND p.data->>'staffSubmittedAt' IS NOT NULL) AND NOT(o.kind='review_reminder' AND role='lm' AND p.data->>'managerSubmittedAt' IS NOT NULL))
 OR o.recipient_roles?'gbs' AND app.probation_gbs_user(c.employment_id,u.id));
END $$;
CREATE FUNCTION app.probation_file_save(p_case uuid,p_part uuid,p_kind text,p_name text,p_content bytea,p_revision integer,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;v_id uuid;existing uuid;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR app.probation_storage_runner()) OR p_kind IS DISTINCT FROM 'offline' OR octet_length(p_content) NOT BETWEEN 5 AND 10485760 OR substring(p_content FROM 1 FOR 5)<>convert_to('%PDF-','UTF8') OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'A scoped PBP/GBS and valid PDF evidence are required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF p_part IS NOT NULL THEN SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;END IF;
 IF p_kind='completed_part' AND (p.data->>'state'<>'locked' OR NOT app.probation_signatures_complete(p.id)) THEN RAISE EXCEPTION 'Only a current completed signed part can be filed';END IF;
 IF p_kind='offline' AND p.revision IS DISTINCT FROM p_revision OR p_kind='completed_part' AND p.content_revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'The PDF source revision changed; read and render it again';END IF;
 IF p_kind='offline' AND (p.id IS NULL OR p.data->>'state' NOT IN('not_issued','issued') OR p.data->>'managerSubmittedAt' IS NOT NULL OR p.data->>'staffSubmittedAt' IS NOT NULL) THEN RAISE EXCEPTION 'Offline intake cannot replace an electronic submission';END IF;
 IF p_kind='letter_draft' AND NOT EXISTS(SELECT 1 FROM probation_outcome o WHERE o.case_id=c.id AND o.tenant_id=c.tenant_id AND o.part_id=p.id AND o.released_at IS NULL AND o.outcome<>'other') THEN RAISE EXCEPTION 'A recorded final outcome is required';END IF;
 SELECT id INTO existing FROM probation_file WHERE tenant_id=c.tenant_id AND case_id=c.id AND part_id=p_part AND kind=p_kind AND revision=p_revision;
 IF existing IS NOT NULL THEN RETURN existing;END IF;
 INSERT INTO probation_file(tenant_id,case_id,part_id,kind,revision,name,content,content_hash,created_by) VALUES(c.tenant_id,c.id,p_part,p_kind,p_revision,left(p_name,200),p_content,encode(sha256(p_content),'hex'),app.current_user_id()) RETURNING id INTO v_id;
 IF p_kind='completed_part' THEN UPDATE probation_part SET data=jsonb_set(data,'{pdfPending}','false'::jsonb) WHERE id=p.id;END IF;
 IF p_kind IN('offline','completed_part') THEN INSERT INTO probation_filing_queue(file_id,tenant_id,case_id,source_hash,reason) VALUES(v_id,c.tenant_id,c.id,encode(sha256(p_content),'hex'),p_reason) ON CONFLICT(file_id) DO NOTHING;IF app.probation_storage_runner() THEN PERFORM app.probation_file_owner(v_id);END IF;END IF;
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
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;PERFORM app.probation_assert_case_runtime(c.id);
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR o.revision IS DISTINCT FROM p_expected OR o.released_at IS NOT NULL OR o.outcome='other' THEN RAISE EXCEPTION 'Only an unreleased recorded outcome may be drafted';END IF;
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND definition_key=o.outcome AND state='published';
 SELECT * INTO f FROM probation_file WHERE id=p_file AND tenant_id=o.tenant_id AND case_id=c.id AND part_id=o.part_id AND kind='letter_draft';IF t.id IS NULL OR f.id IS NULL THEN RAISE EXCEPTION 'Use the pinned published probation template and this case draft';END IF;
 source:=app.probation_personnel_source(c.employment_id);
 UPDATE probation_outcome SET template_id=t.id::text,template_version=t.version,letter_file_id=f.id,merge_data=p_merge||jsonb_build_object('employeeName',source->>'employeeName','employeeCode',source->>'employeeCode','startOn',c.data->>'startOn','endOn',c.data->>'endOn','outcome',o.outcome),state='awaiting_release',updated_at=now() WHERE id=o.id;
 PERFORM app.probation_audit(c.id,o.part_id,'letter_generated');
END $$;
CREATE FUNCTION app.probation_letter_release(p_outcome uuid,p_expected integer,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;f probation_file;doc uuid;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;PERFORM app.probation_assert_case_runtime(c.id);
 IF o.released_at IS NOT NULL THEN RETURN;END IF;
 IF o.revision IS DISTINCT FROM p_expected OR o.state<>'awaiting_release' OR o.letter_file_id IS NULL OR length(btrim(coalesce(p_reason,'')))<3 OR o.outcome IN('extend','not_confirm') AND NOT app.probation_role(c.employment_id,'pbp') OR o.outcome='confirm' AND NOT(app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp') OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'The current authorised reviewer must release the prepared letter';END IF;
 IF NOT app.probation_review_complete(o.part_id) THEN RAISE EXCEPTION 'The evaluation route must be complete before letter release';END IF;
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
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id FOR UPDATE;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id;
 IF NOT(app.probation_role(e.id,'gbs') OR app.probation_storage_runner()) OR NOT EXISTS(SELECT 1 FROM probation_file f JOIN employee_document doc ON doc.id=f.employee_document_id AND doc.tenant_id=f.tenant_id WHERE f.id=o.letter_file_id AND f.tenant_id=o.tenant_id AND doc.employment_id=e.id) OR o.released_at IS NULL OR o.outcome NOT IN('confirm','extend','not_confirm') THEN RAISE EXCEPTION 'GBS may apply only a released approved outcome';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF o.state='completed' THEN RETURN;END IF;
 IF o.outcome='confirm' AND e.confirmation_date::text IS DISTINCT FROM c.data->>'endOn' THEN RAISE EXCEPTION 'The canonical confirmation movement has not completed';END IF;
 IF o.outcome='extend' AND (e.extended_confirmation_date::text IS DISTINCT FROM p_next->>'endOn' OR (c.data->>'extensionCount')::integer>=2 OR p_new_part IS NULL) THEN RAISE EXCEPTION 'The canonical extension movement has not completed';END IF;
 IF o.outcome='not_confirm' AND (p_handoff IS NULL OR NOT EXISTS(SELECT 1 FROM lc_v9_case x WHERE x.id=p_handoff AND x.tenant_id=c.tenant_id AND x.employment_id=e.id AND x.module='off' AND x.data->'facts'->>'caseType'='Non-confirmation' AND x.data->'facts'->>'lastDay'=c.data->>'endOn' AND x.data->>'probationSourceCaseId'=c.id::text)) THEN RAISE EXCEPTION 'The canonical company-initiated offboarding handoff has not completed';END IF;
 IF o.outcome IN('confirm','extend') AND NOT EXISTS(SELECT 1 FROM domain_event ev WHERE ev.tenant_id=c.tenant_id AND ev.aggregate_id=e.id AND ev.event_type='employment.info.updated' AND ev.actor_id IS NOT DISTINCT FROM app.current_user_id() AND ev.xmin::text::bigint=mod(txid_current(),4294967296) AND ev.payload->'movement'->>'remarks'=o.source_key AND ev.payload->'movement'->>'type'=CASE WHEN o.outcome='confirm' THEN 'confirmation' ELSE 'probationExtension' END AND CASE WHEN o.outcome='confirm' THEN ev.payload->'after'->>'confirmationDate'=c.data->>'endOn' ELSE ev.payload->'after'->>'extendedConfirmationDate'=p_next->>'endOn' END) THEN RAISE EXCEPTION 'Canonical Personnel movement receipt required in the same transaction';END IF;
 IF o.outcome IN('confirm','extend') THEN SELECT ev.id::text INTO p_movement FROM domain_event ev WHERE ev.tenant_id=c.tenant_id AND ev.aggregate_id=e.id AND ev.event_type='employment.info.updated' AND ev.xmin::text::bigint=mod(txid_current(),4294967296) AND ev.payload->'movement'->>'remarks'=o.source_key ORDER BY ev.created_at,ev.id LIMIT 1;END IF;
 UPDATE probation_personnel_tx_intent SET consumed=true WHERE tenant_id=c.tenant_id AND transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND employment_id=e.id AND source_id=o.id;
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
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF NOT(app.probation_role(c.employment_id,'gbs') OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'Outcome retry authority required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 UPDATE probation_outcome SET failure=left(p_message,1000),updated_at=now() WHERE id=o.id AND state<>'completed';
END $$;
CREATE FUNCTION app.probation_prepare_signing(p_part uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;kpis jsonb;source jsonb;policy jsonb;scoped_route jsonb;manager jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF app.probation_part_role(p.id,'lm') IS NOT TRUE OR p.data->>'managerSubmittedAt' IS NOT NULL OR app.probation_submission_ready(p.id,'lm') IS NOT TRUE THEN RAISE EXCEPTION 'Only the ready current manager submission may freeze content';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF p.data?'signingFacts' THEN RETURN;END IF;
 source:=app.probation_personnel_source(c.employment_id);IF source->>'startOn' IS DISTINCT FROM c.data->>'startOn' OR source->>'endOn' IS NOT NULL AND source->>'endOn' IS DISTINCT FROM c.data->>'endOn' THEN RAISE EXCEPTION 'Reconcile changed canonical Personnel dates before this submission';END IF;
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
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_case_access(c.id) THEN RETURN;END IF;IF app.probation_case_company_current(c.id) IS NOT TRUE THEN RETURN;END IF;
 RETURN QUERY SELECT u.id,h.key,p.full_name FROM jsonb_each_text(app.probation_holders(c.employment_id)) h JOIN app_user u ON u.id=CASE WHEN h.key IN('employee','lm','hod','pbp') THEN h.value::uuid ELSE NULL END AND u.tenant_id=c.tenant_id JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE h.key IN('employee','lm','hod','pbp')
 UNION SELECT u.id,x.step_id,p.full_name FROM probation_delegate x JOIN probation_part r ON r.id=x.part_id AND r.tenant_id=x.tenant_id JOIN app_user u ON u.id=x.holder_id AND u.tenant_id=x.tenant_id JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE r.case_id=c.id AND x.tenant_id=c.tenant_id AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 UNION SELECT u.id,step->>'role',identity.full_name FROM probation_part part
  CROSS JOIN LATERAL jsonb_array_elements(app.probation_resolve_route_unchecked(part.id)->'steps') step
  JOIN app_user u ON u.id=(step->>'holderId')::uuid AND u.tenant_id=part.tenant_id
  JOIN person identity ON identity.id=u.person_id AND identity.tenant_id=u.tenant_id
  WHERE part.case_id=c.id AND part.tenant_id=c.tenant_id AND step->>'representedId' IS NOT NULL;
END $$;
CREATE FUNCTION app.probation_commands(p_part uuid) RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;v jsonb;commands text[]:='{}';is_employee boolean;is_lm boolean;is_pbp boolean;is_gbs boolean;open boolean;pending_role text;current_holder uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RETURN commands;END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF app.probation_case_company_current(c.id) IS NOT TRUE OR app.probation_owns_legacy(c.employment_id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN RETURN commands;END IF;
 is_employee:=app.probation_part_role(p.id,'employee');is_lm:=app.probation_part_role(p.id,'lm');is_pbp:=app.probation_role(c.employment_id,'pbp');is_gbs:=app.probation_role(c.employment_id,'gbs');open:=p.data->>'state' NOT IN('not_issued','locked','recorded','completed_offline','cancelled');
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 SELECT s->>'role',(s->>'holderId')::uuid INTO pending_role,current_holder FROM jsonb_array_elements(app.probation_resolved_route(p.id)->'steps') s WHERE s->>'required'='true' AND NOT app.document_signing_step_fulfilled(d.data,s) AND s->>'coveredByStepId' IS NULL ORDER BY (s->>'stage')::integer,s->>'id' LIMIT 1;
 IF open AND is_employee AND p.data->>'type'<>'1' AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'managerSubmittedAt' IS NULL THEN commands:=array_append(commands,'submit_employee');END IF;
 IF open AND is_lm AND p.data->>'managerSubmittedAt' IS NULL AND (p.data->>'type'='1' OR c.data->'config'->>'lmWaitsForEmployee' IS DISTINCT FROM 'true' OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'employeeWaitException' IS NOT NULL) THEN commands:=array_append(commands,'submit_manager');END IF;
 IF open AND p.data->>'managerSubmittedAt' IS NOT NULL AND current_holder=app.current_user_id() THEN
 IF pending_role='employee' AND is_employee THEN commands:=array_append(commands,'acknowledge');ELSIF pending_role IN('hod','pbp') THEN commands:=array_append(commands,'approve');END IF;
 IF pending_role IN('employee','hod','pbp') THEN commands:=array_append(commands,'return');END IF;
 END IF;
 IF is_gbs AND app.probation_offline_record_ready(p.id) THEN commands:=array_append(commands,'record');END IF;
 IF is_gbs AND p.data->>'state'='pending_approval' AND app.probation_signatures_complete(p.id) THEN
 SELECT data INTO v FROM probation_rater_draft WHERE part_id=p.id AND rater='lm';
 IF v->>'outcome' IS DISTINCT FROM 'extend' OR p.data->>'pbpExtensionConfirmed'='true' THEN commands:=array_append(commands,'record');END IF;END IF;
 IF (is_pbp OR is_gbs) AND (p.data->>'state' IN('locked','recorded','completed_offline') OR p.data->>'managerSubmittedAt' IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM probation_outcome WHERE part_id=p.id AND tenant_id=p.tenant_id AND (released_at IS NOT NULL OR movement_ref IS NOT NULL OR handoff_ref IS NOT NULL)) THEN commands:=array_append(commands,'unlock');END IF;
 IF is_pbp AND p.data->>'type'<>'1' AND p.data->>'state'='not_issued' AND c.data->>'kpiAcknowledged'<>'true' AND p.data->>'kpiException' IS NULL AND c.data->'config'->>'kpiGate'='block' THEN commands:=array_append(commands,'kpi_exception');END IF;
 IF is_pbp AND p.data->>'type'<>'1' AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'employeeWaitException' IS NULL AND p.data->>'managerSubmittedAt' IS NULL AND p.data->>'state' IN('issued','returned') AND c.data->'config'->>'lmWaitsForEmployee'='true' AND (p.data->>'dueOn')::date<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN commands:=array_append(commands,'employee_wait_exception');END IF;
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
DECLARE c probation_case;p probation_part;w probation_builder_definition;s jsonb;v_id uuid;first_id uuid;f jsonb;plan jsonb;message jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp')) OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Scoped workflow run authority and reason required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 SELECT * INTO w FROM probation_builder_definition WHERE id=p_workflow AND tenant_id=c.tenant_id AND company_id=c.company_id AND kind='workflow' AND state='published' AND c.data->'workflowIds'?id::text;
 IF NOT FOUND THEN RAISE EXCEPTION 'Use this case pinned published workflow';END IF;
 IF p_part IS NOT NULL THEN SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id;IF NOT FOUND OR p.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Workflow source changed';END IF;
 ELSIF c.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Workflow source changed';END IF;
 f:=c.data->'facts';
 IF coalesce(w.data->'conditions'->>'businessGroupId',f->>'businessGroupId') IS DISTINCT FROM f->>'businessGroupId' OR coalesce(w.data->'conditions'->>'businessUnitId',f->>'businessUnitId') IS DISTINCT FROM f->>'businessUnitId' OR coalesce(w.data->'conditions'->>'departmentId',f->>'departmentId') IS DISTINCT FROM f->>'departmentId' OR coalesce(w.data->'conditions'->>'grade',c.data->>'gradeAtStart') IS DISTINCT FROM c.data->>'gradeAtStart' OR w.data->'conditions'?'part' AND w.data->'conditions'->>'part' IS DISTINCT FROM p.data->>'type' THEN RETURN NULL;END IF;
 plan:=app.probation_workflow_plan(c.id,p.id,w.data);IF plan->>'matches' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;IF plan->>'ready' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Workflow source is held: %',coalesce(plan->>'holdReason','The current source is not ready');END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(w.data->'steps') LOOP
  IF s->>'type'<>'notify' THEN RAISE EXCEPTION 'Unsupported probation workflow operation';END IF;
  SELECT item INTO message FROM jsonb_array_elements(plan->'messages') items(item) WHERE item->>'id'=s->>'id';IF coalesce(jsonb_array_length(message->'recipients'),0)=0 THEN CONTINUE;END IF;
  v_id:=app.probation_enqueue(c.id,p.id,w.data->'trigger'->>'event',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,message->'roles','probation-workflow:'||w.id::text||':'||c.id::text||':'||coalesce(p.id::text,'case')||':'||(s->>'id')||':'||(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text,coalesce(p.revision,c.revision));
  IF v_id IS NOT NULL THEN UPDATE probation_occurrence SET workflow_id=w.id,workflow_step_id=s->>'id',recipient_user_ids=(SELECT jsonb_agg(DISTINCT recipient->'userId') FROM jsonb_array_elements(message->'recipients') recipient) WHERE id=v_id AND tenant_id=c.tenant_id AND workflow_id IS NULL;first_id:=coalesce(first_id,v_id);END IF;
 END LOOP;
 PERFORM app.probation_audit(c.id,p.id,'workflow_run',p_reason);RETURN first_id;
END $$;
CREATE FUNCTION app.probation_notification_content(p_tenant uuid,p_event uuid,p_user uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_occurrence;c probation_case;p probation_part;w probation_builder_definition;s jsonb;words jsonb;h jsonb;subject text;body text;k text;value text;roles jsonb;eligible boolean:=false;prior_tenant text:=current_setting('app.tenant_id',true);
BEGIN
 SELECT * INTO o FROM probation_occurrence WHERE tenant_id=p_tenant AND source_event_id=p_event AND state='scheduled' AND recipient_user_ids?p_user::text;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=p_tenant;
 IF c.id IS NULL OR c.data->>'sourceCompanyMoved'='true' OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id) OR NOT EXISTS(SELECT 1 FROM tenant_module m JOIN tenant tenant ON tenant.id=m.tenant_id WHERE m.tenant_id=p_tenant AND m.module_code='lifecycle' AND (m.company_id IS NULL OR m.company_id=c.company_id) AND m.status IN('active','trial') AND m.activated_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now()) AND tenant.status IN('active','trial')) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') AND o.kind<>'letter_released' OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=p_tenant AND company_id=c.company_id AND enabled AND activation_on<=o.due_on AND o.created_at>=updated_at) OR NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_user AND tenant_id=p_tenant AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RETURN NULL;END IF;
 SELECT * INTO p FROM probation_part WHERE id=o.part_id AND tenant_id=p_tenant;IF o.kind='route_attention' AND coalesce(p.data->>'state','') NOT IN('pending_ack','pending_approval') THEN RETURN NULL;END IF;IF o.kind='letter_returned' AND (p.data->>'state' IS DISTINCT FROM 'returned' OR NOT EXISTS(SELECT 1 FROM probation_outcome x WHERE x.letter_part_id=p.id AND x.tenant_id=p.tenant_id)) OR o.kind='letter_release_pending' AND NOT EXISTS(SELECT 1 FROM probation_outcome x WHERE x.letter_part_id=p.id AND x.tenant_id=p.tenant_id AND x.released_at IS NULL) THEN RETURN NULL;END IF;
 SELECT * INTO w FROM probation_builder_definition WHERE id=o.workflow_id AND tenant_id=p_tenant AND company_id=c.company_id AND kind='workflow' AND state='published' AND (c.data->'workflowIds'?id::text OR o.kind='overdue_summary' AND EXISTS(SELECT 1 FROM probation_activation_summary summary WHERE summary.tenant_id=o.tenant_id AND summary.occurrence_id=o.id));IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT item INTO s FROM jsonb_array_elements(w.data->'steps') items(item) WHERE item->>'id'=o.workflow_step_id AND item->>'type'='notify';IF s IS NULL THEN RETURN NULL;END IF;
 -- Resolve authority using explicit source tenant, never caller-supplied identity/role GUCs.
 -- Existing holder resolver is tenant-bound, so derive temporary scope only inside this non-callable helper.
 PERFORM set_config('app.tenant_id',p_tenant::text,true);h:=app.probation_holders(c.employment_id);
 IF o.kind IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending') THEN
 SELECT EXISTS(SELECT 1 FROM app.probation_pending_parties(p.id) party WHERE party.user_id=p_user AND o.recipient_roles?party.role) AND NOT(o.kind IN('review_reminder','review_due') AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date>(p.data->>'dueOn')::date) INTO eligible;
 ELSIF o.kind='letter_signing_pending' THEN
 SELECT p.data->>'state'='pending_approval' AND p.data->'letterSourceStamp'=app.probation_letter_stamp_value(p.id,c.tenant_id) AND EXISTS(SELECT 1 FROM document_signing_document doc CROSS JOIN LATERAL jsonb_array_elements(doc.data->'route'->'steps') st WHERE doc.tenant_id=p_tenant AND doc.subject_type='probation' AND doc.subject_id=p.id AND st->>'holderId'=p_user::text AND app.probation_signing_route_allowed(p.id,doc.data->'route') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc.data->'actions') a WHERE a->>'stepId'=st->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=doc.data->>'contentRevision' AND a->>'contentHash'=doc.data->>'contentHash') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc.data->'route'->'steps') prior WHERE (prior->>'stage')::integer<(st->>'stage')::integer AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc.data->'actions') a WHERE a->>'stepId'=prior->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=doc.data->>'contentRevision' AND a->>'contentHash'=doc.data->>'contentHash'))) INTO eligible;
 ELSE
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements_text(o.recipient_roles) r WHERE r<>'gbs' AND h->>r=p_user::text AND NOT(o.kind='review_reminder' AND r='employee' AND p.data->>'staffSubmittedAt' IS NOT NULL) AND NOT(o.kind='review_reminder' AND r='lm' AND p.data->>'managerSubmittedAt' IS NOT NULL)) OR o.recipient_roles?'gbs' AND app.probation_gbs_user(c.employment_id,p_user) INTO eligible;END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_tenant,''),true);IF eligible IS NOT TRUE THEN RETURN NULL;END IF;
 IF o.kind='route_attention' THEN
  RETURN jsonb_build_object('subject','Probation signing route needs attention','body',CASE WHEN o.recipient_roles?'gbs' THEN 'A required signer is unavailable. Open the scoped probation case to review the assignment.' ELSE 'A current signing holder changed. Open the scoped probation case to review the pending route.' END);
 END IF;
 subject:=s->>'subject';body:=s->>'body';words:=jsonb_build_object('employeeName',c.data->'facts'->>'employeeName','employeeCode',c.data->'facts'->>'employeeCode','companyName',c.data->'facts'->>'companyName','part',p.data->>'type','dueOn',p.data->>'dueOn','endOn',c.data->>'endOn');
 IF o.kind='overdue_summary' THEN words:=jsonb_build_object('employeeName','','employeeCode','','part','','endOn','','dueOn',o.due_on::text,'companyName',c.data->'facts'->>'companyName');END IF;
 FOR k,value IN SELECT key,coalesce(v,'') FROM jsonb_each_text(words) e(key,v) LOOP subject:=regexp_replace(subject,'[{][{][[:space:]]*'||k||'[[:space:]]*[}][}]','{{'||k||'}}','g');body:=regexp_replace(body,'[{][{][[:space:]]*'||k||'[[:space:]]*[}][}]','{{'||k||'}}','g');subject:=replace(subject,'{{'||k||'}}',value);body:=replace(body,'{{'||k||'}}',value);END LOOP;
 IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR subject~E'[\r\n]' OR body IS NULL OR length(body) NOT BETWEEN 1 AND 20000 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('subject',subject,'body',body);
END $$;
REVOKE ALL ON FUNCTION app.probation_notification_content(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.probation_personnel_intent(p_outcome uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;v jsonb;months integer;new_end date;e employment;
BEGIN
 PERFORM app.probation_write_lock();
 PERFORM app.access_workforce_write_lock();SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Released outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR UPDATE;
 IF NOT(app.probation_role(e.id,'gbs') OR app.probation_storage_runner()) OR NOT EXISTS(SELECT 1 FROM probation_file f JOIN employee_document doc ON doc.id=f.employee_document_id AND doc.tenant_id=f.tenant_id WHERE f.id=o.letter_file_id AND f.tenant_id=o.tenant_id AND doc.employment_id=e.id) OR o.released_at IS NULL OR o.outcome NOT IN('confirm','extend') OR NOT app.probation_review_complete(o.part_id) THEN RAISE EXCEPTION 'Released signed GBS outcome authority required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 v:=app.probation_evaluation_decision(o.part_id);
 IF coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on)::text IS DISTINCT FROM c.data->>'endOn' OR v->>'outcome' IS DISTINCT FROM o.outcome OR e.terminated_on IS NOT NULL OR e.resignation_date IS NOT NULL THEN RAISE EXCEPTION 'Personnel outcome source changed';END IF;
 IF o.outcome='extend' THEN months:=(v->>'extensionMonths')::integer;IF months NOT IN(3,6) OR (c.data->>'extensionCount')::integer>=2 OR NOT EXISTS(SELECT 1 FROM probation_part WHERE id=o.part_id AND data->>'pbpExtensionConfirmed'='true') THEN RAISE EXCEPTION 'Current PBP confirmed extension required';END IF;new_end:=((c.data->>'endOn')::date+interval '1 day'+(months::text||' months')::interval-interval '1 day')::date;END IF;
 IF o.state<>'completed' THEN PERFORM app.probation_mint_personnel_intent(e.id,o.id,'outcome',CASE WHEN o.outcome='confirm' THEN (c.data->>'endOn')::date ELSE new_end END,o.outcome='extend');END IF;
 RETURN jsonb_build_object('outcomeId',o.id,'employmentId',e.id,'kind',CASE WHEN o.outcome='confirm' THEN 'confirmation' ELSE 'probationExtension' END,'effectiveDate',CASE WHEN o.outcome='confirm' THEN c.data->>'endOn' ELSE (o.released_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text END,'endDate',new_end,'sourceKey',o.source_key,'completed',o.state='completed');
END $$;
CREATE FUNCTION app.probation_offboarding_intent(p_case uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;o probation_outcome;
BEGIN
 PERFORM app.probation_write_lock();
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT(app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp') OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'Scoped probation handoff authority required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 SELECT * INTO o FROM probation_outcome WHERE case_id=c.id AND tenant_id=c.tenant_id AND outcome='not_confirm' AND released_at IS NOT NULL ORDER BY released_at DESC,id DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM probation_file file JOIN employee_document document ON document.id=file.employee_document_id AND document.tenant_id=file.tenant_id WHERE file.id=o.letter_file_id AND file.tenant_id=c.tenant_id AND document.employment_id=c.employment_id) OR NOT app.probation_review_complete(o.part_id) OR c.data->>'state' NOT IN('outcome_pending','not_confirmed') THEN RAISE EXCEPTION 'Released current nonconfirmation letter and signed decision required';END IF;
 RETURN jsonb_build_object('caseId',c.id,'employmentId',c.employment_id,'type','Non-confirmation','noticeDate',(o.released_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date,'lastDay',c.data->>'endOn','manualHandoff',false,'letterDocumentId',o.letter_file_id,'offboardingCaseId',o.handoff_ref);
END $$;
CREATE FUNCTION app.probation_offboarding_sequence(p_case uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent jsonb;result bigint;
BEGIN
 PERFORM app.probation_write_lock();
 intent:=app.probation_offboarding_intent(p_case);IF intent->>'offboardingCaseId' IS NOT NULL OR (intent->>'noticeDate')::date>(intent->>'lastDay')::date THEN RAISE EXCEPTION 'Probation handoff completed or requires actual date reconciliation';END IF;
 INSERT INTO tenant_counter(tenant_id,kind,value) VALUES(app.current_tenant_id(),'OFB9',1) ON CONFLICT(tenant_id,kind) DO UPDATE SET value=tenant_counter.value+1 RETURNING value INTO result;RETURN result;
END $$;

CREATE FUNCTION app.probation_cutover_snapshot(p_company uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT(app.probation_config_admin(p_company) OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'Named cutover preparer required';END IF;
 SELECT jsonb_build_object('companyId',p_company,'personnel',coalesce(jsonb_agg(jsonb_build_object('id',e.id,'joinDate',e.join_date,'hiredOn',e.hired_on,'endOn',coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on),'gradeId',e.grade_id,'confirmation',e.confirmation_date,'resignation',e.resignation_date,'termination',e.terminated_on,'employeeName',(SELECT full_name FROM person WHERE id=e.person_id AND tenant_id=e.tenant_id),'exclusionReason',app.probation_intake_exclusion(e.id)) ORDER BY e.id),'[]'),'configurations',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'kind',kind) ORDER BY kind,version),'[]') FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND state IN('published','retired')),'cases',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'revision',c.revision,'state',c.data->>'state') ORDER BY c.id),'[]') FROM probation_case c WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=p_company),'legacyReviews',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',legacy.id,'employmentId',legacy.employment_id,'reviewType',legacy.review_type,'status',legacy.status,'endOn',legacy.end_date,'dueOn',legacy.due_date) ORDER BY legacy.id),'[]') FROM employment_review legacy JOIN employment subject ON subject.id=legacy.employment_id AND subject.tenant_id=legacy.tenant_id WHERE legacy.tenant_id=app.current_tenant_id() AND subject.company_id=p_company),'intake',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'revision',i.revision,'sourceDigest',i.source_digest,'data',i.data,'reviewedBy',i.reviewed_by) ORDER BY i.id),'[]') FROM probation_intake_entry i WHERE i.tenant_id=app.current_tenant_id() AND i.company_id=p_company),'reactivation',app.probation_reactivation_cases(p_company),'activation',(SELECT jsonb_build_object('enabled',a.enabled,'watermark',a.activation_on,'digest',a.dry_run_digest,'priorCutover',EXISTS(SELECT 1 FROM probation_cutover previous WHERE previous.tenant_id=a.tenant_id AND previous.company_id=a.company_id AND previous.applied_at IS NOT NULL)) FROM probation_activation a WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=p_company),'offlineDecisions',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'entryId',f.entry_id,'entryRevision',f.entry_revision,'sourceDigest',f.source_digest,'proposedBy',f.proposed_by,'acceptedAt',f.accepted_at,'proposalDigest',encode(sha256(convert_to(jsonb_build_object('outcome',f.outcome,'months',f.extension_months,'reason',f.reason)::text,'UTF8')),'hex')) ORDER BY f.id),'[]') FROM probation_offline_final_proposal f WHERE f.tenant_id=app.current_tenant_id() AND f.company_id=p_company AND f.superseded_at IS NULL),'builders',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'version',b.version,'state',b.state) ORDER BY b.id),'[]') FROM probation_builder_definition b WHERE b.tenant_id=app.current_tenant_id() AND b.company_id=p_company)) INTO result FROM employment e WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=p_company;
 RETURN result;
END $$;
CREATE FUNCTION app.probation_prepare_cutover(p_company uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE data jsonb;fingerprint text;v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 data:=app.probation_cutover_snapshot(p_company);fingerprint:=encode(sha256(convert_to(data::text,'UTF8')),'hex');
 INSERT INTO probation_cutover(tenant_id,company_id,data,digest,actor_user_id) VALUES(app.current_tenant_id(),p_company,data,fingerprint,app.current_user_id()) RETURNING id INTO v_id;
 RETURN jsonb_build_object('id',v_id,'digest',fingerprint,'snapshot',data,'sends',false);
END $$;
ALTER TABLE probation_cutover ADD COLUMN approved_by uuid REFERENCES app_user(id),ADD COLUMN approved_at timestamptz,ADD COLUMN reason text;
CREATE FUNCTION app.probation_approve_cutover(p_id uuid,p_digest text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_cutover;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_cutover WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.probation_config_admin(c.company_id) OR c.data->>'planComplete' IS DISTINCT FROM 'true' OR c.data->'holds' IS DISTINCT FROM '[]'::jsonb OR c.applied_at IS NOT NULL OR c.digest IS DISTINCT FROM p_digest OR length(btrim(coalesce(p_reason,'')))<3 OR coalesce(c.data->'sourceSnapshot',c.data) IS DISTINCT FROM app.probation_cutover_snapshot(c.company_id) THEN RAISE EXCEPTION 'Review and approve the unchanged current cutover dry run';END IF;
 IF c.approved_at IS NOT NULL THEN
  IF c.approved_by IS NOT DISTINCT FROM app.current_user_id() AND c.reason IS NOT DISTINCT FROM p_reason THEN RETURN;END IF;
  RAISE EXCEPTION 'Prepare a new cutover review to replace an existing approval';
 END IF;
 UPDATE probation_cutover SET approved_by=app.current_user_id(),approved_at=now(),reason=p_reason WHERE id=c.id;
END $$;
-- Activation is deliberately an owner/deployment operation, never an application-user permission.
-- Approval records review intent; it does not silently activate production or replay missed dates.
CREATE FUNCTION app.probation_activate_cutover(p_id uuid,p_day date) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_cutover;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_storage_runner() OR p_day IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Explicit owner current-day activation required';END IF;
 SELECT * INTO c FROM probation_cutover WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.probation_company_entitled(c.company_id) IS NOT TRUE OR c.data->>'planComplete' IS DISTINCT FROM 'true' OR c.approved_by IS NULL OR c.applied_at IS NOT NULL OR c.created_at<now()-interval '1 day' OR coalesce(c.data->'sourceSnapshot',c.data) IS DISTINCT FROM app.probation_cutover_snapshot(c.company_id) OR NOT EXISTS(SELECT 1 FROM probation_access a JOIN app_user u ON u.id=a.user_id AND u.tenant_id=a.tenant_id WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.role='admin' AND a.user_id=c.approved_by AND a.valid_from<=p_day AND (a.valid_to IS NULL OR a.valid_to>=p_day) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'A fresh named approved cutover is required';END IF;
 INSERT INTO probation_activation(tenant_id,company_id,enabled,activation_on,dry_run_digest,approved_by) VALUES(c.tenant_id,c.company_id,true,p_day,c.digest,c.approved_by) ON CONFLICT(tenant_id,company_id) DO UPDATE SET enabled=true,activation_on=p_day,dry_run_digest=c.digest,approved_by=c.approved_by,updated_at=now();
 UPDATE probation_cutover SET applied_at=now() WHERE id=c.id;
END $$;
CREATE FUNCTION app.probation_owns_legacy(p_employment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM probation_case c JOIN probation_activation a ON a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled WHERE c.employment_id=p_employment AND c.tenant_id=app.current_tenant_id());
$$;

ALTER TABLE probation_outcome ADD COLUMN letter_part_id uuid REFERENCES probation_part(id);
CREATE FUNCTION app.probation_letter_template_score(p_outcome uuid,p_template uuid) RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;source jsonb;key text;rule_values jsonb;actual text;score integer:=0;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND state='published' AND data->>'unfinished'='false' AND data->>'outcome'=o.outcome;
 IF t.id IS NULL OR EXISTS(SELECT 1 FROM probation_builder_definition later WHERE later.tenant_id=t.tenant_id AND later.company_id=t.company_id AND later.kind=t.kind AND later.definition_key=t.definition_key AND later.version>t.version AND later.state IN('published','retired')) THEN RETURN NULL;END IF;
 source:=app.probation_personnel_source(c.employment_id);
 FOR key,rule_values IN SELECT * FROM jsonb_each(coalesce(t.data->'rules','{}')) LOOP
 IF jsonb_typeof(rule_values)<>'array' OR key NOT IN('businessGroup','businessUnit','company','department','grade','outcome','extensionNumber') THEN RETURN NULL;END IF;IF jsonb_array_length(rule_values)=0 THEN CONTINUE;END IF;
 actual:=CASE key WHEN 'businessGroup' THEN source->>'businessGroupId' WHEN 'businessUnit' THEN source->>'businessUnitId' WHEN 'company' THEN c.company_id::text WHEN 'department' THEN source->>'departmentId' WHEN 'grade' THEN c.data->>'gradeAtStart' WHEN 'outcome' THEN o.outcome WHEN 'extensionNumber' THEN CASE WHEN o.outcome='extend' THEN ((c.data->>'extensionCount')::integer+1)::text ELSE (c.data->>'extensionCount') END END;
 IF (rule_values?actual OR key='grade' AND rule_values?coalesce(source->>'gradeId','')) IS NOT TRUE THEN RETURN NULL;END IF;score:=score+1;
 END LOOP;RETURN score;
END $$;
CREATE FUNCTION app.probation_letter_template_choices(p_outcome uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;choices jsonb;best integer;ties integer;suggested text;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF c.id IS NULL OR app.probation_case_company_current(c.id) IS NOT TRUE OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'Scoped outcome operator required';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'familyId',definition_key,'version',version,'name',data->>'name','score',score) ORDER BY score DESC,data->>'name',id),'[]'),max(score) INTO choices,best FROM(SELECT t.*,app.probation_letter_template_score(o.id,t.id) as score FROM probation_builder_definition t WHERE t.tenant_id=c.tenant_id AND t.company_id=c.company_id AND t.kind='template') candidates WHERE score IS NOT NULL;
 SELECT count(*),min(item->>'id') INTO ties,suggested FROM jsonb_array_elements(choices) item WHERE (item->>'score')::integer=best;
 RETURN jsonb_build_object('templates',choices,'suggestedTemplateId',CASE WHEN ties=1 THEN suggested ELSE NULL END,'tie',ties>1);
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_template_score(uuid,uuid),app.probation_letter_template_choices(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_letter_template_choices(uuid) TO ai_hr_app;
CREATE FUNCTION app.probation_prepare_letter(p_outcome uuid,p_template uuid,p_merge jsonb,p_expected integer,p_source_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;p probation_part;source jsonb;merged jsonb;rules jsonb;v_part uuid:=gen_random_uuid();basehash text;descriptor jsonb;old_pointer uuid;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RAISE EXCEPTION 'Recorded outcome unavailable';END IF;old_pointer:=o.letter_part_id;IF old_pointer IS NOT NULL THEN PERFORM 1 FROM probation_part WHERE id=old_pointer AND tenant_id=o.tenant_id FOR UPDATE;END IF;
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF o.letter_part_id IS DISTINCT FROM old_pointer THEN RAISE EXCEPTION 'The letter revision changed; reload before preparing';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;PERFORM app.probation_assert_case_runtime(c.id);
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR o.revision IS DISTINCT FROM p_expected OR o.released_at IS NOT NULL OR o.state='release_requested' OR o.outcome='other' OR NOT app.probation_review_complete(o.part_id) THEN RAISE EXCEPTION 'Scoped reviewer and current signed recorded outcome required';END IF;
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND state='published' AND app.probation_letter_template_score(o.id,id) IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Use a complete published matching template';END IF;
 PERFORM 1 FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR SHARE;descriptor:=app.probation_letter_preview(o.id,t.id,p_merge,p_expected);IF descriptor->>'sourceDigest' IS DISTINCT FROM p_source_digest THEN RAISE EXCEPTION 'The letter source changed; preview and render it again';END IF;PERFORM app.probation_validate_letter_fields(descriptor->'fields',descriptor->'merge',true);merged:=descriptor->'merge';
 SELECT jsonb_build_object('requiredRoles',jsonb_agg(DISTINCT s->>'role')) INTO rules FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'required'='true';
 IF rules->'requiredRoles' IS NULL OR jsonb_array_length(rules->'requiredRoles')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'role' NOT IN('pbp','lm','hod','employee') OR s->>'holderId' IS NOT NULL OR s->>'representedId' IS NOT NULL) THEN RAISE EXCEPTION 'Letter routes need current source roles and required signers';END IF;
 PERFORM app.document_signing_validate(jsonb_build_object('route',t.data->'route','actions','[]'::jsonb),rules);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(t.data->'route'->'steps') staff CROSS JOIN jsonb_array_elements(t.data->'route'->'steps') hr WHERE staff->>'role'='employee' AND hr->>'role'<>'employee' AND (staff->>'stage')::integer<=(hr->>'stage')::integer) THEN RAISE EXCEPTION 'HR signing must precede employee acknowledgement';END IF;
 basehash:=descriptor->>'sourceDigest';
 -- A new draft has its own immutable signing subject; previous signed subjects remain readable history.
 INSERT INTO probation_part(id,tenant_id,case_id,data) VALUES(v_part,c.tenant_id,c.id,jsonb_build_object('id',v_part,'documentKind','letter','evaluationPartId',o.part_id,'letterOutcomeId',o.id,'letterTemplateId',t.id,'letterTemplateVersion',t.version,'letterTemplateName',t.data->>'name','letterMerge',merged,'letterBlocks',t.data->'blocks','letterFields',coalesce(t.data->'fields','[]'),'letterBaseHash',basehash,'letterSourceStamp',descriptor->'sourceStamp','letterGuardrails',rules,'route',t.data->'route','state','pending_approval','type',0,'cycle',o.revision));
 IF o.letter_part_id IS NOT NULL THEN UPDATE probation_part SET data=jsonb_set(data,'{state}','"cancelled"'),revision=revision+1 WHERE id=o.letter_part_id AND tenant_id=o.tenant_id;END IF;
 UPDATE probation_outcome SET template_id=t.id::text,template_version=t.version,merge_data=merged,letter_part_id=v_part,state='awaiting_release',revision=revision+1,updated_at=now() WHERE id=o.id;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(c.tenant_id,v_part,'meta',1,(SELECT data FROM probation_part WHERE id=v_part),app.current_user_id(),'Prepared outcome letter');
 PERFORM app.probation_audit(c.id,v_part,'letter_prepared');
 RETURN app.probation_signing_content(v_part)||jsonb_build_object('partId',v_part,'outcomeRevision',o.revision+1,'route',app.probation_resolved_route(v_part),'guardrails',rules,'merge',merged,'blocks',t.data->'blocks','fields',coalesce(t.data->'fields','[]'));
END $$;
CREATE FUNCTION app.probation_release_signed_letter(p_outcome uuid,p_part uuid,p_expected integer,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;p probation_part;d document_signing_document;request uuid;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF o.letter_part_id IS DISTINCT FROM p.id OR p.case_id IS DISTINCT FROM c.id OR p.data->>'letterOutcomeId' IS DISTINCT FROM o.id::text OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR o.revision IS DISTINCT FROM p_expected OR length(btrim(coalesce(p_reason,'')))<3 OR app.probation_signatures_complete(p.id) IS NOT TRUE OR app.probation_review_complete(o.part_id) IS NOT TRUE OR o.outcome IN('extend','not_confirm') AND app.probation_role(c.employment_id,'pbp') IS NOT TRUE OR o.outcome='confirm' AND NOT(app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp')) THEN RAISE EXCEPTION 'Current authorised release and complete matching signatures required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);IF o.released_at IS NOT NULL THEN RETURN o.letter_file_id;END IF;
 PERFORM 1 FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR SHARE;IF app.probation_letter_source_current(p.id) IS NOT TRUE THEN RAISE EXCEPTION 'Personnel eligibility or signed source changed; prepare a new approved generation';END IF;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 SELECT id INTO request FROM probation_render_request WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='letter' AND content_hash=d.data->>'contentHash' AND state IN('pending','sealed');IF request IS NOT NULL THEN RETURN request;END IF;
 INSERT INTO probation_render_request(tenant_id,case_id,part_id,outcome_id,kind,content_hash,content_revision,document_id,document_revision,requested_by,reason,render_data)
 VALUES(p.tenant_id,c.id,p.id,o.id,'letter',d.data->>'contentHash',(d.data->>'contentRevision')::integer,d.id,d.revision,app.current_user_id(),p_reason,jsonb_build_object('part',p.data,'signing',d.data,'contentData',app.probation_content(p.id),'createdAt',p.created_at)) RETURNING id INTO request;
 UPDATE probation_outcome SET state='release_requested',failure='Verified owner rendering and Personal File filing are pending.',updated_at=now() WHERE id=o.id;UPDATE probation_part SET data=jsonb_set(data,'{state}','"release_requested"'),revision=revision+1 WHERE id=p.id;PERFORM app.probation_audit(c.id,p.id,'letter_release_requested',p_reason);RETURN request;
END $$;
-- Close every native boundary, including helper functions created earlier in this migration.
DO $$ DECLARE fn regprocedure;name text;BEGIN
 FOR fn,name IN SELECT p.oid::regprocedure,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'probation\_%' ESCAPE '\' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,ai_hr_app',fn);
  IF name=ANY(ARRAY['probation_config_admin','probation_role','probation_storage_runner','probation_case_access','probation_part_access','probation_signing_guardrails','probation_signing_content','probation_config_write','probation_assign_access','probation_admit','probation_save_draft','probation_part_command','probation_definition_save','probation_followup_add','probation_delegate_add','probation_route_override','probation_personnel_source','probation_resolved_route','probation_bootstrap_admin','probation_issue','probation_withdraw','probation_notification_recipients','probation_file_save','probation_record_effect','probation_outcome_failure','probation_prepare_signing','probation_case_holder_names','probation_commands','probation_workflow_run','probation_personnel_intent','probation_offboarding_intent','probation_offboarding_sequence','probation_prepare_cutover','probation_cutover_snapshot','probation_approve_cutover','probation_letter_template_choices','probation_owns_legacy','probation_prepare_letter','probation_release_signed_letter']) THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ai_hr_app',fn);END IF;
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
 IF o.id IS NULL OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) OR o.revision IS DISTINCT FROM p_expected OR o.released_at IS NOT NULL OR o.outcome='other' OR NOT app.probation_review_complete(o.part_id) THEN RAISE EXCEPTION 'Scoped reviewer and current signed outcome required for letter preview';END IF;IF app.probation_case_company_current(c.id) IS NOT TRUE THEN RAISE EXCEPTION 'The employing company changed; this case is historical';END IF;PERFORM app.probation_assert_runtime(c.company_id);
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND state='published' AND app.probation_letter_template_score(o.id,id) IS NOT NULL;IF NOT FOUND THEN RAISE EXCEPTION 'Matching approved published letter template required';END IF;
 IF jsonb_typeof(coalesce(p_edits,'{}'))<>'object' OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(p_edits,'{}')) e WHERE jsonb_typeof(e.value)<>'string' OR length(e.value#>>'{}')>10000 OR e.key IN('employeeName','employeeCode','companyName','startOn','endOn','outcome','extensionMonths','employeeJobTitle','employeeGrade','businessGroup','businessUnit','division','department','lineManagerName','hodName','pbpName','originalEndOn','reviewPlanMonths','confirmationEffectiveOn','extensionNewEndOn','extensionCount','maxExtensions','signatoryName','signatoryTitle','acknowledgedBy','acknowledgedOn','company.name','company.regNo','company.address','company.color') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(t.data->'fields','[]')) f WHERE f->>'id'=e.key AND f->>'owner'='hr' AND f->>'pmKey' IS NULL)) THEN RAISE EXCEPTION 'Only declared editable HR fields may be supplied';END IF;
 source:=app.probation_personnel_source(c.employment_id)||app.probation_letter_company_values(c.company_id,c.tenant_id)||jsonb_build_object('letterValues',app.probation_letter_values(o.id,t.id));IF source->>'resignationOn' IS NOT NULL OR source->>'terminatedOn' IS NOT NULL OR source->>'confirmationOn' IS NOT NULL OR source->>'companyId' IS DISTINCT FROM c.company_id::text OR source->>'startOn' IS DISTINCT FROM c.data->>'startOn' OR source->>'endOn' IS NOT NULL AND source->>'endOn' IS DISTINCT FROM c.data->>'endOn' THEN RAISE EXCEPTION 'Personnel eligibility or period changed; reconcile before generating a letter';END IF;merged:=coalesce(p_edits,'{}')||jsonb_build_object('employeeName',source->>'employeeName','employeeCode',source->>'employeeCode','companyName',source->>'companyName','startOn',c.data->>'startOn','endOn',c.data->>'endOn','outcome',o.outcome,'extensionMonths',(app.probation_evaluation_decision(o.part_id)->>'extensionMonths'))||app.probation_letter_company_values(c.company_id,c.tenant_id)||coalesce(source->'letterValues','{}');
 SELECT jsonb_build_object('requiredRoles',jsonb_agg(DISTINCT s->>'role')) INTO rules FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'required'='true';
 descriptor:=jsonb_build_object('sourceStamp',app.probation_letter_source_stamp(source),'merge',merged,'blocks',t.data->'blocks','fields',coalesce(t.data->'fields','[]'),'route',t.data->'route','guardrails',rules,'companyId',c.company_id,'employmentId',c.employment_id,'templateName',t.data->>'name','templateId',t.id,'templateVersion',t.version,'outcomeRevision',o.revision);
 RETURN descriptor||jsonb_build_object('sourceDigest',encode(sha256(convert_to(descriptor::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_preview(uuid,uuid,jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_preview(uuid,uuid,jsonb,integer) TO ai_hr_app;

-- Canonical service-info trigger authority: real protected transaction intent, never a caller GUC.
CREATE TABLE probation_personnel_tx_intent(
 tenant_id uuid NOT NULL REFERENCES tenant(id),transaction_id bigint NOT NULL,backend_pid integer NOT NULL,login_name text NOT NULL,
 employment_id uuid NOT NULL REFERENCES employment(id),actor_user_id uuid,source_id uuid NOT NULL,source_kind text NOT NULL,
 allowed_fields text[] NOT NULL,baseline_hash text NOT NULL,desired jsonb NOT NULL,consumed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,transaction_id,backend_pid,employment_id)
);
ALTER TABLE probation_personnel_tx_intent ENABLE ROW LEVEL SECURITY;ALTER TABLE probation_personnel_tx_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_owner ON probation_personnel_tx_intent FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON probation_personnel_tx_intent FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_mint_personnel_intent(p_employment uuid,p_source uuid,p_kind text,p_date date,p_extended boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;fields text[];desired jsonb;baseline text;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO e FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND OR p_date IS NULL THEN RAISE EXCEPTION 'Canonical probation date source unavailable';END IF;
 fields:=CASE WHEN p_extended THEN ARRAY['extended_confirmation_date','final_confirmation_date'] ELSE ARRAY['confirmation_date','final_confirmation_date'] END;
 desired:=CASE WHEN p_extended THEN jsonb_build_object('extended_confirmation_date',p_date,'final_confirmation_date',p_date) ELSE jsonb_build_object('confirmation_date',p_date,'final_confirmation_date',coalesce(e.extended_confirmation_date,p_date)) END;
 baseline:=encode(sha256(convert_to((to_jsonb(e)-fields)::text,'UTF8')),'hex');
 INSERT INTO probation_personnel_tx_intent(tenant_id,transaction_id,backend_pid,login_name,employment_id,actor_user_id,source_id,source_kind,allowed_fields,baseline_hash,desired) VALUES(e.tenant_id,txid_current(),pg_backend_pid(),session_user,e.id,app.current_user_id(),p_source,p_kind,fields,baseline,desired)
 ON CONFLICT(tenant_id,transaction_id,backend_pid,employment_id) DO UPDATE SET actor_user_id=excluded.actor_user_id,source_id=excluded.source_id,source_kind=excluded.source_kind,allowed_fields=excluded.allowed_fields,baseline_hash=excluded.baseline_hash,desired=excluded.desired,login_name=excluded.login_name,consumed=false;
END $$;
CREATE FUNCTION app.probation_service_info_intent_allowed(p_old jsonb,p_new jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i probation_personnel_tx_intent;k text;
BEGIN
 IF p_old->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR p_new->>'tenant_id' IS DISTINCT FROM p_old->>'tenant_id' OR p_new->>'id' IS DISTINCT FROM p_old->>'id' THEN RETURN false;END IF;
 SELECT * INTO i FROM probation_personnel_tx_intent WHERE tenant_id=app.current_tenant_id() AND transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user AND employment_id=(p_old->>'id')::uuid AND actor_user_id IS NOT DISTINCT FROM app.current_user_id();
 IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_active_user()) OR i.baseline_hash<>encode(sha256(convert_to((p_old-i.allowed_fields)::text,'UTF8')),'hex') OR (p_new-i.allowed_fields) IS DISTINCT FROM (p_old-i.allowed_fields) THEN RETURN false;END IF;
 FOREACH k IN ARRAY i.allowed_fields LOOP IF p_new->k IS DISTINCT FROM i.desired->k THEN RETURN false;END IF;END LOOP;RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.probation_mint_personnel_intent(uuid,uuid,text,date,boolean),app.probation_service_info_intent_allowed(jsonb,jsonb) FROM PUBLIC,ai_hr_app;

CREATE TABLE probation_date_adjustment(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES probation_case(id),
 expected_revision integer NOT NULL,old_end date NOT NULL,new_end date NOT NULL,reason text NOT NULL CHECK(length(btrim(reason))>=3),
 requested_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),gbs_approved_by uuid REFERENCES app_user(id),gbs_approved_at timestamptz,failure text,applied_at timestamptz,applied_by uuid REFERENCES app_user(id),CHECK(new_end>old_end)
);
ALTER TABLE probation_date_adjustment ENABLE ROW LEVEL SECURITY;ALTER TABLE probation_date_adjustment FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_owner ON probation_date_adjustment FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY probation_date_read ON probation_date_adjustment FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM probation_case c WHERE c.id=case_id AND c.tenant_id=probation_date_adjustment.tenant_id AND NOT app.probation_case_source_moved(c.id) AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs'))));
REVOKE ALL ON probation_date_adjustment FROM PUBLIC,ai_hr_app;GRANT SELECT ON probation_date_adjustment TO ai_hr_app;
CREATE FUNCTION app.probation_request_date_shift(p_case uuid,p_expected integer,p_end date,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.probation_role(c.employment_id,'pbp') IS NOT TRUE OR c.revision IS DISTINCT FROM p_expected OR p_end IS NULL OR p_end<=(c.data->>'endOn')::date OR c.data->>'state' IN('confirmed','not_confirmed','withdrawn','outcome_pending') OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Current PBP, later date and a long-leave reason are required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF NOT app.probation_can_request_date_shift(c.id) THEN RAISE EXCEPTION 'Resolve the pending date request or reconcile the Personnel source first';END IF;
 INSERT INTO probation_date_adjustment(tenant_id,case_id,expected_revision,old_end,new_end,reason,requested_by) VALUES(c.tenant_id,c.id,c.revision,(c.data->>'endOn')::date,p_end,p_reason,app.current_user_id()) RETURNING id INTO v_id;PERFORM app.probation_audit(c.id,NULL,'date_shift_requested',p_reason);RETURN v_id;
END $$;
CREATE FUNCTION app.probation_date_shift_intent(p_request uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r probation_date_adjustment;c probation_case;e employment;
BEGIN
 PERFORM app.probation_write_lock();
 PERFORM app.access_workforce_write_lock();SELECT * INTO r FROM probation_date_adjustment WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Date adjustment unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=r.case_id AND tenant_id=r.tenant_id FOR UPDATE;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR UPDATE;
 IF app.probation_storage_runner() IS NOT TRUE OR r.superseded_at IS NOT NULL OR r.gbs_approved_by IS NULL OR r.failure IS NOT NULL OR app.probation_gbs_user(e.id,r.gbs_approved_by) IS NOT TRUE OR app.probation_holders(e.id)->>'pbp' IS DISTINCT FROM r.requested_by::text OR e.confirmation_date IS NOT NULL OR e.terminated_on IS NOT NULL OR e.resignation_date IS NOT NULL OR r.applied_at IS NULL AND (r.expected_revision IS DISTINCT FROM c.revision OR r.old_end IS DISTINCT FROM coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on)) THEN RAISE EXCEPTION 'GBS may apply only the unchanged current canonical probation date request';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF r.applied_at IS NULL THEN PERFORM app.probation_mint_personnel_intent(e.id,r.id,'date_shift',r.new_end,true);END IF;
 RETURN jsonb_build_object('outcomeId',r.id,'employmentId',e.id,'kind','probationExtension','effectiveDate',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,'endDate',r.new_end,'sourceKey','probation-date-shift:'||r.id::text,'completed',r.applied_at IS NOT NULL);
END $$;
CREATE FUNCTION app.probation_finish_date_shift(p_request uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r probation_date_adjustment;c probation_case;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO r FROM probation_date_adjustment WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=r.case_id AND tenant_id=r.tenant_id;
 IF r.id IS NULL OR NOT(app.probation_role(c.employment_id,'gbs') OR app.probation_storage_runner()) OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.extended_confirmation_date=r.new_end) OR c.data->>'endOn' IS DISTINCT FROM r.new_end::text THEN RAISE EXCEPTION 'Canonical date update and schedule reconciliation must complete atomically';END IF;
 IF NOT EXISTS(SELECT 1 FROM domain_event ev WHERE ev.tenant_id=c.tenant_id AND ev.aggregate_id=c.employment_id AND ev.event_type='employment.info.updated' AND ev.actor_id IS NOT DISTINCT FROM app.current_user_id() AND ev.xmin::text::bigint=mod(txid_current(),4294967296) AND ev.payload->'movement'->>'remarks'='probation-date-shift:'||r.id::text AND ev.payload->'movement'->>'type'='probationExtension' AND ev.payload->'after'->>'extendedConfirmationDate'=r.new_end::text) THEN RAISE EXCEPTION 'Canonical date movement receipt required in the same transaction';END IF;
 UPDATE probation_personnel_tx_intent SET consumed=true WHERE tenant_id=c.tenant_id AND transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND employment_id=c.employment_id AND source_id=r.id;
 UPDATE probation_date_adjustment SET applied_at=coalesce(applied_at,now()),applied_by=coalesce(applied_by,app.current_user_id()) WHERE id=r.id;PERFORM app.probation_audit(c.id,NULL,'date_shift_applied',r.reason);
END $$;
CREATE FUNCTION app.probation_reconcile_dates(p_case uuid,p_expected integer,p_plan jsonb,p_parts jsonb,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;e employment;p probation_part;replacement jsonb;form jsonb;route jsonb;v_part uuid;changed boolean:=false;
BEGIN
 PERFORM app.probation_write_lock();
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR SHARE;
 IF c.id IS NULL OR app.probation_storage_runner() IS NOT TRUE OR c.revision IS DISTINCT FROM p_expected OR length(btrim(coalesce(p_reason,'')))<3 OR p_plan->>'startOn' IS DISTINCT FROM coalesce(e.join_date,e.hired_on)::text OR p_plan->>'endOn' IS DISTINCT FROM coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on)::text OR jsonb_typeof(p_parts) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Current source dates, scoped reconciliation and reason required';END IF;
 IF app.probation_storage_runner() IS TRUE AND NOT EXISTS(SELECT 1 FROM probation_activation a WHERE a.company_id=c.company_id AND a.tenant_id=c.tenant_id AND a.enabled) THEN
  IF app.probation_case_company_current(c.id) IS NOT TRUE OR app.probation_company_entitled(c.company_id) IS NOT TRUE OR app.probation_owns_legacy(c.employment_id) IS NOT TRUE OR e.confirmation_date IS NOT NULL OR e.resignation_date IS NOT NULL OR e.terminated_on IS NOT NULL THEN RAISE EXCEPTION 'The preserved source requires explicit outcome or legacy reconciliation';END IF;
 ELSE
  PERFORM app.probation_assert_case_runtime(c.id);
 END IF;
 SELECT data INTO form FROM probation_configuration WHERE id=c.form_id;SELECT data INTO route FROM probation_configuration WHERE id=c.route_id;
 FOR p IN SELECT * FROM probation_part WHERE case_id=c.id AND tenant_id=c.tenant_id AND coalesce(data->>'documentKind','review')='review' AND (data->>'cycle')::integer=(c.data->>'extensionCount')::integer ORDER BY id FOR UPDATE LOOP
  IF p.data->>'managerSubmittedAt' IS NOT NULL OR p.data->>'staffSubmittedAt' IS NOT NULL AND p.data->>'unlockOwner' IS NULL OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled') THEN CONTINUE;END IF;
  SELECT value INTO replacement FROM jsonb_array_elements(p_parts) WHERE value->>'type'=p.data->>'type';
  INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision,p.data,app.current_user_id(),p_reason);
  IF replacement IS NULL THEN UPDATE probation_part SET data=jsonb_set(data,'{state}','"cancelled"'),revision=revision+1 WHERE id=p.id;
  ELSE IF replacement->>'dueOn' IS NULL OR replacement->>'issueOn' IS NULL OR (replacement->>'issueOn')::date>(replacement->>'dueOn')::date THEN RAISE EXCEPTION 'Valid canonical working-calendar schedule required';END IF;
   UPDATE probation_part SET data=(data-ARRAY['signingFacts','signingPeriod','signingKpis'])||jsonb_build_object('dueOn',replacement->>'dueOn','issueOn',replacement->>'issueOn','state',CASE WHEN (replacement->>'issueOn')::date>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN 'not_issued' ELSE data->>'state' END),revision=revision+1,content_revision=content_revision+1 WHERE id=p.id;
  END IF;
  UPDATE probation_occurrence SET state='cancelled' WHERE part_id=p.id AND tenant_id=p.tenant_id AND state IN('ready','scheduled');changed:=true;
 END LOOP;
 FOR replacement IN SELECT value FROM jsonb_array_elements(p_parts) LOOP
  IF replacement->>'type' NOT IN('1','2','3') OR (replacement->>'cycle')::integer<>(c.data->>'extensionCount')::integer THEN RAISE EXCEPTION 'Invalid corrected review plan';END IF;
  IF NOT EXISTS(SELECT 1 FROM probation_part existing_part WHERE existing_part.case_id=c.id AND existing_part.tenant_id=c.tenant_id AND existing_part.data->>'type'=replacement->>'type' AND existing_part.data->>'cycle'=replacement->>'cycle' AND existing_part.data->>'state'<>'cancelled') THEN
   v_part:=(replacement->>'id')::uuid;
   INSERT INTO probation_part(id,tenant_id,case_id,data) VALUES(v_part,c.tenant_id,c.id,replacement||jsonb_build_object('id',v_part,'state','not_issued','revision',1,'staffSubmittedAt',NULL,'managerSubmittedAt',NULL,'acknowledgedAt',NULL,'route',route->'parts'->(replacement->>'type')));
   INSERT INTO probation_rater_draft(part_id,tenant_id,rater,data) VALUES(v_part,c.tenant_id,'employee',jsonb_build_object('employee',app.probation_blank_assessment(form),'employeeComments','')),(v_part,c.tenant_id,'lm',jsonb_build_object('manager',app.probation_blank_assessment(form),'kpis','[]'::jsonb,'support',jsonb_build_object('coaching','','access','','checkins','','other',''),'strengths','','development','','managerComments','','outcome',NULL,'midpointStatus',NULL,'justification','','extensionMonths',NULL));
  END IF;
 END LOOP;
 UPDATE probation_case SET data=data||jsonb_build_object('startOn',p_plan->>'startOn','endOn',p_plan->>'endOn','planMonths',p_plan->'planMonths','planFlag',p_plan->'planFlag','sourceDateChangePending',false)||CASE WHEN p_plan?'milestones' THEN jsonb_build_object('milestones',p_plan->'milestones') ELSE '{}'::jsonb END,revision=revision+1,updated_at=now() WHERE id=c.id;PERFORM app.probation_audit(c.id,NULL,'dates_reconciled',p_reason);
END $$;
REVOKE ALL ON FUNCTION app.probation_request_date_shift(uuid,integer,date,text),app.probation_date_shift_intent(uuid),app.probation_finish_date_shift(uuid),app.probation_reconcile_dates(uuid,integer,jsonb,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_request_date_shift(uuid,integer,date,text) TO ai_hr_app;
REVOKE ALL ON FUNCTION app.probation_reconcile_dates(uuid,integer,jsonb,jsonb,text) FROM ai_hr_app;
REVOKE ALL ON FUNCTION app.probation_date_shift_intent(uuid),app.probation_finish_date_shift(uuid) FROM ai_hr_app;
CREATE FUNCTION app.probation_mark_source_change(p_case uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;IF c.id IS NULL OR NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'Scoped source reconciliation authority required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF c.data->>'sourceDateChangePending' IS DISTINCT FROM 'true' THEN UPDATE probation_case SET data=jsonb_set(data,'{sourceDateChangePending}','true'),revision=revision+1 WHERE id=c.id;UPDATE probation_occurrence SET state='cancelled' WHERE case_id=c.id AND tenant_id=c.tenant_id AND state IN('ready','scheduled');PERFORM app.probation_audit(c.id,NULL,'source_dates_changed');END IF;
END $$;
REVOKE ALL ON FUNCTION app.probation_mark_source_change(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_mark_source_change(uuid) TO ai_hr_app;
CREATE FUNCTION app.probation_personnel_intent_commit_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM probation_personnel_tx_intent i WHERE i.tenant_id=NEW.tenant_id AND i.transaction_id=NEW.transaction_id AND i.backend_pid=NEW.backend_pid AND i.employment_id=NEW.employment_id AND NOT i.consumed) THEN RAISE EXCEPTION 'Probation Personnel intent must finish with its canonical movement and source receipt in the same transaction';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER probation_personnel_intent_committed AFTER INSERT OR UPDATE ON probation_personnel_tx_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.probation_personnel_intent_commit_guard();
REVOKE ALL ON FUNCTION app.probation_personnel_intent_commit_guard() FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.probation_letter_transition(p_part uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;o probation_outcome;d document_signing_document;event_kind text;roles jsonb;users jsonb;w probation_builder_definition;step jsonb;v_id uuid;v_event uuid;key text;found_workflow boolean:=false;stage integer;h jsonb;step_roles jsonb;step_users jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;SELECT * INTO o FROM probation_outcome WHERE id=(p.data->>'letterOutcomeId')::uuid AND tenant_id=p.tenant_id FOR UPDATE;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR o.letter_part_id IS DISTINCT FROM p.id OR d.id IS NULL OR NOT(app.probation_storage_runner() AND o.released_at IS NOT NULL AND EXISTS(SELECT 1 FROM probation_render_request q WHERE q.tenant_id=p.tenant_id AND q.part_id=p.id AND q.state='sealed' AND q.file_id=o.letter_file_id) OR app.probation_active_user() AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'actorId'=app.current_user_id()::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash'))) THEN RAISE EXCEPTION 'Current letter and authenticated transition actor required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF o.state='release_requested' THEN RETURN;END IF;
 IF o.released_at IS NOT NULL THEN event_kind:='letter_released';roles:='["employee","lm","pbp"]';
 ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'action'='returned' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') THEN
 event_kind:='letter_returned';roles:='["pbp","gbs"]';UPDATE probation_part SET data=jsonb_set(data,'{state}','"returned"'),revision=revision+1 WHERE id=p.id AND data->>'state'<>'returned';UPDATE probation_outcome SET state='awaiting_revision',failure='The letter was returned. Prepare a new revision before signing continues.' WHERE id=o.id;
 ELSE
 event_kind:='letter_signing_pending';SELECT min((s->>'stage')::integer) INTO stage FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=s->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash');
 IF stage IS NULL THEN event_kind:='letter_release_pending';roles:=CASE WHEN o.outcome='confirm' THEN '["pbp","gbs"]'::jsonb ELSE '["pbp"]'::jsonb END;ELSE SELECT jsonb_agg(DISTINCT s->>'role'),jsonb_agg(DISTINCT s->>'holderId') INTO roles,users FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND (s->>'stage')::integer=stage AND s->>'holderId' IS NOT NULL;END IF;
 END IF;
 IF event_kind<>'letter_signing_pending' THEN users:=app.probation_users_for_roles(c.employment_id,roles);END IF;
 IF coalesce(jsonb_array_length(users),0)=0 THEN RETURN;END IF;
 FOR w IN SELECT * FROM probation_builder_definition WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND kind='workflow' AND state='published' AND data->'trigger'->>'event'=event_kind AND c.data->'workflowIds'?id::text LOOP
 FOR step IN SELECT value FROM jsonb_array_elements(w.data->'steps') LOOP
 SELECT jsonb_agg(r) INTO step_roles FROM jsonb_array_elements_text(roles) r WHERE step->'to'?r;IF coalesce(jsonb_array_length(step_roles),0)=0 THEN CONTINUE;END IF;
 IF event_kind='letter_signing_pending' THEN SELECT jsonb_agg(DISTINCT st->>'holderId') INTO step_users FROM jsonb_array_elements(d.data->'route'->'steps') st WHERE step_roles?(st->>'role') AND (st->>'stage')::integer=stage AND st->>'holderId' IS NOT NULL;ELSE step_users:=app.probation_users_for_roles(c.employment_id,step_roles);END IF;IF coalesce(jsonb_array_length(step_users),0)=0 THEN CONTINUE;END IF;found_workflow:=true;key:='probation-letter:'||p.id::text||':'||d.revision::text||':'||event_kind||':'||w.id::text||':'||(step->>'id');
 IF EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN CONTINUE;END IF;
 v_id:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',v_id,'probation.notification-due',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'documentKind','letter','kind',event_kind)) RETURNING id INTO v_event;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id,workflow_id,workflow_step_id) VALUES(v_id,c.tenant_id,c.id,p.id,key,event_kind,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,step_users,step_roles,'scheduled',p.revision,v_event,w.id,step->>'id');
 END LOOP;END LOOP;
 -- Even an unconfigured email definition cannot hide the next assigned in-app signing task.
 IF NOT found_workflow THEN key:='probation-letter:'||p.id::text||':'||d.revision::text||':'||event_kind||':in-app';IF NOT EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN
 v_id:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',v_id,'probation.notification-due',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'documentKind','letter','kind',event_kind)) RETURNING id INTO v_event;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id) VALUES(v_id,c.tenant_id,c.id,p.id,key,event_kind,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,users,roles,'scheduled',p.revision,v_event);END IF;END IF;
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_transition(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_transition(uuid) TO ai_hr_app;
CREATE FUNCTION app.probation_letter_source_stamp(p_source jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (jsonb_build_object('employmentId',p_source->'employmentId','personId',p_source->'personId','companyId',p_source->'companyId','employeeName',p_source->'employeeName','employeeCode',p_source->'employeeCode','companyName',p_source->'companyName','startOn',p_source->'startOn','endOn',p_source->'endOn','confirmationOn',p_source->'confirmationOn','resignationOn',p_source->'resignationOn','terminatedOn',p_source->'terminatedOn','company.name',p_source->'company.name','company.regNo',p_source->'company.regNo','company.address',p_source->'company.address','company.color',p_source->'company.color')||coalesce(p_source->'letterValues','{}'))-ARRAY['acknowledgedBy','acknowledgedOn'];
$$;
CREATE FUNCTION app.probation_letter_source_current(p_part uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;source jsonb;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR NOT app.probation_case_access(c.id) THEN RETURN false;END IF;
 source:=app.probation_personnel_source(c.employment_id)||app.probation_letter_company_values(c.company_id,c.tenant_id);RETURN coalesce(p.data->'letterSourceStamp'=app.probation_letter_stamp_value(p.id,p.tenant_id) AND source->>'companyId'=c.company_id::text AND source->>'confirmationOn' IS NULL AND source->>'resignationOn' IS NULL AND source->>'terminatedOn' IS NULL,false);
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_source_stamp(jsonb),app.probation_letter_source_current(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_letter_tasks(p_case uuid) RETURNS TABLE("partId" uuid,label text,state text,"waitingRole" text,"waitingName" text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.probation_case_access(p_case) IS NOT TRUE THEN RETURN;END IF;
 RETURN QUERY SELECT p.id,coalesce(t.data->>'name','Probation outcome letter'),CASE WHEN o.released_at IS NOT NULL THEN 'released' WHEN o.state='release_requested' THEN 'awaiting_owner_seal' WHEN p.data->>'state'='returned' THEN 'awaiting_revision' WHEN pending.role IS NULL THEN 'awaiting_release' ELSE 'awaiting_signature' END,CASE WHEN o.released_at IS NOT NULL OR app.probation_case_company_current(c.id) IS NOT TRUE THEN NULL WHEN o.state='release_requested' THEN 'system' ELSE coalesce(pending.role,'pbp') END,CASE WHEN o.state='release_requested' THEN NULL ELSE person.full_name END FROM probation_part p JOIN probation_outcome o ON o.letter_part_id=p.id AND o.tenant_id=p.tenant_id JOIN probation_case c ON c.id=p.case_id AND c.tenant_id=p.tenant_id LEFT JOIN probation_builder_definition t ON t.id=(p.data->>'letterTemplateId')::uuid AND t.tenant_id=p.tenant_id LEFT JOIN document_signing_document d ON d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id LEFT JOIN LATERAL(SELECT st->>'role' as role,(st->>'holderId')::uuid as holder FROM jsonb_array_elements(d.data->'route'->'steps') st WHERE st->>'required'='true' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=st->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') ORDER BY (st->>'stage')::integer,st->>'id' LIMIT 1) pending ON true LEFT JOIN app_user u ON u.id=CASE WHEN o.released_at IS NOT NULL OR app.probation_case_company_current(c.id) IS NOT TRUE THEN NULL ELSE coalesce(pending.holder,(app.probation_holders(c.employment_id)->>'pbp')::uuid) END AND u.tenant_id=p.tenant_id LEFT JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE p.case_id=p_case AND p.tenant_id=app.current_tenant_id() AND p.data->>'documentKind'='letter' AND app.probation_part_access(p.id) ORDER BY p.created_at DESC,p.id;
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_tasks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_tasks(uuid) TO ai_hr_app;
CREATE FUNCTION app.probation_letter_company_values(p_company uuid,p_tenant uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('company.name',legal_name,'company.regNo',coalesce(registration_no,''),'company.address',concat_ws(E'\n',nullif(address_line1,''),nullif(address_line2,''),nullif(address_line3,''),nullif(concat_ws(' ',nullif(postcode,''),nullif(city,'')),''),nullif(state,''),nullif(address_country,'')),'company.color','#4F46E5') FROM company WHERE id=p_company AND tenant_id=p_tenant;
$$;
REVOKE ALL ON FUNCTION app.probation_letter_company_values(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_letter_source_value(p_employment uuid,p_tenant uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('employmentId',e.id,'personId',e.person_id,'companyId',e.company_id,'employeeName',p.full_name,'employeeCode',e.employee_code,'companyName',c.legal_name,'startOn',coalesce(e.join_date,e.hired_on),'endOn',coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on),'confirmationOn',e.confirmation_date,'resignationOn',e.resignation_date,'terminatedOn',e.terminated_on)||app.probation_letter_company_values(e.company_id,e.tenant_id) FROM employment e JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id WHERE e.id=p_employment AND e.tenant_id=p_tenant;
$$;
REVOKE ALL ON FUNCTION app.probation_letter_source_value(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_users_for_roles(p_employment uuid,p_roles jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h jsonb;result jsonb;co uuid;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 h:=app.probation_holders(p_employment);co:=(h->>'companyId')::uuid;SELECT coalesce(jsonb_agg(DISTINCT h->>r),'[]') INTO result FROM jsonb_array_elements_text(p_roles) r WHERE r IN('employee','lm','hod','pbp') AND h->>r IS NOT NULL;
 IF p_roles?'gbs' THEN SELECT result||coalesce(jsonb_agg(DISTINCT a.user_id),'[]') INTO result FROM probation_access a WHERE a.tenant_id=app.current_tenant_id() AND a.role='gbs' AND app.probation_gbs_user(p_employment,a.user_id);END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.probation_users_for_roles(uuid,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_part_role(p_part uuid,p_role text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;IF p.id IS NULL OR app.probation_active_user() IS NOT TRUE OR app.probation_case_access(c.id) IS NOT TRUE OR app.probation_case_company_current(c.id) IS NOT TRUE THEN RETURN false;END IF;
 IF app.probation_role(c.employment_id,p_role) THEN RETURN true;END IF;IF p_role='employee' THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM probation_delegate d JOIN LATERAL jsonb_array_elements(p.data->'route'->'steps') step ON step->>'id'=d.step_id AND step->>'role'=p_role WHERE d.part_id=p.id AND d.tenant_id=p.tenant_id AND d.holder_id=app.current_user_id() AND d.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (d.valid_to IS NULL OR d.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) AND app.probation_company_entitled(c.company_id);
END $$;
REVOKE ALL ON FUNCTION app.probation_part_role(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_part_role(uuid,text) TO ai_hr_app;
CREATE FUNCTION app.probation_navigation_access() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE configuration boolean;participant boolean;intake boolean;
BEGIN
 IF app.probation_active_user() IS NOT TRUE THEN RETURN jsonb_build_object('page',false,'configure',false,'intake',false);END IF;
 SELECT EXISTS(SELECT 1 FROM company c WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND app.probation_company_entitled(c.id) AND (app.probation_config_admin(c.id) OR app.is_group_admin() AND app.is_admin_for(c.id) AND NOT EXISTS(SELECT 1 FROM probation_access a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.id AND a.role='admin' AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)))) INTO configuration;
 SELECT EXISTS(SELECT 1 FROM probation_case c WHERE c.tenant_id=app.current_tenant_id() AND app.probation_case_access(c.id)) INTO participant;
 SELECT EXISTS(SELECT 1 FROM company co WHERE co.tenant_id=app.current_tenant_id() AND co.archived_at IS NULL AND app.probation_company_entitled(co.id) AND (app.probation_config_admin(co.id) OR CASE WHEN EXISTS(SELECT 1 FROM probation_access opted WHERE opted.tenant_id=co.tenant_id AND opted.user_id=app.current_user_id() AND opted.role IN('pbp','gbs') AND app.is_company_descendant(co.id,opted.company_id) AND opted.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (opted.valid_to IS NULL OR opted.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN EXISTS(SELECT 1 FROM employment employee WHERE employee.tenant_id=co.tenant_id AND employee.company_id=co.id AND (app.probation_role(employee.id,'pbp') OR app.probation_role(employee.id,'gbs'))) ELSE false END)) INTO intake;
 RETURN jsonb_build_object('page',configuration OR participant,'configure',configuration,'intake',intake);
END $$;
REVOKE ALL ON FUNCTION app.probation_navigation_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_navigation_access() TO ai_hr_app;
-- One stage projection for preview, execution and eventual delivery. No completed party is reminded.
CREATE FUNCTION app.probation_pending_parties(p_part uuid) RETURNS TABLE(role text,user_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;h jsonb;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR p.data->>'state' IN('not_issued','locked','completed_offline','cancelled','returned','release_requested') THEN RETURN;END IF;
 IF p.data->>'documentKind'='letter' OR p.data->>'managerSubmittedAt' IS NOT NULL THEN
 RETURN QUERY SELECT signer.role,signer.user_id FROM app.probation_pending_signers(p.id) signer;
 IF p.data->>'documentKind' IS DISTINCT FROM 'letter' AND NOT EXISTS(SELECT 1 FROM app.probation_pending_signers(p.id)) AND app.probation_signatures_complete(p.id) THEN RETURN QUERY SELECT 'gbs'::text,u.id FROM app_user u WHERE u.tenant_id=c.tenant_id AND app.probation_users_for_roles(c.employment_id,'["gbs"]')?u.id::text;END IF;RETURN;
 END IF;
 h:=app.probation_holders(c.employment_id);
 IF p.data->>'type'<>'1' AND p.data->>'staffSubmittedAt' IS NULL AND h->>'employee' IS NOT NULL THEN role:='employee';user_id:=(h->>'employee')::uuid;RETURN NEXT;END IF;
 IF p.data->>'type'='1' OR c.data->'config'->>'lmWaitsForEmployee' IS DISTINCT FROM 'true' OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'employeeWaitException' IS NOT NULL THEN
 RETURN QUERY SELECT 'lm'::text,coalesce((SELECT delegate.holder_id FROM probation_delegate delegate JOIN LATERAL jsonb_array_elements(p.data->'route'->'steps') step ON step->>'id'=delegate.step_id AND step->>'role'='lm' WHERE delegate.tenant_id=p.tenant_id AND delegate.part_id=p.id AND delegate.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (delegate.valid_to IS NULL OR delegate.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) LIMIT 1),(h->>'lm')::uuid) WHERE h->>'lm' IS NOT NULL;
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.probation_pending_parties(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_workflow_plan(p_case uuid,p_part uuid,p_definition jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;source jsonb;condition jsonb;event text;ready boolean:=true;hold text;step jsonb;roles jsonb;recipients jsonb;messages jsonb:='[]';words jsonb;k text;value text;subject text;body text;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;users jsonb;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id;IF c.id IS NULL OR p.id IS NULL THEN RETURN jsonb_build_object('matches',false);END IF;
 IF app.probation_case_company_current(c.id) IS NOT TRUE THEN RETURN jsonb_build_object('matches',true,'ready',false,'holdReason','The employing company changed. This case is historical.','id',p.id,'partId',p.id,'type',p.data->'type','dueOn',p.data->>'dueOn','state',p.data->>'state','messages','[]'::jsonb);END IF;
 source:=app.probation_personnel_source(c.employment_id);condition:=coalesce(p_definition->'conditions','{}');event:=p_definition->'trigger'->>'event';
 IF condition->>'businessGroupId' IS NOT NULL AND condition->>'businessGroupId' IS DISTINCT FROM source->>'businessGroupId' OR condition->>'businessUnitId' IS NOT NULL AND condition->>'businessUnitId' IS DISTINCT FROM source->>'businessUnitId' OR condition->>'departmentId' IS NOT NULL AND condition->>'departmentId' IS DISTINCT FROM source->>'departmentId' OR condition->>'grade' IS NOT NULL AND condition->>'grade' IS DISTINCT FROM c.data->>'gradeAtStart' OR condition->>'part' IS NOT NULL AND condition->>'part' IS DISTINCT FROM p.data->>'type' OR (event LIKE 'letter\_%') IS DISTINCT FROM (p.data->>'documentKind'='letter') AND coalesce(p.data->>'documentKind','review')<>'review' OR event LIKE 'letter\_%' AND coalesce(p.data->>'documentKind','review')<>'letter' THEN RETURN jsonb_build_object('matches',false);END IF;
 IF source->>'resignationOn' IS NOT NULL OR source->>'terminatedOn' IS NOT NULL OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN ready:=false;hold:='The source is no longer an active probation case.';
 ELSIF source->>'startOn' IS DISTINCT FROM c.data->>'startOn' OR source->>'endOn' IS NOT NULL AND source->>'endOn' IS DISTINCT FROM c.data->>'endOn' THEN ready:=false;hold:='Canonical Personnel dates require reconciliation.';
 ELSIF NOT EXISTS(SELECT 1 FROM probation_activation a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled AND a.activation_on<=day) THEN ready:=false;hold:='Runtime is not activated for this company.';
 ELSIF event='kpi_assigned' THEN ready:=p.data->>'type'='1' AND p.data->>'issueOn'=day::text AND p.data->>'state'='issued';
 ELSIF event='kpi_reminder' THEN ready:=p.data->>'type'='1' AND c.data->'milestones'->>'kpiReminderOn'=day::text AND p.data->>'state' NOT IN('not_issued','locked','completed_offline','cancelled');
 ELSIF event='kpi_overdue' THEN ready:=p.data->>'type'='1' AND c.data->'milestones'->>'kpiOverdueOn'=day::text AND p.data->>'state' NOT IN('locked','completed_offline','cancelled');
 ELSIF event='review_issued' THEN ready:=p.data->>'type' IN('2','3') AND p.data->>'issueOn'=day::text AND p.data->>'state'='issued';
 ELSIF event='review_reminder' THEN ready:=p.data->>'type' IN('2','3') AND p.data->>'state' NOT IN('not_issued','locked','completed_offline','cancelled') AND day<=(p.data->>'dueOn')::date AND (day=(p.data->>'dueOn')::date-coalesce((c.data->'config'->>'firstReminderDays')::integer,14) OR day>=(p.data->>'dueOn')::date-coalesce((c.data->'config'->>'dailyReminderDays')::integer,7));
 ELSIF event='review_due' THEN ready:=p.data->>'type' IN('2','3') AND p.data->>'dueOn'=day::text AND p.data->>'state' NOT IN('not_issued','locked','completed_offline','cancelled');
 ELSIF event='approval_pending' THEN ready:=p.data->>'managerSubmittedAt' IS NOT NULL AND p.data->>'state' IN('pending_ack','pending_approval');
 ELSIF event='letter_signing_pending' THEN ready:=p.data->>'documentKind'='letter' AND p.data->>'state'='pending_approval' AND EXISTS(SELECT 1 FROM probation_outcome o WHERE o.letter_part_id=p.id AND o.tenant_id=p.tenant_id AND o.released_at IS NULL);
 ELSIF event='letter_returned' THEN ready:=p.data->>'documentKind'='letter' AND p.data->>'state'='returned';
 ELSIF event='letter_release_pending' THEN ready:=p.data->>'documentKind'='letter' AND app.probation_signatures_complete(p.id) AND EXISTS(SELECT 1 FROM probation_outcome o WHERE o.letter_part_id=p.id AND o.tenant_id=p.tenant_id AND o.released_at IS NULL);
 ELSIF event='letter_released' THEN ready:=p.data->>'documentKind'='letter' AND EXISTS(SELECT 1 FROM probation_outcome o WHERE o.letter_part_id=p.id AND o.tenant_id=p.tenant_id AND (o.released_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date=day);
 ELSE ready:=false;hold:='This event requires an explicitly reviewed batch source.';END IF;
 IF ready IS NOT TRUE AND hold IS NULL THEN hold:='The current date or pending source step does not match this trigger.';END IF;
 words:=jsonb_build_object('employeeName',source->>'employeeName','employeeCode',source->>'employeeCode','companyName',source->>'companyName','part',CASE WHEN p.data->>'documentKind'='letter' THEN 'outcome letter' ELSE p.data->>'type' END,'dueOn',coalesce(p.data->>'dueOn',c.data->>'endOn'),'endOn',c.data->>'endOn');
 FOR step IN SELECT item FROM jsonb_array_elements(coalesce(p_definition->'steps','[]')) items(item) LOOP
 SELECT coalesce(jsonb_agg(r),'[]') INTO roles FROM jsonb_array_elements_text(coalesce(step->'to','[]')) r WHERE r IN('employee','lm','hod','pbp','gbs') AND (event NOT IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending','letter_signing_pending') OR EXISTS(SELECT 1 FROM app.probation_pending_parties(p.id) party WHERE party.role=r));
 users:=app.probation_users_for_roles(c.employment_id,roles);
 SELECT coalesce(jsonb_agg(jsonb_build_object('role',r,'userId',u.id,'name',person.full_name) ORDER BY r,person.full_name,u.id),'[]') INTO recipients FROM jsonb_array_elements_text(roles) r JOIN app_user u ON u.tenant_id=c.tenant_id JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE (CASE WHEN event IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending','letter_signing_pending') THEN EXISTS(SELECT 1 FROM app.probation_pending_parties(p.id) party WHERE party.role=r AND party.user_id=u.id) ELSE users?u.id::text AND (r='gbs' OR app.probation_holders(c.employment_id)->>r=u.id::text) END) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 subject:=step->>'subject';body:=step->>'body';FOR k,value IN SELECT key,coalesce(v,'') FROM jsonb_each_text(words) e(key,v) LOOP subject:=regexp_replace(subject,'[{][{][[:space:]]*'||k||'[[:space:]]*[}][}]','{{'||k||'}}','g');body:=regexp_replace(body,'[{][{][[:space:]]*'||k||'[[:space:]]*[}][}]','{{'||k||'}}','g');subject:=replace(subject,'{{'||k||'}}',value);body:=replace(body,'{{'||k||'}}',value);END LOOP;
 messages:=messages||jsonb_build_array(jsonb_build_object('id',step->>'id','subject',subject,'body',body,'roles',roles,'recipients',recipients,'caseHref','/lifecycle/probation/'||c.id::text||CASE WHEN p.data->>'documentKind'='letter' THEN '/letters/'||p.id::text ELSE '' END));
 END LOOP;
 RETURN jsonb_build_object('matches',true,'ready',coalesce(ready,false),'holdReason',hold,'id',p.id,'partId',p.id,'type',p.data->'type','dueOn',p.data->>'dueOn','state',p.data->>'state','messages',messages);
END $$;
CREATE FUNCTION app.probation_workflow_preview(p_company uuid,p_definition jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;plan jsonb;parts jsonb;examples jsonb:='[]';count integer:=0;
BEGIN
 IF app.probation_config_admin(p_company) IS NOT TRUE OR p_definition->>'module' IS DISTINCT FROM 'probation' THEN RAISE EXCEPTION 'Named company workflow preparer required';END IF;
 FOR c IN SELECT * FROM probation_case WHERE tenant_id=app.current_tenant_id() AND company_id=p_company ORDER BY id LIMIT 101 LOOP
 count:=count+1;IF count>100 THEN EXIT;END IF;parts:='[]';
 FOR p IN SELECT * FROM probation_part WHERE tenant_id=c.tenant_id AND case_id=c.id AND data->>'state'<>'cancelled' ORDER BY created_at,id LOOP plan:=app.probation_workflow_plan(c.id,p.id,p_definition);IF plan->>'matches'='true' THEN parts:=parts||jsonb_build_array(plan);END IF;END LOOP;
 IF jsonb_array_length(parts)>0 THEN examples:=examples||jsonb_build_array(jsonb_build_object('id',c.id,'employeeName',c.data->'facts'->>'employeeName','endOn',c.data->>'endOn','parts',parts));END IF;
 END LOOP;RETURN jsonb_build_object('examples',examples,'truncated',count>100,'sends',false);
END $$;
REVOKE ALL ON FUNCTION app.probation_workflow_plan(uuid,uuid,jsonb),app.probation_workflow_preview(uuid,jsonb) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_workflow_preview(uuid,jsonb) TO ai_hr_app;
CREATE FUNCTION app.probation_pending_signers(p_part uuid) RETURNS TABLE(role text,user_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;stage integer;route jsonb;
BEGIN
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=app.current_tenant_id() AND subject_type='probation' AND subject_id=p_part;IF NOT FOUND OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'action'='returned' AND action->>'contentRevision'=d.data->>'contentRevision' AND action->>'contentHash'=d.data->>'contentHash') THEN RETURN;END IF;
 route:=app.probation_signing_refresh_route(p_part);
 IF route IS NULL THEN RETURN;END IF;
 SELECT min((s->>'stage')::integer) INTO stage FROM jsonb_array_elements(route->'steps') s WHERE s->>'required'='true' AND NOT app.document_signing_step_fulfilled(d.data,s);
 RETURN QUERY SELECT s->>'role',(s->>'holderId')::uuid FROM jsonb_array_elements(route->'steps') s WHERE s->>'required'='true' AND (s->>'stage')::integer=stage AND s->>'holderId' IS NOT NULL AND s->>'coveredByStepId' IS NULL AND NOT app.document_signing_step_fulfilled(d.data,s);
END $$;
REVOKE ALL ON FUNCTION app.probation_pending_signers(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_review_transition(p_part uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;w probation_builder_definition;plan jsonb;message jsonb;users jsonb;roles jsonb;key text;occurrence uuid;event_id uuid;configured boolean:=false;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 IF p.id IS NULL OR coalesce(p.data->>'documentKind','review')<>'review' OR app.probation_active_user() IS NOT TRUE OR NOT(app.probation_case_access(c.id)) THEN RAISE EXCEPTION 'Current scoped review actor required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF d.id IS NULL OR p.data->>'managerSubmittedAt' IS NULL OR p.data->>'state' IN('locked','completed_offline','cancelled','returned') THEN RETURN;END IF;
 SELECT coalesce(jsonb_agg(DISTINCT party.user_id),'[]'),coalesce(jsonb_agg(DISTINCT party.role),'[]') INTO users,roles FROM app.probation_pending_parties(p.id) party;IF jsonb_array_length(users)=0 THEN RETURN;END IF;
 FOR w IN SELECT * FROM probation_builder_definition WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND kind='workflow' AND state='published' AND data->'trigger'->>'event'='approval_pending' AND c.data->'workflowIds'?id::text LOOP
 plan:=app.probation_workflow_plan(c.id,p.id,w.data);IF plan->>'matches' IS DISTINCT FROM 'true' OR plan->>'ready' IS DISTINCT FROM 'true' THEN CONTINUE;END IF;
 FOR message IN SELECT value FROM jsonb_array_elements(plan->'messages') LOOP
 IF jsonb_array_length(message->'recipients')=0 THEN CONTINUE;END IF;configured:=true;key:='probation-review:'||p.id::text||':'||d.revision::text||':'||w.id::text||':'||(message->>'id');IF EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN CONTINUE;END IF;
 SELECT jsonb_agg(DISTINCT recipient->'userId'),jsonb_agg(DISTINCT recipient->'role') INTO users,roles FROM jsonb_array_elements(message->'recipients') recipient;
 occurrence:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',occurrence,'probation.notification-due','user',app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'kind','approval_pending')) RETURNING id INTO event_id;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id,workflow_id,workflow_step_id) VALUES(occurrence,c.tenant_id,c.id,p.id,key,'approval_pending',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,users,roles,'scheduled',p.revision,event_id,w.id,message->>'id');
 END LOOP;END LOOP;
 IF NOT configured THEN
 SELECT jsonb_agg(DISTINCT party.user_id),jsonb_agg(DISTINCT party.role) INTO users,roles FROM app.probation_pending_parties(p.id) party;
 IF users IS NULL OR jsonb_array_length(users)=0 THEN RETURN;END IF;
 key:='probation-review:'||p.id::text||':'||d.revision::text||':in-app';IF NOT EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN occurrence:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',occurrence,'probation.notification-due','user',app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'kind','approval_pending')) RETURNING id INTO event_id;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id) VALUES(occurrence,c.tenant_id,c.id,p.id,key,'approval_pending',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,users,roles,'scheduled',p.revision,event_id);END IF;END IF;
END $$;
REVOKE ALL ON FUNCTION app.probation_review_transition(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_review_transition(uuid) TO ai_hr_app;
CREATE FUNCTION app.probation_validate_evaluation_route(p_route jsonb,p_type integer) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE manager_stage integer;employee_stage integer;
BEGIN
 IF p_type IS NULL OR p_type NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'Choose an evaluation Part from 1 to 3';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_route->'steps','[]')) step WHERE step?'coveredStepIds' OR step?'coveredByStepId') THEN
  RAISE EXCEPTION 'Signing role coverage is resolved from the active policy and actual holders';
 END IF;
 PERFORM app.document_signing_validate(jsonb_build_object('route',p_route,'actions','[]'::jsonb),jsonb_build_object('requiredRoles','["lm","employee"]'::jsonb)||CASE WHEN p_type=3 THEN jsonb_build_object('independentApprovalFromRole','lm') ELSE '{}'::jsonb END);
 IF (SELECT count(*) FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='lm')<>1 OR (SELECT count(*) FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='employee')<>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role' NOT IN('lm','employee','hod','pbp') OR s->>'holderId' IS NOT NULL OR s->>'representedId' IS NOT NULL OR s->>'role'='lm' AND s->>'kind'<>'sign' OR s->>'role'='employee' AND s->>'kind'<>'acknowledge') THEN RAISE EXCEPTION 'Evaluation routes use one manager signature, one employee acknowledgement and source role approvers';END IF;
 SELECT (s->>'stage')::integer INTO manager_stage FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='lm';SELECT (s->>'stage')::integer INTO employee_stage FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role'='employee';
 IF employee_stage<=manager_stage OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role' NOT IN('lm','employee') AND (s->>'stage')::integer<=manager_stage) THEN RAISE EXCEPTION 'Manager signing must precede acknowledgement and later approvals';END IF;
END $$;
REVOKE ALL ON FUNCTION app.probation_validate_evaluation_route(jsonb,integer) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_write_lock() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL THEN RAISE EXCEPTION 'Tenant-bound probation command required';END IF;
 PERFORM app.access_workforce_write_lock();PERFORM pg_advisory_xact_lock(hashtextextended('probation-write:'||app.current_tenant_id()::text,0));
END $$;
REVOKE ALL ON FUNCTION app.probation_write_lock() FROM PUBLIC,ai_hr_app;
CREATE TABLE probation_filing_queue(
 file_id uuid PRIMARY KEY REFERENCES probation_file(id),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES probation_case(id),
 source_hash text NOT NULL,reason text NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','filed','held')),created_at timestamptz NOT NULL DEFAULT now(),filed_at timestamptz,failure text
);
ALTER TABLE probation_filing_queue ENABLE ROW LEVEL SECURITY;ALTER TABLE probation_filing_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_owner ON probation_filing_queue FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON probation_filing_queue FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_file_owner(p_file uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q probation_filing_queue;f probation_file;c probation_case;doc uuid;
BEGIN
 PERFORM app.probation_write_lock();IF app.probation_storage_runner() IS NOT TRUE THEN RAISE EXCEPTION 'Verified no-login owner required for canonical Personal File filing';END IF;
 SELECT * INTO q FROM probation_filing_queue WHERE file_id=p_file AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO f FROM probation_file WHERE id=q.file_id AND tenant_id=q.tenant_id FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=q.case_id AND tenant_id=q.tenant_id;
 IF q.file_id IS NULL OR f.case_id IS DISTINCT FROM c.id OR q.source_hash IS DISTINCT FROM f.content_hash OR q.source_hash IS DISTINCT FROM encode(sha256(f.content),'hex') OR f.kind NOT IN('offline','completed_part','letter_released') OR app.probation_company_entitled(c.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Unchanged authorized probation PDF source and company entitlement required';END IF;
 IF f.employee_document_id IS NOT NULL THEN RETURN f.employee_document_id;END IF;IF app.probation_case_company_current(c.id) IS NOT TRUE THEN PERFORM app.probation_hold_source_transfer(c.id);RETURN NULL;END IF;IF NOT EXISTS(SELECT 1 FROM probation_activation active WHERE active.tenant_id=c.tenant_id AND active.company_id=c.company_id AND active.enabled) THEN RETURN NULL;END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF f.kind='letter_released' AND NOT EXISTS(SELECT 1 FROM probation_outcome o WHERE o.case_id=c.id AND o.tenant_id=c.tenant_id AND o.letter_file_id=f.id AND o.released_at IS NOT NULL) THEN RAISE EXCEPTION 'A current authenticated release receipt is required';END IF;
 INSERT INTO employee_document(tenant_id,employment_id,title,category,description,content,file_name,mime_type,size_bytes,uploaded_by_user_id,updated_by_user_id) VALUES(c.tenant_id,c.employment_id,CASE WHEN f.kind='letter_released' THEN 'Probation outcome letter' WHEN f.kind='offline' THEN 'Completed offline probation review' ELSE 'Completed probation review' END,'Probation','Automatically filed from approved Probation source '||f.id::text,f.content,f.name,'application/pdf',octet_length(f.content),NULL,NULL) RETURNING id INTO doc;
 UPDATE probation_file SET employee_document_id=doc WHERE id=f.id;UPDATE probation_outcome SET failure=NULL WHERE letter_file_id=f.id AND tenant_id=f.tenant_id AND state='released';UPDATE probation_filing_queue SET state='filed',filed_at=now(),failure=NULL WHERE file_id=f.id;PERFORM app.probation_audit(c.id,f.part_id,'personal_file_filed');RETURN doc;
END $$;
REVOKE ALL ON FUNCTION app.probation_file_owner(uuid) FROM PUBLIC,ai_hr_app;
CREATE INDEX probation_filing_pending ON probation_filing_queue(tenant_id,state,created_at);
CREATE FUNCTION app.probation_signer_candidate(p_case uuid,p_user uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;h jsonb;v_person_id uuid;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();IF c.id IS NULL THEN RETURN false;END IF;
 SELECT u.person_id INTO v_person_id FROM app_user u WHERE u.id=p_user AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);IF v_person_id IS NULL THEN RETURN false;END IF;h:=app.probation_holders(c.employment_id);
 RETURN coalesce(p_user::text IN(h->>'employee',h->>'lm',h->>'hod',h->>'pbp') OR app.lifecycle_canonical_people_ops_member(c.company_id,p_user) OR EXISTS(SELECT 1 FROM employment e WHERE e.person_id=v_person_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)),false);
END $$;
CREATE FUNCTION app.probation_signer_candidates(p_case uuid,p_search text DEFAULT '') RETURNS TABLE(id uuid,name text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;
BEGIN
 SELECT * INTO c FROM probation_case WHERE probation_case.id=p_case AND tenant_id=app.current_tenant_id();IF c.id IS NULL OR app.probation_case_access(c.id) IS NOT TRUE OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'Current scoped PBP or People Ops authority required';END IF;
 RETURN QUERY SELECT u.id,p.full_name FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.tenant_id=c.tenant_id AND app.probation_signer_candidate(c.id,u.id) AND (coalesce(p_search,'')='' OR p.full_name ILIKE '%'||left(p_search,100)||'%') ORDER BY p.full_name,u.id LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION app.probation_signer_candidate(uuid,uuid),app.probation_signer_candidates(uuid,text) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_signer_candidates(uuid,text) TO ai_hr_app;
CREATE FUNCTION app.probation_inbox() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.probation_active_user() IS NOT TRUE THEN RETURN jsonb_build_object('count',0,'items','[]'::jsonb);END IF;
 WITH review_tasks AS (
 SELECT c.id as case_id,p.id as part_id,person.full_name as employee_name,command.kind,'/lifecycle/probation/'||c.id::text||'/'||p.id::text as href,coalesce((p.data->>'dueOn')::date,(c.data->>'endOn')::date) as due_on
 FROM probation_case c JOIN probation_part p ON p.case_id=c.id AND p.tenant_id=c.tenant_id JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id JOIN person person ON person.id=e.person_id AND person.tenant_id=e.tenant_id
 CROSS JOIN LATERAL(SELECT value as kind FROM unnest(app.probation_commands(p.id)) value WHERE value IN('submit_employee','submit_manager','acknowledge','approve','record','confirm_extension','confirm_refusal','kpi_exception','employee_wait_exception') LIMIT 1) command
 WHERE c.tenant_id=app.current_tenant_id() AND coalesce(p.data->>'documentKind','review')='review' AND app.probation_case_access(c.id)
 ),letter_tasks AS (
 SELECT c.id as case_id,t."partId" as part_id,person.full_name as employee_name,CASE WHEN t.state='awaiting_revision' THEN 'letter_revise' WHEN t.state='awaiting_release' THEN 'letter_release' ELSE 'letter_sign' END as kind,'/lifecycle/probation/'||c.id::text||'/letters/'||t."partId"::text as href,(c.data->>'endOn')::date as due_on
 FROM probation_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id JOIN person person ON person.id=e.person_id AND person.tenant_id=e.tenant_id CROSS JOIN LATERAL app.probation_letter_tasks(c.id) t
 WHERE c.tenant_id=app.current_tenant_id() AND app.probation_case_access(c.id) AND app.probation_case_company_current(c.id) AND EXISTS(SELECT 1 FROM probation_activation active WHERE active.tenant_id=c.tenant_id AND active.company_id=c.company_id AND active.enabled) AND (EXISTS(SELECT 1 FROM app.probation_pending_signers(t."partId") signer WHERE signer.user_id=app.current_user_id()) OR t.state IN('awaiting_revision','awaiting_release') AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')))
 ),tasks AS (SELECT * FROM review_tasks UNION ALL SELECT * FROM letter_tasks)
 SELECT jsonb_build_object('count',(SELECT count(*) FROM tasks),'items',coalesce((SELECT jsonb_agg(jsonb_build_object('caseId',case_id,'partId',part_id,'employeeName',employee_name,'kind',kind,'href',href) ORDER BY due_on,case_id,part_id) FROM(SELECT * FROM tasks ORDER BY due_on,case_id,part_id LIMIT 20) bounded),'[]'::jsonb)) INTO result;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.probation_inbox() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_inbox() TO ai_hr_app;
CREATE FUNCTION app.probation_letter_values(p_outcome uuid,p_template uuid,p_subject uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;e employment;a assignment;h jsonb;d document_signing_document;letter document_signing_document;holder uuid;signer_name text;signer_title text;manager_name text;head_name text;partner_name text;months integer;new_end text;result jsonb;subject probation_part;has_signed boolean:=false;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=c.tenant_id;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id;IF e.id IS NULL OR t.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO a FROM assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND superseded_at IS NULL AND valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (valid_to IS NULL OR valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY valid_from DESC,id LIMIT 1;h:=app.probation_holders(e.id);
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=c.tenant_id AND subject_type='probation' AND subject_id=o.part_id;
 SELECT action->>'actorName' INTO manager_name FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'role'='lm' AND action->>'action'='signed' AND action->>'contentRevision'=d.data->>'contentRevision' AND action->>'contentHash'=d.data->>'contentHash' LIMIT 1;
 SELECT action->>'actorName' INTO head_name FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'role'='hod' AND action->>'action'='signed' AND action->>'contentRevision'=d.data->>'contentRevision' AND action->>'contentHash'=d.data->>'contentHash' LIMIT 1;
 SELECT action->>'actorName' INTO partner_name FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'role'='pbp' AND action->>'action'='signed' AND action->>'contentRevision'=d.data->>'contentRevision' AND action->>'contentHash'=d.data->>'contentHash' LIMIT 1;
 SELECT (h->>(step->>'role'))::uuid INTO holder FROM jsonb_array_elements(t.data->'route'->'steps') step WHERE step->>'required'='true' AND step->>'role'<>'employee' ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
 IF p_subject IS NOT NULL THEN
  SELECT * INTO subject FROM probation_part WHERE id=p_subject AND tenant_id=c.tenant_id AND case_id=c.id;SELECT * INTO letter FROM document_signing_document WHERE subject_id=p_subject AND subject_type='probation' AND tenant_id=c.tenant_id;
  SELECT (action->>'actorId')::uuid,action->>'actorName' INTO holder,signer_name FROM jsonb_array_elements(letter.data->'actions') action JOIN jsonb_array_elements(letter.data->'route'->'steps') step ON step->>'id'=action->>'stepId' WHERE action->>'role'<>'employee' AND action->>'action'='signed' AND action->>'contentRevision'=letter.data->>'contentRevision' AND action->>'contentHash'=letter.data->>'contentHash' ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
  IF signer_name IS NOT NULL THEN has_signed:=true;signer_title:=subject.data->'letterMerge'->>'signatoryTitle';ELSE SELECT (h->>(step->>'role'))::uuid INTO holder FROM jsonb_array_elements(t.data->'route'->'steps') step WHERE step->>'required'='true' AND step->>'role'<>'employee' ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;END IF;
 END IF;
 IF signer_name IS NULL THEN SELECT person.full_name INTO signer_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=holder AND u.tenant_id=c.tenant_id;END IF;
 IF NOT has_signed AND signer_title IS NULL THEN SELECT company->>'signatoryTitle' INTO signer_title FROM lc_v9_config configuration CROSS JOIN LATERAL jsonb_array_elements(coalesce(configuration.data->'companies','[]')) company WHERE configuration.tenant_id=c.tenant_id AND company->>'companyId'=c.company_id::text AND company->>'signatoryUserId'=holder::text LIMIT 1;END IF;
 IF NOT has_signed AND nullif(signer_title,'') IS NULL THEN SELECT position.title INTO signer_title FROM app_user u JOIN employment employment ON employment.person_id=u.person_id AND employment.tenant_id=u.tenant_id JOIN assignment assignment ON assignment.employment_id=employment.id AND assignment.tenant_id=employment.tenant_id AND assignment.superseded_at IS NULL AND assignment.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (assignment.valid_to IS NULL OR assignment.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) JOIN position position ON position.id=assignment.position_id AND position.tenant_id=assignment.tenant_id WHERE u.id=holder AND u.tenant_id=c.tenant_id AND (least(employment.terminated_on,employment.resignation_date,employment.last_working_date) IS NULL OR least(employment.terminated_on,employment.resignation_date,employment.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY (employment.company_id=c.company_id) DESC,employment.hired_on DESC,employment.id LIMIT 1;END IF;
 SELECT (data->>'extensionMonths')::integer INTO months FROM probation_rater_draft WHERE part_id=o.part_id AND tenant_id=c.tenant_id AND rater='lm';IF o.outcome='extend' AND months IN(3,6) THEN new_end:=((c.data->>'endOn')::date+interval '1 day'+(months::text||' months')::interval-interval '1 day')::date::text;END IF;
 result:=jsonb_build_object('employeeJobTitle',coalesce((SELECT title FROM position WHERE id=a.position_id AND tenant_id=c.tenant_id),''),'employeeGrade',coalesce((SELECT regexp_replace(upper(code),'^(JG|GRADE)[ -]*','','g') FROM job_grade WHERE id=e.grade_id AND tenant_id=e.tenant_id),c.data->>'gradeAtStart'),'businessGroup',coalesce((SELECT bg.legal_name FROM company co JOIN company bg ON bg.id=coalesce(co.parent_company_id,co.id) AND bg.tenant_id=co.tenant_id WHERE co.id=c.company_id AND co.tenant_id=c.tenant_id),''),'businessUnit',coalesce((SELECT name FROM business_unit WHERE id=a.business_unit_id AND tenant_id=c.tenant_id),''),'division',coalesce(e.org_division,''),'department',coalesce((SELECT name FROM department WHERE id=a.department_id AND tenant_id=c.tenant_id),''),'lineManagerName',coalesce(manager_name,(SELECT person.full_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=(h->>'lm')::uuid AND u.tenant_id=c.tenant_id),''),'hodName',coalesce(head_name,(SELECT person.full_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=(h->>'hod')::uuid AND u.tenant_id=c.tenant_id),''),'pbpName',coalesce(partner_name,(SELECT person.full_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=(h->>'pbp')::uuid AND u.tenant_id=c.tenant_id),''),'originalEndOn',coalesce(c.data->>'originalEndOn',c.data->>'endOn'),'reviewPlanMonths',coalesce(c.data->>'planMonths',''),'confirmationEffectiveOn',CASE WHEN o.outcome='confirm' THEN c.data->>'endOn' ELSE '' END,'extensionNewEndOn',coalesce(new_end,''),'extensionCount',coalesce(c.data->>'extensionCount','0'),'maxExtensions',coalesce(c.data->'config'->>'maxExtensions','2'),'signatoryName',coalesce(signer_name,''),'signatoryTitle',coalesce(signer_title,''),'acknowledgedBy','','acknowledgedOn','');RETURN result;
END $$;
CREATE FUNCTION app.probation_letter_stamp_value(p_part uuid,p_tenant uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;source jsonb;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=p_tenant;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p_tenant;IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' THEN RETURN NULL;END IF;
 source:=app.probation_letter_source_value(c.employment_id,c.tenant_id)||jsonb_build_object('letterValues',app.probation_letter_values((p.data->>'letterOutcomeId')::uuid,(p.data->>'letterTemplateId')::uuid,p.id));RETURN app.probation_letter_source_stamp(source);
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_values(uuid,uuid,uuid),app.probation_letter_stamp_value(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_letter_protected_keys() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT ARRAY['employeeName','employeeCode','companyName','startOn','endOn','outcome','extensionMonths','employeeJobTitle','employeeGrade','businessGroup','businessUnit','division','department','lineManagerName','hodName','pbpName','originalEndOn','reviewPlanMonths','confirmationEffectiveOn','extensionNewEndOn','extensionCount','maxExtensions','signatoryName','signatoryTitle','acknowledgedBy','acknowledgedOn','company.name','company.regNo','company.address','company.color'];
$$;
CREATE FUNCTION app.probation_validate_letter_fields(p_fields jsonb,p_merge jsonb,p_preparing boolean DEFAULT true) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field jsonb;control jsonb;key text;value text;rows jsonb;number numeric;required boolean;
BEGIN
 IF jsonb_typeof(p_fields) IS DISTINCT FROM 'array' OR jsonb_array_length(p_fields)>200 OR (SELECT count(DISTINCT f->>'id') FROM jsonb_array_elements(p_fields) f)<>jsonb_array_length(p_fields) THEN RAISE EXCEPTION 'Use bounded uniquely identified letter fields';END IF;
 FOR field IN SELECT item FROM jsonb_array_elements(p_fields) items(item) LOOP
 IF nullif(field->>'id','') IS NULL OR coalesce(field->>'type','') NOT IN('text','textarea','select','date','checkbox','phone','email','number','table') OR coalesce(field->>'owner','') NOT IN('hr','pmLocked') OR field->>'owner'='pmLocked' AND NOT(coalesce(field->>'pmKey','')=ANY(app.probation_letter_protected_keys())) OR field->>'owner'='hr' AND (field->>'pmKey' IS NOT NULL OR field->>'id'=ANY(app.probation_letter_protected_keys())) THEN RAISE EXCEPTION 'Use declared HR fields or registered immutable Personnel fields';END IF;
 key:=coalesce(field->>'pmKey',field->>'id');value:=coalesce(p_merge->>key,'');
 IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb THEN SELECT item INTO control FROM jsonb_array_elements(p_fields) items(item) WHERE item->>'id'=field->'when'->>'field';IF control IS NULL THEN RAISE EXCEPTION 'Conditional field source is missing';END IF;IF coalesce(p_merge->>coalesce(control->>'pmKey',control->>'id'),'') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;END IF;
 IF key IN('acknowledgedBy','acknowledgedOn') THEN IF field->>'type' NOT IN('text','textarea') THEN RAISE EXCEPTION 'Authenticated acknowledgement fields use a read-only text value';END IF;CONTINUE;END IF;
 required:=p_preparing AND coalesce((field->>'required')::boolean,false);IF length(value)>20000 OR required AND length(btrim(value))=0 OR required AND field->>'type'='checkbox' AND value<>'true' THEN RAISE EXCEPTION 'Complete every required visible letter field';END IF;
 IF value='' THEN CONTINUE;END IF;
 IF field->>'type'='select' AND NOT(coalesce(field->'options','[]')?value) OR field->>'type'='checkbox' AND value NOT IN('true','false') OR field->>'type'='email' AND value!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN RAISE EXCEPTION 'Use valid declared letter field values';END IF;
 IF field->>'type'='date' THEN IF value!~'^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Use an ISO calendar date';END IF;PERFORM value::date;END IF;
 IF field->>'type'='number' THEN IF value~*'^(NaN|[+-]?Infinity)$' THEN RAISE EXCEPTION 'Use a finite letter field number';END IF;number:=value::numeric;END IF;
 IF field->>'type'='table' THEN rows:=value::jsonb;IF jsonb_typeof(rows) IS DISTINCT FROM 'array' OR jsonb_array_length(rows)>50 OR required AND jsonb_array_length(rows)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(rows) records(item) WHERE jsonb_typeof(item) IS DISTINCT FROM 'array' OR jsonb_array_length(item) IS DISTINCT FROM coalesce(jsonb_array_length(field->'columns'),0) OR EXISTS(SELECT 1 FROM jsonb_array_elements(item) cells(cell) WHERE jsonb_typeof(cell) IS DISTINCT FROM 'string' OR length(cell#>>'{}')>1000)) THEN RAISE EXCEPTION 'Use valid bounded letter table rows';END IF;END IF;
 END LOOP;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN RAISE EXCEPTION 'Use valid declared letter field values';
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_protected_keys(),app.probation_validate_letter_fields(jsonb,jsonb,boolean) FROM PUBLIC,ai_hr_app;
CREATE TABLE probation_render_request(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES probation_case(id),part_id uuid NOT NULL REFERENCES probation_part(id),outcome_id uuid REFERENCES probation_outcome(id),kind text NOT NULL CHECK(kind IN('review','letter')),
 content_hash text NOT NULL,content_revision integer NOT NULL,document_id uuid NOT NULL REFERENCES document_signing_document(id),document_revision integer NOT NULL,
 requested_by uuid REFERENCES app_user(id),reason text NOT NULL,render_data jsonb NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','sealed','held')),file_id uuid REFERENCES probation_file(id),failure text,created_at timestamptz NOT NULL DEFAULT now(),sealed_at timestamptz,
 UNIQUE(tenant_id,part_id,kind,content_hash)
);
ALTER TABLE probation_render_request ENABLE ROW LEVEL SECURITY;ALTER TABLE probation_render_request FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_owner ON probation_render_request FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());REVOKE ALL ON probation_render_request FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_enqueue_review_pdf(p_part uuid,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;request uuid;form jsonb;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 IF p.id IS NULL OR coalesce(p.data->>'documentKind','review')<>'review' OR p.data->>'state'<>'locked' OR app.probation_signatures_complete(p.id) IS NOT TRUE THEN RAISE EXCEPTION 'A complete authenticated source review is required';END IF;
 SELECT id INTO request FROM probation_render_request WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='review' AND content_hash=d.data->>'contentHash';IF request IS NOT NULL THEN RETURN request;END IF;
 SELECT data INTO form FROM probation_configuration WHERE id=c.form_id AND tenant_id=c.tenant_id;
 INSERT INTO probation_render_request(tenant_id,case_id,part_id,kind,content_hash,content_revision,document_id,document_revision,requested_by,reason,render_data)
 VALUES(c.tenant_id,c.id,p.id,'review',d.data->>'contentHash',(d.data->>'contentRevision')::integer,d.id,d.revision,app.current_user_id(),p_reason,jsonb_build_object('record',c.data,'part',p.data,'form',form,'employee',(SELECT data FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=p.tenant_id AND rater='employee'),'manager',(SELECT data FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=p.tenant_id AND rater='lm'),'signing',d.data,'signingId',d.id,'contentData',app.probation_content(p.id),'partContentRevision',p.content_revision)) RETURNING id INTO request;RETURN request;
END $$;
CREATE FUNCTION app.probation_request_part_pdf(p_part uuid,p_expected integer,p_content integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;request uuid;file uuid;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF p.id IS NULL OR app.probation_case_access(p.case_id) IS NOT TRUE OR p.revision IS DISTINCT FROM p_expected OR p.content_revision IS DISTINCT FROM p_content THEN RAISE EXCEPTION 'Read the current completed review generation';END IF;
 PERFORM app.probation_assert_case_runtime(p.case_id);
 request:=app.probation_enqueue_review_pdf(p.id,'Completed authenticated probation PDF requested');SELECT file_id INTO file FROM probation_render_request WHERE id=request;RETURN jsonb_build_object('requestId',request,'fileId',file,'status',CASE WHEN file IS NULL THEN 'pending' ELSE 'ready' END);
END $$;
CREATE FUNCTION app.probation_owner_render_context(p_request uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q probation_render_request;p probation_part;c probation_case;
BEGIN
 PERFORM app.probation_write_lock();IF app.probation_storage_runner() IS NOT TRUE THEN RAISE EXCEPTION 'Verified no-login rendering owner required';END IF;
 SELECT * INTO q FROM probation_render_request WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;IF q.id IS NULL THEN RAISE EXCEPTION 'Protected render request unavailable';END IF;IF q.state='sealed' THEN RETURN jsonb_build_object('sealed',true,'fileId',q.file_id);END IF;
 SELECT * INTO c FROM probation_case WHERE id=q.case_id AND tenant_id=q.tenant_id;IF app.probation_case_company_current(c.id) IS NOT TRUE THEN PERFORM app.probation_hold_source_transfer(c.id);RETURN jsonb_build_object('held',true);END IF;IF NOT EXISTS(SELECT 1 FROM probation_activation active WHERE active.tenant_id=c.tenant_id AND active.company_id=c.company_id AND active.enabled) THEN RETURN jsonb_build_object('paused',true);END IF;PERFORM app.probation_assert_case_runtime(c.id);IF app.probation_company_entitled(c.company_id) IS NOT TRUE OR q.content_hash IS DISTINCT FROM encode(sha256(convert_to((q.render_data->'contentData')::text,'UTF8')),'hex') OR NOT EXISTS(SELECT 1 FROM document_signing_revision revision WHERE revision.document_id=q.document_id AND revision.tenant_id=q.tenant_id AND revision.revision=q.document_revision AND revision.data->>'contentHash'=q.content_hash AND revision.data=q.render_data->'signing') THEN RAISE EXCEPTION 'Immutable source content and real signing snapshot are required';END IF;
 IF q.kind='letter' THEN SELECT * INTO p FROM probation_part WHERE id=q.part_id AND tenant_id=q.tenant_id FOR UPDATE;IF NOT EXISTS(SELECT 1 FROM probation_outcome o WHERE o.id=q.outcome_id AND o.tenant_id=q.tenant_id AND o.letter_part_id=p.id AND o.state='release_requested') OR app.probation_letter_source_current(p.id) IS NOT TRUE THEN UPDATE probation_render_request SET state='held',failure='The signed letter source changed; current PBP adjudication is required.' WHERE id=q.id;UPDATE probation_outcome SET state='awaiting_revision',failure='The signed letter source changed; prepare a current approved generation.' WHERE id=q.outcome_id;UPDATE probation_part SET data=jsonb_set(data,'{state}','"returned"'),revision=revision+1 WHERE id=p.id;RETURN jsonb_build_object('held',true);END IF;END IF;
 RETURN jsonb_build_object('id',q.id,'kind',q.kind,'caseId',q.case_id,'partId',q.part_id,'contentHash',q.content_hash,'data',q.render_data);
END $$;
CREATE FUNCTION app.probation_owner_seal_render(p_request uuid,p_hash text,p_pdf bytea) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q probation_render_request;file uuid;context jsonb;c probation_case;
BEGIN
 PERFORM app.probation_write_lock();IF app.probation_storage_runner() IS NOT TRUE THEN RAISE EXCEPTION 'Verified no-login sealing owner required';END IF;context:=app.probation_owner_render_context(p_request);IF context->>'held'='true' OR context->>'paused'='true' THEN RETURN NULL;END IF;SELECT * INTO q FROM probation_render_request WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;IF q.state='sealed' THEN RETURN q.file_id;END IF;
 IF q.content_hash IS DISTINCT FROM p_hash OR p_pdf IS NULL OR octet_length(p_pdf) NOT BETWEEN 5 AND 10485760 OR substring(p_pdf FROM 1 FOR 5)<>convert_to('%PDF-','UTF8') THEN RAISE EXCEPTION 'The real owner must seal the exact canonical rendering source';END IF;SELECT * INTO c FROM probation_case WHERE id=q.case_id AND tenant_id=q.tenant_id;
 INSERT INTO probation_file(tenant_id,case_id,part_id,kind,revision,name,content,content_hash,created_by) VALUES(q.tenant_id,c.id,q.part_id,CASE WHEN q.kind='letter' THEN 'letter_released' ELSE 'completed_part' END,q.content_revision,CASE WHEN q.kind='letter' THEN 'probation-outcome-' ELSE 'probation-review-' END||q.content_revision::text||'.pdf',p_pdf,encode(sha256(p_pdf),'hex'),NULL) RETURNING id INTO file;
 INSERT INTO probation_filing_queue(file_id,tenant_id,case_id,source_hash,reason) VALUES(file,q.tenant_id,c.id,encode(sha256(p_pdf),'hex'),q.reason);
 IF q.kind='letter' THEN UPDATE probation_outcome SET state='released',released_by=q.requested_by,released_at=now(),letter_file_id=file,failure='Personal File filing is pending.',updated_at=now() WHERE id=q.outcome_id;UPDATE probation_part SET data=jsonb_set(data,'{state}','"locked"'),revision=revision+1 WHERE id=q.part_id;ELSE UPDATE probation_part SET data=jsonb_set(data,'{pdfPending}','false') WHERE id=q.part_id AND content_revision=(q.render_data->>'partContentRevision')::integer;END IF;
 UPDATE probation_render_request SET state='sealed',file_id=file,sealed_at=now(),failure=NULL WHERE id=q.id;PERFORM app.probation_file_owner(file);IF q.kind='letter' THEN PERFORM app.probation_letter_transition(q.part_id);END IF;PERFORM app.probation_audit(c.id,q.part_id,'canonical_pdf_sealed');RETURN file;
END $$;
CREATE FUNCTION app.probation_hold_render(p_request uuid,p_code text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q probation_render_request;
BEGIN
 PERFORM app.probation_write_lock();IF app.probation_storage_runner() IS NOT TRUE THEN RAISE EXCEPTION 'Verified no-login owner required';END IF;SELECT * INTO q FROM probation_render_request WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;IF q.id IS NULL OR q.state='sealed' THEN RETURN;END IF;
 UPDATE probation_render_request SET state='held',failure='A signature rendering needs current People Partner review.' WHERE id=q.id;
 IF q.kind='letter' THEN UPDATE probation_outcome SET state='awaiting_revision',failure='A signature rendering needs a fresh approved letter generation.' WHERE id=q.outcome_id;UPDATE probation_part SET data=jsonb_set(data,'{state}','"returned"'),revision=revision+1 WHERE id=q.part_id;ELSE UPDATE probation_part SET data=data||jsonb_build_object('pdfPending',true,'pdfFailureCode','signature_render_failed') WHERE id=q.part_id;END IF;
END $$;
REVOKE ALL ON FUNCTION app.probation_enqueue_review_pdf(uuid,text),app.probation_request_part_pdf(uuid,integer,integer),app.probation_owner_render_context(uuid),app.probation_owner_seal_render(uuid,text,bytea),app.probation_hold_render(uuid,text) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_request_part_pdf(uuid,integer,integer) TO ai_hr_app;
CREATE INDEX probation_render_pending ON probation_render_request(tenant_id,state,created_at);

-- Preparation custody is separate from activated runtime cases and Personal File documents.
CREATE TABLE probation_intake_entry (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),employment_id uuid NOT NULL REFERENCES employment(id),
 revision integer NOT NULL DEFAULT 1,source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),data jsonb NOT NULL,reviewed_by uuid NOT NULL REFERENCES app_user(id),reviewed_at timestamptz NOT NULL DEFAULT now(),applied_case_id uuid REFERENCES probation_case(id),
 UNIQUE(tenant_id,employment_id)
);
CREATE TABLE probation_intake_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),employment_id uuid NOT NULL REFERENCES employment(id),name text NOT NULL,content bytea NOT NULL,content_hash text NOT NULL,reason text NOT NULL,uploaded_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE probation_intake_entry ENABLE ROW LEVEL SECURITY;ALTER TABLE probation_intake_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE probation_intake_evidence ENABLE ROW LEVEL SECURITY;ALTER TABLE probation_intake_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_owner ON probation_intake_entry FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY probation_owner ON probation_intake_evidence FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE FUNCTION app.probation_intake_stage_access(p_employment uuid,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND e.company_id=p_company
  AND (app.probation_role(e.id,'pbp') OR app.probation_role(e.id,'gbs')))
$$;
REVOKE ALL ON FUNCTION app.probation_intake_stage_access(uuid,uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_intake_stage_access(uuid,uuid) TO ai_hr_app;
CREATE POLICY probation_intake_read ON probation_intake_entry FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (app.probation_config_admin(company_id) OR app.probation_intake_stage_access(employment_id,company_id)));
REVOKE ALL ON probation_intake_entry,probation_intake_evidence FROM PUBLIC,ai_hr_app;GRANT SELECT ON probation_intake_entry TO ai_hr_app;
CREATE FUNCTION app.probation_intake_digest(p_employment uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('source',app.probation_personnel_source(e.id),'versions',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY kind,id),'[]') FROM(SELECT DISTINCT ON(kind,CASE WHEN kind='form' THEN coalesce(data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]') ELSE '[]'::jsonb END) id,kind,version FROM probation_configuration WHERE tenant_id=e.tenant_id AND company_id=e.company_id AND state IN('published','retired') ORDER BY kind,CASE WHEN kind='form' THEN coalesce(data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]') ELSE '[]'::jsonb END,version DESC) v))::text,'UTF8')),'hex') FROM employment e WHERE e.tenant_id=app.current_tenant_id() AND e.id=p_employment;
$$;
CREATE FUNCTION app.probation_intake_save(p_employment uuid,p_expected integer,p_digest text,p_data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;entry probation_intake_entry;part jsonb;flag jsonb;v_id uuid;source jsonb;settings jsonb;required_parts jsonb;extensions integer;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO e FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF e.id IS NULL OR NOT(app.probation_role(e.id,'pbp') OR app.probation_role(e.id,'gbs')) OR app.probation_company_entitled(e.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Current canonical scoped PBP or People Ops reviewer required';END IF;
 IF EXISTS(SELECT 1 FROM probation_case WHERE employment_id=e.id AND tenant_id=e.tenant_id) THEN RAISE EXCEPTION 'This employment already has a probation case';END IF;
 SELECT * INTO entry FROM probation_intake_entry WHERE employment_id=e.id AND tenant_id=e.tenant_id FOR UPDATE;
 IF entry.id IS NOT NULL AND entry.company_id IS DISTINCT FROM e.company_id OR p_expected IS DISTINCT FROM coalesce(entry.revision,0) OR p_digest IS DISTINCT FROM app.probation_intake_digest(e.id) THEN RAISE EXCEPTION 'Personnel or intake configuration changed; review the current source';END IF;
 IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR p_data-ARRAY['kind','reason','validatedUnknown','exclusionFlags','parts','extensionCount','extensionEventIds','validatedHistory']<>'{}' OR coalesce(p_data->>'kind','') NOT IN('exclude','unfinished') OR length(btrim(coalesce(p_data->>'reason','')))<3 OR jsonb_typeof(p_data->'validatedUnknown') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_data->'exclusionFlags') IS DISTINCT FROM 'object' OR (p_data->'exclusionFlags')-ARRAY['noProbation','internalTransfer','rehire','confirmedOnHire']<>'{}' OR (SELECT count(*) FROM jsonb_each(p_data->'exclusionFlags'))<>4 OR EXISTS(SELECT 1 FROM jsonb_each(p_data->'exclusionFlags') f WHERE jsonb_typeof(f.value)<>'boolean') OR jsonb_typeof(p_data->'parts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'parts')>5 OR coalesce(p_data->>'extensionCount','0')!~'^[0-2]$' THEN RAISE EXCEPTION 'Supply a reasoned intake disposition, explicit exclusion flags and bounded Part stages';END IF;
 IF (p_data->>'validatedUnknown'='true' OR p_data->>'validatedHistory'='true') AND app.probation_role(e.id,'pbp') IS NOT TRUE THEN RAISE EXCEPTION 'Only the actual scoped PBP may validate missing probation data';END IF;
 source:=app.probation_personnel_source(e.id);
 IF p_data->>'kind'='unfinished' AND app.probation_intake_exclusion(e.id) IS NOT NULL THEN RAISE EXCEPTION 'The canonical or explicitly reviewed source is excluded';END IF;
 IF p_data->>'kind'='unfinished' AND (source->>'explicitNoProbation'='true' OR source->>'confirmationOn' IS NOT NULL OR source->>'resignationOn' IS NOT NULL OR source->>'terminatedOn' IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_each(p_data->'exclusionFlags') f WHERE f.value='true'::jsonb)) THEN RAISE EXCEPTION 'An explicitly excluded employment cannot be admitted';END IF;
 IF p_data->>'kind'='unfinished' THEN
 extensions:=coalesce((p_data->>'extensionCount')::integer,0);IF app.probation_intake_history_valid(source,p_data) IS NOT TRUE THEN RAISE EXCEPTION 'Actual PBP must validate the canonical extension/date-adjustment sources and ordered cycles';END IF;
 SELECT data INTO settings FROM probation_configuration WHERE tenant_id=e.tenant_id AND company_id=e.company_id AND kind='settings' AND state='published' ORDER BY version DESC LIMIT 1;required_parts:=app.probation_intake_required_parts(source,settings,extensions);
 IF jsonb_array_length(p_data->'parts') IS DISTINCT FROM jsonb_array_length(required_parts) OR EXISTS(SELECT 1 FROM jsonb_array_elements(required_parts) required WHERE (SELECT count(*) FROM jsonb_array_elements(p_data->'parts') mapped WHERE mapped->>'type'=required->>'type' AND mapped->>'cycle'=required->>'cycle' AND (required->>'requiresOffline'<>'true' OR mapped->>'status'='completed_offline'))<>1) THEN RAISE EXCEPTION 'Map each canonical Part and cycle once; earlier final reviews need their original completed-offline PDFs';END IF;END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(p_data->'parts') LOOP
 IF part-ARRAY['type','cycle','status','evidenceId']<>'{}' OR coalesce(part->>'type','') NOT IN('1','2','3') OR coalesce(part->>'cycle','')!~'^[0-2]$' OR coalesce(part->>'status','') NOT IN('unfinished','completed_offline') OR part->>'status'='completed_offline' AND NOT EXISTS(SELECT 1 FROM probation_intake_evidence evidence WHERE evidence.id=(part->>'evidenceId')::uuid AND evidence.tenant_id=e.tenant_id AND evidence.employment_id=e.id) OR part->>'status'='unfinished' AND part->>'evidenceId' IS NOT NULL THEN RAISE EXCEPTION 'Completed-offline Parts require original scoped PDF evidence, never invented electronic signatures';END IF;
 END LOOP;
 IF entry.id IS NULL THEN INSERT INTO probation_intake_entry(tenant_id,company_id,employment_id,source_digest,data,reviewed_by) VALUES(e.tenant_id,e.company_id,e.id,p_digest,p_data,app.current_user_id()) RETURNING id INTO v_id;ELSE UPDATE probation_intake_entry SET revision=revision+1,source_digest=p_digest,data=p_data,reviewed_by=app.current_user_id(),reviewed_at=now() WHERE id=entry.id RETURNING id INTO v_id;END IF;
 RETURN v_id;
END $$;
CREATE FUNCTION app.probation_intake_upload(p_employment uuid,p_name text,p_pdf bytea,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO e FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF e.id IS NULL OR NOT(app.probation_role(e.id,'pbp') OR app.probation_role(e.id,'gbs')) OR p_pdf IS NULL OR octet_length(p_pdf) NOT BETWEEN 5 AND 10485760 OR substring(p_pdf FROM 1 FOR 5)<>convert_to('%PDF-','UTF8') OR length(btrim(coalesce(p_reason,'')))<3 OR length(btrim(coalesce(p_name,''))) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Current scoped reviewer and original offline PDF provenance required';END IF;
 INSERT INTO probation_intake_evidence(tenant_id,company_id,employment_id,name,content,content_hash,reason,uploaded_by) VALUES(e.tenant_id,e.company_id,e.id,p_name,p_pdf,encode(sha256(p_pdf),'hex'),p_reason,app.current_user_id()) RETURNING id INTO v_id;RETURN v_id;
END $$;
CREATE FUNCTION app.probation_intake_workspace(p_company uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;entry probation_intake_entry;source jsonb;settings jsonb;issues jsonb;classification text;items jsonb:='[]';count integer:=0;holders jsonb;can_review boolean;stage_options jsonb;extensions integer;option_count integer;proposal uuid;
BEGIN
 IF app.probation_storage_runner() IS NOT TRUE AND app.probation_config_admin(p_company) IS NOT TRUE AND NOT EXISTS(SELECT 1 FROM employment employee WHERE employee.company_id=p_company AND employee.tenant_id=app.current_tenant_id() AND (app.probation_role(employee.id,'pbp') OR app.probation_role(employee.id,'gbs'))) THEN RAISE EXCEPTION 'Scoped intake preparation authority required';END IF;
 SELECT data INTO settings FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='settings' AND state='published' ORDER BY version DESC LIMIT 1;
 FOR e IN SELECT * FROM employment WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND app.probation_intake_exclusion(id) IS NULL AND (app.probation_storage_runner() OR app.probation_config_admin(p_company) OR app.probation_role(id,'pbp') OR app.probation_role(id,'gbs')) ORDER BY employee_code,id LIMIT 501 LOOP
 count:=count+1;IF count>500 THEN EXIT;END IF;source:=app.probation_personnel_source(e.id);SELECT * INTO entry FROM probation_intake_entry WHERE employment_id=e.id AND tenant_id=e.tenant_id AND company_id=e.company_id;proposal:=app.probation_offline_proposal_for_entry(entry.id);issues:='[]';classification:='ready';can_review:=app.probation_role(e.id,'pbp') OR app.probation_role(e.id,'gbs');
 IF EXISTS(SELECT 1 FROM probation_case WHERE employment_id=e.id AND tenant_id=e.tenant_id) THEN classification:='already_admitted';
 ELSIF source->>'explicitNoProbation'='true' OR source->>'confirmationOn' IS NOT NULL OR source->>'resignationOn' IS NOT NULL OR source->>'terminatedOn' IS NOT NULL OR source->>'employmentType' IS NOT NULL AND source->>'employmentType'<>'full_time' OR entry.data->>'kind'='exclude' THEN classification:='excluded';
 ELSE
 IF coalesce(source->>'grade','')='' OR source->>'employmentType' IS NULL THEN issues:=issues||jsonb_build_array('Resolve the canonical start-grade or active employment type before intake.');END IF;
 IF settings IS NULL THEN issues:=issues||jsonb_build_array('Published probation settings are missing.');ELSIF coalesce(source->>'grade','')<>'' AND NOT(settings->'eligibleGrades'?(source->>'grade')) AND NOT(source->>'grade'='H' AND settings->>'gradeHEnabled'='true' AND EXISTS(SELECT 1 FROM probation_configuration form WHERE form.tenant_id=e.tenant_id AND form.company_id=e.company_id AND form.kind='form' AND form.state='published' AND app.probation_is_current_publication('form',form.id) AND form.data->'targetGrades'?'H')) THEN classification:='excluded';END IF;
 IF app.probation_intake_history_valid(source,coalesce(entry.data,'{}')) IS NOT TRUE THEN issues:=issues||jsonb_build_array('The actual PBP must validate the canonical extension or date-adjustment history before import.');END IF;
 IF (source->>'unknownPeriod'='true' OR source->>'eligibilityReviewRequired'='true') AND coalesce(entry.data->>'validatedUnknown','false')<>'true' THEN issues:=issues||jsonb_build_array('The actual PBP must validate missing probation data and any transfer/rehire eligibility history.');END IF;
 IF entry.id IS NULL THEN issues:=issues||jsonb_build_array('A reasoned existing-employee stage mapping has not been reviewed.');ELSIF entry.reviewed_by::text IS DISTINCT FROM source->'holders'->>'pbp' AND app.probation_gbs_user(e.id,entry.reviewed_by) IS NOT TRUE THEN issues:=issues||jsonb_build_array('The accepted intake reviewer no longer holds the required canonical scope.');ELSIF entry.source_digest IS DISTINCT FROM app.probation_intake_digest(e.id) THEN issues:=issues||jsonb_build_array('Personnel or the published intake versions changed after stage review.');END IF;
 IF proposal IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(entry.data->'parts','[]')) part WHERE part->>'type'='3' AND (part->>'cycle')::integer=coalesce((entry.data->>'extensionCount')::integer,0) AND part->>'status'='completed_offline') THEN issues:=issues||jsonb_build_array('The completed offline final decision requires PBP adjudication; do not manufacture electronic signatures or an automatic outcome.');END IF;
 IF source->'holders'->>'employee' IS NULL OR source->'holders'->>'lm' IS NULL OR source->'holders'->>'hod' IS NULL OR source->'holders'->>'pbp' IS NULL THEN issues:=issues||jsonb_build_array('Resolve the current employee, LM, HOD and canonical PBP logins before cutover.');END IF;
 IF classification<>'excluded' AND jsonb_array_length(issues)>0 THEN classification:='held';END IF;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('role',role.key,'name',person.full_name,'userId',u.id) ORDER BY role.key),'[]') INTO holders FROM jsonb_each_text(source->'holders') role JOIN app_user u ON u.id=role.value::uuid AND u.tenant_id=e.tenant_id JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id;
 extensions:=coalesce((entry.data->>'extensionCount')::integer,0);stage_options:='[]';SELECT least(2,count(*))::integer INTO option_count FROM jsonb_array_elements(source->'extensionHistory') event WHERE event->>'kind'<>'date_shift' AND event->>'months' IN('3','6') AND source->>'extendedEndOn' IS NOT NULL;
 SELECT jsonb_agg(jsonb_build_object('extensionCount',choice,'requiredParts',app.probation_intake_required_parts(source,settings,choice)) ORDER BY choice) INTO stage_options FROM generate_series(0,option_count) choice;
 items:=items||jsonb_build_array(jsonb_build_object('source',source,'classification',classification,'issues',issues,'canReview',can_review,'canValidate',app.probation_role(e.id,'pbp'),'requiredParts',app.probation_intake_required_parts(source,settings,extensions),'stageOptions',stage_options,'offlineDecisionReady',proposal IS NOT NULL,'offlineDecision',CASE WHEN can_review THEN app.probation_offline_decision_json(proposal) ELSE NULL END,'holders',holders,'sourceDigest',app.probation_intake_digest(e.id),'disposition',CASE WHEN entry.id IS NULL THEN NULL ELSE entry.data||jsonb_build_object('id',entry.id,'revision',entry.revision,'sourceDigest',entry.source_digest) END,'evidence',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'reason',f.reason,'createdAt',f.created_at) ORDER BY f.created_at,f.id),'[]') FROM probation_intake_evidence f WHERE f.tenant_id=e.tenant_id AND f.employment_id=e.id)));
 END LOOP;
 RETURN jsonb_build_object('candidates',items,'truncated',count>500,'excludedCount',(SELECT count(*) FROM employment all_employment WHERE all_employment.tenant_id=app.current_tenant_id() AND all_employment.company_id=p_company AND app.probation_intake_exclusion(all_employment.id) IS NOT NULL AND (app.probation_storage_runner() OR app.probation_config_admin(p_company) OR app.probation_role(all_employment.id,'pbp') OR app.probation_role(all_employment.id,'gbs'))));
END $$;
REVOKE ALL ON FUNCTION app.probation_intake_digest(uuid),app.probation_intake_save(uuid,integer,text,jsonb),app.probation_intake_upload(uuid,text,bytea,text),app.probation_intake_workspace(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_intake_save(uuid,integer,text,jsonb),app.probation_intake_upload(uuid,text,bytea,text),app.probation_intake_workspace(uuid) TO ai_hr_app;
CREATE FUNCTION app.probation_prepare_cutover_plan(p_company uuid,p_plan jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fingerprint text;v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 IF app.probation_config_admin(p_company) IS NOT TRUE OR p_plan->>'companyId' IS DISTINCT FROM p_company::text OR p_plan->>'module' IS DISTINCT FROM 'probation' OR p_plan->>'activationOn' IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text OR p_plan->'sourceSnapshot' IS DISTINCT FROM app.probation_cutover_snapshot(p_company) OR p_plan->>'sends' IS DISTINCT FROM 'false' OR p_plan->'noCatchup'->>'pastDatesExcluded' IS DISTINCT FROM 'true' OR p_plan->'noCatchup'->>'requiresNamedOwnerApproval' IS DISTINCT FROM 'true' OR jsonb_typeof(p_plan->'wouldFire') IS DISTINCT FROM 'array' OR jsonb_typeof(p_plan->'excludedPast') IS DISTINCT FROM 'array' OR jsonb_typeof(p_plan->'holds') IS DISTINCT FROM 'array' OR jsonb_typeof(p_plan->'imports') IS DISTINCT FROM 'array' OR jsonb_array_length(p_plan->'imports')>500 THEN RAISE EXCEPTION 'Prepare the complete current-source no-catch-up rehearsal before approval';END IF;
 fingerprint:=encode(sha256(convert_to(p_plan::text,'UTF8')),'hex');INSERT INTO probation_cutover(tenant_id,company_id,data,digest,actor_user_id) VALUES(app.current_tenant_id(),p_company,p_plan,fingerprint,app.current_user_id()) RETURNING id INTO v_id;RETURN jsonb_build_object('id',v_id,'digest',fingerprint,'snapshot',p_plan,'sends',false);
END $$;
REVOKE ALL ON FUNCTION app.probation_prepare_cutover_plan(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_prepare_cutover_plan(uuid,jsonb) TO ai_hr_app;
CREATE FUNCTION app.probation_gbs_user(p_employment uuid,p_user uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope jsonb:=app.probation_holders(p_employment); day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 RETURN EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.id=p_user AND u.tenant_id=e.tenant_id
  JOIN probation_access a ON a.user_id=u.id AND a.tenant_id=e.tenant_id
  WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND app.probation_company_entitled(e.company_id) AND app.lifecycle_canonical_people_ops_member(e.company_id,u.id)
   AND a.role='gbs' AND app.is_company_descendant(e.company_id,a.company_id)
   AND (a.department_id IS NULL OR a.department_id::text=scope->>'departmentId')
   AND (a.business_unit_id IS NULL OR a.business_unit_id::text=scope->>'businessUnitId')
   AND a.valid_from<=day AND (a.valid_to IS NULL OR a.valid_to>=day));
END $$;
CREATE FUNCTION app.probation_queue_date_shift(p_request uuid,p_case uuid,p_expected integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r probation_date_adjustment;c probation_case;e employment;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO r FROM probation_date_adjustment WHERE id=p_request AND case_id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=r.case_id AND tenant_id=r.tenant_id FOR UPDATE;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id;
 IF r.id IS NULL OR app.probation_role(e.id,'gbs') IS NOT TRUE THEN RAISE EXCEPTION 'Current canonical scoped GBS approval required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF r.applied_at IS NOT NULL THEN RETURN jsonb_build_object('alreadyApplied',true,'queued',false);END IF;
 IF c.revision IS DISTINCT FROM p_expected OR r.expected_revision IS DISTINCT FROM c.revision OR r.old_end IS DISTINCT FROM coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on) OR e.confirmation_date IS NOT NULL OR e.resignation_date IS NOT NULL OR e.terminated_on IS NOT NULL OR app.probation_holders(e.id)->>'pbp' IS DISTINCT FROM r.requested_by::text THEN RAISE EXCEPTION 'The Personnel source, PBP authority or expected revision changed';END IF;
 IF r.superseded_at IS NOT NULL THEN RAISE EXCEPTION 'This date request was superseded';END IF;
 IF r.gbs_approved_by IS NOT NULL THEN
  IF r.gbs_approved_by IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'The original GBS approval is immutable';END IF;
  IF r.failure IS NULL THEN RETURN jsonb_build_object('alreadyApplied',false,'queued',true,'requestId',r.id);END IF;
 END IF;
 UPDATE probation_date_adjustment SET gbs_approved_by=coalesce(gbs_approved_by,app.current_user_id()),gbs_approved_at=coalesce(gbs_approved_at,now()),failure=NULL WHERE id=r.id;PERFORM app.probation_audit(c.id,NULL,'date_shift_gbs_approved',r.reason);RETURN jsonb_build_object('alreadyApplied',false,'queued',true,'requestId',r.id);
END $$;
REVOKE ALL ON FUNCTION app.probation_gbs_user(uuid,uuid),app.probation_queue_date_shift(uuid,uuid,integer) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_queue_date_shift(uuid,uuid,integer) TO ai_hr_app;
-- Canonical Personnel/offboarding capabilities belong only to the real owner effect executor.
REVOKE ALL ON FUNCTION app.probation_personnel_intent(uuid),app.probation_offboarding_intent(uuid),app.probation_offboarding_sequence(uuid),app.probation_record_effect(uuid,text,uuid,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_request_outcome_retry(p_outcome uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF o.id IS NULL OR app.probation_role(c.employment_id,'gbs') IS NOT TRUE THEN RAISE EXCEPTION 'Current scoped GBS outcome retry authority required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF o.state='completed' THEN RETURN jsonb_build_object('completed',true,'queued',false);END IF;
 IF o.released_at IS NULL OR NOT EXISTS(SELECT 1 FROM probation_file f WHERE f.id=o.letter_file_id AND f.tenant_id=o.tenant_id AND f.employee_document_id IS NOT NULL) THEN RAISE EXCEPTION 'A released owner-rendered and filed letter is required before an outcome retry';END IF;
 UPDATE probation_outcome SET failure='Approved GBS retry is queued for the canonical owner executor.',updated_at=now() WHERE id=o.id;PERFORM app.probation_audit(c.id,o.part_id,'outcome_retry_requested');RETURN jsonb_build_object('completed',false,'queued',true);
END $$;
REVOKE ALL ON FUNCTION app.probation_request_outcome_retry(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_request_outcome_retry(uuid) TO ai_hr_app;

REVOKE ALL ON FUNCTION app.probation_admit(jsonb,jsonb,uuid,uuid,uuid,text) FROM PUBLIC,ai_hr_app;
ALTER TABLE probation_cutover ADD COLUMN owner_receipt jsonb;
CREATE TABLE probation_activation_summary(
 tenant_id uuid NOT NULL REFERENCES tenant(id),batch_id uuid NOT NULL REFERENCES probation_cutover(id),pbp_user_id uuid NOT NULL REFERENCES app_user(id),case_ids jsonb NOT NULL,occurrence_id uuid NOT NULL REFERENCES probation_occurrence(id),PRIMARY KEY(batch_id,pbp_user_id)
);
ALTER TABLE probation_activation_summary ENABLE ROW LEVEL SECURITY;ALTER TABLE probation_activation_summary FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_owner ON probation_activation_summary FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON probation_activation_summary FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_apply_intake_stage(p_batch uuid,p_entry uuid,p_case uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE batch probation_cutover;entry probation_intake_entry;c probation_case;stage jsonb;part probation_part;evidence probation_intake_evidence;file_receipt uuid;proposal uuid;
BEGIN
 PERFORM app.probation_write_lock();IF app.probation_storage_runner() IS NOT TRUE THEN RAISE EXCEPTION 'Actual owner import executor required';END IF;
 SELECT * INTO batch FROM probation_cutover WHERE id=p_batch AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO entry FROM probation_intake_entry WHERE id=p_entry AND tenant_id=batch.tenant_id FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=batch.tenant_id FOR UPDATE;
 IF batch.applied_at IS NULL OR batch.approved_by IS NULL OR entry.employment_id IS DISTINCT FROM c.employment_id OR (entry.reviewed_by::text IS DISTINCT FROM app.probation_holders(c.employment_id)->>'pbp' AND app.probation_gbs_user(c.employment_id,entry.reviewed_by) IS NOT TRUE) OR entry.source_digest IS DISTINCT FROM app.probation_intake_digest(c.employment_id) OR c.data->>'cutoverBatchId' IS DISTINCT FROM batch.id::text OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(batch.data->'imports') imported WHERE imported->>'entryId'=entry.id::text AND imported->>'entryRevision'=entry.revision::text AND imported->>'sourceDigest'=entry.source_digest AND imported->'record'->>'id'=c.id::text) THEN RAISE EXCEPTION 'The exact reviewed source/stage import descriptor is required';END IF;
 FOR stage IN SELECT value FROM jsonb_array_elements(entry.data->'parts') ORDER BY (value->>'type')::integer LOOP
 SELECT * INTO part FROM probation_part WHERE case_id=c.id AND tenant_id=c.tenant_id AND data->>'type'=stage->>'type' AND data->>'cycle'=stage->>'cycle' FOR UPDATE;
 IF part.id IS NULL THEN RAISE EXCEPTION 'The staged Part is missing from the canonical plan';END IF;
 IF stage->>'status'='completed_offline' THEN
 SELECT * INTO evidence FROM probation_intake_evidence WHERE id=(stage->>'evidenceId')::uuid AND employment_id=c.employment_id AND tenant_id=c.tenant_id;
 IF evidence.id IS NULL OR evidence.content_hash IS DISTINCT FROM encode(sha256(evidence.content),'hex') THEN RAISE EXCEPTION 'The original offline evidence changed';END IF;
 file_receipt:=app.probation_file_save(c.id,part.id,'offline',evidence.name,evidence.content,part.revision,entry.data->>'reason');UPDATE probation_part SET data=data||jsonb_build_object('offlineIntakeEntryId',entry.id,'offlineAcceptedBy',entry.reviewed_by,'offlineUploadedBy',evidence.uploaded_by) WHERE id=part.id;
 IF part.data->>'type'='3' AND part.data->>'cycle'=c.data->>'extensionCount' THEN proposal:=app.probation_offline_proposal_for_entry(entry.id);IF proposal IS NULL THEN RAISE EXCEPTION 'Current PBP-attested original final decision required';END IF;UPDATE probation_offline_final_proposal SET case_id=c.id,part_id=part.id,file_id=file_receipt WHERE id=proposal AND tenant_id=c.tenant_id;END IF;
 ELSIF (part.data->>'issueOn')::date<=(batch.data->>'activationOn')::date THEN PERFORM app.probation_issue(part.id,(batch.data->>'activationOn')::date);END IF;
 END LOOP;
 IF (c.data->>'extensionCount')::integer>0 THEN UPDATE probation_case SET data=jsonb_set(data,'{state}','"extended"') WHERE id=c.id;END IF;
 UPDATE probation_intake_entry SET applied_case_id=c.id WHERE id=entry.id;PERFORM app.probation_audit(c.id,NULL,'reviewed_cutover_stage_imported',entry.data->>'reason');
END $$;
CREATE FUNCTION app.probation_finalize_cutover(p_batch uuid,p_receipt jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE batch probation_cutover;grouped record;context_case probation_case;workflow probation_builder_definition;step jsonb;occurrence uuid;summary_count integer:=0;
BEGIN
 PERFORM app.probation_write_lock();IF app.probation_storage_runner() IS NOT TRUE THEN RAISE EXCEPTION 'Actual owner cutover executor required';END IF;SELECT * INTO batch FROM probation_cutover WHERE id=p_batch AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF batch.applied_at IS NULL OR batch.approved_by IS NULL OR p_receipt->>'origin' IS DISTINCT FROM batch.data->'environment'->>'configuredOrigin' OR length(btrim(coalesce(p_receipt->>'reference','')))<3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(batch.data->'imports') imported WHERE NOT EXISTS(SELECT 1 FROM probation_intake_entry entry WHERE entry.id=(imported->>'entryId')::uuid AND entry.tenant_id=batch.tenant_id AND entry.applied_case_id=(imported->'record'->>'id')::uuid)) THEN RAISE EXCEPTION 'Every exact reviewed cohort import and installation receipt must finish atomically';END IF;
 FOR grouped IN SELECT app.probation_holders(c.employment_id)->>'pbp' as pbp,min(c.id::text)::uuid as context_id,jsonb_agg(c.id ORDER BY c.id) as ids FROM probation_case c WHERE c.tenant_id=batch.tenant_id AND (c.data->>'cutoverBatchId'=batch.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(batch.data->'reactivation','[]')) preserved WHERE preserved->>'id'=c.id::text AND preserved->>'status'='preserved')) AND c.data->>'state' NOT IN('withdrawn','confirmed','not_confirmed') AND EXISTS(SELECT 1 FROM probation_part p WHERE p.case_id=c.id AND p.tenant_id=c.tenant_id AND p.data->>'state' NOT IN('locked','completed_offline','cancelled') AND (p.data->>'dueOn')::date<(batch.data->>'activationOn')::date) GROUP BY app.probation_holders(c.employment_id)->>'pbp' LOOP
 IF grouped.pbp IS NULL OR EXISTS(SELECT 1 FROM probation_activation_summary WHERE batch_id=batch.id AND pbp_user_id=grouped.pbp::uuid) THEN CONTINUE;END IF;SELECT * INTO context_case FROM probation_case WHERE id=grouped.context_id AND tenant_id=batch.tenant_id;
 SELECT * INTO workflow FROM probation_builder_definition WHERE tenant_id=batch.tenant_id AND company_id=batch.company_id AND kind='workflow' AND state='published' AND app.probation_is_current_publication('workflow',id) AND data->'trigger'->>'event'='overdue_summary' AND coalesce(data->'conditions','{}')='{}' ORDER BY version DESC,id LIMIT 1;
 SELECT value INTO step FROM jsonb_array_elements(workflow.data->'steps') WHERE value->'to'?'pbp' ORDER BY value->>'id' LIMIT 1;
 IF workflow.id IS NULL OR step IS NULL THEN RAISE EXCEPTION 'Publish the reviewed global PBP overdue-summary message before activation';END IF;
 occurrence:=app.probation_enqueue(context_case.id,NULL,'overdue_summary',(batch.data->>'activationOn')::date,'["pbp"]','probation-cutover-summary:'||batch.id::text||':'||grouped.pbp,context_case.revision);
 UPDATE probation_occurrence SET workflow_id=workflow.id,workflow_step_id=step->>'id' WHERE id=occurrence;INSERT INTO probation_activation_summary(tenant_id,batch_id,pbp_user_id,case_ids,occurrence_id) VALUES(batch.tenant_id,batch.id,grouped.pbp::uuid,grouped.ids,occurrence);summary_count:=summary_count+1;
 END LOOP;
 UPDATE probation_cutover SET owner_receipt=p_receipt||jsonb_build_object('executedAt',now(),'databaseExecutor',session_user,'imported',(SELECT count(*) FROM jsonb_array_elements(batch.data->'imports')),'summaryCount',summary_count) WHERE id=batch.id;
 RETURN jsonb_build_object('batchId',batch.id,'imported',(SELECT count(*) FROM jsonb_array_elements(batch.data->'imports')),'summaryCount',summary_count,'activationOn',batch.data->>'activationOn');
END $$;
REVOKE ALL ON FUNCTION app.probation_apply_intake_stage(uuid,uuid,uuid),app.probation_finalize_cutover(uuid,jsonb) FROM PUBLIC,ai_hr_app;
-- Pausing/expiry does not revive the replaced legacy owner. Only a separately reviewed reconciliation can.
CREATE TABLE probation_legacy_reconciliation(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES probation_case(id),source_digest text NOT NULL,reason text NOT NULL,requested_by uuid NOT NULL REFERENCES app_user(id),requested_at timestamptz NOT NULL DEFAULT now(),gbs_approved_by uuid REFERENCES app_user(id),gbs_approved_at timestamptz,applied_at timestamptz,UNIQUE(case_id,source_digest)
);
ALTER TABLE probation_legacy_reconciliation ENABLE ROW LEVEL SECURITY;ALTER TABLE probation_legacy_reconciliation FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_owner ON probation_legacy_reconciliation FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON probation_legacy_reconciliation FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.probation_owns_legacy(p_employment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM probation_case c WHERE c.employment_id=p_employment AND c.tenant_id=app.current_tenant_id() AND (NOT app.probation_case_company_current(c.id) OR NOT EXISTS(SELECT 1 FROM probation_legacy_reconciliation receipt WHERE receipt.case_id=c.id AND receipt.tenant_id=c.tenant_id AND receipt.applied_at IS NOT NULL)));
$$;
CREATE FUNCTION app.probation_legacy_review_owned(p_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM employment_review review WHERE review.id=p_review AND review.tenant_id=app.current_tenant_id() AND review.review_type='probation' AND app.probation_owns_legacy(review.employment_id));
$$;
REVOKE ALL ON FUNCTION app.probation_legacy_review_owned(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_legacy_review_owned(uuid) TO ai_hr_app;
CREATE FUNCTION app.probation_legacy_reconcile_digest(p_case uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('record',c.data,'revision',c.revision,'personnel',app.probation_personnel_source(c.employment_id),'parts',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'revision',p.revision,'contentRevision',p.content_revision) ORDER BY p.id),'[]') FROM probation_part p WHERE p.case_id=c.id AND p.tenant_id=c.tenant_id),'documents',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'revision',d.revision) ORDER BY d.id),'[]') FROM document_signing_document d JOIN probation_part p ON p.id=d.subject_id AND p.tenant_id=d.tenant_id WHERE d.subject_type='probation' AND p.case_id=c.id AND d.tenant_id=c.tenant_id),'legacyReviews',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',legacy.id,'status',legacy.status,'endOn',legacy.end_date,'dueOn',legacy.due_date) ORDER BY legacy.id),'[]') FROM employment_review legacy WHERE legacy.tenant_id=c.tenant_id AND legacy.employment_id=c.employment_id AND legacy.review_type='probation'),'outcomes',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'state',o.state,'released',o.released_at,'movement',o.movement_ref,'handoff',o.handoff_ref) ORDER BY o.id),'[]') FROM probation_outcome o WHERE o.case_id=c.id AND o.tenant_id=c.tenant_id))::text,'UTF8')),'hex') FROM probation_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id();
$$;
CREATE FUNCTION app.probation_legacy_resume_source_current(p_case uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM probation_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id
  WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND app.probation_case_company_current(c.id)
   AND e.confirmation_date IS NULL AND e.resignation_date IS NULL AND e.terminated_on IS NULL
   AND NOT EXISTS(SELECT 1 FROM employment_review legacy WHERE legacy.tenant_id=c.tenant_id AND legacy.employment_id=e.id
    AND legacy.review_type='probation' AND legacy.status IN('pending_manager','pending_hr')
    AND legacy.end_date IS DISTINCT FROM coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.probation_end_date,e.provisional_end_on)));
END $$;
REVOKE ALL ON FUNCTION app.probation_legacy_resume_source_current(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_request_legacy_reconciliation(p_case uuid,p_expected integer,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;digest text;v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR app.probation_legacy_resume_source_current(c.id) IS NOT TRUE OR app.probation_role(c.employment_id,'pbp') IS NOT TRUE OR c.revision IS DISTINCT FROM p_expected OR length(btrim(coalesce(p_reason,'')))<3 OR EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) OR EXISTS(SELECT 1 FROM probation_outcome WHERE case_id=c.id AND tenant_id=c.tenant_id AND (released_at IS NOT NULL OR movement_ref IS NOT NULL OR handoff_ref IS NOT NULL)) OR EXISTS(SELECT 1 FROM employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND (e.confirmation_date IS NOT NULL OR e.resignation_date IS NOT NULL OR e.terminated_on IS NOT NULL)) THEN RAISE EXCEPTION 'Paused, unaffected cohort and actual scoped PBP reconciliation required; delivered decisions cannot be reversed by a switch';END IF;
 digest:=app.probation_legacy_reconcile_digest(c.id);
 SELECT receipt.id INTO v_id FROM probation_legacy_reconciliation receipt WHERE receipt.tenant_id=c.tenant_id AND receipt.case_id=c.id AND receipt.source_digest=digest;
 IF v_id IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM probation_legacy_reconciliation receipt WHERE receipt.id=v_id AND receipt.requested_by=app.current_user_id() AND receipt.reason=p_reason AND receipt.applied_at IS NULL) THEN RETURN v_id;END IF;
  RAISE EXCEPTION 'The exact source already has a preserved reconciliation request';
 END IF;
 INSERT INTO probation_legacy_reconciliation(tenant_id,case_id,source_digest,reason,requested_by) VALUES(c.tenant_id,c.id,digest,p_reason,app.current_user_id()) RETURNING id INTO v_id;
 PERFORM app.probation_audit(c.id,NULL,'legacy_reconciliation_requested',p_reason);RETURN v_id;
END $$;
CREATE FUNCTION app.probation_approve_legacy_reconciliation(p_id uuid,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt probation_legacy_reconciliation;c probation_case;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO receipt FROM probation_legacy_reconciliation WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=receipt.case_id AND tenant_id=receipt.tenant_id;
 IF receipt.id IS NULL OR app.probation_legacy_resume_source_current(c.id) IS NOT TRUE OR app.probation_role(c.employment_id,'gbs') IS NOT TRUE OR length(btrim(coalesce(p_reason,'')))<3 OR receipt.applied_at IS NOT NULL OR receipt.source_digest IS DISTINCT FROM app.probation_legacy_reconcile_digest(c.id) OR app.probation_holders(c.employment_id)->>'pbp' IS DISTINCT FROM receipt.requested_by::text OR EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) THEN RAISE EXCEPTION 'Actual GBS and unchanged paused PBP reconciliation required';END IF;
 IF receipt.gbs_approved_at IS NOT NULL THEN
  IF receipt.gbs_approved_by=app.current_user_id() AND receipt.approved_reason=p_reason THEN RETURN;END IF;
  RAISE EXCEPTION 'The original named GBS approval is immutable';
 END IF;
 UPDATE probation_legacy_reconciliation SET gbs_approved_by=app.current_user_id(),gbs_approved_at=now(),approved_reason=p_reason WHERE id=receipt.id;PERFORM app.probation_audit(c.id,NULL,'legacy_reconciliation_gbs_approved',p_reason);
END $$;
CREATE FUNCTION app.probation_apply_legacy_reconciliation(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt probation_legacy_reconciliation;c probation_case;
BEGIN
 PERFORM app.probation_write_lock();IF app.probation_storage_runner() IS NOT TRUE THEN RAISE EXCEPTION 'Verified owner reconciliation executor required';END IF;SELECT * INTO receipt FROM probation_legacy_reconciliation WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=receipt.case_id AND tenant_id=receipt.tenant_id;
 IF receipt.applied_at IS NOT NULL THEN RETURN;END IF;
 IF receipt.id IS NULL OR app.probation_legacy_resume_source_current(c.id) IS NOT TRUE OR receipt.gbs_approved_at IS NULL OR receipt.source_digest IS DISTINCT FROM app.probation_legacy_reconcile_digest(c.id) OR app.probation_gbs_user(c.employment_id,receipt.gbs_approved_by) IS NOT TRUE OR app.probation_holders(c.employment_id)->>'pbp' IS DISTINCT FROM receipt.requested_by::text OR EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) OR EXISTS(SELECT 1 FROM probation_outcome WHERE case_id=c.id AND tenant_id=c.tenant_id AND (released_at IS NOT NULL OR movement_ref IS NOT NULL OR handoff_ref IS NOT NULL)) THEN RAISE EXCEPTION 'Fresh named unchanged unaffected-cohort reconciliation required';END IF;
 UPDATE probation_legacy_reconciliation SET applied_at=coalesce(applied_at,now()) WHERE id=receipt.id;PERFORM app.probation_audit(c.id,NULL,'legacy_reconciliation_applied',receipt.reason);
END $$;
REVOKE ALL ON FUNCTION app.probation_legacy_reconcile_digest(uuid),app.probation_request_legacy_reconciliation(uuid,integer,text),app.probation_approve_legacy_reconciliation(uuid,text),app.probation_apply_legacy_reconciliation(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_request_legacy_reconciliation(uuid,integer,text),app.probation_approve_legacy_reconciliation(uuid,text) TO ai_hr_app;
CREATE FUNCTION app.probation_intake_exclusion(p_employment uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;employment_kind text;grade_code text;settings jsonb;original_grade uuid;
BEGIN
 SELECT * INTO e FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN 'unavailable';END IF;
 IF EXISTS(SELECT 1 FROM probation_intake_entry prior WHERE prior.employment_id=e.id AND prior.tenant_id=e.tenant_id AND prior.company_id<>e.company_id) THEN RETURN 'company_transfer';END IF;
 IF e.confirmation_date IS NOT NULL THEN RETURN 'confirmed';END IF;IF e.resignation_date IS NOT NULL THEN RETURN 'resignation';END IF;IF e.terminated_on IS NOT NULL THEN RETURN 'ended';END IF;
 IF coalesce(e.probation_value,-1)=0 OR coalesce(e.probation_months,-1)=0 THEN RETURN 'no_probation';END IF;
 IF EXISTS(SELECT 1 FROM probation_intake_entry entry WHERE entry.tenant_id=e.tenant_id AND entry.employment_id=e.id AND (entry.data->>'kind'='exclude' OR EXISTS(SELECT 1 FROM jsonb_each(entry.data->'exclusionFlags') flag WHERE flag.value='true'::jsonb))) THEN RETURN 'reviewed_exclusion';END IF;
 SELECT employment_type INTO employment_kind FROM assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND superseded_at IS NULL AND valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (valid_to IS NULL OR valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY valid_from DESC,id LIMIT 1;
 IF employment_kind IS NOT NULL AND employment_kind<>'full_time' THEN RETURN 'employment_type';END IF;
 SELECT (payload->>'gradeId')::uuid INTO original_grade FROM domain_event WHERE tenant_id=e.tenant_id AND subject_employment_id=e.id AND event_type='employment.hired' AND payload->>'gradeId' IS NOT NULL ORDER BY sequence LIMIT 1;
 SELECT regexp_replace(upper(code),'^(JG|GRADE)[ -]*','','g') INTO grade_code FROM job_grade WHERE id=coalesce(original_grade,e.grade_id) AND tenant_id=e.tenant_id;
 SELECT data INTO settings FROM probation_configuration WHERE tenant_id=e.tenant_id AND company_id=e.company_id AND kind='settings' AND state='published' ORDER BY version DESC LIMIT 1;
 IF settings IS NOT NULL AND coalesce(grade_code,'')<>'' AND NOT(settings->'eligibleGrades'?grade_code) AND NOT(grade_code='H' AND settings->>'gradeHEnabled'='true' AND EXISTS(SELECT 1 FROM probation_configuration form WHERE form.tenant_id=e.tenant_id AND form.company_id=e.company_id AND form.kind='form' AND form.state='published' AND app.probation_is_current_publication('form',form.id) AND form.data->'targetGrades'?'H')) THEN RETURN 'grade_not_enabled';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.probation_intake_exclusion(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_intake_evidence_read(p_employment uuid,p_evidence uuid) RETURNS TABLE(name text,content bytea) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source employment;evidence probation_intake_evidence;
BEGIN
 SELECT * INTO source FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF source.id IS NULL OR NOT(app.probation_role(source.id,'pbp') OR app.probation_role(source.id,'gbs')) THEN RAISE EXCEPTION 'Current actual scoped intake reviewer authority required';END IF;
 SELECT * INTO evidence FROM probation_intake_evidence WHERE id=p_evidence AND employment_id=source.id AND tenant_id=source.tenant_id AND company_id=source.company_id;
 IF evidence.id IS NULL OR evidence.content_hash IS DISTINCT FROM encode(sha256(evidence.content),'hex') THEN RAISE EXCEPTION 'Original scoped intake evidence is unavailable or changed';END IF;name:=evidence.name;content:=evidence.content;RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION app.probation_intake_evidence_read(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_intake_evidence_read(uuid,uuid) TO ai_hr_app;
CREATE FUNCTION app.probation_intake_eligibility_review(p_employment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND (e.join_date IS DISTINCT FROM e.hired_on AND e.join_date IS NOT NULL OR EXISTS(SELECT 1 FROM employment earlier WHERE earlier.tenant_id=e.tenant_id AND earlier.person_id=e.person_id AND earlier.id<>e.id AND least(earlier.terminated_on,earlier.resignation_date,earlier.last_working_date)<coalesce(e.join_date,e.hired_on))));
$$;
REVOKE ALL ON FUNCTION app.probation_intake_eligibility_review(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_intake_companies() RETURNS TABLE(id uuid,name text,"canPrepare" boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co.id,co.legal_name,app.probation_config_admin(co.id) FROM company co WHERE co.tenant_id=app.current_tenant_id() AND co.archived_at IS NULL AND app.probation_active_user() AND app.probation_company_entitled(co.id) AND (app.probation_config_admin(co.id) OR CASE WHEN EXISTS(SELECT 1 FROM probation_access opted WHERE opted.tenant_id=co.tenant_id AND opted.user_id=app.current_user_id() AND opted.role IN('pbp','gbs') AND app.is_company_descendant(co.id,opted.company_id) AND opted.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (opted.valid_to IS NULL OR opted.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN EXISTS(SELECT 1 FROM employment employee WHERE employee.tenant_id=co.tenant_id AND employee.company_id=co.id AND (app.probation_role(employee.id,'pbp') OR app.probation_role(employee.id,'gbs'))) ELSE false END) ORDER BY co.legal_name,co.id;
$$;
REVOKE ALL ON FUNCTION app.probation_intake_companies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_intake_companies() TO ai_hr_app;
CREATE FUNCTION app.probation_signing_action_allowed(p_subject uuid,p_action jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;step jsonb;draft jsonb;form jsonb;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;SELECT * INTO d FROM document_signing_document WHERE subject_id=p.id AND subject_type='probation' AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR d.id IS NULL OR app.probation_active_user() IS NOT TRUE OR app.probation_case_access(c.id) IS NOT TRUE THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') returned WHERE returned->>'action'='returned' AND returned->>'contentRevision'=d.data->>'contentRevision' AND returned->>'contentHash'=d.data->>'contentHash') THEN RETURN false;END IF;
 SELECT value INTO step FROM jsonb_array_elements(d.data->'route'->'steps') WHERE value->>'id'=p_action->>'stepId';IF step IS NULL THEN RETURN false;END IF;
 IF p.data->>'documentKind'='letter' OR p_action->>'action'<>'signed' OR step->>'role'<>'employee' THEN RETURN true;END IF;
 SELECT data INTO draft FROM probation_rater_draft WHERE part_id=p.id AND tenant_id=p.tenant_id AND rater='employee';SELECT data INTO form FROM probation_configuration WHERE id=c.form_id AND tenant_id=c.tenant_id;
 RETURN coalesce(p_action->>'comment','')=coalesce(draft->>'employeeComments','') AND (p.data->>'type'='1' OR form->>'employeeCommentsRequired' IS DISTINCT FROM 'true' OR length(btrim(coalesce(draft->>'employeeComments','')))>0);
END $$;
REVOKE ALL ON FUNCTION app.probation_signing_action_allowed(uuid,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_historical_date(p_value text) RETURNS date
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_value !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN NULL;END IF;
 RETURN p_value::date;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.probation_historical_date(text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_extension_length(p_old date,p_new date) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_new=(p_old+1+interval '3 months'-interval '1 day')::date THEN 3 WHEN p_new=(p_old+1+interval '6 months'-interval '1 day')::date THEN 6 ELSE NULL END;
$$;
CREATE FUNCTION app.probation_intake_extension_history(p_employment uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;events jsonb;original_end date;months integer;
BEGIN
 SELECT * INTO e FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN '[]';END IF;original_end:=coalesce(e.probation_end_date,e.provisional_end_on);
 WITH recorded AS(SELECT ev.id,ev.sequence,ev.occurred_at as recorded_at,app.probation_historical_date(coalesce(ev.payload->'before'->>'finalConfirmationDate',ev.payload->'before'->>'extendedConfirmationDate',ev.payload->'before'->>'confirmationDate',ev.payload->'before'->>'probationEndDate',ev.payload->'before'->>'provisionalEndOn')) as old_end,app.probation_historical_date(ev.payload->'after'->>'extendedConfirmationDate') as new_end,CASE WHEN ev.payload->'movement'->>'remarks' LIKE 'probation-date-shift:%' THEN 'date_shift' WHEN ev.payload->'movement'->>'type'='probationExtension' THEN 'probation_extension' ELSE 'unclassified' END as kind FROM domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.aggregate_id=e.id AND ev.subject_employment_id=e.id AND ev.event_type='employment.info.updated' AND app.probation_historical_date(ev.payload->'after'->>'extendedConfirmationDate') IS NOT NULL AND ev.payload->'after'->>'extendedConfirmationDate' IS DISTINCT FROM ev.payload->'before'->>'extendedConfirmationDate') SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'oldEndOn',old_end,'newEndOn',new_end,'months',app.probation_extension_length(old_end,new_end),'recordedAt',recorded_at) ORDER BY sequence),'[]') INTO events FROM recorded;
 IF events='[]'::jsonb AND e.extended_confirmation_date IS NOT NULL AND original_end IS NOT NULL THEN months:=app.probation_extension_length(original_end,e.extended_confirmation_date);IF months IS NOT NULL THEN events:=jsonb_build_array(jsonb_build_object('id','current:'||e.id::text,'kind','current_source','oldEndOn',original_end,'newEndOn',e.extended_confirmation_date,'months',months,'recordedAt',NULL));END IF;END IF;
 RETURN events;
END $$;
CREATE FUNCTION app.probation_intake_required_parts(p_source jsonb,p_settings jsonb,p_extensions integer) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb:='[{"type":1,"cycle":0,"requiresOffline":false}]';months integer;midpoint integer;cycle integer;base_end date;
BEGIN
 base_end:=coalesce((p_source->>'originalEndOn')::date,(p_source->>'endOn')::date);months:=(p_source->>'probationMonths')::integer;
 IF months IS NULL AND base_end IS NOT NULL THEN SELECT n INTO months FROM generate_series(1,120) n WHERE ((p_source->>'startOn')::date+(n::text||' months')::interval-interval '1 day')::date=base_end LIMIT 1;END IF;
 IF months IS NULL AND p_source->>'unknownPeriod'='true' THEN months:=CASE WHEN p_source->>'grade'='H' THEN 3 ELSE (p_settings->>'defaultMonths')::integer END;END IF;
 SELECT (rule->>'midpointMonths')::integer INTO midpoint FROM jsonb_array_elements(coalesce(p_settings->'plans','[]')) rule WHERE (rule->>'months')::integer=months LIMIT 1;
 IF midpoint IS NOT NULL AND (base_end IS NULL OR ((p_source->>'startOn')::date+(midpoint::text||' months')::interval)::date<base_end) THEN result:=result||jsonb_build_array(jsonb_build_object('type',2,'cycle',0,'requiresOffline',false));END IF;
 FOR cycle IN 0..p_extensions LOOP result:=result||jsonb_build_array(jsonb_build_object('type',3,'cycle',cycle,'requiresOffline',cycle<p_extensions));END LOOP;RETURN result;
END $$;
CREATE FUNCTION app.probation_intake_history_valid(p_source jsonb,p_entry jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE chosen jsonb:=coalesce(p_entry->'extensionEventIds','[]');extensions integer:=coalesce((p_entry->>'extensionCount')::integer,0);event jsonb;last_end date;selected integer:=0;event_end date;
BEGIN
 IF extensions NOT BETWEEN 0 AND 2 OR jsonb_typeof(chosen) IS DISTINCT FROM 'array' OR jsonb_array_length(chosen) IS DISTINCT FROM extensions OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(chosen))<>extensions OR p_source->>'extendedEndOn' IS NULL AND extensions>0 OR p_source->>'extendedEndOn' IS NOT NULL AND p_entry->>'validatedHistory' IS DISTINCT FROM 'true' THEN RETURN false;END IF;
 FOR event IN SELECT value FROM jsonb_array_elements(coalesce(p_source->'extensionHistory','[]')) LOOP
 IF NOT(chosen?(event->>'id')) THEN CONTINUE;END IF;event_end:=(event->>'oldEndOn')::date;
 IF event->>'kind'='date_shift' OR coalesce(event->>'months','') NOT IN('3','6') OR event_end IS NULL OR event_end<(p_source->>'startOn')::date OR last_end IS NOT NULL AND event_end<=last_end THEN RETURN false;END IF;last_end:=event_end;selected:=selected+1;
 END LOOP;
 RETURN selected=extensions AND (last_end IS NULL OR (p_source->>'endOn')::date>last_end);
END $$;
REVOKE ALL ON FUNCTION app.probation_extension_length(date,date),app.probation_intake_extension_history(uuid),app.probation_intake_required_parts(jsonb,jsonb,integer),app.probation_intake_history_valid(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
-- An admitted case belongs to the employing legal company that supplied its evidence.
CREATE FUNCTION app.probation_assert_case_runtime(p_case uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 PERFORM 1 FROM employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id FOR SHARE;
 IF NOT FOUND OR c.data->>'sourceCompanyMoved'='true' THEN RAISE EXCEPTION 'The employment moved to a different company; this case is historical and cannot act';END IF;PERFORM app.probation_assert_runtime(c.company_id);
 IF app.probation_owns_legacy(c.employment_id) IS NOT TRUE THEN RAISE EXCEPTION 'This preserved case was explicitly reconciled back to legacy review';END IF;
END $$;
CREATE FUNCTION app.probation_hold_source_transfer(p_case uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;
BEGIN
 PERFORM app.probation_write_lock();IF app.probation_storage_runner() IS NOT TRUE THEN RAISE EXCEPTION 'Verified owner source-transfer review required';END IF;SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR app.probation_case_company_current(c.id) OR c.data->>'sourceCompanyMoved'='true' THEN RETURN false;END IF;
 UPDATE probation_case SET data=data||jsonb_build_object('sourceCompanyMoved',true,'sourceTransferHeldAt',now()),revision=revision+1 WHERE id=c.id;
 UPDATE probation_occurrence SET state='cancelled' WHERE case_id=c.id AND tenant_id=c.tenant_id AND state IN('ready','scheduled');
 UPDATE probation_render_request SET state='held',failure='The employing company changed; preserve this original-company history.' WHERE case_id=c.id AND tenant_id=c.tenant_id AND state='pending';
 UPDATE probation_filing_queue SET state='held',failure='The employing company changed before canonical filing.' WHERE case_id=c.id AND tenant_id=c.tenant_id AND state IN('pending','held');
 UPDATE probation_date_adjustment SET failure='The employing company changed before this date movement.' WHERE case_id=c.id AND tenant_id=c.tenant_id AND applied_at IS NULL;
 UPDATE probation_outcome SET failure='The employing company changed before the remaining outcome effects.',updated_at=now() WHERE case_id=c.id AND tenant_id=c.tenant_id AND state<>'completed';
 PERFORM app.probation_audit(c.id,NULL,'source_company_changed');RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.probation_case_company_current(uuid),app.probation_case_source_moved(uuid),app.probation_assert_case_runtime(uuid),app.probation_hold_source_transfer(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_case_source_moved(uuid) TO ai_hr_app;
-- A completed paper review retains its original file; a new HR decision is not a historical signature.
CREATE TABLE probation_offline_final_proposal(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),employment_id uuid NOT NULL REFERENCES employment(id),
 entry_id uuid NOT NULL REFERENCES probation_intake_entry(id),entry_revision integer NOT NULL,evidence_id uuid NOT NULL REFERENCES probation_intake_evidence(id),source_digest text NOT NULL,
 case_id uuid REFERENCES probation_case(id),part_id uuid REFERENCES probation_part(id),file_id uuid REFERENCES probation_file(id),
 period_start date NOT NULL,period_end date NOT NULL,outcome text NOT NULL CHECK(outcome IN('confirm','extend','not_confirm','other')),extension_months integer,reason text NOT NULL CHECK(length(btrim(reason))>=3),
 proposed_by uuid NOT NULL REFERENCES app_user(id),proposed_at timestamptz NOT NULL DEFAULT now(),accepted_by uuid REFERENCES app_user(id),accepted_at timestamptz,superseded_at timestamptz,
 CHECK(period_end>=period_start),CHECK((outcome='extend' AND extension_months IN(3,6) AND extension_months IS NOT NULL) OR (outcome<>'extend' AND extension_months IS NULL))
);
CREATE UNIQUE INDEX probation_offline_final_current_entry ON probation_offline_final_proposal(entry_id,entry_revision) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX probation_offline_final_current_part ON probation_offline_final_proposal(part_id) WHERE part_id IS NOT NULL AND superseded_at IS NULL;
ALTER TABLE probation_offline_final_proposal ENABLE ROW LEVEL SECURITY;ALTER TABLE probation_offline_final_proposal FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_owner ON probation_offline_final_proposal FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON probation_offline_final_proposal FROM PUBLIC,ai_hr_app;
ALTER TABLE probation_outcome ADD COLUMN offline_proposal_id uuid REFERENCES probation_offline_final_proposal(id);
CREATE FUNCTION app.probation_offline_proposal_for_entry(p_entry uuid) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE entry probation_intake_entry;proposal uuid;
BEGIN
 SELECT * INTO entry FROM probation_intake_entry WHERE id=p_entry AND tenant_id=app.current_tenant_id();IF entry.id IS NULL THEN RETURN NULL;END IF;
 SELECT f.id INTO proposal FROM probation_offline_final_proposal f WHERE f.entry_id=entry.id AND f.entry_revision=entry.revision AND f.tenant_id=entry.tenant_id AND f.superseded_at IS NULL AND f.source_digest=entry.source_digest AND f.proposed_by::text=app.probation_holders(entry.employment_id)->>'pbp' AND EXISTS(SELECT 1 FROM jsonb_array_elements(entry.data->'parts') stage WHERE stage->>'type'='3' AND coalesce((stage->>'cycle')::integer,0)=coalesce((entry.data->>'extensionCount')::integer,0) AND stage->>'status'='completed_offline' AND stage->>'evidenceId'=f.evidence_id::text);RETURN proposal;
END $$;
CREATE FUNCTION app.probation_offline_decision_json(p_proposal uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',f.id,'entryId',f.entry_id,'revision',f.entry_revision,'outcome',f.outcome,'extensionMonths',f.extension_months,'reason',f.reason,'evidenceId',f.evidence_id,'fileId',f.file_id,'periodStart',f.period_start,'periodEnd',f.period_end,'proposedBy',f.proposed_by,'proposedAt',f.proposed_at,'acceptedBy',f.accepted_by,'acceptedAt',f.accepted_at) FROM probation_offline_final_proposal f WHERE f.id=p_proposal AND f.tenant_id=app.current_tenant_id();
$$;
CREATE FUNCTION app.probation_propose_offline_final(p_employment uuid,p_entry uuid,p_expected integer,p_evidence uuid,p_outcome text,p_months integer,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE entry probation_intake_entry;source jsonb;proposal uuid;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO entry FROM probation_intake_entry WHERE id=p_entry AND employment_id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF entry.id IS NULL OR entry.applied_case_id IS NOT NULL OR app.probation_role(p_employment,'pbp') IS NOT TRUE OR entry.revision IS DISTINCT FROM p_expected OR entry.source_digest IS DISTINCT FROM app.probation_intake_digest(p_employment) OR coalesce(p_outcome,'') NOT IN('confirm','extend','not_confirm','other') OR length(btrim(coalesce(p_reason,'')))<3 OR (p_outcome='extend' AND (coalesce(p_months,0) NOT IN(3,6) OR coalesce((entry.data->>'extensionCount')::integer,0)>=2)) OR (p_outcome<>'extend' AND p_months IS NOT NULL) THEN RAISE EXCEPTION 'Current actual PBP and a reasoned unchanged paper decision are required';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(entry.data->'parts') stage JOIN probation_intake_evidence evidence ON evidence.id=(stage->>'evidenceId')::uuid AND evidence.tenant_id=entry.tenant_id AND evidence.employment_id=entry.employment_id WHERE stage->>'type'='3' AND (stage->>'cycle')::integer=coalesce((entry.data->>'extensionCount')::integer,0) AND stage->>'status'='completed_offline' AND evidence.id=p_evidence AND evidence.content_hash=encode(sha256(evidence.content),'hex')) THEN RAISE EXCEPTION 'Use the exact original PDF mapped to the current completed-offline final Part';END IF;
 source:=app.probation_personnel_source(p_employment);IF source->>'endOn' IS NULL OR source->>'companyId' IS DISTINCT FROM entry.company_id::text THEN RAISE EXCEPTION 'Resolve the actual legal employer and review period before recording paper evidence';END IF;
 UPDATE probation_offline_final_proposal SET superseded_at=now() WHERE entry_id=entry.id AND entry_revision=entry.revision AND tenant_id=entry.tenant_id AND superseded_at IS NULL;
 INSERT INTO probation_offline_final_proposal(tenant_id,company_id,employment_id,entry_id,entry_revision,evidence_id,source_digest,period_start,period_end,outcome,extension_months,reason,proposed_by) VALUES(entry.tenant_id,entry.company_id,entry.employment_id,entry.id,entry.revision,p_evidence,entry.source_digest,(source->>'startOn')::date,(source->>'endOn')::date,p_outcome,p_months,p_reason,app.current_user_id()) RETURNING id INTO proposal;RETURN proposal;
END $$;
CREATE FUNCTION app.probation_offline_record_ready(p_part uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;f probation_offline_final_proposal;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 SELECT * INTO f FROM probation_offline_final_proposal WHERE part_id=p.id AND case_id=c.id AND tenant_id=c.tenant_id AND superseded_at IS NULL AND accepted_at IS NULL;
 RETURN coalesce(f.id IS NOT NULL AND app.probation_case_company_current(c.id) AND p.data->>'state'='completed_offline' AND p.data->>'type'='3' AND p.data->>'cycle'=c.data->>'extensionCount' AND f.proposed_by::text=app.probation_holders(c.employment_id)->>'pbp' AND f.period_start::text=c.data->>'startOn' AND f.period_end::text=c.data->>'endOn' AND EXISTS(SELECT 1 FROM employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id AND e.confirmation_date IS NULL AND e.resignation_date IS NULL AND e.terminated_on IS NULL AND coalesce(e.join_date,e.hired_on)=f.period_start AND coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on)=f.period_end) AND EXISTS(SELECT 1 FROM probation_file file JOIN probation_intake_evidence evidence ON evidence.id=f.evidence_id AND evidence.tenant_id=file.tenant_id AND evidence.content_hash=file.content_hash JOIN employee_document canonical ON canonical.id=file.employee_document_id AND canonical.tenant_id=file.tenant_id AND canonical.employment_id=c.employment_id WHERE file.id=f.file_id AND file.tenant_id=c.tenant_id AND file.part_id=p.id AND file.kind='offline'),false);
END $$;
CREATE FUNCTION app.probation_review_complete(p_part uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;f probation_offline_final_proposal;
BEGIN
 IF app.probation_signatures_complete(p_part) THEN RETURN true;END IF;
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 SELECT * INTO f FROM probation_offline_final_proposal WHERE part_id=p.id AND case_id=c.id AND tenant_id=c.tenant_id AND superseded_at IS NULL AND accepted_at IS NOT NULL;
 RETURN coalesce(f.id IS NOT NULL AND p.data->>'offlineProposalId'=f.id::text AND app.probation_case_company_current(c.id) AND p.data->>'state'='completed_offline' AND f.period_start::text=c.data->>'startOn' AND f.period_end::text=c.data->>'endOn' AND EXISTS(SELECT 1 FROM probation_file file JOIN employee_document canonical ON canonical.id=file.employee_document_id AND canonical.tenant_id=file.tenant_id AND canonical.employment_id=c.employment_id WHERE file.id=f.file_id AND file.tenant_id=c.tenant_id AND file.part_id=p.id AND file.kind='offline'),false);
END $$;
CREATE FUNCTION app.probation_evaluation_decision(p_part uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE decision jsonb;
BEGIN
 SELECT jsonb_build_object('outcome',f.outcome,'extensionMonths',f.extension_months,'justification',f.reason,'provenance','completed_offline') INTO decision FROM probation_offline_final_proposal f JOIN probation_part part ON part.id=f.part_id AND part.tenant_id=f.tenant_id AND part.data->>'offlineProposalId'=f.id::text AND part.data->>'state'='completed_offline' WHERE f.part_id=p_part AND f.tenant_id=app.current_tenant_id() AND f.accepted_at IS NOT NULL AND f.superseded_at IS NULL;
 IF decision IS NULL THEN SELECT data INTO decision FROM probation_rater_draft WHERE part_id=p_part AND tenant_id=app.current_tenant_id() AND rater='lm';END IF;RETURN decision;
END $$;
CREATE FUNCTION app.probation_offline_decision_for_part(p_part uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;proposal uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR p.data->>'state'<>'completed_offline' OR app.probation_case_company_current(c.id) IS NOT TRUE OR NOT(app.probation_storage_runner() OR app.probation_case_access(c.id) AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs'))) THEN RETURN NULL;END IF;
 SELECT id INTO proposal FROM probation_offline_final_proposal WHERE part_id=p.id AND tenant_id=p.tenant_id AND superseded_at IS NULL;RETURN app.probation_offline_decision_json(proposal);
END $$;
REVOKE ALL ON FUNCTION app.probation_offline_proposal_for_entry(uuid),app.probation_offline_decision_json(uuid),app.probation_propose_offline_final(uuid,uuid,integer,uuid,text,integer,text),app.probation_offline_record_ready(uuid),app.probation_review_complete(uuid),app.probation_evaluation_decision(uuid),app.probation_offline_decision_for_part(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_propose_offline_final(uuid,uuid,integer,uuid,text,integer,text),app.probation_offline_decision_for_part(uuid) TO ai_hr_app;
CREATE FUNCTION app.probation_can_adjudicate_offline_final(p_part uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 RETURN c.id IS NOT NULL AND app.probation_case_access(c.id) AND app.probation_case_company_current(c.id)
  AND app.probation_owns_legacy(c.employment_id) AND app.probation_role(c.employment_id,'pbp')
  AND EXISTS(SELECT 1 FROM probation_activation a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled)
  AND EXISTS(SELECT 1 FROM probation_offline_final_proposal f WHERE f.part_id=p.id AND f.tenant_id=p.tenant_id AND f.superseded_at IS NULL AND f.accepted_at IS NOT NULL AND f.outcome='other')
  AND app.probation_review_complete(p.id)
  AND NOT EXISTS(SELECT 1 FROM probation_outcome o WHERE o.part_id=p.id AND o.tenant_id=p.tenant_id AND (o.released_at IS NOT NULL OR o.movement_ref IS NOT NULL OR o.handoff_ref IS NOT NULL));
END $$;
REVOKE ALL ON FUNCTION app.probation_can_adjudicate_offline_final(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_can_adjudicate_offline_final(uuid) TO ai_hr_app;
CREATE FUNCTION app.probation_adjudicate_offline_final(p_case uuid,p_part uuid,p_expected integer,p_outcome text,p_months integer,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;f probation_offline_final_proposal;proposal uuid;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id FOR UPDATE;PERFORM app.probation_assert_case_runtime(c.id);
 SELECT * INTO f FROM probation_offline_final_proposal WHERE part_id=p.id AND tenant_id=p.tenant_id AND superseded_at IS NULL AND accepted_at IS NOT NULL FOR UPDATE;
 IF f.id IS NULL OR app.probation_can_adjudicate_offline_final(p.id) IS NOT TRUE OR p.revision IS DISTINCT FROM p_expected OR coalesce(p_outcome,'') NOT IN('confirm','extend','not_confirm') OR length(btrim(coalesce(p_reason,'')))<3 OR (p_outcome='extend' AND (coalesce(p_months,0) NOT IN(3,6) OR (c.data->>'extensionCount')::integer>=2)) OR (p_outcome<>'extend' AND p_months IS NOT NULL) OR EXISTS(SELECT 1 FROM probation_outcome WHERE part_id=p.id AND tenant_id=p.tenant_id AND (released_at IS NOT NULL OR movement_ref IS NOT NULL OR handoff_ref IS NOT NULL)) THEN RAISE EXCEPTION 'Only the current PBP may adjudicate a recorded unresolved paper decision, with an actual reason';END IF;
 UPDATE probation_offline_final_proposal SET superseded_at=now() WHERE id=f.id;
 INSERT INTO probation_offline_final_proposal(tenant_id,company_id,employment_id,entry_id,entry_revision,evidence_id,source_digest,case_id,part_id,file_id,period_start,period_end,outcome,extension_months,reason,proposed_by) VALUES(f.tenant_id,f.company_id,f.employment_id,f.entry_id,f.entry_revision,f.evidence_id,f.source_digest,c.id,p.id,f.file_id,f.period_start,f.period_end,p_outcome,p_months,p_reason,app.current_user_id()) RETURNING id INTO proposal;
 UPDATE probation_part SET revision=revision+1 WHERE id=p.id;UPDATE probation_case SET revision=revision+1 WHERE id=c.id;PERFORM app.probation_audit(c.id,p.id,'offline_final_adjudicated',p_reason);RETURN proposal;
END $$;
REVOKE ALL ON FUNCTION app.probation_adjudicate_offline_final(uuid,uuid,integer,text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_adjudicate_offline_final(uuid,uuid,integer,text,integer,text) TO ai_hr_app;

ALTER TABLE probation_date_adjustment ADD COLUMN superseded_at timestamptz, ADD COLUMN superseded_by uuid, ADD COLUMN superseded_reason text;
CREATE UNIQUE INDEX probation_date_one_pending ON probation_date_adjustment(tenant_id,case_id) WHERE applied_at IS NULL AND superseded_at IS NULL;
CREATE FUNCTION app.probation_date_request_current(r probation_date_adjustment,c probation_case) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN r.expected_revision=c.revision AND app.probation_case_company_current(c.id) AND EXISTS(
  SELECT 1 FROM employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.confirmation_date IS NULL AND e.resignation_date IS NULL AND e.terminated_on IS NULL
  AND r.old_end=coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.probation_end_date,e.provisional_end_on)
  AND app.probation_holders(e.id)->>'pbp'=r.requested_by::text
  AND (r.gbs_approved_by IS NULL OR app.probation_gbs_user(e.id,r.gbs_approved_by)));
END $$;
CREATE FUNCTION app.probation_date_request_actions(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r probation_date_adjustment;c probation_case; valid boolean;
BEGIN
 SELECT * INTO r FROM probation_date_adjustment WHERE id=p_id AND tenant_id=app.current_tenant_id() AND applied_at IS NULL AND superseded_at IS NULL;
 SELECT * INTO c FROM probation_case WHERE id=r.case_id AND tenant_id=r.tenant_id;
 IF c.id IS NULL OR app.probation_case_access(c.id) IS NOT TRUE OR app.probation_case_company_current(c.id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM probation_activation a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled) THEN RETURN jsonb_build_object('canApprove',false,'canSupersede',false);END IF;
 valid:=app.probation_date_request_current(r,c) IS TRUE;
 RETURN jsonb_build_object(
  'canApprove',app.probation_role(c.employment_id,'gbs') IS TRUE AND valid AND (r.gbs_approved_by IS NULL OR (r.failure IS NOT NULL AND r.gbs_approved_by=app.current_user_id())),
  'canSupersede',app.probation_role(c.employment_id,'pbp') IS TRUE AND (r.gbs_approved_by IS NULL OR r.failure IS NOT NULL OR NOT valid));
END $$;
CREATE FUNCTION app.probation_can_request_date_shift(p_case uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM probation_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id JOIN probation_activation a ON a.company_id=c.company_id AND a.tenant_id=c.tenant_id AND a.enabled WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND app.probation_case_access(c.id) AND app.probation_case_company_current(c.id) AND app.probation_role(e.id,'pbp') AND c.data->>'state' NOT IN('confirmed','not_confirmed','withdrawn','outcome_pending') AND e.confirmation_date IS NULL AND e.resignation_date IS NULL AND e.terminated_on IS NULL AND (c.data->>'endOn')::date=coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.probation_end_date,e.provisional_end_on) AND NOT EXISTS(SELECT 1 FROM probation_date_adjustment r WHERE r.case_id=c.id AND r.tenant_id=c.tenant_id AND r.applied_at IS NULL AND r.superseded_at IS NULL));
END $$;
CREATE FUNCTION app.probation_supersede_date_shift(p_case uuid,p_request uuid,p_revision integer,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r probation_date_adjustment;c probation_case;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO r FROM probation_date_adjustment WHERE id=p_request AND case_id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 SELECT * INTO c FROM probation_case WHERE id=r.case_id AND tenant_id=r.tenant_id FOR UPDATE;
 IF c.id IS NULL OR c.revision IS DISTINCT FROM p_revision OR length(btrim(coalesce(p_reason,'')))<3 OR app.probation_date_request_actions(r.id)->>'canSupersede' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Only the current PBP may supersede an unresolved date request with a reason';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 UPDATE probation_date_adjustment SET superseded_at=now(),superseded_by=app.current_user_id(),superseded_reason=p_reason WHERE id=r.id;
 PERFORM app.probation_audit(c.id,NULL,'date_shift_superseded',p_reason);
END $$;
REVOKE ALL ON FUNCTION app.probation_date_request_current(probation_date_adjustment,probation_case),app.probation_date_request_actions(uuid),app.probation_can_request_date_shift(uuid),app.probation_supersede_date_shift(uuid,uuid,integer,text) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_date_request_actions(uuid),app.probation_can_request_date_shift(uuid),app.probation_supersede_date_shift(uuid,uuid,integer,text) TO ai_hr_app;

-- Named preparation can rehearse preserved cases without opening their confidential drafts.
CREATE FUNCTION app.probation_reactivation_cases(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT(app.probation_config_admin(p_company) OR app.probation_storage_runner()) OR app.probation_company_entitled(p_company) IS NOT TRUE THEN
  RAISE EXCEPTION 'Named cutover preparation required';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',c.id,'employmentId',c.employment_id,'revision',c.revision,'state',c.data->>'state',
  'source',app.probation_personnel_source(c.employment_id),
  'startOn',c.data->>'startOn','endOn',c.data->>'endOn','gradeAtStart',c.data->>'gradeAtStart',
  'config',c.data->'config','milestones',c.data->'milestones',
  'workflowIds',coalesce(c.data->'workflowIds','[]'),
  'frozenScope',jsonb_build_object('businessGroupId',c.data->'facts'->>'businessGroupId','businessUnitId',c.data->'facts'->>'businessUnitId','departmentId',c.data->'facts'->>'departmentId'),
  'occurrenceKeys',(SELECT coalesce(jsonb_agg(o.source_key ORDER BY o.source_key),'[]') FROM probation_occurrence o WHERE o.case_id=c.id AND o.tenant_id=c.tenant_id AND o.due_on>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date),
  'pendingWork',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',work.kind,'id',work.id,'state',work.state) ORDER BY work.kind,work.id),'[]') FROM (
   SELECT 'render' AS kind,q.id,q.state FROM probation_render_request q WHERE q.case_id=c.id AND q.tenant_id=c.tenant_id AND q.state IN('pending','held')
   UNION ALL SELECT 'filing',q.file_id,q.state FROM probation_filing_queue q WHERE q.case_id=c.id AND q.tenant_id=c.tenant_id AND q.state IN('pending','held')
   UNION ALL SELECT 'outcome',o.id,o.state FROM probation_outcome o WHERE o.case_id=c.id AND o.tenant_id=c.tenant_id AND o.released_at IS NOT NULL AND o.state<>'completed'
   UNION ALL SELECT 'schedule_reconciliation',q.id,q.state FROM probation_schedule_reconciliation_request q WHERE q.case_id=c.id AND q.tenant_id=c.tenant_id AND q.state='pending'
   UNION ALL SELECT 'date_shift',r.id,CASE WHEN r.failure IS NOT NULL THEN 'failed' WHEN r.gbs_approved_at IS NOT NULL THEN 'queued' ELSE 'awaiting_gbs' END FROM probation_date_adjustment r WHERE r.case_id=c.id AND r.tenant_id=c.tenant_id AND r.applied_at IS NULL AND r.superseded_at IS NULL
  ) work),
  'parts',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'type',p.data->'type','state',p.data->>'state','issueOn',p.data->>'issueOn','dueOn',p.data->>'dueOn',
    'pending',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',party.role,'userId',u.id,'name',person.full_name) ORDER BY party.role,u.id),'[]')
      FROM app.probation_pending_parties(p.id) party JOIN app_user u ON u.id=party.user_id AND u.tenant_id=c.tenant_id
      JOIN person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id))
   ) ORDER BY p.id),'[]') FROM probation_part p WHERE p.case_id=c.id AND p.tenant_id=c.tenant_id AND p.data->>'documentKind' IS DISTINCT FROM 'letter'),
  'holders',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',holder.key,'name',person.full_name,'userId',u.id) ORDER BY holder.key),'[]') FROM jsonb_each_text(app.probation_personnel_source(c.employment_id)->'holders') holder JOIN app_user u ON u.id=holder.value::uuid AND u.tenant_id=c.tenant_id JOIN person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 ) ORDER BY c.id),'[]') INTO result
 FROM (SELECT candidate.* FROM probation_case candidate
  WHERE candidate.tenant_id=app.current_tenant_id() AND candidate.company_id=p_company
    AND candidate.data->>'state' NOT IN('withdrawn','confirmed','not_confirmed')
    AND app.probation_case_company_current(candidate.id) AND app.probation_owns_legacy(candidate.employment_id)
  ORDER BY candidate.id LIMIT 501) c;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.probation_reactivation_cases(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_reactivation_cases(uuid) TO ai_hr_app;

ALTER TABLE probation_activation ADD COLUMN paused_at timestamptz, ADD COLUMN pause_receipt text;
CREATE FUNCTION app.probation_pause_company(p_company uuid,p_receipt text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.probation_write_lock();
 IF app.probation_storage_runner() IS NOT TRUE OR length(btrim(coalesce(p_receipt,''))) NOT BETWEEN 3 AND 2000 THEN
  RAISE EXCEPTION 'Verified installation owner and a rollback receipt are required';
 END IF;
 UPDATE probation_activation SET enabled=false,paused_at=now(),pause_receipt=p_receipt,updated_at=now()
 WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND enabled;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app.probation_pause_company(uuid,text) FROM PUBLIC,ai_hr_app;


CREATE TABLE probation_schedule_reconciliation_request (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES probation_case(id),
 revision integer NOT NULL,source_stamp text NOT NULL,requested_by uuid NOT NULL REFERENCES app_user(id),reason text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','applied','stale')),created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz
);
CREATE UNIQUE INDEX probation_schedule_reconciliation_pending ON probation_schedule_reconciliation_request(tenant_id,case_id) WHERE state='pending';
ALTER TABLE probation_schedule_reconciliation_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE probation_schedule_reconciliation_request FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_owner ON probation_schedule_reconciliation_request FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON probation_schedule_reconciliation_request FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.probation_schedule_source_stamp(p_case uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('companyId',e.company_id,'startOn',coalesce(e.join_date,e.hired_on),
  'endOn',coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.probation_end_date,e.provisional_end_on),
  'confirmed',e.confirmation_date,'resigned',e.resignation_date,'terminated',e.terminated_on,'revision',c.revision,
  'activation',(SELECT a.updated_at FROM probation_activation a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id))::text,'UTF8')),'hex')
 FROM probation_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
 WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id()
$$;
CREATE FUNCTION app.probation_can_reconcile_dates(p_case uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM probation_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
  WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND app.probation_case_access(c.id)
   AND app.probation_case_company_current(c.id) AND app.probation_owns_legacy(c.employment_id)
   AND (app.probation_role(e.id,'pbp') OR app.probation_role(e.id,'gbs'))
   AND c.data->>'state' NOT IN('confirmed','not_confirmed','withdrawn','outcome_pending')
   AND e.confirmation_date IS NULL AND e.resignation_date IS NULL AND e.terminated_on IS NULL
   AND coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.probation_end_date,e.provisional_end_on) IS NOT NULL
   AND (c.data->>'startOn' IS DISTINCT FROM coalesce(e.join_date,e.hired_on)::text OR c.data->>'endOn' IS DISTINCT FROM coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.probation_end_date,e.provisional_end_on)::text)
   AND NOT EXISTS(SELECT 1 FROM probation_schedule_reconciliation_request q WHERE q.tenant_id=c.tenant_id AND q.case_id=c.id AND q.state='pending'));
END $$;
CREATE FUNCTION app.probation_request_schedule_reconciliation(p_case uuid,p_expected integer,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.revision IS DISTINCT FROM p_expected OR app.probation_can_reconcile_dates(c.id) IS NOT TRUE OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 2000
 THEN
  RAISE EXCEPTION 'Review the unchanged Personnel schedule and give a reason';
 END IF;
 INSERT INTO probation_schedule_reconciliation_request(tenant_id,case_id,revision,source_stamp,requested_by,reason)
 VALUES(c.tenant_id,c.id,c.revision,app.probation_schedule_source_stamp(c.id),app.current_user_id(),p_reason);
 PERFORM app.probation_audit(c.id,NULL,'schedule_reconciliation_requested',p_reason);
END $$;
CREATE FUNCTION app.probation_schedule_reconciliation_owner(p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q probation_schedule_reconciliation_request;c probation_case;
BEGIN
 PERFORM app.probation_write_lock();
 IF app.probation_storage_runner() IS NOT TRUE THEN RAISE EXCEPTION 'Verified installation owner required';END IF;
 SELECT * INTO q FROM probation_schedule_reconciliation_request WHERE id=p_request AND tenant_id=app.current_tenant_id() AND state='pending' FOR UPDATE;
 SELECT * INTO c FROM probation_case WHERE id=q.case_id AND tenant_id=q.tenant_id FOR UPDATE;
 IF c.id IS NULL THEN RETURN NULL;END IF;
 IF q.source_stamp IS DISTINCT FROM app.probation_schedule_source_stamp(c.id) OR app.probation_case_company_current(c.id) IS NOT TRUE OR app.probation_owns_legacy(c.employment_id) IS NOT TRUE OR app.probation_company_entitled(c.company_id) IS NOT TRUE
 OR NOT(coalesce(app.probation_holders(c.employment_id)->>'pbp'=q.requested_by::text,false) OR app.probation_gbs_user(c.employment_id,q.requested_by)) THEN
  UPDATE probation_schedule_reconciliation_request SET state='stale',resolved_at=now() WHERE id=q.id;
  PERFORM app.probation_audit(c.id,NULL,'schedule_reconciliation_stale',q.reason);RETURN NULL;
 END IF;
 RETURN jsonb_build_object('caseId',c.id,'revision',q.revision,'reason',q.reason);
END $$;
REVOKE ALL ON FUNCTION app.probation_schedule_source_stamp(uuid),app.probation_can_reconcile_dates(uuid),app.probation_request_schedule_reconciliation(uuid,integer,text),app.probation_schedule_reconciliation_owner(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_can_reconcile_dates(uuid),app.probation_request_schedule_reconciliation(uuid,integer,text) TO ai_hr_app;

-- A retired head blocks future selection while keeping every published version immutable.
ALTER TABLE probation_configuration ADD COLUMN retirement_reason text;
ALTER TABLE probation_builder_definition ADD COLUMN retirement_reason text;
CREATE FUNCTION app.probation_is_current_publication(p_kind text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f probation_configuration;b probation_builder_definition;
BEGIN
 IF p_kind='form' THEN
  SELECT * INTO f FROM probation_configuration WHERE id=p_id AND tenant_id=app.current_tenant_id() AND kind='form' AND state='published';
  RETURN f.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM probation_configuration newer
   WHERE newer.tenant_id=f.tenant_id AND newer.company_id=f.company_id AND newer.kind=f.kind AND newer.version>f.version AND newer.state IN('published','retired')
    AND coalesce(newer.data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]')=coalesce(f.data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]'));
 END IF;
 IF p_kind IN('workflow','template') THEN
  SELECT * INTO b FROM probation_builder_definition WHERE id=p_id AND tenant_id=app.current_tenant_id() AND kind=p_kind AND state='published';
  RETURN b.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM probation_builder_definition newer WHERE newer.tenant_id=b.tenant_id AND newer.company_id=b.company_id AND newer.kind=b.kind AND newer.definition_key=b.definition_key AND newer.version>b.version AND newer.state IN('published','retired'));
 END IF;
 RETURN false;
END $$;
CREATE FUNCTION app.probation_current_publication(p_company uuid,p_kind text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT(app.probation_config_admin(p_company) OR app.probation_storage_runner()) THEN RETURN false;END IF;
 IF p_kind='form' THEN
  RETURN EXISTS(SELECT 1 FROM probation_configuration f WHERE f.id=p_id AND f.tenant_id=app.current_tenant_id() AND f.company_id=p_company AND app.probation_is_current_publication(p_kind,f.id));
 END IF;
 RETURN EXISTS(SELECT 1 FROM probation_builder_definition b WHERE b.id=p_id AND b.tenant_id=app.current_tenant_id() AND b.company_id=p_company AND app.probation_is_current_publication(p_kind,b.id));
END $$;
CREATE FUNCTION app.probation_publication_retirement(p_company uuid,p_kind text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE expected integer:=0;
BEGIN
 IF app.probation_config_admin(p_company) IS NOT TRUE OR app.probation_current_publication(p_company,p_kind,p_id) IS NOT TRUE THEN
  RETURN jsonb_build_object('canRetire',false,'expectedVersion',0);
 END IF;
 IF p_kind='form' THEN
  SELECT max(f.version) INTO expected FROM probation_configuration f WHERE f.tenant_id=app.current_tenant_id() AND f.company_id=p_company AND f.kind=p_kind;
 ELSE
  SELECT max(b.version) INTO expected FROM probation_builder_definition b JOIN probation_builder_definition selected
   ON selected.tenant_id=b.tenant_id AND selected.company_id=b.company_id AND selected.kind=b.kind AND selected.definition_key=b.definition_key
   WHERE selected.id=p_id AND b.tenant_id=app.current_tenant_id() AND b.company_id=p_company AND b.kind=p_kind;
 END IF;
 RETURN jsonb_build_object('canRetire',true,'expectedVersion',expected);
END $$;
CREATE FUNCTION app.probation_retire_publication(p_company uuid,p_kind text,p_id uuid,p_expected integer,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE authority jsonb; retired_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 authority:=app.probation_publication_retirement(p_company,p_kind,p_id);
 IF authority->>'canRetire' IS DISTINCT FROM 'true' OR (authority->>'expectedVersion')::integer IS DISTINCT FROM p_expected OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 2000 THEN
  RAISE EXCEPTION 'Reload the active probation publication and give a retirement reason';
 END IF;
 IF p_kind='form' THEN
  INSERT INTO probation_configuration(tenant_id,company_id,kind,version,state,data,created_by,retirement_reason)
  SELECT f.tenant_id,f.company_id,f.kind,p_expected+1,'retired',f.data,app.current_user_id(),p_reason FROM probation_configuration f WHERE f.id=p_id AND f.tenant_id=app.current_tenant_id() RETURNING id INTO retired_id;
 ELSE
  INSERT INTO probation_builder_definition(tenant_id,company_id,kind,definition_key,version,state,data,created_by,retirement_reason)
  SELECT b.tenant_id,b.company_id,b.kind,b.definition_key,p_expected+1,'retired',b.data,app.current_user_id(),p_reason FROM probation_builder_definition b WHERE b.id=p_id AND b.tenant_id=app.current_tenant_id() RETURNING id INTO retired_id;
 END IF;
 RETURN jsonb_build_object('id',retired_id,'version',p_expected+1);
END $$;
REVOKE ALL ON FUNCTION app.probation_is_current_publication(text,uuid),app.probation_current_publication(uuid,text,uuid),app.probation_publication_retirement(uuid,text,uuid),app.probation_retire_publication(uuid,text,uuid,integer,text) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_current_publication(uuid,text,uuid),app.probation_publication_retirement(uuid,text,uuid),app.probation_retire_publication(uuid,text,uuid,integer,text) TO ai_hr_app;

-- The canonical pending route is generated from current scope, never supplied by a caller.
CREATE FUNCTION app.probation_signing_refresh_route(p_subject uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;resolved jsonb;step jsonb;steps jsonb:='[]';identity uuid;
BEGIN
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=app.current_tenant_id() AND subject_type='probation' AND subject_id=p_subject;
 IF d.id IS NULL THEN RETURN NULL;END IF;
 resolved:=app.probation_resolved_route(p_subject);
 FOR step IN SELECT value FROM jsonb_array_elements(resolved->'steps') LOOP
  IF NOT app.document_signing_step_fulfilled(d.data,step) THEN
   SELECT u.person_id INTO identity FROM app_user u WHERE u.id=(step->>'holderId')::uuid AND u.tenant_id=d.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
   IF identity IS NULL THEN step:=(step-'holderPersonId')||jsonb_build_object('holderId',NULL);
   ELSE step:=step||jsonb_build_object('holderPersonId',identity);END IF;
  END IF;
  steps:=steps||jsonb_build_array(step);
 END LOOP;
 RETURN jsonb_set(d.data->'route','{steps}',steps);
END $$;
CREATE FUNCTION app.probation_signing_refresh_allowed(p_subject uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;p probation_part;c probation_case;route jsonb;pending integer;
BEGIN
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=app.current_tenant_id() AND subject_type='probation' AND subject_id=p_subject;
 SELECT * INTO p FROM probation_part WHERE id=d.subject_id AND tenant_id=d.tenant_id;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF c.id IS NULL OR coalesce(p.data->>'state','') NOT IN('pending_ack','pending_approval') OR c.data->>'state' IN('confirmed','not_confirmed','withdrawn')
  OR app.probation_case_access(c.id) IS NOT TRUE OR app.probation_case_company_current(c.id) IS NOT TRUE OR app.probation_owns_legacy(c.employment_id) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM probation_activation a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') returned WHERE returned->>'action'='returned' AND returned->>'contentRevision'=d.data->>'contentRevision' AND returned->>'contentHash'=d.data->>'contentHash') THEN RETURN false;
 END IF;
 IF app.probation_storage_runner() THEN RETURN true;END IF;
 IF app.probation_active_user() IS NOT TRUE THEN RETURN false;END IF;
 route:=app.probation_signing_refresh_route(p.id);
 SELECT min((s->>'stage')::integer) INTO pending FROM jsonb_array_elements(route->'steps') s WHERE s->>'required'='true'
  AND NOT app.document_signing_step_fulfilled(d.data,s);
 RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') s WHERE s->>'holderId'=app.current_user_id()::text AND s->>'required'='true' AND (s->>'stage')::integer=pending AND s->>'coveredByStepId' IS NULL
  AND NOT app.document_signing_step_fulfilled(d.data,s));
END $$;
REVOKE ALL ON FUNCTION app.probation_signing_refresh_allowed(uuid),app.probation_signing_refresh_route(uuid) FROM PUBLIC,ai_hr_app;


ALTER TABLE probation_legacy_reconciliation ADD COLUMN approved_reason text;
CREATE FUNCTION app.probation_legacy_reconciliation_state(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;e employment;receipt probation_legacy_reconciliation;eligible boolean;pbp boolean;gbs boolean;digest text;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF c.id IS NULL OR app.probation_case_access(c.id) IS NOT TRUE OR app.probation_case_company_current(c.id) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM probation_activation a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled) THEN RETURN NULL;END IF;
 pbp:=app.probation_role(c.employment_id,'pbp');gbs:=app.probation_role(c.employment_id,'gbs');
 IF NOT(pbp OR gbs) THEN RETURN NULL;END IF;
 SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id AND company_id=c.company_id;
 eligible:=app.probation_legacy_resume_source_current(c.id)
  AND NOT EXISTS(SELECT 1 FROM probation_outcome o WHERE o.case_id=c.id AND o.tenant_id=c.tenant_id AND (o.released_at IS NOT NULL OR o.movement_ref IS NOT NULL OR o.handoff_ref IS NOT NULL));
 digest:=app.probation_legacy_reconcile_digest(c.id);
 SELECT * INTO receipt FROM probation_legacy_reconciliation r WHERE r.case_id=c.id AND r.tenant_id=c.tenant_id
  AND (r.source_digest=digest OR r.applied_at IS NOT NULL) ORDER BY (r.applied_at IS NOT NULL) DESC,r.requested_at DESC,r.id LIMIT 1;
 RETURN jsonb_build_object('canRequest',pbp AND eligible AND receipt.id IS NULL,'holdReason',CASE WHEN eligible THEN NULL ELSE 'The current Personnel or legacy review dates, or a committed outcome, require separate reconciliation.' END,
  'request',CASE WHEN receipt.id IS NULL THEN NULL ELSE jsonb_build_object(
   'id',receipt.id,'reason',receipt.reason,'requestedAt',receipt.requested_at,'approvedAt',receipt.gbs_approved_at,'appliedAt',receipt.applied_at,
   'canApprove',gbs AND eligible AND receipt.gbs_approved_at IS NULL AND receipt.applied_at IS NULL AND receipt.source_digest=digest
    AND app.probation_holders(c.employment_id)->>'pbp' IS NOT DISTINCT FROM receipt.requested_by::text) END);
END $$;
REVOKE ALL ON FUNCTION app.probation_legacy_reconciliation_state(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_legacy_reconciliation_state(uuid) TO ai_hr_app;

CREATE FUNCTION app.probation_notify_route_attention(p_document uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;p probation_part;c probation_case;activation probation_activation;
 workflow probation_builder_definition;step jsonb;attention_role text;occurrence uuid;
 day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;fingerprint text;
BEGIN
 IF app.probation_storage_runner() IS NOT TRUE THEN RAISE EXCEPTION 'Verified route notification owner required';END IF;
 PERFORM app.probation_write_lock();
 SELECT * INTO d FROM document_signing_document WHERE id=p_document AND tenant_id=app.current_tenant_id() AND subject_type='probation';
 IF d.id IS NULL OR app.probation_signing_refresh_allowed(d.subject_id) IS NOT TRUE THEN RETURN;END IF;
 SELECT * INTO p FROM probation_part WHERE id=d.subject_id AND tenant_id=d.tenant_id;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 SELECT * INTO activation FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') signer WHERE signer->>'required'='true' AND signer->>'holderId' IS NULL) THEN
  attention_role:='gbs';
 ELSIF EXISTS(SELECT 1 FROM document_signing_revision snapshot WHERE snapshot.tenant_id=d.tenant_id AND snapshot.document_id=d.id
  AND snapshot.reason='Current canonical probation signing holders changed' AND snapshot.data->'contentRevision'=d.data->'contentRevision'
  AND snapshot.data->'route'=d.data->'route' AND snapshot.created_at>=activation.updated_at AND (snapshot.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date=day) THEN
  attention_role:='pbp';
 ELSE RETURN;END IF;
 SELECT * INTO workflow FROM probation_builder_definition w WHERE w.tenant_id=c.tenant_id AND w.company_id=c.company_id AND w.kind='workflow'
  AND w.state='published' AND c.data->'workflowIds'?w.id::text AND w.data->'trigger'->>'event'='approval_pending'
  AND coalesce(w.data->'conditions','{}')='{}'
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(w.data->'steps') action WHERE action->'to'?attention_role)
  ORDER BY w.version DESC,w.id LIMIT 1;
 IF workflow.id IS NULL THEN RETURN;END IF;
 SELECT value INTO step FROM jsonb_array_elements(workflow.data->'steps') WHERE value->'to'?attention_role ORDER BY value->>'id' LIMIT 1;
 fingerprint:=encode(sha256(convert_to((d.data->'route')::text,'UTF8')),'hex');
 occurrence:=app.probation_enqueue(c.id,p.id,'route_attention',day,jsonb_build_array(attention_role),'probation-route-attention:'||p.id::text||':'||(d.data->>'contentRevision')||':'||fingerprint||':'||attention_role,p.revision);
 UPDATE probation_occurrence SET workflow_id=workflow.id,workflow_step_id=step->>'id' WHERE tenant_id=c.tenant_id AND id=occurrence AND workflow_id IS NULL;
END $$;
REVOKE ALL ON FUNCTION app.probation_notify_route_attention(uuid) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.probation_current_escalated_actor(p_case uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;
BEGIN
 IF app.probation_active_user() IS NOT TRUE THEN RETURN false;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF c.id IS NULL OR app.probation_case_company_current(c.id) IS NOT TRUE OR app.probation_owns_legacy(c.employment_id) IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM probation_activation a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled) THEN RETURN false;END IF;
 RETURN EXISTS(
  SELECT 1 FROM probation_part p JOIN document_signing_document d ON d.tenant_id=p.tenant_id AND d.subject_type='probation' AND d.subject_id=p.id
   CROSS JOIN LATERAL jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') step
  WHERE p.tenant_id=c.tenant_id AND p.case_id=c.id AND p.data->>'state'='pending_approval' AND step->>'kind'='approve'
   AND step->>'holderId'=app.current_user_id()::text AND step->>'representedId' IS NOT NULL AND step->>'required'='true' AND step->>'coveredByStepId' IS NULL
   AND NOT app.document_signing_step_fulfilled(d.data,step)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') earlier WHERE earlier->>'required'='true' AND (earlier->>'stage')::integer<(step->>'stage')::integer AND NOT app.document_signing_step_fulfilled(d.data,earlier)));
END $$;
REVOKE ALL ON FUNCTION app.probation_current_escalated_actor(uuid) FROM PUBLIC,ai_hr_app;
