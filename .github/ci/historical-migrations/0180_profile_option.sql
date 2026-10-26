-- 7d309da7 — Personnel Profile: configurable dropdown catalogs (religion / race / nationality / state /
-- country / relationship). Purely ADDITIVE. A new GENERIC tenant-wide option table `profile_option`
-- (category-keyed) backs the six dropdowns that were free-text on the Profile tab. Person columns STAY text
-- (NO data migration): a stored value not in this catalog is preserved on save (legacy-value tolerance);
-- the catalog only governs what an admin may NEWLY pick. Deliberately NOT folded into LABEL_KINDS
-- (department/position/cost_center/business_unit are company-scoped typed tables) — these are flat
-- tenant-wide lists.
--
-- RLS mirrors claim_type (0048_claims_rls.sql): tenant-read for every member, admin-only write
-- (WITH CHECK app.is_admin()). New tables never inherit grants (ADR-0002) — grant ai_hr_app explicitly.

CREATE TABLE IF NOT EXISTS "profile_option" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category" text NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_option_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_option_tenant_cat_idx" ON "profile_option" USING btree ("tenant_id","category");--> statement-breakpoint
-- The idempotency key the seed + the create path rely on (one row per tenant/category/value).
CREATE UNIQUE INDEX IF NOT EXISTS "profile_option_tenant_cat_value_uq" ON "profile_option" USING btree ("tenant_id","category","value");--> statement-breakpoint

-- New tables never inherit grants (ADR-0002) — grant the app role explicitly. Plain GRANT/POLICY (matching
-- 0048/0168): drizzle never re-runs a recorded migration, so these run exactly once on a fresh table.
GRANT SELECT, INSERT, UPDATE, DELETE ON "profile_option" TO ai_hr_app;--> statement-breakpoint
ALTER TABLE "profile_option" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "profile_option_rls" ON "profile_option" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

-- Seed the default catalog for EVERY existing tenant (idempotent via the unique index). New tenants are
-- seeded by core/profile-options.ts::seedProfileOptions at provisioning / first admin visit. This list is
-- kept BYTE-IDENTICAL with DEFAULT_PROFILE_OPTIONS in core/profile-options.ts. state ← MY_STATES (16);
-- relationship ← DEPENDENT_RELATIONSHIPS ∪ common emergency kinds; sensible defaults for the rest.
INSERT INTO "profile_option" ("tenant_id", "category", "value", "label", "sort_order")
SELECT t.id, d.category, d.value, d.value, d.sort_order
FROM "tenant" t
CROSS JOIN (VALUES
  ('religion', 'Islam', 0),
  ('religion', 'Buddhism', 1),
  ('religion', 'Christianity', 2),
  ('religion', 'Hinduism', 3),
  ('religion', 'Sikhism', 4),
  ('religion', 'Taoism', 5),
  ('religion', 'None', 6),
  ('religion', 'Other', 7),
  ('race', 'Malay', 0),
  ('race', 'Chinese', 1),
  ('race', 'Indian', 2),
  ('race', 'Bumiputera Sabah', 3),
  ('race', 'Bumiputera Sarawak', 4),
  ('race', 'Other', 5),
  ('nationality', 'Malaysian', 0),
  ('nationality', 'Singaporean', 1),
  ('nationality', 'Indonesian', 2),
  ('nationality', 'Indian', 3),
  ('nationality', 'Bangladeshi', 4),
  ('nationality', 'Nepalese', 5),
  ('nationality', 'Filipino', 6),
  ('nationality', 'Other', 7),
  ('state', 'Johor', 0),
  ('state', 'Kedah', 1),
  ('state', 'Kelantan', 2),
  ('state', 'Melaka', 3),
  ('state', 'Negeri Sembilan', 4),
  ('state', 'Pahang', 5),
  ('state', 'Perak', 6),
  ('state', 'Perlis', 7),
  ('state', 'Pulau Pinang', 8),
  ('state', 'Sabah', 9),
  ('state', 'Sarawak', 10),
  ('state', 'Selangor', 11),
  ('state', 'Terengganu', 12),
  ('state', 'Kuala Lumpur', 13),
  ('state', 'Labuan', 14),
  ('state', 'Putrajaya', 15),
  ('country', 'Malaysia', 0),
  ('country', 'Singapore', 1),
  ('country', 'Indonesia', 2),
  ('country', 'Thailand', 3),
  ('country', 'Brunei', 4),
  ('country', 'India', 5),
  ('country', 'Other', 6),
  ('relationship', 'Spouse', 0),
  ('relationship', 'Child', 1),
  ('relationship', 'Parent', 2),
  ('relationship', 'Sibling', 3),
  ('relationship', 'Guardian', 4),
  ('relationship', 'Friend', 5),
  ('relationship', 'Relative', 6),
  ('relationship', 'Colleague', 7),
  ('relationship', 'Other', 8)
) AS d(category, value, sort_order)
ON CONFLICT ("tenant_id", "category", "value") DO NOTHING;
