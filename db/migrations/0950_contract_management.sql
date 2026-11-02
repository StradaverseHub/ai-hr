-- Unapplied source allocation0950/when1793330000350. Preserve all existing onb/off definitions and SQL bytes.
CREATE TABLE contract_configuration(tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid PRIMARY KEY REFERENCES company(id),revision integer NOT NULL DEFAULT 1,data jsonb NOT NULL,runtime_enabled boolean NOT NULL DEFAULT false,activation_on date,effect_principal_id uuid REFERENCES app_user(id),updated_by uuid NOT NULL REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now(),CHECK(NOT runtime_enabled OR (activation_on IS NOT NULL AND effect_principal_id IS NOT NULL)));
CREATE TABLE contract_role_assignment(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),business_unit_id uuid REFERENCES business_unit(id),user_id uuid NOT NULL REFERENCES app_user(id),role text NOT NULL CHECK(role IN('pbp','gbs','rewards','legal','template_approver')),valid_from date NOT NULL,valid_to date,created_by uuid NOT NULL REFERENCES app_user(id),CHECK(valid_to IS NULL OR valid_to>=valid_from));
CREATE TABLE contract_workflow(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),revision integer NOT NULL DEFAULT 1,draft jsonb NOT NULL,published_version integer,required boolean NOT NULL DEFAULT true,enabled boolean NOT NULL DEFAULT true,UNIQUE(tenant_id,company_id,id));
CREATE TABLE contract_workflow_version(workflow_id uuid NOT NULL REFERENCES contract_workflow(id),tenant_id uuid NOT NULL REFERENCES tenant(id),version integer NOT NULL,definition jsonb NOT NULL,published_by uuid NOT NULL REFERENCES app_user(id),published_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workflow_id,version));
CREATE TABLE contract_template(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),type text NOT NULL CHECK(type IN('renewal','end','declined','retirement')),revision integer NOT NULL DEFAULT 1,draft jsonb NOT NULL,draft_submitted_at timestamptz,draft_submitted_by uuid REFERENCES app_user(id),live_version integer,letterhead bytea,signatory_name text,signatory_title text,UNIQUE(tenant_id,company_id,type));
CREATE TABLE contract_template_version(template_id uuid NOT NULL REFERENCES contract_template(id),tenant_id uuid NOT NULL REFERENCES tenant(id),version integer NOT NULL,document jsonb NOT NULL,letterhead bytea,signatory_name text NOT NULL,signatory_title text NOT NULL,approved_by uuid NOT NULL REFERENCES app_user(id),approved_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(template_id,version));
CREATE TABLE contract_term(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),employment_id uuid NOT NULL REFERENCES employment(id),version integer NOT NULL CHECK(version>0),kind text NOT NULL CHECK(kind IN('maternity_cover','project','post_retirement')),start_on date NOT NULL,end_on date NOT NULL,source_revision text NOT NULL,predecessor_id uuid REFERENCES contract_term(id),retirement_source_id uuid,health_completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,employment_id,version),CHECK(start_on<=end_on));
CREATE TABLE contract_case(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),employment_id uuid NOT NULL REFERENCES employment(id),term_id uuid NOT NULL REFERENCES contract_term(id),purpose text NOT NULL DEFAULT 'expiry' CHECK(purpose IN('initial','expiry')),number text NOT NULL,revision integer NOT NULL DEFAULT 1,data jsonb NOT NULL,workflow_id uuid REFERENCES contract_workflow(id),workflow_version integer,source_conflict text,last_synced_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,number),UNIQUE(term_id,purpose),CHECK(revision=(data->>'revision')::integer),FOREIGN KEY(workflow_id,workflow_version) REFERENCES contract_workflow_version(workflow_id,version));
CREATE TABLE contract_document(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES contract_case(id),template_id uuid NOT NULL REFERENCES contract_template(id),template_version integer NOT NULL,decision_revision integer NOT NULL,type text NOT NULL CHECK(type IN('renewal','end','declined','retirement')),content bytea NOT NULL,content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),merge_values jsonb NOT NULL,created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),issued_at timestamptz,released_at timestamptz,superseded_at timestamptz,signature jsonb,signed_content bytea,employee_document_id uuid REFERENCES employee_document(id),FOREIGN KEY(template_id,template_version) REFERENCES contract_template_version(template_id,version),CHECK(octet_length(content) BETWEEN 4 AND 10485760),CHECK(content_hash=encode(sha256(content),'hex')));
CREATE TABLE contract_case_activity(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES contract_case(id),actor_user_id uuid REFERENCES app_user(id),action text NOT NULL,detail jsonb NOT NULL DEFAULT '{}',occurred_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE contract_effect(case_id uuid NOT NULL REFERENCES contract_case(id),tenant_id uuid NOT NULL REFERENCES tenant(id),kind text NOT NULL CHECK(kind IN('records','offboarding','manual_handoff','verify')),status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','done','failed')),receipt jsonb,error text,attempts integer NOT NULL DEFAULT 0,completed_at timestamptz,PRIMARY KEY(case_id,kind));
CREATE TABLE contract_message(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),case_id uuid NOT NULL REFERENCES contract_case(id),workflow_id uuid NOT NULL REFERENCES contract_workflow(id),workflow_version integer NOT NULL,occurrence_key text NOT NULL,recipient_user_id uuid NOT NULL REFERENCES app_user(id),notification_id uuid REFERENCES notification(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(case_id,occurrence_key,recipient_user_id));
--> statement-breakpoint
CREATE FUNCTION app.contract_active_user(wanted_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=wanted_user AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)); $$;
CREATE FUNCTION app.contract_has_role(wanted_company uuid,wanted_unit uuid,wanted_role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_active_user(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.contract_role_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=wanted_company AND (a.business_unit_id IS NULL OR a.business_unit_id=wanted_unit) AND a.user_id=app.current_user_id() AND a.role=wanted_role AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)); $$;
CREATE FUNCTION app.contract_hr_admin(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_active_user(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.role_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.app_user_id=app.current_user_id() AND a.role::text IN('hr_admin','super_admin') AND (a.company_id IS NULL OR a.company_id=wanted_company OR app.is_company_descendant(wanted_company,a.company_id))); $$;
REVOKE ALL ON FUNCTION app.contract_hr_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_hr_admin(uuid) TO ai_hr_app;
CREATE FUNCTION app.contract_configure(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_active_user(app.current_user_id()) AND (app.contract_hr_admin(wanted_company) OR app.contract_has_role(wanted_company,NULL,'gbs')); $$;
CREATE FUNCTION app.contract_business_unit(wanted_employment uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT a.business_unit_id FROM public.assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.employment_id=wanted_employment AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1; $$;
CREATE FUNCTION app.contract_users_for_employment(wanted_employment uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT u.id FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id() AND app.contract_active_user(u.id) AND 1=(SELECT count(*) FROM public.app_user x WHERE x.person_id=e.person_id AND x.tenant_id=e.tenant_id AND app.contract_active_user(x.id)); $$;
CREATE FUNCTION app.contract_manager_users(wanted_employment uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT DISTINCT u FROM public.reporting_line r CROSS JOIN LATERAL app.contract_users_for_employment(r.manager_employment_id) u WHERE r.tenant_id=app.current_tenant_id() AND r.subordinate_employment_id=wanted_employment AND r.line_type='administrative' AND r.superseded_at IS NULL AND r.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (r.valid_to IS NULL OR r.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date); $$;
CREATE FUNCTION app.contract_runtime(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM public.contract_configuration c WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=wanted_company AND c.runtime_enabled AND c.activation_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=c.tenant_id AND t.status IN('active','trial')) AND EXISTS(SELECT 1 FROM public.tenant_module tm WHERE tm.tenant_id=c.tenant_id AND tm.module_code='lifecycle' AND tm.status IN('active','trial') AND (tm.expires_at IS NULL OR tm.expires_at>now()) AND (tm.company_id IS NULL OR tm.company_id=c.company_id))); $$;
CREATE FUNCTION app.contract_case_access(wanted_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_case c WHERE c.id=wanted_case AND c.tenant_id=app.current_tenant_id() AND app.contract_active_user(app.current_user_id()) AND (app.contract_configure(c.company_id) OR app.contract_has_role(c.company_id,app.contract_business_unit(c.employment_id),'pbp') OR app.current_user_id() IN(SELECT app.contract_manager_users(c.employment_id)) OR app.current_user_id() IN(SELECT app.contract_users_for_employment(c.employment_id)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.data->'approvals') step CROSS JOIN LATERAL jsonb_array_elements_text(step->'holderIds') holder WHERE holder::uuid=app.current_user_id()))); $$;
CREATE FUNCTION app.contract_case_pbp(wanted_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM public.contract_case c WHERE c.id=wanted_case AND c.tenant_id=app.current_tenant_id() AND app.contract_has_role(c.company_id,app.contract_business_unit(c.employment_id),'pbp')); $$;
CREATE FUNCTION app.contract_case_manager(wanted_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM public.contract_case c WHERE c.id=wanted_case AND c.tenant_id=app.current_tenant_id() AND app.current_user_id() IN(SELECT app.contract_manager_users(c.employment_id))); $$;
REVOKE ALL ON FUNCTION app.contract_active_user(uuid),app.contract_has_role(uuid,uuid,text),app.contract_configure(uuid),app.contract_business_unit(uuid),app.contract_users_for_employment(uuid),app.contract_manager_users(uuid),app.contract_runtime(uuid),app.contract_case_access(uuid),app.contract_case_pbp(uuid),app.contract_case_manager(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_active_user(uuid),app.contract_has_role(uuid,uuid,text),app.contract_configure(uuid),app.contract_business_unit(uuid),app.contract_users_for_employment(uuid),app.contract_manager_users(uuid),app.contract_runtime(uuid),app.contract_case_access(uuid),app.contract_case_pbp(uuid),app.contract_case_manager(uuid) TO ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['contract_configuration','contract_role_assignment','contract_workflow','contract_workflow_version','contract_template','contract_template_version','contract_term','contract_case','contract_document','contract_case_activity','contract_effect','contract_message'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner())',name||'_owner',name);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,ai_hr_app',name);EXECUTE format('GRANT SELECT ON public.%I TO ai_hr_app',name);
 END LOOP;
END $$;
CREATE POLICY contract_configuration_read ON contract_configuration FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_configure(company_id));
CREATE POLICY contract_role_read ON contract_role_assignment FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (user_id=app.current_user_id() OR app.contract_configure(company_id)));
CREATE POLICY contract_workflow_read ON contract_workflow FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_configure(company_id));
CREATE POLICY contract_workflow_version_read ON contract_workflow_version FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM contract_workflow w WHERE w.id=workflow_id AND app.contract_configure(w.company_id)));
CREATE POLICY contract_template_read ON contract_template FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (app.contract_has_role(company_id,NULL,'gbs') OR app.contract_has_role(company_id,NULL,'legal') OR app.contract_has_role(company_id,NULL,'template_approver')));
CREATE POLICY contract_template_version_read ON contract_template_version FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM contract_template t WHERE t.id=template_id AND app.contract_has_role(t.company_id,NULL,'gbs')));
CREATE POLICY contract_case_read ON contract_case FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_case_access(id));
CREATE POLICY contract_term_read ON contract_term FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM contract_case c WHERE c.term_id=contract_term.id AND app.contract_case_access(c.id)));
CREATE POLICY contract_document_read ON contract_document FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_case_access(case_id) AND (app.current_user_id() NOT IN(SELECT app.contract_users_for_employment((SELECT employment_id FROM public.contract_case WHERE id=case_id))) OR issued_at IS NOT NULL OR released_at IS NOT NULL));
CREATE POLICY contract_activity_read ON contract_case_activity FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_case_access(case_id));
CREATE POLICY contract_effect_read ON contract_effect FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_case_access(case_id));
CREATE POLICY contract_message_read ON contract_message FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_case_access(case_id));
--> statement-breakpoint
CREATE FUNCTION app.contract_audit(wanted_case uuid,action text,detail jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id();IF c.id IS NULL THEN RAISE EXCEPTION 'contract case unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO public.contract_case_activity(tenant_id,case_id,actor_user_id,action,detail) VALUES(c.tenant_id,c.id,app.current_user_id(),action,detail);
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'contract-case',c.id,'contract.'||action,(CASE WHEN app.current_user_id() IS NULL THEN 'system' ELSE 'user' END)::public.actor_type,app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'revision',c.revision));
END $$;
REVOKE ALL ON FUNCTION app.contract_audit(uuid,text,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_source(wanted_employment uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('employmentId',e.id,'companyId',e.company_id,'personId',e.person_id,'name',p.full_name,'employeeId',coalesce(e.employee_code,''),'startOn',e.contract_start_date,'endOn',e.contract_end_date,'businessGroupId',a.business_unit_id,'businessGroup',coalesce(bu.name,''),'manager',coalesce((SELECT mp.full_name FROM public.reporting_line rl JOIN public.employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id WHERE rl.tenant_id=e.tenant_id AND rl.subordinate_employment_id=e.id AND rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (rl.valid_to IS NULL OR rl.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY rl.valid_from DESC,rl.id LIMIT 1),''),'designation',coalesce(pos.title,''),'department',coalesce(dep.name,''),'grade',coalesce(g.code,''),'company',co.legal_name,'salaryCents',(c.basic_salary*100)::bigint::text,'allowanceCents',CASE WHEN pc.id IS NOT NULL THEN (coalesce(fx.amount,0)*100)::bigint::text END,'allowanceComponentId',pc.id,'fixedAllowanceId',fx.id,'compensationId',c.id,'currency',c.currency,'sourceRevision',encode(sha256(convert_to(jsonb_build_array(e.id,e.company_id,e.contract_start_date,e.contract_end_date,e.terminated_on,e.resignation_date,e.last_working_date,e.blacklisted_at,a.id,a.business_unit_id,c.id,c.basic_salary,pc.id,fx.id,fx.amount,c.currency)::text,'UTF8')),'hex'),'ended',least(e.resignation_date,e.last_working_date,e.terminated_on)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT x.* FROM public.assignment x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.superseded_at IS NULL AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY x.valid_from DESC,x.id LIMIT 1) a ON true
 LEFT JOIN public.business_unit bu ON bu.id=a.business_unit_id AND bu.tenant_id=e.tenant_id
 LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id LEFT JOIN public.department dep ON dep.id=a.department_id AND dep.tenant_id=e.tenant_id LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT x.* FROM public.compensation x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.superseded_at IS NULL AND x.valid_from<=greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date) AND (x.valid_to IS NULL OR x.valid_to>greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date)) ORDER BY x.valid_from DESC,x.id LIMIT 1) c ON true
 LEFT JOIN public.contract_configuration cfg ON cfg.company_id=e.company_id AND cfg.tenant_id=e.tenant_id
 LEFT JOIN public.pay_component pc ON pc.id=(cfg.data->>'allowanceComponentId')::uuid AND pc.tenant_id=e.tenant_id AND pc.kind='allowance' AND pc.archived_at IS NULL AND pc.pending_input_kind IS NULL AND (pc.rule IS NULL OR pc.rule->>'kind'='fixed')
 LEFT JOIN LATERAL(SELECT x.* FROM public.employment_pay_component x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.component_id=pc.id AND x.superseded_at IS NULL AND x.valid_from<=greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date) AND (x.valid_to IS NULL OR x.valid_to>greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,e.contract_start_date)) ORDER BY x.valid_from DESC,x.id LIMIT 1) fx ON true
 WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id(); $$;
REVOKE ALL ON FUNCTION app.contract_source(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_case_source(wanted_case uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_source(c.employment_id) FROM public.contract_case c WHERE c.id=wanted_case AND c.tenant_id=app.current_tenant_id() AND app.contract_case_access(c.id); $$;
REVOKE ALL ON FUNCTION app.contract_case_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_case_source(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_save_configuration(wanted_company uuid,expected_revision integer,p_data jsonb,p_runtime boolean,p_effect_principal uuid,p_activation date) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_configuration;next_revision integer;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.contract_configure(wanted_company) OR NOT EXISTS(SELECT 1 FROM public.company x WHERE x.id=wanted_company AND x.tenant_id=app.current_tenant_id()) THEN RAISE EXCEPTION 'contract configuration permission unavailable' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_data)<>'object' OR octet_length(p_data::text)>100000 OR p_data->>'expiryNeverAutoEnds' IS DISTINCT FROM 'true' OR COALESCE((p_data->>'minimumTermMonths')::integer,0)<3 THEN RAISE EXCEPTION 'invalid contract configuration' USING ERRCODE='23514'; END IF;
 SELECT * INTO c FROM public.contract_configuration WHERE company_id=wanted_company AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF coalesce(c.revision,0)<>expected_revision THEN RAISE EXCEPTION 'contract configuration changed' USING ERRCODE='40001'; END IF;
 IF (p_runtime IS DISTINCT FROM coalesce(c.runtime_enabled,false) OR p_effect_principal IS DISTINCT FROM c.effect_principal_id OR p_activation IS DISTINCT FROM c.activation_on) AND NOT app.contract_hr_admin(wanted_company) THEN RAISE EXCEPTION 'runtime activation and executor nomination require scoped HR authority' USING ERRCODE='42501'; END IF;
 IF p_effect_principal IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment a ON a.app_user_id=u.id AND a.tenant_id=u.tenant_id WHERE u.id=p_effect_principal AND u.tenant_id=app.current_tenant_id() AND app.contract_active_user(u.id) AND a.role::text IN('hr_admin','super_admin') AND (a.company_id IS NULL OR a.company_id=wanted_company OR app.is_company_descendant(wanted_company,a.company_id))) THEN RAISE EXCEPTION 'nominate an active scoped HR executor' USING ERRCODE='42501'; END IF;
 IF p_runtime AND (p_activation IS NULL OR p_effect_principal IS NULL OR NOT coalesce((p_data->>'ownersConfirmed')::boolean,false) OR (SELECT count(*) FROM public.contract_template t WHERE t.company_id=wanted_company AND t.tenant_id=app.current_tenant_id() AND t.live_version IS NOT NULL)<>4 OR (SELECT count(*) FROM public.contract_workflow w WHERE w.company_id=wanted_company AND w.tenant_id=app.current_tenant_id() AND w.required AND w.enabled AND w.published_version IS NOT NULL)<5) THEN RAISE EXCEPTION 'confirm policy owners and publish all required workflows and templates before activation' USING ERRCODE='23514'; END IF;
 next_revision:=coalesce(c.revision,0)+1;
 INSERT INTO public.contract_configuration(tenant_id,company_id,revision,data,runtime_enabled,activation_on,effect_principal_id,updated_by) VALUES(app.current_tenant_id(),wanted_company,next_revision,p_data,p_runtime,p_activation,p_effect_principal,app.current_user_id()) ON CONFLICT(company_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,runtime_enabled=excluded.runtime_enabled,activation_on=excluded.activation_on,effect_principal_id=excluded.effect_principal_id,updated_by=excluded.updated_by,updated_at=now();
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(app.current_tenant_id(),'contract-configuration',wanted_company,'contract.configuration.saved','user',app.current_user_id(),jsonb_build_object('revision',next_revision,'runtimeEnabled',p_runtime,'effectPrincipalId',p_effect_principal));
 RETURN next_revision;
END $$;
CREATE FUNCTION app.contract_assign_role(wanted_company uuid,wanted_unit uuid,wanted_user uuid,wanted_role text,from_day date,to_day date,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.contract_active_user(app.current_user_id()) OR NOT app.contract_hr_admin(wanted_company) OR NOT app.contract_active_user(wanted_user) OR wanted_role NOT IN('pbp','gbs','rewards','legal','template_approver') OR from_day IS NULL OR to_day<from_day OR length(btrim(coalesce(p_reason,'')))<10 OR (wanted_unit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.business_unit b WHERE b.id=wanted_unit AND b.tenant_id=app.current_tenant_id() AND (b.company_id=wanted_company OR b.is_global))) THEN RAISE EXCEPTION 'invalid scoped contract role assignment' USING ERRCODE='42501'; END IF;
 INSERT INTO public.contract_role_assignment(tenant_id,company_id,business_unit_id,user_id,role,valid_from,valid_to,created_by) VALUES(app.current_tenant_id(),wanted_company,wanted_unit,wanted_user,wanted_role,from_day,to_day,app.current_user_id()) RETURNING id INTO result;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(app.current_tenant_id(),'contract-role-assignment',result,'contract.role.assigned','user',app.current_user_id(),jsonb_build_object('companyId',wanted_company,'role',wanted_role,'userId',wanted_user,'reason',p_reason));RETURN result;
END $$;
CREATE FUNCTION app.contract_save_workflow(wanted_company uuid,wanted_id uuid,expected_revision integer,p_definition jsonb,p_publish boolean,p_confirm_pause boolean DEFAULT false) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.contract_workflow;version integer;step jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();IF NOT app.contract_configure(wanted_company) THEN RAISE EXCEPTION 'contract workflow permission unavailable' USING ERRCODE='42501'; END IF;
 IF p_definition->>'module' IS DISTINCT FROM 'contract_staff' OR p_definition->>'id' IS DISTINCT FROM wanted_id::text OR jsonb_typeof(p_definition->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(p_definition->'steps') NOT BETWEEN 1 AND 40 OR octet_length(p_definition::text)>200000 THEN RAISE EXCEPTION 'invalid contract workflow' USING ERRCODE='23514'; END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(p_definition->'steps') LOOP IF step->>'type' NOT IN('generate_document','request_approval','wait_signature','update_record','start_offboarding','notify') OR step ? 'sql' THEN RAISE EXCEPTION 'invalid contract workflow step' USING ERRCODE='23514'; END IF; END LOOP;
 SELECT * INTO w FROM public.contract_workflow WHERE id=wanted_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF coalesce(w.revision,0)<>expected_revision OR w.id IS NOT NULL AND w.company_id<>wanted_company THEN RAISE EXCEPTION 'contract workflow changed' USING ERRCODE='40001'; END IF;
 IF coalesce(w.required,false) AND (NOT coalesce((p_definition->>'enabled')::boolean,false) OR NOT coalesce((p_definition->>'required')::boolean,false)) AND NOT p_confirm_pause THEN RAISE EXCEPTION 'confirm pausing a required workflow' USING ERRCODE='23514'; END IF;
 version:=coalesce(w.published_version,0)+1;
 INSERT INTO public.contract_workflow(id,tenant_id,company_id,revision,draft,required,enabled) VALUES(wanted_id,app.current_tenant_id(),wanted_company,coalesce(w.revision,0)+1,p_definition,(p_definition->>'required')::boolean,(p_definition->>'enabled')::boolean) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,draft=excluded.draft;
 IF p_publish THEN
 INSERT INTO public.contract_workflow_version(workflow_id,tenant_id,version,definition,published_by) VALUES(wanted_id,app.current_tenant_id(),version,p_definition,app.current_user_id());
 UPDATE public.contract_workflow SET published_version=version,required=(p_definition->>'required')::boolean,enabled=(p_definition->>'enabled')::boolean WHERE id=wanted_id;
 END IF;RETURN coalesce(w.revision,0)+1;
END $$;
CREATE FUNCTION app.contract_save_template(wanted_company uuid,wanted_id uuid,wanted_type text,expected_revision integer,p_document jsonb,p_letterhead bytea,p_signatory_name text,p_signatory_title text,p_submit boolean) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t public.contract_template;
BEGIN
 PERFORM app.access_workforce_write_lock();IF NOT app.contract_has_role(wanted_company,NULL,'gbs') OR wanted_type NOT IN('renewal','end','declined','retirement') OR octet_length(p_document::text)>1000000 OR jsonb_typeof(p_document->'blocks') IS DISTINCT FROM 'array' OR octet_length(p_letterhead)>1048576 THEN RAISE EXCEPTION 'contract template permission or document invalid' USING ERRCODE='42501'; END IF;
 SELECT * INTO t FROM public.contract_template WHERE id=wanted_id AND tenant_id=app.current_tenant_id() FOR UPDATE;IF coalesce(t.revision,0)<>expected_revision OR t.id IS NOT NULL AND (t.company_id<>wanted_company OR t.type<>wanted_type) THEN RAISE EXCEPTION 'contract template changed' USING ERRCODE='40001'; END IF;
 IF p_submit AND (length(btrim(p_signatory_name))=0 OR length(btrim(p_signatory_title))=0) THEN RAISE EXCEPTION 'set legal entity signatory' USING ERRCODE='23514'; END IF;
 INSERT INTO public.contract_template(id,tenant_id,company_id,type,revision,draft,letterhead,signatory_name,signatory_title,draft_submitted_at,draft_submitted_by) VALUES(wanted_id,app.current_tenant_id(),wanted_company,wanted_type,coalesce(t.revision,0)+1,p_document,p_letterhead,p_signatory_name,p_signatory_title,CASE WHEN p_submit THEN now() END,CASE WHEN p_submit THEN app.current_user_id() END) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,draft=excluded.draft,letterhead=excluded.letterhead,signatory_name=excluded.signatory_name,signatory_title=excluded.signatory_title,draft_submitted_at=excluded.draft_submitted_at,draft_submitted_by=excluded.draft_submitted_by;
 RETURN coalesce(t.revision,0)+1;
END $$;
CREATE FUNCTION app.contract_publish_template(wanted_id uuid,expected_revision integer,p_approve boolean,p_reason text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t public.contract_template;version integer;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO t FROM public.contract_template WHERE id=wanted_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF t.id IS NULL OR NOT(app.contract_has_role(t.company_id,NULL,'legal') OR app.contract_has_role(t.company_id,NULL,'template_approver')) OR app.current_user_id()=t.draft_submitted_by THEN RAISE EXCEPTION 'independent configured template approver required' USING ERRCODE='42501'; END IF;
 IF p_approve IS NULL OR t.revision<>expected_revision OR t.draft_submitted_at IS NULL THEN RAISE EXCEPTION 'template approval changed' USING ERRCODE='40001'; END IF;
 IF NOT p_approve AND length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'rejection comment required' USING ERRCODE='23514'; END IF;
 version:=coalesce(t.live_version,0)+1;
 IF p_approve THEN INSERT INTO public.contract_template_version(template_id,tenant_id,version,document,letterhead,signatory_name,signatory_title,approved_by) VALUES(t.id,t.tenant_id,version,t.draft,t.letterhead,t.signatory_name,t.signatory_title,app.current_user_id()); END IF;
 UPDATE public.contract_template SET revision=revision+1,live_version=CASE WHEN p_approve THEN version ELSE live_version END,draft_submitted_at=NULL,draft_submitted_by=NULL WHERE id=t.id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t.tenant_id,'contract-template',t.id,CASE WHEN p_approve THEN 'contract.template.published' ELSE 'contract.template.returned' END,'user',app.current_user_id(),jsonb_build_object('version',CASE WHEN p_approve THEN version END,'reason',p_reason));RETURN t.revision+1;
END $$;
REVOKE ALL ON FUNCTION app.contract_save_configuration(uuid,integer,jsonb,boolean,uuid,date),app.contract_assign_role(uuid,uuid,uuid,text,date,date,text),app.contract_save_workflow(uuid,uuid,integer,jsonb,boolean,boolean),app.contract_save_template(uuid,uuid,text,integer,jsonb,bytea,text,text,boolean),app.contract_publish_template(uuid,integer,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_save_configuration(uuid,integer,jsonb,boolean,uuid,date),app.contract_assign_role(uuid,uuid,uuid,text,date,date,text),app.contract_save_workflow(uuid,uuid,integer,jsonb,boolean,boolean),app.contract_save_template(uuid,uuid,text,integer,jsonb,bytea,text,text,boolean),app.contract_publish_template(uuid,integer,boolean,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_intake_source(wanted_employment uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.contract_source(e.id) FROM public.employment e WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id() AND app.contract_configure(e.company_id); $$;
CREATE FUNCTION app.contract_intake(wanted_employment uuid,p_kind text,p_source_revision text,p_retirement_event uuid DEFAULT NULL,p_health_event uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;cfg public.contract_configuration;term public.contract_term;existing public.contract_case;case_id uuid:=gen_random_uuid();term_id uuid:=gen_random_uuid();version integer;number text;n bigint;data jsonb;purpose text:=CASE WHEN p_retirement_event IS NULL THEN 'expiry' ELSE 'initial' END;
BEGIN
 PERFORM app.access_workforce_write_lock();PERFORM 1 FROM public.employment WHERE id=wanted_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 source:=app.contract_source(wanted_employment);IF source IS NULL OR NOT app.contract_configure((source->>'companyId')::uuid) OR NOT app.contract_runtime((source->>'companyId')::uuid) THEN RAISE EXCEPTION 'contract runtime or intake authority unavailable' USING ERRCODE='42501'; END IF;
 IF source->>'sourceRevision' IS DISTINCT FROM p_source_revision OR p_kind NOT IN('maternity_cover','project','post_retirement') OR source->>'startOn' IS NULL OR source->>'endOn' IS NULL OR source->>'salaryCents' IS NULL OR source->>'allowanceCents' IS NULL OR source->>'currency'<>'MYR' OR coalesce((source->>'ended')::boolean,false) THEN RAISE EXCEPTION 'verify the current Personnel contract dates, pay currency and source' USING ERRCODE='40001'; END IF;
 IF (p_retirement_event IS NULL) IS DISTINCT FROM (p_health_event IS NULL) THEN RAISE EXCEPTION 'both retirement proof references are required' USING ERRCODE='23514'; END IF;
 IF p_retirement_event IS NOT NULL AND (p_kind<>'post_retirement' OR NOT EXISTS(SELECT 1 FROM public.contract_retirement_custody proof WHERE proof.tenant_id=app.current_tenant_id() AND proof.employment_id=wanted_employment AND proof.approval_event_id=p_retirement_event AND proof.health_event_id=p_health_event AND proof.verified_at IS NOT NULL AND proof.verified_by<>proof.captured_by AND proof.source_revision=p_source_revision AND EXISTS(SELECT 1 FROM public.employee_document d WHERE d.id=proof.approval_document_id AND d.tenant_id=proof.tenant_id AND d.employment_id=proof.employment_id AND encode(sha256(d.content),'hex')=proof.approval_hash) AND EXISTS(SELECT 1 FROM public.employee_document d WHERE d.id=proof.health_document_id AND d.tenant_id=proof.tenant_id AND d.employment_id=proof.employment_id AND encode(sha256(d.content),'hex')=proof.health_hash))) THEN RAISE EXCEPTION 'verified retirement custody for the unchanged approved terms is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO cfg FROM public.contract_configuration WHERE company_id=(source->>'companyId')::uuid AND tenant_id=app.current_tenant_id() FOR UPDATE;
 SELECT * INTO term FROM public.contract_term WHERE employment_id=wanted_employment AND tenant_id=app.current_tenant_id() ORDER BY version DESC LIMIT 1 FOR UPDATE;
 IF term.id IS NOT NULL AND term.start_on=(source->>'startOn')::date AND term.end_on=(source->>'endOn')::date THEN
 SELECT * INTO existing FROM public.contract_case WHERE term_id=term.id AND contract_case.purpose=purpose;
 IF existing.id IS NOT NULL THEN RETURN existing.id; END IF; IF p_retirement_event IS NOT NULL AND term.version<>1 THEN RAISE EXCEPTION 'only first post-retirement term can use verified retirement approval' USING ERRCODE='23514'; END IF;term_id:=term.id;version:=term.version;
 ELSE
 IF term.id IS NOT NULL AND EXISTS(SELECT 1 FROM public.contract_case c WHERE c.term_id=term.id AND c.data->>'state' NOT IN('renewed','handed_off','cancelled')) THEN RAISE EXCEPTION 'reconcile the existing case instead of creating another end-date case' USING ERRCODE='40001'; END IF;
 version:=coalesce(term.version,0)+1;
 IF p_retirement_event IS NOT NULL AND (p_kind<>'post_retirement' OR version<>1 OR NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.id=p_retirement_event AND e.tenant_id=app.current_tenant_id() AND e.subject_employment_id=wanted_employment AND e.event_type='retirement.contract-approved') OR NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.id=p_health_event AND e.tenant_id=app.current_tenant_id() AND e.subject_employment_id=wanted_employment AND e.event_type='retirement.health-check-completed')) THEN RAISE EXCEPTION 'verified retirement approval and completed health-check source events are required' USING ERRCODE='42501'; END IF;
 INSERT INTO public.contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision,predecessor_id,retirement_source_id,health_completed_at) VALUES(term_id,app.current_tenant_id(),(source->>'companyId')::uuid,wanted_employment,version,p_kind,(source->>'startOn')::date,(source->>'endOn')::date,p_source_revision,term.id,p_retirement_event,CASE WHEN p_health_event IS NOT NULL THEN now() END);
 END IF;
 INSERT INTO public.tenant_counter(tenant_id,kind,value) VALUES(app.current_tenant_id(),'contract-'||to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY'),1) ON CONFLICT(tenant_id,kind) DO UPDATE SET value=tenant_counter.value+1 RETURNING value INTO n;
 number:='CT-'||to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY')||'-'||lpad(n::text,4,'0');
 data:=jsonb_build_object('id',case_id,'number',number,'term',jsonb_build_object('id',term_id,'employmentId',wanted_employment,'companyId',source->>'companyId','kind',p_kind,'version',version,'startOn',source->>'startOn','endOn',source->>'endOn','salaryCents',source->>'salaryCents','allowanceCents',source->>'allowanceCents','sourceRevision',p_source_revision),'revision',1,'state',CASE WHEN (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date >= (source->>'endOn')::date-(cfg.data->>'firstAlertDays')::integer THEN 'decision_pending' ELSE 'upcoming' END,'settings',cfg.data,'decision',NULL,'decisionHistory','[]'::jsonb,'approvals','[]'::jsonb,'document',NULL,'effects',jsonb_build_object('personnel',NULL,'payroll',NULL,'verificationTask',NULL,'offboarding',NULL,'manualHandoff',NULL),'sourceRetirementApprovalId',p_retirement_event,'healthCompletedAt',CASE WHEN p_health_event IS NOT NULL THEN now()::text END);
 IF p_retirement_event IS NOT NULL THEN data:=data||jsonb_build_object('state','in_approval','decision',jsonb_build_object('revision',1,'kind','renew','months',NULL,'startOn',source->>'startOn','endOn',source->>'endOn','salaryCents',source->>'salaryCents','allowanceCents',source->>'allowanceCents','reason','Approved first post-retirement contract','submittedBy',(SELECT actor_id FROM public.domain_event WHERE id=p_retirement_event),'submittedAt',(SELECT occurred_at FROM public.domain_event WHERE id=p_retirement_event),'confirmedBy',(SELECT actor_id FROM public.domain_event WHERE id=p_retirement_event),'confirmedAt',(SELECT occurred_at FROM public.domain_event WHERE id=p_retirement_event))); END IF;
 INSERT INTO public.contract_case(id,tenant_id,company_id,employment_id,term_id,purpose,number,data) VALUES(case_id,app.current_tenant_id(),(source->>'companyId')::uuid,wanted_employment,term_id,purpose,number,data);PERFORM app.contract_audit(case_id,'case.created');RETURN case_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_intake_source(uuid),app.contract_intake(uuid,text,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_intake_source(uuid),app.contract_intake(uuid,text,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_conditions_match(p_conditions jsonb,p_data jsonb,wanted_unit uuid) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c jsonb;v text;expected text;
BEGIN
 FOR c IN SELECT value FROM jsonb_array_elements(coalesce(p_conditions,'[]')) LOOP
 v:=CASE c->>'field' WHEN 'decision' THEN p_data->'decision'->>'kind' WHEN 'contractType' THEN p_data->'term'->>'kind' WHEN 'businessGroup' THEN wanted_unit::text WHEN 'payChanges' THEN ((p_data->'decision'->>'salaryCents')::numeric IS DISTINCT FROM (p_data->'term'->>'salaryCents')::numeric OR (p_data->'decision'->>'allowanceCents')::numeric IS DISTINCT FROM (p_data->'term'->>'allowanceCents')::numeric)::text WHEN 'termMonths' THEN p_data->'decision'->>'months' END;expected:=c->>'value';
 IF CASE c->>'op' WHEN 'is' THEN v IS DISTINCT FROM expected WHEN 'isNot' THEN v IS NOT DISTINCT FROM expected WHEN 'gte' THEN c->>'field'<>'termMonths' OR coalesce(v::integer,0)<expected::integer WHEN 'lt' THEN c->>'field'<>'termMonths' OR coalesce(v::integer,0)>=expected::integer ELSE true END THEN RETURN false; END IF;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION app.contract_approver_users(wanted_case uuid,p_resolver jsonb) RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;unit uuid;field text:=p_resolver->>'field';role text:=p_resolver->>'role';
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id();IF c.id IS NULL THEN RETURN; END IF;unit:=app.contract_business_unit(c.employment_id);
 IF p_resolver->>'type'='named_employee' THEN RETURN QUERY SELECT DISTINCT x.value::uuid FROM jsonb_array_elements_text(p_resolver->'userIds') x WHERE app.contract_active_user(x.value::uuid);
 ELSIF p_resolver->>'type'='employee_record' AND field='manager' THEN RETURN QUERY SELECT app.contract_manager_users(c.employment_id);
 ELSIF p_resolver->>'type'='employee_record' AND field IN('ceo','hod') THEN
 RETURN QUERY SELECT app.contract_users_for_employment(CASE WHEN field='ceo' THEN b.head_employment_id ELSE d.head_employment_id END) FROM public.assignment a LEFT JOIN public.business_unit b ON b.id=a.business_unit_id AND b.tenant_id=a.tenant_id LEFT JOIN public.department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id WHERE a.employment_id=c.employment_id AND a.tenant_id=c.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY 1;
 ELSE
 IF p_resolver->>'type'='employee_record' AND field='pbp' THEN role:='pbp'; END IF;
 RETURN QUERY SELECT DISTINCT a.user_id FROM public.contract_role_assignment a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND (a.business_unit_id IS NULL OR a.business_unit_id=unit) AND a.role=role AND app.contract_active_user(a.user_id) AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
 IF role='rewards' THEN RETURN QUERY SELECT DISTINCT m.user_id FROM public.reward_member m JOIN public.reward_unit r ON r.id=m.unit_id AND r.tenant_id=m.tenant_id WHERE r.tenant_id=c.tenant_id AND r.company_id=c.company_id AND r.business_unit_id=unit AND r.deleted_at IS NULL AND m.role='gr' AND app.reward_member_eligible_internal(m.id); END IF;
 END IF;
END $$;
CREATE FUNCTION app.contract_case_approval_actor(wanted_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_case c JOIN public.contract_workflow_version v ON v.workflow_id=c.workflow_id AND v.version=c.workflow_version AND v.tenant_id=c.tenant_id CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') s WHERE c.id=wanted_case AND c.tenant_id=app.current_tenant_id() AND s->>'type'='request_approval' AND app.current_user_id() IN(SELECT app.contract_approver_users(c.id,s->'approver')) AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.data->'approvals') a WHERE a->>'id'=s->>'id' AND a->>'state' IN('pending','approved','rejected') AND app.current_user_id()::text IN(SELECT jsonb_array_elements_text(a->'holderIds')))); $$;
CREATE OR REPLACE FUNCTION app.contract_case_access(wanted_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_case c WHERE c.id=wanted_case AND c.tenant_id=app.current_tenant_id() AND app.contract_active_user(app.current_user_id()) AND (app.contract_configure(c.company_id) OR app.contract_has_role(c.company_id,app.contract_business_unit(c.employment_id),'pbp') OR app.current_user_id() IN(SELECT app.contract_manager_users(c.employment_id)) OR app.current_user_id() IN(SELECT app.contract_users_for_employment(c.employment_id)) OR app.contract_case_approval_actor(c.id))); $$;
CREATE FUNCTION app.contract_approval_route(wanted_case uuid,p_data jsonb,wanted_workflow uuid,wanted_version integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;v public.contract_workflow_version;s jsonb;holders jsonb;result jsonb:='[]';stage integer:=0;skip boolean;
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id();SELECT * INTO v FROM public.contract_workflow_version WHERE workflow_id=wanted_workflow AND version=wanted_version AND tenant_id=app.current_tenant_id();
 IF c.id IS NULL OR v.workflow_id IS NULL THEN RAISE EXCEPTION 'published contract route unavailable' USING ERRCODE='23514'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(v.definition->'steps') WHERE value->>'type'='request_approval' LOOP
 skip:=NOT app.contract_conditions_match(s->'conditions',p_data,app.contract_business_unit(c.employment_id));
 SELECT coalesce(jsonb_agg(u ORDER BY u),'[]'::jsonb) INTO holders FROM (SELECT DISTINCT app.contract_approver_users(c.id,s->'approver') u) users;
 IF NOT skip AND (jsonb_array_length(holders)=0 OR holders ? (p_data->'decision'->>'submittedBy')) THEN RAISE EXCEPTION 'resolve every independent contract approver before submission' USING ERRCODE='23514'; END IF;
 result:=result||jsonb_build_array(jsonb_build_object('id',s->>'id','name',s->>'name','stage',stage,'holderIds',CASE WHEN skip THEN '[]'::jsonb ELSE holders END,'quorum',s->>'quorum','when',CASE WHEN s->'conditions' @> '[{"field":"payChanges","op":"is","value":"true"}]'::jsonb THEN 'pay_changed' ELSE 'always' END,'state',CASE WHEN skip THEN 'skipped' ELSE 'pending' END,'actions','[]'::jsonb));stage:=stage+1;
 END LOOP;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_conditions_match(jsonb,jsonb,uuid),app.contract_approver_users(uuid,jsonb),app.contract_case_approval_actor(uuid),app.contract_approval_route(uuid,jsonb,uuid,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_commit_case(wanted_case uuid,p_data jsonb,p_action text,p_detail jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;result jsonb;
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;IF c.id IS NULL THEN RAISE EXCEPTION 'contract case unavailable' USING ERRCODE='42501'; END IF;
 result:=p_data||jsonb_build_object('revision',c.revision+1);UPDATE public.contract_case SET revision=revision+1,data=result,updated_at=now() WHERE id=c.id;PERFORM app.contract_audit(c.id,p_action,p_detail);RETURN result;
END $$;
CREATE FUNCTION app.contract_issue_if_complete(wanted_case uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;d public.contract_document;data jsonb;
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;data:=c.data;
 IF data->>'state'<>'in_approval' OR data->'decision'->>'confirmedAt' IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(data->'approvals') s WHERE s->>'state' NOT IN('approved','skipped')) OR (jsonb_array_length(data->'approvals')=0 AND data->>'sourceRetirementApprovalId' IS NULL) THEN RETURN data; END IF;
 IF data->'decision'->>'kind'='end' THEN RETURN app.contract_commit_case(c.id,data||jsonb_build_object('state','ending'),'approvals.completed'); END IF;
 SELECT * INTO d FROM public.contract_document WHERE case_id=c.id AND tenant_id=c.tenant_id AND decision_revision=(data->'decision'->>'revision')::integer AND type='renewal' AND superseded_at IS NULL ORDER BY created_at DESC,id LIMIT 1 FOR UPDATE;
 IF d.id IS NULL THEN RETURN data; END IF;
 IF d.issued_at IS NULL THEN UPDATE public.contract_document SET issued_at=now() WHERE id=d.id;END IF;
 RETURN app.contract_commit_case(c.id,data||jsonb_build_object('state','e_acceptance','document',jsonb_build_object('id',d.id,'hash',d.content_hash,'templateId',d.template_id,'templateVersion',d.template_version,'decisionRevision',d.decision_revision,'issuedAt',coalesce(d.issued_at,now())::text,'acceptedAt',NULL,'declinedAt',NULL,'declineReason',NULL)),'document.issued',jsonb_build_object('documentId',d.id,'hash',d.content_hash));
END $$;
CREATE FUNCTION app.contract_case_command(wanted_case uuid,expected_revision integer,p_command text,p_args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;data jsonb;decision jsonb;v public.contract_workflow_version;w public.contract_workflow;route jsonb;s jsonb;step jsonb;definition jsonb;actions jsonb;next_steps jsonb:='[]';stage integer;approved boolean;new_start date;new_end date;months integer;actor uuid:=app.current_user_id();source jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR NOT app.contract_case_access(c.id) OR NOT app.contract_runtime(c.company_id) THEN RAISE EXCEPTION 'contract action or runtime unavailable' USING ERRCODE='42501'; END IF;
 IF c.revision<>expected_revision THEN RAISE EXCEPTION 'contract case changed; reload before acting' USING ERRCODE='40001'; END IF;data:=c.data;source:=app.contract_source(c.employment_id);
 IF p_command IN('propose','confirm','approve','reject') AND (source->>'sourceRevision' IS DISTINCT FROM data->'term'->>'sourceRevision' OR coalesce((source->>'ended')::boolean,false)) THEN RAISE EXCEPTION 'Personnel source changed; reconcile the current case before continuing' USING ERRCODE='40001'; END IF;
 IF p_command='propose' THEN
 IF data->>'state' NOT IN('upcoming','decision_pending') OR p_args->>'kind' NOT IN('renew','end') OR length(btrim(coalesce(p_args->>'reason','')))=0 OR length(p_args->>'reason')>5000 OR (p_args->>'kind'='renew' AND NOT app.contract_case_manager(c.id)) OR (p_args->>'kind'='end' AND NOT app.contract_case_pbp(c.id)) THEN RAISE EXCEPTION 'current LM renewal or PBP end decision required' USING ERRCODE='42501'; END IF;
 IF p_args->>'kind'='renew' THEN
 months:=(p_args->>'months')::integer;IF months IS NULL OR months<(data->'settings'->>'minimumTermMonths')::integer OR months>120 OR NOT coalesce(p_args->>'salaryCents' ~ '^(0|[1-9][0-9]{0,11})$',false) OR NOT coalesce(p_args->>'allowanceCents' ~ '^(0|[1-9][0-9]{0,11})$',false) THEN RAISE EXCEPTION 'valid minimum term and exact RM amounts required' USING ERRCODE='23514'; END IF;
 new_start:=(data->'term'->>'endOn')::date+1;new_end:=(new_start+make_interval(months=>months))::date-1;
 ELSE new_end:=(data->'term'->>'endOn')::date;END IF;
 decision:=jsonb_build_object('revision',coalesce((data->'decision'->>'revision')::integer,0)+1,'kind',p_args->>'kind','months',months,'startOn',new_start,'endOn',new_end,'salaryCents',CASE WHEN p_args->>'kind'='renew' THEN p_args->>'salaryCents' ELSE data->'term'->>'salaryCents' END,'allowanceCents',CASE WHEN p_args->>'kind'='renew' THEN p_args->>'allowanceCents' ELSE data->'term'->>'allowanceCents' END,'reason',btrim(p_args->>'reason'),'submittedBy',actor,'submittedAt',now()::text,'confirmedBy',NULL,'confirmedAt',NULL);
 data:=data||jsonb_build_object('state','decision_pending','decision',decision,'decisionHistory',CASE WHEN data->'decision'='null'::jsonb THEN data->'decisionHistory' ELSE data->'decisionHistory'||jsonb_build_array(data->'decision') END,'approvals','[]'::jsonb,'document',NULL);
 ELSIF p_command='confirm' THEN
 IF data->>'state'<>'decision_pending' OR data->'decision'='null'::jsonb OR NOT app.contract_case_pbp(c.id) OR data->'decision'->>'kind'='renew' AND data->'decision'->>'submittedBy'=actor::text THEN RAISE EXCEPTION 'independent assigned PBP confirmation required' USING ERRCODE='42501'; END IF;
 data:=jsonb_set(data,'{decision}',data->'decision'||jsonb_build_object('confirmedBy',actor,'confirmedAt',now()::text));
 SELECT * INTO w FROM public.contract_workflow WHERE id=(p_args->>'workflowId')::uuid AND tenant_id=c.tenant_id AND company_id=c.company_id AND enabled AND published_version IS NOT NULL;
 SELECT * INTO v FROM public.contract_workflow_version WHERE workflow_id=w.id AND version=w.published_version AND tenant_id=c.tenant_id;
 IF w.id IS NULL OR v.definition->'trigger'->>'event'<>'decisionSubmitted' OR NOT app.contract_conditions_match(v.definition->'conditions',data,app.contract_business_unit(c.employment_id)) THEN RAISE EXCEPTION 'choose the matching published Contract staff decision workflow' USING ERRCODE='23514'; END IF;
 route:=app.contract_approval_route(c.id,data,w.id,w.published_version);
 IF data->'decision'->>'kind'='renew' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(route) a WHERE a->>'state'='pending') THEN RAISE EXCEPTION 'renewal requires an active independent approval route' USING ERRCODE='23514'; END IF;
 IF data->'decision'->>'kind'='end' AND NOT coalesce((data->'settings'->>'endApprovalEnabled')::boolean,false) THEN route:='[]'; END IF;
 UPDATE public.contract_case SET workflow_id=w.id,workflow_version=w.published_version WHERE id=c.id;
 data:=data||jsonb_build_object('approvals',route,'state',CASE WHEN data->'decision'->>'kind'='end' AND jsonb_array_length(route)=0 THEN 'ending' ELSE 'in_approval' END);
 ELSIF p_command IN('approve','reject') THEN
 IF data->>'state'<>'in_approval' OR (p_args->>'decisionRevision')::integer IS DISTINCT FROM (data->'decision'->>'revision')::integer OR data->'decision'->>'submittedBy'=actor::text THEN RAISE EXCEPTION 'current independent approval required' USING ERRCODE='42501'; END IF;
 SELECT min((a->>'stage')::integer) INTO stage FROM jsonb_array_elements(data->'approvals') a WHERE a->>'state'='pending';
 SELECT a INTO step FROM jsonb_array_elements(data->'approvals') a WHERE a->>'id'=p_args->>'stepId' AND a->>'state'='pending' AND (a->>'stage')::integer=stage;
 SELECT s1 INTO definition FROM public.contract_workflow_version x CROSS JOIN LATERAL jsonb_array_elements(x.definition->'steps') s1 WHERE x.workflow_id=c.workflow_id AND x.version=c.workflow_version AND x.tenant_id=c.tenant_id AND s1->>'id'=step->>'id';
 IF step IS NULL OR NOT(step->'holderIds' ? actor::text) OR actor NOT IN(SELECT app.contract_approver_users(c.id,definition->'approver')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(step->'actions') a WHERE a->>'actorId'=actor::text) THEN RAISE EXCEPTION 'only the current assigned eligible approver can act once' USING ERRCODE='42501'; END IF;
 IF p_command='reject' AND length(btrim(coalesce(p_args->>'comment','')))=0 THEN RAISE EXCEPTION 'rejection comment required' USING ERRCODE='23514'; END IF;
 actions:=step->'actions'||jsonb_build_array(jsonb_build_object('actorId',actor,'action',CASE WHEN p_command='approve' THEN 'approve' ELSE 'reject' END,'comment',btrim(coalesce(p_args->>'comment','')),'at',now()::text));
 approved:=step->>'quorum'='any' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(step->'holderIds') holder WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(actions) a WHERE a->>'actorId'=holder AND a->>'action'='approve'));
 FOR s IN SELECT value FROM jsonb_array_elements(data->'approvals') LOOP
 next_steps:=next_steps||jsonb_build_array(CASE WHEN s->>'id'=step->>'id' THEN s||jsonb_build_object('actions',actions,'state',CASE WHEN p_command='reject' THEN 'rejected' WHEN approved THEN 'approved' ELSE 'pending' END) ELSE s END);END LOOP;
 data:=jsonb_set(data,'{approvals}',next_steps);
 IF p_command='reject' THEN data:=data||jsonb_build_object('state','decision_pending','document',NULL,'decision',data->'decision'||jsonb_build_object('confirmedBy',NULL,'confirmedAt',NULL));UPDATE public.contract_document SET superseded_at=now() WHERE case_id=c.id AND issued_at IS NULL AND superseded_at IS NULL;END IF;
 ELSIF p_command='cancel' THEN
 IF NOT app.contract_configure(c.company_id) OR length(btrim(coalesce(p_args->>'reason','')))=0 OR data->>'state' IN('records_pending','renewed','handed_off') THEN RAISE EXCEPTION 'recorded cancellation is unavailable after committed effects' USING ERRCODE='42501'; END IF;data:=data||jsonb_build_object('state','cancelled');
 ELSE RAISE EXCEPTION 'unsupported contract command' USING ERRCODE='23514'; END IF;
 data:=app.contract_commit_case(c.id,data,'case.'||p_command,p_args-ARRAY['salaryCents','allowanceCents']);
 IF p_command='approve' THEN data:=app.contract_issue_if_complete(c.id); END IF;RETURN data;
END $$;
REVOKE ALL ON FUNCTION app.contract_commit_case(uuid,jsonb,text,jsonb),app.contract_issue_if_complete(uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.contract_case_command(uuid,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_case_command(uuid,integer,text,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_template_for_case(wanted_case uuid,wanted_type text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',t.id,'version',v.version,'type',t.type,'document',v.document,'letterhead',encode(v.letterhead,'base64'),'signatoryName',v.signatory_name,'signatoryTitle',v.signatory_title)
 FROM public.contract_case c JOIN public.contract_template t ON t.company_id=c.company_id AND t.tenant_id=c.tenant_id AND t.type=wanted_type JOIN public.contract_template_version v ON v.template_id=t.id AND v.version=t.live_version AND v.tenant_id=t.tenant_id WHERE c.id=wanted_case AND c.tenant_id=app.current_tenant_id() AND (app.contract_case_pbp(c.id) OR app.contract_has_role(c.company_id,NULL,'gbs'));
$$;
CREATE FUNCTION app.contract_store_document(wanted_case uuid,expected_revision integer,wanted_template uuid,wanted_version integer,p_type text,p_pdf bytea,p_values jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;t public.contract_template;v public.contract_template_version;doc_id uuid:=gen_random_uuid();hash text:=encode(sha256(p_pdf),'hex');expected_type text;data jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR NOT app.contract_runtime(c.company_id) OR NOT(app.contract_case_pbp(c.id) OR app.contract_has_role(c.company_id,NULL,'gbs')) THEN RAISE EXCEPTION 'contract document authority or runtime unavailable' USING ERRCODE='42501'; END IF;
 IF c.revision<>expected_revision OR c.data->>'state' NOT IN('in_approval','ending') OR c.data->'decision'->>'confirmedAt' IS NULL THEN RAISE EXCEPTION 'current confirmed contract decision required' USING ERRCODE='40001'; END IF;
 expected_type:=CASE WHEN c.data->>'state'='in_approval' THEN 'renewal' WHEN c.data->'document'->>'declinedAt' IS NOT NULL THEN 'declined' WHEN c.data->'term'->>'kind'='post_retirement' THEN 'retirement' ELSE 'end' END;
 IF p_type<>expected_type OR octet_length(p_pdf) NOT BETWEEN 4 AND 10485760 OR convert_from(substring(p_pdf from 1 for 4),'UTF8')<>'%PDF' THEN RAISE EXCEPTION 'correct reviewed contract PDF required' USING ERRCODE='23514'; END IF;
 SELECT * INTO t FROM public.contract_template WHERE id=wanted_template AND tenant_id=c.tenant_id AND company_id=c.company_id AND type=p_type;SELECT * INTO v FROM public.contract_template_version WHERE template_id=t.id AND version=wanted_version AND tenant_id=c.tenant_id;
 IF v.template_id IS NULL OR t.live_version<>wanted_version THEN RAISE EXCEPTION 'generate from the current approved template version' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.contract_document WHERE case_id=c.id AND tenant_id=c.tenant_id AND type=p_type AND decision_revision=(c.data->'decision'->>'revision')::integer AND issued_at IS NOT NULL AND superseded_at IS NULL) THEN RAISE EXCEPTION 'issued contract document is immutable' USING ERRCODE='40001'; END IF;
 UPDATE public.contract_document SET superseded_at=now() WHERE case_id=c.id AND type=p_type AND issued_at IS NULL AND superseded_at IS NULL;
 INSERT INTO public.contract_document(id,tenant_id,case_id,template_id,template_version,decision_revision,type,content,content_hash,merge_values,created_by) VALUES(doc_id,c.tenant_id,c.id,t.id,v.version,(c.data->'decision'->>'revision')::integer,p_type,p_pdf,hash,p_values,app.current_user_id());
 data:=app.contract_commit_case(c.id,c.data||CASE WHEN p_type='renewal' THEN jsonb_build_object('document',jsonb_build_object('id',doc_id,'hash',hash,'templateId',t.id,'templateVersion',v.version,'decisionRevision',(c.data->'decision'->>'revision')::integer,'issuedAt',NULL,'acceptedAt',NULL,'declinedAt',NULL,'declineReason',NULL)) ELSE '{}'::jsonb END,'document.generated',jsonb_build_object('documentId',doc_id,'templateId',t.id,'templateVersion',v.version,'hash',hash));
 IF p_type='renewal' THEN data:=app.contract_issue_if_complete(c.id); END IF;RETURN jsonb_build_object('case',data,'documentId',doc_id);
END $$;
CREATE FUNCTION app.contract_accept_document(wanted_case uuid,expected_revision integer,wanted_document uuid,p_hash text,p_action text,p_reason text,p_signature jsonb,p_signed_pdf bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;d public.contract_document;data jsonb;signature_value jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR NOT app.contract_runtime(c.company_id) OR app.current_user_id() NOT IN(SELECT app.contract_users_for_employment(c.employment_id)) THEN RAISE EXCEPTION 'only the current employee can accept this contract' USING ERRCODE='42501'; END IF;
 IF app.contract_source(c.employment_id)->>'sourceRevision' IS DISTINCT FROM c.data->'term'->>'sourceRevision' THEN RAISE EXCEPTION 'Personnel contract source changed before acceptance' USING ERRCODE='40001'; END IF;
 SELECT * INTO d FROM public.contract_document WHERE id=wanted_document AND case_id=c.id AND tenant_id=c.tenant_id FOR UPDATE;
 IF c.revision<>expected_revision OR c.data->>'state'<>'e_acceptance' OR d.id IS NULL OR d.content_hash<>p_hash OR d.superseded_at IS NOT NULL OR d.issued_at IS NULL OR d.signature IS NOT NULL OR d.decision_revision IS DISTINCT FROM (c.data->'decision'->>'revision')::integer OR c.data->'document'->>'id'<>d.id::text THEN RAISE EXCEPTION 'review the exact current issued contract before acting' USING ERRCODE='40001'; END IF;
 IF p_action IS NULL OR p_action NOT IN('accept','decline') OR p_action='decline' AND length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'accept or decline with a reason' USING ERRCODE='23514'; END IF;
 IF p_action='accept' AND (p_signature->>'consent' IS DISTINCT FROM 'true' OR p_signature->>'method' NOT IN('typed','drawn') OR length(coalesce(p_signature->>'value','')) NOT BETWEEN 2 AND 200000 OR octet_length(p_signed_pdf) NOT BETWEEN 4 AND 10485760 OR convert_from(substring(p_signed_pdf from 1 for 4),'UTF8')<>'%PDF') THEN RAISE EXCEPTION 'verified employee signature and consent required' USING ERRCODE='23514'; END IF;
 signature_value:=jsonb_build_object('userId',app.current_user_id(),'at',now()::text,'action',p_action,'reason',nullif(btrim(p_reason),''),'documentHash',d.content_hash,'decisionRevision',d.decision_revision)||CASE WHEN p_action='accept' THEN jsonb_build_object('method',p_signature->>'method','value',p_signature->>'value','consent',true) ELSE '{}'::jsonb END;
 UPDATE public.contract_document SET signature=signature_value,signed_content=CASE WHEN p_action='accept' THEN p_signed_pdf END WHERE id=d.id;
 data:=jsonb_set(c.data,'{document}',c.data->'document'||jsonb_build_object('acceptedAt',CASE WHEN p_action='accept' THEN now()::text END,'declinedAt',CASE WHEN p_action='decline' THEN now()::text END,'declineReason',CASE WHEN p_action='decline' THEN btrim(p_reason) END));
 data:=data||jsonb_build_object('state',CASE WHEN p_action='accept' THEN 'records_pending' ELSE 'ending' END);
 IF p_action='accept' THEN INSERT INTO public.contract_effect(case_id,tenant_id,kind) VALUES(c.id,c.tenant_id,'records') ON CONFLICT DO NOTHING; END IF;
 RETURN app.contract_commit_case(c.id,data,'employee.'||p_action,jsonb_build_object('documentId',d.id,'hash',d.content_hash));
END $$;
CREATE FUNCTION app.contract_release_letter(wanted_case uuid,expected_revision integer,wanted_document uuid,p_hash text,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;d public.contract_document;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR NOT app.contract_runtime(c.company_id) OR NOT app.contract_has_role(c.company_id,NULL,'gbs') THEN RAISE EXCEPTION 'People Ops letter release permission unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM public.contract_document WHERE id=wanted_document AND case_id=c.id AND tenant_id=c.tenant_id FOR UPDATE;
 IF c.revision<>expected_revision OR c.data->>'state'<>'ending' OR d.id IS NULL OR d.type='renewal' OR d.content_hash<>p_hash OR d.decision_revision<>(c.data->'decision'->>'revision')::integer OR d.superseded_at IS NOT NULL OR d.released_at IS NOT NULL OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'review and release the current ending letter with a reason' USING ERRCODE='40001'; END IF;
 UPDATE public.contract_document SET issued_at=now(),released_at=now() WHERE id=d.id;
 INSERT INTO public.contract_effect(case_id,tenant_id,kind) VALUES(c.id,c.tenant_id,'offboarding') ON CONFLICT DO NOTHING;
 RETURN app.contract_commit_case(c.id,c.data,'letter.released',jsonb_build_object('documentId',d.id,'hash',d.content_hash,'reason',p_reason));
END $$;
REVOKE ALL ON FUNCTION app.contract_template_for_case(uuid,text),app.contract_store_document(uuid,integer,uuid,integer,text,bytea,jsonb),app.contract_accept_document(uuid,integer,uuid,text,text,text,jsonb,bytea),app.contract_release_letter(uuid,integer,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_template_for_case(uuid,text),app.contract_store_document(uuid,integer,uuid,integer,text,bytea,jsonb),app.contract_accept_document(uuid,integer,uuid,text,text,text,jsonb,bytea),app.contract_release_letter(uuid,integer,uuid,text,text) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE employee_document ADD COLUMN contract_document_id uuid REFERENCES contract_document(id);
CREATE UNIQUE INDEX employee_document_contract_source_uq ON employee_document(contract_document_id) WHERE contract_document_id IS NOT NULL;
CREATE POLICY employee_document_contract_filing ON employee_document FOR INSERT TO PUBLIC WITH CHECK(current_user<>'ai_hr_app' AND tenant_id=app.current_tenant_id() AND contract_document_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.contract_document d JOIN public.contract_case c ON c.id=d.case_id AND c.tenant_id=d.tenant_id WHERE d.id=contract_document_id AND d.tenant_id=employee_document.tenant_id AND c.employment_id=employee_document.employment_id AND (d.released_at IS NOT NULL OR d.signature->>'action'='accept')));
CREATE FUNCTION app.contract_filed_document_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN IF OLD.contract_document_id IS NOT NULL THEN RAISE EXCEPTION 'Issued contract documents are immutable; create a new approved version' USING ERRCODE='23514';END IF;RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END $$;
CREATE TRIGGER contract_filed_document_immutable BEFORE UPDATE OR DELETE ON employee_document FOR EACH ROW EXECUTE FUNCTION app.contract_filed_document_immutable();
CREATE FUNCTION app.contract_file_document(wanted_document uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.contract_document;c public.contract_case;file_id uuid:=gen_random_uuid();bytes bytea;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO d FROM public.contract_document WHERE id=wanted_document AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM public.contract_case WHERE id=d.case_id AND tenant_id=d.tenant_id FOR UPDATE;
 IF d.id IS NULL OR NOT app.contract_case_access(c.id) OR NOT app.contract_runtime(c.company_id) OR NOT(d.released_at IS NOT NULL OR d.signature->>'action'='accept') THEN RAISE EXCEPTION 'sealed contract filing unavailable' USING ERRCODE='42501'; END IF;
 IF d.employee_document_id IS NOT NULL THEN RETURN d.employee_document_id; END IF;bytes:=coalesce(d.signed_content,d.content);
 INSERT INTO public.employee_document(id,tenant_id,employment_id,title,category,description,content,file_name,mime_type,size_bytes,uploaded_by_user_id,updated_by_user_id,contract_document_id) VALUES(file_id,c.tenant_id,c.employment_id,c.number||' · '||d.type,'Contract Management','Immutable approved contract document',bytes,c.number||'-'||d.type||'.pdf','application/pdf',octet_length(bytes),app.current_user_id(),app.current_user_id(),d.id);
 UPDATE public.contract_document SET employee_document_id=file_id WHERE id=d.id;PERFORM app.contract_audit(c.id,'document.filed',jsonb_build_object('documentId',d.id,'employeeDocumentId',file_id));RETURN file_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_filed_document_immutable(),app.contract_file_document(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_file_document(uuid) TO ai_hr_app;
--> statement-breakpoint
-- This capability is bound to a frozen accepted case and a separately nominated, still-active HR executor.
-- It accepts no dates, employee IDs, pay amounts or SQL from the caller.
CREATE FUNCTION app.contract_effect_authorised(wanted_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_case c JOIN public.contract_configuration cfg ON cfg.company_id=c.company_id AND cfg.tenant_id=c.tenant_id JOIN public.app_user u ON u.id=cfg.effect_principal_id AND u.tenant_id=c.tenant_id
 WHERE c.id=wanted_case AND c.tenant_id=app.current_tenant_id() AND app.contract_runtime(c.company_id) AND app.contract_active_user(u.id)
 AND EXISTS(SELECT 1 FROM public.role_assignment a WHERE a.tenant_id=c.tenant_id AND a.app_user_id=u.id AND a.role::text IN('hr_admin','super_admin') AND (a.company_id IS NULL OR a.company_id=c.company_id OR app.is_company_descendant(c.company_id,a.company_id)))
 AND (app.contract_case_access(c.id) OR session_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname=session_user AND p.rolsuper)));
$$;
CREATE FUNCTION app.contract_apply_records(wanted_case uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;cfg public.contract_configuration;term public.contract_term;source jsonb;decision jsonb;cur public.compensation;fixed public.employment_pay_component;component public.pay_component;next_comp uuid;next_fixed uuid;next_term uuid;next_case uuid;next_data jsonb;next_source jsonb;next_number text;n bigint;from_day date;new_end date;data jsonb;receipt_value jsonb;error_message text;executor uuid;batch public.payroll_batch;changed_pay boolean;event_id uuid:=gen_random_uuid();
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR NOT app.contract_effect_authorised(c.id) THEN RAISE EXCEPTION 'accepted contract effect authority unavailable' USING ERRCODE='42501'; END IF;
 SELECT e.receipt INTO receipt_value FROM public.contract_effect e WHERE e.case_id=c.id AND e.kind='records' AND e.tenant_id=c.tenant_id AND e.status='done';IF receipt_value IS NOT NULL THEN RETURN receipt_value; END IF;
 IF c.data->>'state'<>'records_pending' OR c.data->'document'->>'acceptedAt' IS NULL OR NOT EXISTS(SELECT 1 FROM public.contract_document d WHERE d.id=(c.data->'document'->>'id')::uuid AND d.case_id=c.id AND d.tenant_id=c.tenant_id AND d.content_hash=c.data->'document'->>'hash' AND d.signature->>'action'='accept' AND d.decision_revision=(c.data->'decision'->>'revision')::integer) THEN RAISE EXCEPTION 'current signed accepted contract required' USING ERRCODE='23514'; END IF;
 INSERT INTO public.contract_effect(case_id,tenant_id,kind) VALUES(c.id,c.tenant_id,'records') ON CONFLICT DO NOTHING;
 SELECT * INTO cfg FROM public.contract_configuration WHERE company_id=c.company_id AND tenant_id=c.tenant_id FOR UPDATE;executor:=cfg.effect_principal_id;
 BEGIN
 PERFORM 1 FROM public.employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR UPDATE;source:=app.contract_source(c.employment_id);decision:=c.data->'decision';
 IF source->>'sourceRevision' IS DISTINCT FROM c.data->'term'->>'sourceRevision' OR coalesce((source->>'ended')::boolean,false) THEN RAISE EXCEPTION 'Personnel source changed; People Ops must reconcile accepted terms'; END IF;
 from_day:=(decision->>'startOn')::date;new_end:=(decision->>'endOn')::date;
 IF c.purpose<>'initial' AND (from_day IS DISTINCT FROM (c.data->'term'->>'endOn')::date+1 OR new_end IS DISTINCT FROM (from_day+make_interval(months=>(decision->>'months')::integer))::date-1) THEN RAISE EXCEPTION 'accepted term dates do not match the approved renewal'; END IF;
 changed_pay:=(decision->>'salaryCents')::numeric IS DISTINCT FROM (c.data->'term'->>'salaryCents')::numeric OR (decision->>'allowanceCents')::numeric IS DISTINCT FROM (c.data->'term'->>'allowanceCents')::numeric;
 -- The canonical closed-month owner treats payroll periods as half-open month intervals.
 IF changed_pay AND EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=p.tenant_id WHERE p.tenant_id=c.tenant_id AND p.employment_id=c.employment_id AND b.status='closed' AND (b.pay_period||'-01')::date+interval '1 month'>from_day) THEN RAISE EXCEPTION 'closed payroll overlaps the approved effective date; authorised reconciliation required'; END IF;
 SELECT * INTO cur FROM public.compensation WHERE id=(source->>'compensationId')::uuid AND tenant_id=c.tenant_id FOR UPDATE;
 SELECT * INTO component FROM public.pay_component WHERE id=(source->>'allowanceComponentId')::uuid AND tenant_id=c.tenant_id FOR SHARE;
 IF cur.id IS NULL OR cur.currency<>'MYR' OR component.id IS NULL OR component.kind<>'allowance' OR component.archived_at IS NOT NULL OR component.pending_input_kind IS NOT NULL OR component.rule IS NOT NULL AND component.rule->>'kind'<>'fixed' THEN RAISE EXCEPTION 'verify current salary and configured fixed allowance Pay Item'; END IF;
 IF changed_pay AND EXISTS(SELECT 1 FROM public.compensation x WHERE x.employment_id=c.employment_id AND x.tenant_id=c.tenant_id AND x.superseded_at IS NULL AND x.id<>cur.id AND x.valid_from>=from_day) THEN RAISE EXCEPTION 'a future salary revision conflicts with this renewal'; END IF;
 IF (decision->>'salaryCents')::numeric IS DISTINCT FROM (c.data->'term'->>'salaryCents')::numeric THEN
 IF cur.valid_from>=from_day OR cur.valid_to IS NOT NULL AND cur.valid_to<>from_day THEN RAISE EXCEPTION 'salary history boundary changed'; END IF;
 UPDATE public.compensation SET valid_to=from_day WHERE id=cur.id;next_comp:=gen_random_uuid();
 INSERT INTO public.compensation(id,tenant_id,employment_id,basic_salary,currency,monthly_allowance,pay_mode,payment_term,rate_amount,remarks,valid_from,valid_to) VALUES(next_comp,c.tenant_id,c.employment_id,(decision->>'salaryCents')::numeric/100,cur.currency,cur.monthly_allowance,cur.pay_mode,cur.payment_term,cur.rate_amount,decision->>'reason',from_day,NULL);
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'compensation',next_comp,'compensation.set','user',executor,c.employment_id,jsonb_build_object('employmentId',c.employment_id,'effectiveFrom',from_day,'fieldsChanged',jsonb_build_array('basicSalary'),'contractCaseId',c.id,'triggeredBy',app.current_user_id()));
 END IF;
 IF (decision->>'allowanceCents')::numeric IS DISTINCT FROM (c.data->'term'->>'allowanceCents')::numeric THEN
 IF EXISTS(SELECT 1 FROM public.employment_pay_component x WHERE x.tenant_id=c.tenant_id AND x.employment_id=c.employment_id AND x.component_id=component.id AND x.superseded_at IS NULL AND x.valid_from>=from_day) THEN RAISE EXCEPTION 'a future fixed allowance revision conflicts with this renewal'; END IF;
 SELECT * INTO fixed FROM public.employment_pay_component x WHERE x.id=(source->>'fixedAllowanceId')::uuid AND x.tenant_id=c.tenant_id FOR UPDATE;
 IF fixed.id IS NOT NULL THEN IF fixed.valid_from>=from_day OR fixed.valid_to IS NOT NULL AND fixed.valid_to<>from_day THEN RAISE EXCEPTION 'fixed allowance history boundary changed'; END IF;UPDATE public.employment_pay_component SET valid_to=from_day WHERE id=fixed.id;END IF;
 IF (decision->>'allowanceCents')::numeric>0 THEN next_fixed:=gen_random_uuid();INSERT INTO public.employment_pay_component(id,tenant_id,employment_id,component_id,amount,currency,valid_from,valid_to,prorate_override,remarks,run_type,payroll_cycle_id) VALUES(next_fixed,c.tenant_id,c.employment_id,component.id,(decision->>'allowanceCents')::numeric/100,'MYR',from_day,NULL,fixed.prorate_override,decision->>'reason',fixed.run_type,fixed.payroll_cycle_id);END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'employment-pay-component',coalesce(next_fixed,fixed.id),'employment-pay-component.set','user',executor,c.employment_id,jsonb_build_object('employmentId',c.employment_id,'componentId',component.id,'effectiveFrom',from_day,'contractCaseId',c.id,'triggeredBy',app.current_user_id()));
 END IF;
 -- Canonical employment date owner: only the accepted dates are written; no status reinstatement or exit change.
 UPDATE public.employment SET contract_start_date=from_day,contract_end_date=new_end WHERE id=c.employment_id AND tenant_id=c.tenant_id;
 INSERT INTO public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(event_id,c.tenant_id,'employment',c.employment_id,'employment.updated','user',executor,c.employment_id,jsonb_build_object('fields',jsonb_build_array('contractStartDate','contractEndDate'),'contractCaseId',c.id,'triggeredBy',app.current_user_id()));
 IF changed_pay THEN
 FOR batch IN SELECT b.* FROM public.payroll_batch b WHERE b.tenant_id=c.tenant_id AND b.company_id=c.company_id AND b.status='processed' AND b.pay_period>=to_char(from_day,'YYYY-MM') AND EXISTS(SELECT 1 FROM public.payslip p WHERE p.batch_id=b.id AND p.tenant_id=b.tenant_id AND p.employment_id=c.employment_id) ORDER BY b.id FOR UPDATE LOOP
 UPDATE public.payroll_batch SET needs_recalc_at=coalesce(needs_recalc_at,now()),recalc_employment_ids=(SELECT coalesce(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM jsonb_array_elements(coalesce(batch.recalc_employment_ids,'[]'::jsonb)||jsonb_build_array(c.employment_id::text))) WHERE id=batch.id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(c.tenant_id,'payroll-batch',batch.id,'payroll-batch.recalc-required','user',executor,jsonb_build_object('employmentIds',jsonb_build_array(c.employment_id),'addedEmploymentIds',jsonb_build_array(c.employment_id),'changeCategory','compensation','contractCaseId',c.id,'triggeredBy',app.current_user_id()));END LOOP;END IF;
 SELECT * INTO term FROM public.contract_term WHERE id=c.term_id AND tenant_id=c.tenant_id FOR UPDATE;next_term:=CASE WHEN c.purpose='initial' THEN term.id ELSE gen_random_uuid() END;
 next_source:=app.contract_source(c.employment_id);
 IF c.purpose<>'initial' THEN INSERT INTO public.contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision,predecessor_id) VALUES(next_term,c.tenant_id,c.company_id,c.employment_id,term.version+1,term.kind,from_day,new_end,next_source->>'sourceRevision',term.id);END IF;
 INSERT INTO public.tenant_counter(tenant_id,kind,value) VALUES(c.tenant_id,'contract-'||to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY'),1) ON CONFLICT(tenant_id,kind) DO UPDATE SET value=tenant_counter.value+1 RETURNING value INTO n;
 next_number:='CT-'||to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY')||'-'||lpad(n::text,4,'0');next_case:=gen_random_uuid();
 next_data:=c.data||jsonb_build_object('id',next_case,'number',next_number,'revision',1,'settings',cfg.data,'state',CASE WHEN (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date>=new_end-(cfg.data->>'firstAlertDays')::integer THEN 'decision_pending' ELSE 'upcoming' END,'term',jsonb_build_object('id',next_term,'employmentId',c.employment_id,'companyId',c.company_id,'kind',term.kind,'version',CASE WHEN c.purpose='initial' THEN term.version ELSE term.version+1 END,'startOn',from_day,'endOn',new_end,'salaryCents',decision->>'salaryCents','allowanceCents',decision->>'allowanceCents','sourceRevision',next_source->>'sourceRevision'),'decision',NULL,'decisionHistory','[]'::jsonb,'approvals','[]'::jsonb,'document',NULL,'sourceRetirementApprovalId',NULL,'healthCompletedAt',NULL,'effects',jsonb_build_object('personnel',NULL,'payroll',NULL,'verificationTask',NULL,'offboarding',NULL,'manualHandoff',NULL));
 INSERT INTO public.contract_case(id,tenant_id,company_id,employment_id,term_id,purpose,number,data) VALUES(next_case,c.tenant_id,c.company_id,c.employment_id,next_term,'expiry',next_number,next_data) ON CONFLICT(term_id,purpose) DO NOTHING;
 INSERT INTO public.contract_effect(case_id,tenant_id,kind,status,receipt) VALUES(c.id,c.tenant_id,'verify','pending',jsonb_build_object('employmentId',c.employment_id,'decisionRevision',decision->>'revision','executorId',executor)) ON CONFLICT DO NOTHING;
 receipt_value:=jsonb_build_object('employmentEventId',event_id,'compensationId',next_comp,'fixedAllowanceId',next_fixed,'nextTermId',next_term,'nextCaseId',next_case,'effectPrincipalId',executor,'triggeredBy',app.current_user_id());
 UPDATE public.contract_effect SET status='done',receipt=receipt_value,error=NULL,attempts=attempts+1,completed_at=now() WHERE case_id=c.id AND kind='records';
 data:=c.data||jsonb_build_object('state','renewed','effects',c.data->'effects'||jsonb_build_object('personnel',event_id,'payroll',CASE WHEN changed_pay THEN event_id END,'verificationTask',c.id));PERFORM app.contract_commit_case(c.id,data,'records.applied',receipt_value);RETURN receipt_value;
 EXCEPTION WHEN OTHERS THEN
 GET STACKED DIAGNOSTICS error_message=MESSAGE_TEXT;UPDATE public.contract_effect SET status='failed',error=left(error_message,2000),attempts=attempts+1 WHERE case_id=c.id AND kind='records';PERFORM app.contract_audit(c.id,'records.failed',jsonb_build_object('reason',left(error_message,2000),'effectPrincipalId',executor));RETURN jsonb_build_object('pending',true,'reason',left(error_message,2000));
 END;
END $$;
REVOKE ALL ON FUNCTION app.contract_effect_authorised(uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.contract_apply_records(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_apply_records(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Custody of existing retirement decisions: real source references, two independent people,
-- and the exact current Personnel terms. This does not grant retirement approval authority.
CREATE TABLE contract_retirement_custody(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),employment_id uuid NOT NULL REFERENCES employment(id),retirement_case_id uuid NOT NULL REFERENCES lc_v9_case(id),approval_document_id uuid NOT NULL REFERENCES employee_document(id),health_document_id uuid NOT NULL REFERENCES employee_document(id),approval_hash text NOT NULL,health_hash text NOT NULL,source_revision text NOT NULL,captured_by uuid NOT NULL REFERENCES app_user(id),captured_at timestamptz NOT NULL DEFAULT now(),capture_reason text NOT NULL,verified_by uuid REFERENCES app_user(id),verified_at timestamptz,verification_reason text,approval_event_id uuid REFERENCES domain_event(id),health_event_id uuid REFERENCES domain_event(id),CHECK(approval_document_id<>health_document_id),CHECK(verified_by IS DISTINCT FROM captured_by));
ALTER TABLE contract_retirement_custody ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_retirement_custody FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_retirement_custody_owner ON contract_retirement_custody FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_retirement_custody_read ON contract_retirement_custody FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (app.contract_configure(company_id) OR app.contract_has_role(company_id,app.contract_business_unit(employment_id),'pbp')));
REVOKE ALL ON contract_retirement_custody FROM PUBLIC,ai_hr_app;
GRANT SELECT ON contract_retirement_custody TO ai_hr_app;
CREATE FUNCTION app.contract_capture_retirement(wanted_employment uuid,wanted_retirement uuid,wanted_approval uuid,wanted_health uuid,p_source_revision text,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;a public.employee_document;h public.employee_document;result uuid;
BEGIN
 PERFORM app.access_workforce_write_lock();
 PERFORM 1 FROM public.employment WHERE id=wanted_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 source:=app.contract_source(wanted_employment);
 IF source IS NULL OR NOT app.contract_has_role((source->>'companyId')::uuid,app.contract_business_unit(wanted_employment),'pbp') OR source->>'sourceRevision' IS DISTINCT FROM p_source_revision OR length(btrim(coalesce(p_reason,'')))<20 THEN RAISE EXCEPTION 'current scoped PBP and a documented source attestation are required' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.contract_term WHERE employment_id=wanted_employment AND tenant_id=app.current_tenant_id()) OR NOT EXISTS(SELECT 1 FROM public.lc_v9_case c WHERE c.id=wanted_retirement AND c.tenant_id=app.current_tenant_id() AND c.employment_id=wanted_employment AND c.company_id=(source->>'companyId')::uuid AND c.module='off' AND c.data->'facts'->>'caseType'='Retirement' AND c.data->>'state' IN('submitted','closed')) THEN RAISE EXCEPTION 'an actual submitted retirement case and first post-retirement term are required' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM public.employee_document WHERE id=wanted_approval AND tenant_id=app.current_tenant_id() AND employment_id=wanted_employment FOR SHARE;
 SELECT * INTO h FROM public.employee_document WHERE id=wanted_health AND tenant_id=app.current_tenant_id() AND employment_id=wanted_employment FOR SHARE;
 IF a.id IS NULL OR h.id IS NULL OR a.id=h.id OR a.mime_type<>'application/pdf' OR h.mime_type<>'application/pdf' OR octet_length(a.content)<4 OR octet_length(h.content)<4 THEN RAISE EXCEPTION 'select separate existing approval and completed health-check PDF records from this employee P-file' USING ERRCODE='23514'; END IF;
 INSERT INTO public.contract_retirement_custody(tenant_id,company_id,employment_id,retirement_case_id,approval_document_id,health_document_id,approval_hash,health_hash,source_revision,captured_by,capture_reason) VALUES(app.current_tenant_id(),(source->>'companyId')::uuid,wanted_employment,wanted_retirement,a.id,h.id,encode(sha256(a.content),'hex'),encode(sha256(h.content),'hex'),p_source_revision,app.current_user_id(),p_reason) RETURNING id INTO result;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(app.current_tenant_id(),'contract-retirement-custody',result,'contract.retirement-evidence.captured','user',app.current_user_id(),wanted_employment,jsonb_build_object('retirementCaseId',wanted_retirement,'approvalDocumentId',a.id,'healthDocumentId',h.id,'reason',p_reason));
 RETURN result;
END $$;
CREATE FUNCTION app.contract_verify_retirement(wanted_custody uuid,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_retirement_custody;source jsonb;approval_event uuid:=gen_random_uuid();health_event uuid:=gen_random_uuid();
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO c FROM public.contract_retirement_custody WHERE id=wanted_custody AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR NOT app.contract_has_role(c.company_id,NULL,'gbs') OR app.current_user_id()=c.captured_by OR length(btrim(coalesce(p_reason,'')))<20 THEN RAISE EXCEPTION 'an independent scoped GBS verifier and source-review attestation are required' USING ERRCODE='42501'; END IF;
 IF c.verified_at IS NOT NULL THEN RETURN jsonb_build_object('approvalEventId',c.approval_event_id,'healthEventId',c.health_event_id); END IF;
 PERFORM 1 FROM public.employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR UPDATE;
 source:=app.contract_source(c.employment_id);
 IF source->>'sourceRevision' IS DISTINCT FROM c.source_revision OR EXISTS(SELECT 1 FROM public.contract_term WHERE employment_id=c.employment_id AND tenant_id=c.tenant_id) OR NOT EXISTS(SELECT 1 FROM public.lc_v9_case x WHERE x.id=c.retirement_case_id AND x.tenant_id=c.tenant_id AND x.employment_id=c.employment_id AND x.module='off' AND x.data->'facts'->>'caseType'='Retirement' AND x.data->>'state' IN('submitted','closed')) OR NOT EXISTS(SELECT 1 FROM public.employee_document d WHERE d.id=c.approval_document_id AND d.tenant_id=c.tenant_id AND d.employment_id=c.employment_id AND encode(sha256(d.content),'hex')=c.approval_hash) OR NOT EXISTS(SELECT 1 FROM public.employee_document d WHERE d.id=c.health_document_id AND d.tenant_id=c.tenant_id AND d.employment_id=c.employment_id AND encode(sha256(d.content),'hex')=c.health_hash) THEN RAISE EXCEPTION 'retirement evidence or approved Personnel terms changed; capture and review again' USING ERRCODE='40001'; END IF;
 INSERT INTO public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(approval_event,c.tenant_id,'contract-retirement-custody',c.id,'retirement.contract-approved','user',app.current_user_id(),c.employment_id,jsonb_build_object('custodyId',c.id,'sourceRevision',c.source_revision,'documentId',c.approval_document_id,'documentHash',c.approval_hash,'capturedBy',c.captured_by)),(health_event,c.tenant_id,'contract-retirement-custody',c.id,'retirement.health-check-completed','user',app.current_user_id(),c.employment_id,jsonb_build_object('custodyId',c.id,'sourceRevision',c.source_revision,'documentId',c.health_document_id,'documentHash',c.health_hash));
 UPDATE public.contract_retirement_custody SET verified_by=app.current_user_id(),verified_at=now(),verification_reason=p_reason,approval_event_id=approval_event,health_event_id=health_event WHERE id=c.id;
 RETURN jsonb_build_object('approvalEventId',approval_event,'healthEventId',health_event);
END $$;
REVOKE ALL ON FUNCTION app.contract_capture_retirement(uuid,uuid,uuid,uuid,text,text),app.contract_verify_retirement(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_capture_retirement(uuid,uuid,uuid,uuid,text,text),app.contract_verify_retirement(uuid,text) TO ai_hr_app;
CREATE FUNCTION app.contract_event_custody_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.event_type LIKE 'contract.%' OR NEW.event_type IN('retirement.contract-approved','retirement.health-check-completed')) AND current_user='ai_hr_app' THEN RAISE EXCEPTION 'contract events require the native purpose-bound owner' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER contract_event_custody_guard BEFORE INSERT OR UPDATE ON domain_event FOR EACH ROW EXECUTE FUNCTION app.contract_event_custody_guard();
--> statement-breakpoint
CREATE FUNCTION app.contract_admission_choices(wanted_company uuid) RETURNS TABLE(id uuid,name text,"employeeId" text,"startOn" text,"endOn" text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.id,p.full_name,e.employee_code,e.contract_start_date::text,e.contract_end_date::text FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=wanted_company AND app.contract_configure(e.company_id) AND e.contract_start_date IS NOT NULL AND e.contract_end_date IS NOT NULL AND e.blacklisted_at IS NULL ORDER BY p.full_name,e.id LIMIT 2000; $$;
CREATE FUNCTION app.contract_directory(wanted_company uuid) RETURNS TABLE(id uuid,name text,"employeeId" text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT u.id,p.full_name,e.employee_code FROM public.app_user u JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id JOIN public.employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id AND e.company_id=wanted_company WHERE u.tenant_id=app.current_tenant_id() AND app.contract_configure(wanted_company) AND app.contract_active_user(u.id) AND e.blacklisted_at IS NULL ORDER BY p.full_name,u.id LIMIT 2000; $$;
CREATE FUNCTION app.contract_workflow_preview(wanted_case uuid,wanted_workflow uuid,p_definition jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;s jsonb;result jsonb:='[]';holders jsonb;
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id();
 IF c.id IS NULL OR NOT app.contract_configure(c.company_id) OR NOT EXISTS(SELECT 1 FROM public.contract_workflow w WHERE w.id=wanted_workflow AND w.company_id=c.company_id AND w.tenant_id=c.tenant_id AND w.draft=p_definition) THEN RAISE EXCEPTION 'contract preview permission or current draft unavailable' USING ERRCODE='42501'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p_definition->'steps') LOOP
 SELECT coalesce(jsonb_agg(u ORDER BY u),'[]') INTO holders FROM (SELECT DISTINCT app.contract_approver_users(c.id,coalesce(s->'approver','{}')) u WHERE s->>'type'='request_approval') r;
 result:=result||jsonb_build_array(jsonb_build_object('stepId',s->>'id','type',s->>'type','matches',app.contract_conditions_match(p_definition->'conditions',c.data,app.contract_business_unit(c.employment_id)) AND app.contract_conditions_match(s->'conditions',c.data,app.contract_business_unit(c.employment_id)),'holderIds',holders,'blocked',s->>'type'='request_approval' AND (jsonb_array_length(holders)=0 OR holders ? (c.data->'decision'->>'submittedBy'))));
 END LOOP;RETURN jsonb_build_object('dryRun',true,'caseRevision',c.revision,'steps',result);
END $$;
CREATE FUNCTION app.contract_decision_preview(wanted_case uuid,p_decision jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;w public.contract_workflow;result jsonb:='[]';data jsonb;
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id();
 IF c.id IS NULL OR NOT (app.contract_case_manager(c.id) OR app.contract_case_pbp(c.id)) THEN RAISE EXCEPTION 'contract decision preview unavailable' USING ERRCODE='42501'; END IF;
 data:=c.data||jsonb_build_object('decision',p_decision);
 FOR w IN SELECT * FROM public.contract_workflow WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled AND published_version IS NOT NULL LOOP
 IF w.draft->'trigger'->>'event'='decisionSubmitted' AND app.contract_conditions_match(w.draft->'conditions',data,app.contract_business_unit(c.employment_id)) THEN
 result:=result||jsonb_build_array(jsonb_build_object('workflowId',w.id,'name',w.draft->>'name','version',w.published_version,'approvals',app.contract_approval_route(c.id,data,w.id,w.published_version)));
 END IF;END LOOP;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_admission_choices(uuid),app.contract_directory(uuid),app.contract_workflow_preview(uuid,uuid,jsonb),app.contract_decision_preview(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_admission_choices(uuid),app.contract_directory(uuid),app.contract_workflow_preview(uuid,uuid,jsonb),app.contract_decision_preview(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_offboarding_intent(wanted_case uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;d public.contract_document;done jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR NOT app.contract_effect_authorised(c.id) THEN RAISE EXCEPTION 'contract handoff authority unavailable' USING ERRCODE='42501'; END IF;
 SELECT receipt INTO done FROM public.contract_effect WHERE case_id=c.id AND tenant_id=c.tenant_id AND kind='offboarding' AND status='done';IF done IS NOT NULL THEN RETURN done; END IF;
 SELECT * INTO d FROM public.contract_document WHERE case_id=c.id AND tenant_id=c.tenant_id AND released_at IS NOT NULL AND superseded_at IS NULL AND type<>'renewal' AND decision_revision=(c.data->'decision'->>'revision')::integer ORDER BY released_at DESC,id LIMIT 1 FOR SHARE;
 IF c.data->>'state'<>'ending' OR d.id IS NULL OR app.contract_source(c.employment_id)->>'sourceRevision' IS DISTINCT FROM c.data->'term'->>'sourceRevision' THEN RAISE EXCEPTION 'current ending intent and released letter are required' USING ERRCODE='40001'; END IF;
 RETURN jsonb_build_object('caseId',c.id,'employmentId',c.employment_id,'type',CASE WHEN c.data->'term'->>'kind'='post_retirement' THEN 'Retirement' ELSE 'Contract end' END,'noticeDate',(d.released_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date,'lastDay',c.data->'term'->>'endOn','manualHandoff',app.contract_source(c.employment_id)->>'grade'='H','letterDocumentId',d.id);
END $$;
CREATE FUNCTION app.contract_offboarding_sequence(wanted_case uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent jsonb;result bigint;
BEGIN
 intent:=app.contract_offboarding_intent(wanted_case);IF intent->>'offboardingCaseId' IS NOT NULL OR coalesce((intent->>'manualHandoff')::boolean,false) OR (intent->>'noticeDate')::date>(intent->>'lastDay')::date THEN RAISE EXCEPTION 'contract handoff is completed, manual or requires real date reconciliation' USING ERRCODE='23514'; END IF;
 INSERT INTO public.tenant_counter(tenant_id,kind,value) VALUES(app.current_tenant_id(),'OFB9',1) ON CONFLICT(tenant_id,kind) DO UPDATE SET value=tenant_counter.value+1 RETURNING value INTO result;RETURN result;
END $$;
CREATE FUNCTION app.contract_complete_handoff(wanted_case uuid,wanted_offboarding uuid,p_reason text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;intent jsonb;receipt_value jsonb;
BEGIN
 intent:=app.contract_offboarding_intent(wanted_case);IF intent->>'offboardingCaseId' IS NOT NULL THEN RETURN intent; END IF;
 SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF coalesce((intent->>'manualHandoff')::boolean,false) THEN
 IF NOT app.contract_has_role(c.company_id,NULL,'gbs') OR wanted_offboarding IS NOT NULL OR length(btrim(coalesce(p_reason,'')))<10 THEN RAISE EXCEPTION 'Grade H requires a GBS manual handoff receipt' USING ERRCODE='42501'; END IF;
 receipt_value:=jsonb_build_object('manualHandoff',true,'confirmedBy',app.current_user_id(),'reason',p_reason,'at',now());
 INSERT INTO public.contract_effect(case_id,tenant_id,kind,status,receipt,completed_at) VALUES(c.id,c.tenant_id,'manual_handoff','done',receipt_value,now()) ON CONFLICT(case_id,kind) DO UPDATE SET status='done',receipt=excluded.receipt,completed_at=excluded.completed_at;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM public.lc_v9_case x WHERE x.id=wanted_offboarding AND x.tenant_id=c.tenant_id AND x.employment_id=c.employment_id AND x.company_id=c.company_id AND x.module='off' AND x.data->'facts'->>'caseType'=intent->>'type' AND x.data->'facts'->>'lastDay'=intent->>'lastDay' AND x.data->'facts'->>'noticeDate'=intent->>'noticeDate' AND x.data->>'contractSourceCaseId'=c.id::text) THEN RAISE EXCEPTION 'canonical offboarding receipt does not match the frozen ending intent' USING ERRCODE='23514'; END IF;
 receipt_value:=jsonb_build_object('offboardingCaseId',wanted_offboarding,'letterDocumentId',intent->>'letterDocumentId','at',now());
 END IF;
 UPDATE public.contract_effect SET status='done',receipt=receipt_value,error=NULL,completed_at=now(),attempts=attempts+1 WHERE case_id=c.id AND kind='offboarding';
 RETURN app.contract_commit_case(c.id,c.data||jsonb_build_object('state','handed_off','effects',c.data->'effects'||jsonb_build_object(CASE WHEN coalesce((intent->>'manualHandoff')::boolean,false) THEN 'manualHandoff' ELSE 'offboarding' END,coalesce(wanted_offboarding::text,c.id::text))),'offboarding.handed-off',receipt_value);
END $$;
REVOKE ALL ON FUNCTION app.contract_offboarding_intent(uuid),app.contract_offboarding_sequence(uuid),app.contract_complete_handoff(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_offboarding_intent(uuid),app.contract_offboarding_sequence(uuid),app.contract_complete_handoff(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_retirement_choices(wanted_employment uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;retirements jsonb;documents jsonb;
BEGIN
 source:=app.contract_source(wanted_employment);
 IF source IS NULL OR NOT(app.contract_has_role((source->>'companyId')::uuid,app.contract_business_unit(wanted_employment),'pbp') OR app.contract_has_role((source->>'companyId')::uuid,NULL,'gbs')) THEN RAISE EXCEPTION 'scoped retirement evidence custody unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'number',c.number,'state',c.data->>'state') ORDER BY c.created_at DESC),'[]') INTO retirements FROM public.lc_v9_case c WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=wanted_employment AND c.module='off' AND c.data->'facts'->>'caseType'='Retirement' AND c.data->>'state' IN('submitted','closed');
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'title',d.title,'fileName',d.file_name,'createdAt',d.created_at) ORDER BY d.created_at DESC),'[]') INTO documents FROM public.employee_document d WHERE d.tenant_id=app.current_tenant_id() AND d.employment_id=wanted_employment AND d.mime_type='application/pdf';
 RETURN jsonb_build_object('source',source,'retirements',retirements,'documents',documents);
END $$;
REVOKE ALL ON FUNCTION app.contract_retirement_choices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_retirement_choices(uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE contract_message ADD COLUMN source_event_id uuid REFERENCES domain_event(id),ADD COLUMN step_id uuid,ADD COLUMN private_subject text,ADD COLUMN private_body text,ADD COLUMN expected_state text;
DROP POLICY contract_message_read ON contract_message;
CREATE POLICY contract_message_read ON contract_message FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND recipient_user_id=app.current_user_id() AND app.contract_case_access(case_id));
CREATE FUNCTION app.contract_notification_recipients(wanted_message uuid) RETURNS TABLE(employment_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT DISTINCT e.id FROM public.contract_message m JOIN public.contract_case c ON c.id=m.case_id AND c.tenant_id=m.tenant_id JOIN public.app_user u ON u.id=m.recipient_user_id AND u.tenant_id=m.tenant_id JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id AND e.company_id=c.company_id JOIN public.contract_workflow_version v ON v.workflow_id=m.workflow_id AND v.version=m.workflow_version AND v.tenant_id=m.tenant_id CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') s
 WHERE m.id=wanted_message AND m.tenant_id=app.current_tenant_id() AND app.contract_runtime(c.company_id) AND app.contract_active_user(u.id) AND c.data->>'state'=m.expected_state AND c.source_conflict IS NULL AND s->>'id'=m.step_id::text AND s->>'type'='notify' AND app.contract_conditions_match(v.definition->'conditions',c.data,app.contract_business_unit(c.employment_id)) AND app.contract_conditions_match(s->'conditions',c.data,app.contract_business_unit(c.employment_id)) AND u.id IN(SELECT app.contract_approver_users(c.id,resolver) FROM jsonb_array_elements(s->'to') resolver) AND u.id IN(SELECT app.contract_users_for_employment(e.id));
$$;
CREATE FUNCTION app.contract_notification_content(wanted_message uuid,wanted_employment uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('subject',m.private_subject,'body',m.private_body,'linkPath','/lifecycle/contracts/'||m.case_id::text) FROM public.contract_message m WHERE m.id=wanted_message AND m.tenant_id=app.current_tenant_id() AND wanted_employment IN(SELECT app.contract_notification_recipients(m.id)); $$;
REVOKE ALL ON FUNCTION app.contract_notification_recipients(uuid),app.contract_notification_content(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_notification_recipients(uuid),app.contract_notification_content(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Private sender port. The shared leased dispatcher is the sole caller; explicit identity
-- arguments avoid treating the mail service's database login as an employee principal.
CREATE FUNCTION app.contract_notification_content(p_tenant uuid,p_event uuid,p_user uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior_tenant text:=current_setting('app.tenant_id',true);result jsonb;
BEGIN
 PERFORM set_config('app.tenant_id',p_tenant::text,true);
 SELECT jsonb_build_object('subject',m.private_subject,'body',m.private_body) INTO result FROM public.contract_message m JOIN public.domain_event ev ON ev.id=m.source_event_id AND ev.tenant_id=m.tenant_id JOIN public.app_user u ON u.id=m.recipient_user_id AND u.tenant_id=m.tenant_id WHERE m.tenant_id=p_tenant AND m.source_event_id=p_event AND m.recipient_user_id=p_user AND ev.event_type='contract.notification-due' AND ev.aggregate_id=m.id AND EXISTS(SELECT 1 FROM app.contract_notification_recipients(m.id) r JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=m.tenant_id WHERE e.person_id=u.person_id);
 PERFORM set_config('app.tenant_id',coalesce(prior_tenant,''),true);RETURN result;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_tenant,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION app.contract_notification_content(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_run_workflow(wanted_case uuid,wanted_workflow uuid,p_event text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;w public.contract_workflow;v public.contract_workflow_version;s jsonb;resolver jsonb;recipient uuid;message_id uuid;event_id uuid;occurrence text;due_days integer;today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;count_created integer:=0;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR NOT app.contract_effect_authorised(c.id) OR c.source_conflict IS NOT NULL OR NOT(app.contract_configure(c.company_id) OR app.current_user_id() IS NULL AND (session_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname=session_user AND p.rolsuper))) THEN RAISE EXCEPTION 'contract workflow execution authority unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO w FROM public.contract_workflow WHERE id=wanted_workflow AND tenant_id=c.tenant_id AND company_id=c.company_id AND enabled AND published_version IS NOT NULL;
 SELECT * INTO v FROM public.contract_workflow_version WHERE workflow_id=w.id AND version=CASE WHEN c.workflow_id=w.id THEN c.workflow_version ELSE w.published_version END AND tenant_id=c.tenant_id;
 IF w.id IS NULL OR v.workflow_id IS NULL OR v.definition->'trigger'->>'event' IS DISTINCT FROM p_event OR NOT app.contract_conditions_match(v.definition->'conditions',c.data,app.contract_business_unit(c.employment_id)) THEN RETURN 0; END IF;
 IF p_event='beforeContractEnd' THEN
 IF c.data->>'state' NOT IN('upcoming','decision_pending') OR c.data->'decision'<>'null'::jsonb THEN RETURN 0; END IF;
 SELECT min(d) INTO due_days FROM unnest(ARRAY[(v.definition->'trigger'->>'days')::integer,(c.data->'settings'->>'reminderDays')::integer,(c.data->'settings'->>'decisionDueDays')::integer,(c.data->'settings'->>'escalationDays')::integer]) d WHERE today>=(c.data->'term'->>'endOn')::date-d;
 IF due_days IS NULL THEN RETURN 0; END IF;
 IF c.data->>'state'='upcoming' THEN PERFORM app.contract_commit_case(c.id,c.data||jsonb_build_object('state','decision_pending'),'expiry.alert-due');SELECT * INTO c FROM public.contract_case WHERE id=c.id; END IF;
 occurrence:=p_event||':'||due_days;
 ELSIF p_event='decisionSubmitted' THEN IF c.data->'decision'->>'confirmedAt' IS NULL OR c.workflow_id IS DISTINCT FROM w.id THEN RETURN 0; END IF;occurrence:=p_event||':'||(c.data->'decision'->>'revision')||':'||(c.data->>'state');
 ELSIF p_event='approvalRejected' THEN IF c.data->>'state'<>'decision_pending' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.data->'approvals') a WHERE a->>'state'='rejected') THEN RETURN 0; END IF;occurrence:=p_event||':'||(c.data->'decision'->>'revision');
 ELSIF p_event='signatureDeclined' THEN IF c.data->>'state'<>'ending' OR c.data->'document'->>'declinedAt' IS NULL THEN RETURN 0; END IF;occurrence:=p_event||':'||(c.data->'decision'->>'revision');
 ELSE RETURN 0; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(v.definition->'steps') WHERE value->>'type'='notify' LOOP
 IF NOT app.contract_conditions_match(s->'conditions',c.data,app.contract_business_unit(c.employment_id)) THEN CONTINUE; END IF;
 -- Post-renewal verification notification waits for actual canonical effect success.
 IF p_event='decisionSubmitted' AND c.data->'decision'->>'kind'='renew' AND c.data->>'state'<>'renewed' THEN CONTINUE; END IF;
 FOR resolver IN SELECT value FROM jsonb_array_elements(s->'to') LOOP
 FOR recipient IN SELECT DISTINCT app.contract_approver_users(c.id,resolver) LOOP
 message_id:=gen_random_uuid();event_id:=gen_random_uuid();
 INSERT INTO public.contract_message(id,tenant_id,case_id,workflow_id,workflow_version,occurrence_key,recipient_user_id,step_id,private_subject,private_body,expected_state) VALUES(message_id,c.tenant_id,c.id,w.id,v.version,occurrence||':'||(s->>'id'),recipient,(s->>'id')::uuid,s->>'subject',s->>'body',c.data->>'state') ON CONFLICT DO NOTHING;
 IF FOUND THEN INSERT INTO public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(event_id,c.tenant_id,'contract-message',message_id,'contract.notification-due',CASE WHEN app.current_user_id() IS NULL THEN 'system'::public.actor_type ELSE 'user'::public.actor_type END,app.current_user_id(),c.employment_id,jsonb_build_object('messageId',message_id));UPDATE public.contract_message SET source_event_id=event_id WHERE id=message_id;count_created:=count_created+1;END IF;
 END LOOP;END LOOP;END LOOP;RETURN count_created;
END $$;
REVOKE ALL ON FUNCTION app.contract_run_workflow(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_run_workflow(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_reconcile_source(wanted_case uuid,expected_revision integer,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;source jsonb;data jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR NOT(app.contract_case_pbp(c.id) OR app.contract_has_role(c.company_id,NULL,'gbs')) OR NOT app.contract_runtime(c.company_id) THEN RAISE EXCEPTION 'scoped source reconciliation authority required' USING ERRCODE='42501'; END IF;
 IF c.revision<>expected_revision OR c.data->>'state' NOT IN('upcoming','decision_pending','in_approval','e_acceptance') OR c.data->'document'->>'acceptedAt' IS NOT NULL OR c.purpose='initial' OR length(btrim(coalesce(p_reason,'')))<10 THEN RAISE EXCEPTION 'accepted or retirement-approved intent cannot be rewritten; review a new authorised source instead' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM public.employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR UPDATE;source:=app.contract_source(c.employment_id);
 IF source->>'startOn' IS NULL OR source->>'endOn' IS NULL OR source->>'salaryCents' IS NULL OR source->>'allowanceCents' IS NULL OR source->>'currency' IS DISTINCT FROM 'MYR' OR coalesce((source->>'ended')::boolean,false) THEN RAISE EXCEPTION 'current Personnel term is not eligible' USING ERRCODE='23514'; END IF;
 UPDATE public.contract_document SET superseded_at=now() WHERE case_id=c.id AND tenant_id=c.tenant_id AND superseded_at IS NULL;
 UPDATE public.contract_term SET start_on=(source->>'startOn')::date,end_on=(source->>'endOn')::date,source_revision=source->>'sourceRevision' WHERE id=c.term_id AND tenant_id=c.tenant_id;
 data:=c.data||jsonb_build_object('state','decision_pending','term',c.data->'term'||jsonb_build_object('startOn',source->>'startOn','endOn',source->>'endOn','salaryCents',source->>'salaryCents','allowanceCents',source->>'allowanceCents','sourceRevision',source->>'sourceRevision'),'decisionHistory',c.data->'decisionHistory'||CASE WHEN c.data->'decision'='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(c.data->'decision') END,'decision',NULL,'approvals','[]'::jsonb,'document',NULL);
 UPDATE public.contract_case SET source_conflict=NULL,last_synced_at=now(),workflow_id=NULL,workflow_version=NULL WHERE id=c.id;
 RETURN app.contract_commit_case(c.id,data,'source.reconciled',jsonb_build_object('reason',p_reason,'previousSourceRevision',c.data->'term'->>'sourceRevision','sourceRevision',source->>'sourceRevision'));
END $$;
CREATE FUNCTION app.contract_verify_records(wanted_case uuid,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO c FROM public.contract_case WHERE id=wanted_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF c.id IS NULL OR NOT app.contract_has_role(c.company_id,NULL,'gbs') OR c.data->>'state'<>'renewed' OR length(btrim(coalesce(p_reason,'')))<10 THEN RAISE EXCEPTION 'GBS verification of actual completed records is required' USING ERRCODE='42501'; END IF;
 UPDATE public.contract_effect SET status='done',completed_at=now(),receipt=receipt||jsonb_build_object('verifiedBy',app.current_user_id(),'reason',p_reason) WHERE case_id=c.id AND tenant_id=c.tenant_id AND kind='verify' AND status='pending';IF FOUND THEN PERFORM app.contract_audit(c.id,'records.verified',jsonb_build_object('reason',p_reason));END IF;
END $$;
REVOKE ALL ON FUNCTION app.contract_reconcile_source(uuid,integer,text),app.contract_verify_records(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_reconcile_source(uuid,integer,text),app.contract_verify_records(uuid,text) TO ai_hr_app;
