-- System Labels UI redesign (797e3523): add a nullable short-code "label" to each of the four label
-- tables. Additive-only, backward compatible — NULL/absent means the record simply has no short code
-- (today's exact behaviour). No backfill, no event: pure DDL on presentation columns.
ALTER TABLE "department" ADD COLUMN IF NOT EXISTS "label" text;
--> statement-breakpoint
ALTER TABLE "position" ADD COLUMN IF NOT EXISTS "label" text;
--> statement-breakpoint
ALTER TABLE "cost_center" ADD COLUMN IF NOT EXISTS "label" text;
--> statement-breakpoint
ALTER TABLE "business_unit" ADD COLUMN IF NOT EXISTS "label" text;
