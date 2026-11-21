-- Unnumbered replacement for the hosted installed-owner rehearsal.
DO $predecessor$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles owner_role ON owner_role.oid=p.proowner
  WHERE p.oid=pg_catalog.to_regprocedure('app.offboarding_posting_queue_access()')
    AND owner_role.rolname=current_user
    AND NOT owner_role.rolsuper
    AND NOT owner_role.rolbypassrls
    AND p.prorettype='boolean'::regtype
    AND p.prosecdef
    AND p.provolatile='s'
    AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
    AND pg_catalog.md5(p.prosrc)='0b244f4aa1621807d85b8bc27d5dc41e'
    AND pg_catalog.has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
    AND NOT EXISTS (
     SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
     WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
    )
 ) THEN
  RAISE EXCEPTION 'Unexpected Offboarding queue access predecessor or owner';
 END IF;
END
$predecessor$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.offboarding_posting_queue_access() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 actor_tenant uuid := app.current_tenant_id();
 actor_id uuid := app.current_user_id();
BEGIN
 IF app.principal_snapshot_current() IS NOT TRUE THEN RETURN false; END IF;

 -- Membership in at least one of these groups is required by every native path.
 IF NOT EXISTS (
  WITH relevant_groups AS MATERIALIZED (
   SELECT p.approver_group_id AS id FROM public.personnel_posting p
   WHERE p.tenant_id=actor_tenant AND p.source='offboarding'
   UNION
   SELECT cfg.data->>'peopleOpsGroup' FROM public.lc_v9_config cfg
   WHERE cfg.tenant_id=actor_tenant
   UNION
   SELECT CASE WHEN cfg.data->'offboarding' ? 'postingApproverGroupId'
    THEN cfg.data->'offboarding'->>'postingApproverGroupId' ELSE cfg.data->>'peopleOpsGroup' END
   FROM public.lc_v9_config cfg WHERE cfg.tenant_id=actor_tenant
  )
  SELECT 1 FROM relevant_groups g
  WHERE actor_id=ANY(app.offboarding_posting_group_members(g.id))
 ) THEN RETURN false; END IF;

 -- The existing company and posting owners still decide every eligible case.
 RETURN EXISTS (
  SELECT 1 FROM public.personnel_posting p WHERE p.tenant_id=actor_tenant AND p.source='offboarding'
    AND app.personnel_posting_visible(p.approver_group_id,p.employment_id,p.source)
 ) OR EXISTS (
  SELECT 1 FROM public.company c JOIN public.lc_v9_config cfg ON cfg.tenant_id=c.tenant_id
  WHERE c.tenant_id=actor_tenant AND (
   app.offboarding_posting_ops(c.id) OR app.offboarding_posting_group(c.id,
    CASE WHEN cfg.data->'offboarding' ? 'postingApproverGroupId'
     THEN cfg.data->'offboarding'->>'postingApproverGroupId' ELSE cfg.data->>'peopleOpsGroup' END)
  )
 );
END $$;
