-- SOURCE DRAFT: not journalled/applied. Centrally reserved after Board1 0576/0577 and ESS 0578.
-- Storage is private to the canonical owner. No direct runtime writes, operator grants or RLS bypass.
CREATE TABLE access_capability (
 id text PRIMARY KEY,
 scope text NOT NULL CHECK(scope IN ('tenant','company')),
 supported boolean NOT NULL DEFAULT false,
 bindings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(bindings)='array' AND jsonb_array_length(bindings)<=128),
 CHECK(id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,5}$')
);
--> statement-breakpoint
CREATE TABLE access_configuration (
 tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
 revision uuid NOT NULL DEFAULT gen_random_uuid(),
 initialized boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE access_group (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100 AND name=btrim(name)),
 legacy_key text CHECK(legacy_key IN ('system_administrator','hr_admin','manager','employee','payroll_partner','performance_comp_partner')),
 system_administrator boolean NOT NULL DEFAULT false,
 retired_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT access_group_tenant_id_uq UNIQUE(tenant_id,id),
 CHECK(NOT system_administrator OR retired_at IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX access_group_name_uq ON access_group(tenant_id,lower(name));
--> statement-breakpoint
CREATE UNIQUE INDEX access_group_protected_uq ON access_group(tenant_id) WHERE system_administrator;
--> statement-breakpoint
CREATE UNIQUE INDEX access_group_legacy_uq ON access_group(tenant_id,legacy_key) WHERE legacy_key IS NOT NULL;
--> statement-breakpoint
CREATE TABLE access_group_grant (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 group_id uuid NOT NULL,
 capability_id text NOT NULL REFERENCES access_capability(id),
 company_id uuid REFERENCES company(id),
 retired_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,group_id) REFERENCES access_group(tenant_id,id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX access_group_grant_global_uq ON access_group_grant(tenant_id,group_id,capability_id) WHERE company_id IS NULL AND retired_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX access_group_grant_company_uq ON access_group_grant(tenant_id,group_id,capability_id,company_id) WHERE company_id IS NOT NULL AND retired_at IS NULL;
--> statement-breakpoint
CREATE TABLE access_membership (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 group_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES app_user(id),
 company_id uuid REFERENCES company(id),
 retired_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,group_id) REFERENCES access_group(tenant_id,id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX access_membership_global_uq ON access_membership(tenant_id,group_id,user_id) WHERE company_id IS NULL AND retired_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX access_membership_company_uq ON access_membership(tenant_id,group_id,user_id,company_id) WHERE company_id IS NOT NULL AND retired_at IS NULL;
--> statement-breakpoint
CREATE INDEX access_membership_user_idx ON access_membership(tenant_id,user_id) WHERE retired_at IS NULL;
--> statement-breakpoint
CREATE TABLE access_user_override (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 user_id uuid NOT NULL REFERENCES app_user(id),
 capability_id text NOT NULL REFERENCES access_capability(id),
 company_id uuid REFERENCES company(id),
 effect text NOT NULL CHECK(effect IN ('allow','deny')),
 retired_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX access_user_override_global_uq ON access_user_override(tenant_id,user_id,capability_id) WHERE company_id IS NULL AND retired_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX access_user_override_company_uq ON access_user_override(tenant_id,user_id,capability_id,company_id) WHERE company_id IS NOT NULL AND retired_at IS NULL;
--> statement-breakpoint
CREATE INDEX access_user_override_user_idx ON access_user_override(tenant_id,user_id) WHERE retired_at IS NULL;
--> statement-breakpoint
-- The caller's GUC cannot forge schema-owner membership. Actual owner differs in dev/rehearsal/prod.
ALTER TABLE access_capability ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE access_capability FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY access_capability_owner ON access_capability FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
ALTER TABLE access_configuration ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE access_configuration FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY access_configuration_owner ON access_configuration FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
ALTER TABLE access_group ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE access_group FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY access_group_owner ON access_group FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
ALTER TABLE access_group_grant ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE access_group_grant FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY access_group_grant_owner ON access_group_grant FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
ALTER TABLE access_membership ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE access_membership FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY access_membership_owner ON access_membership FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
ALTER TABLE access_user_override ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE access_user_override FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY access_user_override_owner ON access_user_override FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON access_capability,access_configuration,access_group,access_group_grant,access_membership,access_user_override FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Composite tenant/group FKs protect groups. Existing company/user tables lack composite tenant keys;
-- enforce tenant references independently of the service before any row may enter the private store.
CREATE FUNCTION app.access_validate_reference() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=NEW.company_id AND c.tenant_id=NEW.tenant_id) THEN
  RAISE EXCEPTION 'access reference outside tenant' USING ERRCODE='23503';
 END IF;
 IF TG_TABLE_NAME IN ('access_membership','access_user_override') AND NOT EXISTS(
  SELECT 1 FROM public.app_user u WHERE u.id=(to_jsonb(NEW)->>'user_id')::uuid AND u.tenant_id=NEW.tenant_id
 ) THEN RAISE EXCEPTION 'access reference outside tenant' USING ERRCODE='23503'; END IF;
 IF TG_TABLE_NAME IN ('access_group_grant','access_user_override') AND EXISTS(
  SELECT 1 FROM public.access_capability c WHERE c.id=to_jsonb(NEW)->>'capability_id' AND c.scope='tenant' AND NEW.company_id IS NOT NULL
 ) THEN RAISE EXCEPTION 'tenant permission requires tenant scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_validate_reference() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_group_grant_reference BEFORE INSERT OR UPDATE ON access_group_grant FOR EACH ROW EXECUTE FUNCTION app.access_validate_reference();
--> statement-breakpoint
CREATE TRIGGER access_membership_reference BEFORE INSERT OR UPDATE ON access_membership FOR EACH ROW EXECUTE FUNCTION app.access_validate_reference();
--> statement-breakpoint
CREATE TRIGGER access_user_override_reference BEFORE INSERT OR UPDATE ON access_user_override FOR EACH ROW EXECUTE FUNCTION app.access_validate_reference();
--> statement-breakpoint
-- Role assignments remain their actual owner. A view derives default-group membership rather than
-- copying it into another mutable table; role revocation therefore disappears on the very next read.
-- Installation operators are deliberately absent. Custom memberships remain separately configurable.
CREATE VIEW access_effective_membership AS
 SELECT m.tenant_id,m.group_id,m.user_id,m.company_id,false AS derived FROM access_membership m WHERE m.retired_at IS NULL
 UNION
 SELECT r.tenant_id,g.id,r.app_user_id,CASE WHEN g.legacy_key='system_administrator' THEN NULL::uuid ELSE r.company_id END,true
 FROM role_assignment r JOIN access_group g ON g.tenant_id=r.tenant_id AND g.retired_at IS NULL
  AND (g.legacy_key=r.role::text OR (g.legacy_key='system_administrator' AND (r.role::text='super_admin' OR (r.role::text='hr_admin' AND r.company_id IS NULL))));
--> statement-breakpoint
REVOKE ALL ON access_effective_membership FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- One existing company-tree owner. Both endpoints are tenant-local, even in a definer function.
CREATE FUNCTION app.access_scope_covers(p_scope uuid,p_target uuid,p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (p_scope IS NULL OR EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_scope AND c.tenant_id=p_tenant))
 AND CASE WHEN p_target IS NULL THEN p_scope IS NULL ELSE
  EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_target AND c.tenant_id=p_tenant)
  AND (p_scope IS NULL OR p_scope=p_target OR app.is_company_descendant(p_target,p_scope)) END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_scope_covers(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_allowed_for(p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.app_user u JOIN public.access_configuration s ON s.tenant_id=u.tenant_id
  JOIN public.access_capability c ON c.id=p_capability
  WHERE u.id=p_user AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL
   AND NOT app.login_blocked(u.id) AND s.initialized AND c.supported AND jsonb_array_length(c.bindings)>0
   AND ((c.scope='tenant' AND p_company IS NULL) OR (c.scope='company' AND p_company IS NOT NULL))
   AND NOT EXISTS(SELECT 1 FROM public.access_user_override o
    WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.capability_id=c.id AND o.effect='deny' AND o.retired_at IS NULL
     AND app.access_scope_covers(o.company_id,p_company,u.tenant_id))
   AND (
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
REVOKE ALL ON FUNCTION app.access_allowed_for(uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Runtime may ask only for its actual principal. No user-id parameter or client role-list fallback.
CREATE FUNCTION app.access_capability_allowed(p_capability text,p_company uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_allowed_for(app.current_user_id(),p_capability,p_company);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_capability_allowed(text,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_capability_allowed(text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- A subtree grant must not cross a denied descendant. Enumerating current companies is insufficient
-- for all-company delegation because that scope includes companies created in the future too.
CREATE FUNCTION app.access_can_delegate(p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.access_capability c
  JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
  WHERE c.id=p_capability AND c.supported AND jsonb_array_length(c.bindings)>0
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
REVOKE ALL ON FUNCTION app.access_can_delegate(text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_assert_administrator() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.access_configuration s WHERE s.tenant_id=app.current_tenant_id() AND s.initialized)
 AND NOT EXISTS(SELECT 1 FROM public.access_group g JOIN public.access_effective_membership m ON m.group_id=g.id AND m.tenant_id=g.tenant_id
  WHERE g.tenant_id=app.current_tenant_id() AND g.system_administrator AND g.retired_at IS NULL
   AND m.company_id IS NULL
   AND app.access_allowed_for(m.user_id,'access.system_admin',NULL)
   AND app.access_allowed_for(m.user_id,'access.configure',NULL)) THEN
  RAISE EXCEPTION 'access last administrator' USING ERRCODE='23514';
 END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_assert_administrator() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Only implemented bindings may be marked supported. The remaining entries stay unavailable until
-- their page, action, read/export and SQL consumers are completed and verified in this source round.
INSERT INTO access_capability(id,scope,supported,bindings) VALUES
 ('access.system_admin','tenant',true,'[{"owner":"app.access_assert_administrator","operation":"recovery-invariant"}]'),
 ('access.configure','tenant',true,'[{"owner":"app.access_configuration_state","operation":"read"},{"owner":"app.access_configuration_commit","operation":"write"}]'),
 ('workforce.view','company',false,'[]'),
 ('workforce.maintain','company',false,'[]'),
 ('profile.review','company',false,'[]');
--> statement-breakpoint
CREATE FUNCTION app.access_configuration_initialize() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); u uuid:=app.current_user_id(); root_group uuid; hr_group uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF EXISTS(SELECT 1 FROM public.access_configuration s WHERE s.tenant_id=t AND s.initialized) THEN RETURN false; END IF;
 -- Bootstrap is based on real role rows and current login availability, never GUC role text.
 IF NOT EXISTS(SELECT 1 FROM public.app_user a JOIN public.role_assignment r ON r.app_user_id=a.id AND r.tenant_id=a.tenant_id
  WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)
   AND (r.role::text='super_admin' OR (r.role::text='hr_admin' AND r.company_id IS NULL))) THEN
  RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501';
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
 PERFORM app.access_assert_administrator();
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'access-configuration',t,'access-configuration.initialized','user',u::text,'{"defaultsCreated":true,"legacyRolesChanged":false}'::jsonb);
 RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_configuration_initialize() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_configuration_initialize() TO ai_hr_app;
--> statement-breakpoint
-- Fingerprint inputs include current availability and the actual company tree, so a hierarchy or
-- employment-end change cannot silently reuse a configuration preview on the next transaction.
CREATE FUNCTION app.access_scope_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'date',current_date,
  'users',COALESCE((SELECT jsonb_agg(jsonb_build_array(u.id,u.archived_at,app.login_blocked(u.id)) ORDER BY u.id) FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id()),'[]'::jsonb),
  'companies',COALESCE((SELECT jsonb_agg(jsonb_build_array(c.id,c.parent_company_id) ORDER BY c.id) FROM public.company c WHERE c.tenant_id=app.current_tenant_id()),'[]'::jsonb),
  'roles',COALESCE((SELECT jsonb_agg(jsonb_build_array(r.id,r.app_user_id,r.role,r.company_id) ORDER BY r.id) FROM public.role_assignment r WHERE r.tenant_id=app.current_tenant_id()),'[]'::jsonb)
 )::text,'UTF8')),'hex');
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_scope_fingerprint() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_configuration_state() RETURNS jsonb
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
  'catalog',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'scope',c.scope,'supported',c.supported,'bindings',c.bindings) ORDER BY c.id) FROM public.access_capability c),'[]'::jsonb),
  'companyIds',COALESCE((SELECT jsonb_agg(c.id ORDER BY c.id) FROM public.company c WHERE c.tenant_id=t),'[]'::jsonb),
  'coverage',COALESCE((SELECT jsonb_agg(jsonb_build_object('ancestor',a.id,'company',c.id) ORDER BY a.id,c.id) FROM public.company a JOIN public.company c ON a.tenant_id=c.tenant_id WHERE a.tenant_id=t AND a.id<>c.id AND app.is_company_descendant(c.id,a.id)),'[]'::jsonb),
  'scopeFingerprint',app.access_scope_fingerprint()
 ) INTO result FROM public.access_configuration s WHERE s.tenant_id=t AND s.initialized;
 IF result IS NULL THEN RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501'; END IF;
 RETURN result;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_configuration_state() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_configuration_state() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_command_keys(v jsonb,keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_typeof(v)='object' AND v ?& keys AND (v-keys)='{}'::jsonb;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_command_keys(jsonb,text[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_require_delegate(cap text,scope_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.access_capability c WHERE c.id=cap AND c.supported AND jsonb_array_length(c.bindings)>0) THEN
  RAISE EXCEPTION 'access unsupported' USING ERRCODE='23514';
 END IF;
 IF NOT app.access_can_delegate(cap,scope_id) THEN RAISE EXCEPTION 'access ceiling' USING ERRCODE='42501'; END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_require_delegate(text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- This is the only runtime write seam. It independently validates the command, current authority,
-- grant ceiling, revision, dated scope and final administrator. Direct table writes remain refused.
-- Its bounded audit event is inseparable from the change, including a direct SQL invocation.
CREATE FUNCTION app.access_configuration_commit(expected uuid,expected_scope text,command jsonb,new_revision uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 t uuid:=app.current_tenant_id(); actor uuid:=app.current_user_id(); actual uuid;
 kind text; gid uuid; uid uuid; cid uuid; cap text; mode text; enabled boolean;
 group_row public.access_group%ROWTYPE; grant_row record; entry jsonb; intersection uuid;
 audit jsonb; before_grants jsonb;
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
    IF NOT app.access_command_keys(command,ARRAY['kind','groupId','grants']) OR jsonb_typeof(command->'grants')<>'array' OR jsonb_array_length(command->'grants')>256 THEN
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
 PERFORM app.access_assert_administrator();
 UPDATE public.access_configuration SET revision=new_revision,updated_at=now() WHERE tenant_id=t AND revision=expected;
 IF NOT FOUND THEN RAISE EXCEPTION 'access changed' USING ERRCODE='40001'; END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'access-configuration',t,'access-configuration.changed','user',actor::text,audit);
 RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_configuration_commit(uuid,text,jsonb,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_configuration_commit(uuid,text,jsonb,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Existing identity/role/lifecycle writers join the same tenant lock. Advancing the shared row also
-- causes a stale repeatable-read writer to serialize/refuse instead of relying on an old admin count.
CREATE FUNCTION app.access_lock_legacy_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;
BEGIN
 IF TG_OP='DELETE' THEN t:=OLD.tenant_id; ELSE t:=NEW.tenant_id; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 UPDATE public.access_configuration SET revision=gen_random_uuid(),updated_at=now() WHERE tenant_id=t AND initialized;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_lock_legacy_writer() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_role_authority_lock BEFORE INSERT OR UPDATE OR DELETE ON role_assignment FOR EACH ROW EXECUTE FUNCTION app.access_lock_legacy_writer();
--> statement-breakpoint
CREATE TRIGGER access_user_authority_lock BEFORE INSERT OR DELETE OR UPDATE OF archived_at,person_id ON app_user FOR EACH ROW EXECUTE FUNCTION app.access_lock_legacy_writer();
--> statement-breakpoint
CREATE TRIGGER access_employment_authority_lock BEFORE INSERT OR DELETE OR UPDATE OF person_id,company_id,resignation_date,last_working_date,terminated_on,blacklisted_at ON employment FOR EACH ROW EXECUTE FUNCTION app.access_lock_legacy_writer();
--> statement-breakpoint
CREATE TRIGGER access_company_scope_lock BEFORE INSERT OR DELETE OR UPDATE OF parent_company_id ON company FOR EACH ROW EXECUTE FUNCTION app.access_lock_legacy_writer();
--> statement-breakpoint
CREATE FUNCTION app.access_administrator_constraint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;
BEGIN
 IF TG_OP='DELETE' THEN t:=OLD.tenant_id; ELSE t:=NEW.tenant_id; END IF;
 IF t=app.current_tenant_id() THEN PERFORM app.access_assert_administrator(); END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_administrator_constraint() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Deferred constraints inspect the final transaction, permitting an atomic replacement but never a
-- committed state with zero usable administrators. Owner-side recovery remains an explicit owner act.
CREATE CONSTRAINT TRIGGER access_role_administrator AFTER INSERT OR UPDATE OR DELETE ON role_assignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_administrator_constraint();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER access_user_administrator AFTER INSERT OR UPDATE OR DELETE ON app_user DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_administrator_constraint();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER access_employment_administrator AFTER INSERT OR UPDATE OR DELETE ON employment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_administrator_constraint();
--> statement-breakpoint
CREATE FUNCTION app.access_configuration_denied_for(t uuid,u uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.access_configuration s JOIN public.access_user_override o ON o.tenant_id=s.tenant_id
  WHERE s.tenant_id=t AND s.initialized AND o.user_id=u AND o.capability_id='access.configure'
   AND o.company_id IS NULL AND o.effect='deny' AND o.retired_at IS NULL);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_configuration_denied_for(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_configuration_not_denied() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT app.access_configuration_denied_for(app.current_tenant_id(),app.current_user_id());
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_configuration_not_denied() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_configuration_not_denied() TO ai_hr_app;
--> statement-breakpoint
-- Preserve existing role/scope floors; an explicit configuration denial must also prevent restoring
-- one's authority through the older Users & roles write surface. It never grants a new legacy role.
CREATE POLICY access_role_configuration_denial ON role_assignment AS RESTRICTIVE FOR ALL TO ai_hr_app
 USING(app.access_configuration_not_denied()) WITH CHECK(app.access_configuration_not_denied());
--> statement-breakpoint
CREATE FUNCTION app.access_guard_legacy_configuration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid; row_value jsonb;
BEGIN
 IF TG_OP='DELETE' THEN t:=OLD.tenant_id; row_value:=to_jsonb(OLD); ELSE t:=NEW.tenant_id; row_value:=to_jsonb(NEW); END IF;
 IF app.access_configuration_denied_for(t,app.current_user_id()) THEN RAISE EXCEPTION 'access ceiling' USING ERRCODE='42501'; END IF;
 -- Pre-auth activation has no signed-in actor. Recheck the original inviter's current denial instead
 -- of allowing a previously issued invitation to restore access after the inviter was revoked.
 IF TG_TABLE_NAME='app_invitation' AND TG_OP='UPDATE' AND row_value->>'status'='accepted'
  AND app.access_configuration_denied_for(t,(row_value->>'created_by')::uuid) THEN
  RAISE EXCEPTION 'access ceiling' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_guard_legacy_configuration() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_role_configuration_guard BEFORE INSERT OR UPDATE OR DELETE ON role_assignment FOR EACH ROW EXECUTE FUNCTION app.access_guard_legacy_configuration();
--> statement-breakpoint
CREATE TRIGGER access_invitation_authority_lock BEFORE INSERT OR UPDATE OR DELETE ON app_invitation FOR EACH ROW EXECUTE FUNCTION app.access_lock_legacy_writer();
--> statement-breakpoint
CREATE TRIGGER access_invitation_configuration_guard BEFORE INSERT OR UPDATE OR DELETE ON app_invitation FOR EACH ROW EXECUTE FUNCTION app.access_guard_legacy_configuration();
--> statement-breakpoint
CREATE TRIGGER access_user_configuration_guard BEFORE DELETE OR UPDATE OF archived_at ON app_user FOR EACH ROW EXECUTE FUNCTION app.access_guard_legacy_configuration();
--> statement-breakpoint
-- Company-deletion guards must count private references without exposing their rows or granting SELECT.
-- Both the current scope and the real active principal must permit company administration.
CREATE FUNCTION app.access_company_reference_reader(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.is_admin_for(p_company)
 AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id())
 AND EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND r.role::text IN ('hr_admin','super_admin') AND app.access_scope_covers(r.company_id,p_company,u.tenant_id));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_company_reference_reader(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_group_grant_company_in_use(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_company_reference_reader(p_company) AND EXISTS(SELECT 1 FROM public.access_group_grant a WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=p_company);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_group_grant_company_in_use(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_group_grant_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_membership_company_in_use(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_company_reference_reader(p_company) AND EXISTS(SELECT 1 FROM public.access_membership a WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=p_company);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_membership_company_in_use(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_membership_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_user_override_company_in_use(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_company_reference_reader(p_company) AND EXISTS(SELECT 1 FROM public.access_user_override a WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=p_company);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_user_override_company_in_use(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_user_override_company_in_use(uuid) TO ai_hr_app;
