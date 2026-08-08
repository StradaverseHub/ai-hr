-- 1fff489c PHASE 2 — Locations gain a Branch, so the employee's Attendance tab can propose a work
-- location from the Branch already recorded on their Employment tab.
--
-- WHAT A BRANCH IS HERE. Branch is NOT a table. It is profile_option category 'branch' — a tenant-wide
-- flat catalogue (core/profile-options.ts) whose values are stored on employment.org_branch as text and
-- validated on save with legacy-value tolerance. This column stores the SAME text so the resolver is a
-- plain equality join, and core/location.ts validates it through the very same
-- assertProfileValueAllowed() setEmploymentInfo uses — one catalogue, one tolerance rule, no second
-- vocabulary to keep in step.
--
-- WHY THE UNIQUE INDEX IS PER COMPANY AND NOT PER TENANT. profile_option is tenant-wide but `location` is
-- company-scoped, so two companies may legitimately both map BUKIT JALIL to their OWN location — that is
-- the normal case in this tenant, not an edge case (production 2026-08-07: 9 companies, 8 locations, a
-- branch catalogue of 2 values shared across them). A tenant-wide unique index would make the second
-- company's mapping impossible. Partial on archived_at IS NULL for the same reason location_code_uq is:
-- archiving a location must free its branch for a replacement.
--
-- No backfill: every existing location keeps branch NULL, which reads as "not mapped yet" and is exactly
-- what the four new empty-state messages are for.

ALTER TABLE "location" ADD COLUMN IF NOT EXISTS "branch" text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "location_branch_uq"
  ON "location" ("tenant_id", "company_id", "branch")
  WHERE "archived_at" IS NULL AND "branch" IS NOT NULL;--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
-- Re-asserted for the same reason as 0419: table-level grants already cover a new column, but a restored
-- developer cluster is where an omission would surface rather than production.
GRANT SELECT, INSERT, UPDATE, DELETE ON "location" TO ai_hr_app;
