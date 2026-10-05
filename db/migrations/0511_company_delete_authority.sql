-- f00bd1eb — who may delete a company, decided by the database and not only by the service.
--
-- 1) THE GAP. The live policy on `company` is one PERMISSIVE FOR ALL `tenant_isolation` (0016) whose USING
--    is the tenant alone; its WITH CHECK (`is_admin_for(coalesce(parent_company_id, id))`) applies to INSERT
--    and UPDATE only, never to DELETE. So a DELETE was gated by the tenant and nothing else: any session of
--    the tenant — a member, or company A's administrator aiming at company B — passed RLS, and the only thing
--    that stopped harm was a foreign key happening to refuse. deleteCompanyAction also read the session with
--    getSession rather than requireAdmin, and deleteCompany checked no role at all.
--
--    A RESTRICTIVE policy is ANDed with the permissive one, so a hard DELETE now needs the same authority
--    the row's WITH CHECK already demands for writing it: administering the company's parent, or the
--    company itself when it is a group root. Precedent: 0277's compensation_delete_admin. The service
--    checks the same thing first so it can say so in words (core/admin.ts deleteCompany); this is the lock
--    that holds when the service check is bypassed.
CREATE POLICY company_delete_admin ON company AS RESTRICTIVE FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND app.is_admin_for(coalesce(parent_company_id, id)));
--> statement-breakpoint

-- 2) A COMPANY THAT WAS NEVER USED STILL HAS NIGHTLY USAGE RECORDS, and the app role cannot remove them.
--    scripts/capture-usage.ts writes one `usage_snapshot` row per company per day on the OWNER connection;
--    0313 grants ai_hr_app SELECT only, with a FOR SELECT policy only, and test/module-entitlement-rls.test.ts
--    pins that: the metering record is "readable, never writable by a customer". ABC Comapny on production
--    carries five such rows, all zero, and they alone would make it undeletable from the app (foreign key
--    usage_snapshot_company_same_tenant_fk). The approved plan decides: zero-usage rows go with the company
--    and their count is recorded on `company.deleted`.
--
--    So the table privilege is NOT widened. One SECURITY DEFINER function removes exactly the rows that record
--    nothing — no employments, no users, no payslips — and only for a caller with the authority to delete the
--    company itself (the same expression as policy 1). A row with any usage in it is never touched here; the
--    company delete refuses before calling this (core/company-refs.ts). Returns how many rows it removed.
--
--    search_path = pg_catalog, public, pg_temp and every relation schema-qualified: 0312's rule for SECURITY
--    DEFINER (with `public` alone Postgres still searches pg_temp first). The tenant is checked explicitly,
--    because a definer function is not bound by RLS.
CREATE FUNCTION app.delete_unused_usage_snapshots(p_company uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.company c
     WHERE c.id = p_company
       AND c.tenant_id = app.current_tenant_id()
       AND app.is_admin_for(coalesce(c.parent_company_id, c.id))
  ) THEN
    RAISE EXCEPTION 'not permitted to remove usage records for this company' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.usage_snapshot u
   WHERE u.company_id = p_company
     AND u.tenant_id = app.current_tenant_id()
     AND u.active_employments = 0
     AND u.active_users = 0
     AND u.payslips_generated = 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delete_unused_usage_snapshots(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.delete_unused_usage_snapshots(uuid) TO ai_hr_app;
