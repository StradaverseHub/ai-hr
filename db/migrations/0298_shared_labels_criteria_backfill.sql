-- Personnel (Admin) — fix Criteria-based Organisation Label filtering showing EMPTY dropdowns
-- (feedback d61f0ff2, follow-up to 570e3311 / ADR-0073).
--
-- ROOT CAUSE: label_company_assignment (Criteria) rows are written unconditionally by
-- assignLabelToCompanies, but the resolver (core/system-labels.ts labelIdsForCompany /
-- visibleLabelIdsCondition) skips the junction AND global branches unless the target company's
-- shared_system_labels flag is ON — and it defaults OFF (0157, the phased-rollout safety switch).
-- So every label distributed to a company through Criteria stayed hidden on the hire form, leaving
-- Department / Position / Business Unit / Cost Centre dropdowns empty despite correct configuration.
--
-- ONE-TIME CORRECTION (idempotent, additive, no schema change): enable sharing for every company that
-- already has junction rows pointing at it, so existing Criteria configuration takes effect immediately.
-- NOTE: 0157 backfilled a SELF-assignment junction row per pre-existing label, so this statement also
-- enables the flag for companies that merely owned labels at 0157-time — harmless: with no shared-in
-- and no global labels the flag-ON resolver output is exactly origin-only (byte-identical). The flag
-- itself is KEPT as an explicit per-company opt-out (System Labels → Sharing settings); the service
-- layer now auto-enables it on future Criteria assignments (assignLabelToCompanies / setLabelGlobal),
-- so configuration can never again be silently swallowed.
UPDATE "company" SET "shared_system_labels" = true
WHERE "shared_system_labels" = false
  AND "id" IN (SELECT DISTINCT "company_id" FROM "label_company_assignment");--> statement-breakpoint
-- Global ("All Companies") labels are equally gated by the flag (labelIdsForCompany's early return):
-- enable it for ALL companies of any tenant that has at least one is_global label, so a configured
-- global label surfaces everywhere it was promised to.
UPDATE "company" SET "shared_system_labels" = true
WHERE "shared_system_labels" = false
  AND "tenant_id" IN (
    SELECT "tenant_id" FROM "department" WHERE "is_global" = true
    UNION SELECT "tenant_id" FROM "position" WHERE "is_global" = true
    UNION SELECT "tenant_id" FROM "cost_center" WHERE "is_global" = true
    UNION SELECT "tenant_id" FROM "business_unit" WHERE "is_global" = true
  );
