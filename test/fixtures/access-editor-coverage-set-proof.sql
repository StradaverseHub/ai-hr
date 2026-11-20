-- Unnumbered hosted proof for the Access editor’s current company ancestry projection.
DO $guard$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
  WHERE p.oid=pg_catalog.to_regprocedure('app.access_configuration_state()')
   AND r.rolname=current_user AND NOT r.rolsuper AND NOT r.rolbypassrls
   AND p.prosecdef AND p.provolatile='s' AND p.prorettype='jsonb'::regtype
   AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
   AND pg_catalog.md5(p.prosrc)='0d6ca27b939a580a33090d52cf4d7c56'
   AND pg_catalog.has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
   AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
   )
 ) THEN
  RAISE EXCEPTION 'Unexpected Access configuration state predecessor or owner';
 END IF;
END
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_configuration_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); result jsonb;
BEGIN
 IF NOT app.access_allowed_for(app.current_user_id(),'access.configure',NULL) THEN
  RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501';
 END IF;
 WITH RECURSIVE parents AS MATERIALIZED (
  SELECT c.id,app.company_org_current_parent(c.id) AS parent_id FROM public.company c WHERE c.tenant_id=t
 ), ancestors(company,ancestor,visited) AS (
  SELECT child.id,parent.id,ARRAY[child.id,parent.id] FROM parents child JOIN parents parent ON parent.id=child.parent_id
  WHERE parent.id<>child.id
  UNION ALL
  SELECT a.company,parent.id,a.visited||parent.id
  FROM ancestors a JOIN parents current_company ON current_company.id=a.ancestor
  JOIN parents parent ON parent.id=current_company.parent_id
  WHERE NOT(parent.id=ANY(a.visited))
 )
 SELECT jsonb_build_object(
  'snapshot',jsonb_build_object('tenantId',t,'revision',s.revision,
   'users',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'active',u.archived_at IS NULL AND NOT app.login_blocked(u.id)) ORDER BY u.id) FROM public.app_user u WHERE u.tenant_id=t),'[]'::jsonb),
   'groups',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'retired',g.retired_at IS NOT NULL,'systemAdministrator',g.system_administrator,
    'grants',COALESCE((SELECT jsonb_agg(jsonb_build_object('capabilityId',a.capability_id,'companyId',a.company_id) ORDER BY a.capability_id,a.company_id NULLS FIRST) FROM public.access_group_grant a WHERE a.tenant_id=t AND a.group_id=g.id AND a.retired_at IS NULL),'[]'::jsonb)) ORDER BY g.id) FROM public.access_group g WHERE g.tenant_id=t),'[]'::jsonb),
   'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',m.user_id,'groupId',m.group_id,'companyId',m.company_id,'derived',m.derived) ORDER BY m.user_id,m.group_id,m.company_id NULLS FIRST,m.derived) FROM public.access_effective_membership m WHERE m.tenant_id=t),'[]'::jsonb),
   'overrides',COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',o.user_id,'capabilityId',o.capability_id,'companyId',o.company_id,'effect',o.effect) ORDER BY o.user_id,o.capability_id,o.company_id NULLS FIRST) FROM public.access_user_override o WHERE o.tenant_id=t AND o.retired_at IS NULL),'[]'::jsonb)),
  'catalog',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'scope',c.scope,'supported',c.supported,'bindings',c.bindings) ORDER BY c.id) FROM public.access_capability c),'[]'::jsonb),
  'companyIds',COALESCE((SELECT jsonb_agg(c.id ORDER BY c.id) FROM public.company c WHERE c.tenant_id=t),'[]'::jsonb),
  'coverage',COALESCE((SELECT jsonb_agg(jsonb_build_object('ancestor',a.ancestor,'company',a.company) ORDER BY a.ancestor,a.company) FROM ancestors a),'[]'::jsonb),
  'recoveryUserIds',COALESCE((SELECT jsonb_agg(u.id ORDER BY u.id) FROM public.app_user u WHERE u.tenant_id=t AND app.access_recovery_available(u.id)),'[]'::jsonb),
  'scopeFingerprint',app.access_scope_fingerprint()
 ) INTO result FROM public.access_configuration s WHERE s.tenant_id=t AND s.initialized;
 IF result IS NULL THEN RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501'; END IF;
 RETURN result;
END;
$$;
