-- Probation access: named roles with permissions, scoped and dated members, and the Direct Superiors rule (lane K of
-- the Probation Confirmation build; handoff B7; ADR docs/adr/2026-11-15-probation-shared-automation.md build step 5).
-- Tag 5763 / idx 5163 / when 1793330005463, assigned by the build coordinator.
--
-- Additive: every grant that exists today keeps working (the tenant-level Probation module permission, the case
-- holders, the earlier probation_access PBP/GBS assignments, delegation and escalation). The new model only adds:
--  1. probation_access_role (owner only): a named role with permissions from two families.
--       Cases (within each member's scope): cases.view, cases.letters (prepare, preview and release letters),
--       cases.low_result (record the low-result action), cases.route (change a part's route or record a replacement).
--       Settings: settings.configure, settings.intake (intake and activation), settings.postings (may choose the
--       posting-approver group in Probation settings; approving a posting stays with that group, decision 4).
--     probation_access_member (owner only): a person in a role, scoped by business group (the group company,
--       coalesce(parent_company_id, id), as the shared routing editor lists it) and/or company (both empty = all), valid
--       from/to, revocation recorded. A role's case permissions also make its scope visible (acting needs sight).
--     probation_access_rule (owner only): the Direct Superiors rule. No row = on, with view and record a declined
--       signature (today's behaviour). Off removes the Line Manager's Probation role (app.probation_role 'lm'); view off
--       removes only the Line Manager's sight of their team's cases; declined off removes only recording a decline.
--  2. Writes only through app.probation_access_* commands (SECURITY DEFINER, app.probation_write_lock, authority, one
--     domain_event each). Only a System Administrator (access.system_admin) or a holder of the existing ADR-0135
--     "manage access" capability (access.configure) may change roles, members or the rule (app.probation_access_admin).
--  3. Enforcement in the existing owners, by replacing them with the same signature and grants:
--       app.probation_visible_among (set-based: one company list per viewer),
--       app.probation_role (the Direct Superiors rule for 'lm'), app.probation_signing_access (declined signature),
--       app.probation_config_admin / _settings_scope_admin / automation_can_configure (settings.configure),
--       app.probation_settings_scope_save / probation_config_write (settings.postings guards the posting-approver group),
--       the intake and activation owners (settings.intake through app.probation_intake_admin), the letter owners
--       (cases.letters), app.probation_record_low_result_action (cases.low_result), app.probation_route_override and
--       app.probation_delegate_add (cases.route). app.probation_navigation_access is unchanged (its installed body is
--       pinned); app.probation_access_navigation answers what roles add to navigation, including the Access page.
--     A role permission never acts on the member's own case (app.probation_case_permitted excludes the employee).
--     System Administrators keep exactly today's Probation authority (the Probation module permission they hold by default,
--     so every Settings permission) plus this access page; seeing or acting on cases still needs a holder role or a role
--     membership, which they can give themselves (audited). "Setup permission is not participant authority" (existing
--     rule, test/probation-persistence.test.ts) is kept.
-- Three new empty tables (no backfill); no existing table, row, policy or purpose-owned object changes.
CREATE TABLE public.probation_access_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  permissions text[] NOT NULL CHECK (cardinality(permissions) BETWEEN 1 AND 7 AND permissions <@ ARRAY['cases.view','cases.letters','cases.low_result','cases.route','settings.configure','settings.intake','settings.postings']::text[]),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by uuid NOT NULL REFERENCES public.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES public.app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retired_by uuid REFERENCES public.app_user(id),
  CHECK ((retired_at IS NULL) = (retired_by IS NULL)),
  CONSTRAINT probation_access_role_id_tenant UNIQUE (id, tenant_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX probation_access_role_name ON public.probation_access_role (tenant_id, lower(btrim(name))) WHERE retired_at IS NULL;
--> statement-breakpoint
CREATE TABLE public.probation_access_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  role_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.app_user(id),
  business_group_id uuid,
  company_id uuid,
  valid_from date NOT NULL,
  valid_to date,
  created_by uuid NOT NULL REFERENCES public.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.app_user(id),
  revocation_reason text CHECK (revocation_reason IS NULL OR length(revocation_reason) <= 500),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT probation_access_member_role_fk FOREIGN KEY (role_id, tenant_id) REFERENCES public.probation_access_role (id, tenant_id),
  CONSTRAINT probation_access_member_company_tenant_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION,
  CONSTRAINT probation_access_member_group_tenant_key FOREIGN KEY (business_group_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION
);
--> statement-breakpoint
CREATE INDEX probation_access_member_user ON public.probation_access_member (tenant_id, user_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX probation_access_member_role ON public.probation_access_member (tenant_id, role_id);
--> statement-breakpoint
CREATE TABLE public.probation_access_rule (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
  direct_superiors boolean NOT NULL,
  superior_view boolean NOT NULL,
  superior_declined boolean NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  updated_by uuid NOT NULL REFERENCES public.app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.probation_access_role ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.probation_access_role FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.probation_access_member ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.probation_access_member FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.probation_access_rule ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.probation_access_rule FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY probation_access_role_owner ON public.probation_access_role FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY probation_access_member_owner ON public.probation_access_member FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY probation_access_rule_owner ON public.probation_access_rule FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.probation_access_role, public.probation_access_member, public.probation_access_rule FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- Who may change Probation roles, members and the Direct Superiors rule: a System Administrator or a holder of the
-- existing "manage access" capability (access.configure). Also the page permission of /lifecycle/probation/access.
CREATE FUNCTION app.probation_access_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND app.probation_active_user()
  AND (app.access_capability_allowed('access.system_admin',NULL) OR app.access_capability_allowed('access.configure',NULL)),false);
$$;
--> statement-breakpoint
-- The Direct Superiors rule in force. No row is today's behaviour: on, with view and record a declined signature.
CREATE FUNCTION app.probation_superior_rule() RETURNS TABLE(enabled boolean,can_view boolean,can_record_declined boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(r.direct_superiors,true),coalesce(r.direct_superiors AND r.superior_view,true),coalesce(r.direct_superiors AND r.superior_declined,true)
 FROM (SELECT 1) one LEFT JOIN public.probation_access_rule r ON r.tenant_id=app.current_tenant_id();
$$;
--> statement-breakpoint
-- The companies a user's current role memberships cover for any of the given permissions. One set-based statement over
-- the tenant's companies; a membership counts from valid_from to valid_to (HR day), unrevoked, in an unretired role.
-- The caller checks that the user is an active login of this tenant.
CREATE FUNCTION app.probation_permitted_companies(p_user uuid,p_permissions text[]) RETURNS TABLE(company_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH m AS MATERIALIZED (
  SELECT DISTINCT m.business_group_id,m.company_id FROM public.probation_access_member m
  JOIN public.probation_access_role r ON r.id=m.role_id AND r.tenant_id=m.tenant_id
  WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=p_user AND m.revoked_at IS NULL AND r.retired_at IS NULL AND r.permissions && p_permissions
   AND m.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (m.valid_to IS NULL OR m.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
 SELECT co.id FROM public.company co
 WHERE co.tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM m)
  AND EXISTS(SELECT 1 FROM m WHERE (m.company_id IS NULL OR m.company_id=co.id) AND (m.business_group_id IS NULL OR m.business_group_id=coalesce(co.parent_company_id,co.id)));
$$;
--> statement-breakpoint
-- The current user holds the permission for this company (an entitled company of this tenant).
CREATE FUNCTION app.probation_permitted(p_permission text,p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p_company IS NOT NULL AND app.probation_active_user() AND app.probation_company_entitled(p_company)
  AND EXISTS(SELECT 1 FROM app.probation_permitted_companies(app.current_user_id(),ARRAY[p_permission]) x WHERE x.company_id=p_company),false);
$$;
--> statement-breakpoint
-- The current user holds the permission tenant-wide (a membership with neither a business group nor a company), or,
-- when companies are given, for every one of them.
CREATE FUNCTION app.probation_permitted_scope(p_permission text,p_companies uuid[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.probation_active_user() AND CASE WHEN coalesce(cardinality(p_companies),0)=0 THEN EXISTS(
   SELECT 1 FROM public.probation_access_member m JOIN public.probation_access_role r ON r.id=m.role_id AND r.tenant_id=m.tenant_id
   WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND m.revoked_at IS NULL AND r.retired_at IS NULL AND p_permission=ANY(r.permissions)
    AND m.business_group_id IS NULL AND m.company_id IS NULL
    AND m.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (m.valid_to IS NULL OR m.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
  ELSE NOT EXISTS(SELECT 1 FROM unnest(p_companies) wanted(id) WHERE NOT app.probation_permitted(p_permission,wanted.id)) END,false);
$$;
--> statement-breakpoint
-- A case permission on this employment's current company, never on the member's own probation.
CREATE FUNCTION app.probation_case_permitted(p_employment uuid,p_permission text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p_permission LIKE 'cases.%' AND app.probation_active_user() AND EXISTS(
  SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND app.probation_permitted(p_permission,e.company_id)
   AND NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=e.tenant_id AND u.person_id=e.person_id)),false);
$$;
--> statement-breakpoint
-- Intake and activation for a company: everyone who configures it (as today) or holds settings.intake there.
CREATE FUNCTION app.probation_intake_admin(p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.probation_config_admin(p_company) OR app.probation_permitted('settings.intake',p_company)
  AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL),false);
$$;
--> statement-breakpoint
-- The same question for a recorded approver (the activation owner re-checks the approver, not the current session).
CREATE FUNCTION app.probation_intake_admin_for(p_tenant uuid,p_user uuid,p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.access_allowed_for_tenant(p_tenant,p_user,'probation.module',NULL) OR p_tenant=app.current_tenant_id()
  AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  AND EXISTS(SELECT 1 FROM app.probation_permitted_companies(p_user,ARRAY['settings.configure','settings.intake']) x WHERE x.company_id=p_company),false);
$$;
--> statement-breakpoint
-- Who may choose the posting-approver group in Probation settings (it never approves a posting itself): holders of the
-- tenant-level Probation module permission (as today) and members with settings.postings for the whole scope.
CREATE FUNCTION app.probation_postings_admin(p_companies uuid[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.probation_active_user() AND (app.access_capability_allowed('probation.module',NULL) OR app.probation_permitted_scope('settings.postings',p_companies)),false);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_access_admin(),app.probation_superior_rule(),app.probation_permitted_companies(uuid,text[]),
 app.probation_permitted(text,uuid),app.probation_permitted_scope(text,uuid[]),app.probation_case_permitted(uuid,text),app.probation_intake_admin(uuid),
 app.probation_intake_admin_for(uuid,uuid,uuid),app.probation_postings_admin(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_access_admin(),app.probation_permitted(text,uuid),app.probation_case_permitted(uuid,text),app.probation_intake_admin(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Commands. Each takes the shared workforce barrier and the Probation write lock, checks authority, validates, writes
-- and records one domain_event in the same transaction.
CREATE FUNCTION app.probation_access_role_save(p_role uuid,p_name text,p_permissions text[],p_expected integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();prior public.probation_access_role;v_id uuid;v_revision integer;wanted text[];
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 IF app.probation_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Only a System Administrator or someone who manages access can change Probation access' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT x ORDER BY x),'{}') INTO wanted FROM unnest(coalesce(p_permissions,'{}'::text[])) x;
 IF length(btrim(coalesce(p_name,''))) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Give the role a name' USING ERRCODE='22023';END IF;
 IF cardinality(wanted) NOT BETWEEN 1 AND 7 OR NOT wanted <@ ARRAY['cases.view','cases.letters','cases.low_result','cases.route','settings.configure','settings.intake','settings.postings']::text[] THEN
  RAISE EXCEPTION 'Choose at least one permission' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM public.probation_access_role r WHERE r.tenant_id=t AND r.retired_at IS NULL AND lower(btrim(r.name))=lower(btrim(p_name)) AND r.id IS DISTINCT FROM p_role) THEN
  RAISE EXCEPTION 'Another role already has this name' USING ERRCODE='23505';END IF;
 IF p_role IS NULL THEN
  IF coalesce(p_expected,0)<>0 THEN RAISE EXCEPTION 'This role changed; reload before saving' USING ERRCODE='40001';END IF;
  INSERT INTO public.probation_access_role(tenant_id,name,permissions,created_by,updated_by) VALUES(t,btrim(p_name),wanted,app.current_user_id(),app.current_user_id()) RETURNING id,revision INTO v_id,v_revision;
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  VALUES(t,'probation_access',v_id,'probation.access.role_created','user'::actor_type,app.current_user_id(),jsonb_build_object('name',btrim(p_name),'permissions',to_jsonb(wanted)));
  RETURN jsonb_build_object('id',v_id,'revision',v_revision);
 END IF;
 SELECT * INTO prior FROM public.probation_access_role WHERE id=p_role AND tenant_id=t FOR UPDATE;
 IF prior.id IS NULL OR prior.retired_at IS NOT NULL THEN RAISE EXCEPTION 'This role no longer exists' USING ERRCODE='22023';END IF;
 IF prior.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'This role changed; reload before saving' USING ERRCODE='40001';END IF;
 UPDATE public.probation_access_role SET name=btrim(p_name),permissions=wanted,revision=prior.revision+1,updated_by=app.current_user_id(),updated_at=now() WHERE id=prior.id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'probation_access',prior.id,'probation.access.role_changed','user'::actor_type,app.current_user_id(),
  jsonb_build_object('name',btrim(p_name),'previousName',prior.name,'permissions',to_jsonb(wanted),'previousPermissions',to_jsonb(prior.permissions),'revision',prior.revision+1));
 RETURN jsonb_build_object('id',prior.id,'revision',prior.revision+1);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_access_role_retire(p_role uuid,p_expected integer,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();prior public.probation_access_role;members integer;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 IF app.probation_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Only a System Administrator or someone who manages access can change Probation access' USING ERRCODE='42501';END IF;
 IF length(coalesce(p_reason,''))>500 THEN RAISE EXCEPTION 'Keep the reason under 500 characters' USING ERRCODE='22023';END IF;
 SELECT * INTO prior FROM public.probation_access_role WHERE id=p_role AND tenant_id=t FOR UPDATE;
 IF prior.id IS NULL OR prior.retired_at IS NOT NULL THEN RAISE EXCEPTION 'This role no longer exists' USING ERRCODE='22023';END IF;
 IF prior.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'This role changed; reload before saving' USING ERRCODE='40001';END IF;
 UPDATE public.probation_access_member SET revoked_at=now(),revoked_by=app.current_user_id(),revocation_reason='Role deleted'
 WHERE tenant_id=t AND role_id=prior.id AND revoked_at IS NULL;
 GET DIAGNOSTICS members=ROW_COUNT;
 UPDATE public.probation_access_role SET retired_at=now(),retired_by=app.current_user_id(),revision=prior.revision+1,updated_by=app.current_user_id(),updated_at=now() WHERE id=prior.id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'probation_access',prior.id,'probation.access.role_retired','user'::actor_type,app.current_user_id(),
  jsonb_build_object('name',prior.name,'permissions',to_jsonb(prior.permissions),'membersRevoked',members,'reason',nullif(btrim(coalesce(p_reason,'')),'')));
END $$;
--> statement-breakpoint
-- Scope rules shared by add and change: an optional business group (a group company) and an optional company of it.
CREATE FUNCTION app.probation_access_scope_check(p_business_group uuid,p_company uuid,p_from date,p_to date) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF p_from IS NULL THEN RAISE EXCEPTION 'Choose a Valid from date' USING ERRCODE='22023';END IF;
 IF p_to IS NOT NULL AND p_to<p_from THEN RAISE EXCEPTION 'Valid to must be on or after Valid from' USING ERRCODE='22023';END IF;
 IF p_business_group IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=t AND c.archived_at IS NULL AND coalesce(c.parent_company_id,c.id)=p_business_group) THEN
  RAISE EXCEPTION 'Choose a business group of this organisation' USING ERRCODE='22023';END IF;
 IF p_company IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=t AND c.archived_at IS NULL AND (p_business_group IS NULL OR coalesce(c.parent_company_id,c.id)=p_business_group)) THEN
  RAISE EXCEPTION 'Choose a company in the chosen business group' USING ERRCODE='22023';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_access_member_add(p_role uuid,p_user uuid,p_business_group uuid,p_company uuid,p_from date,p_to date) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();r public.probation_access_role;v_id uuid;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 IF app.probation_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Only a System Administrator or someone who manages access can change Probation access' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM public.probation_access_role WHERE id=p_role AND tenant_id=t FOR UPDATE;
 IF r.id IS NULL OR r.retired_at IS NOT NULL THEN RAISE EXCEPTION 'This role no longer exists' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=p_user AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN
  RAISE EXCEPTION 'Choose a person with an active login' USING ERRCODE='22023';END IF;
 PERFORM app.probation_access_scope_check(p_business_group,p_company,p_from,p_to);
 IF EXISTS(SELECT 1 FROM public.probation_access_member m WHERE m.tenant_id=t AND m.role_id=r.id AND m.user_id=p_user AND m.revoked_at IS NULL
   AND m.business_group_id IS NOT DISTINCT FROM p_business_group AND m.company_id IS NOT DISTINCT FROM p_company
   AND m.valid_from<=coalesce(p_to,'infinity'::date) AND p_from<=coalesce(m.valid_to,'infinity'::date)) THEN
  RAISE EXCEPTION 'This person already has this scope in this role for these dates' USING ERRCODE='23505';END IF;
 INSERT INTO public.probation_access_member(tenant_id,role_id,user_id,business_group_id,company_id,valid_from,valid_to,created_by)
 VALUES(t,r.id,p_user,p_business_group,p_company,p_from,p_to,app.current_user_id()) RETURNING id INTO v_id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'probation_access',r.id,'probation.access.member_added','user'::actor_type,app.current_user_id(),
  jsonb_build_object('memberId',v_id,'userId',p_user,'businessGroupId',p_business_group,'companyId',p_company,'validFrom',p_from,'validTo',p_to,'permissions',to_jsonb(r.permissions)));
 RETURN v_id;
END $$;
--> statement-breakpoint
-- A change keeps history: the old membership is revoked and a new one added, in one transaction and one event.
CREATE FUNCTION app.probation_access_member_change(p_member uuid,p_business_group uuid,p_company uuid,p_from date,p_to date) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();m public.probation_access_member;r public.probation_access_role;v_id uuid;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 IF app.probation_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Only a System Administrator or someone who manages access can change Probation access' USING ERRCODE='42501';END IF;
 SELECT * INTO m FROM public.probation_access_member WHERE id=p_member AND tenant_id=t FOR UPDATE;
 IF m.id IS NULL OR m.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'This membership no longer exists' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM public.probation_access_role WHERE id=m.role_id AND tenant_id=t;
 IF r.retired_at IS NOT NULL THEN RAISE EXCEPTION 'This role no longer exists' USING ERRCODE='22023';END IF;
 PERFORM app.probation_access_scope_check(p_business_group,p_company,p_from,p_to);
 IF m.business_group_id IS NOT DISTINCT FROM p_business_group AND m.company_id IS NOT DISTINCT FROM p_company AND m.valid_from=p_from AND m.valid_to IS NOT DISTINCT FROM p_to THEN RETURN m.id;END IF;
 UPDATE public.probation_access_member SET revoked_at=now(),revoked_by=app.current_user_id(),revocation_reason='Changed' WHERE id=m.id;
 INSERT INTO public.probation_access_member(tenant_id,role_id,user_id,business_group_id,company_id,valid_from,valid_to,created_by)
 VALUES(t,m.role_id,m.user_id,p_business_group,p_company,p_from,p_to,app.current_user_id()) RETURNING id INTO v_id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'probation_access',m.role_id,'probation.access.member_changed','user'::actor_type,app.current_user_id(),
  jsonb_build_object('memberId',v_id,'previousMemberId',m.id,'userId',m.user_id,'businessGroupId',p_business_group,'companyId',p_company,'validFrom',p_from,'validTo',p_to,
   'previous',jsonb_build_object('businessGroupId',m.business_group_id,'companyId',m.company_id,'validFrom',m.valid_from,'validTo',m.valid_to)));
 RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_access_member_revoke(p_member uuid,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();m public.probation_access_member;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 IF app.probation_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Only a System Administrator or someone who manages access can change Probation access' USING ERRCODE='42501';END IF;
 IF length(coalesce(p_reason,''))>500 THEN RAISE EXCEPTION 'Keep the reason under 500 characters' USING ERRCODE='22023';END IF;
 SELECT * INTO m FROM public.probation_access_member WHERE id=p_member AND tenant_id=t FOR UPDATE;
 IF m.id IS NULL OR m.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'This membership no longer exists' USING ERRCODE='22023';END IF;
 UPDATE public.probation_access_member SET revoked_at=now(),revoked_by=app.current_user_id(),revocation_reason=coalesce(nullif(btrim(coalesce(p_reason,'')),''),'Removed') WHERE id=m.id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'probation_access',m.role_id,'probation.access.member_revoked','user'::actor_type,app.current_user_id(),
  jsonb_build_object('memberId',m.id,'userId',m.user_id,'businessGroupId',m.business_group_id,'companyId',m.company_id,'validFrom',m.valid_from,'validTo',m.valid_to,'reason',nullif(btrim(coalesce(p_reason,'')),'')));
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_access_rule_save(p_enabled boolean,p_view boolean,p_declined boolean,p_expected integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();prior public.probation_access_rule;v_revision integer;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 IF app.probation_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Only a System Administrator or someone who manages access can change Probation access' USING ERRCODE='42501';END IF;
 IF p_enabled IS NULL OR p_view IS NULL OR p_declined IS NULL THEN RAISE EXCEPTION 'Choose each setting of the Direct Superiors rule' USING ERRCODE='22023';END IF;
 SELECT * INTO prior FROM public.probation_access_rule WHERE tenant_id=t FOR UPDATE;
 IF coalesce(prior.revision,0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'The Direct Superiors rule changed; reload before saving' USING ERRCODE='40001';END IF;
 v_revision:=coalesce(prior.revision,0)+1;
 INSERT INTO public.probation_access_rule(tenant_id,direct_superiors,superior_view,superior_declined,revision,updated_by)
 VALUES(t,p_enabled,p_view,p_declined,v_revision,app.current_user_id())
 ON CONFLICT(tenant_id) DO UPDATE SET direct_superiors=excluded.direct_superiors,superior_view=excluded.superior_view,superior_declined=excluded.superior_declined,
  revision=excluded.revision,updated_by=excluded.updated_by,updated_at=now();
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'probation_access',t,'probation.access.direct_superiors_saved','user'::actor_type,app.current_user_id(),
  jsonb_build_object('enabled',p_enabled,'view',p_view,'recordDeclined',p_declined,'revision',v_revision,
   'previous',CASE WHEN prior.tenant_id IS NULL THEN jsonb_build_object('enabled',true,'view',true,'recordDeclined',true) ELSE jsonb_build_object('enabled',prior.direct_superiors,'view',prior.superior_view,'recordDeclined',prior.superior_declined) END));
 RETURN v_revision;
END $$;
--> statement-breakpoint
-- Everything the Access page shows, bounded: the rule, current roles with their unrevoked members (names only), the
-- earlier PBP/GBS assignments kept from before roles, and the business group and company options.
CREATE FUNCTION app.probation_access_view() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();result jsonb;
BEGIN
 IF app.probation_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Only a System Administrator or someone who manages access can open Probation access' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object(
  'rule',(SELECT jsonb_build_object('enabled',coalesce(x.direct_superiors,true),'view',coalesce(x.superior_view,true),'recordDeclined',coalesce(x.superior_declined,true),'revision',coalesce(x.revision,0))
   FROM (SELECT 1) one LEFT JOIN public.probation_access_rule x ON x.tenant_id=t),
  'roles',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'permissions',to_jsonb(r.permissions),'revision',r.revision,
    'members',coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'userId',m.user_id,'name',coalesce(p.full_name,''),'businessGroupId',m.business_group_id,'companyId',m.company_id,'validFrom',m.valid_from,'validTo',m.valid_to) ORDER BY p.full_name,m.valid_from,m.id)
     FROM (SELECT * FROM public.probation_access_member WHERE tenant_id=t AND role_id=r.id AND revoked_at IS NULL ORDER BY created_at,id LIMIT 500) m
     JOIN public.app_user u ON u.id=m.user_id AND u.tenant_id=m.tenant_id LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id),'[]'::jsonb)) ORDER BY lower(r.name),r.id)
   FROM (SELECT * FROM public.probation_access_role WHERE tenant_id=t AND retired_at IS NULL ORDER BY lower(name),id LIMIT 200) r),'[]'::jsonb),
  'earlier',coalesce((SELECT jsonb_agg(jsonb_build_object('role',a.role,'name',coalesce(p.full_name,''),'companyId',a.company_id,'validFrom',a.valid_from,'validTo',a.valid_to) ORDER BY a.role,p.full_name,a.company_id)
   FROM (SELECT * FROM public.probation_access WHERE tenant_id=t AND role IN('pbp','gbs') AND (valid_to IS NULL OR valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY valid_from,id LIMIT 2000) a
   JOIN public.app_user u ON u.id=a.user_id AND u.tenant_id=a.tenant_id LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id),'[]'::jsonb),
  'companies',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.legal_name,'businessGroupId',coalesce(c.parent_company_id,c.id)) ORDER BY c.legal_name,c.id)
   FROM (SELECT * FROM public.company WHERE tenant_id=t AND archived_at IS NULL ORDER BY legal_name,id LIMIT 2000) c),'[]'::jsonb),
  'businessGroups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.legal_name) ORDER BY g.legal_name,g.id)
   FROM public.company g WHERE g.tenant_id=t AND g.id IN(SELECT DISTINCT coalesce(c.parent_company_id,c.id) FROM public.company c WHERE c.tenant_id=t AND c.archived_at IS NULL)),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END $$;
--> statement-breakpoint
-- People to add as members: active logins with a person, by name, at most 20.
CREATE FUNCTION app.probation_access_people(p_query text) RETURNS TABLE(id uuid,name text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.probation_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Only a System Administrator or someone who manages access can open Probation access' USING ERRCODE='42501';END IF;
 IF length(btrim(coalesce(p_query,''))) NOT BETWEEN 2 AND 100 THEN RETURN;END IF;
 RETURN QUERY SELECT u.id,p.full_name FROM public.app_user u JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
  WHERE u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND position(lower(btrim(p_query)) IN lower(p.full_name))>0
  ORDER BY p.full_name,u.id LIMIT 20;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_access_role_save(uuid,text,text[],integer),app.probation_access_role_retire(uuid,integer,text),app.probation_access_scope_check(uuid,uuid,date,date),
 app.probation_access_member_add(uuid,uuid,uuid,uuid,date,date),app.probation_access_member_change(uuid,uuid,uuid,date,date),app.probation_access_member_revoke(uuid,text),
 app.probation_access_rule_save(boolean,boolean,boolean,integer),app.probation_access_view(),app.probation_access_people(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_access_role_save(uuid,text,text[],integer),app.probation_access_role_retire(uuid,integer,text),
 app.probation_access_member_add(uuid,uuid,uuid,uuid,date,date),app.probation_access_member_change(uuid,uuid,uuid,date,date),app.probation_access_member_revoke(uuid,text),
 app.probation_access_rule_save(boolean,boolean,boolean,integer),app.probation_access_view(),app.probation_access_people(text) TO ai_hr_app;
--> statement-breakpoint
-- The Line Manager (Direct Superior) holds the Probation 'lm' role only while the Direct Superiors rule is on.
CREATE OR REPLACE FUNCTION app.probation_role(p_employment uuid,p_role text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h jsonb;co uuid;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF NOT app.probation_active_user() THEN RETURN false;END IF;
 h:=app.probation_holders(p_employment);co:=(h->>'companyId')::uuid;IF co IS NULL OR NOT app.probation_company_entitled(co) THEN RETURN false;END IF;
 IF p_role='lm' AND coalesce((SELECT r.enabled FROM app.probation_superior_rule() r),true) IS NOT TRUE THEN RETURN false;END IF;
 IF p_role IN('employee','lm','hod','pbp') THEN RETURN coalesce(h->>p_role=app.current_user_id()::text,false);END IF;
 IF p_role='gbs' THEN RETURN app.probation_gbs_user(p_employment,app.current_user_id());END IF;
 RETURN false;
END $$;
--> statement-breakpoint
-- Configure probation: the tenant-level Probation module permission (as today) or settings.configure for this company.
CREATE OR REPLACE FUNCTION app.probation_config_admin(p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_active_user() AND (app.access_capability_allowed('probation.module',NULL) OR app.probation_permitted('settings.configure',p_company))
  AND app.probation_company_entitled(p_company)
  AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL);
$$;
--> statement-breakpoint
-- The group standard and company settings are tenant-level: settings.configure counts only for all companies.
CREATE OR REPLACE FUNCTION app.probation_settings_scope_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND app.probation_active_user() AND (app.access_capability_allowed('probation.module',NULL) OR app.probation_permitted_scope('settings.configure',NULL)),false);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_can_configure(p_module text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT app.current_tenant_id() IS NOT NULL AND CASE p_module
    WHEN 'probation' THEN app.probation_active_user() AND (app.access_capability_allowed('probation.module', NULL) OR app.probation_permitted_scope('settings.configure', NULL))
    ELSE false END;
$$;
--> statement-breakpoint
-- Company settings versions before a group standard exists: the posting-approver group needs settings.postings.
CREATE OR REPLACE FUNCTION app.probation_config_write(p_company uuid,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.probation_write_lock();
 IF p_kind='settings' AND EXISTS(SELECT 1 FROM public.probation_settings_scope_version WHERE tenant_id=app.current_tenant_id() AND scope='standard' AND state='published') THEN
  RAISE EXCEPTION 'Probation settings now come from the group standard and company settings' USING ERRCODE='22023';
 END IF;
 IF p_kind='settings' AND coalesce(p_data->>'postingApproverGroupId','') IS DISTINCT FROM coalesce((SELECT x.data->>'postingApproverGroupId' FROM public.probation_configuration x
   WHERE x.tenant_id=app.current_tenant_id() AND x.company_id=p_company AND x.kind='settings' ORDER BY x.version DESC LIMIT 1),'')
  AND app.probation_postings_admin(ARRAY[p_company]) IS NOT TRUE THEN
  RAISE EXCEPTION 'Only someone with Approve Personnel postings can choose who approves Personnel postings' USING ERRCODE='42501';
 END IF;
 RETURN app.probation_config_write_company(p_company,p_kind,p_data,p_publish,p_expected);
END $$;
--> statement-breakpoint
-- What the role model adds to Probation navigation (app.probation_navigation_access stays as 2252 installed it; the
-- service combines both): Configure probation or Intake and activation for any entitled active company, and the Access
-- page. One membership read each, no per-company loop.
CREATE FUNCTION app.probation_access_navigation() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
  'configure',coalesce(app.probation_active_user() AND EXISTS(SELECT 1 FROM app.probation_permitted_companies(app.current_user_id(),ARRAY['settings.configure']) x
   JOIN public.company c ON c.id=x.company_id AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL WHERE app.probation_company_entitled(c.id)),false),
  'intake',coalesce(app.probation_active_user() AND EXISTS(SELECT 1 FROM app.probation_permitted_companies(app.current_user_id(),ARRAY['settings.configure','settings.intake']) x
   JOIN public.company c ON c.id=x.company_id AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL WHERE app.probation_company_entitled(c.id)),false),
  'access',app.probation_access_admin());
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_access_navigation() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_access_navigation() TO ai_hr_app;
--> statement-breakpoint
-- Cases: view. Role members see their scope; the Direct Superiors rule decides the Line Manager (body from 5755_probation_routed_assignment; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_visible_among(p_cases uuid[]) RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();me uuid:=app.current_user_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 my_person uuid;usable boolean:=false;ops boolean:=false;visible uuid[];superior_view boolean:=true;view_companies uuid[]:='{}'::uuid[];
BEGIN
 IF t IS NULL THEN RETURN;END IF;
 IF app.probation_storage_runner() THEN RETURN QUERY SELECT c.id FROM public.probation_case c WHERE c.tenant_id=t AND (p_cases IS NULL OR c.id=ANY(p_cases));RETURN;END IF;
 IF coalesce(app.probation_active_user(),false) IS NOT TRUE THEN RETURN;END IF;
 -- 5763: the Direct Superiors rule and the companies this viewer's roles cover (one read each).
 SELECT r.can_view INTO superior_view FROM app.probation_superior_rule() r;
 SELECT coalesce(array_agg(x.company_id),'{}'::uuid[]) INTO view_companies FROM app.probation_permitted_companies(me,ARRAY['cases.view','cases.letters','cases.low_result','cases.route']) x;
 SELECT u.person_id,(u.archived_at IS NULL AND NOT app.login_blocked(u.id)) INTO my_person,usable FROM public.app_user u WHERE u.id=me AND u.tenant_id=t;
 IF EXISTS(SELECT 1 FROM public.probation_access m WHERE m.tenant_id=t AND m.user_id=me AND m.role='gbs') THEN
  ops:=coalesce(usable,false) AND coalesce(app.lifecycle_canonical_people_ops_member((SELECT co.id FROM public.company co WHERE co.tenant_id=t ORDER BY co.id LIMIT 1),me),false);
 END IF;
 SELECT coalesce(array_agg(x.id),'{}'::uuid[]) INTO visible FROM (
  WITH cs AS MATERIALIZED (
   SELECT c.id,c.employment_id,c.company_id,e.person_id,coalesce(e.company_id=c.company_id AND c.data->>'sourceCompanyMoved' IS DISTINCT FROM 'true',false) AS current_company
   FROM public.probation_case c LEFT JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
   WHERE c.tenant_id=t AND (p_cases IS NULL OR c.id=ANY(p_cases))),
  ent AS MATERIALIZED (SELECT co.id FROM public.company co WHERE co.tenant_id=t AND co.id IN(SELECT DISTINCT cs.company_id FROM cs) AND app.probation_company_entitled(co.id)),
  live AS MATERIALIZED (SELECT cs.* FROM cs JOIN ent ON ent.id=cs.company_id),
  h AS MATERIALIZED (SELECT * FROM app.probation_holders_set(ARRAY(SELECT live.employment_id FROM live WHERE live.current_company))),
  gbs AS MATERIALIZED (SELECT m.* FROM public.probation_access m WHERE ops AND m.tenant_id=t AND m.user_id=me AND m.role='gbs' AND m.valid_from<=day AND (m.valid_to IS NULL OR m.valid_to>=day)),
  anc AS MATERIALIZED (SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT h.company_id FROM h WHERE EXISTS(SELECT 1 FROM gbs)))),
  -- Each GBS mapping covers the companies below it, optionally narrowed to a department or unit: decided per company once.
  gbs_cover AS MATERIALIZED (SELECT DISTINCT anc.company_id,m.department_id,m.business_unit_id FROM gbs m JOIN anc ON anc.ancestor_id=m.company_id),
  -- Decision 7: lines on which I am the delegate of a Head of Department or PBP holder, with Probation explicitly ticked.
  general AS MATERIALIZED (
   SELECT d.id AS line_id,hu.id AS holder_id FROM public.reporting_line d
   JOIN public.employment de ON de.id=d.manager_employment_id AND de.tenant_id=d.tenant_id AND de.person_id=my_person
   JOIN public.employment he ON he.id=d.subordinate_employment_id AND he.tenant_id=d.tenant_id
   JOIN public.app_user hu ON hu.person_id=he.person_id AND hu.tenant_id=d.tenant_id
   WHERE d.tenant_id=t AND d.line_type::text='delegate' AND d.superseded_at IS NULL AND d.valid_from<=current_date AND (d.valid_to IS NULL OR d.valid_to>current_date)
    AND EXISTS(SELECT 1 FROM public.reporting_line_scope s WHERE s.reporting_line_id=d.id AND s.tenant_id=d.tenant_id AND s.module='probation')),
  held AS MATERIALIZED (
   SELECT h.employment_id FROM h WHERE me IN(h.employee,h.hod,h.pbp) OR superior_view AND me=h.lm
    OR EXISTS(SELECT 1 FROM general g JOIN public.reporting_line_scope s ON s.reporting_line_id=g.line_id AND s.tenant_id=t AND s.module='probation'
     WHERE g.holder_id IN(h.hod,h.pbp) AND app.delegation_line_covers(g.line_id,h.employment_id,'probation',coalesce(s.task_type,'probation.approve')))
    OR EXISTS(SELECT 1 FROM gbs_cover g WHERE g.company_id=h.company_id AND (g.department_id IS NULL OR g.department_id=h.department_id) AND (g.business_unit_id IS NULL OR g.business_unit_id=h.business_unit_id))),
  delegated AS MATERIALIZED (
   SELECT DISTINCT p.case_id FROM public.probation_delegate d JOIN public.probation_part p ON p.id=d.part_id AND p.tenant_id=d.tenant_id
   WHERE d.tenant_id=t AND d.holder_id=me AND d.valid_from<=day AND (d.valid_to IS NULL OR d.valid_to>=day)),
  -- 5751 (E4): steps assigned on a Part to a person I am a general Probation delegate for (a group-held GBS step resolves
  -- to its assigned person); the delegation must cover this employee, as for Head of Department and PBP holders.
  assigned AS MATERIALIZED (
   SELECT DISTINCT p.case_id,g.line_id FROM general g
   JOIN public.probation_delegate x ON x.tenant_id=t AND x.holder_id=g.holder_id AND x.kind IN('missing_holder','holder_changed') AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day)
   JOIN public.probation_part p ON p.id=x.part_id AND p.tenant_id=x.tenant_id),
  -- 5755 (decision 7): routed letter steps held by a person I am a general Probation delegate for (open letters only).
  routed AS MATERIALIZED (
   SELECT DISTINCT p.case_id,g.line_id FROM general g
   JOIN public.document_signing_document doc ON doc.tenant_id=t AND doc.subject_type='probation' AND jsonb_typeof(doc.data->'routing')='object'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(doc.data->'route'->'steps')='array' THEN doc.data->'route'->'steps' ELSE '[]'::jsonb END) st WHERE st->>'holderId'=g.holder_id::text)
   JOIN public.probation_part p ON p.id=doc.subject_id AND p.tenant_id=doc.tenant_id AND p.data->>'state' IN('pending_approval','returned'))
  SELECT live.id FROM live WHERE live.current_company AND live.company_id=ANY(view_companies)
  UNION
  SELECT live.id FROM live WHERE NOT live.current_company AND live.person_id=my_person
  UNION
  SELECT live.id FROM live WHERE live.current_company AND (live.employment_id IN(SELECT held.employment_id FROM held) OR live.id IN(SELECT delegated.case_id FROM delegated)
   OR EXISTS(SELECT 1 FROM assigned a JOIN public.reporting_line_scope s ON s.reporting_line_id=a.line_id AND s.tenant_id=t AND s.module='probation'
    WHERE a.case_id=live.id AND app.delegation_line_covers(a.line_id,live.employment_id,'probation',coalesce(s.task_type,'probation.approve')))
   OR EXISTS(SELECT 1 FROM routed r JOIN public.reporting_line_scope s ON s.reporting_line_id=r.line_id AND s.tenant_id=t AND s.module='probation'
    WHERE r.case_id=live.id AND app.delegation_line_covers(r.line_id,live.employment_id,'probation',coalesce(s.task_type,'probation.letter_sign'))))
 ) x;
 RETURN QUERY SELECT unnest(visible);
 -- Residual: an escalated approver on a case that is otherwise invisible to them. Candidates are found as one set (cases
 -- with a part waiting for approval that has a signing document), then checked per candidate.
 RETURN QUERY WITH waiting AS MATERIALIZED (
  SELECT DISTINCT p.case_id FROM public.probation_part p JOIN public.document_signing_document d ON d.tenant_id=p.tenant_id AND d.subject_type='probation' AND d.subject_id=p.id
  WHERE p.tenant_id=t AND p.data->>'state'='pending_approval' AND (p_cases IS NULL OR p.case_id=ANY(p_cases))),
 candidates AS MATERIALIZED (
  SELECT c.id FROM public.probation_case c JOIN waiting w ON w.case_id=c.id
  WHERE c.tenant_id=t AND NOT c.id=ANY(visible) AND app.probation_company_entitled(c.company_id))
 SELECT candidates.id FROM candidates WHERE app.probation_current_escalated_actor(candidates.id);
END $$;
--> statement-breakpoint
-- Direct Superiors rule: recording a declined signature (body from 5756_probation_form_approver_choices; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_signing_access(p_subject uuid,p_operation text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;step jsonb;
BEGIN
 IF coalesce(p_operation,'') NOT IN('create','read','sign','revise','reroute','decline') THEN RETURN false;END IF;
 SELECT * INTO p FROM probation_part WHERE id=p_subject AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_active_user() OR NOT app.probation_case_access(p.case_id) THEN RETURN false;END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p_operation='read' THEN RETURN app.probation_part_access(p.id);END IF;
 IF app.probation_case_company_current(c.id) IS NOT TRUE OR app.probation_owns_legacy(c.employment_id) IS NOT TRUE OR NOT app.probation_company_entitled(c.company_id) OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled','not_issued','release_requested') THEN RETURN false;END IF;
 IF p.data->>'documentKind'='letter' THEN
 -- 5752: a routed letter. Its steps are held by the people its routing froze, not by Probation roles. A holder named on the
 -- current route acts at their step; after a send-back only the owner may send it round again; the owner or the pending
 -- reviewer may revise (app.document_signing_store enforces the edit lock).
 IF jsonb_typeof(p.data->'letterRouting')='array' THEN
  SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
  IF p_operation='revise' AND d.id IS NOT NULL THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR app.document_signing_can_edit(d.data,app.current_user_id());END IF;
  IF p_operation='sign' THEN RETURN d.id IS NOT NULL AND app.probation_letter_source_current(p.id) AND (CASE WHEN app.document_signing_returned(d.data) THEN app.document_signing_owner(d.data)=app.current_user_id() ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') st WHERE st->>'holderId'=app.current_user_id()::text) END) IS TRUE;END IF;
 END IF;
 IF p_operation IN('create','revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs');END IF;
 IF p_operation='sign' THEN RETURN p.data->>'state'<>'returned' AND app.probation_letter_source_current(p.id) AND EXISTS(SELECT 1 FROM document_signing_document doc CROSS JOIN LATERAL jsonb_array_elements(doc.data->'route'->'steps') st WHERE doc.tenant_id=p.tenant_id AND doc.subject_type='probation' AND doc.subject_id=p.id AND st->>'holderId'=app.current_user_id()::text AND (app.probation_role(c.employment_id,st->>'role') OR EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') cur WHERE cur->>'id'=st->>'id' AND cur->>'holderId'=app.current_user_id()::text AND cur->>'representedId' IS NOT NULL) OR EXISTS(SELECT 1 FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=st->>'id' AND x.holder_id=app.current_user_id() AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))));END IF;RETURN false;END IF;
 IF p_operation='create' THEN RETURN app.probation_part_role(p.id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation IN('revise','reroute') THEN RETURN app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR p.data->>'managerSubmittedAt' IS NULL AND app.probation_part_role(p.id,'lm') AND app.probation_submission_ready(p.id,'lm');END IF;
 IF p_operation='decline' THEN RETURN p.data->>'managerSubmittedAt' IS NOT NULL AND p.data->>'acknowledgedAt' IS NULL AND (app.probation_part_role(p.id,'lm') AND coalesce((SELECT r.can_record_declined FROM app.probation_superior_rule() r),true) OR app.probation_role(c.employment_id,'pbp') AND EXISTS(SELECT 1 FROM probation_followup WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='refusal_request' AND content_revision=p.content_revision));END IF;
 IF p_operation<>'sign' THEN RETURN false;END IF;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 FOR step IN SELECT value FROM jsonb_array_elements(d.data->'route'->'steps') LOOP
 IF step->>'holderId'=app.current_user_id()::text AND (app.probation_form_approver_role(step->>'role') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='employee' AND app.probation_role(c.employment_id,'employee') AND p.data->>'managerSubmittedAt' IS NOT NULL OR step->>'role'='lm' AND app.probation_part_role(p.id,'lm') AND p.data->>'managerSubmittedAt' IS NULL AND app.probation_submission_ready(p.id,'lm')) THEN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') current_step WHERE current_step->>'id'=step->>'id' AND current_step->>'holderId'=app.current_user_id()::text) THEN RETURN true;END IF;
 END IF;END LOOP;RETURN false;
END $$;
--> statement-breakpoint
-- Settings: Approve Personnel postings decides who may choose the posting-approver group (body from 5742_probation_settings_scope; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_settings_scope_save(p_key uuid,p_scope text,p_name text,p_companies uuid[],p_data jsonb,p_publish boolean,p_expected integer,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();prior public.probation_settings_scope_version;standard_key uuid;v_id uuid;v_version integer;companies uuid[]:=coalesce(p_companies,'{}'::uuid[]);
 previous_members uuid[]:='{}'::uuid[];affected uuid[];clash text;mapping text;rule jsonb;v_company uuid;materialized integer:=0;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 IF app.probation_settings_scope_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Probation module permission is required' USING ERRCODE='42501';END IF;
 IF p_key IS NULL OR coalesce(p_scope,'') NOT IN('standard','company') OR p_publish IS NULL OR length(btrim(coalesce(p_name,''))) NOT BETWEEN 1 AND 200 OR length(coalesce(p_reason,''))>2000 THEN
  RAISE EXCEPTION 'Name the setting and choose its scope' USING ERRCODE='22023';END IF;
 IF p_scope='standard' THEN
  SELECT setting_key INTO standard_key FROM public.probation_settings_scope_version WHERE tenant_id=t AND scope='standard' LIMIT 1;
  IF standard_key IS NOT NULL AND standard_key<>p_key THEN RAISE EXCEPTION 'This tenant already has a group standard; edit it instead' USING ERRCODE='23505';END IF;
  IF cardinality(companies)<>0 THEN RAISE EXCEPTION 'The group standard applies to every company' USING ERRCODE='22023';END IF;
 ELSE
  IF cardinality(companies) NOT BETWEEN 1 AND 500 OR (SELECT count(DISTINCT c) FROM unnest(companies) c)<>cardinality(companies) THEN RAISE EXCEPTION 'Choose the companies this setting applies to' USING ERRCODE='22023';END IF;
  IF (SELECT count(*) FROM public.company c WHERE c.tenant_id=t AND c.id=ANY(companies) AND c.archived_at IS NULL AND app.probation_company_entitled(c.id))<>cardinality(companies) THEN
   RAISE EXCEPTION 'Choose active companies with Probation in this tenant' USING ERRCODE='22023';END IF;
 END IF;
 PERFORM app.probation_settings_scope_check(p_scope,p_data);
 SELECT * INTO prior FROM public.probation_settings_scope_version WHERE tenant_id=t AND setting_key=p_key ORDER BY version DESC LIMIT 1;
 IF coalesce(prior.version,0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'These probation settings changed; reload before saving' USING ERRCODE='40001';END IF;
 -- 5763: choosing the posting-approver group needs Approve Personnel postings (decision 4: approving stays with the group).
 IF coalesce(p_data->>'postingApproverGroupId','') IS DISTINCT FROM coalesce(prior.data->>'postingApproverGroupId','') AND app.probation_postings_admin(CASE WHEN p_scope='company' THEN companies END) IS NOT TRUE THEN
  RAISE EXCEPTION 'Only someone with Approve Personnel postings can choose who approves Personnel postings' USING ERRCODE='42501';END IF;
 IF prior.id IS NOT NULL AND prior.scope<>p_scope THEN RAISE EXCEPTION 'A setting cannot change between group standard and company setting' USING ERRCODE='22023';END IF;
 IF prior.state='retired' THEN RAISE EXCEPTION 'A retired company setting cannot change' USING ERRCODE='22023';END IF;
 IF p_publish AND p_scope='company' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p_data)) THEN RAISE EXCEPTION 'Override at least one field, or apply the group standard' USING ERRCODE='22023';END IF;
  SELECT string_agg(c.legal_name||' ('||coalesce(other.name,'another company setting')||')',', ' ORDER BY c.legal_name) INTO clash
  FROM public.probation_settings_scope_member m JOIN public.company c ON c.id=m.company_id AND c.tenant_id=m.tenant_id
  LEFT JOIN public.probation_settings_scope_version other ON other.tenant_id=m.tenant_id AND other.id=m.version_id
  WHERE m.tenant_id=t AND m.company_id=ANY(companies) AND m.setting_key<>p_key;
  IF clash IS NOT NULL THEN RAISE EXCEPTION 'A company can be in only one company setting. Already in another setting: %',left(clash,500) USING ERRCODE='23505';END IF;
  mapping:=coalesce((SELECT data->>'organisationMapping' FROM public.probation_settings_scope_version WHERE tenant_id=t AND scope='standard' AND state='published' ORDER BY version DESC LIMIT 1),app.probation_organisation_mapping());
  FOR rule IN SELECT value FROM jsonb_array_elements(coalesce(p_data->'overrides','[]'::jsonb)) LOOP
   FOREACH v_company IN ARRAY companies LOOP PERFORM app.probation_assert_organisation_scope(rule,mapping,v_company);END LOOP;
  END LOOP;
 END IF;
 v_version:=coalesce(prior.version,0)+1;
 INSERT INTO public.probation_settings_scope_version(tenant_id,setting_key,scope,version,state,name,company_ids,data,reason,created_by,published_by,published_at)
 VALUES(t,p_key,p_scope,v_version,CASE WHEN p_publish THEN 'published' ELSE 'draft' END,btrim(p_name),companies,
  CASE WHEN p_scope='standard' THEN (p_data-'version'-'scope'-'gradeHFormPublished')||jsonb_build_object('organisationMapping',coalesce(p_data->>'organisationMapping',app.probation_organisation_mapping())) ELSE p_data END,
  nullif(btrim(coalesce(p_reason,'')),''),app.current_user_id(),CASE WHEN p_publish THEN app.current_user_id() END,CASE WHEN p_publish THEN now() END)
 RETURNING id INTO v_id;
 IF p_publish THEN
  IF p_scope='company' THEN
   SELECT coalesce(array_agg(m.company_id),'{}'::uuid[]) INTO previous_members FROM public.probation_settings_scope_member m WHERE m.tenant_id=t AND m.setting_key=p_key;
   DELETE FROM public.probation_settings_scope_member m WHERE m.tenant_id=t AND m.setting_key=p_key;
   INSERT INTO public.probation_settings_scope_member(tenant_id,company_id,setting_key,version_id) SELECT t,c,p_key,v_id FROM unnest(companies) c;
   affected:=ARRAY(SELECT DISTINCT c FROM unnest(previous_members||companies) c);
  ELSE
   affected:=ARRAY(SELECT c.id FROM public.company c WHERE c.tenant_id=t AND c.archived_at IS NULL AND app.probation_company_entitled(c.id));
  END IF;
  materialized:=app.probation_settings_materialize(affected);
 END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'probation_settings',p_key,CASE WHEN p_publish THEN 'probation.settings_scope.published' ELSE 'probation.settings_scope.saved' END,'user'::actor_type,app.current_user_id(),
  jsonb_build_object('scope',p_scope,'versionId',v_id,'version',v_version,'companies',to_jsonb(companies),'previousCompanies',to_jsonb(previous_members),
   'fields',CASE WHEN p_scope='company' THEN (SELECT coalesce(jsonb_agg(k ORDER BY k),'[]'::jsonb) FROM jsonb_object_keys(p_data) k) ELSE '[]'::jsonb END,'resolvedVersions',materialized,'reason',nullif(btrim(coalesce(p_reason,'')),'')));
 RETURN jsonb_build_object('id',v_id,'settingKey',p_key,'version',v_version,'resolvedVersions',materialized);
END $$;
--> statement-breakpoint
-- Settings: Intake and activation (body from 0949_probation_confirmation; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_intake_companies() RETURNS TABLE(id uuid,name text,"canPrepare" boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT co.id,co.legal_name,app.probation_intake_admin(co.id) FROM company co WHERE co.tenant_id=app.current_tenant_id() AND co.archived_at IS NULL AND app.probation_active_user() AND app.probation_company_entitled(co.id) AND (app.probation_intake_admin(co.id) OR CASE WHEN EXISTS(SELECT 1 FROM probation_access opted WHERE opted.tenant_id=co.tenant_id AND opted.user_id=app.current_user_id() AND opted.role IN('pbp','gbs') AND app.is_company_descendant(co.id,opted.company_id) AND opted.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (opted.valid_to IS NULL OR opted.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN EXISTS(SELECT 1 FROM employment employee WHERE employee.tenant_id=co.tenant_id AND employee.company_id=co.id AND (app.probation_role(employee.id,'pbp') OR app.probation_role(employee.id,'gbs'))) ELSE false END) ORDER BY co.legal_name,co.id;
$$;
--> statement-breakpoint
-- Settings: Intake and activation (body from 5010_employee_import_staged_job; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_intake_workspace(p_company uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE e employment;entry probation_intake_entry;source jsonb;settings jsonb;issues jsonb;classification text;items jsonb:='[]';count integer:=0;holders jsonb;can_review boolean;stage_options jsonb;extensions integer;option_count integer;proposal uuid;
BEGIN
 IF app.probation_storage_runner() IS NOT TRUE AND app.probation_intake_admin(p_company) IS NOT TRUE AND NOT EXISTS(SELECT 1 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) employee WHERE employee.company_id=p_company AND employee.tenant_id=app.current_tenant_id() AND (app.probation_role(employee.id,'pbp') OR app.probation_role(employee.id,'gbs'))) THEN RAISE EXCEPTION 'Scoped intake preparation authority required';END IF;
 SELECT data INTO settings FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='settings' AND state='published' ORDER BY version DESC LIMIT 1;
 FOR e IN SELECT * FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) employment WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND app.probation_intake_exclusion(id) IS NULL AND (app.probation_storage_runner() OR app.probation_intake_admin(p_company) OR app.probation_role(id,'pbp') OR app.probation_role(id,'gbs')) ORDER BY employee_code,id LIMIT 501 LOOP
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
 SELECT coalesce(jsonb_agg(jsonb_build_object('role',role.key,'name',person.full_name,'userId',u.id) ORDER BY role.key),'[]') INTO holders FROM jsonb_each_text(source->'holders') role JOIN app_user u ON u.id=role.value::uuid AND u.tenant_id=e.tenant_id JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) person ON person.id=u.person_id AND person.tenant_id=u.tenant_id;
 extensions:=coalesce((entry.data->>'extensionCount')::integer,0);stage_options:='[]';SELECT least(2,count(*))::integer INTO option_count FROM jsonb_array_elements(source->'extensionHistory') event WHERE event->>'kind'<>'date_shift' AND event->>'months' IN('3','6') AND source->>'extendedEndOn' IS NOT NULL;
 SELECT jsonb_agg(jsonb_build_object('extensionCount',choice,'requiredParts',app.probation_intake_required_parts(source,settings,choice)) ORDER BY choice) INTO stage_options FROM generate_series(0,option_count) choice;
 items:=items||jsonb_build_array(jsonb_build_object('source',source,'classification',classification,'issues',issues,'canReview',can_review,'canValidate',app.probation_role(e.id,'pbp'),'requiredParts',app.probation_intake_required_parts(source,settings,extensions),'stageOptions',stage_options,'offlineDecisionReady',proposal IS NOT NULL,'offlineDecision',CASE WHEN can_review THEN app.probation_offline_decision_json(proposal) ELSE NULL END,'holders',holders,'sourceDigest',app.probation_intake_digest(e.id),'disposition',CASE WHEN entry.id IS NULL THEN NULL ELSE entry.data||jsonb_build_object('id',entry.id,'revision',entry.revision,'sourceDigest',entry.source_digest) END,'evidence',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'reason',f.reason,'createdAt',f.created_at) ORDER BY f.created_at,f.id),'[]') FROM probation_intake_evidence f WHERE f.tenant_id=e.tenant_id AND f.employment_id=e.id)));
 END LOOP;
 RETURN jsonb_build_object('candidates',items,'truncated',count>500,'excludedCount',(SELECT count(*) FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) all_employment WHERE all_employment.tenant_id=app.current_tenant_id() AND all_employment.company_id=p_company AND app.probation_intake_exclusion(all_employment.id) IS NOT NULL AND (app.probation_storage_runner() OR app.probation_intake_admin(p_company) OR app.probation_role(all_employment.id,'pbp') OR app.probation_role(all_employment.id,'gbs'))));
END $function$;
--> statement-breakpoint
-- Settings: Intake and activation (the intake reader reads Personnel through this owner) (body from 0949_probation_confirmation; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_personnel_source(p_employment uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;
BEGIN
 SELECT * INTO e FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_company_entitled(e.company_id) AND (
  app.probation_role(e.id,'gbs') OR app.probation_role(e.id,'pbp') OR app.probation_role(e.id,'lm') OR app.probation_role(e.id,'employee') OR app.probation_role(e.id,'hod') OR app.probation_intake_admin(e.company_id)
  OR EXISTS(SELECT 1 FROM probation_case c WHERE c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.company_id=e.company_id AND app.probation_case_company_current(c.id) AND app.probation_case_access(c.id))
 )) THEN RAISE EXCEPTION 'Personnel record unavailable for probation';END IF;
 RETURN app.probation_personnel_source_unchecked(p_employment);
END $$;
--> statement-breakpoint
-- Settings: Intake and activation (body from 0949_probation_confirmation; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_cutover_snapshot(p_company uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT(app.probation_intake_admin(p_company) OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'Named cutover preparer required';END IF;
 SELECT jsonb_build_object('companyId',p_company,'personnel',coalesce(jsonb_agg(jsonb_build_object('id',e.id,'joinDate',e.join_date,'hiredOn',e.hired_on,'endOn',coalesce(e.final_confirmation_date,e.extended_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on),'gradeId',e.grade_id,'confirmation',e.confirmation_date,'resignation',e.resignation_date,'termination',e.terminated_on,'employeeName',(SELECT full_name FROM person WHERE id=e.person_id AND tenant_id=e.tenant_id),'exclusionReason',app.probation_intake_exclusion(e.id)) ORDER BY e.id),'[]'),'configurations',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'kind',kind) ORDER BY kind,version),'[]') FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND state IN('published','retired')),'cases',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'revision',c.revision,'state',c.data->>'state') ORDER BY c.id),'[]') FROM probation_case c WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=p_company),'legacyReviews',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',legacy.id,'employmentId',legacy.employment_id,'reviewType',legacy.review_type,'status',legacy.status,'endOn',legacy.end_date,'dueOn',legacy.due_date) ORDER BY legacy.id),'[]') FROM employment_review legacy JOIN employment subject ON subject.id=legacy.employment_id AND subject.tenant_id=legacy.tenant_id WHERE legacy.tenant_id=app.current_tenant_id() AND subject.company_id=p_company),'intake',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'revision',i.revision,'sourceDigest',i.source_digest,'data',i.data,'reviewedBy',i.reviewed_by) ORDER BY i.id),'[]') FROM probation_intake_entry i WHERE i.tenant_id=app.current_tenant_id() AND i.company_id=p_company),'reactivation',app.probation_reactivation_cases(p_company),'activation',(SELECT jsonb_build_object('enabled',a.enabled,'watermark',a.activation_on,'digest',a.dry_run_digest,'priorCutover',EXISTS(SELECT 1 FROM probation_cutover previous WHERE previous.tenant_id=a.tenant_id AND previous.company_id=a.company_id AND previous.applied_at IS NOT NULL)) FROM probation_activation a WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=p_company),'offlineDecisions',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'entryId',f.entry_id,'entryRevision',f.entry_revision,'sourceDigest',f.source_digest,'proposedBy',f.proposed_by,'acceptedAt',f.accepted_at,'proposalDigest',encode(sha256(convert_to(jsonb_build_object('outcome',f.outcome,'months',f.extension_months,'reason',f.reason)::text,'UTF8')),'hex')) ORDER BY f.id),'[]') FROM probation_offline_final_proposal f WHERE f.tenant_id=app.current_tenant_id() AND f.company_id=p_company AND f.superseded_at IS NULL),'builders',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'version',b.version,'state',b.state) ORDER BY b.id),'[]') FROM probation_builder_definition b WHERE b.tenant_id=app.current_tenant_id() AND b.company_id=p_company)) INTO result FROM employment e WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=p_company;
 RETURN result;
END $$;
--> statement-breakpoint
-- Settings: Intake and activation (body from 0949_probation_confirmation; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_reactivation_cases(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT(app.probation_intake_admin(p_company) OR app.probation_storage_runner()) OR app.probation_company_entitled(p_company) IS NOT TRUE THEN
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
--> statement-breakpoint
-- Settings: Intake and activation (body from 0949_probation_confirmation; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_prepare_cutover_plan(p_company uuid,p_plan jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fingerprint text;v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 IF app.probation_intake_admin(p_company) IS NOT TRUE OR p_plan->>'companyId' IS DISTINCT FROM p_company::text OR p_plan->>'module' IS DISTINCT FROM 'probation' OR p_plan->>'activationOn' IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text OR p_plan->'sourceSnapshot' IS DISTINCT FROM app.probation_cutover_snapshot(p_company) OR p_plan->>'sends' IS DISTINCT FROM 'false' OR p_plan->'noCatchup'->>'pastDatesExcluded' IS DISTINCT FROM 'true' OR p_plan->'noCatchup'->>'requiresNamedOwnerApproval' IS DISTINCT FROM 'true' OR jsonb_typeof(p_plan->'wouldFire') IS DISTINCT FROM 'array' OR jsonb_typeof(p_plan->'excludedPast') IS DISTINCT FROM 'array' OR jsonb_typeof(p_plan->'holds') IS DISTINCT FROM 'array' OR jsonb_typeof(p_plan->'imports') IS DISTINCT FROM 'array' OR jsonb_array_length(p_plan->'imports')>500 THEN RAISE EXCEPTION 'Prepare the complete current-source no-catch-up rehearsal before approval';END IF;
 fingerprint:=encode(sha256(convert_to(p_plan::text,'UTF8')),'hex');INSERT INTO probation_cutover(tenant_id,company_id,data,digest,actor_user_id) VALUES(app.current_tenant_id(),p_company,p_plan,fingerprint,app.current_user_id()) RETURNING id INTO v_id;RETURN jsonb_build_object('id',v_id,'digest',fingerprint,'snapshot',p_plan,'sends',false);
END $$;
--> statement-breakpoint
-- Settings: Intake and activation (body from 0949_probation_confirmation; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_approve_cutover(p_id uuid,p_digest text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_cutover;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_cutover WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.probation_intake_admin(c.company_id) OR c.data->>'planComplete' IS DISTINCT FROM 'true' OR c.data->'holds' IS DISTINCT FROM '[]'::jsonb OR c.applied_at IS NOT NULL OR c.digest IS DISTINCT FROM p_digest OR length(btrim(coalesce(p_reason,'')))<3 OR coalesce(c.data->'sourceSnapshot',c.data) IS DISTINCT FROM app.probation_cutover_snapshot(c.company_id) THEN RAISE EXCEPTION 'Review and approve the unchanged current cutover dry run';END IF;
 IF c.approved_at IS NOT NULL THEN
  IF c.approved_by IS NOT DISTINCT FROM app.current_user_id() AND c.reason IS NOT DISTINCT FROM p_reason THEN RETURN;END IF;
  RAISE EXCEPTION 'Prepare a new cutover review to replace an existing approval';
 END IF;
 UPDATE probation_cutover SET approved_by=app.current_user_id(),approved_at=now(),reason=p_reason WHERE id=c.id;
END $$;
--> statement-breakpoint
-- Settings: Intake and activation (the recorded approver must still hold it) (body from 2107_probation_module_permission; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_request_activation(p_id uuid,p_digest text,p_reference text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_cutover;v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_cutover WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.probation_intake_admin(c.company_id) IS NOT TRUE OR c.digest IS DISTINCT FROM p_digest
  OR c.approved_by IS NULL OR NOT app.probation_intake_admin_for(c.tenant_id,c.approved_by,c.company_id)
  OR c.applied_at IS NOT NULL OR c.created_at<now()-interval '1 day'
  OR c.data->>'planComplete' IS DISTINCT FROM 'true' OR c.data->'holds' IS DISTINCT FROM '[]'::jsonb
  OR coalesce(c.data->'sourceSnapshot',c.data) IS DISTINCT FROM app.probation_cutover_snapshot(c.company_id)
  OR length(btrim(coalesce(p_reference,''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'Review and approve the unchanged current cutover before requesting activation';END IF;
 INSERT INTO probation_activation_request(tenant_id,cutover_id,company_id,requested_by,digest,installation_reference)
 VALUES(c.tenant_id,c.id,c.company_id,app.current_user_id(),c.digest,btrim(p_reference))
 ON CONFLICT(tenant_id,cutover_id) DO NOTHING RETURNING id INTO v_id;
 IF v_id IS NULL THEN SELECT id INTO v_id FROM probation_activation_request WHERE tenant_id=c.tenant_id AND cutover_id=c.id;RETURN v_id;END IF;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(c.tenant_id,'probation',c.company_id,'probation.runtime.activation-requested','user',app.current_user_id(),jsonb_build_object('requestId',v_id,'cutoverId',c.id,'digest',c.digest));
 RETURN v_id;
END $$;
--> statement-breakpoint
-- Settings: Intake and activation (the recorded approver must still hold it) (body from 2107_probation_module_permission; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_activate_cutover(p_id uuid,p_day date) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_cutover;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_storage_runner() OR p_day IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Explicit owner current-day activation required';END IF;
 SELECT * INTO c FROM probation_cutover WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.probation_company_entitled(c.company_id) IS NOT TRUE OR c.data->>'planComplete' IS DISTINCT FROM 'true' OR c.approved_by IS NULL OR c.applied_at IS NOT NULL OR c.created_at<now()-interval '1 day' OR coalesce(c.data->'sourceSnapshot',c.data) IS DISTINCT FROM app.probation_cutover_snapshot(c.company_id) OR NOT app.probation_intake_admin_for(c.tenant_id,c.approved_by,c.company_id) THEN RAISE EXCEPTION 'A fresh approved cutover and current Probation module permission are required';END IF;
 INSERT INTO probation_activation(tenant_id,company_id,enabled,activation_on,dry_run_digest,approved_by) VALUES(c.tenant_id,c.company_id,true,p_day,c.digest,c.approved_by) ON CONFLICT(tenant_id,company_id) DO UPDATE SET enabled=true,activation_on=p_day,dry_run_digest=c.digest,approved_by=c.approved_by,updated_at=now();
 UPDATE probation_cutover SET applied_at=now() WHERE id=c.id;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  VALUES(c.tenant_id,'probation',c.company_id,'probation.runtime.activated','system',NULL,jsonb_build_object('cutoverId',c.id,'digest',c.digest,'activationOn',p_day));
END $$;
--> statement-breakpoint
-- Cases: Approve and release letters (body from 0949_probation_confirmation; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_letter_template_choices(p_outcome uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;choices jsonb;best integer;ties integer;suggested text;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF c.id IS NULL OR app.probation_case_company_current(c.id) IS NOT TRUE OR NOT((app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters')) OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'Scoped outcome operator required';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'familyId',definition_key,'version',version,'name',data->>'name','score',score) ORDER BY score DESC,data->>'name',id),'[]'),max(score) INTO choices,best FROM(SELECT t.*,app.probation_letter_template_score(o.id,t.id) as score FROM probation_builder_definition t WHERE t.tenant_id=c.tenant_id AND t.company_id=c.company_id AND t.kind='template') candidates WHERE score IS NOT NULL;
 SELECT count(*),min(item->>'id') INTO ties,suggested FROM jsonb_array_elements(choices) item WHERE (item->>'score')::integer=best;
 RETURN jsonb_build_object('templates',choices,'suggestedTemplateId',CASE WHEN ties=1 THEN suggested ELSE NULL END,'tie',ties>1);
END $$;
--> statement-breakpoint
-- Cases: Approve and release letters (body from 0949_probation_confirmation; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_letter_preview(p_outcome uuid,p_template uuid,p_edits jsonb,p_expected integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;source jsonb;merged jsonb;descriptor jsonb;rules jsonb;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF o.id IS NULL OR NOT((app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters')) OR app.probation_role(c.employment_id,'gbs')) OR o.revision IS DISTINCT FROM p_expected OR o.released_at IS NOT NULL OR o.outcome='other' OR NOT app.probation_review_complete(o.part_id) THEN RAISE EXCEPTION 'Scoped reviewer and current signed outcome required for letter preview';END IF;IF app.probation_case_company_current(c.id) IS NOT TRUE THEN RAISE EXCEPTION 'The employing company changed; this case is historical';END IF;PERFORM app.probation_assert_runtime(c.company_id);
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND state='published' AND app.probation_letter_template_score(o.id,id) IS NOT NULL;IF NOT FOUND THEN RAISE EXCEPTION 'Matching approved published letter template required';END IF;
 IF jsonb_typeof(coalesce(p_edits,'{}'))<>'object' OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(p_edits,'{}')) e WHERE jsonb_typeof(e.value)<>'string' OR length(e.value#>>'{}')>10000 OR e.key IN('employeeName','employeeCode','companyName','startOn','endOn','outcome','extensionMonths','employeeJobTitle','employeeGrade','businessGroup','businessUnit','division','department','lineManagerName','hodName','pbpName','originalEndOn','reviewPlanMonths','confirmationEffectiveOn','extensionNewEndOn','extensionCount','maxExtensions','signatoryName','signatoryTitle','acknowledgedBy','acknowledgedOn','company.name','company.regNo','company.address','company.color') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(t.data->'fields','[]')) f WHERE f->>'id'=e.key AND f->>'owner'='hr' AND f->>'pmKey' IS NULL)) THEN RAISE EXCEPTION 'Only declared editable HR fields may be supplied';END IF;
 source:=app.probation_personnel_source(c.employment_id)||app.probation_letter_company_values(c.company_id,c.tenant_id)||jsonb_build_object('letterValues',app.probation_letter_values(o.id,t.id));IF source->>'resignationOn' IS NOT NULL OR source->>'terminatedOn' IS NOT NULL OR source->>'confirmationOn' IS NOT NULL OR source->>'companyId' IS DISTINCT FROM c.company_id::text OR source->>'startOn' IS DISTINCT FROM c.data->>'startOn' OR source->>'endOn' IS NOT NULL AND source->>'endOn' IS DISTINCT FROM c.data->>'endOn' THEN RAISE EXCEPTION 'Personnel eligibility or period changed; reconcile before generating a letter';END IF;merged:=coalesce(p_edits,'{}')||jsonb_build_object('employeeName',source->>'employeeName','employeeCode',source->>'employeeCode','companyName',source->>'companyName','startOn',c.data->>'startOn','endOn',c.data->>'endOn','outcome',o.outcome,'extensionMonths',(app.probation_evaluation_decision(o.part_id)->>'extensionMonths'))||app.probation_letter_company_values(c.company_id,c.tenant_id)||coalesce(source->'letterValues','{}');
 SELECT jsonb_build_object('requiredRoles',jsonb_agg(DISTINCT s->>'role')) INTO rules FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'required'='true';
 descriptor:=jsonb_build_object('sourceStamp',app.probation_letter_source_stamp(source),'merge',merged,'blocks',t.data->'blocks','fields',coalesce(t.data->'fields','[]'),'route',t.data->'route','guardrails',rules,'companyId',c.company_id,'employmentId',c.employment_id,'templateName',t.data->>'name','templateId',t.id,'templateVersion',t.version,'outcomeRevision',o.revision);
 RETURN descriptor||jsonb_build_object('sourceDigest',encode(sha256(convert_to(descriptor::text,'UTF8')),'hex'));
END $$;
--> statement-breakpoint
-- Cases: Approve and release letters (body from 5752_probation_letter_routing; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_prepare_letter(p_outcome uuid,p_template uuid,p_merge jsonb,p_expected integer,p_source_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;p probation_part;source jsonb;merged jsonb;rules jsonb;v_part uuid:=gen_random_uuid();basehash text;descriptor jsonb;old_pointer uuid;routed boolean;placeholder jsonb;holders jsonb;fallback text;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RAISE EXCEPTION 'Recorded outcome unavailable';END IF;old_pointer:=o.letter_part_id;IF old_pointer IS NOT NULL THEN PERFORM 1 FROM probation_part WHERE id=old_pointer AND tenant_id=o.tenant_id FOR UPDATE;END IF;
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF o.letter_part_id IS DISTINCT FROM old_pointer THEN RAISE EXCEPTION 'The letter revision changed; reload before preparing';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;PERFORM app.probation_assert_case_runtime(c.id);
 IF NOT((app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters')) OR app.probation_role(c.employment_id,'gbs')) OR o.revision IS DISTINCT FROM p_expected OR o.released_at IS NOT NULL OR o.state='release_requested' OR o.outcome='other' OR NOT app.probation_review_complete(o.part_id) THEN RAISE EXCEPTION 'Scoped reviewer and current signed recorded outcome required';END IF;
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND state='published' AND app.probation_letter_template_score(o.id,id) IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Use a complete published matching template';END IF;
 PERFORM 1 FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR SHARE;descriptor:=app.probation_letter_preview(o.id,t.id,p_merge,p_expected);IF descriptor->>'sourceDigest' IS DISTINCT FROM p_source_digest THEN RAISE EXCEPTION 'The letter source changed; preview and render it again';END IF;PERFORM app.probation_validate_letter_fields(descriptor->'fields',descriptor->'merge',true);merged:=descriptor->'merge';
 routed:=app.probation_letter_routed(t.data);
 -- 5752: a routed template version freezes its own routing (resolved by the caller, then app.probation_letter_freeze_route);
 -- the legacy role route below applies only to versions without routing, exactly as before.
 IF routed THEN
 IF app.probation_letter_routing_valid(t.data->'routing') IS NOT TRUE THEN RAISE EXCEPTION 'Complete every step of the signing and review routing';END IF;
 rules:=jsonb_build_object('requiredRoles','[]'::jsonb);
 SELECT jsonb_build_object('version',1,'steps',jsonb_agg(jsonb_build_object('id',s->>'id','role','routing','kind',s->>'action','stage',(s->>'order')::integer,'holderId',NULL,'required',true) ORDER BY (s->>'order')::integer,n)) INTO placeholder FROM jsonb_array_elements(t.data->'routing') WITH ORDINALITY x(s,n);
 ELSE
 SELECT jsonb_build_object('requiredRoles',jsonb_agg(DISTINCT s->>'role')) INTO rules FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'required'='true';
 IF rules->'requiredRoles' IS NULL OR jsonb_array_length(rules->'requiredRoles')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.data->'route'->'steps') s WHERE s->>'role' NOT IN('pbp','lm','hod','employee') OR s->>'holderId' IS NOT NULL OR s->>'representedId' IS NOT NULL) THEN RAISE EXCEPTION 'Letter routes need current source roles and required signers';END IF;
 PERFORM app.document_signing_validate(jsonb_build_object('route',t.data->'route','actions','[]'::jsonb),rules);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(t.data->'route'->'steps') staff CROSS JOIN jsonb_array_elements(t.data->'route'->'steps') hr WHERE staff->>'role'='employee' AND hr->>'role'<>'employee' AND (staff->>'stage')::integer<=(hr->>'stage')::integer) THEN RAISE EXCEPTION 'HR signing must precede employee acknowledgement';END IF;
 END IF;
 basehash:=descriptor->>'sourceDigest';
 -- A new draft has its own immutable signing subject; previous signed subjects remain readable history.
 INSERT INTO probation_part(id,tenant_id,case_id,data) VALUES(v_part,c.tenant_id,c.id,jsonb_build_object('id',v_part,'documentKind','letter','evaluationPartId',o.part_id,'letterOutcomeId',o.id,'letterTemplateId',t.id,'letterTemplateVersion',t.version,'letterTemplateName',t.data->>'name','letterMerge',merged,'letterBlocks',t.data->'blocks','letterFields',coalesce(t.data->'fields','[]'),'letterBaseHash',basehash,'letterSourceStamp',descriptor->'sourceStamp','letterGuardrails',rules,'route',CASE WHEN routed THEN placeholder ELSE t.data->'route' END,'state','pending_approval','type',0,'cycle',o.revision)||CASE WHEN routed THEN jsonb_build_object('letterRouting',t.data->'routing','letterRoutingPending',true) ELSE '{}'::jsonb END);
 IF o.letter_part_id IS NOT NULL THEN UPDATE probation_part SET data=jsonb_set(data,'{state}','"cancelled"'),revision=revision+1 WHERE id=o.letter_part_id AND tenant_id=o.tenant_id;END IF;
 UPDATE probation_outcome SET template_id=t.id::text,template_version=t.version,merge_data=merged,letter_part_id=v_part,state='awaiting_release',revision=revision+1,updated_at=now() WHERE id=o.id;
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(c.tenant_id,v_part,'meta',1,(SELECT data FROM probation_part WHERE id=v_part),app.current_user_id(),'Prepared outcome letter');
 PERFORM app.probation_audit(c.id,v_part,'letter_prepared');
 holders:=app.probation_holders(c.employment_id);
 fallback:=coalesce(nullif(c.data->'config'->>'fallbackGroupId',''),(SELECT v.data->>'peopleOpsGroup' FROM lc_v9_config v WHERE v.tenant_id=c.tenant_id));
 RETURN app.probation_signing_content(v_part)||CASE WHEN routed THEN jsonb_build_object('routing',t.data->'routing','templateKey',t.definition_key,'caseOwnerId',holders->>'pbp','fallbackGroupId',fallback) ELSE '{}'::jsonb END||jsonb_build_object('partId',v_part,'outcomeRevision',o.revision+1,'route',app.probation_resolved_route(v_part),'guardrails',rules,'merge',merged,'blocks',t.data->'blocks','fields',coalesce(t.data->'fields','[]'));
END $$;
--> statement-breakpoint
-- Cases: Approve and release letters (body from 5759_probation_employee_own_steps_only; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_letter_freeze_route(p_part uuid,p_route jsonb,p_unresolved jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();p probation_part;c probation_case;h jsonb;s jsonb;r jsonb;expected_role text;cleaned jsonb:='[]'::jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=t FOR UPDATE;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR jsonb_typeof(p.data->'letterRouting') IS DISTINCT FROM 'array' OR p.data->'letterRoutingPending' IS DISTINCT FROM 'true'::jsonb
  OR EXISTS(SELECT 1 FROM document_signing_document d WHERE d.tenant_id=t AND d.subject_type='probation' AND d.subject_id=p.id)
  OR NOT((app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters')) OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'A just-prepared routed letter and its scoped preparer are required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF jsonb_typeof(p_route) IS DISTINCT FROM 'object' OR p_route->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p_route->'steps') IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_route->'steps')<>jsonb_array_length(p.data->'letterRouting') OR jsonb_typeof(p_unresolved) IS DISTINCT FROM 'array' OR jsonb_array_length(p_unresolved)>30 THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
 h:=app.probation_holders(c.employment_id);
 FOR s IN SELECT value FROM jsonb_array_elements(p_route->'steps') LOOP
  SELECT value INTO r FROM jsonb_array_elements(p.data->'letterRouting') WHERE value->>'id'=s->>'id';
  IF r IS NULL THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
  expected_role:=CASE r->'who'->>'kind' WHEN 'employee' THEN 'employee' WHEN 'directSuperior' THEN 'lm' WHEN 'routing' THEN 'routing:'||(r->'who'->>'routingId') WHEN 'group' THEN 'group:'||(r->'who'->>'groupId') ELSE 'people' END;
  IF s->>'role' IS DISTINCT FROM expected_role OR s->>'kind' IS DISTINCT FROM r->>'action' OR s->'stage' IS DISTINCT FROM r->'order' OR s->'required' IS DISTINCT FROM 'true'::jsonb
   OR coalesce(s->'owner','false'::jsonb) IS DISTINCT FROM r->'owner' OR s ? 'coveredStepIds' OR s ? 'coveredByStepId' OR s ? 'representedId'
   OR s ? 'meantFor' AND (jsonb_typeof(s->'meantFor') IS DISTINCT FROM 'string' OR length(s->>'meantFor')>300) THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
  IF s->>'holderId' IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id::text=s->>'holderId' AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'A routed letter step holder is unavailable';END IF;
   -- 5759: the case's own employee holds only "The employee" step.
   IF r->'who'->>'kind' IS DISTINCT FROM 'employee' THEN
    IF EXISTS(SELECT 1 FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.id::text=s->>'holderId' AND u.tenant_id=t AND e.id=c.employment_id) THEN RAISE EXCEPTION 'The employee cannot review or approve their own probation';END IF;
   END IF;
   IF NOT s ? 'meantFor' AND (r->'who'->>'kind'='employee' AND s->>'holderId' IS DISTINCT FROM h->>'employee' OR r->'who'->>'kind'='directSuperior' AND s->>'holderId' IS DISTINCT FROM h->>'lm'
    OR r->'who'->>'kind'='people' AND NOT (r->'who'->'userIds') ? (s->>'holderId')) THEN RAISE EXCEPTION 'A routed letter step names someone its routing does not';END IF;
  END IF;
  cleaned:=cleaned||jsonb_build_array(s-'holderPersonId');
 END LOOP;
 UPDATE probation_part SET data=(data-'letterRoutingPending')||jsonb_build_object('route',jsonb_build_object('version',1,'steps',cleaned),'letterRoutingUnresolved',p_unresolved),revision=revision+1,updated_at=now() WHERE id=p.id;
 IF jsonb_array_length(p_unresolved)>0 THEN
  INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(t,'probation',c.id,'probation.letter_routing_fallback',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,
   jsonb_build_object('caseId',c.id,'partId',p.id,'unresolved',(SELECT jsonb_agg(jsonb_build_object('stepId',x->>'stepId','meantFor',left(coalesce(x->>'meantFor',''),300),'reason',left(coalesce(x->>'reason',''),300),'fallbackGroupId',x->>'fallbackGroupId','holderId',x->>'holderId')) FROM jsonb_array_elements(p_unresolved) x)));
 END IF;
END $$;
--> statement-breakpoint
-- Cases: Approve and release letters (body from 5752_probation_letter_routing; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_letter_routing_context(p_part uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();p probation_part;c probation_case;h jsonb;routing jsonb;fallback text;routing_ids uuid[];group_ids text[];result jsonb;title text;bg uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=t;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR jsonb_typeof(p.data->'letterRouting') IS DISTINCT FROM 'array'
  OR NOT((app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters')) OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'Scoped letter preparer required';END IF;
 routing:=p.data->'letterRouting';h:=app.probation_holders(c.employment_id);
 fallback:=coalesce(nullif(c.data->'config'->>'fallbackGroupId',''),(SELECT v.data->>'peopleOpsGroup' FROM lc_v9_config v WHERE v.tenant_id=t));
 SELECT pos.title INTO title FROM assignment a JOIN position pos ON pos.id=a.position_id AND pos.tenant_id=a.tenant_id
  WHERE a.employment_id=c.employment_id AND a.tenant_id=t AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1;
 SELECT coalesce(co.parent_company_id,co.id) INTO bg FROM company co WHERE co.id=c.company_id AND co.tenant_id=t;
 SELECT coalesce(array_agg(DISTINCT (s->'who'->>'routingId')::uuid),'{}') INTO routing_ids FROM jsonb_array_elements(routing) s WHERE s->'who'->>'kind'='routing';
 WITH r AS MATERIALIZED (
  SELECT DISTINCT ON (v.routing_id) v.routing_id,v.name,v.routing_rows,v.retired FROM automation_routing_version v
  WHERE v.tenant_id=t AND v.routing_id=ANY(routing_ids) ORDER BY v.routing_id,v.revision DESC)
 SELECT array_agg(DISTINCT g) INTO group_ids FROM (
  SELECT s->'who'->>'groupId' AS g FROM jsonb_array_elements(routing) s WHERE s->'who'->>'kind'='group'
  UNION ALL SELECT row->'assignTo'->>'groupId' FROM r CROSS JOIN LATERAL jsonb_array_elements(r.routing_rows) row WHERE NOT r.retired AND row->'assignTo'->>'kind'='group'
  UNION ALL SELECT fallback) x WHERE g IS NOT NULL;
 SELECT jsonb_build_object(
  'employeeUserId',h->>'employee','directSuperiorUserId',h->>'lm','caseOwnerId',h->>'pbp','fallbackGroupId',fallback,
  'facts',jsonb_build_object('businessGroup',h->>'businessUnitId','businessGroupCompany',bg,'company',c.company_id,'department',h->>'departmentId','jobTitle',title),
  'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.routing_id,'name',r.name,'rows',r.routing_rows)) FROM (
    SELECT DISTINCT ON (v.routing_id) v.routing_id,v.name,v.routing_rows,v.retired FROM automation_routing_version v
    WHERE v.tenant_id=t AND v.routing_id=ANY(routing_ids) ORDER BY v.routing_id,v.revision DESC) r WHERE NOT r.retired),'[]'::jsonb),
  'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g->>'id','members',coalesce((
    SELECT jsonb_agg(u.id ORDER BY m.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members')='array' THEN g->'members' ELSE '[]'::jsonb END) WITH ORDINALITY m(id,n)
    JOIN app_user u ON u.id::text=m.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE m.n<=500),'[]'::jsonb)))
   FROM lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.data->'groups')='array' THEN v.data->'groups' ELSE '[]'::jsonb END) g
   WHERE v.tenant_id=t AND g->>'id'=ANY(coalesce(group_ids,'{}'))),'[]'::jsonb),
  'recent',coalesce((SELECT jsonb_object_agg(x.holder,x.n) FROM (
    SELECT st->>'holderId' AS holder,count(*) AS n FROM (SELECT d.data FROM document_signing_document d WHERE d.tenant_id=t AND d.subject_type='probation' AND jsonb_typeof(d.data->'routing')='object' ORDER BY d.created_at DESC LIMIT 2000) recent
    CROSS JOIN LATERAL jsonb_array_elements(recent.data->'route'->'steps') st WHERE st->>'holderId' IS NOT NULL GROUP BY 1) x),'{}'::jsonb)) INTO result;
 RETURN result;
END $$;
--> statement-breakpoint
-- Cases: Approve and release letters (body from 0949_probation_confirmation; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_letter_release(p_outcome uuid,p_expected integer,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;f probation_file;doc uuid;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;PERFORM app.probation_assert_case_runtime(c.id);
 IF o.released_at IS NOT NULL THEN RETURN;END IF;
 IF o.revision IS DISTINCT FROM p_expected OR o.state<>'awaiting_release' OR o.letter_file_id IS NULL OR length(btrim(coalesce(p_reason,'')))<3 OR o.outcome IN('extend','not_confirm') AND NOT (app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters')) OR o.outcome='confirm' AND NOT(app.probation_role(c.employment_id,'gbs') OR (app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters')) OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'The current authorised reviewer must release the prepared letter';END IF;
 IF NOT app.probation_review_complete(o.part_id) THEN RAISE EXCEPTION 'The evaluation route must be complete before letter release';END IF;
 SELECT * INTO f FROM probation_file WHERE id=o.letter_file_id AND tenant_id=o.tenant_id AND kind='letter_draft' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Draft letter unavailable';END IF;
 INSERT INTO employee_document(tenant_id,employment_id,title,category,description,content,file_name,mime_type,size_bytes,uploaded_by_user_id,updated_by_user_id) VALUES(c.tenant_id,c.employment_id,'Probation outcome letter','Probation',p_reason,f.content,f.name,'application/pdf',octet_length(f.content),app.current_user_id(),app.current_user_id()) RETURNING id INTO doc;
 UPDATE probation_file SET kind='letter_released',employee_document_id=doc WHERE id=f.id;
 UPDATE probation_outcome SET state='released',released_by=app.current_user_id(),released_at=now(),updated_at=now() WHERE id=o.id;
 PERFORM app.probation_audit(c.id,o.part_id,'letter_released',p_reason);
END $$;
--> statement-breakpoint
-- Cases: Approve and release letters (body from 0949_probation_confirmation; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_release_signed_letter(p_outcome uuid,p_part uuid,p_expected integer,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;p probation_part;d document_signing_document;request uuid;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF o.letter_part_id IS DISTINCT FROM p.id OR p.case_id IS DISTINCT FROM c.id OR p.data->>'letterOutcomeId' IS DISTINCT FROM o.id::text OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR o.revision IS DISTINCT FROM p_expected OR length(btrim(coalesce(p_reason,'')))<3 OR app.probation_signatures_complete(p.id) IS NOT TRUE OR app.probation_review_complete(o.part_id) IS NOT TRUE OR o.outcome IN('extend','not_confirm') AND (app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters')) IS NOT TRUE OR o.outcome='confirm' AND NOT(app.probation_role(c.employment_id,'gbs') OR (app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters'))) THEN RAISE EXCEPTION 'Current authorised release and complete matching signatures required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);IF o.released_at IS NOT NULL THEN RETURN o.letter_file_id;END IF;
 PERFORM 1 FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id FOR SHARE;IF app.probation_letter_source_current(p.id) IS NOT TRUE THEN RAISE EXCEPTION 'Personnel eligibility or signed source changed; prepare a new approved generation';END IF;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 SELECT id INTO request FROM probation_render_request WHERE tenant_id=p.tenant_id AND part_id=p.id AND kind='letter' AND content_hash=d.data->>'contentHash' AND state IN('pending','sealed');IF request IS NOT NULL THEN RETURN request;END IF;
 INSERT INTO probation_render_request(tenant_id,case_id,part_id,outcome_id,kind,content_hash,content_revision,document_id,document_revision,requested_by,reason,render_data)
 VALUES(p.tenant_id,c.id,p.id,o.id,'letter',d.data->>'contentHash',(d.data->>'contentRevision')::integer,d.id,d.revision,app.current_user_id(),p_reason,jsonb_build_object('part',p.data,'signing',d.data,'contentData',app.probation_content(p.id),'createdAt',p.created_at)) RETURNING id INTO request;
 UPDATE probation_outcome SET state='release_requested',failure='Verified owner rendering and Personal File filing are pending.',updated_at=now() WHERE id=o.id;UPDATE probation_part SET data=jsonb_set(data,'{state}','"release_requested"'),revision=revision+1 WHERE id=p.id;PERFORM app.probation_audit(c.id,p.id,'letter_release_requested',p_reason);RETURN request;
END $$;
--> statement-breakpoint
-- Cases: Approve and release letters (body from 5757_probation_legacy_workflow_move; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_letter_transition(p_part uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;o probation_outcome;d document_signing_document;event_kind text;roles jsonb;users jsonb;w probation_builder_definition;step jsonb;v_id uuid;v_event uuid;key text;found_workflow boolean:=false;stage integer;h jsonb;step_roles jsonb;step_users jsonb;routed boolean;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;SELECT * INTO o FROM probation_outcome WHERE id=(p.data->>'letterOutcomeId')::uuid AND tenant_id=p.tenant_id FOR UPDATE;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR o.letter_part_id IS DISTINCT FROM p.id OR d.id IS NULL OR NOT(app.probation_storage_runner() AND o.released_at IS NOT NULL AND EXISTS(SELECT 1 FROM probation_render_request q WHERE q.tenant_id=p.tenant_id AND q.part_id=p.id AND q.state='sealed' AND q.file_id=o.letter_file_id) OR app.probation_active_user() AND ((app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters')) OR app.probation_role(c.employment_id,'gbs') OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'actorId'=app.current_user_id()::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash'))) THEN RAISE EXCEPTION 'Current letter and authenticated transition actor required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF o.state='release_requested' THEN RETURN;END IF;
 routed:=jsonb_typeof(d.data->'routing')='object';
 -- 5752: a routed letter the owner sent round again returns to signing.
 IF routed AND NOT app.document_signing_returned(d.data) AND p.data->>'state'='returned' AND o.released_at IS NULL THEN
  UPDATE probation_part SET data=jsonb_set(data,'{state}','"pending_approval"'),revision=revision+1 WHERE id=p.id;
  UPDATE probation_outcome SET state='awaiting_release',failure=NULL,updated_at=now() WHERE id=o.id AND state='awaiting_revision';
 END IF;
 IF o.released_at IS NOT NULL THEN event_kind:='letter_released';roles:='["employee","lm","pbp"]';
 ELSIF (CASE WHEN routed THEN app.document_signing_returned(d.data) ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'action'='returned' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') END) THEN
 event_kind:='letter_returned';roles:='["pbp","gbs"]';UPDATE probation_part SET data=jsonb_set(data,'{state}','"returned"'),revision=revision+1 WHERE id=p.id AND data->>'state'<>'returned';UPDATE probation_outcome SET state='awaiting_revision',failure='The letter was returned. Prepare a new revision before signing continues.' WHERE id=o.id;
 ELSE
 event_kind:='letter_signing_pending';SELECT min((s->>'stage')::integer) INTO stage FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND NOT CASE WHEN routed THEN app.document_signing_step_fulfilled(d.data,s) ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=s->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') END;
 IF stage IS NULL THEN event_kind:='letter_release_pending';roles:=CASE WHEN o.outcome='confirm' THEN '["pbp","gbs"]'::jsonb ELSE '["pbp"]'::jsonb END;ELSE SELECT jsonb_agg(DISTINCT s->>'role'),jsonb_agg(DISTINCT s->>'holderId') INTO roles,users FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND (s->>'stage')::integer=stage AND s->>'holderId' IS NOT NULL;END IF;
 END IF;
 IF event_kind<>'letter_signing_pending' THEN users:=app.probation_users_for_roles(c.employment_id,roles);END IF;
 IF coalesce(jsonb_array_length(users),0)=0 THEN RETURN;END IF;
 FOR w IN SELECT * FROM probation_builder_definition WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND kind='workflow' AND state='published' AND data->'trigger'->>'event'=event_kind AND c.data->'workflowIds'?id::text LOOP
 FOR step IN SELECT value FROM jsonb_array_elements(w.data->'steps') LOOP
 SELECT jsonb_agg(r) INTO step_roles FROM jsonb_array_elements_text(roles) r WHERE step->'to'?r;IF coalesce(jsonb_array_length(step_roles),0)=0 THEN CONTINUE;END IF;
 IF event_kind='letter_signing_pending' THEN SELECT jsonb_agg(DISTINCT st->>'holderId') INTO step_users FROM jsonb_array_elements(d.data->'route'->'steps') st WHERE step_roles?(st->>'role') AND (st->>'stage')::integer=stage AND st->>'holderId' IS NOT NULL;ELSE step_users:=app.probation_users_for_roles(c.employment_id,step_roles);END IF;IF coalesce(jsonb_array_length(step_users),0)=0 THEN CONTINUE;END IF;found_workflow:=true;IF EXISTS(SELECT 1 FROM probation_workflow_move mv WHERE mv.tenant_id=c.tenant_id AND mv.definition_id=w.id) THEN CONTINUE;END IF;key:='probation-letter:'||p.id::text||':'||d.revision::text||':'||event_kind||':'||w.id::text||':'||(step->>'id');
 IF EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN CONTINUE;END IF;
 v_id:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',v_id,'probation.notification-due',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'documentKind','letter','kind',event_kind)) RETURNING id INTO v_event;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id,workflow_id,workflow_step_id) VALUES(v_id,c.tenant_id,c.id,p.id,key,event_kind,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,step_users,step_roles,'scheduled',p.revision,v_event,w.id,step->>'id');
 END LOOP;END LOOP;
 -- Even an unconfigured email definition cannot hide the next assigned in-app signing task.
 IF NOT found_workflow THEN key:='probation-letter:'||p.id::text||':'||d.revision::text||':'||event_kind||':in-app';IF NOT EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN
 v_id:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',v_id,'probation.notification-due',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'documentKind','letter','kind',event_kind)) RETURNING id INTO v_event;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id) VALUES(v_id,c.tenant_id,c.id,p.id,key,event_kind,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,users,roles,'scheduled',p.revision,v_event);END IF;END IF;
END $$;
--> statement-breakpoint
-- Cases: Approve and release letters (the letter itself is readable to whoever may release it) (body from 5755_probation_routed_assignment; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_part_access(p_part uuid,p_rater text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;e uuid;
BEGIN
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id();IF NOT FOUND OR NOT app.probation_case_access(p.case_id) THEN RETURN false;END IF;
 SELECT employment_id INTO e FROM probation_case WHERE id=p.case_id AND tenant_id=app.current_tenant_id();
 IF app.probation_case_company_current(p.case_id) IS NOT TRUE THEN IF app.probation_storage_runner() THEN RETURN true;END IF;IF p.data->>'documentKind'='letter' THEN RETURN p.data->>'state'='locked';END IF;RETURN p_rater IS NULL OR p_rater='employee' OR p_rater='lm' AND p.data->>'managerSubmittedAt' IS NOT NULL;END IF;
 IF p.data->>'documentKind'='letter' AND jsonb_typeof(p.data->'letterRouting')='array' THEN RETURN app.probation_storage_runner() OR app.probation_role(e,'pbp') OR app.probation_case_permitted(e,'cases.letters') OR app.probation_role(e,'gbs') OR EXISTS(SELECT 1 FROM document_signing_document d WHERE d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id AND (app.document_signing_owner(d.data)=app.current_user_id() OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'actorId'=app.current_user_id()::text) OR EXISTS(SELECT 1 FROM app.document_signing_pending_steps(jsonb_set(d.data,'{route}',coalesce(app.probation_resolve_route_unchecked(p.id),d.data->'route'))) st WHERE st->>'holderId'=app.current_user_id()::text)));END IF;
 IF p.data->>'documentKind'='letter' THEN RETURN app.probation_storage_runner() OR app.probation_role(e,'pbp') OR app.probation_case_permitted(e,'cases.letters') OR app.probation_role(e,'gbs') OR EXISTS(SELECT 1 FROM document_signing_document d CROSS JOIN LATERAL jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') st WHERE d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id AND st->>'holderId'=app.current_user_id()::text AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(app.probation_resolve_route_unchecked(p.id)->'steps') prior WHERE (prior->>'stage')::integer<(st->>'stage')::integer AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=prior->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash')));END IF;
 IF p_rater IS NULL OR app.probation_role(e,'pbp') OR app.probation_role(e,'gbs') THEN RETURN true;END IF;
 IF p_rater='employee' THEN RETURN app.probation_role(e,'employee') OR p.data->>'staffSubmittedAt' IS NOT NULL OR p.data->>'acknowledgedAt' IS NOT NULL;END IF;
 IF p_rater='lm' THEN RETURN app.probation_part_role(p.id,'lm') OR p.data->>'managerSubmittedAt' IS NOT NULL;END IF;
 RETURN false;
END $$;
--> statement-breakpoint
-- Cases: Record low-result actions (body from 5760_probation_queue_kinds_and_pbp_tasks; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_record_low_result_action(p_part uuid,p_note text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;v_id uuid;band integer;low_band integer:=2;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Probation review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF app.current_user_id() IS NULL OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR app.probation_case_permitted(c.employment_id,'cases.low_result')) THEN RAISE EXCEPTION 'Only the case''s PBP or GBS People Ops may record the low-result action' USING ERRCODE='42501';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF length(btrim(coalesce(p_note,''))) NOT BETWEEN 3 AND 10000 THEN RAISE EXCEPTION 'Describe the action taken with the Line Manager' USING ERRCODE='22023';END IF;
 IF p.data->>'scoreBand' ~ '^[1-5]$' THEN band:=(p.data->>'scoreBand')::integer;END IF;
 IF c.data->'config'->>'lowBand' ~ '^[1-5]$' THEN low_band:=(c.data->'config'->>'lowBand')::integer;END IF;
 IF band IS NULL OR band>low_band OR p.data->>'managerSubmittedAt' IS NULL OR p.data->>'state'='cancelled' THEN RAISE EXCEPTION 'This review has no low result to act on' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM probation_followup f WHERE f.tenant_id=p.tenant_id AND f.part_id=p.id AND f.kind='low_result_action' AND f.content_revision=p.content_revision) THEN RAISE EXCEPTION 'The low-result action is already recorded' USING ERRCODE='40001';END IF;
 INSERT INTO probation_followup(tenant_id,case_id,part_id,actor_user_id,kind,note,content_revision) VALUES(p.tenant_id,c.id,p.id,app.current_user_id(),'low_result_action',btrim(p_note),p.content_revision) RETURNING id INTO v_id;
 PERFORM app.probation_audit(c.id,p.id,'low_result_action_recorded');
 RETURN v_id;
END $$;
--> statement-breakpoint
-- Cases: Change a case's route (body from 5759_probation_employee_own_steps_only; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_route_override(p_part uuid,p_route jsonb,p_reason text,p_expected integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;rules jsonb;routed boolean:=false;route jsonb:=p_route;form_rows jsonb;form_policy jsonb;policy_patch jsonb:='{}'::jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.revision IS DISTINCT FROM p_expected OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.route')) OR length(btrim(coalesce(p_reason,'')))<3 OR p.data->>'managerSubmittedAt' IS NOT NULL OR p.data->>'state' IN('locked','recorded','completed_offline','cancelled') THEN RAISE EXCEPTION 'PBP may change only an unsubmitted route with a reason';END IF;
 rules:=app.probation_signing_guardrails(p.id);
 -- 5758: does the proposed evaluation route carry a routed approver step (Direct Superior, routing, group, named people)?
 IF coalesce(p.data->>'documentKind','review')='review' THEN
  IF jsonb_typeof(p_route->'steps')='array' THEN
   routed:=EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role' NOT IN('lm','employee','hod','pbp') AND app.probation_form_approver_role(s->>'role'));
  END IF;
 END IF;
 IF NOT routed THEN
  -- The 0949 path, unchanged.
  IF coalesce(p.data->>'documentKind','review')='review' THEN PERFORM app.probation_validate_evaluation_route(p_route,(p.data->>'type')::integer);END IF;PERFORM app.document_signing_validate(jsonb_build_object('route',p_route,'actions','[]'::jsonb),rules);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role' NOT IN('lm','employee','hod','pbp') OR s->>'holderId' IS NOT NULL OR s->>'representedId' IS NOT NULL) THEN RAISE EXCEPTION 'Routes choose roles; use recorded delegation for named replacements';END IF;
 ELSE
  SELECT f.data->'approvals'->(p.data->>'type'),f.data->'duplicateRolePolicy' INTO form_rows,form_policy FROM probation_configuration f WHERE f.id=c.form_id AND f.tenant_id=c.tenant_id AND f.kind='form';
  IF jsonb_typeof(form_rows) IS DISTINCT FROM 'array' THEN form_rows:='[]'::jsonb;END IF;
  -- Each routed step keeps the id and routing of one of the case's form rows for this Part, so it is filled from that
  -- row (group, named people or routing) when the Line Manager submits. A PBP cannot invent a new routing here.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_route->'steps') s WHERE s->>'role' NOT IN('lm','employee','hod','pbp')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(form_rows) r WHERE r->>'id'=s->>'id' AND r->>'who'=s->>'role')) THEN
   RAISE EXCEPTION 'A routed approval step must keep a routing of this case''s form version';
  END IF;
  -- The label and "meant for" note are server-owned: the routing or group name, and the Part's current note for the step.
  SELECT jsonb_set(p_route,'{steps}',coalesce(jsonb_agg(CASE
    WHEN jsonb_typeof(a.s) IS DISTINCT FROM 'object' THEN a.s
    WHEN a.s->>'role' IN('lm','employee','hod','pbp') THEN a.s-ARRAY['label','meantFor']
    ELSE (a.s-ARRAY['label','meantFor'])||jsonb_strip_nulls(jsonb_build_object('label',app.probation_form_approver_label(a.s->>'role'),
     'meantFor',(SELECT o->>'meantFor' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.data->'route'->'steps')='array' THEN p.data->'route'->'steps' ELSE '[]'::jsonb END) o
      WHERE o->>'id'=a.s->>'id' AND o->>'role'=a.s->>'role' AND jsonb_typeof(o->'meantFor')='string' LIMIT 1)))
   END ORDER BY a.n),'[]'::jsonb)) INTO route
  FROM jsonb_array_elements(p_route->'steps') WITH ORDINALITY a(s,n);
  PERFORM app.probation_validate_form_route(route,(p.data->>'type')::integer);
  PERFORM app.document_signing_validate(jsonb_build_object('route',route,'actions','[]'::jsonb),rules);
  -- The duplicate-role policy: the one the Part's route was frozen with, else its form version's (as 5751 freezes it).
  IF jsonb_typeof(p.data->'routePolicy') IS DISTINCT FROM 'object' THEN
   IF jsonb_typeof(form_policy)='object' THEN policy_patch:=jsonb_build_object('routePolicy',form_policy);END IF;
  END IF;
 END IF;
 -- 5759: no step other than the employee's own may be held by the case's employee, as role holder or current replacement.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(route->'steps') s
  JOIN app_user u ON u.tenant_id=p.tenant_id AND (u.id::text=(app.probation_holders(c.employment_id)->>(CASE WHEN s->>'role'='superior' THEN 'lm' ELSE s->>'role' END))
   OR u.id IN(SELECT x.holder_id FROM probation_delegate x WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=s->>'id' AND x.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)))
  JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id AND e.id=c.employment_id
  WHERE s->>'role' IS DISTINCT FROM 'employee') THEN RAISE EXCEPTION 'The employee cannot review or approve their own probation';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 INSERT INTO probation_revision(tenant_id,part_id,rater,revision,data,actor_user_id,reason) VALUES(p.tenant_id,p.id,'meta',p.revision,p.data,app.current_user_id(),p_reason);
 UPDATE probation_part SET data=data||jsonb_build_object('route',route,'routeOverride',true,'routeReason',p_reason)||policy_patch,revision=revision+1,content_revision=content_revision+1 WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'route_changed',p_reason);
END $$;
--> statement-breakpoint
-- Cases: Change a case's route (record a replacement holder) (body from 5759_probation_employee_own_steps_only; only the marked authority changes).
CREATE OR REPLACE FUNCTION app.probation_delegate_add(p_part uuid,p_step text,p_holder uuid,p_kind text,p_from date,p_to date,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;h jsonb;represented uuid;step_role text;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR app.probation_case_permitted(c.employment_id,'cases.route')) OR length(btrim(coalesce(p_reason,'')))<3 OR p_kind NOT IN('delegation','holder_changed','missing_holder') OR p_from IS NULL OR p_to<p_from THEN RAISE EXCEPTION 'A current PBP/GBS must record the replacement and reason';END IF;
 -- 5759: the case's own employee is never the replacement or delegate for any step.
 IF EXISTS(SELECT 1 FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.id=p_holder AND u.tenant_id=p.tenant_id AND e.id=c.employment_id) THEN
  RAISE EXCEPTION 'The employee cannot review or approve their own probation';
 END IF;
 IF app.probation_signer_candidate(c.id,p_holder) IS NOT TRUE THEN RAISE EXCEPTION 'Choose an active existing signer within this case legitimate company or canonical role scope';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_holder AND tenant_id=p.tenant_id AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RAISE EXCEPTION 'Choose an active existing login';END IF;
 SELECT (app.probation_holders(c.employment_id)->>(s->>'role'))::uuid INTO represented FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step;
 IF NOT FOUND THEN RAISE EXCEPTION 'Signing step unavailable';END IF;IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step AND s->>'role'='employee') THEN RAISE EXCEPTION 'Employee acknowledgement belongs to the employee; use the reasoned refusal route when necessary';END IF;
 -- 5758: a routed approver step (Direct Superior, routing, group, named people; 5756).
 SELECT s->>'role' INTO step_role FROM jsonb_array_elements(p.data->'route'->'steps') s WHERE s->>'id'=p_step LIMIT 1;
 IF step_role NOT IN('lm','employee','hod','pbp','gbs') AND app.probation_form_approver_role(step_role) THEN
  IF p_kind='delegation' THEN
   IF step_role='superior' THEN
    -- A Direct Superior step is held by the case's Line Manager holder (5756), so it represents them as a Line Manager step does.
    represented:=(app.probation_holders(c.employment_id)->>'lm')::uuid;
   ELSE
    -- The step's current person on this Part: the latest current replacement, or whom a current delegation already covers.
    SELECT CASE WHEN x.kind='delegation' THEN x.represented_id ELSE x.holder_id END INTO represented FROM probation_delegate x
    WHERE x.tenant_id=p.tenant_id AND x.part_id=p.id AND x.step_id=p_step AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day)
     AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=x.holder_id AND u.tenant_id=x.tenant_id AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
    ORDER BY x.created_at DESC,x.id DESC LIMIT 1;
   END IF;
  END IF;
 END IF;
 IF p_kind='delegation' AND represented IS NULL THEN RAISE EXCEPTION 'Use the explicit missing-holder replacement path when there is no current holder';END IF;
 IF EXISTS(SELECT 1 FROM document_signing_document doc CROSS JOIN LATERAL jsonb_array_elements(doc.data->'route'->'steps') step
  WHERE doc.tenant_id=p.tenant_id AND doc.subject_type='probation' AND doc.subject_id=p.id AND step->>'id'=p_step AND app.document_signing_step_fulfilled(doc.data,step))
 THEN RAISE EXCEPTION 'Completed signatures retain their actual historical holder';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 INSERT INTO probation_delegate(tenant_id,part_id,step_id,holder_id,represented_id,kind,reason,created_by,valid_from,valid_to) VALUES(p.tenant_id,p.id,p_step,p_holder,CASE WHEN p_kind='delegation' THEN represented END,p_kind,p_reason,app.current_user_id(),p_from,p_to);
 PERFORM app.probation_audit(c.id,p.id,'signer_replaced',p_reason);
END $$;
