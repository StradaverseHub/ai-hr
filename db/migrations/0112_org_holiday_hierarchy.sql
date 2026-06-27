-- ADR-0055: org-based public-holiday override. Extends the state-specific holiday engine (ADR-0038 2C)
-- with a business-group (company-subtree) layer ON TOP of state and national. Resolution is single-winner
-- replacement: business-group (company subtree) → state → national. The widened unique index lets the same
-- date exist at national, state, AND group scope without collision; the CHECK makes scope mutually
-- exclusive at the DB so seed/CSV/import paths cannot create an ambiguous multi-scope row. All four
-- statements are additive and backfill-safe — existing rows have company_id NULL and at most one of
-- (state, company_id) set, so the CHECK and the superset index can only ever accept MORE rows than today.

ALTER TABLE "holiday" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_scope_excl" CHECK (num_nonnulls("state", "company_id") <= 1);--> statement-breakpoint
DROP INDEX IF EXISTS "holiday_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_uq" ON "holiday" USING btree ("tenant_id","country","holiday_date",coalesce("state", ''),coalesce("company_id", '00000000-0000-0000-0000-000000000000'::uuid));
