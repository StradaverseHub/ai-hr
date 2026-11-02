-- Unapplied BOARD owner: exact Organisation/configuration actions, not reference-picker authority.
INSERT INTO public.access_capability(id,scope,supported,bindings)
 SELECT domain||'.'||operation,CASE WHEN domain='organisation' THEN 'company' ELSE 'tenant' END,false,'[]'::jsonb
 FROM unnest(ARRAY['organisation','settings']) domain CROSS JOIN unnest(ARRAY['view','add','edit','delete']) operation;
INSERT INTO app.access_default_capability_grant(legacy_key,capability_id)
 SELECT 'hr_admin','organisation.'||operation FROM unnest(ARRAY['view','add','edit','delete']) operation;
--> statement-breakpoint
CREATE FUNCTION app.organisation_settings_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cap IN ('organisation.view','organisation.add','organisation.edit','organisation.delete','settings.view','settings.add','settings.edit','settings.delete')
 AND EXISTS(SELECT 1 FROM public.app_user a JOIN public.role_assignment r ON r.tenant_id=a.tenant_id AND r.app_user_id=a.id
 WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)
 AND r.role::text IN ('hr_admin','super_admin') AND (cap LIKE 'settings.%' OR co IS NULL AND r.company_id IS NULL OR co IS NOT NULL AND app.access_scope_covers(r.company_id,co,t)));
$$;
CREATE FUNCTION app.organisation_settings_delegation_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.organisation_settings_legacy_allowed(t,u,cap,co)
 AND (cap NOT LIKE 'settings.%' OR EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u AND r.role::text IN ('super_admin','hr_admin') AND r.company_id IS NULL));
$$;
REVOKE ALL ON FUNCTION app.organisation_settings_legacy_allowed(uuid,uuid,text,uuid),app.organisation_settings_delegation_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.organisation_settings_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current()
 AND app.organisation_settings_legacy_allowed(t,u,cap,co)
 AND CASE WHEN cap LIKE 'settings.%' THEN app.is_admin() WHEN co IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(co) END;
$$;
REVOKE ALL ON FUNCTION app.organisation_settings_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Future root companies require genuinely tenant-wide View/Add grants; no fabricated company ID.
CREATE FUNCTION app.organisation_global_action(p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_operation IN ('view','add','edit','delete') AND app.principal_snapshot_current() AND app.is_group_admin()
 AND app.organisation_settings_legacy_allowed(app.current_tenant_id(),app.current_user_id(),'organisation.'||p_operation,NULL)
 AND CASE WHEN NOT EXISTS(SELECT 1 FROM public.access_capability WHERE id='organisation.'||p_operation AND supported) THEN true ELSE
 EXISTS(SELECT 1 FROM public.access_configuration WHERE tenant_id=app.current_tenant_id() AND initialized)
 AND (p_operation='view' OR app.organisation_global_action('view'))
 AND NOT EXISTS(SELECT 1 FROM public.access_user_override o WHERE o.tenant_id=app.current_tenant_id() AND o.user_id=app.current_user_id() AND o.capability_id='organisation.'||p_operation AND o.retired_at IS NULL AND o.effect='deny')
 AND (EXISTS(SELECT 1 FROM public.access_user_override o WHERE o.tenant_id=app.current_tenant_id() AND o.user_id=app.current_user_id() AND o.capability_id='organisation.'||p_operation AND o.retired_at IS NULL AND o.effect='allow' AND o.company_id IS NULL)
 OR EXISTS(SELECT 1 FROM public.access_effective_membership m JOIN public.access_group g ON g.id=m.group_id AND g.tenant_id=m.tenant_id JOIN public.access_group_grant a ON a.group_id=g.id AND a.tenant_id=g.tenant_id
 WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND m.company_id IS NULL AND g.retired_at IS NULL AND a.capability_id='organisation.'||p_operation AND a.company_id IS NULL AND a.retired_at IS NULL)) END;
$$;
CREATE FUNCTION app.organisation_action_allowed(p_operation text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_operation IN ('view','add','edit','delete') AND app.principal_snapshot_current()
 AND CASE WHEN p_company IS NULL THEN app.organisation_global_action(p_operation) ELSE
 app.is_admin_for(p_company) AND app.organisation_settings_legacy_allowed(app.current_tenant_id(),app.current_user_id(),'organisation.'||p_operation,p_company)
 AND CASE WHEN EXISTS(SELECT 1 FROM public.access_capability WHERE id='organisation.'||p_operation AND supported)
 THEN app.access_allowed_for(app.current_user_id(),'organisation.'||p_operation,p_company) ELSE true END END;
$$;
CREATE FUNCTION app.settings_action_allowed(p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_operation IN ('view','add','edit','delete') AND app.principal_snapshot_current() AND app.is_admin()
 AND app.organisation_settings_legacy_allowed(app.current_tenant_id(),app.current_user_id(),'settings.'||p_operation,NULL)
 AND CASE WHEN EXISTS(SELECT 1 FROM public.access_capability WHERE id='settings.'||p_operation AND supported)
 THEN app.access_allowed_for(app.current_user_id(),'settings.'||p_operation,NULL) ELSE true END;
$$;
REVOKE ALL ON FUNCTION app.organisation_global_action(text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.organisation_action_allowed(text,uuid),app.settings_action_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organisation_action_allowed(text,uuid),app.settings_action_allowed(text) TO ai_hr_app;
--> statement-breakpoint
--> statement-breakpoint
-- Exact native maintenance purposes. Dormant until the restricted publisher qualifies the full
-- component; reference/picker reads keep their own native courses.
CREATE FUNCTION app.organisation_profile_option_delegation_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co IS NULL AND cap IN ('function.systemLabels.profileOptions.view','function.systemLabels.profileOptions.add','function.systemLabels.profileOptions.edit','function.systemLabels.profileOptions.delete')
 AND app.organisation_settings_delegation_allowed(t,u,'settings.'||substring(cap from '[^.]+$'),NULL);
$$;
REVOKE ALL ON FUNCTION app.organisation_profile_option_delegation_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
DO $functions$ DECLARE source record;operation text;BEGIN
 FOR source IN SELECT * FROM (VALUES
('profileRequestSettings','tenant','settings','nav.profileRequestSettings','screen','/admin/settings/profile-requests','profileRequestSettings','app.organisation_settings_delegation_allowed',ARRAY['view','edit']::text[]),
('profileApprovalRules','tenant','settings','essProfile.approvalRules','screen','/admin/settings/profile-requests/rules','profileApprovalRules','app.organisation_settings_delegation_allowed',ARRAY['view','edit']::text[]),
('organization','company','organisation','nav.organization','screen','/admin/organization','organization','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.department','company','organisation','admin.systemLabels.category.department','submenu','/admin/settings/system-labels','systemLabels','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.position','company','organisation','admin.systemLabels.category.position','submenu','/admin/settings/system-labels','systemLabels','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.cost_center','company','organisation','admin.systemLabels.category.cost_center','submenu','/admin/settings/system-labels','systemLabels','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.business_unit','company','organisation','admin.systemLabels.category.business_unit','submenu','/admin/settings/system-labels','systemLabels','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.jobGrade','tenant','settings','admin.systemLabels.category.grade','submenu','/admin/settings/system-labels','systemLabels','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions','tenant','settings','nav.profileOptions','submenu','/admin/settings/system-labels/profile-options','systemLabels','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('employeeIdConfig.company','company','organisation','nav.employeeIdConfig','submenu','/admin/settings/employee-id','employeeIdConfig','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('employeeIdConfig.global','tenant','settings','nav.employeeIdConfig','submenu','/admin/settings/employee-id','employeeIdConfig','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('peopleGeneral','tenant','settings','nav.peopleGeneral','screen','/admin/settings/people-general','peopleGeneral','app.organisation_settings_delegation_allowed',ARRAY['view','edit']::text[]),
('dashboardCardConfig','tenant','settings','nav.dashboardCardConfig','screen','/admin/settings/dashboard','dashboardCardConfig','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('loginPresentation','tenant','settings','nav.loginPresentation','screen','/admin/settings/login','loginPresentation','app.organisation_settings_delegation_allowed',ARRAY['view','edit']::text[]),
('loginPresentation.sessionPolicy','tenant','settings','sessionTimeout.settingsTitle','submenu','/admin/settings/login','loginPresentation','app.organisation_settings_delegation_allowed',ARRAY['view','edit']::text[]),
('workflowEmail','tenant','settings','nav.workflowEmail','screen','/admin/settings/notifications','workflowEmail','app.organisation_settings_delegation_allowed',ARRAY['view','edit']::text[]),
('emailTemplates','tenant','settings','nav.emailTemplates','screen','/admin/settings/email-templates','emailTemplates','app.organisation_settings_delegation_allowed',ARRAY['view','edit']::text[]),
('entra','tenant','settings','nav.entra','screen','/admin/settings/entra','entra','app.organisation_settings_delegation_allowed',ARRAY['view','edit']::text[]),
('aiConfig','tenant','settings','nav.aiConfig','screen','/control-tower/agents/provider','aiConfig','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemTesting','tenant','settings','nav.systemTesting','screen','/admin/system-testing','systemTesting','app.organisation_settings_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemExplorer','tenant','settings','nav.systemExplorer','screen','/admin/system-explorer','systemExplorer','app.organisation_settings_delegation_allowed',ARRAY['view']::text[]),
('systemLabels.profileOptions.religion','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.religion','submenu','/admin/settings/system-labels/profile-options','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.race','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.race','submenu','/admin/settings/system-labels/profile-options','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.nationality','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.nationality','submenu','/admin/settings/system-labels/profile-options','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.state','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.state','submenu','/admin/settings/system-labels/profile-options','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.country','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.country','submenu','/admin/settings/system-labels/profile-options','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.relationship','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.relationship','submenu','/admin/settings/system-labels/profile-options','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.salutation','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.salutation','submenu','/admin/settings/system-labels/profile-options','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.division','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.division','submenu','/admin/settings/system-labels','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.branch','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.branch','submenu','/admin/settings/system-labels','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.region','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.region','submenu','/admin/settings/system-labels','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.line','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.line','submenu','/admin/settings/system-labels','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.section','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.section','submenu','/admin/settings/system-labels','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.team','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.team','submenu','/admin/settings/system-labels','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.base','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.base','submenu','/admin/settings/system-labels','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.category','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.category','submenu','/admin/settings/system-labels','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.dependentRelationship','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.dependentRelationship','submenu','/admin/settings/system-labels/profile-options','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[]),
('systemLabels.profileOptions.qualificationLevel','tenant','function.systemLabels.profileOptions','admin.profileOptions.category.qualificationLevel','submenu','/admin/settings/system-labels/profile-options','systemLabels','app.organisation_profile_option_delegation_allowed',ARRAY['view','add','edit','delete']::text[])
 ) definitions(key,scope,parent,label,kind,href,screen,floor,operations) LOOP
  FOREACH operation IN ARRAY source.operations LOOP
   PERFORM app.register_function_action(source.key,operation,source.scope,source.parent||'.'||operation,source.floor,
    jsonb_build_object('moduleKey',CASE WHEN source.parent LIKE 'function.%' THEN 'settings' ELSE source.parent END,'labelKey',source.label,'kind',source.kind,'course','administrative','screenKey',source.screen,'href',source.href,'employeeBearing',false));
  END LOOP;
 END LOOP;
END $functions$;
CREATE FUNCTION app.organisation_settings_function_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.access_function_action f JOIN app.access_function_definition d USING(function_key)
 WHERE f.capability_id=cap AND (f.parent_capability ~ '^(organisation|settings)\.' OR f.function_key LIKE 'systemLabels.profileOptions.%' AND f.parent_capability='function.systemLabels.profileOptions.'||f.operation)
 AND app.organisation_settings_legacy_allowed(t,u,CASE WHEN f.function_key LIKE 'systemLabels.profileOptions.%' THEN 'settings.'||f.operation ELSE f.parent_capability END,co)
 AND (f.function_key NOT IN ('dashboardCardConfig.usage','employeeIdConfig.global','peopleGeneral','loginPresentation','loginPresentation.sessionPolicy','aiConfig','emailTemplates','entra') AND NOT(f.function_key IN ('workflowEmail','profileRequestSettings','profileApprovalRules') AND f.operation<>'view')
  OR EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=t AND r.app_user_id=u AND r.role::text IN ('hr_admin','super_admin') AND r.company_id IS NULL)));
$$;
CREATE FUNCTION app.organisation_settings_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current()
 AND app.organisation_settings_function_legacy_allowed(t,u,cap,co)
 AND EXISTS(SELECT 1 FROM app.access_function_action f WHERE f.capability_id=cap
 AND app.organisation_settings_current_legacy_allowed(t,u,CASE WHEN f.function_key LIKE 'systemLabels.profileOptions.%' THEN 'settings.'||f.operation ELSE f.parent_capability END,co)
 AND (f.function_key NOT IN ('dashboardCardConfig.usage','employeeIdConfig.global','peopleGeneral','loginPresentation','loginPresentation.sessionPolicy','aiConfig','emailTemplates','entra') AND NOT(f.function_key IN ('workflowEmail','profileRequestSettings','profileApprovalRules') AND f.operation<>'view') OR app.is_group_admin()));
$$;
CREATE FUNCTION app.organisation_settings_function_allowed(p_key text,p_operation text,p_company uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.access_function_action f JOIN app.access_function_definition d USING(function_key)
 WHERE f.function_key=p_key AND f.operation=p_operation AND (f.parent_capability ~ '^(organisation|settings)\.' OR f.function_key LIKE 'systemLabels.profileOptions.%' AND f.parent_capability='function.systemLabels.profileOptions.'||f.operation)
 AND app.organisation_settings_function_current_legacy_allowed(app.current_tenant_id(),app.current_user_id(),f.capability_id,p_company)
 AND CASE WHEN f.function_key LIKE 'systemLabels.profileOptions.%' THEN app.organisation_settings_function_allowed('systemLabels.profileOptions',p_operation,NULL) WHEN f.parent_capability LIKE 'settings.%' THEN app.settings_action_allowed(p_operation) ELSE app.organisation_action_allowed(p_operation,p_company) END
 AND CASE WHEN d.scope='company' AND p_company IS NULL THEN app.function_global_action_allowed(p_key,p_operation) ELSE app.function_action_allowed(p_key,p_operation,p_company) END);
$$;
REVOKE ALL ON FUNCTION app.organisation_settings_function_legacy_allowed(uuid,uuid,text,uuid),app.organisation_settings_function_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.organisation_settings_function_allowed(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organisation_settings_function_allowed(text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.organisation_birth(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,kind text NOT NULL,row_id uuid NOT NULL,company_id uuid NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,kind,row_id));
ALTER TABLE app.organisation_birth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.organisation_birth FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.organisation_company_born(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.organisation_birth b JOIN public.company c ON c.id=b.row_id AND c.tenant_id=b.tenant_id
 WHERE b.xact_id=pg_current_xact_id() AND b.tenant_id=app.current_tenant_id() AND b.user_id=app.current_user_id() AND b.kind='company' AND b.row_id=p_company);
$$;
REVOKE ALL ON FUNCTION app.organisation_company_born(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.organisation_remember_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 DELETE FROM app.organisation_birth WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 IF NOT app.access_workforce_storage_owner() THEN
 INSERT INTO app.organisation_birth VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),TG_TABLE_NAME,NEW.id,CASE WHEN TG_TABLE_NAME='company' THEN NEW.id ELSE (to_jsonb(NEW)->>'company_id')::uuid END) ON CONFLICT DO NOTHING;
 END IF;RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.organisation_remember_birth() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.settings_birth(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,kind text NOT NULL,row_id uuid NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,kind,row_id));
ALTER TABLE app.settings_birth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.settings_birth FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.settings_born(p_kind text,p_row uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.settings_birth b WHERE b.xact_id=pg_current_xact_id() AND b.tenant_id=app.current_tenant_id() AND b.user_id=app.current_user_id() AND b.kind=p_kind AND b.row_id=p_row);
$$;
REVOKE ALL ON FUNCTION app.settings_born(text,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.settings_remember_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 DELETE FROM app.settings_birth WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 IF NOT app.access_workforce_storage_owner() THEN INSERT INTO app.settings_birth VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),TG_TABLE_NAME,NEW.id) ON CONFLICT DO NOTHING;END IF;RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.settings_remember_birth() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER settings_successful_birth AFTER INSERT ON public.test_case FOR EACH ROW EXECUTE FUNCTION app.settings_remember_birth();
--> statement-breakpoint
CREATE TABLE app.organisation_number_intent(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,config_id uuid NOT NULL,before_number integer NOT NULL,after_number integer NOT NULL,draft_id uuid,PRIMARY KEY(xact_id,tenant_id,user_id,config_id));
ALTER TABLE app.organisation_number_intent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.organisation_number_intent FROM PUBLIC,ai_hr_app;
-- A code is witnessed only after the native allocator successfully changes its real counter.
CREATE TABLE app.organisation_issued_code(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,company_id uuid NOT NULL,config_id uuid NOT NULL,number integer NOT NULL,code text NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,company_id,code));
ALTER TABLE app.organisation_issued_code ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.organisation_issued_code FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.organisation_employee_code_issued(p_company uuid,p_code text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.organisation_issued_code i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id() AND i.company_id=p_company AND i.code=p_code);
$$;
REVOKE ALL ON FUNCTION app.organisation_employee_code_issued(uuid,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.organisation_allocate_employee_code(p_company uuid) RETURNS TABLE(code text,config_id uuid,number integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.employee_id_config%ROWTYPE;n integer;
BEGIN
 PERFORM app.access_workforce_write_lock();
 DELETE FROM app.organisation_number_intent WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 DELETE FROM app.organisation_issued_code WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 IF NOT app.is_admin_for(p_company) OR NOT app.access_workforce_action_company(p_company,'add') THEN RAISE EXCEPTION 'Employee admission unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.employee_id_config WHERE tenant_id=app.current_tenant_id() AND status='active' AND (company_id=p_company OR company_id IS NULL) ORDER BY company_id IS NULL LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;
 n:=CASE WHEN c.current_running_number<c.start_number THEN c.start_number ELSE c.current_running_number+c.increment END;
 INSERT INTO app.organisation_number_intent VALUES(pg_current_xact_id(),c.tenant_id,app.current_user_id(),c.id,c.current_running_number,n,NULL)
 ON CONFLICT ON CONSTRAINT organisation_number_intent_pkey DO UPDATE SET before_number=EXCLUDED.before_number,after_number=EXCLUDED.after_number;
 UPDATE public.employee_id_config SET current_running_number=n,updated_at=now() WHERE id=c.id;
 INSERT INTO app.organisation_issued_code VALUES(pg_current_xact_id(),c.tenant_id,app.current_user_id(),p_company,c.id,n,c.prefix||lpad(n::text,greatest(c.number_length,length(n::text)),'0')||c.suffix);
 RETURN QUERY SELECT c.prefix||lpad(n::text,greatest(c.number_length,length(n::text)),'0')||c.suffix,c.id,n;
END;$$;
REVOKE ALL ON FUNCTION app.organisation_allocate_employee_code(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organisation_allocate_employee_code(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Only configuration readers/writers use this dispatch. Runtime ESS settings keep their own course.
CREATE FUNCTION app.organisation_setting_function_key(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_key IN ('ess.profile_change_fields','ess.profile_change_approver','ess.profile_photo_edit') THEN 'profileRequestSettings'
 WHEN p_key='ess.profile_change_routing' THEN 'profileApprovalRules' END;
$$;
REVOKE ALL ON FUNCTION app.organisation_setting_function_key(text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.tenant_setting_action_allowed(p_key text,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.organisation_setting_function_key(p_key) IS NULL THEN app.settings_action_allowed(p_operation)
 ELSE app.organisation_settings_function_allowed(app.organisation_setting_function_key(p_key),p_operation,NULL) END;
$$;
REVOKE ALL ON FUNCTION app.tenant_setting_action_allowed(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_setting_action_allowed(text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.organisation_settings_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b jsonb:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;a jsonb:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;r jsonb:=coalesce(a,b);
 op text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;co uuid;origin uuid;requested_kind text;label uuid;prior_parent uuid;next_parent uuid;function_key text;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF (r->>'tenant_id')::uuid IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() OR (a IS NOT NULL AND b IS NOT NULL AND (a->>'tenant_id' IS DISTINCT FROM b->>'tenant_id' OR a->>'id' IS DISTINCT FROM b->>'id')) THEN RAISE EXCEPTION 'Configuration principal unavailable' USING ERRCODE='42501';END IF;
 -- Separate native Leave escalation permission owns only these actual Company columns.
 IF TG_TABLE_NAME='company' AND TG_OP='UPDATE' AND app.leave_approval_escalation_source_allowed(b,a) THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND b->>'archived_at' IS NULL AND a->>'archived_at' IS NOT NULL THEN op:='delete';END IF;
 IF TG_TABLE_NAME IN ('job_grade','profile_option','people_general_policy','dashboard_card_config','login_presentation','session_policy','tenant_setting','email_design','email_design_version','email_asset','notification_email_policy','ai_provider_config','entra_connector','test_case','test_case_version','test_assignment','test_catalogue_update') THEN
  IF TG_TABLE_NAME='test_case' AND TG_OP='UPDATE' AND app.settings_born('test_case',(a->>'id')::uuid) THEN op:='add';END IF;
  IF TG_TABLE_NAME='test_case_version' THEN op:=CASE WHEN app.settings_born('test_case',(r->>'test_case_id')::uuid) THEN 'add' ELSE 'edit' END;END IF;
  IF TG_TABLE_NAME='test_assignment' AND TG_OP='UPDATE' AND (b->>'active')::boolean AND NOT (a->>'active')::boolean THEN op:='delete';END IF;
  IF TG_TABLE_NAME IN ('login_presentation','session_policy','tenant_setting','email_design','email_design_version','email_asset','notification_email_policy','entra_connector') THEN op:=CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'edit' END;END IF;
  -- The policy is one revisioned setting: first materialization is Edit, not permission to add policies.
  IF TG_TABLE_NAME='people_general_policy' THEN
   -- Admission counters are private native plumbing. The app has no raw table privilege.
   IF TG_OP='UPDATE' AND (a-'admission_version')=(b-'admission_version') AND (a->>'admission_version')::bigint=(b->>'admission_version')::bigint+1 THEN RETURN NEW;END IF;
   IF TG_OP='INSERT' AND NOT (a->>'allow_duplicated_nric')::boolean AND NOT (a->>'allow_duplicated_email')::boolean AND (a->>'admission_version')::bigint=1 THEN RETURN NEW;END IF;
   op:='edit';
  END IF;
  IF TG_TABLE_NAME='profile_option' AND TG_OP='UPDATE' AND b->>'category' IS DISTINCT FROM a->>'category' THEN RAISE EXCEPTION 'Profile option category is immutable' USING ERRCODE='42501';END IF;
  IF TG_TABLE_NAME='tenant_setting' AND TG_OP='UPDATE' AND a->>'key' IS DISTINCT FROM b->>'key' THEN RAISE EXCEPTION 'Setting key is immutable' USING ERRCODE='42501';END IF;
  function_key:=CASE TG_TABLE_NAME WHEN 'tenant_setting' THEN app.organisation_setting_function_key(r->>'key') WHEN 'job_grade' THEN 'systemLabels.jobGrade' WHEN 'profile_option' THEN 'systemLabels.profileOptions.'||(r->>'category') WHEN 'people_general_policy' THEN 'peopleGeneral' WHEN 'dashboard_card_config' THEN 'dashboardCardConfig' WHEN 'login_presentation' THEN 'loginPresentation' WHEN 'session_policy' THEN 'loginPresentation.sessionPolicy' WHEN 'email_design' THEN 'emailTemplates' WHEN 'email_design_version' THEN 'emailTemplates' WHEN 'email_asset' THEN 'emailTemplates' WHEN 'notification_email_policy' THEN 'workflowEmail' WHEN 'ai_provider_config' THEN 'aiConfig' WHEN 'entra_connector' THEN 'entra' WHEN 'test_case' THEN 'systemTesting' WHEN 'test_case_version' THEN 'systemTesting' WHEN 'test_assignment' THEN 'systemTesting' WHEN 'test_catalogue_update' THEN 'systemTesting' ELSE NULL END;
  IF function_key IS NOT NULL AND NOT app.organisation_settings_function_allowed(function_key,op,NULL) THEN RAISE EXCEPTION 'Settings function unavailable' USING ERRCODE='42501';END IF;
  IF NOT app.settings_action_allowed(op) THEN RAISE EXCEPTION 'Settings action unavailable' USING ERRCODE='42501';END IF;
 ELSIF TG_TABLE_NAME='employee_id_config' THEN
  -- Exact private number allocation is plumbing, never arbitrary Settings Edit.
  IF TG_OP='UPDATE' AND (a-'current_running_number'-'updated_at')=(b-'current_running_number'-'updated_at') AND EXISTS(
   SELECT 1 FROM app.organisation_number_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id() AND i.config_id=(a->>'id')::uuid AND i.before_number=(b->>'current_running_number')::integer AND i.after_number=(a->>'current_running_number')::integer AND (i.draft_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.employee_draft d WHERE d.id=i.draft_id AND d.tenant_id=i.tenant_id))) THEN
   DELETE FROM app.organisation_number_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND config_id=(a->>'id')::uuid;RETURN NEW;
  END IF;
  co:=(r->>'company_id')::uuid;
  IF NOT app.organisation_settings_function_allowed(CASE WHEN co IS NULL THEN 'employeeIdConfig.global' ELSE 'employeeIdConfig.company' END,op,co) THEN RAISE EXCEPTION 'Employee ID function unavailable' USING ERRCODE='42501';END IF;
  IF (co IS NULL AND NOT app.settings_action_allowed(op)) OR (co IS NOT NULL AND NOT app.organisation_action_allowed(op,co)) THEN RAISE EXCEPTION 'Employee ID configuration action unavailable' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' AND (a->>'company_id') IS DISTINCT FROM (b->>'company_id') THEN RAISE EXCEPTION 'Configuration scope is immutable' USING ERRCODE='42501';END IF;
 ELSIF TG_TABLE_NAME='label_company_assignment' THEN
  IF TG_OP='UPDATE' AND (a->>'label_kind' IS DISTINCT FROM b->>'label_kind' OR a->>'label_id' IS DISTINCT FROM b->>'label_id' OR a->>'company_id' IS DISTINCT FROM b->>'company_id') THEN RAISE EXCEPTION 'Label criteria identity is immutable' USING ERRCODE='42501';END IF;
  requested_kind:=r->>'label_kind';label:=(r->>'label_id')::uuid;co:=(r->>'company_id')::uuid;
  IF requested_kind NOT IN ('department','position','cost_center','business_unit') THEN RAISE EXCEPTION 'Unknown label' USING ERRCODE='42501';END IF;
  EXECUTE format('SELECT company_id FROM public.%I WHERE id=$1 AND tenant_id=$2',requested_kind) INTO origin USING label,app.current_tenant_id();
  IF origin IS NULL THEN
   -- Existing native delete cleanup has already removed the label. Its private successful-delete proof is exact.
   IF TG_OP<>'DELETE' OR NOT EXISTS(SELECT 1 FROM app.organisation_birth i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id() AND i.kind='deleted:'||requested_kind AND i.row_id=label) THEN RAISE EXCEPTION 'Label owner unavailable' USING ERRCODE='42501';END IF;
  ELSE
   op:=CASE WHEN EXISTS(SELECT 1 FROM app.organisation_birth i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id() AND i.kind=requested_kind AND i.row_id=label) THEN 'add' ELSE 'edit' END;
   IF NOT app.organisation_settings_function_allowed('systemLabels.'||requested_kind,op,origin) OR NOT app.organisation_settings_function_allowed('systemLabels.'||requested_kind,op,co) THEN RAISE EXCEPTION 'Label criteria function unavailable' USING ERRCODE='42501';END IF;
   IF NOT app.organisation_action_allowed(op,origin) OR NOT app.organisation_action_allowed(op,co) THEN RAISE EXCEPTION 'Label criteria action unavailable' USING ERRCODE='42501';END IF;
  END IF;
 ELSE
  co:=CASE WHEN TG_TABLE_NAME='company' THEN (r->>'id')::uuid ELSE (r->>'company_id')::uuid END;
  function_key:=CASE WHEN TG_TABLE_NAME IN ('company','company_logo') THEN 'organization' ELSE 'systemLabels.'||TG_TABLE_NAME END;
  -- Branding replaces/removes a company attribute; it never creates/deletes the organisation.
  IF TG_TABLE_NAME='company_logo' THEN op:='edit';END IF;
  IF TG_TABLE_NAME='company' AND TG_OP='INSERT' THEN
   IF NOT app.organisation_settings_function_allowed('organization','add',(a->>'parent_company_id')::uuid) THEN RAISE EXCEPTION 'Organisation function Add unavailable' USING ERRCODE='42501';END IF;
   IF NOT app.organisation_action_allowed('add',(a->>'parent_company_id')::uuid) THEN RAISE EXCEPTION 'Organisation Add unavailable' USING ERRCODE='42501';END IF;
  ELSE
   IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('department','position','cost_center','business_unit') AND EXISTS(SELECT 1 FROM app.organisation_birth i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id() AND i.kind=TG_TABLE_NAME AND i.row_id=(r->>'id')::uuid) THEN op:='add';END IF;
   IF NOT app.organisation_settings_function_allowed(function_key,op,co) THEN RAISE EXCEPTION 'Organisation function unavailable' USING ERRCODE='42501';END IF;
   IF NOT app.organisation_action_allowed(op,co) THEN RAISE EXCEPTION 'Organisation action unavailable' USING ERRCODE='42501';END IF;
   IF TG_OP='UPDATE' AND TG_TABLE_NAME<>'company' AND (a->>'company_id') IS DISTINCT FROM (b->>'company_id') THEN
    IF NOT app.organisation_settings_function_allowed(function_key,op,(b->>'company_id')::uuid) OR NOT app.organisation_settings_function_allowed(function_key,op,(a->>'company_id')::uuid) THEN RAISE EXCEPTION 'Organisation destination unavailable' USING ERRCODE='42501';END IF;
   END IF;
   IF TG_TABLE_NAME='company' AND TG_OP='UPDATE' AND (a->>'parent_company_id') IS DISTINCT FROM (b->>'parent_company_id') THEN
    prior_parent:=(b->>'parent_company_id')::uuid;next_parent:=(a->>'parent_company_id')::uuid;
    IF (prior_parent IS NOT NULL AND NOT app.organisation_settings_function_allowed('organization','edit',prior_parent)) OR NOT app.organisation_settings_function_allowed('organization','edit',next_parent) THEN RAISE EXCEPTION 'Organisation parent destination unavailable' USING ERRCODE='42501';END IF;
   END IF;
  END IF;
  IF TG_OP='DELETE' AND TG_TABLE_NAME IN ('department','position','cost_center','business_unit') THEN
   INSERT INTO app.organisation_birth VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),'deleted:'||TG_TABLE_NAME,(b->>'id')::uuid,co) ON CONFLICT DO NOTHING;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END;$$;
REVOKE ALL ON FUNCTION app.organisation_settings_write_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Successful upserts are classified by the row guard after conflict resolution.
-- Join Access before taking either source row lock, including direct runtime writes.
CREATE FUNCTION app.organisation_settings_upsert_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN PERFORM app.access_workforce_write_lock();END IF;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.organisation_settings_upsert_lock() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER organisation_settings_upsert_lock BEFORE INSERT OR UPDATE OR DELETE ON public.profile_option FOR EACH STATEMENT EXECUTE FUNCTION app.organisation_settings_upsert_lock();
CREATE TRIGGER organisation_settings_upsert_lock BEFORE INSERT OR UPDATE OR DELETE ON public.ai_provider_config FOR EACH STATEMENT EXECUTE FUNCTION app.organisation_settings_upsert_lock();
CREATE TRIGGER organisation_settings_upsert_lock BEFORE INSERT OR UPDATE OR DELETE ON public.session_policy FOR EACH STATEMENT EXECUTE FUNCTION app.organisation_settings_upsert_lock();
--> statement-breakpoint
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['company','department','position','cost_center','business_unit','job_grade','profile_option','employee_id_config','people_general_policy','label_company_assignment','company_logo','dashboard_card_config','login_presentation','session_policy','tenant_setting','email_design','email_design_version','email_asset','notification_email_policy','ai_provider_config','entra_connector','test_case','test_case_version','test_assignment','test_catalogue_update'] LOOP
 -- Provider configuration is upserted: only the successful row operation determines Add/Edit.
 EXECUTE format('CREATE TRIGGER organisation_settings_action %s INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.organisation_settings_write_guard()',CASE WHEN name IN ('ai_provider_config','profile_option') THEN 'AFTER' ELSE 'BEFORE' END,name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['company','department','position','cost_center','business_unit'] LOOP
 EXECUTE format('CREATE TRIGGER a00_organisation_successful_birth AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.organisation_remember_birth()',name);
 END LOOP;
END;$$;

--> statement-breakpoint
-- Prepare only a counter rollback belonging to the actual locked draft. Consumption requires
-- that same draft to have been deleted; preparing alone cannot advance or rewind a sequence.
CREATE FUNCTION app.organisation_prepare_draft_number_release(p_draft uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.employee_draft%ROWTYPE;c public.employee_id_config%ROWTYPE;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO d FROM public.employee_draft WHERE id=p_draft AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.access_workforce_draft_delete_allowed(d.id) THEN RAISE EXCEPTION 'Draft delete unavailable' USING ERRCODE='42501';END IF;
 IF d.reserved_config_id IS NULL OR d.reserved_number IS NULL OR d.reserved_employee_code IS NULL THEN RETURN;END IF;
 SELECT * INTO c FROM public.employee_id_config WHERE id=d.reserved_config_id AND tenant_id=d.tenant_id FOR UPDATE;
 IF NOT FOUND OR c.current_running_number<>d.reserved_number THEN RETURN;END IF;
 IF c.prefix||lpad(d.reserved_number::text,greatest(c.number_length,length(d.reserved_number::text)),'0')||c.suffix IS DISTINCT FROM d.reserved_employee_code THEN RAISE EXCEPTION 'Draft reserved number changed' USING ERRCODE='42501';END IF;
 INSERT INTO app.organisation_number_intent VALUES(pg_current_xact_id(),d.tenant_id,app.current_user_id(),c.id,c.current_running_number,c.current_running_number-c.increment,d.id)
 ON CONFLICT ON CONSTRAINT organisation_number_intent_pkey DO UPDATE SET before_number=EXCLUDED.before_number,after_number=EXCLUDED.after_number,draft_id=EXCLUDED.draft_id;
END;$$;
REVOKE ALL ON FUNCTION app.organisation_prepare_draft_number_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organisation_prepare_draft_number_release(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Extend the exact0941 delegation owner; retain all its financial/letter and View ceilings.
CREATE OR REPLACE FUNCTION app.access_can_delegate(p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.access_capability c
  JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
  WHERE c.id=p_capability AND app.access_current_capability_source(p_capability,p_company)
   AND (p_capability NOT IN ('workforce.add','workforce.edit','workforce.delete','workforce.maintain') OR CASE WHEN p_company IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(p_company) END)
   AND (p_capability !~ '^(organisation|settings)\.' OR app.organisation_settings_delegation_allowed(u.tenant_id,u.id,p_capability,p_company) AND CASE WHEN p_capability LIKE 'settings.%' THEN app.settings_action_allowed(split_part(p_capability,'.',2)) ELSE app.organisation_action_allowed(split_part(p_capability,'.',2),p_company) END) AND (p_capability !~ '^(payroll|performance_compensation|letters)\.' OR app.financial_letter_delegation_allowed(u.tenant_id,u.id,p_capability,p_company)) AND (p_capability !~ '^[a-z][a-z0-9_]*\.(add|edit|delete|approve|issue)$' OR app.access_can_delegate(split_part(p_capability,'.',1)||'.view',p_company)) AND c.supported AND jsonb_array_length(c.bindings)>0
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND CASE WHEN c.scope='tenant' THEN p_company IS NULL AND app.access_allowed_for(u.id,c.id,NULL)
    WHEN p_company IS NOT NULL THEN app.access_allowed_for(u.id,c.id,p_company)
    ELSE EXISTS(SELECT 1 FROM public.access_configuration s WHERE s.tenant_id=u.tenant_id AND s.initialized)
     AND (EXISTS(SELECT 1 FROM public.access_user_override o WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.capability_id=c.id AND o.company_id IS NULL AND o.effect='allow' AND o.retired_at IS NULL)
      OR EXISTS(SELECT 1 FROM public.access_effective_membership m JOIN public.access_group g ON g.id=m.group_id AND g.tenant_id=m.tenant_id
       JOIN public.access_group_grant a ON a.group_id=g.id AND a.tenant_id=g.tenant_id
       WHERE m.tenant_id=u.tenant_id AND m.user_id=u.id AND m.company_id IS NULL
        AND g.retired_at IS NULL AND a.capability_id=c.id AND a.company_id IS NULL AND a.retired_at IS NULL)) END
   AND NOT EXISTS(SELECT 1 FROM public.access_user_override o
    WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.capability_id=c.id AND o.effect='deny' AND o.retired_at IS NULL
     AND (p_company IS NULL OR o.company_id IS NULL
      OR app.access_scope_covers(o.company_id,p_company,u.tenant_id)
      OR app.access_scope_covers(p_company,o.company_id,u.tenant_id)))
 );
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.email_design_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND r.role::text IN ('hr_admin','super_admin') AND r.company_id IS NULL) AND app.organisation_settings_function_allowed('emailTemplates','view',NULL); $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.entra_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.organisation_settings_function_allowed('entra','view',NULL) AND EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND NOT app.login_blocked(u.id)
 AND r.company_id IS NULL AND r.role IN ('super_admin','hr_admin')
 AND NOT app.access_configuration_denied_for(u.tenant_id,u.id));
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.entra_configure(p_org text,p_directory uuid,p_mode text,p_enabled boolean,p_provision boolean,p_revision uuid,p_expected uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old public.entra_connector%ROWTYPE; t uuid:=app.current_tenant_id();
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.entra_admin() OR NOT app.organisation_settings_function_allowed('entra','edit',NULL) THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('entra-config:'||t,0));
 SELECT * INTO old FROM public.entra_connector WHERE tenant_id=t FOR UPDATE;
 IF old.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'entra_conflict'; END IF;
 -- Moving a directory requires a separate reviewed identity migration, never an in-place takeover.
 IF old.tenant_id IS NOT NULL AND (old.directory_tenant_id<>p_directory OR old.organization<>p_org OR old.mode<>p_mode) THEN RAISE EXCEPTION 'entra_conflict'; END IF;
 INSERT INTO public.entra_connector VALUES(t,p_org,p_directory,p_mode,p_enabled,p_provision,p_revision)
 ON CONFLICT(tenant_id) DO UPDATE SET enabled=p_enabled,provisioning_enabled=p_provision,revision=p_revision;
 INSERT INTO public.entra_workforce(tenant_id,person_id) SELECT t,p.id FROM public.person p WHERE p.tenant_id=t AND EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p.id AND e.tenant_id=t)
 ON CONFLICT(tenant_id,person_id) DO UPDATE SET revision=entra_workforce.revision+1,next_at=now(),status=CASE WHEN entra_workforce.lease IS NOT NULL THEN 'processing' WHEN entra_workforce.status='uncertain' AND entra_workforce.last_location IS NULL THEN 'uncertain' ELSE 'pending' END;
 PERFORM app.append_auth_event(t,'entra-connector',t,'entra.configured','user',app.current_user_id(),jsonb_build_object('revision',p_revision,'enabled',p_enabled,'provisioning',p_provision));
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.entra_bind(p_person uuid,p_user uuid,p_object uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.entra_connector%ROWTYPE; u public.app_user%ROWTYPE; iss text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.entra_admin() OR NOT app.organisation_settings_function_allowed('entra','edit',NULL) THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO c FROM public.entra_connector WHERE tenant_id=app.current_tenant_id() AND enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'entra_forbidden'; END IF;
 PERFORM 1 FROM public.person p WHERE p.tenant_id=c.tenant_id AND p.id=p_person AND p.voided_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'entra_forbidden'; END IF;
 SELECT * INTO u FROM public.app_user WHERE id=p_user AND person_id=p_person AND tenant_id=c.tenant_id FOR UPDATE;
 IF NOT FOUND OR app.login_blocked(u.id) THEN RAISE EXCEPTION 'entra_forbidden'; END IF;
 IF EXISTS(SELECT 1 FROM public.deployment_identity_operator o JOIN public.app_external_identity i USING(issuer,subject) WHERE i.app_user_id=u.id AND o.revoked_at IS NULL)
 OR (u.id<>app.current_user_id() AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.role<>'employee')) THEN RAISE EXCEPTION 'entra_forbidden'; END IF;
 iss:='https://login.microsoftonline.com/'||c.directory_tenant_id||'/v2.0';
 IF EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=iss AND i.subject=p_object::text AND (i.app_user_id<>u.id OR i.revoked_at IS NOT NULL))
 OR EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=iss AND i.app_user_id=u.id AND i.subject<>p_object::text) THEN RAISE EXCEPTION 'entra_conflict'; END IF;
 INSERT INTO public.app_external_identity(issuer,subject,app_user_id) VALUES(iss,p_object::text,u.id) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=iss AND i.subject=p_object::text AND i.app_user_id=u.id AND i.revoked_at IS NULL) THEN RAISE EXCEPTION 'entra_conflict'; END IF;
 UPDATE public.entra_workforce SET object_id=p_object,status=CASE WHEN status='awaiting-link' THEN 'ready' ELSE status END WHERE tenant_id=c.tenant_id AND person_id=p_person;
 PERFORM app.append_auth_event(c.tenant_id,'app-user',u.id,'entra.identity-linked','user',app.current_user_id(),jsonb_build_object('objectId',p_object));
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.entra_retry(p_person uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.entra_admin() OR NOT app.organisation_settings_function_allowed('entra','edit',NULL) THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
 -- Uncertain creates have no safe receipt: do not blindly replay them. IT reconciles upstream first.
 UPDATE public.entra_workforce SET status=CASE WHEN last_status='awaiting-sync' AND submitted_revision=revision THEN 'awaiting-sync' WHEN status='rejected' OR last_location IS NULL THEN 'pending' ELSE 'submitted' END,
 last_location=CASE WHEN status='rejected' THEN NULL ELSE last_location END,next_at=now(),attempts=0
 WHERE tenant_id=app.current_tenant_id() AND person_id=p_person AND status IN ('failed','rejected') AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'entra_conflict'; END IF;
END;
$$;

--> statement-breakpoint
-- Administrative library reads narrow with Settings View; actual assigned tester courses remain independent.
CREATE POLICY settings_test_case_read ON public.test_case AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND (app.organisation_settings_function_allowed('systemTesting','view',NULL) OR app.testing_assigned(id)));
CREATE POLICY settings_test_version_read ON public.test_case_version AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND (app.organisation_settings_function_allowed('systemTesting','view',NULL) OR app.testing_assigned(test_case_id)));
CREATE POLICY settings_test_assignment_read ON public.test_assignment AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND (app.organisation_settings_function_allowed('systemTesting','view',NULL) OR tester_user_id=app.current_user_id()));
CREATE POLICY settings_test_catalogue_read ON public.test_catalogue_update AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND (app.organisation_settings_function_allowed('systemTesting','view',NULL)));

--> statement-breakpoint
-- Candidate custody and protocol receipts are real configuration commands, not live-provider rows.
-- Keep the original native actor predicate and add View to its finite public readers.
DO $provider_actor$ DECLARE source text;anchor text:='SELECT app.current_tenant_id() IS NOT NULL';BEGIN
 SELECT pg_get_functiondef('app._ai_provider_evaluation_actor_valid()'::regprocedure) INTO source;
 IF (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Provider actor owner anchor changed';END IF;
 EXECUTE replace(source,anchor,'SELECT app.organisation_settings_function_allowed(''aiConfig'',''view'',NULL) AND app.current_tenant_id() IS NOT NULL');
END $provider_actor$;
CREATE FUNCTION app.ai_configuration_native_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 operation text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_TABLE_NAME='ai_provider_protocol_evaluation' AND TG_OP<>'DELETE' THEN operation:='edit';END IF;
 IF TG_TABLE_NAME='ai_provider_candidate' AND TG_OP='INSERT' AND EXISTS(SELECT 1 FROM public.ai_provider_config actual WHERE actual.tenant_id=(r->>'tenant_id')::uuid AND actual.provider::text=r->>'provider') THEN operation:='edit';END IF;
 IF r->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR NOT app.principal_snapshot_current() OR NOT app.is_group_admin()
 OR NOT app.organisation_settings_function_allowed('aiConfig',operation,NULL) THEN RAISE EXCEPTION 'Provider configuration action unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.ai_configuration_native_write_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER ai_configuration_native_write_guard AFTER INSERT OR UPDATE OR DELETE ON public.ai_provider_candidate FOR EACH ROW EXECUTE FUNCTION app.ai_configuration_native_write_guard();
CREATE TRIGGER ai_configuration_native_write_guard AFTER INSERT OR UPDATE OR DELETE ON public.ai_provider_protocol_evaluation FOR EACH ROW EXECUTE FUNCTION app.ai_configuration_native_write_guard();
CREATE TRIGGER organisation_settings_upsert_lock BEFORE INSERT OR UPDATE OR DELETE ON public.ai_provider_candidate FOR EACH STATEMENT EXECUTE FUNCTION app.organisation_settings_upsert_lock();
CREATE TRIGGER organisation_settings_upsert_lock BEFORE INSERT OR UPDATE OR DELETE ON public.ai_provider_protocol_evaluation FOR EACH STATEMENT EXECUTE FUNCTION app.organisation_settings_upsert_lock();

--> statement-breakpoint
-- A restored control must not revive a provider review made before its revocation.
CREATE FUNCTION app.ai_configuration_evaluation_stamp() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app._ai_provider_evaluation_actor_valid() AND app.organisation_settings_function_allowed('aiConfig','edit',NULL) THEN app.access_function_authority_stamp() END;
$$;
REVOKE ALL ON FUNCTION app.ai_configuration_evaluation_stamp() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_configuration_evaluation_stamp() TO ai_hr_app;
CREATE TABLE app.ai_configuration_evaluation_authority(
 evaluation_id uuid PRIMARY KEY REFERENCES public.ai_provider_protocol_evaluation(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,source jsonb NOT NULL,authority_stamp text NOT NULL
);
ALTER TABLE app.ai_configuration_evaluation_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_configuration_evaluation_authority FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.ai_configuration_evaluation_authority_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE stamp text;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 stamp:=app.ai_configuration_evaluation_stamp();
 IF stamp IS NULL OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.evaluated_by_user_id IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Provider review authority unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='INSERT' THEN
  INSERT INTO app.ai_configuration_evaluation_authority VALUES(NEW.id,NEW.tenant_id,NEW.evaluated_by_user_id,to_jsonb(NEW),stamp);
 ELSIF NOT EXISTS(SELECT 1 FROM app.ai_configuration_evaluation_authority proof WHERE proof.evaluation_id=NEW.id AND proof.tenant_id=NEW.tenant_id AND proof.user_id=NEW.evaluated_by_user_id AND proof.authority_stamp=stamp
  AND (proof.source-ARRAY['consumed_at','consumed_tx','promoted_at'])=(to_jsonb(NEW)-ARRAY['consumed_at','consumed_tx','promoted_at'])) THEN
  RAISE EXCEPTION 'Provider review authority changed; evaluate again' USING ERRCODE='40001';
 END IF;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app.ai_configuration_evaluation_authority_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER ai_configuration_protocol_authority AFTER INSERT OR UPDATE ON public.ai_provider_protocol_evaluation FOR EACH ROW EXECUTE FUNCTION app.ai_configuration_evaluation_authority_guard();

--> statement-breakpoint
-- Reconciliation is an administrative mutation, independent of status View.
CREATE OR REPLACE FUNCTION app.entra_reconcile_hold(p_person uuid,p_day date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.entra_admin() OR NOT app.organisation_settings_function_allowed('entra','edit',NULL) THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
 UPDATE public.entra_workforce SET status='awaiting-sync',last_active=app.entra_active(tenant_id,person_id,p_day),
 submitted_revision=revision,next_at=now()
 WHERE tenant_id=app.current_tenant_id() AND person_id=p_person AND status='uncertain' AND last_location IS NULL
 AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'entra_conflict'; END IF;
 PERFORM app.append_auth_event(app.current_tenant_id(),'entra-workforce',p_person,'entra.reconciliation-requested','user',app.current_user_id(),NULL);
END;
$$;

--> statement-breakpoint
-- Keep the original validator, revision, history and audit owner intact. Join
-- Access before its per-design lock and require Edit before either native writer.
ALTER FUNCTION app.email_design_save(text,text,jsonb,integer) RENAME TO organisation_email_design_save_native;
REVOKE ALL ON FUNCTION app.organisation_email_design_save_native(text,text,jsonb,integer) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.email_design_save(p_kind text,p_locale text,p_document jsonb,p_expected integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.email_design_admin() OR NOT app.organisation_settings_function_allowed('emailTemplates','edit',NULL) THEN RAISE EXCEPTION 'Email design permission required.' USING ERRCODE='42501';END IF;
 RETURN app.organisation_email_design_save_native(p_kind,p_locale,p_document,p_expected);
END;
$$;
REVOKE ALL ON FUNCTION app.email_design_save(text,text,jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_design_save(text,text,jsonb,integer) TO ai_hr_app;
ALTER FUNCTION app.email_asset_save(text,bytea) RENAME TO organisation_email_asset_save_native;
REVOKE ALL ON FUNCTION app.organisation_email_asset_save_native(text,bytea) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.email_asset_save(p_mime text,p_bytes bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.email_design_admin() OR NOT app.organisation_settings_function_allowed('emailTemplates','edit',NULL) THEN RAISE EXCEPTION 'Email design permission required.' USING ERRCODE='42501';END IF;
 RETURN app.organisation_email_asset_save_native(p_mime,p_bytes);
END;
$$;
REVOKE ALL ON FUNCTION app.email_asset_save(text,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_asset_save(text,bytea) TO ai_hr_app;

--> statement-breakpoint
-- Company/role Home presentation has its own View/Edit purpose. Native employee
-- consumption remains the original active own-company/assignment course below.
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','edit'] LOOP
  PERFORM app.register_function_action('dashboardCardConfig.home',operation,'company','organisation.'||operation,'app.organisation_settings_delegation_allowed','{"moduleKey":"organisation","labelKey":"nav.dashboardCardConfig","kind":"submenu","course":"administrative","employeeBearing":false,"screenKey":"dashboardCardConfig","href":"/admin/settings/dashboard?section=content"}');
 END LOOP;
END $$;
CREATE FUNCTION app.organisation_home_configuration_action(co uuid,operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT operation IN ('view','edit') AND app.principal_snapshot_current() AND app.is_admin_for(co)
 AND app.organisation_settings_function_allowed('dashboardCardConfig.home',operation,co);
$$;
REVOKE ALL ON FUNCTION app.organisation_home_configuration_action(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organisation_home_configuration_action(uuid,text) TO ai_hr_app;
CREATE TRIGGER organisation_settings_upsert_lock BEFORE INSERT ON public.employee_home_configuration_revision FOR EACH STATEMENT EXECUTE FUNCTION app.organisation_settings_upsert_lock();
ALTER POLICY employee_home_configuration_read ON public.employee_home_configuration_revision
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND
  (app.organisation_home_configuration_action(company_id,'view') OR EXISTS(
   SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
   WHERE u.id=app.current_user_id() AND e.tenant_id=employee_home_configuration_revision.tenant_id
    AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND e.blacklisted_at IS NULL
    AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
     OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
    AND (e.company_id=employee_home_configuration_revision.company_id OR EXISTS(
     SELECT 1 FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id
      AND a.company_id=employee_home_configuration_revision.company_id AND a.superseded_at IS NULL
      AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
    ))
  )));
ALTER POLICY employee_home_configuration_insert ON public.employee_home_configuration_revision
 WITH CHECK(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND app.organisation_home_configuration_action(company_id,'edit')
  AND created_by_user_id=app.current_user_id());

--> statement-breakpoint
-- Tenant aggregate analytics retain their native group floor and exact bounded
-- thirty-day projection; individual observations never require setup authority.
SELECT app.register_function_action('dashboardCardConfig.usage','view','tenant','settings.view','app.organisation_settings_delegation_allowed','{"moduleKey":"settings","labelKey":"employeeHome.usage.title","kind":"submenu","course":"administrative","employeeBearing":false,"screenKey":"dashboardCardConfig","href":"/admin/settings/dashboard?section=content"}');
ALTER FUNCTION app.home_card_interactions_summary() RENAME TO organisation_home_interactions_native;
REVOKE ALL ON FUNCTION app.organisation_home_interactions_native() FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.home_card_interactions_summary() RETURNS TABLE(card text,action text,interactions text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.organisation_settings_function_allowed('dashboardCardConfig.usage','view',NULL) THEN RAISE EXCEPTION 'Home usage unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT * FROM app.organisation_home_interactions_native();
END;
$$;
REVOKE ALL ON FUNCTION app.home_card_interactions_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_card_interactions_summary() TO ai_hr_app;

--> statement-breakpoint
-- Administrative reads cannot borrow this actor's independently assigned tester
-- course. Original permissive policies still establish every native own-row fact.
CREATE POLICY settings_testing_execution_read ON public.test_execution AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND (app.organisation_settings_function_allowed('systemTesting','view',NULL) OR tester_user_id=app.current_user_id()));
CREATE POLICY settings_testing_run_read ON public.test_run AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND (app.organisation_settings_function_allowed('systemTesting','view',NULL) OR app.testing_owns_execution(execution_id)));
CREATE POLICY settings_testing_attachment_read ON public.test_execution_attachment AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND (app.organisation_settings_function_allowed('systemTesting','view',NULL) OR app.testing_owns_execution(execution_id)));
-- Retired legacy observation creation has no native command. Actual assigned
-- execution/run creation remains its independent existing native owner.
CREATE POLICY settings_testing_run_insert ON public.test_run AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND (execution_id IS NOT NULL AND app.testing_owns_execution(execution_id)));
CREATE POLICY settings_testing_run_update ON public.test_run AS RESTRICTIVE FOR UPDATE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND (app.testing_owns_execution(execution_id) OR execution_id IS NULL AND app.organisation_settings_function_allowed('systemTesting','edit',NULL)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND (app.testing_owns_execution(execution_id) OR execution_id IS NULL AND app.organisation_settings_function_allowed('systemTesting','edit',NULL)));
DO $$ DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['test_case','test_case_version','test_assignment','test_catalogue_update'] LOOP
  EXECUTE format('CREATE TRIGGER organisation_settings_upsert_lock BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.organisation_settings_upsert_lock()',relation_name);
 END LOOP;
END $$;

--> statement-breakpoint
-- Own tester commands keep their exact native assignment/course. Join Access
-- before the original case/run locks, without granting master-table mutation.
ALTER FUNCTION app.testing_lock_own_assignment(uuid) RENAME TO organisation_testing_assignment_lock_native;
REVOKE ALL ON FUNCTION app.organisation_testing_assignment_lock_native(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.testing_lock_own_assignment(p_assignment_id uuid) RETURNS TABLE(case_id uuid,assignment_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 RETURN QUERY SELECT * FROM app.organisation_testing_assignment_lock_native(p_assignment_id);
END;
$$;
REVOKE ALL ON FUNCTION app.testing_lock_own_assignment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.testing_lock_own_assignment(uuid) TO ai_hr_app;
ALTER FUNCTION app.testing_next_run_no(uuid) RENAME TO organisation_testing_run_no_native;
REVOKE ALL ON FUNCTION app.organisation_testing_run_no_native(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.testing_next_run_no(case_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.testing_live_principal() OR NOT (
  app.organisation_settings_function_allowed('systemTesting','view',NULL)
  OR EXISTS(SELECT 1 FROM public.test_assignment assignment JOIN public.test_case source ON source.id=assignment.test_case_id AND source.tenant_id=assignment.tenant_id
   WHERE assignment.test_case_id=case_id AND assignment.tenant_id=app.current_tenant_id() AND assignment.tester_user_id=app.current_user_id() AND assignment.active AND assignment.target_version_id=source.current_version_id)
 ) THEN RAISE EXCEPTION 'Testing case is not assigned' USING ERRCODE='42501';END IF;
 RETURN app.organisation_testing_run_no_native(case_id);
END;
$$;
REVOKE ALL ON FUNCTION app.testing_next_run_no(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.testing_next_run_no(uuid) TO ai_hr_app;
