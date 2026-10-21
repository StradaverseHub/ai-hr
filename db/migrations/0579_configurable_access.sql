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
CREATE FUNCTION app.access_allowed_for_tenant(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.app_user u JOIN public.access_configuration s ON s.tenant_id=u.tenant_id
  JOIN public.access_capability c ON c.id=p_capability
  WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.archived_at IS NULL
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
REVOKE ALL ON FUNCTION app.access_allowed_for_tenant(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_allowed_for(p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_allowed_for_tenant(app.current_tenant_id(),p_user,p_capability,p_company);
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
-- Factor the existing 0279 login predicate through one dated owner. Current login behavior remains
-- exactly its current_date course; the additional date parameter is private to recovery checks.
CREATE FUNCTION app.login_blocked_on(p_user_id uuid,p_as_of date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_as_of IS NULL THEN true ELSE EXISTS(
  SELECT 1 FROM public.app_user u WHERE u.id=p_user_id AND (
   u.archived_at IS NOT NULL OR (
    u.person_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=u.person_id)
    AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=u.person_id AND e.blacklisted_at IS NULL
     AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
      OR p_as_of<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on)))
   )
  )
 ) END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.login_blocked_on(uuid,date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.login_blocked(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.login_blocked_on(p_user_id,current_date);
$$;
--> statement-breakpoint
CREATE FUNCTION app.access_recovery_available(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=p_user AND NOT app.login_blocked_on(u.id,
  GREATEST(current_date,COALESCE((SELECT MAX(LEAST(e.resignation_date,e.last_working_date,e.terminated_on))+1
   FROM public.employment e WHERE e.person_id=u.person_id
    AND isfinite(LEAST(e.resignation_date,e.last_working_date,e.terminated_on))),current_date))));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_recovery_available(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_assert_administrator_for(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.access_configuration s WHERE s.tenant_id=p_tenant AND s.initialized)
 AND NOT EXISTS(SELECT 1 FROM public.access_group g JOIN public.access_effective_membership m ON m.group_id=g.id AND m.tenant_id=g.tenant_id
  WHERE g.tenant_id=p_tenant AND g.system_administrator AND g.retired_at IS NULL
   AND m.company_id IS NULL
   AND app.access_allowed_for_tenant(p_tenant,m.user_id,'access.system_admin',NULL)
   AND app.access_allowed_for_tenant(p_tenant,m.user_id,'access.configure',NULL)
   AND app.access_recovery_available(m.user_id)) THEN
  RAISE EXCEPTION 'access last administrator' USING ERRCODE='23514';
 END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_assert_administrator_for(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_assert_administrator() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN PERFORM app.access_assert_administrator_for(app.current_tenant_id()); END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_assert_administrator() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Only implemented bindings may be marked supported. The remaining entries stay unavailable until
-- their page, action, read/export and SQL consumers are completed and verified in this source round.
INSERT INTO access_capability(id,scope,supported,bindings) VALUES
 ('access.system_admin','tenant',true,'[{"owner":"app.access_assert_administrator","operation":"recovery-invariant"}]'),
 ('access.configure','tenant',true,'[{"owner":"app.access_configuration_state","operation":"read"},{"owner":"app.access_configuration_editor_metadata","operation":"read-labels-history"},{"owner":"app.access_configuration_commit","operation":"write"},{"owner":"app/admin/users/access/page.tsx","operation":"page"},{"owner":"app/admin/users/access/actions.ts","operation":"preview-save"}]'),
 ('workforce.view','company',false,'[]'),
 ('workforce.maintain','company',false,'[]'),
 ('profile.review','company',false,'[]');
--> statement-breakpoint
CREATE FUNCTION app.access_install_defaults(t uuid,u uuid) RETURNS boolean
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
REVOKE ALL ON FUNCTION app.access_install_defaults(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Existing customers receive defaults during the migration without a browser visit. A tenant with
-- no actual durable customer administrator remains uninitialized; no identity or operator is minted.
DO $$
DECLARE root record;
BEGIN
 FOR root IN SELECT DISTINCT ON(u.tenant_id) u.tenant_id,u.id FROM public.app_user u
  JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
  WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND app.access_recovery_available(u.id)
   AND (r.role::text='super_admin' OR (r.role::text='hr_admin' AND r.company_id IS NULL))
  ORDER BY u.tenant_id,u.id
 LOOP PERFORM app.access_install_defaults(root.tenant_id,root.id); END LOOP;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.access_initialize_from_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Deferred: the complete account/role transaction, including invitation activation, is visible.
 IF NEW.role::text='super_admin' OR (NEW.role::text='hr_admin' AND NEW.company_id IS NULL) THEN
  PERFORM app.access_install_defaults(NEW.tenant_id,NEW.app_user_id);
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_initialize_from_role() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER access_role_default_install AFTER INSERT OR UPDATE ON role_assignment
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_initialize_from_role();
--> statement-breakpoint
CREATE FUNCTION app.access_configuration_initialize() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE installed boolean;
BEGIN
 installed:=app.access_install_defaults(app.current_tenant_id(),app.current_user_id());
 IF NOT EXISTS(SELECT 1 FROM public.access_configuration s WHERE s.tenant_id=app.current_tenant_id() AND s.initialized) THEN
  RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501';
 END IF;
 RETURN installed;
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
  'users',COALESCE((SELECT jsonb_agg(jsonb_build_array(u.id,u.archived_at,app.login_blocked(u.id),app.access_recovery_available(u.id)) ORDER BY u.id) FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id()),'[]'::jsonb),
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
  'recoveryUserIds',COALESCE((SELECT jsonb_agg(u.id ORDER BY u.id) FROM public.app_user u WHERE u.tenant_id=t AND app.access_recovery_available(u.id)),'[]'::jsonb),
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
-- The editor receives login labels and bounded permission history, never a personnel/payroll row.
CREATE FUNCTION app.access_configuration_editor_metadata() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); result jsonb;
BEGIN
 IF NOT app.access_allowed_for(app.current_user_id(),'access.configure',NULL) THEN
  RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501';
 END IF;
 SELECT jsonb_build_object(
  'users',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'label',COALESCE(NULLIF(p.full_name,''),u.id::text)) ORDER BY u.id)
   FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.tenant_id=t),'[]'::jsonb),
  'companies',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'label',c.legal_name) ORDER BY c.id) FROM public.company c WHERE c.tenant_id=t),'[]'::jsonb),
  'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',h.id,'at',h.occurred_at,'actorId',h.actor_id,
    'operation',CASE WHEN h.event_type='access-configuration.initialized' THEN 'initialized' ELSE h.payload->>'kind' END) ORDER BY h.sequence DESC)
   FROM (SELECT e.id,e.sequence,e.occurred_at,e.actor_id,e.event_type,e.payload FROM public.domain_event e
    WHERE e.tenant_id=t AND e.aggregate_type='access-configuration' AND e.aggregate_id=t
     AND e.event_type IN ('access-configuration.initialized','access-configuration.changed')
    ORDER BY e.sequence DESC LIMIT 100) h),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_configuration_editor_metadata() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_configuration_editor_metadata() TO ai_hr_app;
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
 VALUES(t,'access-configuration',t,'access-configuration.changed','user',actor,audit);
 RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_configuration_commit(uuid,text,jsonb,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_configuration_commit(uuid,text,jsonb,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Only the canonical definer owner may append access audit events. General runtime append authority
-- must not manufacture editor history or impersonate a configuration change that never committed.
CREATE FUNCTION app.access_guard_audit_append() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.aggregate_type='access-configuration' OR NEW.event_type IN ('access-configuration.initialized','access-configuration.changed'))
  AND NOT app.acting_as_owner() THEN RAISE EXCEPTION 'access audit owner required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_guard_audit_append() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_audit_append_owner BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.access_guard_audit_append();
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
-- Fresh legacy role floor. Group configuration may never manufacture an old customer/operator role.
-- This private arbitrary-principal form is also used when an old invitation is consumed pre-auth.
CREATE FUNCTION app.access_legacy_role_authority(t uuid,u uuid,p_role text,p_company uuid,p_person uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user a JOIN public.role_assignment r ON r.app_user_id=a.id AND r.tenant_id=a.tenant_id
  WHERE a.id=u AND a.tenant_id=t AND NOT app.login_blocked(a.id) AND NOT app.access_configuration_denied_for(t,u)
   AND (p_role IS NULL OR p_role IN ('employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner'))
   AND (p_role IS DISTINCT FROM 'super_admin' OR p_company IS NULL)
   AND (r.role::text='super_admin' OR (r.role::text='hr_admin' AND r.company_id IS NULL)
    OR (r.role::text='hr_admin' AND p_role='hr_admin' AND p_company IS NOT NULL
     AND app.access_scope_covers(r.company_id,p_company,t)
     AND (p_person IS NULL OR EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=t AND e.person_id=p_person
      AND app.access_scope_covers(r.company_id,e.company_id,t)))))
 );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_legacy_role_authority(uuid,uuid,text,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_legacy_configuration_permitted(p_role text,p_company uuid,p_person uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_legacy_role_authority(app.current_tenant_id(),app.current_user_id(),p_role,p_company,p_person);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_legacy_configuration_permitted(text,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_legacy_configuration_permitted(text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_guard_legacy_configuration() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid; row_value jsonb; requested_role text; requested_company uuid; requested_person uuid;
BEGIN
 IF TG_OP='DELETE' THEN t:=OLD.tenant_id; row_value:=to_jsonb(OLD); ELSE t:=NEW.tenant_id; row_value:=to_jsonb(NEW); END IF;
 IF app.acting_as_owner() THEN
  -- Canonical manual enrollment already re-reads its actual role owner, but an explicit new denial
  -- must still stop its definer write. Owner maintenance with no session remains an explicit act.
  IF app.access_configuration_denied_for(t,app.current_user_id()) THEN RAISE EXCEPTION 'access ceiling' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='app_invitation' AND TG_OP='UPDATE' AND row_value->>'status'='accepted'
   AND (row_value->>'created_by') IS NOT NULL AND NOT app.access_legacy_role_authority(t,(row_value->>'created_by')::uuid,
    row_value->>'role',(row_value->>'company_id')::uuid,(row_value->>'person_id')::uuid) THEN
   RAISE EXCEPTION 'access ceiling' USING ERRCODE='42501';
  END IF;
 ELSE
  IF t IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'access ceiling' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='role_assignment' OR (TG_TABLE_NAME='app_invitation' AND TG_OP='INSERT') THEN
   requested_role:=row_value->>'role';requested_company:=(row_value->>'company_id')::uuid;
   IF TG_TABLE_NAME='app_invitation' THEN
    requested_person:=(row_value->>'person_id')::uuid;
    -- NULL creator is reserved for explicit owner-issued initial activation. A session cannot forge
    -- that path or name a stronger inviter whose authority would later be checked on its behalf.
    IF (row_value->>'created_by')::uuid IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'access ceiling' USING ERRCODE='42501'; END IF;
   END IF;
  END IF;
  -- NULL role requires an actual group administrator for archive/delete and invitation revocation.
  IF NOT app.access_legacy_configuration_permitted(requested_role,requested_company,requested_person) THEN
   RAISE EXCEPTION 'access ceiling' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='role_assignment' AND TG_OP='UPDATE'
   AND NOT app.access_legacy_configuration_permitted(to_jsonb(OLD)->>'role',(to_jsonb(OLD)->>'company_id')::uuid,NULL) THEN
   RAISE EXCEPTION 'access ceiling' USING ERRCODE='42501';
  END IF;
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

--> statement-breakpoint
-- Draft profile-review adapter. The catalogue remains unavailable until all bindings and the
-- actual consumer matrix pass. Its dormant flag preserves the existing eligible HR course; even
-- that course must use an actual live HR principal instead of a stale role list from the caller.
CREATE FUNCTION app.access_profile_review_for_user(p_user uuid,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.tenant_id=e.tenant_id
  JOIN public.role_assignment r ON r.tenant_id=u.tenant_id AND r.app_user_id=u.id
  JOIN public.access_capability c ON c.id='profile.review'
  WHERE e.id=p_subject AND e.tenant_id=app.current_tenant_id() AND u.id=p_user
   AND NOT app.login_blocked(u.id) AND u.person_id IS DISTINCT FROM e.person_id
   AND r.role::text IN ('hr_admin','super_admin') AND app.access_scope_covers(r.company_id,e.company_id,e.tenant_id)
   AND (NOT c.supported OR app.access_allowed_for(u.id,c.id,e.company_id)));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_review_for_user(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_profile_review_permitted(p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.access_profile_review_for_user(app.current_user_id(),p_subject);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_review_permitted(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_profile_review_permitted(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_profile_request_own(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.is_self_person(p_person) AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id()
  AND u.tenant_id=app.current_tenant_id() AND u.person_id=p_person AND NOT app.login_blocked(u.id));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_request_own(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_profile_request_own(uuid) TO ai_hr_app;
--> statement-breakpoint
-- These policies only narrow the existing subject/named-route rules. Own request history and
-- owner-only withdrawal/privacy retention remain separate, and no new Personnel/payroll row is exposed.
CREATE POLICY access_profile_review_read ON profile_change_request AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.access_profile_request_own(person_id) OR app.access_profile_review_permitted(employment_id));
--> statement-breakpoint
CREATE POLICY access_profile_review_update ON profile_change_request AS RESTRICTIVE FOR UPDATE TO ai_hr_app
 USING(app.access_profile_review_permitted(employment_id)) WITH CHECK(app.access_profile_review_permitted(employment_id));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.profile_route_principal(p_approver uuid,p_subject uuid)
RETURNS TABLE(user_id uuid,employment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT u.id,a.id FROM employment a JOIN app_user u ON u.person_id=a.person_id AND u.tenant_id=a.tenant_id
 JOIN employment s ON s.id=p_subject AND s.tenant_id=a.tenant_id
 WHERE a.id=p_approver AND a.tenant_id=app.current_tenant_id() AND a.person_id<>s.person_id
 AND (app.is_self_person(s.person_id) OR app.can_admin_employment(s.id))
 AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND a.blacklisted_at IS NULL
 AND a.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND (LEAST(a.resignation_date,a.last_working_date,a.terminated_on) IS NULL OR LEAST(a.resignation_date,a.last_working_date,a.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND EXISTS(SELECT 1 FROM role_assignment r WHERE r.tenant_id=a.tenant_id AND r.app_user_id=u.id AND r.role IN ('hr_admin','super_admin')
  AND (r.company_id IS NULL OR r.company_id=s.company_id OR app.is_company_descendant(s.company_id,r.company_id)))
 AND (NOT EXISTS(SELECT 1 FROM tenant_setting t WHERE t.tenant_id=a.tenant_id AND t.key='ess.profile_change_approver' AND t.value='"group_admin"'::jsonb) OR EXISTS(SELECT 1 FROM role_assignment g WHERE g.tenant_id=a.tenant_id AND g.app_user_id=u.id AND (g.role='super_admin' OR g.role='hr_admin' AND g.company_id IS NULL)))
 AND app.access_profile_review_for_user(u.id,s.id)
 AND (SELECT count(*) FROM app_user other WHERE other.tenant_id=a.tenant_id AND other.person_id=a.person_id AND other.archived_at IS NULL AND NOT app.login_blocked(other.id))=1;
$$;

--> statement-breakpoint
-- Write-only profile-configuration consequence, separate from a decision on the merits. Existing
-- group-admin settings authority can withdraw pending fields without gaining proposal reads or
-- approval authority. Denying profile.review must not leave now-hidden proposal bytes pending.
CREATE FUNCTION app.access_withdraw_profile_requests(p_keys jsonb,p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();r record;affected integer:=0;keys text[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('profile-edit-policy:'||t::text,0));
 IF NOT app.access_legacy_role_authority(t,u,NULL,NULL,NULL) THEN
  RAISE EXCEPTION 'profile configuration authority unavailable' USING ERRCODE='42501'; END IF;
 IF p_keys IS NULL OR jsonb_typeof(p_keys)<>'array' OR jsonb_array_length(p_keys)>512
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_keys) k WHERE jsonb_typeof(k)<>'string' OR length(k#>>'{}') NOT BETWEEN 1 AND 200
   OR (k#>>'{}') IN ('v','kind','fieldId','fields','registers','baselineHash','redacted'))
  OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
  RAISE EXCEPTION 'profile withdrawal input invalid' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(array_agg(DISTINCT value ORDER BY value),'{}'::text[]) INTO keys FROM jsonb_array_elements_text(p_keys);
 FOR r IN
  UPDATE public.profile_change_request q SET status='rejected',decided_by_employment_id=NULL,decided_at=now(),decision_reason=btrim(p_reason)
  WHERE q.tenant_id=t AND q.status='pending' AND (
   q.proposed->>'fieldId'=ANY(keys) OR q.proposed ?| keys
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.proposed->'fields')='array' THEN q.proposed->'fields' ELSE '[]'::jsonb END) f WHERE f->>'fieldId'=ANY(keys))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.proposed->'registers')='array' THEN q.proposed->'registers' ELSE '[]'::jsonb END) x,
    LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x->'fields')='array' THEN x->'fields' ELSE '[]'::jsonb END) f WHERE f->>'fieldId'=ANY(keys)))
  RETURNING q.id,q.employment_id,q.proposed
 LOOP
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(t,'profile-change',r.id,'profile-change.rejected','user',u,r.employment_id,
   jsonb_build_object('decision','rejected','via','field-locked','reasonGiven',true,'fields',
    (SELECT COALESCE(jsonb_agg(field ORDER BY field),'[]'::jsonb) FROM (
     SELECT DISTINCT k AS field FROM unnest(keys) k WHERE r.proposed ? k OR r.proposed->>'fieldId'=k
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.proposed->'fields')='array' THEN r.proposed->'fields' ELSE '[]'::jsonb END) f WHERE f->>'fieldId'=k)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.proposed->'registers')='array' THEN r.proposed->'registers' ELSE '[]'::jsonb END) x,
       LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x->'fields')='array' THEN x->'fields' ELSE '[]'::jsonb END) f WHERE f->>'fieldId'=k)
    ) matching)));
  affected:=affected+1;
 END LOOP;
 RETURN affected;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_withdraw_profile_requests(jsonb,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_withdraw_profile_requests(jsonb,text) TO ai_hr_app;

--> statement-breakpoint
-- Draft Workforce-purpose adapters. 0576 owns principal freshness; this migration must follow its
-- verified release. These predicates narrow the existing HR record owner rather than manufacture
-- HR, payroll or approval status from a group grant. Catalogue activation waits for all consumers.
-- The pre-existing cron executes already-admitted dated intents as system, not as a synthetic login.
-- session_user is essential: current_user inside a definer function is this function's owner, so an
-- acting_as_owner() check here would accidentally bless every ai_hr_app caller. No runtime EXECUTE.
CREATE FUNCTION app.access_workforce_storage_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT pg_catalog.pg_has_role(
  session_user,(SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.app_user'::regclass),'USAGE')
  AND pg_catalog.pg_has_role(
   (CASE WHEN pg_catalog.current_setting('role')='none' THEN session_user::text ELSE pg_catalog.current_setting('role') END)::name,
   (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.app_user'::regclass),'USAGE');
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_storage_owner() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_owner_company(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NULL AND app.access_workforce_storage_owner()
  AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id()
   AND (app.has_role_for('hr_admin',c.id) OR app.has_role_for('super_admin',c.id)));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_owner_company(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_company(p_company uuid,p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_capability IN ('workforce.view','workforce.maintain') AND (app.access_workforce_owner_company(p_company)
  OR app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.company co JOIN public.app_user u ON u.tenant_id=co.tenant_id
   JOIN public.role_assignment r ON r.tenant_id=u.tenant_id AND r.app_user_id=u.id
   JOIN public.access_capability c ON c.id=p_capability
   WHERE co.id=p_company AND co.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
    AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    AND r.role::text IN ('hr_admin','super_admin') AND app.has_role_for(r.role::text,co.id)
    AND app.access_scope_covers(r.company_id,co.id,co.tenant_id)
    AND (NOT c.supported OR app.access_allowed_for(u.id,c.id,co.id))));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_company(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_company(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_employment(p_employment uuid,p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
  AND app.access_workforce_company(e.company_id,p_capability));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_employment(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_employment(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_not_denied(p_company uuid,p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_capability IN ('workforce.view','workforce.maintain') AND app.principal_snapshot_current()
  AND NOT EXISTS(SELECT 1 FROM public.access_configuration cfg JOIN public.access_user_override o ON o.tenant_id=cfg.tenant_id
   JOIN public.access_capability c ON c.id=o.capability_id AND c.supported
   WHERE cfg.tenant_id=app.current_tenant_id() AND cfg.initialized AND o.user_id=app.current_user_id()
    AND o.capability_id=p_capability AND o.effect='deny' AND o.retired_at IS NULL
    AND app.access_scope_covers(o.company_id,p_company,cfg.tenant_id));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_not_denied(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_not_denied(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_unassigned(p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_capability IN ('workforce.view','workforce.maintain') AND app.principal_snapshot_current()
  AND EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
   JOIN public.access_capability c ON c.id=p_capability
   WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    AND r.company_id IS NULL AND r.role::text IN ('hr_admin','super_admin')
    AND (NOT c.supported OR app.access_can_delegate(c.id,NULL)));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_unassigned(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_unassigned(text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_person(p_person uuid,p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (EXISTS(SELECT 1 FROM public.person p JOIN public.employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id
  WHERE p.id=p_person AND p.tenant_id=app.current_tenant_id() AND app.access_workforce_company(e.company_id,p_capability))
  OR EXISTS(SELECT 1 FROM public.person p WHERE p.id=p_person AND p.tenant_id=app.current_tenant_id()
   AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p.id AND e.tenant_id=p.tenant_id)
   AND app.access_workforce_unassigned(p_capability)))
  -- Keep the existing any-administered-employment person owner. Changing that one shared fact
  -- nevertheless cannot cross an explicit denial on another retained employment's company.
  AND ((app.current_user_id() IS NULL AND app.access_workforce_storage_owner())
   OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=app.current_tenant_id()
    AND NOT app.access_workforce_not_denied(e.company_id,p_capability)));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_person(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_person(uuid,text) TO ai_hr_app;

--> statement-breakpoint
-- Drafts are a distinct Workforce aggregate, not another module's shared employment read. Their
-- private data receives the same fresh read/write gate even if an old author session still exists.
-- 0510 deliberately preserves an author's read/discard course independently of an HR role. Keep
-- that relationship source with actual own-person binding; an explicit applicable denial still wins.
CREATE FUNCTION app.access_workforce_draft(p_company uuid,p_author uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_operation IN ('read','edit','admit') AND (
  (app.access_profile_request_own(p_author) AND (p_operation<>'admit' OR p_company IS NULL)
   AND app.access_workforce_not_denied(p_company,CASE WHEN p_operation='read' THEN 'workforce.view' ELSE 'workforce.maintain' END))
  OR CASE WHEN p_company IS NULL
   THEN app.access_workforce_unassigned(CASE WHEN p_operation='read' THEN 'workforce.view' ELSE 'workforce.maintain' END)
   ELSE app.access_workforce_company(p_company,CASE WHEN p_operation='read' THEN 'workforce.view' ELSE 'workforce.maintain' END) END);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_draft(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_draft(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY access_workforce_draft_read ON employee_draft AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.access_workforce_draft(company_id,created_by_person_id,'read'));
--> statement-breakpoint
CREATE POLICY access_workforce_draft_insert ON employee_draft AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK(app.access_workforce_draft(company_id,created_by_person_id,'admit'));
--> statement-breakpoint
CREATE POLICY access_workforce_draft_update ON employee_draft AS RESTRICTIVE FOR UPDATE TO ai_hr_app
 USING(app.access_workforce_draft(company_id,created_by_person_id,'edit'))
 WITH CHECK(app.access_workforce_draft(company_id,created_by_person_id,'admit'));
--> statement-breakpoint
CREATE POLICY access_workforce_draft_delete ON employee_draft AS RESTRICTIVE FOR DELETE TO ai_hr_app
 USING(app.access_workforce_draft(company_id,created_by_person_id,'edit'));

--> statement-breakpoint
-- Positive grants enter only a bounded purpose projection. They must not be fed back into the
-- legacy raw-row helper above, whose callers include shared write/detail owners still being bound.
CREATE FUNCTION app.access_workforce_projection_company(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(
  SELECT 1 FROM public.company co JOIN public.app_user u ON u.tenant_id=co.tenant_id
  JOIN public.access_capability c ON c.id='workforce.view'
  WHERE co.id=p_company AND co.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND CASE WHEN c.supported THEN app.access_allowed_for(u.id,c.id,co.id)
    ELSE app.access_workforce_company(co.id,c.id) END);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_projection_company(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_projection_company(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Positive maintenance enters fixed commands, never the shared raw-row/write helper. Both view and
-- maintenance must survive effective scope/denials; a capability does not manufacture an HR role.
CREATE FUNCTION app.access_workforce_command_company(p_company uuid) RETURNS boolean
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
REVOKE ALL ON FUNCTION app.access_workforce_command_company(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_command_allowed(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
  AND app.access_workforce_command_company(e.company_id));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_command_allowed(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_command_allowed(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Explicit Workforce list projection. A scoped reader receives these declared display values, not
-- person/employment row SELECT, raw blobs, salary, statutory, bank, classification or arbitrary fields.
-- SQL status/filter/paging remain with the existing application query owners over this projection.
CREATE FUNCTION app.access_workforce_list_rows() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH permitted AS MATERIALIZED (
  SELECT c.id FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 )
 SELECT jsonb_build_object(
  'employmentId',e.id,'name',p.full_name,'email',p.primary_email,'employeeCode',e.employee_code,
  'department',COALESCE(NULLIF(btrim(d.label),''),d.name),'departmentId',a.department_id,
  'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title),'company',co.legal_name,'companyId',e.company_id,
  'hiredOn',e.hired_on,'terminatedOn',e.terminated_on,'confirmationDate',e.confirmation_date,
  'finalConfirmationDate',e.final_confirmation_date,'probationEndDate',e.probation_end_date,
  'provisionalEndOn',e.provisional_end_on,'resignationDate',e.resignation_date,'lastWorkingDate',e.last_working_date,
  'blacklistedAt',e.blacklisted_at,'jobGrade',g.name,'employmentType',a.employment_type,
  'businessUnit',COALESCE(NULLIF(btrim(bu.label),''),bu.code),'costCenter',cc.name,'workLocation',loc.name,
  'joinDate',e.join_date,'reportingTo',(
   SELECT mp.full_name FROM public.reporting_line rl
   JOIN public.employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id
   JOIN permitted manager_scope ON manager_scope.id=me.company_id
   JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
   WHERE rl.tenant_id=e.tenant_id AND rl.subordinate_employment_id=e.id AND rl.line_type='administrative'
    AND rl.valid_to IS NULL AND rl.superseded_at IS NULL ORDER BY rl.valid_from DESC,rl.id LIMIT 1))
 FROM public.employment e JOIN permitted allowed ON allowed.id=e.company_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
 LEFT JOIN public.department d ON d.id=a.department_id AND d.tenant_id=e.tenant_id
 LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id
 LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=a.business_unit_id AND bu.tenant_id=e.tenant_id
 LEFT JOIN public.cost_center cc ON cc.id=a.cost_center_id AND cc.tenant_id=e.tenant_id
 LEFT JOIN public.location loc ON loc.id=a.location_id AND loc.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id();
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_list_rows() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_list_rows() TO ai_hr_app;


--> statement-breakpoint
-- Existing independent self/administrative-tree/HOD record reads remain relationship authority.
-- Replace only the HR arm with the fresh Workforce check; a grant never fabricates a reporting edge.
CREATE FUNCTION app.access_workforce_related_read(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(
  SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
   AND (app.access_workforce_company(e.company_id,'workforce.view') OR app.access_profile_request_own(e.person_id)
    OR EXISTS(SELECT 1 FROM public.employment me JOIN public.app_user u ON u.person_id=me.person_id AND u.tenant_id=me.tenant_id
     WHERE u.id=app.current_user_id() AND me.tenant_id=e.tenant_id AND me.terminated_on IS NULL
      AND (app.is_admin_report_of(e.id,me.id) OR app.heads_department_of(e.id,me.id)))));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_related_read(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_related_read(uuid) TO ai_hr_app;
--> statement-breakpoint
-- General Personnel documents are not pending profile-proposal bytes. Preserve independent own/team
-- reads, but every direct write/delete needs current Workforce maintenance in addition to legacy RLS.
CREATE POLICY access_workforce_document_read ON employee_document AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.access_workforce_related_read(employment_id));
--> statement-breakpoint
CREATE POLICY access_workforce_document_insert ON employee_document AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK(app.access_workforce_employment(employment_id,'workforce.maintain'));
--> statement-breakpoint
CREATE POLICY access_workforce_document_update ON employee_document AS RESTRICTIVE FOR UPDATE TO ai_hr_app
 USING(app.access_workforce_employment(employment_id,'workforce.maintain'))
 WITH CHECK(app.access_workforce_employment(employment_id,'workforce.maintain'));
--> statement-breakpoint
CREATE POLICY access_workforce_document_delete ON employee_document AS RESTRICTIVE FOR DELETE TO ai_hr_app
 USING(app.access_workforce_employment(employment_id,'workforce.maintain'));


--> statement-breakpoint
-- A positive Workforce view grant can open only this declared normal-profile/read-model contract.
-- No raw person/employment grant, payroll-policy/financial fields, classification or file bytes.
CREATE FUNCTION app.access_workforce_record(p_employment uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('employment',listing.value,'profile',jsonb_build_object(
  'salutation',p.salutation,'fullName',p.full_name,'firstName',p.first_name,'lastName',p.last_name,
  'preferredName',p.preferred_name,'nationality',p.nationality,'religion',p.religion,'race',p.race,
  'dateOfBirth',p.date_of_birth,'gender',p.gender,'maritalStatus',p.marital_status,'primaryEmail',p.primary_email,
  'phone',p.phone,'homePhone',p.home_phone,'personalEmail',p.personal_email,'permanentAddressLine1',p.permanent_address_line1,
  'permanentAddressLine2',p.permanent_address_line2,'permanentAddressLine3',p.permanent_address_line3,'permanentPostcode',p.permanent_postcode,'permanentCity',p.permanent_city,
  'permanentState',p.permanent_state,'permanentCountry',p.permanent_country,'correspondenceAddressLine1',p.correspondence_address_line1,'correspondenceAddressLine2',p.correspondence_address_line2,
  'correspondenceAddressLine3',p.correspondence_address_line3,'correspondencePostcode',p.correspondence_postcode,'correspondenceCity',p.correspondence_city,'correspondenceState',p.correspondence_state,
  'correspondenceCountry',p.correspondence_country,'correspondenceMobilePhone',p.correspondence_mobile_phone,'correspondenceHomePhone',p.correspondence_home_phone))
 FROM app.access_workforce_list_rows() AS listing(value)
 JOIN public.employment e ON e.id=(listing.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id()
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE e.id=p_employment;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_record(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_record(uuid) TO ai_hr_app;

--> statement-breakpoint
-- These two employment facts have only direct Workforce writers. Do not put a blanket UPDATE
-- restriction on employment: approved Rewards, resignation and scheduled owners also write that
-- shared row. Lock at statement entry, before PostgreSQL locks a matching employment row, so direct
-- runtime SQL follows the same access-before-data order as the canonical application command.
CREATE FUNCTION app.access_workforce_write_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 -- Lock the real configuration tuple as well. A write from an already-pinned REPEATABLE READ
 -- snapshot must serialize/refuse after revocation, rather than reuse the old permission snapshot.
 -- This does not create a configuration edit or advance its logical revision/history.
 PERFORM 1 FROM app.access_profile_write_generation WHERE tenant_id=t FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Workforce policy generation unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.access_configuration WHERE tenant_id=t AND initialized FOR SHARE;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_write_lock() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_write_lock() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_master_statement_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NOT NULL THEN
  PERFORM app.access_workforce_write_lock();
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_master_statement_lock() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_workforce_master_lock BEFORE UPDATE OF employee_code,is_test_record ON employment
FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_master_update() RETURNS trigger
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
  (NOT app.access_workforce_company(OLD.company_id,'workforce.maintain') OR NOT app.access_workforce_company(NEW.company_id,'workforce.maintain')) THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_master_update() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_workforce_master_update BEFORE UPDATE OF employee_code,is_test_record ON employment
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_master_update();

--> statement-breakpoint
-- The canonical hire owner is the only application INSERT writer for employment. Refuse a denied
-- hire independently at SQL; related person/code/assignment/event writes roll back in that same Tx.
-- A new person has no retained employments yet. Reusing one must respect their existing shared owner.
CREATE FUNCTION app.access_workforce_hire_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR NOT app.access_workforce_company(NEW.company_id,'workforce.maintain')
  OR (EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=NEW.tenant_id AND e.person_id=NEW.person_id)
   AND NOT app.access_workforce_person(NEW.person_id,'workforce.maintain')) THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_hire_insert() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_workforce_hire_lock BEFORE INSERT ON employment
FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
--> statement-breakpoint
CREATE TRIGGER access_workforce_hire_insert BEFORE INSERT ON employment
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_hire_insert();

--> statement-breakpoint
-- Documents have no independent ESS proposal writer (photo proposals have their own table/owner).
-- Keep the restrictive RLS above, and serialize direct SQL with configuration changes as well.
CREATE FUNCTION app.access_workforce_document_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
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
    OR NOT app.access_workforce_employment(OLD.employment_id,'workforce.maintain') THEN
    RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
   END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
   IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id()
    OR NOT app.access_workforce_employment(NEW.employment_id,'workforce.maintain') THEN
    RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_document_write() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_workforce_document_lock BEFORE INSERT OR UPDATE OR DELETE ON employee_document
FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
--> statement-breakpoint
CREATE TRIGGER access_workforce_document_write BEFORE INSERT OR UPDATE OR DELETE ON employee_document
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_document_write();

--> statement-breakpoint
CREATE FUNCTION app.access_workforce_draft_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN
  IF TG_OP='INSERT' THEN
   IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id()
    AND u.tenant_id=app.current_tenant_id() AND u.person_id IS NOT DISTINCT FROM NEW.created_by_person_id) THEN
    RAISE EXCEPTION 'Draft author must be the actual principal' USING ERRCODE='42501';
   END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
   IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id THEN
    RAISE EXCEPTION 'Draft authorship cannot be reassigned' USING ERRCODE='42501';
   END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN
   IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id()
    OR NOT app.access_workforce_draft(OLD.company_id,OLD.created_by_person_id,'edit') THEN
    RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
   END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
   IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id()
    OR NOT app.access_workforce_draft(NEW.company_id,NEW.created_by_person_id,'admit') THEN
    RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_draft_write() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_workforce_draft_lock BEFORE INSERT OR UPDATE OR DELETE ON employee_draft
FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
--> statement-breakpoint
CREATE TRIGGER access_workforce_draft_write BEFORE INSERT OR UPDATE OR DELETE ON employee_draft
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_draft_write();

--> statement-breakpoint
-- One bounded claim owner for hire, draft and code correction. The result names only the kind of
-- collision, never another employee/draft identity or its private payload. Tenant uniqueness is
-- independent of which other company's records happen to be visible to this caller.
CREATE FUNCTION app.employee_code_claim(p_tenant uuid,p_code text,p_exclude_employment uuid DEFAULT NULL,p_exclude_draft uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN
  PERFORM app.access_workforce_write_lock();
  IF p_tenant IS DISTINCT FROM app.current_tenant_id() OR NOT EXISTS(
   SELECT 1 FROM public.company c WHERE c.tenant_id=p_tenant AND app.access_workforce_command_company(c.id)) THEN
   RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=p_tenant AND e.employee_code=p_code
  AND e.id IS DISTINCT FROM p_exclude_employment) THEN RETURN 'employment'; END IF;
 IF EXISTS(SELECT 1 FROM public.employee_draft d WHERE d.tenant_id=p_tenant AND d.reserved_employee_code=p_code
  AND d.id IS DISTINCT FROM p_exclude_draft) THEN RETURN 'draft'; END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employee_code_claim(uuid,text,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employee_code_claim(uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_set_employee_code(p_employment uuid,p_code text,p_expected jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); subject public.employment%ROWTYPE; claimant text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO subject FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=t FOR UPDATE;
 IF NOT FOUND OR NOT app.access_workforce_command_company(subject.company_id) THEN
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
REVOKE ALL ON FUNCTION app.access_workforce_set_employee_code(uuid,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_set_employee_code(uuid,text,jsonb) TO ai_hr_app;

--> statement-breakpoint
-- Register edit/proposal commands never move a retained row to another subject. Privacy erasure
-- updates/clears its existing values or deletes rows; explicit owner recovery remains separate.
CREATE FUNCTION app.access_workforce_register_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'Register subject cannot be reassigned' USING ERRCODE='42501';
 END IF;
 IF TG_TABLE_NAME='employee_qualification' THEN
  IF NEW.employment_id IS DISTINCT FROM OLD.employment_id THEN
   RAISE EXCEPTION 'Register subject cannot be reassigned' USING ERRCODE='42501';
  END IF;
 ELSE
  IF NEW.person_id IS DISTINCT FROM OLD.person_id THEN
   RAISE EXCEPTION 'Register subject cannot be reassigned' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_register_identity() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_workforce_register_identity BEFORE UPDATE OF id,tenant_id,created_at,employment_id ON employee_qualification
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_register_identity();
--> statement-breakpoint
CREATE TRIGGER access_workforce_register_identity BEFORE UPDATE OF id,tenant_id,created_at,person_id ON employee_dependent
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_register_identity();
--> statement-breakpoint
CREATE TRIGGER access_workforce_register_identity BEFORE UPDATE OF id,tenant_id,created_at,person_id ON person_emergency_contact
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_register_identity();
--> statement-breakpoint
-- Family and Qualification archival has no independent ESS approval course. Do not apply this to
-- emergency contacts: clearing the legacy own primary contact archives it under that separate owner.
CREATE FUNCTION app.access_workforce_register_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at OR app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
 END IF;
 IF TG_TABLE_NAME='employee_qualification' AND app.access_workforce_value_intent_allowed('qualification',to_jsonb(OLD),to_jsonb(NEW),false) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='employee_dependent' AND app.access_workforce_value_intent_allowed('dependent',to_jsonb(OLD),to_jsonb(NEW),false) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='employee_qualification' THEN
  IF NOT app.access_workforce_employment(OLD.employment_id,'workforce.maintain') THEN
   RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
  END IF;
 ELSE
  IF NOT app.access_workforce_person(OLD.person_id,'workforce.maintain') THEN
   RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_register_archive() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_workforce_register_archive_lock BEFORE UPDATE OF archived_at ON employee_qualification
FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
--> statement-breakpoint
CREATE TRIGGER access_workforce_register_archive BEFORE UPDATE OF archived_at ON employee_qualification
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_register_archive();
--> statement-breakpoint
CREATE TRIGGER access_workforce_register_archive_lock BEFORE UPDATE OF archived_at ON employee_dependent
FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
--> statement-breakpoint
CREATE TRIGGER access_workforce_register_archive BEFORE UPDATE OF archived_at ON employee_dependent
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_register_archive();

--> statement-breakpoint
-- Physical authorization projection of Personnel descriptors. Values/catalog validation remains in
-- the canonical owners; this finite map cannot address arbitrary columns, financial rows or photos.
-- Registry/SQL parity is a required contract. These are immutable bindings, not tenant settings.
CREATE FUNCTION app.access_profile_value_bindings()
RETURNS TABLE(field_id text,owner text,column_name text,field_name text,legacy_key text,immediate boolean,primary_key text,tab_name text,section_name text)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$ VALUES
 ('profile.personal_details.salutation','person','salutation','salutation','salutation',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.fullname','person','full_name','fullName','fullName',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.firstname','person','first_name','firstName','firstName',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.lastname','person','last_name','lastName','lastName',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.preferredname','person','preferred_name','preferredName','preferredName',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.nationality','person','nationality','nationality','nationality',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.religion','person','religion','religion','religion',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.race','person','race','race','race',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.dateofbirth','compliance','date_of_birth','dateOfBirth','dateOfBirth',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.gender','compliance','gender','gender','gender',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.maritalstatus','compliance','marital_status','maritalStatus','maritalStatus',false,NULL,'Profile','Personal details'),
 ('profile.contact_and_permanent_address.primaryemail','person','primary_email','primaryEmail',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.phone','person','phone','phone',NULL,true,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.homephone','person','home_phone','homePhone',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.personalemail','person','personal_email','personalEmail',NULL,true,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentaddressline1','person','permanent_address_line1','permanentAddressLine1',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentaddressline2','person','permanent_address_line2','permanentAddressLine2',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentaddressline3','person','permanent_address_line3','permanentAddressLine3',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentpostcode','person','permanent_postcode','permanentPostcode',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentcity','person','permanent_city','permanentCity',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentstate','person','permanent_state','permanentState',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentcountry','person','permanent_country','permanentCountry',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.correspondence_address.correspondenceaddressline1','person','correspondence_address_line1','correspondenceAddressLine1',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondenceaddressline2','person','correspondence_address_line2','correspondenceAddressLine2',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondenceaddressline3','person','correspondence_address_line3','correspondenceAddressLine3',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencepostcode','person','correspondence_postcode','correspondencePostcode',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencecity','person','correspondence_city','correspondenceCity',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencestate','person','correspondence_state','correspondenceState',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencecountry','person','correspondence_country','correspondenceCountry',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencemobilephone','person','correspondence_mobile_phone','correspondenceMobilePhone',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencehomephone','person','correspondence_home_phone','correspondenceHomePhone',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.emergency_contact.fullname','emergency','full_name','fullName',NULL,false,'legacyPrimaryEmergency.fullName','Profile','Emergency contact'),
 ('profile.emergency_contact.relationship','emergency','relationship','relationship',NULL,false,'legacyPrimaryEmergency.relationship','Profile','Emergency contact'),
 ('profile.emergency_contact.mobilephone','emergency','mobile_phone','mobilePhone',NULL,false,'legacyPrimaryEmergency.mobilePhone','Profile','Emergency contact'),
 ('profile.emergency_contact.homephone','emergency','home_phone','homePhone',NULL,false,'legacyPrimaryEmergency.homePhone','Profile','Emergency contact'),
 ('profile.emergency_contact.priority','emergency','priority','priority',NULL,false,NULL,'Profile','Emergency contact'),
 ('profile.emergency_contact.address','emergency','address','address',NULL,false,'legacyPrimaryEmergency.address','Profile','Emergency contact'),
 ('family.family_and_dependents.relationship','dependent','relationship','relationship',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.fullname','dependent','full_name','fullName',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.gender','dependent','gender','gender',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.dateofbirth','dependent','date_of_birth','dateOfBirth',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.phone','dependent','phone','phone',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.icorpassport','dependent','ic_or_passport','icOrPassport',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.passportnumber','dependent','passport_number','passportNumber',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.residentialaddress','dependent','residential_address','residentialAddress',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.marriagedate','dependent','marriage_date','marriageDate',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.marriagestatus','dependent','marriage_status','marriageStatus',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.spouseworking','dependent','spouse_working','spouseWorking',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.isbeneficiary','dependent','is_beneficiary','isBeneficiary',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.isdeceased','dependent','is_deceased','isDeceased',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.isstudent','dependent','is_student','isStudent',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.schoolname','dependent','school_name','schoolName',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.studylevel','dependent','study_level','studyLevel',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.studycountry','dependent','study_country','studyCountry',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.childreliefcategory','dependent','child_relief_category','childReliefCategory',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.childtaxrelief','dependent','child_tax_relief','childTaxRelief',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.childreliefpercentage','dependent','child_relief_percentage','childReliefPercentage',NULL,false,NULL,'Family','Family and dependents'),
 ('qualification.academic_and_professional_qualifications.level','qualification','qualification','qualification',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.institute','qualification','institute','institute',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.fromym','qualification','from_ym','fromYm',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.toym','qualification','to_ym','toYm',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.graduationdate','qualification','graduation_date','graduationDate',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.major','qualification','major','major',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.result','qualification','result','result',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.description','qualification','description','description',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.highest','qualification','is_highest','isHighest',NULL,false,NULL,'Qualification','Academic and professional qualifications'); $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_value_bindings() FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- A deny on direct maintenance must not cancel a legitimate, independently authorized ESS decision.
-- Database-private transaction evidence is produced ONLY by a real pending -> approved transition.
-- It contains identities/digests, never a second copy of proposal values or a caller-set bypass flag.
CREATE TABLE app.access_profile_value_actor (
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,user_id uuid NOT NULL,
 PRIMARY KEY(xact_id,tenant_id)
);
--> statement-breakpoint
CREATE TABLE app.access_profile_value_approval (
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,request_id uuid NOT NULL REFERENCES public.profile_change_request(id) ON DELETE CASCADE,
 user_id uuid NOT NULL,proposal_hash text NOT NULL,route_hash text NOT NULL,approved boolean NOT NULL DEFAULT false,audited boolean NOT NULL DEFAULT false,PRIMARY KEY(xact_id,request_id)
);
--> statement-breakpoint
CREATE TABLE app.access_profile_register_application (
 xact_id xid8 NOT NULL,request_id uuid NOT NULL REFERENCES public.profile_change_request(id) ON DELETE CASCADE,
 kind text NOT NULL,client_id text NOT NULL,row_id uuid NOT NULL,
 PRIMARY KEY(xact_id,request_id,kind,client_id),UNIQUE(xact_id,request_id,kind,row_id)
);
--> statement-breakpoint
REVOKE ALL ON TABLE app.access_profile_value_actor,app.access_profile_value_approval,app.access_profile_register_application FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE app.access_profile_value_actor ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.access_profile_value_approval ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.access_profile_register_application ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
CREATE FUNCTION app.access_profile_value_statement_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();previous_user uuid;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL; END IF;
 PERFORM app.access_profile_policy_write_lock();
 IF u IS NULL OR NOT app.principal_snapshot_current() THEN
  RAISE EXCEPTION 'Profile write principal unavailable' USING ERRCODE='42501';
 END IF;
 -- Retained only until a later transaction in this tenant; xid8 is never a reusable 32-bit xid.
 -- No values, raw proposal hashes exposed to the application, or lasting permission are stored here.
 DELETE FROM app.access_profile_register_application a USING app.access_profile_value_approval p
  WHERE a.xact_id=p.xact_id AND a.request_id=p.request_id AND p.tenant_id=t AND p.xact_id<>pg_current_xact_id();
 DELETE FROM app.access_workforce_value_intent WHERE tenant_id=t AND xact_id<>pg_current_xact_id();
 DELETE FROM app.access_profile_value_approval WHERE tenant_id=t AND xact_id<>pg_current_xact_id();
 DELETE FROM app.access_profile_value_actor WHERE tenant_id=t AND xact_id<>pg_current_xact_id();
 INSERT INTO app.access_profile_value_actor VALUES(pg_current_xact_id(),t,u) ON CONFLICT DO NOTHING;
 SELECT user_id INTO previous_user FROM app.access_profile_value_actor WHERE xact_id=pg_current_xact_id() AND tenant_id=t;
 IF previous_user IS DISTINCT FROM u THEN RAISE EXCEPTION 'Profile write principal changed' USING ERRCODE='42501'; END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_value_statement_lock() FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- SQL policy adapter for a declared bound field. Group ceilings and linked hidden name/DOB facts
-- also narrow this adapter. Malformed/unknown policy generations never become legacy defaults.
CREATE FUNCTION app.access_profile_value_editable(p_field text,p_primary boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b record;raw jsonb;cap text;linked text;linked_ids text[];
BEGIN
 SELECT * INTO b FROM app.access_profile_value_bindings() WHERE field_id=p_field;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT value INTO raw FROM public.tenant_setting WHERE tenant_id=app.current_tenant_id() AND key='ess.profile_change_fields';
 IF raw IS NULL OR raw='null'::jsonb OR raw='"all"'::jsonb OR jsonb_typeof(raw)='array' THEN
  IF jsonb_typeof(raw)='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements(raw) v WHERE jsonb_typeof(v)<>'string') THEN RETURN false; END IF;
  IF p_primary THEN RETURN b.primary_key IS NOT NULL; END IF;
  RETURN b.immediate OR b.legacy_key IS NOT NULL AND (raw IS NULL OR raw IN ('null'::jsonb,'"all"'::jsonb) OR raw ? b.legacy_key);
 END IF;
 IF jsonb_typeof(raw)<>'object' THEN RETURN false; END IF;
 IF raw->'version'='2'::jsonb THEN
  IF (SELECT count(*) FROM jsonb_object_keys(raw))<>2 OR jsonb_typeof(raw->'fields') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(raw->'fields')>512 OR EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'fields') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 200)
   OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(raw->'fields') v)<>jsonb_array_length(raw->'fields') THEN RETURN false; END IF;
  RETURN raw->'fields' ? CASE WHEN p_primary THEN b.primary_key ELSE b.field_id END;
 END IF;
 IF raw->'version' NOT IN ('3'::jsonb,'4'::jsonb) OR raw->'version' IS NULL
  OR jsonb_typeof(raw->'fields') IS DISTINCT FROM 'object' OR jsonb_typeof(raw->'primaryOnly') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(raw))<>CASE WHEN raw->'version'='3'::jsonb THEN 3 ELSE 4 END
  OR (SELECT count(*) FROM jsonb_object_keys(raw->'fields'))>512 OR jsonb_array_length(raw->'primaryOnly')>512
  OR EXISTS(SELECT 1 FROM jsonb_each(raw->'fields') f WHERE length(f.key) NOT BETWEEN 1 AND 200 OR f.value NOT IN ('"editable"'::jsonb,'"viewOnly"'::jsonb,'"hide"'::jsonb))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'primaryOnly') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 200)
  OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(raw->'primaryOnly') v)<>jsonb_array_length(raw->'primaryOnly') THEN RETURN false; END IF;
 IF raw->'version'='4'::jsonb THEN
  IF jsonb_typeof(raw->'groups') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(raw->'groups'))>128
   OR EXISTS(SELECT 1 FROM jsonb_each(raw->'groups') g WHERE length(g.key) NOT BETWEEN 1 AND 200 OR g.value NOT IN ('"editable"'::jsonb,'"viewOnly"'::jsonb,'"hide"'::jsonb)) THEN RETURN false; END IF;
 END IF;
 cap:=raw->'fields'->>p_field;
 IF cap IS NULL OR cap='hide' THEN RETURN false; END IF;
 IF raw->'version'='4'::jsonb AND (COALESCE(raw->'groups'->>('tab:'||b.tab_name),'editable')<>'editable'
  OR COALESCE(raw->'groups'->>('section:'||b.tab_name||'/'||b.section_name),'editable')<>'editable') THEN RETURN false; END IF;
 linked_ids:=CASE
  WHEN p_field IN ('profile.personal_details.fullname','profile.personal_details.firstname','profile.personal_details.lastname')
   THEN ARRAY['profile.personal_details.fullname','profile.personal_details.firstname','profile.personal_details.lastname']
  WHEN p_field='profile.personal_details.dateofbirth' THEN ARRAY['profile.personal_details.dateofbirth','profile.personal_details.age']
  WHEN p_field='family.family_and_dependents.dateofbirth' THEN ARRAY['family.family_and_dependents.dateofbirth','family.family_and_dependents.age']
  ELSE ARRAY[p_field] END;
 FOREACH linked IN ARRAY linked_ids LOOP
  IF COALESCE(raw->'fields'->>linked,'hide')='hide' THEN RETURN false; END IF;
 END LOOP;
 RETURN CASE WHEN p_primary THEN b.primary_key IS NOT NULL AND cap='viewOnly' AND raw->'primaryOnly' ? p_field ELSE cap='editable' END;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_value_editable(text,boolean) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.access_profile_value_request_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  -- A reviewer denied Workforce maintenance cannot manufacture another person's pending proposal.
  IF NOT app.access_workforce_employment(NEW.employment_id,'workforce.maintain') AND
   (NOT app.access_profile_request_own(NEW.person_id) OR NEW.status<>'pending' OR NEW.decided_at IS NOT NULL OR NEW.decided_by_employment_id IS NOT NULL) THEN
   RAISE EXCEPTION 'Profile request submission unavailable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 IF NOT app.access_workforce_employment(OLD.employment_id,'workforce.maintain') AND
  (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.person_id IS DISTINCT FROM OLD.person_id
   OR NEW.employment_id IS DISTINCT FROM OLD.employment_id OR NEW.proposed IS DISTINCT FROM OLD.proposed) THEN
  RAISE EXCEPTION 'Profile request subject and values are immutable' USING ERRCODE='42501';
 END IF;
 IF OLD.status<>'pending' AND NOT app.access_workforce_employment(OLD.employment_id,'workforce.maintain') AND
  (NEW.status IS DISTINCT FROM OLD.status OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
   OR NEW.decided_by_employment_id IS DISTINCT FROM OLD.decided_by_employment_id OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason) THEN
  RAISE EXCEPTION 'Profile decision is terminal' USING ERRCODE='42501'; END IF;
 IF OLD.status<>'pending' OR NEW.status<>'approved' OR NEW.proposed->'v'='3'::jsonb THEN RETURN NEW; END IF;
 -- Legacy deployed callers need no approval-only admission when direct shared-Person maintenance
 -- already permits the same write. In particular, migration-before-restart never changes that lane.
 IF app.access_workforce_person(OLD.person_id,'workforce.maintain') THEN RETURN NEW; END IF;
 -- Preparation verifies the route BEFORE any proposed master change. Completion below attests
 -- the actual terminal transition in the same transaction; preparation by itself grants nothing.
 IF NEW.proposed IS DISTINCT FROM OLD.proposed OR NEW.person_id IS DISTINCT FROM OLD.person_id
  OR NEW.employment_id IS DISTINCT FROM OLD.employment_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  OR NEW.route_id IS DISTINCT FROM OLD.route_id OR NEW.route_revision IS DISTINCT FROM OLD.route_revision
  OR NEW.route_approver_user_id IS DISTINCT FROM OLD.route_approver_user_id
  OR NEW.route_approver_employment_id IS DISTINCT FROM OLD.route_approver_employment_id
  OR NEW.route_context IS DISTINCT FROM OLD.route_context THEN
  RAISE EXCEPTION 'Profile decision write unavailable' USING ERRCODE='42501'; END IF;
 PERFORM app.access_profile_value_begin(OLD.id);
 IF (NEW.decided_by_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
  WHERE u.id=app.current_user_id() AND u.tenant_id=OLD.tenant_id AND e.id=NEW.decided_by_employment_id AND e.person_id<>OLD.person_id))
  OR NEW.decided_at IS NULL THEN RAISE EXCEPTION 'Profile decision actor unavailable' USING ERRCODE='42501'; END IF;
 UPDATE app.access_profile_value_approval SET approved=true WHERE xact_id=pg_current_xact_id() AND request_id=OLD.id
  AND tenant_id=OLD.tenant_id AND user_id=app.current_user_id();
 IF NOT FOUND THEN RAISE EXCEPTION 'Profile decision preparation unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_value_request_transition() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_profile_request_value_lock BEFORE INSERT OR UPDATE ON profile_change_request
FOR EACH STATEMENT EXECUTE FUNCTION app.access_profile_value_statement_lock();
--> statement-breakpoint
CREATE TRIGGER access_profile_request_value_transition BEFORE INSERT OR UPDATE ON profile_change_request
FOR EACH ROW EXECUTE FUNCTION app.access_profile_value_request_transition();

--> statement-breakpoint
CREATE FUNCTION app.access_profile_value_normalized(p_value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_value)='string' THEN COALESCE(to_jsonb(NULLIF(btrim(p_value#>>'{}',chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)),'')),'null'::jsonb) ELSE p_value END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_value_normalized(jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.access_profile_value_delta_matches(p_owner text,p_delta jsonb,p_fields jsonb,p_insert boolean,p_relationship_changed boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d record;b record;change jsonb;requested_relationship text;
BEGIN
 IF jsonb_typeof(p_fields) IS DISTINCT FROM 'array' OR jsonb_typeof(p_delta) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 SELECT app.access_profile_value_normalized(f->'value')#>>'{}' INTO requested_relationship
  FROM jsonb_array_elements(p_fields) f WHERE f->>'fieldId'='family.family_and_dependents.relationship';
 FOR d IN SELECT * FROM jsonb_each(p_delta) LOOP
  SELECT * INTO b FROM app.access_profile_value_bindings() WHERE owner=p_owner AND column_name=d.key;
  change:=NULL;
  IF FOUND THEN
   -- A duplicated submitted identity cannot authorize two competing interpretations.
   IF (SELECT count(*) FROM jsonb_array_elements(p_fields) f WHERE f->>'fieldId'=b.field_id)>1 THEN RETURN false; END IF;
   SELECT f INTO change FROM jsonb_array_elements(p_fields) f WHERE f->>'fieldId'=b.field_id;
   IF change IS NOT NULL AND change ? 'value' AND app.access_profile_value_editable(b.field_id)
    AND app.access_profile_value_normalized(change->'value')=d.value THEN CONTINUE; END IF;
  END IF;
  -- The canonical add owners initialize these defaults, even when the employee omitted them.
  IF p_insert AND (d.value='null'::jsonb OR d.key IN ('is_beneficiary','is_deceased','is_highest') AND d.value='false'::jsonb
   OR p_owner='emergency' AND d.key='priority' AND d.value='"other"'::jsonb) THEN CONTINUE; END IF;
  -- A relationship change atomically clears only fields that the existing Family owner says no
  -- longer apply. This cannot set a different value, alter remarks/identity, or change a tax row.
  IF p_owner='dependent' AND p_relationship_changed AND requested_relationship IS NOT NULL AND d.value='null'::jsonb
   AND ((requested_relationship<>'spouse' AND d.key IN ('marriage_date','marriage_status','spouse_working','company_name','employer_address'))
    OR (requested_relationship<>'child' AND d.key IN ('is_student','school_name','study_level','study_country','child_relief_category','child_tax_relief','child_relief_percentage')))
   AND app.access_profile_value_editable('family.family_and_dependents.relationship') THEN CONTINUE; END IF;
  RETURN false;
 END LOOP;
 RETURN true;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_value_delta_matches(text,jsonb,jsonb,boolean,boolean) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- The constraint trigger runs at transaction completion: a pending request by itself grants nothing.
-- It reads the actual approved row and private transition proof from THIS xid8 and THIS principal.
-- Setting constraints immediate before completing a decision refuses; it cannot publish a half-write.
CREATE FUNCTION app.access_profile_value_approved(p_owner text,p_person uuid,p_employment uuid,p_row uuid,p_delta jsonb,p_insert boolean,p_relationship_changed boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q record;entry jsonb;fields jsonb;bound_row uuid;promotion boolean;matched boolean;scalar_delta jsonb;current_marital jsonb;
BEGIN
 FOR q IN SELECT r.* FROM app.access_profile_value_approval proof JOIN public.profile_change_request r ON r.id=proof.request_id
  WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=app.current_tenant_id() AND proof.user_id=app.current_user_id()
   AND r.tenant_id=proof.tenant_id AND r.person_id=p_person AND (p_employment IS NULL OR r.employment_id=p_employment)
   AND proof.approved AND proof.audited AND r.status='approved' AND proof.proposal_hash=encode(sha256(convert_to(r.proposed::text,'UTF8')),'hex')
   AND proof.route_hash=encode(sha256(convert_to(jsonb_build_array(r.route_id,r.route_revision,r.route_approver_user_id,r.route_approver_employment_id,r.route_context)::text,'UTF8')),'hex')
   AND app.access_profile_review_permitted(r.employment_id)
 LOOP
  IF p_owner='person' THEN
   IF q.proposed->'v'='2'::jsonb THEN fields:=q.proposed->'fields';
   ELSIF jsonb_typeof(q.proposed)='object' AND NOT q.proposed ? 'v' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('fieldId',b.field_id,'value',v.value)),'[]'::jsonb) INTO fields
     FROM jsonb_each(q.proposed) v JOIN app.access_profile_value_bindings() b ON b.legacy_key=v.key AND b.owner IN ('person','compliance');
   ELSE CONTINUE; END IF;
   scalar_delta:=p_delta;
   IF scalar_delta ? 'marital_status_source_request_id' THEN
    SELECT to_jsonb(marital_status) INTO current_marital FROM public.person WHERE id=p_person AND tenant_id=app.current_tenant_id();
    IF scalar_delta->'marital_status_source_request_id'<>'null'::jsonb OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) f
     WHERE f->>'fieldId'='profile.personal_details.maritalstatus' AND app.access_profile_value_editable(f->>'fieldId')
      AND app.access_profile_value_normalized(f->'value')=current_marital) THEN CONTINUE; END IF;
    scalar_delta:=scalar_delta-'marital_status_source_request_id';
   END IF;
   -- Compliance and ordinary Person fields share one physical row, but retain their descriptor owner.
   SELECT COALESCE(jsonb_agg(f),'[]'::jsonb) INTO fields FROM jsonb_array_elements(fields) f;
   matched:=true;
   FOR entry IN SELECT jsonb_build_object('owner',b.owner,'delta',jsonb_object_agg(d.key,d.value))
    FROM jsonb_each(scalar_delta) d LEFT JOIN app.access_profile_value_bindings() b ON b.column_name=d.key AND b.owner IN ('person','compliance') GROUP BY b.owner
   LOOP
    IF entry->>'owner' IS NULL OR NOT app.access_profile_value_delta_matches(entry->>'owner',entry->'delta',fields,false) THEN matched:=false;EXIT;END IF;
   END LOOP;
   IF matched THEN RETURN true; END IF;
  ELSIF q.proposed->'v'='2'::jsonb AND jsonb_typeof(q.proposed->'registers')='array' THEN
   FOR entry IN SELECT v FROM jsonb_array_elements(q.proposed->'registers') v WHERE v->>'kind'=p_owner LOOP
    fields:=entry->'fields';
    IF (NOT p_insert AND entry->>'id'=p_row::text OR p_insert AND entry->'id'='null'::jsonb)
     AND app.access_profile_value_delta_matches(p_owner,p_delta,fields,p_insert,p_relationship_changed) THEN
     IF p_insert THEN
      IF NULLIF(entry->>'clientId','') IS NULL THEN CONTINUE; END IF;
      INSERT INTO app.access_profile_register_application VALUES(pg_current_xact_id(),q.id,p_owner,entry->>'clientId',p_row)
       ON CONFLICT DO NOTHING;
      SELECT row_id INTO bound_row FROM app.access_profile_register_application WHERE xact_id=pg_current_xact_id()
       AND request_id=q.id AND kind=p_owner AND client_id=entry->>'clientId';
      IF bound_row IS DISTINCT FROM p_row THEN CONTINUE; END IF;
     END IF;
     RETURN true;
    END IF;
    -- Exactly the canonical single-Highest / Primary transfer side effect. All other columns on
    -- the former holder must be unchanged. Its replacement must really exist in this same subject.
    promotion:=EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(fields)='array' THEN fields ELSE '[]'::jsonb END) f
     WHERE p_owner='qualification' AND f->>'fieldId'='qualification.academic_and_professional_qualifications.highest' AND f->'value'='true'::jsonb
      AND app.access_profile_value_editable(f->>'fieldId')
      OR p_owner='emergency' AND f->>'fieldId'='profile.emergency_contact.priority' AND f->'value'='"primary"'::jsonb
      AND app.access_profile_value_editable(f->>'fieldId'));
    IF NOT p_insert AND promotion THEN
     IF p_owner='qualification' AND p_delta='{"is_highest":false}'::jsonb AND EXISTS(SELECT 1 FROM public.employee_qualification other
      WHERE other.tenant_id=q.tenant_id AND other.employment_id=q.employment_id AND other.id<>p_row AND other.archived_at IS NULL AND other.is_highest
       AND (entry->'id'='null'::jsonb OR entry->>'id'=other.id::text)) THEN RETURN true; END IF;
     IF p_owner='emergency' AND p_delta='{"priority":"secondary"}'::jsonb AND EXISTS(SELECT 1 FROM public.person_emergency_contact other
      WHERE other.tenant_id=q.tenant_id AND other.person_id=q.person_id AND other.id<>p_row AND other.archived_at IS NULL AND other.priority='primary'
       AND (entry->'id'='null'::jsonb OR entry->>'id'=other.id::text)) THEN RETURN true; END IF;
    END IF;
   END LOOP;
  END IF;
 END LOOP;
 RETURN false;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_value_approved(text,uuid,uuid,uuid,jsonb,boolean,boolean) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.access_profile_value_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb;after_row jsonb;delta jsonb;subject_person uuid;subject_employment uuid;row_id uuid;kind text;direct_allowed boolean;
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
 IF TG_TABLE_NAME='person' THEN
  subject_person:=row_id;kind:='person';direct_allowed:=app.access_workforce_person(subject_person,'workforce.maintain');
  -- Only normal-profile/compliance columns belong to this guard. Photo bytes, PDPA, and country
  -- financial/statutory owners retain their independent permissions and existing write restrictions.
  SELECT COALESCE(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(after_row) d
   WHERE d.value IS DISTINCT FROM before_row->d.key AND (d.key IN (SELECT column_name FROM app.access_profile_value_bindings() WHERE owner IN ('person','compliance'))
    OR d.key IN ('address','address_line1','address_line2','address_line3','postcode','city','state','country','marital_status_source_request_id'));
 ELSE
  kind:=CASE TG_TABLE_NAME WHEN 'employee_dependent' THEN 'dependent' WHEN 'employee_qualification' THEN 'qualification' WHEN 'person_emergency_contact' THEN 'emergency' END;
  IF kind='qualification' THEN
   subject_employment:=COALESCE(after_row->>'employment_id',before_row->>'employment_id')::uuid;
   SELECT person_id INTO subject_person FROM public.employment WHERE id=subject_employment AND tenant_id=app.current_tenant_id();
   direct_allowed:=app.access_workforce_employment(subject_employment,'workforce.maintain');
  ELSE
   subject_person:=COALESCE(after_row->>'person_id',before_row->>'person_id')::uuid;
   direct_allowed:=app.access_workforce_person(subject_person,'workforce.maintain');
  END IF;
  SELECT COALESCE(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(after_row) d
   WHERE d.key NOT IN ('id','tenant_id','person_id','employment_id','created_at','updated_at') AND d.value IS DISTINCT FROM before_row->d.key;
  relationship_changed:=TG_OP='UPDATE' AND after_row->'relationship' IS DISTINCT FROM before_row->'relationship';
 END IF;
 IF app.access_workforce_value_intent_allowed(kind,before_row,after_row,true) THEN RETURN NULL; END IF;
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
REVOKE ALL ON FUNCTION app.access_profile_value_guard() FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE TRIGGER access_profile_value_lock BEFORE INSERT OR UPDATE ON person
FOR EACH STATEMENT EXECUTE FUNCTION app.access_profile_value_statement_lock();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER access_profile_value_guard AFTER INSERT OR UPDATE ON person
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_profile_value_guard();
--> statement-breakpoint
CREATE TRIGGER access_profile_value_lock BEFORE INSERT OR UPDATE OR DELETE ON employee_dependent
FOR EACH STATEMENT EXECUTE FUNCTION app.access_profile_value_statement_lock();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER access_profile_value_guard AFTER INSERT OR UPDATE OR DELETE ON employee_dependent
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_profile_value_guard();
--> statement-breakpoint
CREATE TRIGGER access_profile_value_lock BEFORE INSERT OR UPDATE OR DELETE ON employee_qualification
FOR EACH STATEMENT EXECUTE FUNCTION app.access_profile_value_statement_lock();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER access_profile_value_guard AFTER INSERT OR UPDATE OR DELETE ON employee_qualification
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_profile_value_guard();
--> statement-breakpoint
CREATE TRIGGER access_profile_value_lock BEFORE INSERT OR UPDATE OR DELETE ON person_emergency_contact
FOR EACH STATEMENT EXECUTE FUNCTION app.access_profile_value_statement_lock();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER access_profile_value_guard AFTER INSERT OR UPDATE OR DELETE ON person_emergency_contact
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_profile_value_guard();

--> statement-breakpoint
-- Byte contract of JSON.stringify for the finite route-context projection below: insertion order is
-- preserved by json (not jsonb); structural whitespace is removed without touching string contents.
CREATE FUNCTION app.access_profile_route_json(p_value json) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE result text;
BEGIN
 CASE json_typeof(p_value)
 WHEN 'object' THEN SELECT '{'||COALESCE(string_agg(to_json(e.key)::text||':'||app.access_profile_route_json(e.value),',' ORDER BY e.n),'')||'}' INTO result
  FROM json_each(p_value) WITH ORDINALITY e(key,value,n);
 WHEN 'array' THEN SELECT '['||COALESCE(string_agg(app.access_profile_route_json(e.value),',' ORDER BY e.n),'')||']' INTO result
  FROM json_array_elements(p_value) WITH ORDINALITY e(value,n);
 ELSE result:=p_value::text;
 END CASE;
 RETURN result;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_route_json(json) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Independent SQL witness for the existing subjectContext byte projection in core/profile-routing.
-- Lock the same subject/person/current assignments before admitting a decision, including callers
-- that use raw SQL. Merely matching a route UUID or setting route_maintenance is never sufficient.
CREATE FUNCTION app.access_profile_route_fingerprint(p_subject uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject_row record;as_of date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;current_assignments json;projection json;
BEGIN
 PERFORM 1 FROM public.employment WHERE id=p_subject AND tenant_id=app.current_tenant_id() FOR UPDATE;
 PERFORM 1 FROM public.person p JOIN public.employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id
  WHERE e.id=p_subject AND e.tenant_id=app.current_tenant_id() FOR UPDATE OF p;
 PERFORM 1 FROM public.assignment WHERE employment_id=p_subject AND tenant_id=app.current_tenant_id() AND superseded_at IS NULL
  AND valid_from<=as_of AND (valid_to IS NULL OR valid_to>=as_of) ORDER BY id FOR UPDATE;
 SELECT emp.*,p.gender,p.nationality,p.religion,p.race INTO subject_row FROM public.employment emp
  JOIN public.person p ON p.id=emp.person_id AND p.tenant_id=emp.tenant_id WHERE emp.id=p_subject AND emp.tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT COALESCE(json_agg(json_build_object('id',a.id,'companyId',a.company_id,'departmentId',a.department_id,
  'businessUnitId',a.business_unit_id,'positionId',a.position_id,'costCenterId',a.cost_center_id,'employmentType',a.employment_type) ORDER BY a.id),'[]'::json)
  INTO current_assignments FROM public.assignment a WHERE a.tenant_id=subject_row.tenant_id AND a.employment_id=subject_row.id AND a.superseded_at IS NULL
   AND a.valid_from<=as_of AND (a.valid_to IS NULL OR a.valid_to>=as_of);
 projection:=json_build_object('employment',json_build_object('companyId',subject_row.company_id,'gradeId',subject_row.grade_id,
  'orgDivision',subject_row.org_division,'orgBranch',subject_row.org_branch,'orgRegion',subject_row.org_region,'orgLine',subject_row.org_line,'orgSection',subject_row.org_section,
  'orgTeam',subject_row.org_team,'orgBase',subject_row.org_base,'employmentCategory',subject_row.employment_category,'hiredOn',subject_row.hired_on,
  'confirmationDate',subject_row.confirmation_date,'finalConfirmationDate',subject_row.final_confirmation_date,'probationEndDate',subject_row.probation_end_date,
  'provisionalEndOn',subject_row.provisional_end_on,'resignationDate',subject_row.resignation_date,'lastWorkingDate',subject_row.last_working_date,'terminatedOn',subject_row.terminated_on,
  'blacklistedAt',subject_row.blacklisted_at,
  'gender',subject_row.gender,'nationality',subject_row.nationality,'religion',subject_row.religion,'race',subject_row.race),'assignments',current_assignments);
 RETURN encode(sha256(convert_to(app.access_profile_route_json(projection),'UTF8')),'hex');
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_route_fingerprint(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.access_profile_person_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
  RAISE EXCEPTION 'Profile identity is immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_person_identity() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_profile_person_identity BEFORE UPDATE OF id,tenant_id,created_at ON person
FOR EACH ROW EXECUTE FUNCTION app.access_profile_person_identity();

--> statement-breakpoint
-- Fixed request identity only: callers cannot supply fields, SQL names, a reviewer, scope or an actor.
-- Preparing a real request does not authorize a persisted value change. The actual approval transition
-- must complete in this xid8, and the deferred row guards compare every physical changed value.
CREATE FUNCTION app.access_profile_value_begin(p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.profile_change_request%ROWTYPE;r jsonb;route_enabled boolean;route_digest text;proposal_digest text;prepared boolean;actor uuid;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN; END IF;
 PERFORM app.access_profile_policy_write_lock();
 IF app.principal_snapshot_current() IS NOT TRUE OR app.current_user_id() IS NULL THEN
  RAISE EXCEPTION 'Profile decision principal unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO q FROM public.profile_change_request WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR q.status<>'pending' OR q.proposed->'v'='3'::jsonb
  OR app.access_profile_review_permitted(q.employment_id) IS NOT TRUE OR app.can_admin_employment(q.employment_id) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=q.employment_id AND e.tenant_id=q.tenant_id AND e.person_id=q.person_id) THEN
  RAISE EXCEPTION 'Profile decision write unavailable' USING ERRCODE='42501'; END IF;
 SELECT value INTO r FROM public.tenant_setting WHERE tenant_id=q.tenant_id AND key='ess.profile_change_routing';
 IF r IS NOT NULL AND r<>'null'::jsonb AND (jsonb_typeof(r) IS DISTINCT FROM 'object' OR r->'version' NOT IN ('1'::jsonb,'2'::jsonb)
  OR r->'version' IS NULL OR jsonb_typeof(r->'enabled') IS DISTINCT FROM 'boolean') THEN
  RAISE EXCEPTION 'Profile decision route unavailable' USING ERRCODE='42501'; END IF;
 route_enabled:=COALESCE(r->'enabled'='true'::jsonb,false);
 proposal_digest:=encode(sha256(convert_to(q.proposed::text,'UTF8')),'hex');
 route_digest:=encode(sha256(convert_to(jsonb_build_array(q.route_id,q.route_revision,q.route_approver_user_id,q.route_approver_employment_id,q.route_context)::text,'UTF8')),'hex');
 SELECT EXISTS(SELECT 1 FROM app.access_profile_value_approval p WHERE p.xact_id=pg_current_xact_id() AND p.request_id=q.id
  AND p.tenant_id=q.tenant_id AND p.user_id=app.current_user_id() AND p.proposal_hash=proposal_digest AND p.route_hash=route_digest) INTO prepared;
 IF q.route_id IS NOT NULL THEN
  IF NOT route_enabled OR r->>'revision' IS DISTINCT FROM q.route_revision::text
   OR q.route_approver_user_id IS DISTINCT FROM app.current_user_id()
   OR NOT EXISTS(SELECT 1 FROM app.profile_route_principal(q.route_approver_employment_id,q.employment_id) p WHERE p.user_id=app.current_user_id()) THEN
   RAISE EXCEPTION 'Profile decision route changed' USING ERRCODE='42501'; END IF;
  -- The first preparation locks and validates the BEFORE snapshot. Revalidating after applying a
  -- requested nationality/gender change would incorrectly invalidate its own authorized decision.
  IF NOT prepared AND (q.route_context->>'asOf' IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text
   OR q.route_context->>'fingerprint' IS DISTINCT FROM app.access_profile_route_fingerprint(q.employment_id)) THEN
   RAISE EXCEPTION 'Profile decision subject changed' USING ERRCODE='42501'; END IF;
 ELSIF route_enabled OR q.route_approver_user_id IS NOT NULL OR q.route_approver_employment_id IS NOT NULL THEN
  RAISE EXCEPTION 'Profile decision route changed' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_setting WHERE tenant_id=q.tenant_id AND key='ess.profile_change_approver' AND value='"group_admin"'::jsonb)
  AND app.is_group_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Profile decision group scope required' USING ERRCODE='42501'; END IF;
 INSERT INTO app.access_profile_value_actor VALUES(pg_current_xact_id(),q.tenant_id,app.current_user_id()) ON CONFLICT DO NOTHING;
 SELECT user_id INTO actor FROM app.access_profile_value_actor WHERE xact_id=pg_current_xact_id() AND tenant_id=q.tenant_id;
 IF actor IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Profile write principal changed' USING ERRCODE='42501'; END IF;
 INSERT INTO app.access_profile_value_approval(xact_id,tenant_id,request_id,user_id,proposal_hash,route_hash)
  VALUES(pg_current_xact_id(),q.tenant_id,q.id,app.current_user_id(),proposal_digest,route_digest) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM app.access_profile_value_approval p WHERE p.xact_id=pg_current_xact_id() AND p.request_id=q.id
  AND p.tenant_id=q.tenant_id AND p.user_id=app.current_user_id() AND p.proposal_hash=proposal_digest AND p.route_hash=route_digest) THEN
  RAISE EXCEPTION 'Profile decision preparation changed' USING ERRCODE='42501'; END IF;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_value_begin(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_profile_value_begin(uuid) TO ai_hr_app;

--> statement-breakpoint
-- A permitted ESS value write must complete with the canonical immutable decision event as well as
-- its request transition. This trigger attests only the actual event insert, never a caller boolean.
CREATE FUNCTION app.access_profile_value_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.aggregate_type='profile-change' AND NEW.event_type='profile-change.approved'
  AND NEW.actor_type='user' AND NEW.actor_id=app.current_user_id() AND NEW.tenant_id=app.current_tenant_id() THEN
  UPDATE app.access_profile_value_approval proof SET audited=true
   FROM public.profile_change_request r WHERE proof.xact_id=pg_current_xact_id() AND proof.request_id=NEW.aggregate_id
    AND proof.tenant_id=NEW.tenant_id AND proof.user_id=NEW.actor_id AND proof.approved AND r.id=proof.request_id
    AND r.tenant_id=proof.tenant_id AND r.status='approved' AND r.employment_id=NEW.subject_employment_id;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_value_audit() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_profile_value_audit AFTER INSERT ON domain_event
FOR EACH ROW WHEN (NEW.aggregate_type='profile-change' AND NEW.event_type='profile-change.approved') EXECUTE FUNCTION app.access_profile_value_audit();

--> statement-breakpoint
-- A stable physical policy anchor also fences a pre-pinned REPEATABLE READ snapshot when a formerly
-- absent ESS setting is first inserted. Reads lock it; only real policy writes advance it. This is
-- not a tenant policy edit, access revision, or user-visible history entry on a read operation.
CREATE TABLE app.access_profile_write_generation (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,generation bigint NOT NULL DEFAULT 0
);
--> statement-breakpoint
REVOKE ALL ON TABLE app.access_profile_write_generation FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE app.access_profile_write_generation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO app.access_profile_write_generation(tenant_id) SELECT id FROM public.tenant;
--> statement-breakpoint
CREATE FUNCTION app.access_profile_write_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO app.access_profile_write_generation(tenant_id) VALUES(NEW.id);
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_write_tenant() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_profile_write_tenant AFTER INSERT ON tenant
FOR EACH ROW EXECUTE FUNCTION app.access_profile_write_tenant();

--> statement-breakpoint
CREATE FUNCTION app.access_profile_policy_write_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtextextended('profile-edit-policy:'||app.current_tenant_id()::text,0));
 -- The Workforce barrier owns the common physical generation check.
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_policy_write_lock() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_profile_policy_write_lock() TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.access_profile_setting_statement_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN PERFORM app.access_profile_policy_write_lock(); END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_setting_statement_lock() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_profile_setting_lock BEFORE INSERT OR UPDATE OR DELETE ON tenant_setting
FOR EACH STATEMENT EXECUTE FUNCTION app.access_profile_setting_statement_lock();

--> statement-breakpoint
CREATE FUNCTION app.access_profile_setting_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;t uuid;
BEGIN
 IF TG_OP='UPDATE' AND before_row=after_row THEN RETURN NULL; END IF;
 FOR t IN SELECT DISTINCT (v->>'tenant_id')::uuid FROM (VALUES(before_row),(after_row)) entries(v)
  WHERE v->>'key' IN ('ess.profile_change_fields','ess.profile_change_routing','ess.profile_change_approver','ess.profile_photo_edit') ORDER BY 1
 LOOP
  IF NOT app.access_workforce_storage_owner() AND t IS DISTINCT FROM app.current_tenant_id() THEN
   RAISE EXCEPTION 'Profile policy tenant unavailable' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('profile-edit-policy:'||t::text,0));
  UPDATE app.access_profile_write_generation SET generation=generation+1 WHERE tenant_id=t;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile policy generation unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_setting_generation() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_profile_setting_generation AFTER INSERT OR UPDATE OR DELETE ON tenant_setting
FOR EACH ROW EXECUTE FUNCTION app.access_profile_setting_generation();

--> statement-breakpoint
CREATE FUNCTION app.access_profile_setting_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.key IS DISTINCT FROM OLD.key) THEN
  RAISE EXCEPTION 'Setting identity is immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_setting_identity() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_profile_setting_identity BEFORE UPDATE OF tenant_id,key ON tenant_setting
FOR EACH ROW EXECUTE FUNCTION app.access_profile_setting_identity();

--> statement-breakpoint
-- Compatibility with the independent, fixed 0485 Marriage Leave commands. These exact two effects
-- were already callable without general Personnel maintenance; no other Person column inherits it.
-- The persisted cause and absence of live siblings remain the reversal's authoritative facts.
CREATE FUNCTION app.access_profile_marriage_delta(p_before jsonb,p_after jsonb,p_delta jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source_id uuid;source_group uuid;source_person uuid;source_status text;marriage boolean;
BEGIN
 IF p_after->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text OR p_after->>'id' IS DISTINCT FROM p_before->>'id'
  OR (p_delta-ARRAY['marital_status','marital_status_source_request_id'])<>'{}'::jsonb THEN RETURN false; END IF;
 IF p_before->>'marital_status'='single' AND p_after->>'marital_status'='married' AND p_after->>'marital_status_source_request_id' IS NOT NULL THEN
  source_id:=(p_after->>'marital_status_source_request_id')::uuid;
 ELSIF p_before->>'marital_status'='married' AND p_after->>'marital_status'='single'
  AND p_before->>'marital_status_source_request_id' IS NOT NULL AND p_after->>'marital_status_source_request_id' IS NULL THEN
  source_id:=(p_before->>'marital_status_source_request_id')::uuid;
 ELSE RETURN false; END IF;
 SELECT e.person_id,r.parent_group_id,r.status::text,
  CASE WHEN COALESCE(btrim(lt.role),'')<>'' THEN btrim(lt.role)='marriage' ELSE upper(btrim(lt.code))='MARRIAGE' END
  INTO source_person,source_group,source_status,marriage FROM public.leave_request r
  JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  JOIN public.leave_type lt ON lt.id=r.leave_type_id AND lt.tenant_id=r.tenant_id
  WHERE r.id=source_id AND r.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR marriage IS NOT TRUE OR source_person::text IS DISTINCT FROM p_after->>'id' THEN RETURN false; END IF;
 IF p_after->>'marital_status'='married' THEN RETURN source_status='approved'; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM public.leave_request sibling WHERE sibling.tenant_id=app.current_tenant_id()
  AND sibling.status='approved' AND (sibling.id=source_id OR source_group IS NOT NULL AND sibling.parent_group_id=source_group));
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_marriage_delta(jsonb,jsonb,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- First access initialization is also a permission generation change, even when an old snapshot
-- cannot yet see its new access_configuration tuple. The pre-existing tenant anchor closes that gap.
CREATE FUNCTION app.access_profile_access_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 UPDATE app.access_profile_write_generation SET generation=generation+1 WHERE tenant_id=t;
 IF NOT FOUND THEN RAISE EXCEPTION 'Access policy generation unavailable' USING ERRCODE='42501'; END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_access_generation() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_profile_access_generation AFTER INSERT OR UPDATE OR DELETE ON access_configuration
FOR EACH ROW EXECUTE FUNCTION app.access_profile_access_generation();

--> statement-breakpoint
-- Positive maintenance for one selected employment's shared Person. Denials on any retained
-- employment continue to cap shared facts; a grant does not become a legacy HR role or raw-row grant.
CREATE FUNCTION app.access_workforce_command_person(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment selected WHERE selected.id=p_employment AND selected.tenant_id=app.current_tenant_id()
  AND app.access_workforce_command_company(selected.company_id)
  AND NOT EXISTS(SELECT 1 FROM public.employment retained WHERE retained.person_id=selected.person_id AND retained.tenant_id=selected.tenant_id
   AND (NOT app.access_workforce_not_denied(retained.company_id,'workforce.maintain') OR NOT app.access_workforce_not_denied(retained.company_id,'workforce.view'))));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_command_person(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_command_person(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Kernel validators and the fixed SQL command share the same current catalog/legacy-tolerance owner.
-- Profile Options were already tenant-readable. This function reveals only acceptance of a value,
-- never a Person, account, company grant or other employee's stored value.
CREATE FUNCTION app.profile_option_value_allowed(p_category text,p_value text,p_legacy text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_value IS NULL OR p_value='' OR p_value IS NOT DISTINCT FROM p_legacy
  OR NOT EXISTS(SELECT 1 FROM public.profile_option p WHERE p.tenant_id=app.current_tenant_id() AND p.category=p_category)
  OR EXISTS(SELECT 1 FROM public.profile_option p WHERE p.tenant_id=app.current_tenant_id() AND p.category=p_category AND p.value=p_value AND p.is_active);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_option_value_allowed(text,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.profile_option_value_allowed(text,text,text) TO ai_hr_app;

--> statement-breakpoint
CREATE TABLE app.access_workforce_value_intent (
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 user_id uuid NOT NULL,employment_id uuid NOT NULL REFERENCES public.employment(id) ON DELETE CASCADE,
 kind text NOT NULL,row_id uuid NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,
 audit_root uuid NOT NULL,event_type text NOT NULL,event_id uuid REFERENCES public.domain_event(id) ON DELETE SET NULL,
 PRIMARY KEY(xact_id,kind,row_id,after_hash)
);
--> statement-breakpoint
REVOKE ALL ON TABLE app.access_workforce_value_intent FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE app.access_workforce_value_intent ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
CREATE FUNCTION app.access_workforce_value_intent_allowed(p_kind text,p_before jsonb,p_after jsonb,p_complete boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.access_workforce_value_intent i LEFT JOIN public.domain_event event ON event.id=i.event_id
  WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id()
   AND i.kind=p_kind AND i.row_id=(p_after->>'id')::uuid
   AND i.before_hash=encode(sha256(convert_to(p_before::text,'UTF8')),'hex')
   AND i.after_hash=encode(sha256(convert_to(p_after::text,'UTF8')),'hex')
   AND CASE WHEN p_kind='qualification' THEN app.access_workforce_command_allowed(i.employment_id) ELSE app.access_workforce_command_person(i.employment_id) END
   AND (NOT p_complete OR event.tenant_id=i.tenant_id AND event.aggregate_id=i.audit_root AND event.event_type=i.event_type
    AND event.subject_employment_id=i.employment_id AND event.actor_type='user' AND event.actor_id=i.user_id));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_value_intent_allowed(text,jsonb,jsonb,boolean) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Existing DTO vocabulary plus opaque row revisions. No internal Person id, whole master rows,
-- statutory/compensation/bank data, private classification, document bytes or proposal values.
CREATE FUNCTION app.access_workforce_editor(p_employment uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.employment%ROWTYPE;profile_revision text;profile_values jsonb;registers jsonb;
BEGIN
 SELECT * INTO selected FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.access_workforce_projection_company(selected.company_id) THEN RETURN NULL; END IF;
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
  'employmentMaintain',app.access_workforce_command_allowed(selected.id),'registers',registers);
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_editor(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_editor(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.access_workforce_value_shape(p_kind text,p_key text,p_value jsonb,p_previous jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field_binding record;value text;parsed date;category text;
BEGIN
 SELECT * INTO field_binding FROM app.access_profile_value_bindings() b WHERE b.field_name=p_key
  AND CASE WHEN p_kind='person' THEN b.owner IN ('person','compliance') ELSE b.owner=p_kind END;
 IF NOT FOUND THEN RETURN false; END IF;
 IF p_value IS NOT DISTINCT FROM p_previous THEN RETURN true; END IF;
 IF p_value='null'::jsonb THEN RETURN p_key NOT IN ('fullName','primaryEmail','qualification','isHighest','priority','relationship','isBeneficiary','isDeceased'); END IF;
 IF p_key IN ('isHighest','isBeneficiary','isDeceased','isStudent','spouseWorking','childTaxRelief') THEN RETURN jsonb_typeof(p_value)='boolean'; END IF;
 IF p_kind='dependent' AND p_key='childReliefPercentage' THEN RETURN p_value#>>'{}' IN ('50','100'); END IF;
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 value:=p_value#>>'{}';
 IF length(value)>4000 THEN RETURN false; END IF;
 IF p_key IN ('fullName','primaryEmail','qualification') AND value='' THEN RETURN false; END IF;
 IF p_key IN ('primaryEmail','personalEmail') AND value<>'' AND value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RETURN false; END IF;
 IF p_key='gender' AND value NOT IN ('male','female','undisclosed') THEN RETURN false; END IF;
 IF p_key='maritalStatus' AND value NOT IN ('single','married','divorced','widowed','separated','other') THEN RETURN false; END IF;
 IF p_kind='emergency' AND p_key='priority' AND value NOT IN ('primary','secondary','other') THEN RETURN false; END IF;
 IF p_kind='dependent' THEN
  IF p_key='marriageStatus' AND value NOT IN ('married','divorced','widowed','separated') THEN RETURN false; END IF;
  IF p_key='childReliefCategory' AND value NOT IN ('under_18','study_preu','study_tertiary','disabled','disabled_study') THEN RETURN false; END IF;
  IF p_key='relationship' THEN RETURN value IN ('spouse','child','parent','sibling','other') OR EXISTS(SELECT 1 FROM public.profile_option o WHERE o.tenant_id=app.current_tenant_id() AND o.category='dependentRelationship' AND o.value=access_workforce_value_shape.value AND o.is_active); END IF;
 END IF;
 IF p_key IN ('dateOfBirth','graduationDate','marriageDate') THEN
  IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
  BEGIN parsed:=value::date;EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;END;
  IF to_char(parsed,'YYYY-MM-DD')<>value THEN RETURN false; END IF;
 END IF;
 IF p_key IN ('fromYm','toYm') AND value !~ '^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$' THEN RETURN false; END IF;
 category:=CASE WHEN p_key IN ('salutation','religion','race','nationality') THEN p_key
  WHEN p_key IN ('permanentState','correspondenceState') THEN 'state'
  WHEN p_key IN ('permanentCountry','correspondenceCountry') THEN 'country'
  WHEN p_kind='qualification' AND p_key='qualification' THEN 'qualificationLevel'
  WHEN p_kind='emergency' AND p_key='relationship' THEN 'relationship' END;
 IF category IS NOT NULL THEN RETURN app.profile_option_value_allowed(category,value,p_previous#>>'{}'); END IF;
 RETURN true;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_value_shape(text,text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- One bounded command for normal profile and registers. Family effects call the private country
-- owner atomically and return no tax values. No table/column names are accepted from callers.
CREATE FUNCTION app.access_workforce_maintain_record(p_employment uuid,p_kind text,p_row uuid,p_operation text,p_patch jsonb,p_expected text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.employment%ROWTYPE;before_row jsonb;after_row jsonb;normalized jsonb:='{}'::jsonb;
 version text;target_id uuid;table_name text;subject_column text;subject_id uuid;event_name text;aggregate_name text;
 assignments text;insert_columns text;insert_values text;field_names jsonb;pair record;binding record;value jsonb;
 previous record;previous_after jsonb;event_id uuid;instant timestamptz:=now();changed boolean;effect_id uuid;relationship text;
BEGIN
 IF p_kind IS NULL OR p_operation IS NULL OR p_kind NOT IN ('person','qualification','emergency','dependent') OR p_operation NOT IN ('add','update','archive')
  OR jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR octet_length(p_patch::text)>128000 THEN
  RAISE EXCEPTION 'Workforce input invalid' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_patch))>40 OR p_kind='person' AND (p_operation<>'update' OR p_row IS NOT NULL)
  OR p_kind<>'person' AND ((p_operation='add') IS DISTINCT FROM (p_row IS NULL)) THEN
  RAISE EXCEPTION 'Workforce input invalid' USING ERRCODE='22023'; END IF;
 PERFORM app.access_profile_policy_write_lock();
 SELECT * INTO selected FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.current_user_id() IS NULL OR NOT app.access_workforce_command_company(selected.company_id)
  OR p_kind<>'qualification' AND NOT app.access_workforce_command_person(selected.id) THEN
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
   jsonb_build_object('fields',field_names,'via','workforce-maintenance','transferFromId',effect_id)) RETURNING id INTO event_id;
 UPDATE app.access_workforce_value_intent SET event_id=access_workforce_maintain_record.event_id
  WHERE xact_id=pg_current_xact_id() AND tenant_id=selected.tenant_id AND user_id=app.current_user_id() AND audit_root=target_id AND event_type=event_name;
 IF p_kind='dependent' THEN PERFORM app.my_sync_family_child_relief(selected.person_id); END IF;
 RETURN jsonb_build_object('id',target_id,'changed',true,'hrReviewNotice',p_kind='dependent');
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_maintain_record(uuid,text,uuid,text,jsonb,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_maintain_record(uuid,text,uuid,text,jsonb,text) TO ai_hr_app;

--> statement-breakpoint
-- Installed projection of lib/family-child-relief-rule.json. JS/SQL byte and executed outcome
-- parity are mandatory. This derives facts only; rates/money remain in the country pack.
CREATE FUNCTION app.my_family_child_relief_eligible(d public.employee_dependent,p_as_of date) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT ((d.relationship IS NOT DISTINCT FROM 'child') AND (NOT COALESCE(d.is_deceased,false)) AND (NOT (d.archived_at IS NOT NULL)) AND (NOT (d.child_tax_relief IS NOT DISTINCT FROM false)) AND (COALESCE(d.is_student,false) OR (d.date_of_birth IS NOT NULL AND (extract(year FROM p_as_of)::int-extract(year FROM d.date_of_birth)::int-(to_char(p_as_of,'MM-DD')<to_char(d.date_of_birth,'MM-DD'))::int)<18) OR ((d.child_tax_relief IS NOT DISTINCT FROM true) AND COALESCE(d.child_relief_category IN ('study_preu','study_tertiary','disabled','disabled_study'),false))));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.my_family_child_relief_eligible(public.employee_dependent,date) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.my_family_grid_complete(p_eligible integer,p_categorised integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT ((p_eligible IS NOT DISTINCT FROM p_categorised) AND COALESCE(p_eligible>0,false));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.my_family_grid_complete(integer,integer) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Private Malaysia automatic Family owner. No caller count/grid/tax patch, no general tax read
-- grant. Manual mode and every unrelated statutory value remain byte-for-value unchanged.
CREATE FUNCTION app.my_sync_family_child_relief(p_person uuid,p_at timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();stat public.employee_statutory_my%ROWTYPE;derived integer;categorised integer;grid jsonb;old_grid jsonb;
 as_of date:=(p_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date;period text:=to_char(p_at AT TIME ZONE 'UTC','YYYY-MM');batches integer;
 subject uuid;country text;countries integer;before_values jsonb;after_values jsonb;
 no_sync jsonb:=jsonb_build_object('changed',false,'before',NULL,'after',NULL,'payrollAlert',NULL);
BEGIN
 IF p_at IS NULL OR NOT isfinite(p_at) THEN RAISE EXCEPTION 'Family derivation clock invalid' USING ERRCODE='22023'; END IF;
 PERFORM app.access_profile_policy_write_lock();
 PERFORM 1 FROM public.person WHERE id=p_person AND tenant_id=t FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Family subject unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO stat FROM public.employee_statutory_my WHERE tenant_id=t AND person_id=p_person FOR UPDATE;
 IF NOT FOUND THEN RETURN no_sync||jsonb_build_object('skipped','no_statutory_row'); END IF;
 IF stat.child_relief_mode IS DISTINCT FROM 'auto' THEN RETURN no_sync||jsonb_build_object('skipped','manual_mode'); END IF;
 SELECT count(*)::integer,count(*) FILTER(WHERE d.child_relief_category IN ('under_18','study_preu','study_tertiary','disabled','disabled_study'))::integer
  INTO derived,categorised FROM public.employee_dependent d
  WHERE d.tenant_id=t AND d.person_id=p_person AND app.my_family_child_relief_eligible(d,as_of);
 SELECT COALESCE(jsonb_object_agg(category,jsonb_build_object('full',full_count,'half',half_count)),'{}'::jsonb) INTO grid FROM (
  SELECT d.child_relief_category category,count(*) FILTER(WHERE d.child_relief_percentage IS DISTINCT FROM 50) full_count,
   count(*) FILTER(WHERE d.child_relief_percentage=50) half_count FROM public.employee_dependent d
  WHERE d.tenant_id=t AND d.person_id=p_person AND app.my_family_child_relief_eligible(d,as_of)
   AND d.child_relief_category IN ('under_18','study_preu','study_tertiary','disabled','disabled_study') GROUP BY d.child_relief_category
 ) counts;
 IF NOT app.my_family_grid_complete(derived,categorised) THEN grid:=NULL; END IF;
 -- Match the existing canonical grid comparison: absent/zero cells are equivalent, key order is not meaning.
 SELECT COALESCE(jsonb_object_agg(key,jsonb_build_object('full',COALESCE(value->>'full','0')::numeric,'half',COALESCE(value->>'half','0')::numeric)),'{}'::jsonb)
  INTO old_grid FROM jsonb_each(COALESCE(stat.child_relief_table,'{}'::jsonb))
  WHERE COALESCE(value->>'full','0')::numeric<>0 OR COALESCE(value->>'half','0')::numeric<>0;
 IF stat.num_children=derived AND old_grid=COALESCE(grid,'{}'::jsonb) THEN RETURN no_sync||jsonb_build_object('skipped','unchanged'); END IF;
 SELECT count(DISTINCT c.country)::integer,min(c.country) INTO countries,country FROM public.employment e JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id WHERE e.tenant_id=t AND e.person_id=p_person;
 -- No invented jurisdiction when retained employments disagree. The ordinary non-enclosing caller
 -- retains its established NO_SYNC(error); an enclosing activation/command rolls back on this refusal.
 IF countries<>1 OR country IS DISTINCT FROM 'MY' OR EXISTS(SELECT 1 FROM public.employment e JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id WHERE e.tenant_id=t AND e.person_id=p_person AND c.country IS NULL) THEN
  RAISE EXCEPTION 'Family automatic relief jurisdiction unavailable' USING ERRCODE='0A000'; END IF;
 SELECT e.id INTO subject FROM public.employment e WHERE e.tenant_id=t AND e.person_id=p_person ORDER BY (e.terminated_on IS NOT NULL),e.hired_on,e.id LIMIT 1;
 SELECT count(*)::integer INTO batches FROM public.payroll_batch p WHERE p.tenant_id=t AND p.pay_period=period AND p.status<>'closed'
  AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=t AND e.person_id=p_person AND e.company_id=p.company_id);
 before_values:=jsonb_build_object('numChildren',stat.num_children,'childReliefMode',stat.child_relief_mode,'childReliefTable',stat.child_relief_table);
 after_values:=jsonb_build_object('numChildren',derived,'childReliefMode',stat.child_relief_mode,'childReliefTable',grid);
 UPDATE public.employee_statutory_my SET num_children=derived,child_relief_table=grid,updated_at=now() WHERE id=stat.id AND tenant_id=t;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(t,'employee-statutory',stat.id,'employee.tax.updated',CASE WHEN app.current_user_id() IS NULL THEN 'system' ELSE 'user' END,app.current_user_id(),subject,
   jsonb_build_object('personId',p_person,'before',before_values,'after',after_values,'auto',true,'provenance','auto_child_relief','derivedOn',as_of,'payrollAlert',CASE WHEN batches>0 THEN jsonb_build_object('period',period,'batches',batches) ELSE NULL END));
 RETURN jsonb_build_object('changed',true,'before',stat.num_children,'after',derived,'payrollAlert',CASE WHEN batches>0 THEN jsonb_build_object('period',period,'batches',batches) ELSE NULL END,'skipped',NULL);
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.my_sync_family_child_relief(uuid,timestamptz) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Ordinary kernel caller retains the existing statutory setter's read AND write floor. A new
-- Workforce maintainer reaches the private owner only as part of its exact Family command.
CREATE FUNCTION app.access_family_relief_sync(p_person uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner() AND (NOT app.principal_snapshot_current() OR NOT app.is_admin() OR NOT app.can_see_person(p_person)) THEN
  RAISE EXCEPTION 'Family automatic relief unavailable' USING ERRCODE='42501'; END IF;
 RETURN app.my_sync_family_child_relief(p_person);
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_family_relief_sync(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_family_relief_sync(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Tax audit payloads follow the same financial reader boundary as the underlying statutory row.
-- A Workforce grant/ordinary reporting relationship alone cannot reveal a retained tax value.
CREATE FUNCTION app.access_tax_audit_read(p_statutory uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND (app.is_admin() OR EXISTS(
  SELECT 1 FROM public.employee_statutory_my s WHERE s.id=p_statutory AND s.tenant_id=app.current_tenant_id()
   AND (app.is_self_person(s.person_id) OR EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=s.person_id AND e.tenant_id=s.tenant_id AND app.can_admin_payroll_for(e.company_id)))));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_tax_audit_read(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_tax_audit_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY access_tax_audit_read ON public.domain_event AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(event_type<>'employee.tax.updated' OR app.access_tax_audit_read(aggregate_id));

--> statement-breakpoint
-- Ordinary flat Workforce facts only. Grade, compensation, statutory and resignation/dated
-- consequences keep their own owners; this is not a blanket employment-row write permission.
CREATE FUNCTION app.access_workforce_flat_info_columns() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT ARRAY['org_branch','org_division','org_region','org_line','org_section','org_team','org_base','employment_category','contract_remark']::text[];
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_flat_info_columns() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_flat_info_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM jsonb_each(to_jsonb(NEW)) d WHERE d.key=ANY(app.access_workforce_flat_info_columns()) AND d.value IS DISTINCT FROM to_jsonb(OLD)->d.key)
  OR app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  OR NOT app.access_workforce_company(OLD.company_id,'workforce.maintain') OR NOT app.access_workforce_company(NEW.company_id,'workforce.maintain') THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_flat_info_update() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_workforce_flat_info_lock BEFORE UPDATE OF org_branch,org_division,org_region,org_line,org_section,org_team,org_base,employment_category,contract_remark ON employment
FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
--> statement-breakpoint
CREATE TRIGGER access_workforce_flat_info_update BEFORE UPDATE OF org_branch,org_division,org_region,org_line,org_section,org_team,org_base,employment_category,contract_remark ON employment
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_flat_info_update();

--> statement-breakpoint
-- Closed Workforce binding selection. Physical names/meaning still come from the Personnel
-- projection; ESS visibility or a new self-service binding cannot grant a new Workforce field.
CREATE FUNCTION app.access_workforce_command_fields(p_kind text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE p_kind
  WHEN 'person' THEN ARRAY['salutation','fullName','firstName','lastName','preferredName','nationality','religion','race','dateOfBirth','gender','maritalStatus','primaryEmail','phone','homePhone','personalEmail','permanentAddressLine1','permanentAddressLine2','permanentAddressLine3','permanentPostcode','permanentCity','permanentState','permanentCountry','correspondenceAddressLine1','correspondenceAddressLine2','correspondenceAddressLine3','correspondencePostcode','correspondenceCity','correspondenceState','correspondenceCountry','correspondenceMobilePhone','correspondenceHomePhone']
  WHEN 'qualification' THEN ARRAY['qualification','institute','fromYm','toYm','graduationDate','major','result','description','isHighest']
  WHEN 'emergency' THEN ARRAY['fullName','relationship','mobilePhone','homePhone','address','priority']
  WHEN 'dependent' THEN ARRAY['relationship','fullName','gender','dateOfBirth','phone','icOrPassport','passportNumber','residentialAddress','marriageDate','marriageStatus','spouseWorking','isBeneficiary','isDeceased','isStudent','schoolName','studyLevel','studyCountry','childReliefCategory','childTaxRelief','childReliefPercentage']
  ELSE ARRAY[]::text[] END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_command_fields(text) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Termination commands may close only their actual graph, including cross-scope incoming edges. An
-- independent resignation decision can authorize only its fixed pending request consequence. This is
-- private transaction evidence, never a role, caller-set mode or standing permission on a shared row.
CREATE TABLE app.access_termination_intent (
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,employment_id uuid NOT NULL,
 request_id uuid,termination_on date NOT NULL,expected_patch jsonb NOT NULL,
 termination_event uuid,resignation_event uuid,
 PRIMARY KEY(xact_id,tenant_id,user_id,employment_id)
);
--> statement-breakpoint
REVOKE ALL ON TABLE app.access_termination_intent FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE app.access_termination_intent ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION app.access_prepare_resignation_termination(p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.resignation_request%ROWTYPE;e public.employment%ROWTYPE;patch jsonb;existing app.access_termination_intent%ROWTYPE;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Resignation decision unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.resignation_request WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR r.status<>'pending' THEN RAISE EXCEPTION 'Resignation decision unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO e FROM public.employment WHERE id=r.employment_id AND tenant_id=r.tenant_id AND person_id=r.person_id FOR UPDATE;
 -- Retain the existing admin-for-subject decision floor and super-admin self-decision exception.
 IF NOT FOUND OR NOT app.can_admin_employment(e.id)
  OR (app.is_self_person(e.person_id) AND NOT app.has_role_for('super_admin',e.company_id)) THEN
  RAISE EXCEPTION 'Resignation decision unavailable' USING ERRCODE='42501'; END IF;
 patch:=jsonb_build_object('terminated_on',r.last_working_day,'termination_type','voluntary',
  'termination_reason',CASE WHEN r.reason IS NULL THEN 'Resignation' ELSE NULLIF(btrim(r.reason),'') END);
 SELECT * INTO existing FROM app.access_termination_intent WHERE xact_id=pg_current_xact_id()
  AND tenant_id=r.tenant_id AND user_id=app.current_user_id() AND employment_id=e.id;
 IF FOUND THEN
  IF existing.request_id<>r.id OR existing.expected_patch<>patch THEN
   RAISE EXCEPTION 'Resignation consequence changed' USING ERRCODE='40001'; END IF;
  RETURN;
 END IF;
 INSERT INTO app.access_termination_intent(xact_id,tenant_id,user_id,employment_id,request_id,termination_on,expected_patch)
 VALUES(pg_current_xact_id(),r.tenant_id,app.current_user_id(),e.id,r.id,r.last_working_day,patch);
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_prepare_resignation_termination(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_prepare_resignation_termination(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_assert_termination(p_employment uuid,p_patch jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE existing app.access_termination_intent%ROWTYPE;termination_date date;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.access_workforce_storage_owner() THEN RETURN; END IF;
 IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR NOT p_patch ? 'terminated_on'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_patch) key WHERE key NOT IN
   ('terminated_on','termination_type','termination_reason','termination_reason_code','termination_notice_days')) THEN
  RAISE EXCEPTION 'Invalid termination consequence' USING ERRCODE='22023'; END IF;
 termination_date:=(p_patch->>'terminated_on')::date;
 IF termination_date IS NULL OR NOT isfinite(termination_date) THEN
  RAISE EXCEPTION 'Invalid termination consequence' USING ERRCODE='22023'; END IF;
 SELECT * INTO existing FROM app.access_termination_intent WHERE xact_id=pg_current_xact_id()
  AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND employment_id=p_employment;
 IF FOUND THEN
  IF existing.expected_patch<>p_patch THEN RAISE EXCEPTION 'Termination consequence changed' USING ERRCODE='40001'; END IF;
  RETURN;
 END IF;
 IF NOT app.access_workforce_employment(p_employment,'workforce.maintain') THEN
  RAISE EXCEPTION 'Termination consequence unavailable' USING ERRCODE='42501'; END IF;
 -- Direct maintenance can also close incoming edges whose subordinate belongs to a different scope.
 -- Its exact graph consequence still requires the real termination event before commit.
 INSERT INTO app.access_termination_intent(xact_id,tenant_id,user_id,employment_id,termination_on,expected_patch)
 VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),p_employment,termination_date,p_patch);
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_assert_termination(uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_assert_termination(uuid,jsonb) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.access_termination_intent_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.tenant_id=app.current_tenant_id() AND NEW.actor_type='user' AND NEW.actor_id=app.current_user_id() THEN
  IF NEW.event_type='employment.terminated' THEN
   UPDATE app.access_termination_intent proof SET termination_event=NEW.id
    WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=NEW.actor_id
     AND proof.employment_id=NEW.aggregate_id AND proof.employment_id=NEW.subject_employment_id
     AND NEW.payload->>'terminationDate'=proof.termination_on::text
     AND NEW.payload->>'terminationType' IS NOT DISTINCT FROM proof.expected_patch->>'termination_type'
     AND NEW.payload->>'terminationReason' IS NOT DISTINCT FROM proof.expected_patch->>'termination_reason'
     AND (NOT proof.expected_patch ? 'termination_reason_code' OR NEW.payload->'terminationReasonCode' IS NOT DISTINCT FROM proof.expected_patch->'termination_reason_code')
     AND (NOT proof.expected_patch ? 'termination_notice_days' OR NEW.payload->'terminationNoticeDays' IS NOT DISTINCT FROM proof.expected_patch->'termination_notice_days');
  ELSIF NEW.event_type='resignation.accepted' THEN
   UPDATE app.access_termination_intent proof SET resignation_event=NEW.id
    WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=NEW.tenant_id AND proof.user_id=NEW.actor_id
     AND proof.request_id=NEW.aggregate_id AND proof.employment_id=NEW.subject_employment_id
     AND NEW.payload->>'decision'='accepted' AND NEW.payload->>'lastWorkingDay'=proof.termination_on::text;
  END IF;
 END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_termination_intent_audit() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_termination_intent_audit AFTER INSERT ON domain_event
FOR EACH ROW EXECUTE FUNCTION app.access_termination_intent_audit();
--> statement-breakpoint
CREATE FUNCTION app.access_termination_intent_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof app.access_termination_intent%ROWTYPE;
BEGIN
 SELECT * INTO proof FROM app.access_termination_intent WHERE xact_id=NEW.xact_id AND tenant_id=NEW.tenant_id
  AND user_id=NEW.user_id AND employment_id=NEW.employment_id;
 IF NOT FOUND OR proof.termination_event IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=proof.employment_id AND e.tenant_id=proof.tenant_id AND to_jsonb(e) @> proof.expected_patch)
  OR (proof.request_id IS NOT NULL AND (proof.resignation_event IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.resignation_request r WHERE r.id=proof.request_id AND r.tenant_id=proof.tenant_id AND r.employment_id=proof.employment_id
    AND r.status='accepted' AND r.decided_at IS NOT NULL AND r.last_working_day=proof.termination_on))) THEN
  RAISE EXCEPTION 'Incomplete termination consequence' USING ERRCODE='42501'; END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_termination_intent_complete() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER access_termination_intent_complete AFTER INSERT OR UPDATE ON app.access_termination_intent
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_termination_intent_complete();

--> statement-breakpoint
CREATE FUNCTION app.access_workforce_lifecycle_update() RETURNS trigger
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
 IF app.access_workforce_company(OLD.company_id,'workforce.maintain') AND app.access_workforce_company(NEW.company_id,'workforce.maintain') THEN RETURN NEW; END IF;
 SELECT * INTO proof FROM app.access_termination_intent WHERE xact_id=pg_current_xact_id()
  AND tenant_id=OLD.tenant_id AND user_id=app.current_user_id() AND employment_id=OLD.id;
 IF NOT FOUND OR NOT to_jsonb(NEW) @> proof.expected_patch OR EXISTS(
  SELECT 1 FROM jsonb_each(delta) d WHERE NOT proof.expected_patch ? d.key OR d.value IS DISTINCT FROM proof.expected_patch->d.key) THEN
  RAISE EXCEPTION 'Workforce lifecycle maintenance unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_lifecycle_update() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_workforce_lifecycle_lock BEFORE UPDATE OF id,tenant_id,person_id,company_id,hired_on,join_date,resignation_date,last_working_date,terminated_on,termination_type,termination_reason,termination_reason_code,termination_notice_days,blacklisted_at,blacklist_reason ON employment
FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
--> statement-breakpoint
CREATE TRIGGER access_workforce_lifecycle_update BEFORE UPDATE OF id,tenant_id,person_id,company_id,hired_on,join_date,resignation_date,last_working_date,terminated_on,termination_type,termination_reason,termination_reason_code,termination_notice_days,blacklisted_at,blacklist_reason ON employment
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_lifecycle_update();

--> statement-breakpoint
-- All assignment writers are Workforce/hire/correction/scheduled owners, except the exact open
-- closure performed by an admitted termination consequence. Delegate edges keep their own owner.
CREATE FUNCTION app.access_workforce_structure_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb;after_row jsonb;subject uuid;proof app.access_termination_intent%ROWTYPE;
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
 IF (before_row IS NULL OR app.access_workforce_employment(subject,'workforce.maintain'))
  AND (after_row IS NULL OR app.access_workforce_employment(COALESCE((after_row->>'employment_id')::uuid,(after_row->>'subordinate_employment_id')::uuid),'workforce.maintain'))
  AND (TG_TABLE_NAME<>'assignment' OR
   (before_row->>'company_id' IS NULL OR app.access_workforce_company((before_row->>'company_id')::uuid,'workforce.maintain'))
   AND (after_row->>'company_id' IS NULL OR app.access_workforce_company((after_row->>'company_id')::uuid,'workforce.maintain'))) THEN
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
REVOKE ALL ON FUNCTION app.access_workforce_structure_write() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_workforce_assignment_lock BEFORE INSERT OR UPDATE OR DELETE ON assignment
FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
--> statement-breakpoint
CREATE TRIGGER access_workforce_assignment_write BEFORE INSERT OR UPDATE OR DELETE ON assignment
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_structure_write();
--> statement-breakpoint
CREATE TRIGGER access_workforce_reporting_lock BEFORE INSERT OR UPDATE OR DELETE ON reporting_line
FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
--> statement-breakpoint
CREATE TRIGGER access_workforce_reporting_write BEFORE INSERT OR UPDATE OR DELETE ON reporting_line
FOR EACH ROW EXECUTE FUNCTION app.access_workforce_structure_write();
