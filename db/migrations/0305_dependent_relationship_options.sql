-- ea36b7fa — Personnel Family & Dependents consolidation: the Family tab's Relationship dropdown becomes
-- centrally maintainable under System Settings > System Labels > Profile Options via a NEW profile_option
-- category 'dependentRelationship'. DELIBERATELY DISTINCT from the existing 'relationship' category (which
-- governs person.emergency_contact_relationship) — this one governs employee_dependent.relationship.
--
-- Seed the five built-in relationship values for EVERY existing tenant — a TOP-UP in the
-- 0300_person_salutation.sql style, kept BYTE-IDENTICAL with CATEGORY_DEFAULTS.dependentRelationship in
-- core/profile-options.ts (values = the lowercase DEPENDENT_RELATIONSHIPS enum, the contract with stored
-- employee_dependent.relationship data; the Family tab renders built-ins via static i18n labels, so the
-- lowercase label only shows in the System Labels grid, where it is editable). IDEMPOTENT +
-- NON-DESTRUCTIVE via ON CONFLICT DO NOTHING: it never deletes, renames, or reactivates rows an admin
-- curated. New tenants are seeded by core/profile-options.ts::seedProfileOptions at provisioning.
-- Data-only: NO schema change and NO RLS change (profile_option already has tenant-read + admin-write
-- policies from 0180). Server-side, the five built-ins stay ALWAYS valid regardless of this catalog —
-- deactivating one only hides it from NEW picks; custom values added here behave like 'other' for the
-- spouse-field / child-tax-relief gating in core/dependents.ts.
INSERT INTO "profile_option" ("tenant_id", "category", "value", "label", "sort_order")
SELECT t.id, d.category, d.value, d.value, d.sort_order
FROM "tenant" t
CROSS JOIN (VALUES
  ('dependentRelationship', 'spouse', 0),
  ('dependentRelationship', 'child', 1),
  ('dependentRelationship', 'parent', 2),
  ('dependentRelationship', 'sibling', 3),
  ('dependentRelationship', 'other', 4)
) AS d(category, value, sort_order)
ON CONFLICT ("tenant_id", "category", "value") DO NOTHING;
