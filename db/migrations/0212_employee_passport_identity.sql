-- Item e3ce0d4d — Nationality-conditional identification on employee_statutory_my. Malaysians are identified
-- by their MyKad IC (existing ic_number); non-Malaysians by their Passport. Additive + backward-compatible:
--   • Four new nullable passport columns (number / issue date / expiry date / remark). Only non-Malaysian
--     rows populate them; existing Malaysian rows keep a null passport block and their IC exactly as-is.
--   • ic_number RELAXED to NULLABLE so a non-Malaysian employee (no MyKad) can save an identity row with no IC.
--   • The (tenant_id, ic_number) uniqueness becomes a PARTIAL index (WHERE ic_number IS NOT NULL) so multiple
--     non-Malaysian rows carrying a null IC don't collide, while real ICs stay unique per tenant.
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "passport_number" text;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "passport_issue_date" date;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "passport_expiry_date" date;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "passport_remark" text;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ALTER COLUMN "ic_number" DROP NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "employee_statutory_my_ic_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employee_statutory_my_ic_uq" ON "employee_statutory_my" USING btree ("tenant_id","ic_number") WHERE "ic_number" IS NOT NULL;
