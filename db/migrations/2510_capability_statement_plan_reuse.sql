-- Reuse the static query plan, never a permission result. Every call still
-- evaluates the same identity, current membership, override and company scope
-- against its PostgreSQL statement snapshot. Preserve owner, ACL and attributes.
DO $guard$
DECLARE previous pg_catalog.pg_proc%ROWTYPE;
BEGIN
 SELECT * INTO STRICT previous FROM pg_catalog.pg_proc WHERE oid='app.access_allowed_for_tenant(uuid,uuid,text,uuid)'::regprocedure;
 IF pg_catalog.md5(previous.prosrc) IS DISTINCT FROM '0951a1f8bb1de59245b751ca31729953'
    OR previous.prolang <> (SELECT oid FROM pg_catalog.pg_language WHERE lanname='sql')
    OR NOT previous.prosecdef OR previous.provolatile <> 's'
    OR previous.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
 THEN
  RAISE EXCEPTION 'Unexpected app.access_allowed_for_tenant(uuid,uuid,text,uuid) predecessor' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_allowed_for_tenant(p_tenant uuid,p_user uuid,p_capability text,p_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $capability$
BEGIN
 RETURN (
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
 )
 );
END;
$capability$;
