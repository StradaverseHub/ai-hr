-- Fix (ADR-0009, Slice B): the employment table's own SELECT policy must check the admin case
-- via the row's OWN company_id column. can_see_employment() self-queries the employment table to
-- find the company, but a STABLE function can't see a row being inserted in the same statement
-- (INSERT ... RETURNING), so an admin's hire failed the RETURNING read. Checking is_admin_for on
-- the row's company_id short-circuits before the self-query and restores hires.

DROP POLICY employment_rls ON employment;
--> statement-breakpoint
CREATE POLICY employment_rls ON employment FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.is_admin_for(company_id) OR app.can_see_employment(id))
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
