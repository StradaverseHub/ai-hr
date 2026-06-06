-- Null out any pre-existing incoherent rows so the constraint applies cleanly.
UPDATE "role_assignment" SET "company_id" = NULL WHERE "role" = 'super_admin' AND "company_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_super_admin_group_wide" CHECK ("role_assignment"."role" <> 'super_admin' OR "role_assignment"."company_id" IS NULL);