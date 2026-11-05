-- Tenant-isolation defence in depth, ADR-0174 follow-up part 2 of 4. app.is_company_descendant is SECURITY
-- DEFINER and walks public.company past RLS without a tenant filter, so any caller could ask whether one id
-- descends from another in a different tenant. Its EXECUTE cannot simply be narrowed: the
-- performance_kpi_library read policy (evaluated as ai_hr_app), the company cycle trigger and other invoker
-- callers depend on it, as do some fifty definers.
--
-- The walk now starts only from a company of the session tenant and every hop stays in the child's tenant.
-- With no session tenant (owner provisioning and seeding, where the company cycle trigger still has to see a
-- cycle) it stays inside the child's own tenant, which is still narrower than before. 2152/2153 make a
-- cross-tenant parent impossible in data as well. Signature, owner, volatility, SECURITY DEFINER, path and
-- ACL are unchanged; CREATE OR REPLACE keeps the OID and the dependent policy.
CREATE OR REPLACE FUNCTION app.is_company_descendant(child uuid, ancestor uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH RECURSIVE up AS (
    SELECT c.id, c.parent_company_id, c.tenant_id FROM public.company c
    WHERE c.id = child AND c.tenant_id = coalesce(app.current_tenant_id(), c.tenant_id)
    UNION ALL
    SELECT c.id, c.parent_company_id, c.tenant_id FROM public.company c
    JOIN up ON c.id = up.parent_company_id AND c.tenant_id = up.tenant_id
  )
  SELECT EXISTS (SELECT 1 FROM up WHERE id = ancestor);
$$;
