-- 6e9a126e RELEASE THREE — restore the COMPANY-SCOPED WRITE CHECK that dropping leave_policy removes.
--
-- ⚠️ THIS CLOSES A PRIVILEGE WIDENING RELEASE THREE ITSELF INTRODUCES. Without it, release three is a
-- security regression on a nine-company tenant. Found in verification, not in the plan.
--
-- ── WHAT WAS LOST ────────────────────────────────────────────────────────────────────────────────────
-- Migration 0134 (ADR-0066 Phase 0(d)) gave `leave_policy` a company-aware WITH CHECK, deliberately, and
-- said why: "a company-scoped admin may only write a policy for their own company; the group default
-- (company_id NULL) needs a group admin."
--
--     WITH CHECK (tenant_id = app.current_tenant_id()
--                 AND CASE WHEN company_id IS NULL THEN app.is_group_admin()
--                          ELSE app.is_admin_for(company_id) END)
--
-- 0405 drops that table. Its replacement, `entitlement_eligibility_rule` (0396), carries only:
--
--     WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin())
--
-- So after release three, ANY admin could write an entitlement rule targeting ANOTHER company, or every
-- company at once, and the database would not stop them. Nine companies on production makes that real
-- rather than theoretical.
--
-- ── WHY THE CHECK LOOKS DIFFERENT FROM 0134's ────────────────────────────────────────────────────────
-- `leave_policy` had a `company_id` COLUMN to scope on. The new layer keeps targeting inside `criteria`
-- JSONB (core/org-criteria.ts), so the same rule has to be expressed against the document:
--   • criteria names companies  ⇒ the writer must administer EVERY one of them
--   • criteria names none       ⇒ the rule reaches the whole group, which is 0134's `company_id IS NULL`
--                                 case, and needs a group admin
-- Same policy, read out of a different place. `jsonb_array_length(...)` via coalesce rather than the `?`
-- operator: `?` is a parameter placeholder to several drivers and has bitten this repo's tooling before.
--
-- READ STAYS TENANT-WIDE, exactly as 0134 chose: the accrual kernel resolves entitlement under sessions
-- that are not necessarily admin, and a `FOR ALL USING (is_admin_for)` would silently zero-out those reads
-- rather than refuse them — a wrong figure instead of an error, which is the worse failure.
--
-- `entitlement_template` deliberately gets NO company clause: a template holds service bands and belongs
-- to a leave type. It carries no targeting at all — that is this table's job — so there is nothing to
-- scope, and inventing a clause would imply a boundary the data does not have.
--
-- No GRANT: nothing is created.

DROP POLICY IF EXISTS entitlement_eligibility_rule_rls ON "entitlement_eligibility_rule";--> statement-breakpoint

CREATE POLICY entitlement_eligibility_rule_rls ON "entitlement_eligibility_rule" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND app.is_admin()
    AND CASE
          WHEN coalesce(jsonb_array_length(criteria -> 'companyIds'), 0) > 0
            THEN NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(criteria -> 'companyIds') AS c(company_id)
              WHERE NOT app.is_admin_for(c.company_id::uuid)
            )
          ELSE app.is_group_admin()
        END
  );--> statement-breakpoint

COMMENT ON TABLE "entitlement_eligibility_rule" IS
  'Who gets which entitlement template. WRITE is company-scoped through criteria->companyIds: a rule naming companies requires admin rights over every one of them, and a rule naming none reaches the whole group and requires a group admin. This restores the check migration 0134 put on leave_policy, which release three drops. READ is tenant-wide on purpose — the accrual kernel resolves entitlement under non-admin sessions.';
