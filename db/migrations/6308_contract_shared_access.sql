-- Contract shared automation: named capabilities, effective scoped assignments and per-company settings.
-- New tables only. Legacy roles/cases/runs are retained. No salary or employment writes and no automatic cutover.
CREATE TABLE public.contract_access_role (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 permissions text[] NOT NULL CHECK(permissions <@ ARRAY['view','seePay','decide','decline','manual','workflows','templates','groups','access']::text[]),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), updated_by uuid NOT NULL REFERENCES public.app_user(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,name)
);
--> statement-breakpoint
CREATE UNIQUE INDEX contract_access_role_name ON public.contract_access_role(tenant_id,lower(name));
--> statement-breakpoint
CREATE TABLE public.contract_access_member (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id), id uuid NOT NULL DEFAULT gen_random_uuid(), role_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES public.app_user(id), company_id uuid REFERENCES public.company(id), business_group_id uuid REFERENCES public.company(id),
 valid_from date NOT NULL, valid_to date, revoked_at timestamptz,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), created_by uuid NOT NULL REFERENCES public.app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,role_id) REFERENCES public.contract_access_role(tenant_id,id),
 CHECK(valid_to IS NULL OR valid_to>=valid_from)
);
--> statement-breakpoint
CREATE INDEX contract_access_member_lookup ON public.contract_access_member(tenant_id,user_id,company_id,business_group_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE TABLE public.contract_shared_settings (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id), company_id uuid NOT NULL REFERENCES public.company(id), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 fallback_group_id text NOT NULL DEFAULT 'g-peopleops' CHECK(length(btrim(fallback_group_id)) BETWEEN 1 AND 200),
 posting_group_id text NOT NULL DEFAULT 'g-peopleops' CHECK(length(btrim(posting_group_id)) BETWEEN 1 AND 200),
 stall_enabled boolean NOT NULL DEFAULT true, stall_days integer NOT NULL DEFAULT 5 CHECK(stall_days BETWEEN 1 AND 60),
 superior_enabled boolean NOT NULL DEFAULT true, superior_permissions text[] NOT NULL DEFAULT ARRAY['view','decide']::text[]
 CHECK(superior_permissions <@ ARRAY['view','seePay','decide','decline','manual']::text[]),
 updated_by uuid NOT NULL REFERENCES public.app_user(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,company_id)
);
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_permitted(p_permission text,p_company uuid,p_group uuid DEFAULT NULL,p_employment uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.contract_verified_human(app.current_user_id()) AND app.contract_company_entitled(p_company) AND (
  app.contract_hr_admin(p_company)
  OR app.contract_configure(p_company)
  OR EXISTS(SELECT 1 FROM public.contract_access_member m JOIN public.contract_access_role r ON r.tenant_id=m.tenant_id AND r.id=m.role_id
   WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND m.revoked_at IS NULL
   AND (p_permission IN('workflows','templates','groups') OR (m.company_id IS NULL OR m.company_id=p_company) AND (m.business_group_id IS NULL OR m.business_group_id=(SELECT coalesce(co.parent_company_id,co.id) FROM public.company co WHERE co.tenant_id=m.tenant_id AND co.id=p_company)))
   AND m.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (m.valid_to IS NULL OR m.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND p_permission=ANY(r.permissions))
  OR (p_employment IS NOT NULL AND p_permission IN('view','seePay','decide','decline','manual')
   AND coalesce((SELECT s.superior_enabled FROM public.contract_shared_settings s WHERE s.tenant_id=app.current_tenant_id() AND s.company_id=p_company),true)
   AND p_permission=ANY(coalesce((SELECT s.superior_permissions FROM public.contract_shared_settings s WHERE s.tenant_id=app.current_tenant_id() AND s.company_id=p_company),ARRAY['view','decide']::text[]))
   AND app.current_user_id() IN(SELECT app.contract_manager_users(p_employment)))
  OR (p_permission IN('view','decide') AND p_employment IS NOT NULL AND app.contract_pbp_for_employment(p_employment))
 ),false)
$$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_case_permitted(p_case uuid,p_permission text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_case c WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case
 AND (app.contract_case_company_current(c.id) OR p_permission IN('view','seePay'))
 AND app.contract_shared_permitted(p_permission,c.company_id,(SELECT coalesce(co.parent_company_id,co.id) FROM public.company co WHERE co.tenant_id=c.tenant_id AND co.id=c.company_id),CASE WHEN app.contract_case_company_current(c.id) THEN c.employment_id ELSE NULL END))
$$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_access_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.contract_verified_human(app.current_user_id()) AND
 (app.access_capability_allowed('access.system_admin',NULL) OR app.access_capability_allowed('access.configure',NULL)
 OR EXISTS(SELECT 1 FROM public.contract_access_member m JOIN public.contract_access_role r ON r.tenant_id=m.tenant_id AND r.id=m.role_id WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND m.revoked_at IS NULL AND m.company_id IS NULL AND m.business_group_id IS NULL AND 'access'=ANY(r.permissions) AND m.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (m.valid_to IS NULL OR m.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))),false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_permitted(text,uuid,uuid,uuid),app.contract_shared_case_permitted(uuid,text),app.contract_shared_access_admin() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.contract_shared_permitted(text,uuid,uuid,uuid),app.contract_shared_case_permitted(uuid,text),app.contract_shared_access_admin() TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE public.contract_access_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_access_role FORCE ROW LEVEL SECURITY;
ALTER TABLE public.contract_access_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_access_member FORCE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY contract_access_role_owner ON public.contract_access_role FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_access_member_owner ON public.contract_access_member FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_shared_settings_owner ON public.contract_shared_settings FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY contract_access_role_read ON public.contract_access_role FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_shared_access_admin());
CREATE POLICY contract_access_member_read ON public.contract_access_member FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_shared_access_admin());
CREATE POLICY contract_shared_settings_read ON public.contract_shared_settings FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_shared_permitted('access',company_id));
--> statement-breakpoint
REVOKE ALL ON public.contract_access_role,public.contract_access_member,public.contract_shared_settings FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.contract_access_role,public.contract_access_member,public.contract_shared_settings TO ai_hr_app;
--> statement-breakpoint
-- Tenant-level named roles/assignments require Access administration or a tenant-wide Contract Manage access grant; a scoped company editor must not grant
-- themselves a tenant-wide role. Per-company settings retain that company's configure authority.
CREATE FUNCTION app.contract_shared_role_save(p_id uuid,p_name text,p_permissions text[],p_expected integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();r integer;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.contract_shared_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Contract access administration is unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 120 OR p_permissions IS NULL OR NOT p_permissions<@ARRAY['view','seePay','decide','decline','manual','workflows','templates','groups','access']::text[] THEN RAISE EXCEPTION 'Invalid role' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('contract-role:'||t::text||':'||p_id::text,0));
 SELECT revision INTO r FROM public.contract_access_role WHERE tenant_id=t AND id=p_id;
 IF coalesce(r,0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Role changed; reload' USING ERRCODE='40001';END IF;
 INSERT INTO public.contract_access_role(tenant_id,id,name,permissions,revision,updated_by) VALUES(t,p_id,btrim(p_name),p_permissions,coalesce(r,0)+1,app.current_user_id())
 ON CONFLICT(tenant_id,id) DO UPDATE SET name=excluded.name,permissions=excluded.permissions,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=now();
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'contract_access_role',p_id,'contract.access.role.saved','user',app.current_user_id(),jsonb_build_object('revision',coalesce(r,0)+1));
 RETURN coalesce(r,0)+1;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_member_save(p_id uuid,p_role uuid,p_user uuid,p_company uuid,p_group uuid,p_from date,p_to date,p_revoke boolean,p_expected integer DEFAULT 0) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();prior public.contract_access_member;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.contract_shared_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Contract access administration is unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.contract_access_role WHERE tenant_id=t AND id=p_role) OR NOT app.contract_verified_human(p_user)
 OR p_from IS NULL OR p_to<p_from
 OR p_company IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company WHERE tenant_id=t AND id=p_company)
 OR p_group IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company WHERE tenant_id=t AND id=p_group)
 OR p_group IS NOT NULL AND p_company IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company co WHERE co.tenant_id=t AND co.id=p_company AND coalesce(co.parent_company_id,co.id)=p_group)
 THEN RAISE EXCEPTION 'Invalid role assignment' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('contract-member:'||t::text||':'||p_id::text,0));
 SELECT * INTO prior FROM public.contract_access_member WHERE tenant_id=t AND id=p_id FOR UPDATE;
 IF coalesce(prior.revision,0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Assignment changed; reload' USING ERRCODE='40001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('contract-member-scope:'||t::text||':'||p_role::text||':'||p_user::text,0));
 IF NOT p_revoke AND EXISTS(SELECT 1 FROM public.contract_access_member m WHERE m.tenant_id=t AND m.id<>p_id AND m.role_id=p_role AND m.user_id=p_user AND m.revoked_at IS NULL AND m.company_id IS NOT DISTINCT FROM p_company AND m.business_group_id IS NOT DISTINCT FROM p_group AND daterange(m.valid_from,m.valid_to+1,'[)') && daterange(p_from,p_to+1,'[)')) THEN RAISE EXCEPTION 'This person already has an overlapping assignment for this scope' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.contract_access_member WHERE tenant_id=t AND id=p_id AND (role_id<>p_role OR user_id<>p_user)) THEN RAISE EXCEPTION 'Assignment identity cannot change' USING ERRCODE='22023';END IF;
 INSERT INTO public.contract_access_member(tenant_id,id,role_id,user_id,company_id,business_group_id,valid_from,valid_to,revoked_at,created_by)
 VALUES(t,p_id,p_role,p_user,p_company,p_group,p_from,p_to,CASE WHEN p_revoke THEN now() END,app.current_user_id())
 ON CONFLICT(tenant_id,id) DO UPDATE SET company_id=excluded.company_id,business_group_id=excluded.business_group_id,valid_from=excluded.valid_from,valid_to=excluded.valid_to,revoked_at=excluded.revoked_at,revision=contract_access_member.revision+1;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'contract_access_member',p_id,'contract.access.assignment.saved','user',app.current_user_id(),jsonb_build_object('before',to_jsonb(prior),'after',(SELECT to_jsonb(m) FROM public.contract_access_member m WHERE m.tenant_id=t AND m.id=p_id)));
 RETURN p_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_role_save(uuid,text,text[],integer),app.contract_shared_member_save(uuid,uuid,uuid,uuid,uuid,date,date,boolean,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_role_save(uuid,text,text[],integer),app.contract_shared_member_save(uuid,uuid,uuid,uuid,uuid,date,date,boolean,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_settings_save(p_company uuid,p_expected integer,p_data jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();r integer;v_permissions text[];
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.contract_shared_permitted('access',p_company) IS NOT TRUE THEN RAISE EXCEPTION 'Contract settings are unavailable' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR NOT (p_data ?& ARRAY['fallbackGroupId','postingApproverGroupId','stallEnabled','stallDays','automaticSuperior'])
 OR jsonb_typeof(p_data->'stallEnabled') IS DISTINCT FROM 'boolean' OR coalesce(p_data->>'stallDays','')!~'^[0-9]{1,2}$'
 OR (p_data->>'stallDays')::integer NOT BETWEEN 1 AND 60 OR jsonb_typeof(p_data->'automaticSuperior'->'enabled') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(p_data->'automaticSuperior'->'permissions') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'Invalid Contract settings' USING ERRCODE='22023';END IF;
 SELECT coalesce(array_agg(v),'{}'::text[]) INTO v_permissions FROM jsonb_array_elements_text(p_data->'automaticSuperior'->'permissions') v;
 IF NOT v_permissions<@ARRAY['view','seePay','decide','decline','manual']::text[] THEN RAISE EXCEPTION 'Invalid team permissions' USING ERRCODE='22023';END IF;
 -- Group identity, not a display name. Never accept a deleted group and silently send sensitive work elsewhere.
 IF NOT EXISTS(SELECT 1 FROM public.lc_v9_config c CROSS JOIN LATERAL jsonb_array_elements(c.data->'groups') g WHERE c.tenant_id=t AND g->>'id'=p_data->>'fallbackGroupId')
 OR NOT EXISTS(SELECT 1 FROM public.lc_v9_config c CROSS JOIN LATERAL jsonb_array_elements(c.data->'groups') g WHERE c.tenant_id=t AND g->>'id'=p_data->>'postingApproverGroupId')
 THEN RAISE EXCEPTION 'Choose existing fallback and posting approver groups' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('contract-settings:'||t::text||':'||p_company::text,0));
 SELECT revision INTO r FROM public.contract_shared_settings WHERE tenant_id=t AND company_id=p_company;
 IF coalesce(r,0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Settings changed; reload' USING ERRCODE='40001';END IF;
 INSERT INTO public.contract_shared_settings(tenant_id,company_id,revision,fallback_group_id,posting_group_id,stall_enabled,stall_days,superior_enabled,superior_permissions,updated_by)
 VALUES(t,p_company,coalesce(r,0)+1,p_data->>'fallbackGroupId',p_data->>'postingApproverGroupId',(p_data->>'stallEnabled')::boolean,(p_data->>'stallDays')::integer,
 (p_data->'automaticSuperior'->>'enabled')::boolean,v_permissions,app.current_user_id())
 ON CONFLICT(tenant_id,company_id) DO UPDATE SET revision=excluded.revision,fallback_group_id=excluded.fallback_group_id,posting_group_id=excluded.posting_group_id,
 stall_enabled=excluded.stall_enabled,stall_days=excluded.stall_days,superior_enabled=excluded.superior_enabled,superior_permissions=excluded.superior_permissions,updated_by=excluded.updated_by,updated_at=now();
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'contract_settings',p_company,'contract.settings.saved','user',app.current_user_id(),jsonb_build_object('revision',coalesce(r,0)+1));
 RETURN coalesce(r,0)+1;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_settings_save(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_settings_save(uuid,integer,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_company_in_use(p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.contract_hr_admin(p_company) AND (
 EXISTS(SELECT 1 FROM public.contract_shared_settings s WHERE s.tenant_id=app.current_tenant_id() AND s.company_id=p_company)
 OR EXISTS(SELECT 1 FROM public.contract_access_member m WHERE m.tenant_id=app.current_tenant_id() AND (m.company_id=p_company
 OR m.business_group_id=p_company))
 ),false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_setting_groups(p_company uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.contract_shared_permitted('access',p_company) IS NOT TRUE THEN RAISE EXCEPTION 'Contract settings are unavailable' USING ERRCODE='42501';END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',g->>'id','name',g->>'name')) FROM public.lc_v9_config c CROSS JOIN LATERAL jsonb_array_elements(c.data->'groups') g WHERE c.tenant_id=app.current_tenant_id()),'[]'::jsonb);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_setting_groups(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_setting_groups(uuid) TO ai_hr_app;
