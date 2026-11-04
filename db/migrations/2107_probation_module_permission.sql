-- Owner-approved initial holders: active named administrators and System Administrators.
-- Scope is tenant-wide configuration. Inbox participation never implies this capability.
INSERT INTO public.access_capability(id,scope,supported,bindings) VALUES
 ('probation.module','tenant',true,'[{"owner":"app.probation_config_admin","operation":"configure-all-entitled-companies"},{"owner":"app.probation_request_activation","operation":"activate-reviewed-cutover"},{"owner":"app.probation_navigation_access","operation":"page"}]');
--> statement-breakpoint
DO $$
DECLARE t uuid;
BEGIN
 FOR t IN SELECT tenant_id FROM public.access_configuration UNION SELECT tenant_id FROM public.probation_access ORDER BY tenant_id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
  INSERT INTO public.access_group_grant(tenant_id,group_id,capability_id)
   SELECT t,g.id,'probation.module' FROM public.access_group g WHERE g.tenant_id=t AND g.system_administrator AND g.retired_at IS NULL;
  INSERT INTO public.access_user_override(tenant_id,user_id,capability_id,effect)
   SELECT DISTINCT t,a.user_id,'probation.module','allow' FROM public.probation_access a
   JOIN public.app_user u ON u.id=a.user_id AND u.tenant_id=a.tenant_id
   WHERE a.tenant_id=t AND a.role='admin' AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
    AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
    AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
  UPDATE public.access_configuration SET revision=gen_random_uuid(),updated_at=now() WHERE tenant_id=t;
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
   VALUES(t,'access-configuration',t,'probation.module-permission.registered','system',NULL,
    jsonb_build_object('capabilityId','probation.module','scope','tenant','initialHolders','current-named-admins-and-system-administrators','legacyAssignmentsRetained',true));
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_config_admin(p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_active_user() AND app.access_capability_allowed('probation.module',NULL)
  AND app.probation_company_entitled(p_company)
  AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_navigation_access() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE configuration boolean;participant boolean;intake boolean;
BEGIN
 IF app.probation_active_user() IS NOT TRUE THEN RETURN jsonb_build_object('page',false,'configure',false,'intake',false);END IF;
 SELECT EXISTS(SELECT 1 FROM company c WHERE c.tenant_id=app.current_tenant_id() AND app.probation_config_admin(c.id)) INTO configuration;
 SELECT EXISTS(SELECT 1 FROM probation_case c WHERE c.tenant_id=app.current_tenant_id() AND app.probation_case_access(c.id)) INTO participant;
 SELECT EXISTS(SELECT 1 FROM company co WHERE co.tenant_id=app.current_tenant_id() AND co.archived_at IS NULL AND app.probation_company_entitled(co.id) AND (app.probation_config_admin(co.id) OR CASE WHEN EXISTS(SELECT 1 FROM probation_access opted WHERE opted.tenant_id=co.tenant_id AND opted.user_id=app.current_user_id() AND opted.role IN('pbp','gbs') AND app.is_company_descendant(co.id,opted.company_id) AND opted.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (opted.valid_to IS NULL OR opted.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN EXISTS(SELECT 1 FROM employment employee WHERE employee.tenant_id=co.tenant_id AND employee.company_id=co.id AND (app.probation_role(employee.id,'pbp') OR app.probation_role(employee.id,'gbs'))) ELSE false END)) INTO intake;
 RETURN jsonb_build_object('page',configuration OR participant,'configure',configuration,'intake',intake);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_bootstrap_admin(p_company uuid,p_user uuid,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Manage Probation module permission in Access Settings. Preparer nomination is retired.'; END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_assign_access(p_company uuid,p_user uuid,p_role text,p_from date,p_to date,p_business_unit uuid,p_department uuid,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_config_admin(p_company) OR p_role NOT IN('pbp','gbs') OR p_from IS NULL OR p_to<p_from OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Probation access assignment denied';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=p_user AND tenant_id=app.current_tenant_id() AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RAISE EXCEPTION 'Choose one active existing login';END IF;
 IF p_role='gbs' AND app.lifecycle_canonical_people_ops_member(p_company,p_user) IS NOT TRUE OR p_role='pbp' AND app.lifecycle_canonical_pbp_scope(p_company,p_business_unit,p_user) IS NOT TRUE THEN RAISE EXCEPTION 'Module opt-in may only constrain the existing canonical PBP or People Ops role';END IF;
 IF p_business_unit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business_unit WHERE id=p_business_unit AND tenant_id=app.current_tenant_id()) OR p_department IS NOT NULL AND NOT EXISTS(SELECT 1 FROM department WHERE id=p_department AND tenant_id=app.current_tenant_id()) THEN RAISE EXCEPTION 'Invalid probation assignment scope';END IF;
 INSERT INTO probation_access(tenant_id,user_id,company_id,role,valid_from,valid_to,business_unit_id,department_id,reason) VALUES(app.current_tenant_id(),p_user,p_company,p_role,p_from,p_to,p_business_unit,p_department,p_reason) RETURNING probation_access.id INTO v_id;RETURN v_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_activate_cutover(p_id uuid,p_day date) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_cutover;
BEGIN
 PERFORM app.probation_write_lock();
 IF NOT app.probation_storage_runner() OR p_day IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Explicit owner current-day activation required';END IF;
 SELECT * INTO c FROM probation_cutover WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.probation_company_entitled(c.company_id) IS NOT TRUE OR c.data->>'planComplete' IS DISTINCT FROM 'true' OR c.approved_by IS NULL OR c.applied_at IS NOT NULL OR c.created_at<now()-interval '1 day' OR coalesce(c.data->'sourceSnapshot',c.data) IS DISTINCT FROM app.probation_cutover_snapshot(c.company_id) OR NOT app.access_allowed_for_tenant(c.tenant_id,c.approved_by,'probation.module',NULL) THEN RAISE EXCEPTION 'A fresh approved cutover and current Probation module permission are required';END IF;
 INSERT INTO probation_activation(tenant_id,company_id,enabled,activation_on,dry_run_digest,approved_by) VALUES(c.tenant_id,c.company_id,true,p_day,c.digest,c.approved_by) ON CONFLICT(tenant_id,company_id) DO UPDATE SET enabled=true,activation_on=p_day,dry_run_digest=c.digest,approved_by=c.approved_by,updated_at=now();
 UPDATE probation_cutover SET applied_at=now() WHERE id=c.id;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  VALUES(c.tenant_id,'probation',c.company_id,'probation.runtime.activated','system',NULL,jsonb_build_object('cutoverId',c.id,'digest',c.digest,'activationOn',p_day));
END $$;
--> statement-breakpoint

-- The module user requests activation; the existing installation owner executes the
-- complete exact-plan/PDF/install-receipt adjudication. No browser action bypasses it.
CREATE TABLE public.probation_activation_request(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 cutover_id uuid NOT NULL REFERENCES probation_cutover(id),company_id uuid NOT NULL REFERENCES company(id),
 requested_by uuid NOT NULL REFERENCES app_user(id),digest text NOT NULL,installation_reference text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','completed','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,failure text,
 UNIQUE(tenant_id,cutover_id)
);
ALTER TABLE public.probation_activation_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.probation_activation_request FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_activation_request_owner ON public.probation_activation_request FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY probation_activation_request_read ON public.probation_activation_request FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.probation_config_admin(company_id));
REVOKE ALL ON public.probation_activation_request FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.probation_activation_request TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_request_activation(p_id uuid,p_digest text,p_reference text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_cutover;v_id uuid;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_cutover WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.probation_config_admin(c.company_id) IS NOT TRUE OR c.digest IS DISTINCT FROM p_digest
  OR c.approved_by IS NULL OR NOT app.access_allowed_for_tenant(c.tenant_id,c.approved_by,'probation.module',NULL)
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
REVOKE ALL ON FUNCTION app.probation_request_activation(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_request_activation(uuid,text,text) TO ai_hr_app;
