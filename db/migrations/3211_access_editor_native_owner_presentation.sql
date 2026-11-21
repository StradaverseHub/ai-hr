-- Access editor presentation under the actual canonical native migration owner.
-- Supersedes the UNINSTALLED3103 suffix; its historical source/evidence remain immutable.
-- One source owner for bootstrap eligibility; predecessor body and complete identity fail closed.
DO $guard$
DECLARE p pg_proc;native_owner oid;
BEGIN
 SELECT c.relowner INTO native_owner FROM pg_class c WHERE c.oid='public.access_configuration'::regclass;
 IF native_owner IS NULL OR current_user::regrole::oid IS DISTINCT FROM native_owner
  OR native_owner IS DISTINCT FROM (SELECT c.relowner FROM pg_class c WHERE c.oid='public.app_user'::regclass)
  OR native_owner IS DISTINCT FROM (SELECT n.nspowner FROM pg_namespace n WHERE n.oid='app'::regnamespace) THEN
  RAISE EXCEPTION 'Access presentation requires the canonical current native migration owner' USING ERRCODE='55000';
 END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='app.access_install_defaults(uuid,uuid)'::regprocedure;
 IF p.proowner IS DISTINCT FROM native_owner OR p.pronamespace IS DISTINCT FROM 'app'::regnamespace::oid
  OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proname IS DISTINCT FROM 'access_install_defaults' OR p.proargtypes IS DISTINCT FROM '2950 2950'::oidvector
  OR p.proargnames IS DISTINCT FROM ARRAY['t','u']::text[] OR p.pronargs<>2 OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL
  OR p.prorettype IS DISTINCT FROM 'boolean'::regtype::oid OR p.proretset OR p.prokind<>'f' OR p.provariadic<>0
  OR p.proallargtypes IS NOT NULL OR p.proargmodes IS NOT NULL OR p.prosqlbody IS NOT NULL
  OR p.procost<>100 OR p.prorows<>0 OR p.prosupport<>0::oid
  OR NOT p.prosecdef OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
  OR cardinality(p.proconfig) IS DISTINCT FROM 1
  OR regexp_replace(p.proconfig[1],'\s','','g') IS DISTINCT FROM 'search_path=pg_catalog,public,pg_temp'
  OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE a.grantor<>p.proowner OR a.grantee<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
  OR p.prosrc IS DISTINCT FROM $predecessor$
DECLARE root_group uuid; hr_group uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF EXISTS(SELECT 1 FROM public.access_configuration s WHERE s.tenant_id=t AND s.initialized) THEN RETURN false; END IF;
 -- Bootstrap is based on real role rows and current login availability, never GUC role text.
 IF NOT EXISTS(SELECT 1 FROM public.app_user a JOIN public.role_assignment r ON r.app_user_id=a.id AND r.tenant_id=a.tenant_id
  WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND app.access_recovery_available(a.id)
   AND (r.role::text='super_admin' OR (r.role::text='hr_admin' AND r.company_id IS NULL))) THEN
  RETURN false;
 END IF;
 INSERT INTO public.access_configuration(tenant_id) VALUES(t) ON CONFLICT(tenant_id) DO NOTHING;
 INSERT INTO public.access_group(tenant_id,name,legacy_key,system_administrator) VALUES
  (t,'System Administrators','system_administrator',true),(t,'HR Administrators','hr_admin',false),
  (t,'Managers','manager',false),(t,'Employees','employee',false),
  (t,'Payroll Partners','payroll_partner',false),(t,'Performance and Compensation Partners','performance_comp_partner',false);
 SELECT id INTO root_group FROM public.access_group WHERE tenant_id=t AND legacy_key='system_administrator';
 SELECT id INTO hr_group FROM public.access_group WHERE tenant_id=t AND legacy_key='hr_admin';
 INSERT INTO public.access_group_grant(tenant_id,group_id,capability_id)
  SELECT t,root_group,c.id FROM public.access_capability c;
 INSERT INTO public.access_group_grant(tenant_id,group_id,capability_id)
  SELECT t,hr_group,c.id FROM public.access_capability c WHERE c.id IN ('workforce.view','workforce.maintain','profile.review');
 -- Role-derived memberships are a live view. Existing organizational-manager authority is not copied
 -- into a manager role or a new permission row; its actual owner remains the reporting graph.
 UPDATE public.access_configuration SET initialized=true,revision=gen_random_uuid(),updated_at=now() WHERE tenant_id=t;
 PERFORM app.access_assert_administrator_for(t);
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'access-configuration',t,'access-configuration.initialized','user',u,'{"defaultsCreated":true,"legacyRolesChanged":false}'::jsonb);
 RETURN true;
END;
$predecessor$ THEN
  RAISE EXCEPTION 'Access bootstrap predecessor differs from the reviewed native owner' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint

CREATE FUNCTION app._access_bootstrap_eligible(t uuid,u uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $helper$
 SELECT EXISTS(SELECT 1 FROM public.app_user a JOIN public.role_assignment r ON r.app_user_id=a.id AND r.tenant_id=a.tenant_id
  WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND app.access_recovery_available(a.id)
   AND (r.role::text='super_admin' OR (r.role::text='hr_admin' AND r.company_id IS NULL)))
$helper$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._access_bootstrap_eligible(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.access_install_defaults(t uuid,u uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE root_group uuid; hr_group uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF EXISTS(SELECT 1 FROM public.access_configuration s WHERE s.tenant_id=t AND s.initialized) THEN RETURN false; END IF;
 -- Bootstrap is based on real role rows and current login availability, never GUC role text.
 IF NOT app._access_bootstrap_eligible(t,u) THEN
  RETURN false;
 END IF;
 INSERT INTO public.access_configuration(tenant_id) VALUES(t) ON CONFLICT(tenant_id) DO NOTHING;
 INSERT INTO public.access_group(tenant_id,name,legacy_key,system_administrator) VALUES
  (t,'System Administrators','system_administrator',true),(t,'HR Administrators','hr_admin',false),
  (t,'Managers','manager',false),(t,'Employees','employee',false),
  (t,'Payroll Partners','payroll_partner',false),(t,'Performance and Compensation Partners','performance_comp_partner',false);
 SELECT id INTO root_group FROM public.access_group WHERE tenant_id=t AND legacy_key='system_administrator';
 SELECT id INTO hr_group FROM public.access_group WHERE tenant_id=t AND legacy_key='hr_admin';
 INSERT INTO public.access_group_grant(tenant_id,group_id,capability_id)
  SELECT t,root_group,c.id FROM public.access_capability c;
 INSERT INTO public.access_group_grant(tenant_id,group_id,capability_id)
  SELECT t,hr_group,c.id FROM public.access_capability c WHERE c.id IN ('workforce.view','workforce.maintain','profile.review');
 -- Role-derived memberships are a live view. Existing organizational-manager authority is not copied
 -- into a manager role or a new permission row; its actual owner remains the reporting graph.
 UPDATE public.access_configuration SET initialized=true,revision=gen_random_uuid(),updated_at=now() WHERE tenant_id=t;
 PERFORM app.access_assert_administrator_for(t);
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'access-configuration',t,'access-configuration.initialized','user',u,'{"defaultsCreated":true,"legacyRolesChanged":false}'::jsonb);
 RETURN true;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION app.access_editor_presentation_v1()
RETURNS TABLE(read_status text,state jsonb,metadata jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $projection$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF current_setting('transaction_isolation')<>'repeatable read' OR current_setting('transaction_read_only')<>'on'
  OR t IS NULL OR u IS NULL OR app.principal_snapshot_current() IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)) THEN
  RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.access_configuration c WHERE c.tenant_id=t AND c.initialized) THEN
  IF NOT app.access_allowed_for(u,'access.configure',NULL) THEN
   RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT 'initialized'::text,app.access_configuration_state(),app.access_configuration_editor_metadata();
 ELSE
  IF NOT app._access_bootstrap_eligible(t,u) THEN
   RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT 'uninitialized'::text,NULL::jsonb,NULL::jsonb;
 END IF;
END;
$projection$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_editor_presentation_v1() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_editor_presentation_v1() TO ai_hr_app;
