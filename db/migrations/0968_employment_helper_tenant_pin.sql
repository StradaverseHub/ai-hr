-- Tenant-isolation defence in depth, part 1 of 3 (ADR-0174). Not an exploitable gap today: every policy that
-- calls these helpers also carries a tenant conjunct or sits under a restrictive tenant policy (read-only
-- replay of all journal policies, 3 November 2026). These changes make each helper safe on its own.
--
-- 1. The employment helpers answer from GRANTS: `app.is_admin_for` never reads the company row, so a
--    group-wide grant says yes for any company id, including another tenant's. As SECURITY DEFINER they
--    also read `employment` past RLS. Each now pins the employment to the session tenant, exactly as
--    `app.can_see_employment` has done since 0016. `app.is_admin_for` itself is NOT given a company lookup:
--    a root-company INSERT is checked before that company row exists.
-- 2. `SET search_path = public` lets an ai_hr_app session shadow `employment` with a TEMP table, because
--    pg_temp is searched first unless named. The path is now `pg_catalog, public, pg_temp` and the relation
--    is schema-qualified (the 0312 rule), closing the follow-up 0312 left open for these helpers.
-- 3. `app.company_subtree` is SECURITY DEFINER, unfiltered and has no caller in source or policy, so it
--    worked as an id oracle across tenants. It is pinned to the session tenant and EXECUTE is revoked
--    from PUBLIC and ai_hr_app. The owner keeps EXECUTE; a future caller must be granted it deliberately.
--
-- Signatures, owners, volatility and SECURITY DEFINER are unchanged; CREATE OR REPLACE keeps each
-- function's OID, ACL and the policies that depend on it. No table grant changes.
CREATE OR REPLACE FUNCTION app.can_admin_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employment e
    WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND app.is_admin_for(e.company_id)
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_admin_payroll_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employment e
    WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND app.can_admin_payroll_for(e.company_id)
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_admin_perfcomp_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employment e
    WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND app.can_admin_perfcomp_for(e.company_id)
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.company_subtree(root uuid)
  RETURNS TABLE (id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH RECURSIVE down AS (
    SELECT c.id FROM public.company c WHERE c.id = root AND c.tenant_id = app.current_tenant_id()
    UNION ALL
    SELECT c.id FROM public.company c JOIN down ON c.parent_company_id = down.id
    WHERE c.tenant_id = app.current_tenant_id()
  )
  SELECT down.id FROM down;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.company_subtree(uuid) FROM PUBLIC, ai_hr_app;
