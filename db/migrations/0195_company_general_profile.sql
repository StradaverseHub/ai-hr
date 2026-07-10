-- Enhance Company General Tab (bc5d4891): add Company Information + Contact Information master-data
-- columns to the company table. All nullable, additive-only, no backfill — byte-identical to today for
-- every existing company until an admin fills them in. The address `country` here is display/correspondence
-- only; company.country (ISO alpha-2, holiday/statutory driver) is a SEPARATE column and is NOT touched.
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "company_label" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "industry" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "website" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "business_type" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "address_line1" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "address_line2" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "address_line3" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "city" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "state" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "address_country" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "postcode" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "phone" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "fax" text;
