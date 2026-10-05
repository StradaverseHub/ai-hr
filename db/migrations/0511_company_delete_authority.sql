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

-- 2) A COMPANY THAT WAS NEVER USED STILL HAS NIGHTLY USAGE RECORDS, and the app role could not remove them.
--    scripts/capture-usage.ts writes one `usage_snapshot` row per company per day on the OWNER connection;
--    0313 granted ai_hr_app SELECT only, with a FOR SELECT policy only. ABC Comapny on production carries
--    five such rows, all zero, and they alone would make it undeletable from the app (foreign key
--    usage_snapshot_company_same_tenant_fk). The approved plan decides: zero-usage rows go with the company
--    and their count is recorded on `company.deleted`.
--
--    So DELETE is granted, and admitted ONLY for a row that records nothing — no employments, no users, no
--    payslips — by the same authority that may delete the company. A row with any usage in it stays
--    undeletable here whoever asks; core/company-refs.ts refuses the company delete before reaching it.
--    No table is created, so this is the only GRANT needed.
GRANT DELETE ON usage_snapshot TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY usage_snapshot_delete_unused ON usage_snapshot FOR DELETE
  USING (
    tenant_id = app.current_tenant_id()
    AND active_employments = 0
    AND active_users = 0
    AND payslips_generated = 0
    AND EXISTS (
      SELECT 1 FROM company c
      WHERE c.id = usage_snapshot.company_id
        AND c.tenant_id = app.current_tenant_id()
        AND app.is_admin_for(coalesce(c.parent_company_id, c.id))
    )
  );
