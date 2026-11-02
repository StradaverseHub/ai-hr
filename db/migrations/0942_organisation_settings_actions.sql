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
CREATE FUNCTION app.organisation_allocate_employee_code(p_company uuid) RETURNS TABLE(code text,config_id uuid,number integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.employee_id_config%ROWTYPE;n integer;
BEGIN
 PERFORM app.access_workforce_write_lock();
 DELETE FROM app.organisation_number_intent WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 IF NOT app.is_admin_for(p_company) OR NOT app.access_workforce_action_company(p_company,'add') THEN RAISE EXCEPTION 'Employee admission unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.employee_id_config WHERE tenant_id=app.current_tenant_id() AND status='active' AND (company_id=p_company OR company_id IS NULL) ORDER BY company_id IS NULL LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;
 n:=CASE WHEN c.current_running_number<c.start_number THEN c.start_number ELSE c.current_running_number+c.increment END;
 INSERT INTO app.organisation_number_intent VALUES(pg_current_xact_id(),c.tenant_id,app.current_user_id(),c.id,c.current_running_number,n,NULL)
 ON CONFLICT ON CONSTRAINT organisation_number_intent_pkey DO UPDATE SET before_number=EXCLUDED.before_number,after_number=EXCLUDED.after_number;
 UPDATE public.employee_id_config SET current_running_number=n,updated_at=now() WHERE id=c.id;
 RETURN QUERY SELECT c.prefix||lpad(n::text,greatest(c.number_length,length(n::text)),'0')||c.suffix,c.id,n;
END;$$;
REVOKE ALL ON FUNCTION app.organisation_allocate_employee_code(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organisation_allocate_employee_code(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.organisation_settings_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b jsonb:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;a jsonb:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;r jsonb:=coalesce(a,b);
 op text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;co uuid;origin uuid;requested_kind text;label uuid;prior_parent uuid;next_parent uuid;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF (r->>'tenant_id')::uuid IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() OR (a IS NOT NULL AND b IS NOT NULL AND (a->>'tenant_id' IS DISTINCT FROM b->>'tenant_id' OR a->>'id' IS DISTINCT FROM b->>'id')) THEN RAISE EXCEPTION 'Configuration principal unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND b->>'archived_at' IS NULL AND a->>'archived_at' IS NOT NULL THEN op:='delete';END IF;
 IF TG_TABLE_NAME IN ('job_grade','profile_option','people_general_policy','dashboard_card_config','login_presentation','tenant_setting','email_design','email_design_version','email_asset','notification_email_policy','ai_provider_config','entra_connector','test_case','test_case_version','test_assignment','test_catalogue_update') THEN
  IF TG_TABLE_NAME='test_case' AND TG_OP='UPDATE' AND app.settings_born('test_case',(a->>'id')::uuid) THEN op:='add';END IF;
  IF TG_TABLE_NAME='test_case_version' THEN op:=CASE WHEN app.settings_born('test_case',(r->>'test_case_id')::uuid) THEN 'add' ELSE 'edit' END;END IF;
  IF TG_TABLE_NAME='test_assignment' AND TG_OP='UPDATE' AND (b->>'active')::boolean AND NOT (a->>'active')::boolean THEN op:='delete';END IF;
  IF TG_TABLE_NAME IN ('login_presentation','tenant_setting','email_design','email_design_version','email_asset','notification_email_policy','entra_connector') THEN op:=CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'edit' END;END IF;
  -- The policy is one revisioned setting: first materialization is Edit, not permission to add policies.
  IF TG_TABLE_NAME='people_general_policy' THEN
   -- Admission counters are private native plumbing. The app has no raw table privilege.
   IF TG_OP='UPDATE' AND (a-'admission_version')=(b-'admission_version') AND (a->>'admission_version')::bigint=(b->>'admission_version')::bigint+1 THEN RETURN NEW;END IF;
   IF TG_OP='INSERT' AND NOT (a->>'allow_duplicated_nric')::boolean AND NOT (a->>'allow_duplicated_email')::boolean AND (a->>'admission_version')::bigint=1 THEN RETURN NEW;END IF;
   op:='edit';
  END IF;
  IF NOT app.settings_action_allowed(op) THEN RAISE EXCEPTION 'Settings action unavailable' USING ERRCODE='42501';END IF;
 ELSIF TG_TABLE_NAME='employee_id_config' THEN
  -- Exact private number allocation is plumbing, never arbitrary Settings Edit.
  IF TG_OP='UPDATE' AND (a-'current_running_number'-'updated_at')=(b-'current_running_number'-'updated_at') AND EXISTS(
   SELECT 1 FROM app.organisation_number_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id() AND i.config_id=(a->>'id')::uuid AND i.before_number=(b->>'current_running_number')::integer AND i.after_number=(a->>'current_running_number')::integer AND (i.draft_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.employee_draft d WHERE d.id=i.draft_id AND d.tenant_id=i.tenant_id))) THEN
   DELETE FROM app.organisation_number_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND config_id=(a->>'id')::uuid;RETURN NEW;
  END IF;
  co:=(r->>'company_id')::uuid;
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
   IF NOT app.organisation_action_allowed(op,origin) OR NOT app.organisation_action_allowed(op,co) THEN RAISE EXCEPTION 'Label criteria action unavailable' USING ERRCODE='42501';END IF;
  END IF;
 ELSE
  co:=CASE WHEN TG_TABLE_NAME='company' THEN (r->>'id')::uuid ELSE (r->>'company_id')::uuid END;
  -- Branding replaces/removes a company attribute; it never creates/deletes the organisation.
  IF TG_TABLE_NAME='company_logo' THEN op:='edit';END IF;
  IF TG_TABLE_NAME='company' AND TG_OP='INSERT' THEN
   IF NOT app.organisation_action_allowed('add',(a->>'parent_company_id')::uuid) THEN RAISE EXCEPTION 'Organisation Add unavailable' USING ERRCODE='42501';END IF;
  ELSE
   IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('department','position','cost_center','business_unit') AND EXISTS(SELECT 1 FROM app.organisation_birth i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id() AND i.kind=TG_TABLE_NAME AND i.row_id=(r->>'id')::uuid) THEN op:='add';END IF;
   IF NOT app.organisation_action_allowed(op,co) THEN RAISE EXCEPTION 'Organisation action unavailable' USING ERRCODE='42501';END IF;
   IF TG_OP='UPDATE' AND TG_TABLE_NAME<>'company' AND (a->>'company_id') IS DISTINCT FROM (b->>'company_id') THEN
    IF NOT app.organisation_action_allowed(op,(b->>'company_id')::uuid) OR NOT app.organisation_action_allowed(op,(a->>'company_id')::uuid) THEN RAISE EXCEPTION 'Organisation destination unavailable' USING ERRCODE='42501';END IF;
   END IF;
   IF TG_TABLE_NAME='company' AND TG_OP='UPDATE' AND (a->>'parent_company_id') IS DISTINCT FROM (b->>'parent_company_id') THEN
    prior_parent:=(b->>'parent_company_id')::uuid;next_parent:=(a->>'parent_company_id')::uuid;
    IF (prior_parent IS NOT NULL AND NOT app.organisation_action_allowed('edit',prior_parent)) OR NOT app.organisation_action_allowed('edit',next_parent) THEN RAISE EXCEPTION 'Organisation parent destination unavailable' USING ERRCODE='42501';END IF;
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
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['company','department','position','cost_center','business_unit','job_grade','profile_option','employee_id_config','people_general_policy','label_company_assignment','company_logo','dashboard_card_config','login_presentation','tenant_setting','email_design','email_design_version','email_asset','notification_email_policy','ai_provider_config','entra_connector','test_case','test_case_version','test_assignment','test_catalogue_update'] LOOP
 -- Provider configuration is upserted: only the successful row operation determines Add/Edit.
 EXECUTE format('CREATE TRIGGER organisation_settings_action %s INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.organisation_settings_write_guard()',CASE WHEN name='ai_provider_config' THEN 'AFTER' ELSE 'BEFORE' END,name);
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
 AND r.role::text IN ('hr_admin','super_admin') AND r.company_id IS NULL) AND app.settings_action_allowed('view'); $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.entra_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.settings_action_allowed('view') AND EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND NOT app.login_blocked(u.id)
 AND r.company_id IS NULL AND r.role IN ('super_admin','hr_admin')
 AND NOT app.access_configuration_denied_for(u.tenant_id,u.id));
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.entra_configure(p_org text,p_directory uuid,p_mode text,p_enabled boolean,p_provision boolean,p_revision uuid,p_expected uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old public.entra_connector%ROWTYPE; t uuid:=app.current_tenant_id();
BEGIN
 IF NOT app.entra_admin() OR NOT app.settings_action_allowed('edit') THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
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
 IF NOT app.entra_admin() OR NOT app.settings_action_allowed('edit') THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
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
 IF NOT app.entra_admin() OR NOT app.settings_action_allowed('edit') THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
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
 USING(app.settings_action_allowed('view') OR app.testing_assigned(id));
CREATE POLICY settings_test_version_read ON public.test_case_version AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.settings_action_allowed('view') OR app.testing_assigned(test_case_id));
CREATE POLICY settings_test_assignment_read ON public.test_assignment AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.settings_action_allowed('view') OR tester_user_id=app.current_user_id());
CREATE POLICY settings_test_catalogue_read ON public.test_catalogue_update AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.settings_action_allowed('view'));
