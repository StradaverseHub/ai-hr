-- Custom SQL migration file, put your code below! --
-- Sub-delegation: a company-scoped hr_admin may grant/revoke roles WITHIN their own subtree.
-- Split reads from writes: reads stay tenant-scoped (so the Users page still works); writes are
-- gated. The delegated branch (role <> super_admin AND company_id NOT NULL AND is_admin_for) blocks
-- every escalation: no minting super_admins, no group-wide grants, nothing outside the subtree.
-- Since assignRole normalises all non-hr_admin roles to a null company_id, the only grant a
-- delegated admin can actually make is a subtree-scoped hr_admin (appoint a deputy).
DROP POLICY tenant_isolation ON role_assignment;
--> statement-breakpoint
CREATE POLICY role_assignment_read ON role_assignment FOR SELECT
  USING (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY role_assignment_write ON role_assignment FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_group_admin()
      OR (role <> 'super_admin' AND company_id IS NOT NULL AND app.is_admin_for(company_id))
    )
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_group_admin()
      OR (role <> 'super_admin' AND company_id IS NOT NULL AND app.is_admin_for(company_id))
    )
  );