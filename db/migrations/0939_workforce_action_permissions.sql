-- Genuine Workforce action operations. Definitions are dormant until restricted owner publication v2.
INSERT INTO access_capability(id,scope,supported,bindings) VALUES
 ('workforce.add','company',false,'[]'),('workforce.edit','company',false,'[]'),('workforce.delete','company',false,'[]');
--> statement-breakpoint
-- Installation defaults are evaluated from actual native authority on every resolution. They are
-- separate from human overrides: native revocation takes effect without an asynchronous refresh.
CREATE TABLE app.access_native_capability_default(capability_id text PRIMARY KEY REFERENCES public.access_capability(id),parity_function text NOT NULL CHECK(parity_function ~ '^app\.[a-z][a-z0-9_]*$'),current_parity_function text NOT NULL CHECK(current_parity_function ~ '^app\.[a-z][a-z0-9_]*$'));
REVOKE ALL ON app.access_native_capability_default FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_native_default_allowed(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE hook text;allowed boolean;
BEGIN
 SELECT d.parity_function INTO hook FROM app.access_native_capability_default d JOIN public.access_capability c ON c.id=d.capability_id JOIN public.app_user u ON u.id=p_user AND u.tenant_id=p_tenant WHERE d.capability_id=p_capability AND c.supported AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT FOUND THEN RETURN false; END IF;
 EXECUTE format('SELECT %s($1,$2,$3,$4)',hook) INTO allowed USING p_tenant,p_user,p_capability,p_company;
 RETURN allowed IS TRUE;
END; $$;
REVOKE ALL ON FUNCTION app.access_native_default_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_native_default_current(p_capability text,p_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE hook text;allowed boolean;
BEGIN
 SELECT d.current_parity_function INTO hook FROM app.access_native_capability_default d JOIN public.access_capability c ON c.id=d.capability_id WHERE d.capability_id=p_capability AND c.supported;
 IF NOT FOUND OR NOT app.principal_snapshot_current() THEN RETURN false; END IF;
 EXECUTE format('SELECT %s($1,$2,$3,$4)',hook) INTO allowed USING app.current_tenant_id(),app.current_user_id(),p_capability,p_company;
 RETURN allowed IS TRUE;
END; $$;
REVOKE ALL ON FUNCTION app.access_native_default_current(text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_refresh_native_defaults(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected_tenant uuid;
BEGIN
 SELECT tenant_id INTO selected_tenant FROM public.app_user WHERE id=p_user;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||selected_tenant::text,0));
 UPDATE public.access_configuration SET revision=gen_random_uuid(),updated_at=now() WHERE tenant_id=selected_tenant AND initialized;
END; $$;
REVOKE ALL ON FUNCTION app.access_refresh_native_defaults(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Positive function grants remain independent of legacy HR roles. Only a genuinely narrowed
-- principal carrier is scope-clamped; a full Employee-A carrier may still hold an explicit B grant.
CREATE FUNCTION app.access_current_grants_full() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND NOT EXISTS(SELECT 1 FROM app.principal(app.current_user_id()) p CROSS JOIN LATERAL jsonb_array_elements(p.grants) actual
  WHERE NOT EXISTS(SELECT 1 FROM app.current_grants() claimed WHERE claimed.role=actual->>'role'
   AND (claimed.company_id IS NOT DISTINCT FROM nullif(actual->>'companyId','')::uuid OR app.access_scope_covers(claimed.company_id,nullif(actual->>'companyId','')::uuid,app.current_tenant_id()))));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_current_grants_full() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_current_carrier_covers(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND (app.access_current_grants_full() OR EXISTS(SELECT 1 FROM app.current_grants() g WHERE app.access_scope_covers(g.company_id,p_company,app.current_tenant_id())));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_current_carrier_covers(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_derived_carrier_covers(p_legacy text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.current_grants() g WHERE (g.role=p_legacy OR p_legacy='system_administrator' AND g.role IN ('hr_admin','super_admin')) AND app.access_scope_covers(g.company_id,p_company,app.current_tenant_id()));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_derived_carrier_covers(text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_current_capability_source(p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_current_carrier_covers(p_company) AND (app.access_native_default_current(p_capability,p_company) OR
  EXISTS(SELECT 1 FROM public.access_user_override o WHERE o.tenant_id=app.current_tenant_id() AND o.user_id=app.current_user_id() AND o.capability_id=p_capability AND o.effect='allow' AND o.retired_at IS NULL AND app.access_scope_covers(o.company_id,p_company,o.tenant_id))
  OR EXISTS(SELECT 1 FROM public.access_effective_membership m JOIN public.access_group g ON g.tenant_id=m.tenant_id AND g.id=m.group_id JOIN public.access_group_grant a ON a.tenant_id=g.tenant_id AND a.group_id=g.id
   WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND g.retired_at IS NULL AND a.retired_at IS NULL AND a.capability_id=p_capability
    AND app.access_scope_covers(m.company_id,p_company,m.tenant_id) AND app.access_scope_covers(a.company_id,p_company,m.tenant_id)
    AND (NOT m.derived OR app.access_derived_carrier_covers(g.legacy_key,p_company))));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_current_capability_source(text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Code-owned function definitions. These are installation facts, never customer configuration.
-- Keep the legacy capability grammar unchanged. Function IDs additionally retain the exact
-- case-sensitive SCREENS/native submenu key accepted by the restricted registry; operation names
-- remain the finite lower-case set. This is an unapplied source migration, not a historical rewrite.
ALTER TABLE public.access_capability DROP CONSTRAINT access_capability_id_check;
ALTER TABLE public.access_capability ADD CONSTRAINT access_capability_id_check CHECK(
 id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,5}$'
 OR (id ~ '^function\.[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*\.(view|add|edit|delete|approve|issue|execute)$'
  AND length(regexp_replace(substring(id FROM 10),'\.[^.]+$',''))<=160)
);
--> statement-breakpoint
ALTER TABLE public.access_capability ADD COLUMN prerequisites jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(prerequisites)='array');
--> statement-breakpoint
CREATE TABLE app.access_function_definition(
 function_key text PRIMARY KEY,scope text NOT NULL CHECK(scope IN ('tenant','company')),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object')
);
CREATE TABLE app.access_function_action(
 function_key text NOT NULL REFERENCES app.access_function_definition(function_key),
 operation text NOT NULL CHECK(operation IN ('view','add','edit','delete','approve','issue','execute')),
 capability_id text UNIQUE NOT NULL REFERENCES public.access_capability(id),
 parent_capability text REFERENCES public.access_capability(id),delegation_floor_function text,
 PRIMARY KEY(function_key,operation)
);
REVOKE ALL ON app.access_function_definition,app.access_function_action FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.register_function_action(p_key text,p_operation text,p_scope text,p_parent text DEFAULT NULL,p_floor text DEFAULT NULL,p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE cap text:='function.'||p_key||'.'||p_operation;existing app.access_function_definition%ROWTYPE;requirements jsonb:='[]';
BEGIN
 IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.access_capability'::regclass)) OR NOT app.acting_as_owner()
  OR p_key !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$' OR length(p_key)>160 OR p_operation NOT IN ('view','add','edit','delete','approve','issue','execute') OR p_scope NOT IN ('tenant','company')
  THEN RAISE EXCEPTION 'Invalid function registration' USING ERRCODE='42501'; END IF;
 SELECT * INTO existing FROM app.access_function_definition WHERE function_key=p_key;
 IF NOT FOUND THEN
  IF coalesce(p_metadata->>'kind','') NOT IN ('screen','submenu','native_acl') OR coalesce(p_metadata->>'course','') NOT IN ('administrative','own','assigned') OR coalesce(p_metadata->>'moduleKey','')='' OR coalesce(p_metadata->>'labelKey','')='' THEN RAISE EXCEPTION 'Missing function metadata'; END IF;
  INSERT INTO app.access_function_definition VALUES(p_key,p_scope,p_metadata);
 ELSIF existing.scope<>p_scope OR (p_metadata<>'{}'::jsonb AND existing.metadata<>p_metadata) THEN RAISE EXCEPTION 'Function definition drift'; END IF;
 IF p_parent IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.access_capability WHERE id=p_parent AND (scope=p_scope OR scope='tenant')) OR p_parent=cap THEN RAISE EXCEPTION 'Invalid function prerequisite'; END IF;
  requirements:=jsonb_build_array(p_parent);
 END IF;
 IF p_operation<>'view' THEN
  IF NOT EXISTS(SELECT 1 FROM app.access_function_action WHERE function_key=p_key AND operation='view') THEN RAISE EXCEPTION 'Register View first'; END IF;
  requirements:=requirements||jsonb_build_array('function.'||p_key||'.view');
 END IF;
 IF p_floor IS NOT NULL AND (p_floor !~ '^app\.[a-z][a-z0-9_]*$' OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid='public.access_capability'::regclass WHERE p.oid=to_regprocedure(p_floor||'(uuid,uuid,text,uuid)') AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE'))) THEN RAISE EXCEPTION 'Untrusted function native floor'; END IF;
 IF EXISTS(SELECT 1 FROM public.access_capability WHERE id=cap) THEN RAISE EXCEPTION 'Duplicate function registration'; END IF;
 INSERT INTO public.access_capability(id,scope,supported,bindings,prerequisites) VALUES(cap,p_scope,false,'[]',requirements);
 INSERT INTO app.access_function_action VALUES(p_key,p_operation,cap,p_parent,p_floor);
END; $$;
REVOKE ALL ON FUNCTION app.register_function_action(text,text,text,text,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.function_action_allowed(p_key text,p_operation text,p_company uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT app.principal_snapshot_current() AND ((d.scope='tenant' AND p_company IS NULL) OR (d.scope='company' AND EXISTS(SELECT 1 FROM public.company co WHERE co.id=p_company AND co.tenant_id=app.current_tenant_id())))
  AND (NOT c.supported OR app.access_allowed_for(app.current_user_id(),c.id,p_company))
  FROM app.access_function_action a JOIN app.access_function_definition d USING(function_key) JOIN public.access_capability c ON c.id=a.capability_id
  WHERE a.function_key=p_key AND a.operation=p_operation),false);
$$;
REVOKE ALL ON FUNCTION app.function_action_allowed(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.function_action_allowed(text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_function_delegation_floor(p_capability text,p_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected app.access_function_action%ROWTYPE;allowed boolean;
BEGIN
 SELECT * INTO selected FROM app.access_function_action WHERE capability_id=p_capability;
 IF NOT FOUND THEN RETURN p_capability NOT LIKE 'function.%'; END IF;
 IF selected.delegation_floor_function IS NULL THEN RETURN false; END IF;
 EXECUTE format('SELECT %s($1,$2,$3,$4)',selected.delegation_floor_function) INTO allowed USING app.current_tenant_id(),app.current_user_id(),coalesce(selected.parent_capability,p_capability),p_company;
 RETURN allowed IS TRUE;
END; $$;
REVOKE ALL ON FUNCTION app.access_function_delegation_floor(text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.access_allowed_for_tenant(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.app_user u JOIN public.access_configuration s ON s.tenant_id=u.tenant_id
  JOIN public.access_capability c ON c.id=p_capability
  WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.archived_at IS NULL
   AND NOT app.login_blocked(u.id) AND s.initialized AND c.supported AND jsonb_array_length(c.bindings)>0
   AND (c.id !~ '^.+\.(add|edit|delete|approve|issue|execute)$' OR (app.access_allowed_for_tenant(p_tenant,p_user,regexp_replace(c.id,'[^.]+$','view'),p_company) AND NOT EXISTS(SELECT 1 FROM public.access_user_override legacy WHERE legacy.tenant_id=p_tenant AND legacy.user_id=p_user AND legacy.capability_id='workforce.maintain' AND c.id LIKE 'workforce.%' AND legacy.effect='deny' AND legacy.retired_at IS NULL AND app.access_scope_covers(legacy.company_id,p_company,p_tenant))))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.prerequisites) needed(id) JOIN public.access_capability prerequisite ON prerequisite.id=needed.id WHERE NOT app.access_allowed_for_tenant(p_tenant,p_user,needed.id,CASE WHEN prerequisite.scope='tenant' THEN NULL ELSE p_company END))
   AND ((c.scope='tenant' AND p_company IS NULL) OR (c.scope='company' AND p_company IS NOT NULL))
   AND NOT EXISTS(SELECT 1 FROM public.access_user_override o
    WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.capability_id=c.id AND o.effect='deny' AND o.retired_at IS NULL
     AND app.access_scope_covers(o.company_id,p_company,u.tenant_id))
   AND (app.access_native_default_allowed(p_tenant,p_user,p_capability,p_company) OR
    EXISTS(SELECT 1 FROM public.access_user_override o
     WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.capability_id=c.id AND o.effect='allow' AND o.retired_at IS NULL
      AND app.access_scope_covers(o.company_id,p_company,u.tenant_id))
    OR EXISTS(SELECT 1 FROM public.access_effective_membership m
     JOIN public.access_group g ON g.id=m.group_id AND g.tenant_id=m.tenant_id
     JOIN public.access_group_grant a ON a.group_id=g.id AND a.tenant_id=g.tenant_id
     WHERE m.tenant_id=u.tenant_id AND m.user_id=u.id AND g.retired_at IS NULL
      AND a.capability_id=c.id AND a.retired_at IS NULL
      AND app.access_scope_covers(m.company_id,p_company,u.tenant_id)
      AND app.access_scope_covers(a.company_id,p_company,u.tenant_id))
   )
 );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_allowed_for(p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_allowed_for_tenant(app.current_tenant_id(),p_user,p_capability,p_company)
 AND (p_user IS DISTINCT FROM app.current_user_id() OR (app.access_current_capability_source(p_capability,p_company)
  AND NOT EXISTS(SELECT 1 FROM public.access_capability c CROSS JOIN LATERAL jsonb_array_elements_text(c.prerequisites) needed(id) JOIN public.access_capability prerequisite ON prerequisite.id=needed.id WHERE c.id=p_capability AND NOT app.access_allowed_for(p_user,needed.id,CASE WHEN prerequisite.scope='tenant' THEN NULL ELSE p_company END))
  AND (p_capability !~ '^.+\.(add|edit|delete|approve|issue|execute)$' OR app.access_allowed_for(p_user,regexp_replace(p_capability,'[^.]+$','view'),p_company))));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_legacy_command_company(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_workforce_owner_company(p_company) OR (
  app.access_workforce_projection_company(p_company) AND app.principal_snapshot_current() AND EXISTS(
   SELECT 1 FROM public.company co JOIN public.app_user u ON u.tenant_id=co.tenant_id
   JOIN public.access_capability c ON c.id='workforce.maintain'
   WHERE co.id=p_company AND co.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
    AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    AND CASE WHEN c.supported THEN app.access_allowed_for(u.id,c.id,co.id)
     ELSE app.access_workforce_company(co.id,c.id) END));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_legacy_command_company(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.access_workforce_action_company(p_company uuid,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_action IN ('add','edit','delete') AND (app.access_workforce_owner_company(p_company) OR
 CASE WHEN EXISTS(SELECT 1 FROM public.access_capability c WHERE c.id='workforce.'||p_action AND c.supported)
 THEN app.principal_snapshot_current() AND app.access_workforce_projection_company(p_company)
  AND app.access_allowed_for(app.current_user_id(),'workforce.'||p_action,p_company)
 ELSE app.access_workforce_legacy_command_company(p_company) END);
$$;
REVOKE ALL ON FUNCTION app.access_workforce_action_company(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_workforce_action_company(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_action_employment(p_employment uuid,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
 AND app.access_workforce_action_company(e.company_id,p_action) AND (app.data_permission_matches(e.id) OR app.data_permission_employment_born(e.id)));
$$;
REVOKE ALL ON FUNCTION app.access_workforce_action_employment(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_workforce_action_employment(uuid,text) TO ai_hr_app;
CREATE FUNCTION app.access_workforce_initial_employment(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.data_permission_employment_born(p_employment) AND app.access_workforce_action_employment(p_employment,'add');
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_initial_employment(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_initial_employment(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_action_person(p_person uuid,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=app.current_tenant_id())
 AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=app.current_tenant_id()
 AND (NOT app.access_workforce_action_company(e.company_id,p_action) OR NOT (app.data_permission_matches(e.id) OR app.data_permission_employment_born(e.id))));
$$;
REVOKE ALL ON FUNCTION app.access_workforce_action_person(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_workforce_action_person(uuid,text) TO ai_hr_app;
CREATE OR REPLACE FUNCTION app.access_workforce_command_company(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_workforce_action_company(p_company,'add') OR app.access_workforce_action_company(p_company,'edit') OR app.access_workforce_action_company(p_company,'delete');
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_company(p_company uuid,p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_capability IN ('workforce.add','workforce.edit','workforce.delete') THEN app.access_workforce_action_company(p_company,split_part(p_capability,'.',2)) ELSE p_capability IN ('workforce.view','workforce.maintain') AND (app.access_workforce_owner_company(p_company)
  OR app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.company co JOIN public.app_user u ON u.tenant_id=co.tenant_id
   JOIN public.role_assignment r ON r.tenant_id=u.tenant_id AND r.app_user_id=u.id
   JOIN public.access_capability c ON c.id=p_capability
   WHERE co.id=p_company AND co.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
    AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    AND r.role::text IN ('hr_admin','super_admin') AND app.has_role_for(r.role::text,co.id)
    AND app.access_scope_covers(r.company_id,co.id,co.tenant_id)
    AND (NOT c.supported OR app.access_allowed_for(u.id,c.id,co.id)))) END;
$$;
--> statement-breakpoint
-- Initial writes are Add only for an exact current-transaction birth from the data owner.
CREATE OR REPLACE FUNCTION app.access_workforce_person(p_person uuid,p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_capability IN ('workforce.add','workforce.edit','workforce.delete') THEN app.access_workforce_action_person(p_person,split_part(p_capability,'.',2)) ELSE (EXISTS(SELECT 1 FROM public.person p JOIN public.employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id
  WHERE p.id=p_person AND p.tenant_id=app.current_tenant_id() AND app.access_workforce_employment(e.id,p_capability))
  OR EXISTS(SELECT 1 FROM public.person p WHERE p.id=p_person AND p.tenant_id=app.current_tenant_id()
   AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p.id AND e.tenant_id=p.tenant_id)
   AND app.access_workforce_unassigned(p_capability)))
  -- Keep the existing any-administered-employment person owner. Changing that one shared fact
  -- nevertheless cannot cross an explicit denial on another retained employment's company.
  AND ((app.current_user_id() IS NULL AND app.access_workforce_storage_owner())
   OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=app.current_tenant_id()
    AND (NOT app.access_workforce_not_denied(e.company_id,p_capability) OR p_capability='workforce.maintain' AND (NOT app.data_permission_matches(e.id) OR EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.user_id=app.current_user_id() AND a.tenant_id=e.tenant_id) AND NOT app.access_workforce_company(e.company_id,p_capability))))) END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_initial_person(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND e.person_id=p_person)
 AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND e.person_id=p_person
 AND (NOT app.data_permission_employment_born(e.id) OR NOT app.access_workforce_action_company(e.company_id,'add') OR NOT (app.data_permission_matches(e.id) OR app.data_permission_employment_born(e.id))));
$$;
REVOKE ALL ON FUNCTION app.access_workforce_initial_person(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_workforce_initial_person(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_profile_value_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb;after_row jsonb;delta jsonb;subject_person uuid;subject_employment uuid;row_id uuid;kind text;direct_allowed boolean;action text;
 b record;own_contact boolean:=true;relationship_changed boolean:=false;marriage_allowed boolean:=false;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL; END IF;
 IF NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM app.access_profile_value_actor a
  WHERE a.xact_id=pg_current_xact_id() AND a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id()) THEN
  RAISE EXCEPTION 'Profile write principal unavailable' USING ERRCODE='42501'; END IF;
 before_row:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 row_id:=COALESCE(after_row->>'id',before_row->>'id')::uuid;
 IF COALESCE(after_row->>'tenant_id',before_row->>'tenant_id')::uuid IS DISTINCT FROM app.current_tenant_id() THEN
  RAISE EXCEPTION 'Profile subject unavailable' USING ERRCODE='42501'; END IF;
 action:=CASE WHEN TG_OP='DELETE' OR TG_OP='UPDATE' AND after_row->>'archived_at' IS NOT NULL AND before_row->>'archived_at' IS NULL THEN 'delete' WHEN TG_OP='INSERT' THEN 'add' ELSE 'edit' END;
 IF TG_TABLE_NAME='person' THEN
  subject_person:=row_id;kind:='person';direct_allowed:=app.access_workforce_action_person(subject_person,action) OR app.access_workforce_initial_person(subject_person);
  -- Only normal-profile/compliance columns belong to this guard. Privacy erasure has an exact,
  -- separately prepared null/delete witness below; it is never a general value-write exception.
  SELECT COALESCE(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(after_row) d
   WHERE d.value IS DISTINCT FROM before_row->d.key AND (d.key IN (SELECT column_name FROM app.access_profile_value_bindings() WHERE owner IN ('person','compliance'))
    OR d.key IN ('address','address_line1','address_line2','address_line3','postcode','city','state','country','marital_status_source_request_id'));
 ELSE
  kind:=CASE TG_TABLE_NAME WHEN 'employee_dependent' THEN 'dependent' WHEN 'employee_qualification' THEN 'qualification' WHEN 'person_emergency_contact' THEN 'emergency' END;
  IF kind='qualification' THEN
   subject_employment:=COALESCE(after_row->>'employment_id',before_row->>'employment_id')::uuid;
   SELECT person_id INTO subject_person FROM public.employment WHERE id=subject_employment AND tenant_id=app.current_tenant_id();
   direct_allowed:=app.access_workforce_action_employment(subject_employment,action);
  ELSE
   subject_person:=COALESCE(after_row->>'person_id',before_row->>'person_id')::uuid;
   direct_allowed:=app.access_workforce_action_person(subject_person,action) OR app.access_workforce_initial_person(subject_person);
  END IF;
  SELECT COALESCE(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(after_row) d
   WHERE d.key NOT IN ('id','tenant_id','person_id','employment_id','created_at','updated_at') AND d.value IS DISTINCT FROM before_row->d.key;
  relationship_changed:=TG_OP='UPDATE' AND after_row->'relationship' IS DISTINCT FROM before_row->'relationship';
 END IF;
 IF app.access_workforce_value_intent_allowed(kind,before_row,after_row,true) THEN RETURN NULL; END IF;
 IF app.access_privacy_value_intent_allowed(kind,before_row,after_row) THEN RETURN NULL; END IF;
 IF kind='person' AND TG_OP='UPDATE' THEN
  marriage_allowed:=app.access_profile_marriage_delta(before_row,after_row,delta);
  IF delta ? 'marital_status_source_request_id' AND after_row->'marital_status_source_request_id'<>'null'::jsonb AND NOT marriage_allowed THEN
   RAISE EXCEPTION 'Marital status cause is reserved for its leave owner' USING ERRCODE='42501'; END IF;
 END IF;
 IF direct_allowed OR marriage_allowed THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Profile register removal unavailable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND delta='{}'::jsonb AND after_row->'updated_at' IS NOT DISTINCT FROM before_row->'updated_at' THEN RETURN NULL; END IF;
 -- Immediate contact changes are a separate own-person course. No name, compliance value, new
 -- register row or general Personnel grant can inherit it. Real current employment remains required.
 IF app.access_profile_request_own(subject_person) AND EXISTS(SELECT 1 FROM public.employment e
  WHERE e.person_id=subject_person AND e.tenant_id=app.current_tenant_id() AND e.blacklisted_at IS NULL
   AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN
  IF kind='person' AND TG_OP='UPDATE' THEN
   FOR b IN SELECT * FROM jsonb_each(delta) LOOP
    IF NOT EXISTS(SELECT 1 FROM app.access_profile_value_bindings() f WHERE f.owner='person' AND f.column_name=b.key AND f.immediate
     AND app.access_profile_value_editable(f.field_id)) THEN own_contact:=false;EXIT;END IF;
   END LOOP;
   IF own_contact THEN RETURN NULL; END IF;
  ELSIF kind='emergency' AND TG_OP='UPDATE' AND before_row->>'priority'='primary' AND before_row->'archived_at'='null'::jsonb THEN
   own_contact:=NOT EXISTS(SELECT 1 FROM public.person_emergency_contact e WHERE e.tenant_id=app.current_tenant_id()
    AND e.person_id=subject_person AND e.id<>row_id AND e.priority='primary' AND e.archived_at IS NULL);
   FOR b IN SELECT * FROM jsonb_each(delta) LOOP
    IF b.key='archived_at' AND b.value<>'null'::jsonb THEN
     IF EXISTS(SELECT 1 FROM app.access_profile_value_bindings() f WHERE f.owner='emergency' AND f.primary_key IS NOT NULL
      AND NOT app.access_profile_value_editable(f.field_id,true)) THEN own_contact:=false;EXIT;END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM app.access_profile_value_bindings() f WHERE f.owner='emergency' AND f.column_name=b.key
     AND app.access_profile_value_editable(f.field_id,true)) THEN own_contact:=false;EXIT;END IF;
   END LOOP;
   IF own_contact THEN RETURN NULL; END IF;
  END IF;
 END IF;
 IF TG_OP='INSERT' AND kind='person' THEN RAISE EXCEPTION 'Profile creation unavailable' USING ERRCODE='42501'; END IF;
 IF app.access_profile_value_approved(kind,subject_person,subject_employment,row_id,delta,TG_OP='INSERT',relationship_changed) THEN RETURN NULL; END IF;
 RAISE EXCEPTION 'Profile value write unavailable' USING ERRCODE='42501';
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_maintain_record(p_employment uuid,p_kind text,p_row uuid,p_operation text,p_patch jsonb,p_expected text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.employment%ROWTYPE;before_row jsonb;after_row jsonb;normalized jsonb:='{}'::jsonb;
 version text;target_id uuid;table_name text;subject_column text;subject_id uuid;event_name text;aggregate_name text;
 assignments text;insert_columns text;insert_values text;field_names jsonb;pair record;binding record;value jsonb;
 previous record;previous_after jsonb;written_event_id uuid;instant timestamptz:=now();changed boolean;effect_id uuid;relationship text;
BEGIN
 IF p_kind IS NULL OR p_operation IS NULL OR p_kind NOT IN ('person','qualification','emergency','dependent') OR p_operation NOT IN ('add','update','archive')
  OR jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR octet_length(p_patch::text)>128000 THEN
  RAISE EXCEPTION 'Workforce input invalid' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_patch))>40 OR p_kind='person' AND (p_operation<>'update' OR p_row IS NOT NULL)
  OR p_kind<>'person' AND ((p_operation='add') IS DISTINCT FROM (p_row IS NULL)) THEN
  RAISE EXCEPTION 'Workforce input invalid' USING ERRCODE='22023'; END IF;
 PERFORM app.access_profile_policy_write_lock();
 SELECT * INTO selected FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.current_user_id() IS NULL OR NOT app.data_permission_matches(selected.id) OR NOT app.access_workforce_action_company(selected.company_id,CASE p_operation WHEN 'add' THEN 'add' WHEN 'archive' THEN 'delete' ELSE 'edit' END)
  OR p_kind<>'qualification' AND NOT app.access_workforce_action_person(selected.person_id,CASE p_operation WHEN 'add' THEN 'add' WHEN 'archive' THEN 'delete' ELSE 'edit' END) THEN
  RAISE EXCEPTION 'Workforce command unavailable' USING ERRCODE='42501'; END IF;
 table_name:=CASE p_kind WHEN 'person' THEN 'person' WHEN 'qualification' THEN 'employee_qualification' WHEN 'dependent' THEN 'employee_dependent' ELSE 'person_emergency_contact' END;
 subject_column:=CASE WHEN p_kind='qualification' THEN 'employment_id' ELSE 'person_id' END;
 subject_id:=CASE WHEN p_kind='qualification' THEN selected.id ELSE selected.person_id END;
 aggregate_name:=CASE p_kind WHEN 'person' THEN 'person' WHEN 'qualification' THEN 'employee-qualification' WHEN 'dependent' THEN 'employee-dependent' ELSE 'person-emergency-contact' END;
 event_name:=CASE p_kind WHEN 'person' THEN 'person.updated' WHEN 'qualification' THEN 'qualification.' WHEN 'dependent' THEN 'dependent.' ELSE 'emergency-contact.' END;
 IF p_kind<>'person' THEN event_name:=event_name||CASE p_operation WHEN 'add' THEN 'added' WHEN 'update' THEN 'updated' ELSE 'archived' END; END IF;
 IF p_kind='person' THEN
  SELECT to_jsonb(p),p.xmin::text INTO before_row,version FROM public.person p WHERE p.id=selected.person_id AND p.tenant_id=selected.tenant_id FOR UPDATE;
  target_id:=selected.person_id;
 ELSE
  -- Same order as the canonical register writers: former Highest/Primary before the target row.
  IF p_kind='qualification' THEN
   PERFORM 1 FROM public.employee_qualification WHERE tenant_id=selected.tenant_id AND employment_id=selected.id AND archived_at IS NULL AND is_highest ORDER BY id FOR UPDATE;
  ELSE
   PERFORM 1 FROM public.person WHERE id=selected.person_id AND tenant_id=selected.tenant_id FOR UPDATE;
   PERFORM 1 FROM public.person_emergency_contact WHERE tenant_id=selected.tenant_id AND person_id=selected.person_id AND archived_at IS NULL AND priority='primary' ORDER BY id FOR UPDATE;
  END IF;
  target_id:=COALESCE(p_row,gen_random_uuid());
  IF p_operation='add' THEN before_row:='{}'::jsonb;
  ELSE
   EXECUTE format('SELECT to_jsonb(r),r.xmin::text FROM public.%I r WHERE r.id=$1 AND r.tenant_id=$2 AND r.%I=$3 AND r.archived_at IS NULL FOR UPDATE',table_name,subject_column)
    INTO before_row,version USING target_id,selected.tenant_id,subject_id;
  END IF;
 END IF;
 IF before_row IS NULL OR p_operation<>'add' AND (p_expected IS NULL OR version IS DISTINCT FROM p_expected) THEN
  RAISE EXCEPTION 'Workforce record changed' USING ERRCODE='40001'; END IF;
 IF p_operation='add' AND p_expected IS NOT NULL THEN RAISE EXCEPTION 'Workforce input invalid' USING ERRCODE='22023'; END IF;
 IF p_operation='archive' THEN
  IF p_patch<>'{}'::jsonb THEN RAISE EXCEPTION 'Workforce archive input invalid' USING ERRCODE='22023'; END IF;
  normalized:=jsonb_build_object('archived_at',instant,'updated_at',instant);
 ELSE
  relationship:=COALESCE(NULLIF(app.access_profile_value_normalized(p_patch->'relationship')#>>'{}',''),before_row->>'relationship');
  FOR pair IN SELECT * FROM jsonb_each(p_patch) LOOP
   SELECT * INTO binding FROM app.access_profile_value_bindings() b WHERE b.field_name=pair.key
    AND CASE WHEN p_kind='person' THEN b.owner IN ('person','compliance') ELSE b.owner=p_kind END
    AND b.field_name=ANY(app.access_workforce_command_fields(p_kind));
   IF NOT FOUND THEN RAISE EXCEPTION 'Workforce field unavailable' USING ERRCODE='22023'; END IF;
   IF p_kind='dependent' AND ((relationship IS DISTINCT FROM 'spouse' AND pair.key IN ('marriageDate','marriageStatus','spouseWorking')) OR
     (relationship IS DISTINCT FROM 'child' AND pair.key IN ('isStudent','schoolName','studyLevel','studyCountry','childReliefCategory','childTaxRelief','childReliefPercentage'))) THEN CONTINUE; END IF;
   value:=app.access_profile_value_normalized(pair.value);
   -- An unchanged, already-retained relationship on any live contact keeps the existing legacy
   -- tolerance. The public caller cannot supply a fake legacy value to the catalog owner.
   IF NOT (p_kind='emergency' AND pair.key='relationship' AND EXISTS(SELECT 1 FROM public.person_emergency_contact c
     WHERE c.person_id=selected.person_id AND c.tenant_id=selected.tenant_id AND c.archived_at IS NULL AND to_jsonb(c.relationship)=value))
    AND NOT app.access_workforce_value_shape(p_kind,pair.key,value,before_row->binding.column_name) THEN
    RAISE EXCEPTION 'Workforce field invalid' USING ERRCODE='22023'; END IF;
   normalized:=normalized||jsonb_build_object(binding.column_name,value);
  END LOOP;
  IF p_operation='add' THEN
   normalized:=CASE WHEN p_kind='qualification' THEN jsonb_build_object('is_highest',false) WHEN p_kind='dependent' THEN jsonb_build_object('is_beneficiary',false,'is_deceased',false) ELSE jsonb_build_object('priority','other') END||normalized;
   IF COALESCE(normalized->>'qualification',normalized->>'full_name','')='' THEN RAISE EXCEPTION 'Workforce name required' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_kind='dependent' THEN
   IF relationship IS NULL THEN RAISE EXCEPTION 'Family relationship required' USING ERRCODE='22023'; END IF;
   IF p_operation='add' OR relationship IS DISTINCT FROM before_row->>'relationship' THEN
    IF relationship<>'spouse' THEN normalized:=normalized||jsonb_build_object('marriage_date',NULL,'marriage_status',NULL,'spouse_working',NULL,'company_name',NULL,'employer_address',NULL); END IF;
    IF relationship<>'child' THEN normalized:=normalized||jsonb_build_object('is_student',NULL,'school_name',NULL,'study_level',NULL,'study_country',NULL,'child_relief_category',NULL,'child_tax_relief',NULL,'child_relief_percentage',NULL); END IF;
   END IF;
  END IF;
  IF p_kind='qualification' THEN
   after_row:=before_row||normalized;
   IF after_row->>'from_ym'>after_row->>'to_ym' OR left(after_row->>'graduation_date',7)<after_row->>'from_ym' THEN
    RAISE EXCEPTION 'Qualification date order invalid' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_kind='person' AND normalized ? 'marital_status' THEN normalized:=normalized||jsonb_build_object('marital_status_source_request_id',NULL); END IF;
  IF p_operation<>'add' AND NOT EXISTS(SELECT 1 FROM jsonb_each(normalized) d WHERE d.value IS DISTINCT FROM before_row->d.key) THEN
   -- Existing Family saves refresh age-dependent facts even when the edited row itself is unchanged.
   IF p_kind='dependent' THEN PERFORM app.my_sync_family_child_relief(selected.person_id); END IF;
   -- Generic Family notice is independent of private tax mode or other-company payroll state.
   RETURN jsonb_build_object('id',target_id,'changed',false,'hrReviewNotice',p_kind='dependent'); END IF;
  IF p_kind<>'person' THEN normalized:=normalized||jsonb_build_object('updated_at',instant); END IF;
 END IF;
 -- Transfer exactly one Primary/Highest using the same finite fields as the existing canonical owner.
 -- Every affected row has its own exact private before/after witness, tied to the one main event.
 IF p_kind='qualification' AND normalized->'is_highest'='true'::jsonb OR p_kind='emergency' AND normalized->>'priority'='primary' THEN
  FOR previous IN EXECUTE format('SELECT to_jsonb(r) value FROM public.%I r WHERE r.tenant_id=$1 AND r.%I=$2 AND r.id<>$3 AND r.archived_at IS NULL AND %s ORDER BY r.id FOR UPDATE',
   table_name,subject_column,CASE WHEN p_kind='qualification' THEN 'r.is_highest' ELSE 'r.priority=''primary''' END) USING selected.tenant_id,subject_id,target_id
  LOOP
   previous_after:=previous.value||jsonb_build_object(CASE WHEN p_kind='qualification' THEN 'is_highest' ELSE 'priority' END,
    CASE WHEN p_kind='qualification' THEN 'false'::jsonb ELSE '"secondary"'::jsonb END,'updated_at',instant);
   INSERT INTO app.access_workforce_value_intent(xact_id,tenant_id,user_id,employment_id,kind,row_id,before_hash,after_hash,audit_root,event_type)
    VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,p_kind,(previous.value->>'id')::uuid,
     encode(sha256(convert_to(previous.value::text,'UTF8')),'hex'),encode(sha256(convert_to(previous_after::text,'UTF8')),'hex'),target_id,event_name);
   EXECUTE format('UPDATE public.%I SET %s,updated_at=$1 WHERE id=$2 AND tenant_id=$3',table_name,
    CASE WHEN p_kind='qualification' THEN 'is_highest=false' ELSE 'priority=''secondary''' END)
    USING instant,(previous.value->>'id')::uuid,selected.tenant_id;
   effect_id:=(previous.value->>'id')::uuid;
  END LOOP;
 END IF;
 IF p_operation='add' THEN
  normalized:=normalized||jsonb_build_object('id',target_id,'tenant_id',selected.tenant_id,subject_column,subject_id);
  SELECT string_agg(format('%I',key),',' ORDER BY key),string_agg(format('v.%I',key),',' ORDER BY key)
   INTO insert_columns,insert_values FROM jsonb_object_keys(normalized) key;
  EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) v RETURNING to_jsonb(%I.*)',table_name,insert_columns,insert_values,table_name,table_name)
   INTO after_row USING normalized;
 ELSE
  after_row:=before_row||normalized;
  INSERT INTO app.access_workforce_value_intent(xact_id,tenant_id,user_id,employment_id,kind,row_id,before_hash,after_hash,audit_root,event_type)
   VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,p_kind,target_id,
    encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'),target_id,event_name);
  SELECT string_agg(format('%I=v.%I',key,key),',' ORDER BY key) INTO assignments FROM jsonb_object_keys(normalized) key;
  EXECUTE format('UPDATE public.%I r SET %s FROM jsonb_populate_record(NULL::public.%I,$1) v WHERE r.id=$2 AND r.tenant_id=$3 RETURNING to_jsonb(r.*)',table_name,assignments,table_name)
   INTO after_row USING normalized,target_id,selected.tenant_id;
 END IF;
 IF p_operation='add' THEN
  INSERT INTO app.access_workforce_value_intent(xact_id,tenant_id,user_id,employment_id,kind,row_id,before_hash,after_hash,audit_root,event_type)
   VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,p_kind,target_id,
    encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'),target_id,event_name);
 END IF;
 SELECT COALESCE(jsonb_agg(key ORDER BY key),'[]'::jsonb) INTO field_names FROM jsonb_object_keys(p_patch) key;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(selected.tenant_id,aggregate_name,target_id,event_name,'user',app.current_user_id(),selected.id,
   jsonb_build_object('fields',field_names,'via','workforce-maintenance','transferFromId',effect_id)) RETURNING id INTO written_event_id;
 UPDATE app.access_workforce_value_intent SET event_id=written_event_id
  WHERE xact_id=pg_current_xact_id() AND tenant_id=selected.tenant_id AND user_id=app.current_user_id() AND audit_root=target_id AND event_type=event_name;
 IF p_kind='dependent' THEN PERFORM app.my_sync_family_child_relief(selected.person_id); END IF;
 RETURN jsonb_build_object('id',target_id,'changed',true,'hrReviewNotice',p_kind='dependent');
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_set_employee_code(p_employment uuid,p_code text,p_expected jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); subject public.employment%ROWTYPE; claimant text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO subject FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=t FOR UPDATE;
 IF NOT FOUND OR NOT app.access_workforce_action_company(subject.company_id,'edit') OR NOT app.data_permission_matches(subject.id) THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
 END IF;
 -- The public SQL command accepts canonical identifiers only; the shared TS format owner normalizes
 -- ordinary forms. No arbitrary column, person id, company or actor is accepted by this seam.
 IF p_code IS NULL OR p_code !~ '^[A-Z0-9-]{1,30}$' THEN RAISE EXCEPTION 'Employee ID invalid' USING ERRCODE='23514'; END IF;
 IF p_expected IS NOT NULL AND (jsonb_typeof(p_expected) NOT IN ('string','null')
  OR p_expected IS DISTINCT FROM coalesce(to_jsonb(subject.employee_code),'null'::jsonb)) THEN
  RAISE EXCEPTION 'Employee record changed' USING ERRCODE='40001';
 END IF;
 IF subject.employee_code=p_code THEN RETURN false; END IF;
 claimant:=app.employee_code_claim(t,p_code,p_employment,NULL);
 IF claimant IS NOT NULL THEN
  RAISE EXCEPTION '%','employee_code_claim_'||claimant USING ERRCODE='23505',CONSTRAINT='employee_code_claim_'||claimant;
 END IF;
 UPDATE public.employment SET employee_code=p_code WHERE id=p_employment AND tenant_id=t;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(t,'employment',p_employment,'employment.employee-code.set',
  CASE WHEN app.current_user_id() IS NULL THEN 'system'::public.actor_type ELSE 'user'::public.actor_type END,app.current_user_id(),p_employment,
  jsonb_build_object('before',jsonb_build_object('employeeCode',subject.employee_code),'after',jsonb_build_object('employeeCode',p_code)));
 RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_hire_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR NOT app.access_workforce_action_company(NEW.company_id,'add')
  OR (EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=NEW.tenant_id AND e.person_id=NEW.person_id)
   AND NOT app.access_workforce_action_person(NEW.person_id,'add')) THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_document_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE action text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN
  IF TG_OP='UPDATE' THEN
   IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.employment_id IS DISTINCT FROM OLD.employment_id THEN
    RAISE EXCEPTION 'Document subject cannot be reassigned' USING ERRCODE='42501';
   END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN
   IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id()
    OR NOT app.access_workforce_action_employment(OLD.employment_id,action) THEN
    RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
   END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
   IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id()
    OR NOT app.access_workforce_action_employment(NEW.employment_id,action) THEN
    RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_structure_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb;after_row jsonb;subject uuid;proof app.access_termination_intent%ROWTYPE;action text:=CASE TG_OP WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
BEGIN
 IF app.access_workforce_storage_owner() THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Structural principal unavailable' USING ERRCODE='42501'; END IF;
 before_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 after_row:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF before_row=after_row THEN RETURN NEW; END IF;
 IF (before_row IS NOT NULL AND before_row->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text)
  OR (after_row IS NOT NULL AND after_row->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text) THEN
  RAISE EXCEPTION 'Workforce structure unavailable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  OR before_row->'created_at' IS DISTINCT FROM after_row->'created_at'
  OR before_row->'employment_id' IS DISTINCT FROM after_row->'employment_id'
  OR before_row->'subordinate_employment_id' IS DISTINCT FROM after_row->'subordinate_employment_id') THEN
  RAISE EXCEPTION 'Structural identity cannot be reassigned' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='reporting_line' AND (before_row IS NULL OR before_row->>'line_type'='delegate')
  AND (after_row IS NULL OR after_row->>'line_type'='delegate') THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 subject:=COALESCE((before_row->>'employment_id')::uuid,(before_row->>'subordinate_employment_id')::uuid,
  (after_row->>'employment_id')::uuid,(after_row->>'subordinate_employment_id')::uuid);
 IF TG_OP='INSERT' AND TG_TABLE_NAME='assignment' AND app.data_permission_employment_born(subject) THEN action:='add';END IF;
 IF (before_row IS NULL OR app.access_workforce_action_employment(subject,action))
  AND (after_row IS NULL OR app.access_workforce_action_employment(COALESCE((after_row->>'employment_id')::uuid,(after_row->>'subordinate_employment_id')::uuid),action))
  AND (TG_TABLE_NAME<>'assignment' OR
   (before_row->>'company_id' IS NULL OR app.access_workforce_action_company((before_row->>'company_id')::uuid,action))
   AND (after_row->>'company_id' IS NULL OR app.access_workforce_action_company((after_row->>'company_id')::uuid,action))) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 -- The exception can only close an unchanged open/current range involving the terminated subject.
 IF TG_OP='UPDATE' AND before_row->>'valid_to' IS NULL AND before_row->>'superseded_at' IS NULL
  AND (before_row-'valid_to')=(after_row-'valid_to') THEN
  SELECT * INTO proof FROM app.access_termination_intent p WHERE p.xact_id=pg_current_xact_id()
   AND p.tenant_id=app.current_tenant_id() AND p.user_id=app.current_user_id()
   AND p.termination_on::text=after_row->>'valid_to' AND (
    (TG_TABLE_NAME='assignment' AND p.employment_id=(before_row->>'employment_id')::uuid)
    OR (TG_TABLE_NAME='reporting_line' AND before_row->>'line_type'='administrative'
     AND p.employment_id IN ((before_row->>'subordinate_employment_id')::uuid,(before_row->>'manager_employment_id')::uuid)));
  IF FOUND THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Workforce structure maintenance unavailable' USING ERRCODE='42501';
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_lifecycle_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE delta jsonb;proof app.access_termination_intent%ROWTYPE;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 SELECT COALESCE(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(to_jsonb(NEW)) d
  WHERE d.key IN ('id','tenant_id','person_id','company_id','hired_on','join_date','resignation_date','last_working_date',
   'terminated_on','termination_type','termination_reason','termination_reason_code','termination_notice_days','blacklisted_at','blacklist_reason')
   AND d.value IS DISTINCT FROM to_jsonb(OLD)->d.key;
 IF delta='{}'::jsonb THEN RETURN NEW; END IF;
 IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  OR NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id THEN
  RAISE EXCEPTION 'Employment identity cannot be reassigned' USING ERRCODE='42501'; END IF;
 IF app.access_workforce_action_company(OLD.company_id,'edit') AND app.access_workforce_action_company(NEW.company_id,'edit') THEN RETURN NEW; END IF;
 SELECT * INTO proof FROM app.access_termination_intent WHERE xact_id=pg_current_xact_id()
  AND tenant_id=OLD.tenant_id AND user_id=app.current_user_id() AND employment_id=OLD.id;
 IF NOT FOUND OR NOT to_jsonb(NEW) @> proof.expected_patch OR EXISTS(
  SELECT 1 FROM jsonb_each(delta) d WHERE NOT proof.expected_patch ? d.key OR d.value IS DISTINCT FROM proof.expected_patch->d.key) THEN
  RAISE EXCEPTION 'Workforce lifecycle maintenance unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_service_info_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM jsonb_each(to_jsonb(NEW)) d WHERE d.key=ANY(app.access_workforce_service_info_columns()) AND d.value IS DISTINCT FROM to_jsonb(OLD)->d.key)
  OR app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  OR NOT ((app.access_workforce_action_company(OLD.company_id,'edit') AND app.access_workforce_action_company(NEW.company_id,'edit')) OR (app.data_permission_employment_born(OLD.id) AND app.access_workforce_action_company(OLD.company_id,'add') AND app.access_workforce_action_company(NEW.company_id,'add'))) THEN
  RAISE EXCEPTION 'Workforce service information maintenance unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_master_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.employee_code IS NOT DISTINCT FROM OLD.employee_code
  AND NEW.is_test_record IS NOT DISTINCT FROM OLD.is_test_record THEN RETURN NEW; END IF;
 -- Check the connection and SET ROLE owner, never current_user (this definer's owner). An explicit
 -- owner repair/restore retains its authority; ai_hr_app cannot acquire it by calling a definer.
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
 END IF;
 IF NEW.employee_code IS DISTINCT FROM OLD.employee_code AND
  (NOT app.access_workforce_command_company(OLD.company_id) OR NOT app.access_workforce_command_company(NEW.company_id)) THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
 END IF;
 IF NEW.is_test_record IS DISTINCT FROM OLD.is_test_record AND
  (NOT app.access_workforce_action_company(OLD.company_id,'edit') OR NOT app.access_workforce_action_company(NEW.company_id,'edit')) THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TABLE app.access_default_capability_grant(legacy_key text NOT NULL CHECK(legacy_key IN ('hr_admin','manager','employee','payroll_partner','performance_comp_partner')),capability_id text NOT NULL REFERENCES public.access_capability(id),PRIMARY KEY(legacy_key,capability_id));
--> statement-breakpoint
REVOKE ALL ON TABLE app.access_default_capability_grant FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
INSERT INTO app.access_default_capability_grant SELECT 'hr_admin',id FROM public.access_capability WHERE id IN ('workforce.view','workforce.maintain','workforce.add','workforce.edit','workforce.delete','profile.review');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_install_defaults(t uuid,u uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
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
  SELECT t,g.id,m.capability_id FROM public.access_group g JOIN app.access_default_capability_grant m ON m.legacy_key=g.legacy_key WHERE g.tenant_id=t AND g.retired_at IS NULL AND NOT g.system_administrator;
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
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_employment_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE action text;delta jsonb;proof app.access_termination_intent%ROWTYPE;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 action:=CASE WHEN TG_OP='DELETE' OR NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN 'delete' ELSE 'edit' END;
 IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND app.data_permission_employment_born(OLD.id) THEN action:='add';END IF;
 IF app.access_workforce_action_employment(OLD.id,action) AND (TG_OP='DELETE' OR app.access_workforce_action_company(NEW.company_id,action)) THEN
  IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
 END IF;
 -- Separately authorized termination consequences remain exact, never a general edit fallback.
 IF TG_OP='UPDATE' THEN
  SELECT coalesce(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(to_jsonb(NEW))d WHERE d.value IS DISTINCT FROM to_jsonb(OLD)->d.key;
  SELECT * INTO proof FROM app.access_termination_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=OLD.tenant_id AND user_id=app.current_user_id() AND employment_id=OLD.id;
  IF FOUND AND to_jsonb(NEW) @> proof.expected_patch AND NOT EXISTS(SELECT 1 FROM jsonb_each(delta)d WHERE NOT proof.expected_patch ? d.key OR d.value IS DISTINCT FROM proof.expected_patch->d.key) THEN RETURN NEW;END IF;
 END IF;
 RAISE EXCEPTION 'Workforce action unavailable' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION app.access_workforce_employment_action_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER workforce_action_write BEFORE UPDATE OR DELETE ON employment FOR EACH ROW EXECUTE FUNCTION app.access_workforce_employment_action_guard();
--> statement-breakpoint
-- Native draft activation consumes a source. It is not the distinct discard/Delete operation.
CREATE TABLE app.workforce_hire_source (
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,user_id uuid NOT NULL,
 draft_id uuid NOT NULL,company_id uuid NOT NULL,source_hash text NOT NULL,source jsonb NOT NULL,authority_stamp text NOT NULL,
 employment_id uuid,consumed boolean NOT NULL DEFAULT false,PRIMARY KEY(xact_id,tenant_id,user_id,draft_id),UNIQUE(xact_id,tenant_id,user_id,employment_id)
);
ALTER TABLE app.workforce_hire_source ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.workforce_hire_source FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_prepare_hire_source(p_draft uuid,p_company uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.employee_draft;hash text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.access_workforce_action_company(p_company,'add') THEN RAISE EXCEPTION 'Hire source unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO d FROM public.employee_draft WHERE id=p_draft AND tenant_id=app.current_tenant_id() AND company_id=p_company FOR UPDATE;
 IF NOT FOUND OR NOT app.data_permission_draft_matches(d.tenant_id,app.current_user_id(),to_jsonb(d)) THEN RAISE EXCEPTION 'Hire source unavailable' USING ERRCODE='42501';END IF;
 hash:=encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex');
 IF EXISTS(SELECT 1 FROM app.workforce_hire_source s WHERE s.xact_id=pg_current_xact_id() AND s.tenant_id=d.tenant_id AND s.user_id=app.current_user_id() AND (s.draft_id<>d.id OR s.source_hash<>hash OR s.employment_id IS NOT NULL)) THEN RAISE EXCEPTION 'Hire source changed' USING ERRCODE='40001';END IF;
 DELETE FROM app.workforce_hire_source WHERE tenant_id=d.tenant_id AND xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.workforce_hire_source(xact_id,tenant_id,user_id,draft_id,company_id,source_hash,source,authority_stamp,employment_id) VALUES(pg_current_xact_id(),d.tenant_id,app.current_user_id(),d.id,p_company,hash,to_jsonb(d),app.access_function_authority_stamp(),NULL) ON CONFLICT DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION app.access_workforce_prepare_hire_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_workforce_prepare_hire_source(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_bind_hire_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.person;source record;expected_code text;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 SELECT * INTO p FROM public.person WHERE id=NEW.person_id AND tenant_id=NEW.tenant_id;
 FOR source IN SELECT * FROM app.workforce_hire_source s WHERE s.xact_id=pg_current_xact_id() AND s.tenant_id=NEW.tenant_id AND s.user_id=app.current_user_id() AND s.company_id=NEW.company_id AND s.employment_id IS NULL FOR UPDATE LOOP
  expected_code:=coalesce(nullif(source.source->>'reserved_employee_code',''),nullif(btrim(source.source#>>'{data,profile,employeeCode}'),''));
  IF btrim(source.source#>>'{data,profile,fullName}') IS DISTINCT FROM btrim(p.full_name)
   OR lower(btrim(source.source#>>'{data,profile,primaryEmail}')) IS DISTINCT FROM lower(btrim(p.primary_email))
   OR source.source#>>'{data,employment,hiredOn}' IS DISTINCT FROM NEW.hired_on::text
   OR expected_code IS NOT NULL AND upper(expected_code) IS DISTINCT FROM NEW.employee_code THEN
   RAISE EXCEPTION 'Hire source differs from created employment' USING ERRCODE='40001';
  END IF;
  UPDATE app.workforce_hire_source SET employment_id=NEW.id WHERE xact_id=source.xact_id AND tenant_id=source.tenant_id AND user_id=source.user_id AND draft_id=source.draft_id;
 END LOOP;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.access_workforce_bind_hire_source() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER workforce_hire_source_bind AFTER INSERT ON employment FOR EACH ROW EXECUTE FUNCTION app.access_workforce_bind_hire_source();
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_hire_source_supported(data jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE section record;entry record;allowed text[];member jsonb;
BEGIN
 IF jsonb_typeof(data)<>'object' THEN RETURN false;END IF;
 FOR section IN SELECT * FROM jsonb_each(data) LOOP
  IF section.key='creationDefaultsVersion' THEN IF section.value<>'1'::jsonb THEN RETURN false;END IF;CONTINUE;END IF;
  allowed:=CASE section.key
   WHEN 'profile' THEN ARRAY['fullName','employeeCode','employeeIdMode','primaryEmail','phone','gender','dateOfBirth','maritalStatus','nationality','icNumber','salutation','firstName','lastName','preferredName','religion','race','homePhone','personalEmail','permanentAddressLine1','permanentAddressLine2','permanentAddressLine3','permanentPostcode','permanentCity','permanentState','permanentCountry','correspondenceAddressLine1','correspondenceAddressLine2','correspondenceAddressLine3','correspondencePostcode','correspondenceCity','correspondenceState','correspondenceCountry','correspondenceMobilePhone','correspondenceHomePhone','sameAsPermanent','passportNumber','passportIssueDate','passportExpiryDate','passportIssuingCountry','passportIssuingCountryCode','passportRemark']
   WHEN 'employment' THEN ARRAY['companyId','departmentId','positionId','costCenterId','gradeId','reportingManagerEmploymentId','employmentType','hiredOn','provisionalEndOn','probationValue','probationUnit','extendedProbationValue','extendedProbationUnit','confirmationDate','noticeBeforeConfirmationValue','noticeBeforeConfirmationUnit','noticeAfterConfirmationValue','noticeAfterConfirmationUnit']
   WHEN 'statutory' THEN ARRAY['bankName','bankAccountNo','epfNumber','socsoNumber','taxNumber','taxCategory','numChildren','socsoCategory','eisCategory','eisEligible','isResident','epfCitizenship','epfMode','epfEmployeeRate','epfEmployerRate','epfEmployeeAmount','epfEmployerAmount','epfManualReason','subjectToSkbbk','employerBearsTax','taxResidency','employerBearsEpf','employerBearsSocso','employerBearsEis','employerBearsSkbbk','disabledIndividual','disabledSpouse','childReliefMode','subjectToHrdf','enableCustomHolderName','customHolderName','enableCustomHolderId','customHolderId']
   WHEN 'payroll' THEN ARRAY['basicSalary','monthlyAllowance','payMode','paymentTerm','rateAmount','remarks','paymentMethod','payrollPolicyId']
   WHEN 'family' THEN ARRAY['key','fullName','relationship','dateOfBirth','gender','icOrPassport','isBeneficiary','phone','remarks','passportNumber','residentialAddress','isDeceased','deceasedOn','marriageDate','marriageStatus','spouseWorking','occupation','companyName','employerAddress','isStudent','schoolName','studyLevel','studyCountry','childReliefCategory','childTaxRelief','childReliefPercentage']
   ELSE ARRAY[]::text[] END;
  IF section.key='family' THEN
   IF jsonb_typeof(section.value)<>'array' THEN RETURN false;END IF;
   FOR member IN SELECT value FROM jsonb_array_elements(section.value) LOOP
    IF jsonb_typeof(member)<>'object' THEN RETURN false;END IF;
    FOR entry IN SELECT * FROM jsonb_each(member) LOOP
     IF entry.key<>ALL(allowed) THEN RETURN false;END IF;
    END LOOP;
   END LOOP;CONTINUE;
  END IF;
  IF jsonb_typeof(section.value)<>'object' THEN IF section.value NOT IN ('null'::jsonb,'""'::jsonb) THEN RETURN false;END IF;CONTINUE;END IF;
  FOR entry IN SELECT * FROM jsonb_each(section.value) LOOP
   IF entry.value IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb) THEN CONTINUE;END IF;
   IF entry.key<>ALL(allowed) OR jsonb_typeof(entry.value)<>'string' THEN RETURN false;END IF;
  END LOOP;
 END LOOP;RETURN true;
END; $$;
REVOKE ALL ON FUNCTION app.access_workforce_hire_source_supported(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Source consumption checks the complete native source, not merely its identity/number.
CREATE FUNCTION app.access_workforce_hire_effects_match(data jsonb,p_employment uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment%ROWTYPE;master jsonb;placement jsonb;stat jsonb;pay jsonb;section record;entry record;
 target jsonb;column_name text;expected text;actual text;mode text;family_row jsonb;stored_family jsonb;family_expected jsonb;expected_members jsonb:='[]';actual_members jsonb;key text;profile jsonb;
BEGIN
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.data_permission_employment_born(e.id) OR NOT app.access_workforce_hire_source_supported(data) THEN RETURN false;END IF;
 SELECT to_jsonb(p) INTO master FROM public.person p WHERE p.id=e.person_id AND p.tenant_id=e.tenant_id;
 SELECT to_jsonb(a) INTO placement FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from=e.hired_on;
 SELECT to_jsonb(m) INTO stat FROM public.employee_statutory_my m WHERE m.person_id=e.person_id AND m.tenant_id=e.tenant_id;
 SELECT to_jsonb(c) INTO pay FROM public.compensation c WHERE c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.valid_from=e.hired_on AND c.superseded_at IS NULL;
 profile:=coalesce(data->'profile','{}');
 IF profile->>'sameAsPermanent'='yes' THEN
  FOREACH key IN ARRAY ARRAY['AddressLine1','AddressLine2','AddressLine3','Postcode','City','State','Country'] LOOP
   profile:=jsonb_set(profile,ARRAY['correspondence'||key],coalesce(profile->('permanent'||key),'null'));
  END LOOP;
 END IF;
 data:=jsonb_set(data,'{profile}',profile);
 mode:=coalesce(nullif(btrim(data#>>'{statutory,epfMode}'),''),'auto');
 FOR section IN SELECT * FROM jsonb_each(data) source_section WHERE source_section.key IN ('profile','employment','statutory','payroll') LOOP
  IF jsonb_typeof(section.value)<>'object' THEN CONTINUE;END IF;
  FOR entry IN SELECT * FROM jsonb_each(section.value) LOOP
   expected:=nullif(btrim(entry.value#>>'{}'),'');IF expected IS NULL THEN CONTINUE;END IF;
   column_name:=lower(regexp_replace(entry.key,'([A-Z])','_\1','g'));
   target:=CASE section.key WHEN 'profile' THEN master WHEN 'employment' THEN to_jsonb(e) WHEN 'statutory' THEN stat WHEN 'payroll' THEN pay END;
   IF section.key='profile' THEN
    IF entry.key IN ('employeeIdMode','sameAsPermanent') THEN CONTINUE;END IF;
    IF entry.key='employeeCode' THEN target:=to_jsonb(e);END IF;
    IF entry.key='icNumber' OR entry.key LIKE 'passport%' THEN target:=stat;END IF;
    IF entry.key='icNumber' THEN expected:=regexp_replace(expected,'[^0-9]','','g');END IF;
    IF entry.key='passportIssuingCountryCode' THEN expected:=upper(expected);END IF;
   ELSIF section.key='employment' THEN
    IF entry.key IN ('departmentId','positionId','costCenterId','employmentType') THEN target:=placement;END IF;
    IF entry.key='reportingManagerEmploymentId' THEN
     IF NOT EXISTS(SELECT 1 FROM public.reporting_line l WHERE l.tenant_id=e.tenant_id AND l.subordinate_employment_id=e.id AND l.manager_employment_id::text=expected AND l.valid_from=e.hired_on AND l.line_type='administrative' AND l.superseded_at IS NULL) THEN RETURN false;END IF;CONTINUE;
    END IF;
    IF entry.key='provisionalEndOn' THEN
     IF data#>>'{employment,employmentType}'='part_time' THEN expected:=NULL;
     ELSIF coalesce(data#>>'{employment,employmentType}','full_time')='full_time' AND nullif(data#>>'{employment,probationValue}','') IS NOT NULL THEN
      expected:=(e.hired_on+CASE coalesce(nullif(data#>>'{employment,probationUnit}',''),'month') WHEN 'month' THEN make_interval(months=>(data#>>'{employment,probationValue}')::integer) WHEN 'week' THEN make_interval(days=>7*(data#>>'{employment,probationValue}')::integer) ELSE make_interval(days=>(data#>>'{employment,probationValue}')::integer) END)::date::text;
     END IF;
    END IF;
   ELSIF section.key='payroll' THEN
    IF entry.key IN ('paymentMethod','payrollPolicyId') THEN target:=to_jsonb(e);END IF;
    IF entry.key IN ('basicSalary','monthlyAllowance','rateAmount') THEN expected:=regexp_replace(expected,'[,_]','','g');END IF;
   ELSIF section.key='statutory' THEN
    IF entry.key IN ('subjectToSkbbk','employerBearsTax','employerBearsEpf','employerBearsSocso','employerBearsEis','employerBearsSkbbk','disabledIndividual','disabledSpouse','subjectToHrdf','enableCustomHolderName','enableCustomHolderId') THEN expected:=(lower(expected) IN ('true','yes','y','1'))::text;END IF;
    IF entry.key='eisEligible' AND nullif(data#>>'{statutory,eisCategory}','') IS NOT NULL THEN CONTINUE;END IF;
    IF entry.key='eisEligible' THEN expected:=(lower(expected) IN ('true','yes','y','1'))::text;END IF;
    IF entry.key IN ('enableCustomHolderName','enableCustomHolderId') THEN expected:=(lower(btrim(entry.value#>>'{}'))='yes')::text;END IF;
    IF entry.key='customHolderName' AND lower(coalesce(data#>>'{statutory,enableCustomHolderName}',''))<>'yes' THEN expected:=NULL;END IF;
    IF entry.key='customHolderId' AND lower(coalesce(data#>>'{statutory,enableCustomHolderId}',''))<>'yes' THEN expected:=NULL;END IF;
    IF entry.key='epfCitizenship' THEN expected:=regexp_replace(lower(expected),'[ -]+','_','g');END IF;
    IF entry.key='epfMode' THEN expected:=CASE mode WHEN 'manual_percentage' THEN 'manual_percentage' WHEN 'voluntary_percentage' THEN 'topup_percentage' WHEN 'semi_auto' THEN 'voluntary_excess' WHEN 'manual_employee_amount' THEN 'manual_amount' WHEN 'manual_employer_amount' THEN 'manual_amount' WHEN 'manual_both_amount' THEN 'manual_amount' WHEN 'none' THEN 'exempt' ELSE 'auto' END;END IF;
    IF entry.key IN ('epfEmployeeRate','epfEmployerRate') THEN
     IF mode IN ('manual_percentage','voluntary_percentage') OR (mode='semi_auto' AND entry.key='epfEmployeeRate') THEN expected:=(expected::numeric/100)::text;ELSE expected:=NULL;END IF;
    END IF;
    IF entry.key IN ('epfEmployeeAmount','epfEmployerAmount') THEN
     IF NOT (mode='manual_both_amount' OR mode='manual_employee_amount' AND entry.key='epfEmployeeAmount' OR mode='manual_employer_amount' AND entry.key='epfEmployerAmount') THEN expected:=NULL;END IF;
    END IF;
    IF entry.key='epfManualReason' AND mode NOT IN ('manual_employee_amount','manual_employer_amount','manual_both_amount') THEN expected:=NULL;END IF;
    IF entry.key='numChildren' AND data#>>'{statutory,childReliefMode}'='auto' THEN CONTINUE;END IF; -- Native family owner recomputes this derived value.
    IF entry.key='taxCategory' AND expected NOT IN ('1','2','3') THEN column_name:='tax_circumstance';END IF;
    IF entry.key='isResident' AND nullif(data#>>'{statutory,taxResidency}','') IS NOT NULL THEN CONTINUE;END IF;
    IF entry.key='isResident' THEN expected:=(lower(expected) IN ('true','yes','y','1'))::text;END IF;
    IF entry.key='taxResidency' AND data#>>'{statutory,taxCategory}'='none' THEN expected:=CASE WHEN expected='non_resident' THEN 'non_resident' ELSE 'resident' END;END IF;
    IF entry.key='taxResidency' AND expected IN ('rep','knowledge_worker','c_suite') THEN
     IF NOT EXISTS(SELECT 1 FROM public.employment_tax_selection_my t WHERE t.tenant_id=e.tenant_id AND t.employment_id=e.id AND t.company_id=e.company_id AND t.scheme::text=expected) THEN RETURN false;END IF;CONTINUE;
    END IF;
   END IF;
   actual:=nullif(btrim(target->>column_name),'');
   IF jsonb_typeof(target->column_name)='number' AND expected IS NOT NULL THEN
    IF actual::numeric IS DISTINCT FROM expected::numeric THEN RAISE LOG 'Hire source binding unavailable (%/%)',section.key,entry.key;RETURN false;END IF;
   ELSIF actual IS DISTINCT FROM expected THEN RAISE LOG 'Hire source binding unavailable (%/%)',section.key,entry.key;RETURN false;END IF;
  END LOOP;
 END LOOP;
 -- Match the canonical family multiset, including duplicates; row/UI keys confer no storage authority.
 FOR family_row IN SELECT value FROM jsonb_array_elements(coalesce(data->'family','[]')) LOOP
  family_expected:='{}';
  FOR entry IN SELECT * FROM jsonb_each(family_row) source_entry WHERE source_entry.key<>'key' LOOP
   column_name:=lower(regexp_replace(entry.key,'([A-Z])','_\1','g'));
   expected:=nullif(btrim(entry.value#>>'{}'),'');
   IF entry.key IN ('marriageDate','marriageStatus','spouseWorking','companyName','employerAddress') AND family_row->>'relationship'<>'spouse' THEN expected:=NULL;END IF;
   IF entry.key IN ('isStudent','schoolName','studyLevel','studyCountry','childReliefCategory','childTaxRelief','childReliefPercentage') AND family_row->>'relationship'<>'child' THEN expected:=NULL;END IF;
   family_expected:=family_expected||jsonb_build_object(column_name,expected);
  END LOOP;
  expected_members:=expected_members||jsonb_build_array(family_expected);
 END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(d)),'[]') INTO actual_members FROM public.employee_dependent d WHERE d.tenant_id=e.tenant_id AND d.person_id=e.person_id AND d.archived_at IS NULL;
 IF jsonb_array_length(actual_members)<>jsonb_array_length(expected_members) THEN RETURN false;END IF;
 FOR family_expected IN SELECT value FROM jsonb_array_elements(expected_members) LOOP
  stored_family:=NULL;
  SELECT value INTO stored_family FROM jsonb_array_elements(actual_members) m WHERE NOT EXISTS(SELECT 1 FROM jsonb_each(family_expected) v WHERE nullif(btrim(m.value->>v.key),'') IS DISTINCT FROM nullif(v.value#>>'{}','')) LIMIT 1;
  IF stored_family IS NULL THEN RETURN false;END IF;
  -- Remove one matching physical row, retaining multiplicity.
  actual_members:=actual_members-(SELECT ordinality::integer-1 FROM jsonb_array_elements(actual_members) WITH ORDINALITY m WHERE m.value=stored_family LIMIT 1);
 END LOOP;
 RETURN true;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_hire_effects_match(jsonb,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_consumed_draft(p_source jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.workforce_hire_source s JOIN public.employment e ON e.id=s.employment_id AND e.tenant_id=s.tenant_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE s.xact_id=pg_current_xact_id() AND s.tenant_id=app.current_tenant_id() AND s.user_id=app.current_user_id()
 AND s.draft_id=(p_source->>'id')::uuid AND s.source_hash=encode(sha256(convert_to(p_source::text,'UTF8')),'hex')
 AND app.access_workforce_hire_effects_match(s.source->'data',e.id)
 AND app.data_permission_employment_born(e.id) AND app.access_workforce_action_company(e.company_id,'add')
 AND nullif(btrim(s.source#>>'{data,profile,phone}'),'') IS NOT DISTINCT FROM nullif(btrim(p.phone),'')
 AND EXISTS(SELECT 1 FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id
  AND a.department_id::text=s.source#>>'{data,employment,departmentId}' AND a.superseded_at IS NULL
  AND a.employment_type::text=coalesce(nullif(s.source#>>'{data,employment,employmentType}',''),'full_time'))
 AND EXISTS(SELECT 1 FROM public.compensation c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.valid_from=e.hired_on AND c.superseded_at IS NULL
  AND c.basic_salary=coalesce(nullif(regexp_replace(s.source#>>'{data,payroll,basicSalary}','[,_]','','g'),''),'0')::numeric
  AND c.monthly_allowance=coalesce(nullif(regexp_replace(s.source#>>'{data,payroll,monthlyAllowance}','[,_]','','g'),''),'0')::numeric
  AND c.pay_mode::text=coalesce(nullif(s.source#>>'{data,payroll,payMode}',''),'monthly')
  AND c.payment_term=coalesce(nullif(s.source#>>'{data,payroll,paymentTerm}',''),'monthly')
  AND c.rate_amount IS NOT DISTINCT FROM nullif(regexp_replace(s.source#>>'{data,payroll,rateAmount}','[,_]','','g'),'')::numeric
  AND nullif(btrim(c.remarks),'') IS NOT DISTINCT FROM nullif(btrim(s.source#>>'{data,payroll,remarks}'),''))
 AND (nullif(s.source#>>'{data,statutory,subjectToSkbbk}','') IS NULL OR EXISTS(SELECT 1 FROM public.employee_statutory_my m WHERE m.person_id=e.person_id AND m.tenant_id=e.tenant_id AND m.subject_to_skbbk=(s.source#>>'{data,statutory,subjectToSkbbk}'='yes'))));
$$;
REVOKE ALL ON FUNCTION app.access_workforce_consumed_draft(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_draft_action(p_company uuid,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_company IS NOT NULL THEN app.access_workforce_action_company(p_company,p_action)
 WHEN EXISTS(SELECT 1 FROM public.access_capability WHERE id='workforce.'||p_action AND supported)
 THEN app.principal_snapshot_current() AND app.access_can_delegate('workforce.view',NULL) AND app.access_can_delegate('workforce.'||p_action,NULL)
 ELSE app.access_workforce_unassigned('workforce.maintain') END;
$$;
REVOKE ALL ON FUNCTION app.access_workforce_draft_action(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_draft_delete_allowed(p_draft uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employee_draft d WHERE d.id=p_draft AND d.tenant_id=app.current_tenant_id()
  AND (app.access_workforce_draft_action(d.company_id,'delete') OR (app.access_profile_request_own(d.created_by_person_id)
   AND NOT EXISTS(SELECT 1 FROM public.access_user_override o WHERE o.user_id=app.current_user_id() AND o.tenant_id=d.tenant_id AND o.retired_at IS NULL AND o.effect='deny' AND o.capability_id IN ('workforce.delete','workforce.view','workforce.maintain') AND app.access_scope_covers(o.company_id,d.company_id,d.tenant_id)))));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_draft_delete_allowed(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.workforce_draft_birth(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,user_id uuid NOT NULL,draft_id uuid NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,draft_id));
--> statement-breakpoint
REVOKE ALL ON TABLE app.workforce_draft_birth FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_record_draft_birth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NULL OR app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 DELETE FROM app.workforce_draft_birth WHERE tenant_id=NEW.tenant_id AND xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.workforce_draft_birth VALUES(pg_current_xact_id(),NEW.tenant_id,app.current_user_id(),NEW.id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_record_draft_birth() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER workforce_draft_birth AFTER INSERT ON employee_draft FOR EACH ROW EXECUTE FUNCTION app.access_workforce_record_draft_birth();
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_draft_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE company uuid;author uuid;action text;own boolean;initial boolean:=false;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app.access_workforce_write_lock();
 IF TG_OP<>'INSERT' AND NOT app.data_permission_draft_matches(app.current_tenant_id(),app.current_user_id(),to_jsonb(OLD))
  OR TG_OP<>'DELETE' AND NOT app.data_permission_draft_matches(app.current_tenant_id(),app.current_user_id(),to_jsonb(NEW)) THEN RAISE EXCEPTION 'Draft data scope unavailable' USING ERRCODE='42501';END IF;
 company:=CASE WHEN TG_OP='DELETE' THEN OLD.company_id ELSE NEW.company_id END;
 author:=CASE WHEN TG_OP='DELETE' THEN OLD.created_by_person_id ELSE NEW.created_by_person_id END;
 action:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
 IF TG_OP='INSERT' AND NEW.created_by_person_id IS DISTINCT FROM (SELECT u.person_id FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()) THEN
  RAISE EXCEPTION 'Draft author unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id THEN
   RAISE EXCEPTION 'Draft identity cannot be reassigned' USING ERRCODE='42501';END IF;
  IF NEW.data->'creationDefaultsVersion' IS DISTINCT FROM OLD.data->'creationDefaultsVersion' THEN RAISE EXCEPTION 'Draft creation cohort cannot be reassigned' USING ERRCODE='42501';END IF;
  initial:=EXISTS(SELECT 1 FROM app.workforce_draft_birth b WHERE b.xact_id=pg_current_xact_id() AND b.tenant_id=OLD.tenant_id AND b.user_id=app.current_user_id() AND b.draft_id=OLD.id)
   AND app.access_workforce_draft_action(OLD.company_id,'add') AND app.access_workforce_draft_action(NEW.company_id,'add');
 END IF;

 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM app.workforce_hire_source hs WHERE hs.xact_id=pg_current_xact_id() AND hs.tenant_id=OLD.tenant_id AND hs.user_id=app.current_user_id() AND hs.draft_id=OLD.id AND hs.employment_id IS NOT NULL) THEN
  IF NOT app.access_workforce_consumed_draft(to_jsonb(OLD)) THEN RAISE EXCEPTION 'Hire source effects incomplete' USING ERRCODE='42501';END IF;
  UPDATE app.workforce_hire_source SET consumed=true WHERE xact_id=pg_current_xact_id() AND tenant_id=OLD.tenant_id AND user_id=app.current_user_id() AND draft_id=OLD.id;
  RETURN OLD;
 END IF;
 own:=app.access_profile_request_own(author) AND NOT EXISTS(SELECT 1 FROM public.access_user_override o WHERE o.user_id=app.current_user_id() AND o.tenant_id=app.current_tenant_id() AND o.retired_at IS NULL AND o.effect='deny' AND o.capability_id IN ('workforce.'||action,'workforce.view','workforce.maintain') AND (app.access_scope_covers(o.company_id,company,app.current_tenant_id()) OR TG_OP='UPDATE' AND app.access_scope_covers(o.company_id,OLD.company_id,app.current_tenant_id())));
 IF (TG_OP='DELETE' AND app.access_workforce_draft_delete_allowed(OLD.id))
  OR (TG_OP='INSERT' AND (own OR app.access_workforce_draft_action(company,'add')))
  OR (TG_OP='UPDATE' AND (own OR initial OR (app.access_workforce_draft_action(OLD.company_id,'edit') AND app.access_workforce_draft_action(NEW.company_id,'edit')))) THEN
  IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
 END IF;
 IF TG_OP='DELETE' AND app.access_workforce_consumed_draft(to_jsonb(OLD)) THEN
  UPDATE app.workforce_hire_source SET consumed=true WHERE xact_id=pg_current_xact_id() AND tenant_id=OLD.tenant_id AND user_id=app.current_user_id() AND draft_id=OLD.id;
  RETURN OLD;END IF;
 RAISE EXCEPTION 'Draft action unavailable' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION app.access_workforce_draft_action_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER workforce_action_write BEFORE INSERT OR UPDATE OR DELETE ON employee_draft FOR EACH ROW EXECUTE FUNCTION app.access_workforce_draft_action_guard();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_can_delegate(p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.access_capability c
  JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
  WHERE c.id=p_capability AND app.access_function_delegation_floor(p_capability,p_company) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.prerequisites) needed(id) JOIN public.access_capability prerequisite ON prerequisite.id=needed.id WHERE NOT app.access_can_delegate(needed.id,CASE WHEN prerequisite.scope='tenant' THEN NULL ELSE p_company END)) AND app.access_current_capability_source(p_capability,p_company) AND (p_capability NOT IN ('workforce.add','workforce.edit','workforce.delete','workforce.maintain') OR CASE WHEN p_company IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(p_company) END) AND (p_capability !~ '^.+\.(add|edit|delete|approve|issue|execute)$' OR app.access_can_delegate(regexp_replace(p_capability,'[^.]+$','view'),p_company)) AND c.supported AND jsonb_array_length(c.bindings)>0
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND CASE WHEN c.scope='tenant' THEN p_company IS NULL AND app.access_allowed_for(u.id,c.id,NULL)
    WHEN p_company IS NOT NULL THEN app.access_allowed_for(u.id,c.id,p_company)
    ELSE EXISTS(SELECT 1 FROM public.access_configuration s WHERE s.tenant_id=u.tenant_id AND s.initialized)
     AND (app.access_native_default_current(c.id,NULL) OR EXISTS(SELECT 1 FROM public.access_user_override o WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.capability_id=c.id AND o.company_id IS NULL AND o.effect='allow' AND o.retired_at IS NULL)
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
CREATE OR REPLACE FUNCTION app.access_workforce_editor(p_employment uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.employment%ROWTYPE;profile_revision text;profile_values jsonb;registers jsonb;
BEGIN
 SELECT * INTO selected FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.access_workforce_projection_company(selected.company_id) OR NOT app.data_permission_matches(selected.id) THEN RETURN NULL; END IF;
 SELECT p.xmin::text,app.access_workforce_record(selected.id)->'profile' INTO profile_revision,profile_values
  FROM public.person p WHERE p.id=selected.person_id AND p.tenant_id=selected.tenant_id;
 SELECT COALESCE(jsonb_agg(item ORDER BY item->>'kind',item->>'id'),'[]'::jsonb) INTO registers FROM (
  SELECT jsonb_build_object('kind','qualification','id',q.id,'version',q.xmin::text,'values',jsonb_build_object(
   'qualification',q.qualification,'description',q.description,'fromYm',q.from_ym,'toYm',q.to_ym,'institute',q.institute,
   'major',q.major,'graduationDate',q.graduation_date,'result',q.result,'isHighest',q.is_highest)) item
   FROM public.employee_qualification q WHERE q.tenant_id=selected.tenant_id AND q.employment_id=selected.id AND q.archived_at IS NULL
  UNION ALL
  SELECT jsonb_build_object('kind','emergency','id',c.id,'version',c.xmin::text,'values',jsonb_build_object(
   'fullName',c.full_name,'relationship',c.relationship,'mobilePhone',c.mobile_phone,'homePhone',c.home_phone,'address',c.address,'priority',c.priority))
   FROM public.person_emergency_contact c WHERE c.tenant_id=selected.tenant_id AND c.person_id=selected.person_id AND c.archived_at IS NULL
  UNION ALL
  SELECT jsonb_build_object('kind','dependent','id',d.id,'version',d.xmin::text,'values',jsonb_build_object(
   'relationship',d.relationship,'fullName',d.full_name,'gender',d.gender,'dateOfBirth',d.date_of_birth,'phone',d.phone,
   'icOrPassport',d.ic_or_passport,'passportNumber',d.passport_number,'residentialAddress',d.residential_address,
   'marriageDate',d.marriage_date,'marriageStatus',d.marriage_status,'spouseWorking',d.spouse_working,
   'isBeneficiary',d.is_beneficiary,'isDeceased',d.is_deceased,'isStudent',d.is_student,'schoolName',d.school_name,
   'studyLevel',d.study_level,'studyCountry',d.study_country,'childReliefCategory',d.child_relief_category,
   'childTaxRelief',d.child_tax_relief,'childReliefPercentage',d.child_relief_percentage))
   FROM public.employee_dependent d WHERE d.tenant_id=selected.tenant_id AND d.person_id=selected.person_id AND d.archived_at IS NULL
  LIMIT 501
 ) rows;
 IF jsonb_array_length(registers)>500 THEN RAISE EXCEPTION 'Workforce editor record limit' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('profileVersion',profile_revision,'profile',profile_values,'sharedMaintain',app.access_workforce_command_person(selected.id),
  'employmentMaintain',app.access_workforce_command_allowed(selected.id),'registers',registers,'actionCapabilities',jsonb_build_object('employment',jsonb_build_object('add',app.access_workforce_action_employment(selected.id,'add'),'edit',app.access_workforce_action_employment(selected.id,'edit'),'delete',app.access_workforce_action_employment(selected.id,'delete')),'person',jsonb_build_object('add',app.access_workforce_action_person(selected.person_id,'add'),'edit',app.access_workforce_action_person(selected.person_id,'edit'),'delete',app.access_workforce_action_person(selected.person_id,'delete'))));
END; $$;

--> statement-breakpoint
ALTER TABLE app.access_privacy_value_intent DROP CONSTRAINT access_privacy_value_intent_kind_check;
--> statement-breakpoint
ALTER TABLE app.access_privacy_value_intent ADD CONSTRAINT access_privacy_value_intent_kind_check CHECK(kind IN ('person','dependent','emergency','statutory','photo'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_privacy_erasure_begin(p_employment uuid,p_scope text,p_request_ref text,p_reason text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.employment%ROWTYPE;policy jsonb:=app.access_privacy_erasure_policy();at_time timestamptz:=statement_timestamp();
 lifted boolean:=false;lift_date date;original jsonb;expected jsonb;patch jsonb:='{}'::jsonb;field jsonb;column_name text;
 saved record;before_digest text;after_digest text;
BEGIN
 PERFORM app.access_profile_policy_write_lock();
 IF p_scope IS NULL OR p_scope NOT IN ('contact','financial','identity','statutory-ids','all')
  OR p_request_ref IS NULL OR btrim(p_request_ref)='' OR length(p_request_ref)>4000 OR p_reason IS NULL OR length(p_reason)>4000 THEN
  RAISE EXCEPTION 'Privacy erasure input unavailable' USING ERRCODE='22023'; END IF;
 IF app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR app.is_admin() IS NOT TRUE THEN
  RAISE EXCEPTION 'Privacy erasure principal unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO selected FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.can_admin_employment(selected.id) IS NOT TRUE THEN
  RAISE EXCEPTION 'Privacy erasure subject unavailable' USING ERRCODE='42501'; END IF;
 -- Same calendar-year rollover as Date.setUTCFullYear: 29-Feb rolls to 1-Mar in a non-leap year.
 -- Both owners use this admission's one actual timestamp and the one declared retention duration.
 IF selected.terminated_on IS NOT NULL THEN
  lift_date:=make_date(extract(year FROM selected.terminated_on)::integer+(policy->>'retentionYears')::integer,
   extract(month FROM selected.terminated_on)::integer,1)+(extract(day FROM selected.terminated_on)::integer-1);
  lifted:=(lift_date::timestamp AT TIME ZONE 'UTC')<=at_time;
 END IF;
 IF EXISTS(SELECT 1 FROM app.access_privacy_value_intent i WHERE i.xact_id=pg_current_xact_id()
  AND i.tenant_id=selected.tenant_id AND i.user_id=app.current_user_id() AND i.person_id=selected.person_id) THEN
  RAISE EXCEPTION 'Privacy erasure already prepared' USING ERRCODE='40001'; END IF;
 DELETE FROM app.access_privacy_value_intent WHERE tenant_id=selected.tenant_id AND xact_id<pg_snapshot_xmin(pg_current_snapshot());
 SELECT to_jsonb(p) INTO original FROM public.person p WHERE p.id=selected.person_id AND p.tenant_id=selected.tenant_id FOR UPDATE;
 IF original IS NULL THEN RAISE EXCEPTION 'Privacy erasure subject unavailable' USING ERRCODE='42501'; END IF;
 FOR field IN SELECT value FROM jsonb_array_elements(policy->'fields') LOOP
  IF field->>'table'='person' AND (p_scope='all' OR field->'scopes' ? p_scope)
   AND (NOT (field->>'statutoryLocked')::boolean OR lifted) THEN
   column_name:=lower(regexp_replace(field->>'key','([A-Z])','_\1','g'));
   IF NOT original ? column_name THEN RAISE EXCEPTION 'Privacy erasure field unavailable' USING ERRCODE='55000'; END IF;
   patch:=patch||jsonb_build_object(column_name,NULL);
  END IF;
 END LOOP;
 expected:=original||patch;
 before_digest:=encode(sha256(convert_to((original-'updated_at')::text,'UTF8')),'hex');
 after_digest:=encode(sha256(convert_to((expected-'updated_at')::text,'UTF8')),'hex');
 IF before_digest<>after_digest THEN
  INSERT INTO app.access_privacy_value_intent VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,selected.person_id,
   'person',selected.person_id,before_digest,after_digest,p_scope,encode(sha256(convert_to(p_request_ref,'UTF8')),'hex'),encode(sha256(convert_to(p_reason,'UTF8')),'hex'),NULL);
 END IF;
 patch:='{}'::jsonb;
 IF p_scope IN ('contact','all') THEN
  FOR column_name IN SELECT jsonb_array_elements_text(policy->'dependentContact') LOOP
   patch:=patch||jsonb_build_object(lower(regexp_replace(column_name,'([A-Z])','_\1','g')),NULL);
  END LOOP;
 END IF;
 IF p_scope IN ('identity','all') THEN
  FOR column_name IN SELECT jsonb_array_elements_text(policy->'dependentIdentity') LOOP
   patch:=patch||jsonb_build_object(lower(regexp_replace(column_name,'([A-Z])','_\1','g')),NULL);
  END LOOP;
 END IF;
 IF patch<>'{}'::jsonb THEN
  FOR saved IN SELECT to_jsonb(d) AS value FROM public.employee_dependent d WHERE d.tenant_id=selected.tenant_id AND d.person_id=selected.person_id ORDER BY d.id FOR UPDATE LOOP
   original:=saved.value;expected:=original||patch;
   before_digest:=encode(sha256(convert_to((original-'updated_at')::text,'UTF8')),'hex');
   after_digest:=encode(sha256(convert_to((expected-'updated_at')::text,'UTF8')),'hex');
   IF before_digest<>after_digest THEN
    INSERT INTO app.access_privacy_value_intent VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,selected.person_id,
     'dependent',(original->>'id')::uuid,before_digest,after_digest,p_scope,encode(sha256(convert_to(p_request_ref,'UTF8')),'hex'),encode(sha256(convert_to(p_reason,'UTF8')),'hex'),NULL);
   END IF;
  END LOOP;
 END IF;
 IF p_scope IN ('contact','all') THEN
  FOR saved IN SELECT to_jsonb(c) AS value FROM public.person_emergency_contact c WHERE c.tenant_id=selected.tenant_id AND c.person_id=selected.person_id ORDER BY c.id FOR UPDATE LOOP
   original:=saved.value;
   INSERT INTO app.access_privacy_value_intent VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,selected.person_id,
    'emergency',(original->>'id')::uuid,encode(sha256(convert_to((original-'updated_at')::text,'UTF8')),'hex'),
    encode(sha256(convert_to('{}','UTF8')),'hex'),p_scope,encode(sha256(convert_to(p_request_ref,'UTF8')),'hex'),encode(sha256(convert_to(p_reason,'UTF8')),'hex'),NULL);
  END LOOP;
 END IF;
 patch:='{}'::jsonb;
 IF lifted THEN
  FOR field IN SELECT value FROM jsonb_array_elements(policy->'fields') LOOP
   IF field->>'table'='statutory' AND (p_scope='all' OR field->'scopes' ? p_scope) THEN
    column_name:=lower(regexp_replace(field->>'key','([A-Z])','_\1','g'));
    patch:=patch||jsonb_build_object(column_name,NULL);
   END IF;
  END LOOP;
 END IF;
 IF patch<>'{}'::jsonb THEN
  SELECT to_jsonb(m) INTO original FROM public.employee_statutory_my m WHERE m.tenant_id=selected.tenant_id AND m.person_id=selected.person_id FOR UPDATE;
  IF original IS NOT NULL THEN
   expected:=original||patch;
   before_digest:=encode(sha256(convert_to((original-'updated_at')::text,'UTF8')),'hex');
   after_digest:=encode(sha256(convert_to((expected-'updated_at')::text,'UTF8')),'hex');
   IF before_digest<>after_digest THEN
    INSERT INTO app.access_privacy_value_intent VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,selected.person_id,
     'statutory',(original->>'id')::uuid,before_digest,after_digest,p_scope,encode(sha256(convert_to(p_request_ref,'UTF8')),'hex'),encode(sha256(convert_to(p_reason,'UTF8')),'hex'),NULL);
   END IF;
  END IF;
 END IF;
 IF p_scope IN ('identity','all') THEN
  SELECT to_jsonb(ph) INTO original FROM public.person_photo ph WHERE ph.tenant_id=selected.tenant_id AND ph.person_id=selected.person_id FOR UPDATE;
  IF original IS NOT NULL THEN
   INSERT INTO app.access_privacy_value_intent VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,selected.person_id,
    'photo',(original->>'id')::uuid,encode(sha256(convert_to((original-'updated_at')::text,'UTF8')),'hex'),encode(sha256(convert_to('{}','UTF8')),'hex'),p_scope,encode(sha256(convert_to(p_request_ref,'UTF8')),'hex'),encode(sha256(convert_to(p_reason,'UTF8')),'hex'),NULL);
  END IF;
 END IF;
 RETURN at_time;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_privacy_value_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent app.access_privacy_value_intent%ROWTYPE;actual jsonb;table_name text;
BEGIN
 SELECT * INTO intent FROM app.access_privacy_value_intent i WHERE i.xact_id=NEW.xact_id AND i.tenant_id=NEW.tenant_id
  AND i.user_id=NEW.user_id AND i.kind=NEW.kind AND i.row_id=NEW.row_id;
 IF NOT FOUND OR intent.event_id IS NULL OR intent.user_id IS DISTINCT FROM app.current_user_id()
  OR intent.tenant_id IS DISTINCT FROM app.current_tenant_id() OR app.principal_snapshot_current() IS NOT TRUE OR app.is_admin() IS NOT TRUE
  OR app.can_admin_employment(intent.employment_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'Privacy erasure incomplete' USING ERRCODE='42501'; END IF;
 table_name:=CASE intent.kind WHEN 'person' THEN 'person' WHEN 'dependent' THEN 'employee_dependent' WHEN 'emergency' THEN 'person_emergency_contact' WHEN 'statutory' THEN 'employee_statutory_my' WHEN 'photo' THEN 'person_photo' END;
 EXECUTE format('SELECT to_jsonb(r) FROM public.%I r WHERE r.id=$1 AND r.tenant_id=$2',table_name) INTO actual USING intent.row_id,intent.tenant_id;
 actual:=COALESCE(actual,'{}'::jsonb);
 IF encode(sha256(convert_to((actual-'updated_at')::text,'UTF8')),'hex')<>intent.after_hash THEN
  RAISE EXCEPTION 'Privacy erasure effects incomplete' USING ERRCODE='42501'; END IF;
 RETURN NULL;
END; $$;

--> statement-breakpoint
-- The shared statutory row has independent financial owners. This guard covers only
-- Personnel identity/bank cells; partial clear is Edit, physical removal is Delete.
CREATE FUNCTION app.access_workforce_statutory_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 target uuid:=COALESCE(NEW.person_id,OLD.person_id);delta jsonb;relevant boolean;operation text;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_object_agg(k.key,k.value),'{}'::jsonb) INTO delta FROM jsonb_each(after_row) k
  WHERE k.key NOT IN ('id','tenant_id','person_id','created_at','updated_at') AND k.value IS DISTINCT FROM before_row->k.key;
 SELECT EXISTS(SELECT 1 FROM unnest(ARRAY['ic_number','old_ic_number','passport_number','passport_issue_date','passport_expiry_date','passport_issuing_country_code','passport_issuing_country','passport_remark','bank_name','bank_account_no','enable_custom_holder_name','custom_holder_name','enable_custom_holder_id','custom_holder_id']) k
  WHERE CASE WHEN TG_OP='DELETE' THEN before_row->k NOT IN ('null'::jsonb,'false'::jsonb)
   WHEN TG_OP='INSERT' THEN after_row->k NOT IN ('null'::jsonb,'false'::jsonb)
   ELSE after_row->k IS DISTINCT FROM before_row->k END) INTO relevant;
 IF NOT relevant THEN RETURN NULL; END IF;
 IF app.access_privacy_value_intent_allowed('statutory',before_row,after_row) THEN RETURN NULL; END IF;
 -- Existing self-service admission is further checked by its exact deferred field witness.
 IF TG_OP<>'DELETE' AND app.profile_direct_person(target) THEN RETURN NULL; END IF;
 IF TG_OP<>'DELETE' AND to_regprocedure('app.profile_task_statutory_delta_approved(uuid,uuid,jsonb,boolean)') IS NOT NULL THEN
  IF app.profile_task_statutory_delta_approved(target,NEW.id,delta,TG_OP='INSERT') THEN RETURN NULL; END IF;
 END IF;
 operation:=CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'edit' END;
 IF app.access_workforce_action_person(target,operation) OR (TG_OP<>'DELETE' AND app.access_workforce_initial_person(target)) THEN RETURN NULL; END IF;
 RAISE EXCEPTION 'Workforce statutory action unavailable' USING ERRCODE='42501';
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_statutory_action_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER access_workforce_statutory_action_guard AFTER INSERT OR UPDATE OR DELETE ON employee_statutory_my DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_workforce_statutory_action_guard();

--> statement-breakpoint
CREATE FUNCTION app.access_workforce_photo_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 subject uuid:=COALESCE(NEW.person_id,OLD.person_id);operation text:=CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END;
BEGIN
 IF app.access_workforce_storage_owner() OR app.access_privacy_value_intent_allowed('photo',before_row,after_row) THEN RETURN NULL; END IF;
 IF TG_OP<>'DELETE' AND to_regprocedure('app.profile_task_photo_approved(uuid)') IS NOT NULL THEN
  IF app.profile_task_photo_approved(subject) THEN RETURN NULL; END IF;
 END IF;
 IF app.access_workforce_action_person(subject,operation) THEN RETURN NULL; END IF;
 RAISE EXCEPTION 'Workforce photo action unavailable' USING ERRCODE='42501';
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_photo_action_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER access_workforce_photo_action_guard AFTER INSERT OR UPDATE OR DELETE ON person_photo DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_workforce_photo_action_guard();

--> statement-breakpoint
-- Preview uses the same native-aware delegation owner as the physical commit seam.
CREATE FUNCTION app.access_configuration_delegation_preview(p_grants jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE grant_row jsonb;
BEGIN
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT app.access_allowed_for(app.current_user_id(),'access.configure',NULL) THEN RAISE EXCEPTION 'access ceiling' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_grants)<>'array' OR jsonb_array_length(p_grants)>2000 THEN RAISE EXCEPTION 'access invalid' USING ERRCODE='23514'; END IF;
 FOR grant_row IN SELECT value FROM jsonb_array_elements(p_grants) LOOP
  IF NOT app.access_command_keys(grant_row,ARRAY['capabilityId','companyId']) THEN RAISE EXCEPTION 'access invalid' USING ERRCODE='23514'; END IF;
  PERFORM app.access_require_delegate(grant_row->>'capabilityId',(grant_row->>'companyId')::uuid);
 END LOOP;RETURN true;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_configuration_delegation_preview(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_configuration_delegation_preview(jsonb) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.access_workforce_hire_source_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source app.workforce_hire_source%ROWTYPE;
BEGIN
 SELECT * INTO source FROM app.workforce_hire_source s WHERE s.xact_id=NEW.xact_id AND s.tenant_id=NEW.tenant_id AND s.user_id=NEW.user_id AND s.draft_id=NEW.draft_id;
 IF NOT FOUND OR source.employment_id IS NULL THEN RETURN NULL;END IF;
 IF NOT source.consumed THEN RAISE EXCEPTION 'Hire source effects incomplete' USING ERRCODE='42501';END IF;
 IF source.xact_id<>pg_current_xact_id() OR source.user_id IS DISTINCT FROM app.current_user_id() OR source.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR NOT app.access_workforce_consumed_draft(source.source)
  OR EXISTS(SELECT 1 FROM public.employee_draft d WHERE d.id=source.draft_id AND d.tenant_id=source.tenant_id)
  OR NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=source.tenant_id AND e.aggregate_type='employee-draft' AND e.aggregate_id=source.draft_id
   AND e.event_type='employee-draft.completed' AND e.actor_type='user' AND e.actor_id=source.user_id AND e.subject_employment_id=source.employment_id
   AND e.payload->>'employmentId'=source.employment_id::text AND e.payload->>'companyId'=source.company_id::text) THEN
  RAISE EXCEPTION 'Hire source effects incomplete' USING ERRCODE='42501';END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_hire_source_complete() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER workforce_hire_source_complete AFTER INSERT OR UPDATE ON app.workforce_hire_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_workforce_hire_source_complete();

--> statement-breakpoint
-- Preserve the restricted child-owned source port and its exact guard; only the new
-- server-owned literal cohort1 is exempted from the anti-amplification numeric fence.
DO $cohort_upgrade$
DECLARE prior_role text:=pg_catalog.current_setting('role');
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('app._draft_discard_source_snapshot(uuid,uuid)')
  AND p.proowner='ai_hr_draft_discard_port'::regrole AND p.prosecdef
  AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='c3a2744b7924ff9e4313c579dc9d831c5101a5d2b265dcad380cbab63b645ca9')
  OR pg_catalog.has_schema_privilege('ai_hr_draft_discard_port','app','CREATE') THEN
  RAISE EXCEPTION 'Draft discard cohort upgrade requires the exact existing child owner' USING ERRCODE='42501';END IF;
 GRANT CREATE ON SCHEMA app TO ai_hr_draft_discard_port;
 PERFORM pg_catalog.set_config('role','ai_hr_draft_discard_port',true);
 EXECUTE $definition$
CREATE OR REPLACE FUNCTION app._draft_discard_source_snapshot(p_draft uuid,p_company uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
DECLARE d public.employee_draft%ROWTYPE; rev text; physical tid; row_hash text; company_name text;
 counter_json jsonb; counter_rev text; counter_kind text:='none'; digest text; private jsonb;
BEGIN
 IF current_user<>'ai_hr_draft_discard_port' OR NOT pg_catalog.row_security_active('public.employee_draft'::regclass)
  OR NOT app.principal_snapshot_current() OR app.is_admin() IS NOT TRUE OR p_company IS NULL THEN
  RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 -- The outer source owner joins canonical Lifecycle before this source lock.
 PERFORM app.access_workforce_write_lock();
 IF NOT ((SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname) FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.employee_draft'::regclass AND a.attnum>0 AND NOT a.attisdropped)
  IS NOT DISTINCT FROM ARRAY['company_id','created_at','created_by_person_id','current_step','data','id','label','reserved_at','reserved_config_id','reserved_employee_code','reserved_number','tenant_id','updated_at']::text[]) THEN RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
 -- Project only metadata/storage guards first; never move a large data value to the receiver.
 SELECT x.xmin::text,x.ctid INTO rev,physical FROM public.employee_draft x
 WHERE x.id=p_draft AND x.tenant_id=app.current_tenant_id() AND x.company_id=p_company
 FOR UPDATE OF x NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM public.employee_draft x WHERE x.id=p_draft AND (
  pg_catalog.pg_column_compression(x.data) IS NOT NULL OR pg_catalog.pg_column_size(x.data)>65536
  OR pg_catalog.pg_column_compression(x.label) IS NOT NULL OR pg_catalog.pg_column_size(x.label)>8000
  OR pg_catalog.pg_column_compression(x.reserved_employee_code) IS NOT NULL OR coalesce(pg_catalog.pg_column_size(x.reserved_employee_code),0)>2048)) THEN
  RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
 -- The uncompressed binary datum is now bounded. Only the exact server-owned root cohort1 numeric leaf is allowed; all other numeric leaves remain refused.
 IF EXISTS(SELECT 1 FROM public.employee_draft x WHERE x.id=p_draft AND pg_catalog.jsonb_path_exists(CASE WHEN x.data->'creationDefaultsVersion'='1'::jsonb THEN x.data-'creationDefaultsVersion' ELSE x.data END,'strict $.** ? (@.type() == "number")')) THEN
  RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
 SELECT x.* INTO d FROM public.employee_draft x WHERE x.id=p_draft;
 IF d.company_id IS DISTINCT FROM p_company OR pg_catalog.length(d.label)>2000 OR coalesce(pg_catalog.length(d.reserved_employee_code),0)>512
  OR d.reserved_number IS NOT NULL AND coalesce(d.reserved_employee_code,'')='' THEN
  RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
 IF EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=d.tenant_id AND
  (pg_catalog.pg_column_compression(c.legal_name) IS NOT NULL OR pg_catalog.pg_column_size(c.legal_name)>8000)) THEN
  RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
 SELECT c.legal_name INTO company_name FROM public.company c WHERE c.id=p_company AND c.tenant_id=d.tenant_id;
 IF company_name IS NULL OR pg_catalog.length(company_name)>2000 THEN RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 row_hash:=app._draft_discard_row_digest(d,rev);
 IF coalesce(d.reserved_employee_code,'')<>'' AND d.reserved_number IS NOT NULL THEN
  IF d.reserved_config_id IS NOT NULL THEN
   counter_kind:='configured';
   PERFORM 1 FROM public.employee_id_config c WHERE c.id=d.reserved_config_id AND c.tenant_id=d.tenant_id FOR UPDATE OF c NOWAIT;
   IF EXISTS(SELECT 1 FROM public.employee_id_config c WHERE c.id=d.reserved_config_id AND c.tenant_id=d.tenant_id AND (
    pg_catalog.pg_column_compression(c.template_name) IS NOT NULL OR coalesce(pg_catalog.pg_column_size(c.template_name),0)>8000
    OR pg_catalog.pg_column_compression(c.prefix) IS NOT NULL OR pg_catalog.pg_column_size(c.prefix)>8000
    OR pg_catalog.pg_column_compression(c.suffix) IS NOT NULL OR pg_catalog.pg_column_size(c.suffix)>8000
    OR pg_catalog.pg_column_compression(c.status) IS NOT NULL OR pg_catalog.pg_column_size(c.status)>8000)) THEN
    RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
   SELECT (pg_catalog.to_jsonb(c)-'created_at'-'updated_at')||pg_catalog.jsonb_build_object(
    'created_at',pg_catalog.to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updated_at',pg_catalog.to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),c.xmin::text
   INTO counter_json,counter_rev FROM public.employee_id_config c WHERE c.id=d.reserved_config_id AND c.tenant_id=d.tenant_id FOR UPDATE OF c NOWAIT;
  ELSE
   counter_kind:='legacy';
   SELECT pg_catalog.to_jsonb(c),c.xmin::text INTO counter_json,counter_rev FROM public.tenant_counter c
   WHERE c.tenant_id=d.tenant_id AND c.kind='employee_code' FOR UPDATE OF c NOWAIT;
  END IF;
 END IF;
 private:=pg_catalog.jsonb_build_object('rowDigest',row_hash,'counterKind',counter_kind,'counterBefore',counter_json,
  'counterXmin',counter_rev,'configId',d.reserved_config_id,'number',d.reserved_number,'code',d.reserved_employee_code,
  'authorIsActor',coalesce(d.created_by_person_id IS NOT NULL AND d.created_by_person_id=(SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=d.tenant_id),false));
 digest:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array('draft-discard-source:v1',row_hash,rev,physical::text,
  private,p_company,company_name)::text,'UTF8')),'hex');
 private:=private||pg_catalog.jsonb_build_object('sourceDigest',digest);
 RETURN pg_catalog.jsonb_build_object('draftId',d.id,'companyId',p_company,'companyName',company_name,'label',d.label,
  'reservedEmployeeCode',d.reserved_employee_code,'reservedNumber',d.reserved_number,'sourceDigest',digest,
  'nativeRowDigest',row_hash,'xmin',rev,'ctid',physical::text,
  'counterBeforeDigest',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(counter_kind,counter_json,counter_rev)::text,'UTF8')),'hex'),
  'private',private);
END $$;
$definition$;
 PERFORM pg_catalog.set_config('role',prior_role,true);
 REVOKE CREATE ON SCHEMA app FROM ai_hr_draft_discard_port;
END $cohort_upgrade$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_configuration_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); result jsonb;
BEGIN
 IF NOT app.access_allowed_for(app.current_user_id(),'access.configure',NULL) THEN
  RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501';
 END IF;
 SELECT jsonb_build_object(
  'snapshot',jsonb_build_object('tenantId',t,'revision',s.revision,
   'users',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'active',u.archived_at IS NULL AND NOT app.login_blocked(u.id)) ORDER BY u.id) FROM public.app_user u WHERE u.tenant_id=t),'[]'::jsonb),
   'groups',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'retired',g.retired_at IS NOT NULL,'systemAdministrator',g.system_administrator,
    'grants',COALESCE((SELECT jsonb_agg(jsonb_build_object('capabilityId',a.capability_id,'companyId',a.company_id) ORDER BY a.capability_id,a.company_id NULLS FIRST) FROM public.access_group_grant a WHERE a.tenant_id=t AND a.group_id=g.id AND a.retired_at IS NULL),'[]'::jsonb)) ORDER BY g.id) FROM public.access_group g WHERE g.tenant_id=t),'[]'::jsonb),
   'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',m.user_id,'groupId',m.group_id,'companyId',m.company_id,'derived',m.derived) ORDER BY m.user_id,m.group_id,m.company_id NULLS FIRST,m.derived) FROM public.access_effective_membership m WHERE m.tenant_id=t),'[]'::jsonb),
   'overrides',COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',o.user_id,'capabilityId',o.capability_id,'companyId',o.company_id,'effect',o.effect) ORDER BY o.user_id,o.capability_id,o.company_id NULLS FIRST) FROM public.access_user_override o WHERE o.tenant_id=t AND o.retired_at IS NULL),'[]'::jsonb)),
  'nativeDefaults',COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',u.id,'capabilityId',c.id,'companyId',scope.id) ORDER BY u.id,c.id,scope.id NULLS FIRST) FROM public.app_user u CROSS JOIN public.access_capability c CROSS JOIN LATERAL (SELECT NULL::uuid id WHERE c.scope='tenant' OR c.scope='company' AND app.access_native_default_allowed(t,u.id,c.id,NULL) UNION ALL SELECT co.id FROM public.company co WHERE co.tenant_id=t AND c.scope='company' AND NOT app.access_native_default_allowed(t,u.id,c.id,NULL)) scope WHERE u.tenant_id=t AND app.access_native_default_allowed(t,u.id,c.id,scope.id)),'[]'::jsonb),
  'catalog',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'scope',c.scope,'supported',c.supported,'bindings',c.bindings,'prerequisites',c.prerequisites,'presentation',(SELECT d.metadata||jsonb_build_object('key',d.function_key) FROM app.access_function_action a JOIN app.access_function_definition d USING(function_key) WHERE a.capability_id=c.id)) ORDER BY c.id) FROM public.access_capability c),'[]'::jsonb),
  'companyIds',COALESCE((SELECT jsonb_agg(c.id ORDER BY c.id) FROM public.company c WHERE c.tenant_id=t),'[]'::jsonb),
  'coverage',COALESCE((SELECT jsonb_agg(jsonb_build_object('ancestor',a.id,'company',c.id) ORDER BY a.id,c.id) FROM public.company a JOIN public.company c ON a.tenant_id=c.tenant_id WHERE a.tenant_id=t AND a.id<>c.id AND app.is_company_descendant(c.id,a.id)),'[]'::jsonb),
  'recoveryUserIds',COALESCE((SELECT jsonb_agg(u.id ORDER BY u.id) FROM public.app_user u WHERE u.tenant_id=t AND app.access_recovery_available(u.id)),'[]'::jsonb),
  'scopeFingerprint',app.access_scope_fingerprint()
 ) INTO result FROM public.access_configuration s WHERE s.tenant_id=t AND s.initialized;
 IF result IS NULL THEN RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501'; END IF;
 RETURN result;
END;
$$;

--> statement-breakpoint
-- Global company authority includes future companies. A scoped allow cannot prove it, and any
-- retained company denial blocks it. This pure target calculation is separate from current claims.
CREATE FUNCTION app.access_global_for_tenant(p_tenant uuid,p_user uuid,p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.access_capability c JOIN public.app_user u ON u.id=p_user AND u.tenant_id=p_tenant JOIN public.access_configuration configuration ON configuration.tenant_id=u.tenant_id
 WHERE c.id=p_capability AND c.scope='company' AND c.supported AND jsonb_array_length(c.bindings)>0 AND configuration.initialized AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND NOT EXISTS(SELECT 1 FROM public.access_user_override o WHERE o.tenant_id=p_tenant AND o.user_id=p_user AND o.capability_id=c.id AND o.effect='deny' AND o.retired_at IS NULL)
 AND (app.access_native_default_allowed(p_tenant,p_user,p_capability,NULL) OR EXISTS(SELECT 1 FROM public.access_user_override o WHERE o.tenant_id=p_tenant AND o.user_id=p_user AND o.capability_id=c.id AND o.effect='allow' AND o.company_id IS NULL AND o.retired_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.access_effective_membership m JOIN public.access_group g ON g.tenant_id=m.tenant_id AND g.id=m.group_id JOIN public.access_group_grant a ON a.tenant_id=g.tenant_id AND a.group_id=g.id WHERE m.tenant_id=p_tenant AND m.user_id=p_user AND m.company_id IS NULL AND g.retired_at IS NULL AND a.capability_id=c.id AND a.company_id IS NULL AND a.retired_at IS NULL))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.prerequisites) needed(id) JOIN public.access_capability prerequisite ON prerequisite.id=needed.id WHERE NOT CASE WHEN prerequisite.scope='tenant' THEN app.access_allowed_for_tenant(p_tenant,p_user,needed.id,NULL) ELSE app.access_global_for_tenant(p_tenant,p_user,needed.id) END)
 AND (c.id !~ '^.+\.(add|edit|delete|approve|issue|execute)$' OR app.access_global_for_tenant(p_tenant,p_user,regexp_replace(c.id,'[^.]+$','view'))));
$$;
REVOKE ALL ON FUNCTION app.access_global_for_tenant(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.function_global_action_allowed(p_key text,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT app.principal_snapshot_current() AND (NOT c.supported OR
 (app.access_current_capability_source(c.id,NULL) AND app.access_global_for_tenant(app.current_tenant_id(),app.current_user_id(),c.id)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.prerequisites) needed(id) JOIN public.access_capability prerequisite ON prerequisite.id=needed.id WHERE NOT app.access_current_capability_source(needed.id,NULL))))
 FROM app.access_function_action a JOIN app.access_function_definition d USING(function_key) JOIN public.access_capability c ON c.id=a.capability_id WHERE a.function_key=p_key AND a.operation=p_operation AND d.scope='company'),false);
$$;
REVOKE ALL ON FUNCTION app.function_global_action_allowed(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.function_global_action_allowed(text,text) TO ai_hr_app;

--> statement-breakpoint

--> statement-breakpoint
-- Target-data ceilings concern actual employee-bearing administrative authority. Own/assigned
-- task and document courses remain independent; tenant catalogues do not imply employee access.
CREATE FUNCTION app.access_user_has_administrative_function(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user u JOIN public.company co ON co.tenant_id=u.tenant_id WHERE u.id=p_user AND app.access_allowed_for_tenant(u.tenant_id,u.id,'workforce.view',co.id))
 OR EXISTS(SELECT 1 FROM public.app_user u CROSS JOIN app.access_function_definition d JOIN app.access_function_action a USING(function_key) JOIN public.access_capability c ON c.id=a.capability_id
 CROSS JOIN LATERAL (SELECT NULL::uuid id WHERE c.scope='tenant' UNION ALL SELECT co.id FROM public.company co WHERE co.tenant_id=u.tenant_id AND c.scope='company') scope
 WHERE u.id=p_user AND d.metadata->>'course'='administrative' AND d.metadata->'employeeBearing'='true'::jsonb AND app.access_allowed_for_tenant(u.tenant_id,u.id,c.id,scope.id) AND app.access_native_default_allowed(u.tenant_id,u.id,c.id,scope.id));
$$;
REVOKE ALL ON FUNCTION app.access_user_has_administrative_function(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_configuration_commit(expected uuid,expected_scope text,command jsonb,new_revision uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 t uuid:=app.current_tenant_id(); actor uuid:=app.current_user_id(); actual uuid;
 kind text; gid uuid; uid uuid; cid uuid; cap text; mode text; enabled boolean;
 group_row public.access_group%ROWTYPE; grant_row record; entry jsonb; intersection uuid;
 audit jsonb; before_grants jsonb;recipients uuid[]:=ARRAY[]::uuid[];recipient uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF NOT app.access_allowed_for(actor,'access.configure',NULL) THEN RAISE EXCEPTION 'access ceiling' USING ERRCODE='42501'; END IF;
 SELECT revision INTO actual FROM public.access_configuration WHERE tenant_id=t AND initialized FOR UPDATE;
 IF actual IS DISTINCT FROM expected OR expected_scope IS DISTINCT FROM app.access_scope_fingerprint() THEN RETURN false; END IF;
 IF new_revision IS NULL OR new_revision=expected OR jsonb_typeof(command) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'access invalid' USING ERRCODE='23514';
 END IF;
 kind:=command->>'kind';
 audit:=jsonb_build_object('kind',kind,'beforeRevision',actual,'afterRevision',new_revision);
 IF kind='createGroup' THEN
  IF NOT app.access_command_keys(command,ARRAY['kind','groupId','name']) OR jsonb_typeof(command->'name')<>'string'
   OR length(btrim(command->>'name')) NOT BETWEEN 1 AND 100 OR command->>'name'<>btrim(command->>'name')
   OR command->>'name' ~ '[[:cntrl:]]' OR (SELECT count(*) FROM public.access_group WHERE tenant_id=t)>=256 THEN
   RAISE EXCEPTION 'access invalid' USING ERRCODE='23514';
  END IF;
  gid:=(command->>'groupId')::uuid;
  IF gid IS NULL THEN RAISE EXCEPTION 'access invalid' USING ERRCODE='23514'; END IF;
  INSERT INTO public.access_group(id,tenant_id,name) VALUES(gid,t,command->>'name');
  audit:=audit||jsonb_build_object('groupId',gid,'created',true);
 ELSIF kind='setOverride' THEN
  IF NOT app.access_command_keys(command,ARRAY['kind','userId','capabilityId','companyId','effect'])
   OR (command->'effect'<>'null'::jsonb AND command->>'effect' NOT IN ('allow','deny')) THEN
   RAISE EXCEPTION 'access invalid' USING ERRCODE='23514';
  END IF;
  uid:=(command->>'userId')::uuid; cid:=(command->>'companyId')::uuid; cap:=command->>'capabilityId'; mode:=command->>'effect';
  IF cap='access.system_admin' AND mode='allow' THEN RAISE EXCEPTION 'access invalid' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=uid AND u.tenant_id=t) THEN RAISE EXCEPTION 'access invalid' USING ERRCODE='23514'; END IF;
  IF app.data_permission_function_target_ceiling(uid) IS NOT TRUE THEN RAISE EXCEPTION 'access data ceiling' USING ERRCODE='42501'; END IF;
  recipients:=array_append(recipients,uid);
  PERFORM app.access_require_delegate(cap,cid);
  audit:=audit||jsonb_build_object('userId',uid,'capabilityId',cap,'companyId',cid,'beforeEffect',
   (SELECT o.effect FROM public.access_user_override o WHERE o.tenant_id=t AND o.user_id=uid AND o.capability_id=cap AND o.company_id IS NOT DISTINCT FROM cid AND o.retired_at IS NULL),'afterEffect',mode);
  UPDATE public.access_user_override SET retired_at=now() WHERE tenant_id=t AND user_id=uid AND capability_id=cap AND company_id IS NOT DISTINCT FROM cid AND retired_at IS NULL;
  IF mode IS NOT NULL THEN INSERT INTO public.access_user_override(tenant_id,user_id,capability_id,company_id,effect) VALUES(t,uid,cap,cid,mode); END IF;
 ELSE
  gid:=(command->>'groupId')::uuid;
  SELECT * INTO group_row FROM public.access_group WHERE id=gid AND tenant_id=t AND retired_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'access invalid' USING ERRCODE='23514'; END IF;
  IF kind='setMembership' THEN
   IF NOT app.access_command_keys(command,ARRAY['kind','groupId','userId','companyId','enabled']) OR jsonb_typeof(command->'enabled')<>'boolean' THEN
    RAISE EXCEPTION 'access invalid' USING ERRCODE='23514';
   END IF;
   uid:=(command->>'userId')::uuid; cid:=(command->>'companyId')::uuid; enabled:=(command->>'enabled')::boolean;
   IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=uid AND u.tenant_id=t AND (NOT enabled OR (u.archived_at IS NULL AND NOT app.login_blocked(u.id))))
    OR (cid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=cid AND c.tenant_id=t))
    OR group_row.system_administrator
    OR EXISTS(SELECT 1 FROM public.access_effective_membership m WHERE m.tenant_id=t AND m.group_id=gid AND m.user_id=uid AND m.company_id IS NOT DISTINCT FROM cid AND m.derived) THEN
    RAISE EXCEPTION 'access invalid' USING ERRCODE='23514';
   END IF;
   IF app.data_permission_function_target_ceiling(uid) IS NOT TRUE THEN RAISE EXCEPTION 'access data ceiling' USING ERRCODE='42501'; END IF;
   recipients:=array_append(recipients,uid);
   FOR grant_row IN SELECT a.capability_id,a.company_id,c.scope FROM public.access_group_grant a JOIN public.access_capability c ON c.id=a.capability_id WHERE a.tenant_id=t AND a.group_id=gid AND a.retired_at IS NULL LOOP
    IF grant_row.scope='tenant' AND cid IS NOT NULL THEN CONTINUE; END IF;
    IF grant_row.company_id IS NULL THEN intersection:=cid;
    ELSIF cid IS NULL OR app.access_scope_covers(cid,grant_row.company_id,t) THEN intersection:=grant_row.company_id;
    ELSIF app.access_scope_covers(grant_row.company_id,cid,t) THEN intersection:=cid;
    ELSE CONTINUE; END IF;
    PERFORM app.access_require_delegate(grant_row.capability_id,intersection);
   END LOOP;
   IF enabled THEN
    IF NOT EXISTS(SELECT 1 FROM public.access_membership m WHERE m.tenant_id=t AND m.group_id=gid AND m.user_id=uid AND m.company_id IS NOT DISTINCT FROM cid AND m.retired_at IS NULL) THEN
     INSERT INTO public.access_membership(tenant_id,group_id,user_id,company_id) VALUES(t,gid,uid,cid);
    END IF;
   ELSE UPDATE public.access_membership SET retired_at=now() WHERE tenant_id=t AND group_id=gid AND user_id=uid AND company_id IS NOT DISTINCT FROM cid AND retired_at IS NULL;
   END IF;
   audit:=audit||jsonb_build_object('groupId',gid,'userId',uid,'companyId',cid,'enabled',enabled);
  ELSIF kind IN ('renameGroup','retireGroup','replaceGroupGrants') THEN
   SELECT coalesce(array_agg(DISTINCT m.user_id),ARRAY[]::uuid[]) INTO recipients FROM public.access_effective_membership m WHERE m.tenant_id=t AND m.group_id=gid;
   FOREACH recipient IN ARRAY recipients LOOP IF app.data_permission_function_target_ceiling(recipient) IS NOT TRUE THEN RAISE EXCEPTION 'access data ceiling' USING ERRCODE='42501'; END IF;END LOOP;
   FOR grant_row IN SELECT capability_id,company_id FROM public.access_group_grant WHERE tenant_id=t AND group_id=gid AND retired_at IS NULL LOOP
    PERFORM app.access_require_delegate(grant_row.capability_id,grant_row.company_id);
   END LOOP;
   IF kind='renameGroup' THEN
    IF NOT app.access_command_keys(command,ARRAY['kind','groupId','name']) OR jsonb_typeof(command->'name')<>'string'
     OR length(btrim(command->>'name')) NOT BETWEEN 1 AND 100 OR command->>'name'<>btrim(command->>'name') OR command->>'name' ~ '[[:cntrl:]]' THEN
     RAISE EXCEPTION 'access invalid' USING ERRCODE='23514';
    END IF;
    UPDATE public.access_group SET name=command->>'name' WHERE id=gid AND tenant_id=t;
    audit:=audit||jsonb_build_object('groupId',gid,'nameChanged',true);
   ELSIF kind='retireGroup' THEN
    IF NOT app.access_command_keys(command,ARRAY['kind','groupId']) THEN RAISE EXCEPTION 'access invalid' USING ERRCODE='23514'; END IF;
    IF group_row.system_administrator THEN RAISE EXCEPTION 'access last administrator' USING ERRCODE='23514'; END IF;
    UPDATE public.access_group SET retired_at=now() WHERE id=gid AND tenant_id=t;
    audit:=audit||jsonb_build_object('groupId',gid,'retired',true);
   ELSE
    IF NOT app.access_command_keys(command,ARRAY['kind','groupId','grants']) OR jsonb_typeof(command->'grants')<>'array' OR jsonb_array_length(command->'grants')>2048 THEN
     RAISE EXCEPTION 'access invalid' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('capabilityId',capability_id,'companyId',company_id) ORDER BY capability_id,company_id NULLS FIRST),'[]'::jsonb)
     INTO before_grants FROM public.access_group_grant WHERE tenant_id=t AND group_id=gid AND retired_at IS NULL;
    FOR entry IN SELECT value FROM jsonb_array_elements(command->'grants') LOOP
     IF NOT app.access_command_keys(entry,ARRAY['capabilityId','companyId']) THEN RAISE EXCEPTION 'access invalid' USING ERRCODE='23514'; END IF;
     IF NOT group_row.system_administrator AND entry->>'capabilityId'='access.system_admin' THEN RAISE EXCEPTION 'access invalid' USING ERRCODE='23514'; END IF;
     PERFORM app.access_require_delegate(entry->>'capabilityId',(entry->>'companyId')::uuid);
    END LOOP;
    IF (SELECT count(*) FROM jsonb_array_elements(command->'grants'))<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(command->'grants')) THEN
     RAISE EXCEPTION 'access invalid' USING ERRCODE='23514';
    END IF;
    UPDATE public.access_group_grant a SET retired_at=now() WHERE a.tenant_id=t AND a.group_id=gid AND a.retired_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(command->'grants') e WHERE e->>'capabilityId'=a.capability_id AND (e->>'companyId')::uuid IS NOT DISTINCT FROM a.company_id);
    FOR entry IN SELECT value FROM jsonb_array_elements(command->'grants') LOOP
     IF NOT EXISTS(SELECT 1 FROM public.access_group_grant a WHERE a.tenant_id=t AND a.group_id=gid AND a.capability_id=entry->>'capabilityId' AND a.company_id IS NOT DISTINCT FROM (entry->>'companyId')::uuid AND a.retired_at IS NULL) THEN
      INSERT INTO public.access_group_grant(tenant_id,group_id,capability_id,company_id) VALUES(t,gid,entry->>'capabilityId',(entry->>'companyId')::uuid);
     END IF;
    END LOOP;
    audit:=audit||jsonb_build_object('groupId',gid,'beforeGrants',before_grants,'afterGrants',command->'grants');
   END IF;
  ELSE RAISE EXCEPTION 'access invalid' USING ERRCODE='23514'; END IF;
 END IF;
 IF (SELECT count(*) FROM public.access_membership WHERE tenant_id=t AND retired_at IS NULL)>100000
  OR (SELECT count(*) FROM public.access_user_override WHERE tenant_id=t AND retired_at IS NULL)>100000 THEN RAISE EXCEPTION 'access invalid' USING ERRCODE='23514'; END IF;
 FOREACH recipient IN ARRAY recipients LOOP IF app.data_permission_function_target_ceiling(recipient) IS NOT TRUE THEN RAISE EXCEPTION 'access data ceiling' USING ERRCODE='42501'; END IF;END LOOP;
 PERFORM app.access_assert_administrator();
 UPDATE public.access_configuration SET revision=new_revision,updated_at=now() WHERE tenant_id=t AND revision=expected;
 IF NOT FOUND THEN RAISE EXCEPTION 'access changed' USING ERRCODE='40001'; END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'access-configuration',t,'access-configuration.changed','user',actor,audit);
 RETURN true;
END;
$$;

--> statement-breakpoint
-- Preview uses the actual owner transition in a subtransaction that always rolls back. This avoids
-- a second proposed-recipient/data-ceiling evaluator and never persists grants, generations or audit.
CREATE FUNCTION app.access_configuration_transition_preview(p_expected uuid,p_scope text,p_command jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE accepted boolean:=false;
BEGIN
 BEGIN
  accepted:=app.access_configuration_commit(p_expected,p_scope,p_command,gen_random_uuid());
  IF NOT accepted THEN RAISE EXCEPTION 'access changed' USING ERRCODE='40001'; END IF;
  RAISE EXCEPTION 'Preview rollback' USING ERRCODE='P0499';
 EXCEPTION WHEN SQLSTATE 'P0499' THEN NULL;
 END;
 IF NOT accepted THEN RAISE EXCEPTION 'access preview refused' USING ERRCODE='42501'; END IF;
END; $$;
REVOKE ALL ON FUNCTION app.access_configuration_transition_preview(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.access_configuration_transition_preview(uuid,text,jsonb) TO ai_hr_app;

--> statement-breakpoint
-- Exact native Workforce screen. Dormant registrations do not activate incomplete submenu coverage.
-- Independent employee/assigned services retain their own final effect owners.
CREATE FUNCTION app.workforce_function_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cap ~ '^function\.workforceRecords\.(view|add|edit|delete)$'
 AND EXISTS(SELECT 1 FROM public.app_user actor JOIN public.role_assignment r ON r.tenant_id=actor.tenant_id AND r.app_user_id=actor.id
  WHERE actor.tenant_id=t AND actor.id=u AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id)
   AND r.role::text IN ('hr_admin','super_admin') AND CASE WHEN co IS NULL THEN r.company_id IS NULL ELSE app.access_scope_covers(r.company_id,co,t) END);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.workforce_function_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.workforce_function_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current()
 AND app.workforce_function_legacy_allowed(t,u,cap,co)
 AND CASE WHEN co IS NULL THEN EXISTS(SELECT 1 FROM app.current_grants() g WHERE g.role IN ('hr_admin','super_admin') AND g.company_id IS NULL)
  ELSE app.is_admin_for(co) END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.workforce_function_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.workforce_function_delegation_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current()
 AND CASE WHEN cap='workforce.view' THEN true
  WHEN cap IN ('workforce.add','workforce.edit','workforce.delete') THEN
   CASE WHEN co IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(co) END ELSE false END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.workforce_function_delegation_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE operation text;BEGIN
 FOREACH operation IN ARRAY ARRAY['view','add','edit','delete'] LOOP
  PERFORM app.register_function_action('workforceRecords',operation,'company','workforce.'||operation,'app.workforce_function_delegation_allowed',
   '{"moduleKey":"workforce","labelKey":"accessConfiguration.capabilities.workforceView","kind":"screen","course":"administrative","screenKey":"workforceRecords","href":"/admin/personnel","employeeBearing":true}'::jsonb);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_projection_company(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.function_action_allowed('workforceRecords','view',p_company) AND EXISTS(
  SELECT 1 FROM public.company co JOIN public.app_user u ON u.tenant_id=co.tenant_id
  JOIN public.access_capability c ON c.id='workforce.view'
  WHERE co.id=p_company AND co.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND CASE WHEN c.supported THEN app.access_allowed_for(u.id,c.id,co.id)
    ELSE app.access_workforce_company(co.id,c.id) END);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_action_company(p_company uuid,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_action IN ('add','edit','delete') AND (app.access_workforce_owner_company(p_company) OR
 app.function_action_allowed('workforceRecords',p_action,p_company) AND
 CASE WHEN EXISTS(SELECT 1 FROM public.access_capability c WHERE c.id='workforce.'||p_action AND c.supported)
 THEN app.principal_snapshot_current() AND app.access_workforce_projection_company(p_company)
  AND app.access_allowed_for(app.current_user_id(),'workforce.'||p_action,p_company)
 ELSE app.access_workforce_legacy_command_company(p_company) END);
$$;

--> statement-breakpoint
-- Private final-effect control ceiling. This is NOT positive authorization and cannot authorize a
-- regular write/delegation. A module must seal actual positive admission and exact native effects first.
CREATE FUNCTION app.access_capability_denial_clear(p_capability text,p_company uuid,p_seen text[],p_enforce boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.access_capability%ROWTYPE;required jsonb;parent public.access_capability%ROWTYPE;view_id text;
BEGIN
 IF p_capability IS NULL OR p_capability=ANY(p_seen) OR cardinality(p_seen)>1000 THEN RETURN false;END IF;
 SELECT c.* INTO selected FROM public.access_capability c WHERE c.id=p_capability;
 IF NOT FOUND OR jsonb_typeof(selected.prerequisites)<>'array' OR jsonb_typeof(selected.bindings)<>'array'
  OR selected.scope='tenant' AND p_company IS NOT NULL OR selected.scope='company' AND (p_company IS NULL OR NOT EXISTS(SELECT 1 FROM public.company co WHERE co.id=p_company AND co.tenant_id=app.current_tenant_id())) THEN RETURN false;END IF;
 IF selected.supported THEN
  IF jsonb_array_length(selected.bindings)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(selected.bindings) binding WHERE jsonb_typeof(binding)<>'object' OR jsonb_typeof(binding->'owner') IS DISTINCT FROM 'string' OR jsonb_typeof(binding->'operation') IS DISTINCT FROM 'string' OR coalesce(binding->>'owner','')='' OR coalesce(binding->>'operation','')='') THEN RETURN false;END IF;
  IF p_enforce AND (NOT EXISTS(SELECT 1 FROM public.access_configuration configuration WHERE configuration.tenant_id=app.current_tenant_id() AND configuration.initialized)
   OR EXISTS(SELECT 1 FROM public.access_user_override denial WHERE denial.tenant_id=app.current_tenant_id() AND denial.user_id=app.current_user_id() AND denial.retired_at IS NULL AND denial.effect='deny' AND (denial.capability_id=p_capability OR p_capability IN ('workforce.add','workforce.edit','workforce.delete') AND denial.capability_id='workforce.maintain') AND app.access_scope_covers(denial.company_id,p_company,denial.tenant_id))) THEN RETURN false;END IF;
 ELSIF jsonb_array_length(selected.bindings)<>0 THEN RETURN false;END IF;
 p_seen:=p_seen||p_capability;
 FOR required IN SELECT value FROM jsonb_array_elements(selected.prerequisites) LOOP
  IF jsonb_typeof(required)<>'string' THEN RETURN false;END IF;
  SELECT c.* INTO parent FROM public.access_capability c WHERE c.id=required#>>'{}';
  IF NOT FOUND OR selected.scope='tenant' AND parent.scope<>'tenant'
   OR p_enforce AND selected.supported AND NOT parent.supported
   OR NOT app.access_capability_denial_clear(parent.id,CASE WHEN parent.scope='tenant' THEN NULL ELSE p_company END,p_seen,p_enforce AND selected.supported) THEN RETURN false;END IF;
 END LOOP;
 IF p_capability ~ '^.+\.(add|edit|delete|approve|issue|execute)$' THEN
  view_id:=regexp_replace(p_capability,'[^.]+$','view');
  SELECT c.* INTO parent FROM public.access_capability c WHERE c.id=view_id;
  IF NOT FOUND OR selected.scope<>parent.scope OR p_enforce AND selected.supported AND NOT parent.supported
   OR NOT app.access_capability_denial_clear(view_id,p_company,p_seen,p_enforce AND selected.supported) THEN RETURN false;END IF;
 END IF;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION app.access_capability_denial_clear(text,uuid,text[],boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.function_action_denial_clear(p_key text,p_operation text,p_company uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.app_user actor WHERE actor.id=app.current_user_id() AND actor.tenant_id=app.current_tenant_id() AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id))
 AND coalesce((SELECT definition.scope=capability.scope AND action.capability_id='function.'||p_key||'.'||p_operation
  AND definition.metadata->>'kind' IN ('screen','submenu','native_acl') AND definition.metadata->>'course' IN ('administrative','own','assigned')
  AND coalesce(definition.metadata->>'moduleKey','')<>'' AND coalesce(definition.metadata->>'labelKey','')<>''
  AND app.access_capability_denial_clear(action.capability_id,p_company,ARRAY[]::text[],true)
  FROM app.access_function_action action JOIN app.access_function_definition definition USING(function_key)
  JOIN public.access_capability capability ON capability.id=action.capability_id WHERE action.function_key=p_key AND action.operation=p_operation),false);
$$;
REVOKE ALL ON FUNCTION app.function_action_denial_clear(text,text,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Unlike broad employee-data read generations this epoch changes only on authority/control facts.
-- Actual mutate→restore statements remain visible to terminal-effect admission stamps in the same TX.
CREATE TABLE app.access_control_epoch(tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,epoch bigint NOT NULL DEFAULT 1);
ALTER TABLE app.access_control_epoch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.access_control_epoch FROM PUBLIC,ai_hr_app;
INSERT INTO app.access_control_epoch(tenant_id) SELECT id FROM public.tenant;
--> statement-breakpoint
CREATE FUNCTION app.access_control_epoch_bump() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE affected uuid;query text;has_rows boolean;
BEGIN
 IF TG_ARGV[0]='global' THEN
  IF TG_OP='INSERT' THEN EXECUTE 'SELECT EXISTS(SELECT 1 FROM new_rows)' INTO has_rows;
  ELSIF TG_OP='DELETE' THEN EXECUTE 'SELECT EXISTS(SELECT 1 FROM old_rows)' INTO has_rows;
  ELSE EXECUTE 'SELECT EXISTS(SELECT 1 FROM old_rows UNION ALL SELECT 1 FROM new_rows)' INTO has_rows;END IF;
  IF has_rows THEN UPDATE app.access_control_epoch SET epoch=epoch+1;END IF;RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='tenant' THEN
  INSERT INTO app.access_control_epoch(tenant_id) SELECT id FROM new_rows ON CONFLICT DO NOTHING;RETURN NULL;
 END IF;
 query:=CASE TG_OP WHEN 'INSERT' THEN 'SELECT DISTINCT tenant_id FROM new_rows' WHEN 'DELETE' THEN 'SELECT DISTINCT tenant_id FROM old_rows' ELSE 'SELECT tenant_id FROM old_rows UNION SELECT tenant_id FROM new_rows' END;
 FOR affected IN EXECUTE query LOOP
  INSERT INTO app.access_control_epoch AS current_epoch(tenant_id,epoch) SELECT affected,1 WHERE EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=affected)
  ON CONFLICT(tenant_id) DO UPDATE SET epoch=current_epoch.epoch+1;
 END LOOP;RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION app.access_control_epoch_bump() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_control_epoch_tenant AFTER INSERT ON public.tenant REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.access_control_epoch_bump('tenant');
DO $$ DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['app_user','role_assignment','access_configuration','access_group','access_group_grant','access_membership','access_user_override','data_permission_profile','data_permission_revision','user_data_permission_assignment'] LOOP
  EXECUTE format('CREATE TRIGGER access_control_epoch_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.access_control_epoch_bump(''tenant'')',relation_name);
  EXECUTE format('CREATE TRIGGER access_control_epoch_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.access_control_epoch_bump(''tenant'')',relation_name);
  EXECUTE format('CREATE TRIGGER access_control_epoch_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.access_control_epoch_bump(''tenant'')',relation_name);
 END LOOP;
END $$;
--> statement-breakpoint
DO $$ DECLARE relation_name text;schema_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['access_capability','access_function_definition','access_function_action','access_native_capability_default','access_default_capability_grant'] LOOP
  schema_name:=CASE WHEN relation_name='access_capability' THEN 'public' ELSE 'app' END;
  EXECUTE format('CREATE TRIGGER access_control_epoch_insert AFTER INSERT ON %I.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.access_control_epoch_bump(''global'')',schema_name,relation_name);
  EXECUTE format('CREATE TRIGGER access_control_epoch_update AFTER UPDATE ON %I.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.access_control_epoch_bump(''global'')',schema_name,relation_name);
  EXECUTE format('CREATE TRIGGER access_control_epoch_delete AFTER DELETE ON %I.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.access_control_epoch_bump(''global'')',schema_name,relation_name);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.access_function_authority_stamp() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.principal_snapshot_current() THEN encode(sha256(convert_to(jsonb_build_object(
  'tenant',epoch.tenant_id,'user',app.current_user_id(),'epoch',epoch.epoch,'date',current_date,
  'claimedRoles',current_setting('app.roles',true),'claimedGrants',(SELECT coalesce(jsonb_agg(jsonb_build_array(g.role,g.company_id) ORDER BY g.role,g.company_id),'[]'::jsonb) FROM app.current_grants() g),
  'configuration',(SELECT jsonb_build_array(configuration.revision,configuration.initialized) FROM public.access_configuration configuration WHERE configuration.tenant_id=epoch.tenant_id)
 )::text,'UTF8')),'hex') ELSE NULL END FROM app.access_control_epoch epoch WHERE epoch.tenant_id=app.current_tenant_id();
$$;
REVOKE ALL ON FUNCTION app.access_function_authority_stamp() FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- One prospective draft subject owner, also consumed by Onboarding. Missing schema attributes stay
-- NULL; there is no invented employment status/category or numeric/default sentinel allowance.
CREATE FUNCTION app.data_permission_draft_text(p_row jsonb,p_path text[]) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN jsonb_typeof(p_row#>p_path)='string' THEN nullif(p_row#>>p_path,'') ELSE NULL END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_draft_text(jsonb,text[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_draft_subject(t uuid,p_row jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_row)='object' AND p_row->>'tenant_id'=t::text THEN jsonb_build_object(
  'tenant',t::text,'company',(SELECT c.id::text FROM public.company c WHERE c.tenant_id=t AND c.id::text=p_row->>'company_id'),
  'businessUnit',(SELECT d.business_unit_id::text FROM public.department d WHERE d.tenant_id=t AND d.archived_at IS NULL AND d.id::text=app.data_permission_draft_text(p_row,ARRAY['data','employment','departmentId'])),
  'division',NULL,'branch',NULL,
  'department',(SELECT d.id::text FROM public.department d WHERE d.tenant_id=t AND d.archived_at IS NULL AND d.id::text=app.data_permission_draft_text(p_row,ARRAY['data','employment','departmentId'])),
  'section',NULL,'team',NULL,
  'position',(SELECT p.id::text FROM public.position p WHERE p.tenant_id=t AND p.archived_at IS NULL AND p.id::text=app.data_permission_draft_text(p_row,ARRAY['data','employment','positionId'])),
  'grade',(SELECT g.id::text FROM public.job_grade g WHERE g.tenant_id=t AND g.archived_at IS NULL AND g.id::text=app.data_permission_draft_text(p_row,ARRAY['data','employment','gradeId'])),
  'employmentType',(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid='public.employment_type'::regtype AND e.enumlabel=app.data_permission_draft_text(p_row,ARRAY['data','employment','employmentType'])),
  'employmentStatus',NULL,
  'costCentre',(SELECT c.id::text FROM public.cost_center c WHERE c.tenant_id=t AND c.archived_at IS NULL AND c.id::text=app.data_permission_draft_text(p_row,ARRAY['data','employment','costCenterId'])),
  'nationality',app.data_permission_draft_text(p_row,ARRAY['data','profile','nationality']),
  'gender',app.data_permission_draft_text(p_row,ARRAY['data','profile','gender']),
  'maritalStatus',app.data_permission_draft_text(p_row,ARRAY['data','profile','maritalStatus']),
  'category',NULL,'employeeId',coalesce(app.data_permission_draft_text(p_row,ARRAY['reserved_employee_code']),app.data_permission_draft_text(p_row,ARRAY['data','profile','employeeCode']))
 ) ELSE NULL END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_draft_subject(uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_draft_matches(t uuid,u uuid,p_row jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE profile public.data_permission_profile%ROWTYPE;rules jsonb;
BEGIN
 IF jsonb_typeof(p_row)<>'object' OR p_row->>'tenant_id' IS DISTINCT FROM t::text OR NOT EXISTS(SELECT 1 FROM public.app_user actor WHERE actor.id=u AND actor.tenant_id=t AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id)) THEN RETURN false;END IF;
 SELECT p.* INTO profile FROM public.user_data_permission_assignment assignment LEFT JOIN public.data_permission_profile p ON p.tenant_id=assignment.tenant_id AND p.id=assignment.profile_id WHERE assignment.tenant_id=t AND assignment.user_id=u;
 IF NOT FOUND THEN RETURN true;END IF; -- Additional data ceiling only; caller retains its actual native source/company course.
 IF profile.id IS NULL OR NOT profile.enabled OR profile.retired_at IS NOT NULL OR profile.active_revision_id IS NULL THEN RETURN false;END IF;
 SELECT r.rules INTO rules FROM public.data_permission_revision r WHERE r.id=profile.active_revision_id AND r.tenant_id=profile.tenant_id AND r.profile_id=profile.id;
 RETURN app.data_permission_rules_match(rules,app.data_permission_draft_subject(t,p_row));
END; $$;
REVOKE ALL ON FUNCTION app.data_permission_draft_matches(uuid,uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_draft_read(p_draft uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employee_draft source WHERE source.id=p_draft AND source.tenant_id=app.current_tenant_id()
  AND app.access_workforce_draft(source.company_id,source.created_by_person_id,'read') AND app.data_permission_draft_matches(source.tenant_id,app.current_user_id(),to_jsonb(source)));
$$;
REVOKE ALL ON FUNCTION app.data_permission_draft_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.data_permission_draft_read(uuid) TO ai_hr_app;
CREATE POLICY data_permission_draft_read ON public.employee_draft AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.data_permission_draft_read(id));

--> statement-breakpoint
CREATE TABLE app.workforce_draft_mutation(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,draft_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('add','edit','delete')),before_hash text NOT NULL,after_hash text NOT NULL,before_source jsonb NOT NULL,after_source jsonb NOT NULL,authority_stamp text NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,draft_id,before_hash,after_hash));
REVOKE ALL ON app.workforce_draft_mutation FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.workforce_draft_mutation_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 proposed jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 authority text;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 authority:=app.access_function_authority_stamp();IF authority IS NULL THEN RAISE EXCEPTION 'Draft source authority unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM app.workforce_draft_mutation WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.workforce_draft_mutation VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),coalesce(NEW.id,OLD.id),CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'DELETE' THEN 'delete' ELSE 'edit' END,
  encode(sha256(convert_to(prior::text,'UTF8')),'hex'),encode(sha256(convert_to(proposed::text,'UTF8')),'hex'),prior,proposed,authority) ON CONFLICT DO NOTHING;
 RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION app.workforce_draft_mutation_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER workforce_draft_mutation AFTER INSERT OR UPDATE OR DELETE ON public.employee_draft FOR EACH ROW EXECUTE FUNCTION app.workforce_draft_mutation_record();
--> statement-breakpoint
CREATE TABLE app.workforce_draft_audit(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,draft_id uuid NOT NULL,event_id uuid NOT NULL,event_type text NOT NULL,PRIMARY KEY(xact_id,tenant_id,event_id));
REVOKE ALL ON app.workforce_draft_audit FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.workforce_draft_audit_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.aggregate_type='employee-draft' AND NEW.event_type IN ('employee-draft.created','employee-draft.updated','employee-draft.discarded','employee-draft.completed') AND NEW.actor_type='user' AND NEW.actor_id=app.current_user_id() AND NEW.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() THEN
  DELETE FROM app.workforce_draft_audit WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
  INSERT INTO app.workforce_draft_audit VALUES(pg_current_xact_id(),NEW.tenant_id,NEW.actor_id,NEW.aggregate_id,NEW.id,NEW.event_type);
 END IF;RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION app.workforce_draft_audit_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER workforce_draft_audit AFTER INSERT ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app.workforce_draft_audit_record();
--> statement-breakpoint
CREATE FUNCTION app.workforce_draft_saved_source_allowed(p_draft uuid,p_source jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND p_source->>'id'=p_draft::text AND p_source->>'tenant_id'=app.current_tenant_id()::text
 AND app.data_permission_draft_matches(app.current_tenant_id(),app.current_user_id(),p_source)
 AND EXISTS(SELECT 1 FROM app.workforce_draft_mutation proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.draft_id=p_draft AND proof.operation IN ('add','edit')
  AND proof.after_hash=encode(sha256(convert_to(p_source::text,'UTF8')),'hex') AND proof.authority_stamp=app.access_function_authority_stamp()
  AND (proof.before_source='{}'::jsonb OR app.data_permission_draft_matches(proof.tenant_id,proof.user_id,proof.before_source))
  AND EXISTS(SELECT 1 FROM public.employee_draft actual WHERE actual.tenant_id=proof.tenant_id AND actual.id=proof.draft_id AND to_jsonb(actual)=p_source)
  AND EXISTS(SELECT 1 FROM app.workforce_draft_audit audit WHERE audit.xact_id=proof.xact_id AND audit.tenant_id=proof.tenant_id AND audit.user_id=proof.user_id AND audit.draft_id=proof.draft_id AND audit.event_type IN ('employee-draft.created','employee-draft.updated')));
$$;
REVOKE ALL ON FUNCTION app.workforce_draft_saved_source_allowed(uuid,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Finite derived Onboarding source proof. This does not admit general Personnel writes.
CREATE FUNCTION app.workforce_draft_active_admitted(p_draft uuid,p_source jsonb,p_employment uuid,p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.data_permission_draft_matches(app.current_tenant_id(),app.current_user_id(),p_source)
 AND app.access_workforce_consumed_draft(p_source)
 AND EXISTS(SELECT 1 FROM app.workforce_hire_source proof JOIN public.employment employment ON employment.id=proof.employment_id AND employment.tenant_id=proof.tenant_id
  WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.draft_id=p_draft
   AND proof.source=p_source AND proof.employment_id=p_employment AND employment.person_id=p_person AND proof.authority_stamp=app.access_function_authority_stamp())
 AND EXISTS(SELECT 1 FROM public.employee_draft actual WHERE actual.tenant_id=app.current_tenant_id() AND actual.id=p_draft AND to_jsonb(actual)=p_source);
$$;
REVOKE ALL ON FUNCTION app.workforce_draft_active_admitted(uuid,jsonb,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.workforce_draft_active_completed(p_draft uuid,p_source jsonb,p_employment uuid,p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.data_permission_draft_matches(app.current_tenant_id(),app.current_user_id(),p_source)
 AND app.access_workforce_consumed_draft(p_source)
 AND EXISTS(SELECT 1 FROM app.workforce_hire_source proof JOIN public.employment employment ON employment.id=proof.employment_id AND employment.tenant_id=proof.tenant_id
  WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.draft_id=p_draft
   AND proof.source=p_source AND proof.employment_id=p_employment AND employment.person_id=p_person AND proof.consumed AND proof.authority_stamp=app.access_function_authority_stamp())
 AND EXISTS(SELECT 1 FROM app.workforce_draft_mutation mutation WHERE mutation.xact_id=pg_current_xact_id() AND mutation.tenant_id=app.current_tenant_id() AND mutation.user_id=app.current_user_id() AND mutation.draft_id=p_draft AND mutation.operation='delete' AND mutation.before_source=p_source AND mutation.authority_stamp=app.access_function_authority_stamp())
 AND NOT EXISTS(SELECT 1 FROM public.employee_draft actual WHERE actual.tenant_id=app.current_tenant_id() AND actual.id=p_draft)
 AND EXISTS(SELECT 1 FROM app.workforce_draft_audit audit JOIN public.domain_event event ON event.id=audit.event_id AND event.tenant_id=audit.tenant_id WHERE audit.xact_id=pg_current_xact_id() AND audit.tenant_id=app.current_tenant_id() AND audit.user_id=app.current_user_id() AND audit.draft_id=p_draft AND audit.event_type='employee-draft.completed' AND event.subject_employment_id=p_employment AND event.payload->>'employmentId'=p_employment::text AND event.payload->>'companyId'=p_source->>'company_id');
$$;
REVOKE ALL ON FUNCTION app.workforce_draft_active_completed(uuid,jsonb,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.workforce_draft_discard_source(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,draft_id uuid NOT NULL,source jsonb NOT NULL,authority_stamp text NOT NULL,UNIQUE(xact_id,tenant_id,user_id,draft_id));
CREATE TABLE app.workforce_draft_discard_port(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,draft_id uuid NOT NULL,source jsonb NOT NULL,PRIMARY KEY(xact_id,tenant_id,user_id,draft_id));
REVOKE ALL ON app.workforce_draft_discard_source,app.workforce_draft_discard_port FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.workforce_draft_discard_begin(p_draft uuid,p_source jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actual public.employee_draft%ROWTYPE;result uuid;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO actual FROM public.employee_draft WHERE id=p_draft AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR to_jsonb(actual) IS DISTINCT FROM p_source OR NOT app.access_workforce_draft_delete_allowed(p_draft) OR NOT app.data_permission_draft_matches(actual.tenant_id,app.current_user_id(),p_source) OR app.access_function_authority_stamp() IS NULL THEN RAISE EXCEPTION 'Draft discard source unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM app.workforce_draft_discard_source WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.workforce_draft_discard_source(xact_id,tenant_id,user_id,draft_id,source,authority_stamp) VALUES(pg_current_xact_id(),actual.tenant_id,app.current_user_id(),actual.id,p_source,app.access_function_authority_stamp()) ON CONFLICT(xact_id,tenant_id,user_id,draft_id) DO NOTHING RETURNING id INTO result;
 IF result IS NULL THEN SELECT id INTO result FROM app.workforce_draft_discard_source WHERE xact_id=pg_current_xact_id() AND tenant_id=actual.tenant_id AND user_id=app.current_user_id() AND draft_id=actual.id AND source=p_source AND authority_stamp=app.access_function_authority_stamp();END IF;
 IF result IS NULL THEN RAISE EXCEPTION 'Draft discard source changed' USING ERRCODE='42501';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.workforce_draft_discard_begin(uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Only the closed native port's actual DELETE trigger may record this receipt. The outer trigger
-- is INVOKER so it observes the real port current_user before entering the private recorder.
CREATE FUNCTION app.workforce_draft_discard_port_record(p_source jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_source->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Draft discard port source unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM app.workforce_draft_discard_port WHERE xact_id<pg_snapshot_xmin(pg_current_snapshot());
 INSERT INTO app.workforce_draft_discard_port VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),(p_source->>'id')::uuid,p_source);
END $$;
REVOKE ALL ON FUNCTION app.workforce_draft_discard_port_record(jsonb) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.workforce_draft_discard_port_record(jsonb) TO ai_hr_draft_discard_port;
--> statement-breakpoint
CREATE FUNCTION app.workforce_draft_discard_port_needed(p_draft uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.workforce_draft_discard_source proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.draft_id=p_draft);
$$;
REVOKE ALL ON FUNCTION app.workforce_draft_discard_port_needed(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.workforce_draft_discard_port_needed(uuid) TO ai_hr_draft_discard_port;
--> statement-breakpoint
CREATE FUNCTION app.workforce_draft_discard_port_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_user='ai_hr_draft_discard_port' THEN
  IF app.workforce_draft_discard_port_needed(OLD.id) THEN PERFORM app.workforce_draft_discard_port_record(to_jsonb(OLD));END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.workforce_draft_discard_port_trigger() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER workforce_draft_discard_port AFTER DELETE ON public.employee_draft FOR EACH ROW EXECUTE FUNCTION app.workforce_draft_discard_port_trigger();
--> statement-breakpoint
CREATE FUNCTION app.workforce_draft_discard_completed(p_intent uuid,p_draft uuid,p_source jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.data_permission_draft_matches(app.current_tenant_id(),app.current_user_id(),p_source)
 AND EXISTS(SELECT 1 FROM app.workforce_draft_discard_source proof WHERE proof.id=p_intent AND proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id() AND proof.draft_id=p_draft AND proof.source=p_source AND proof.authority_stamp=app.access_function_authority_stamp())
 AND EXISTS(SELECT 1 FROM app.workforce_draft_discard_port port WHERE port.xact_id=pg_current_xact_id() AND port.tenant_id=app.current_tenant_id() AND port.user_id=app.current_user_id() AND port.draft_id=p_draft AND port.source=p_source)
 AND EXISTS(SELECT 1 FROM app.workforce_draft_mutation mutation WHERE mutation.xact_id=pg_current_xact_id() AND mutation.tenant_id=app.current_tenant_id() AND mutation.user_id=app.current_user_id() AND mutation.draft_id=p_draft AND mutation.operation='delete' AND mutation.before_source=p_source AND mutation.authority_stamp=app.access_function_authority_stamp())
 AND NOT EXISTS(SELECT 1 FROM public.employee_draft actual WHERE actual.tenant_id=app.current_tenant_id() AND actual.id=p_draft)
 AND EXISTS(SELECT 1 FROM app.workforce_draft_audit audit WHERE audit.xact_id=pg_current_xact_id() AND audit.tenant_id=app.current_tenant_id() AND audit.user_id=app.current_user_id() AND audit.draft_id=p_draft AND audit.event_type='employee-draft.discarded');
$$;
REVOKE ALL ON FUNCTION app.workforce_draft_discard_completed(uuid,uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.workforce_draft_discard_complete_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.workforce_draft_discard_completed(NEW.id,NEW.draft_id,NEW.source) THEN RAISE EXCEPTION 'Draft discard source effects incomplete' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.workforce_draft_discard_complete_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER workforce_draft_discard_complete AFTER INSERT ON app.workforce_draft_discard_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.workforce_draft_discard_complete_guard();
