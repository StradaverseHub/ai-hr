-- b1b1879d — a Draft employee belongs to its company, at the database as well as on the screen.
--
-- THE GAP. 0337's employee_draft_rls admitted `app.is_admin() OR app.is_self_person(created_by_person_id)`
-- in both USING and WITH CHECK. `app.is_admin()` (0016) is "an admin grant on ANY company", so an hr_admin
-- scoped to company A could select, update and delete company B's drafts — the candidate's IC number, bank
-- account and salary included. Production has no company-scoped admin grant today (0 of 5 hr_admin /
-- super_admin assignments), so nobody is exposed yet; it opens the moment one is created.
--
-- THE RULE, per draft:
--   * a draft WITH a company:    the administrators of that company (`app.is_admin_for`, subtree semantics);
--   * a draft with NO company:   the administrators of every company (`app.is_group_admin`), because it
--                                belongs to no one company — the plan's "administrators who look after all
--                                companies";
--   * its author, always, to READ and DISCARD it (USING) — the person who typed it in keeps sight of it.
--
-- WITH CHECK IS NARROWER THAN USING, deliberately. The author branch is not in it for a draft that carries a
-- company: otherwise an administrator of A could write a draft INTO company B (create it there, or move their
-- own draft there) just by being its author, and so "work on drafts for that company" without administering
-- it. Where the draft lands is decided by who administers the company it lands in. A draft without a company
-- may still be written by its author.
--
-- NO TABLE IS CREATED, so no GRANT: 0337 already grants SELECT, INSERT, UPDATE, DELETE to ai_hr_app.
-- ROLLBACK: re-run 0337's DROP POLICY / CREATE POLICY pair.
DROP POLICY IF EXISTS employee_draft_rls ON employee_draft;--> statement-breakpoint
CREATE POLICY employee_draft_rls ON employee_draft FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_self_person(created_by_person_id)
      OR (company_id IS NULL AND app.is_group_admin())
      OR (company_id IS NOT NULL AND app.is_admin_for(company_id))
    )
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      (company_id IS NULL AND (app.is_self_person(created_by_person_id) OR app.is_group_admin()))
      OR (company_id IS NOT NULL AND app.is_admin_for(company_id))
    )
  );
