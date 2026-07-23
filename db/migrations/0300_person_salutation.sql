-- 8c284478 — Personnel Profile: "Salutation" dropdown on Personal Details (positioned before Full Name),
-- backed by the profile_option catalog (new category 'salutation') exactly like religion/race (7d309da7).
-- Purely ADDITIVE: person.salutation is nullable free text — the catalog governs only what an admin may
-- NEWLY pick (legacy-value tolerance), and existing employee records stay blank until set.
ALTER TABLE "person" ADD COLUMN IF NOT EXISTS "salutation" text;--> statement-breakpoint

-- Seed the default salutation catalog (standard titles + Malaysian honorifics) for EVERY existing tenant —
-- a TOP-UP in the 0210_nationality_full_iso_seed.sql style, kept BYTE-IDENTICAL with
-- CATEGORY_DEFAULTS.salutation in core/profile-options.ts. IDEMPOTENT + NON-DESTRUCTIVE via
-- ON CONFLICT DO NOTHING: it never deletes, renames, or reactivates rows an admin curated. New tenants are
-- seeded by core/profile-options.ts::seedProfileOptions at provisioning. Data-only beyond the ALTER above:
-- no RLS change (profile_option already has tenant-read + admin-write policies from 0180).
INSERT INTO "profile_option" ("tenant_id", "category", "value", "label", "sort_order")
SELECT t.id, d.category, d.value, d.value, d.sort_order
FROM "tenant" t
CROSS JOIN (VALUES
  ('salutation', 'Mr', 0),
  ('salutation', 'Mrs', 1),
  ('salutation', 'Ms', 2),
  ('salutation', 'Mdm', 3),
  ('salutation', 'Dr', 4),
  ('salutation', 'Prof', 5),
  ('salutation', 'Ir', 6),
  ('salutation', 'Ts', 7),
  ('salutation', 'Hj', 8),
  ('salutation', 'Hjh', 9),
  ('salutation', 'Dato''', 10),
  ('salutation', 'Datin', 11),
  ('salutation', 'Dato'' Sri', 12),
  ('salutation', 'Datuk', 13),
  ('salutation', 'Tan Sri', 14),
  ('salutation', 'Puan Sri', 15),
  ('salutation', 'Tun', 16)
) AS d(category, value, sort_order)
ON CONFLICT ("tenant_id", "category", "value") DO NOTHING;
