-- Shared current-principal proof. Security owns this foundation; feature migrations consume it.
CREATE FUNCTION app.principal_snapshot_current() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(
  SELECT 1 FROM app.principal(app.current_user_id()) p
  JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=p.tenant_id
  WHERE p.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND NOT EXISTS(SELECT 1 FROM unnest(app.current_roles()) claimed(role)
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.grants) actual
     WHERE actual->>'role'=claimed.role))
   AND NOT EXISTS(SELECT 1 FROM app.current_grants() claimed
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.grants) actual
     WHERE actual->>'role'=claimed.role AND
      (nullif(actual->>'companyId','') IS NULL
       OR nullif(actual->>'companyId','')::uuid=claimed.company_id
       OR (claimed.company_id IS NOT NULL AND app.is_company_descendant(claimed.company_id,nullif(actual->>'companyId','')::uuid)))))
 );
$$;
REVOKE ALL ON FUNCTION app.principal_snapshot_current() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.principal_snapshot_current() TO ai_hr_app;
