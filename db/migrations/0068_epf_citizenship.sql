-- G1 (#95 follow-on): EPF citizenship status for the Third Schedule rule selection.
-- Additive + back-compat: every existing employee defaults to 'citizen' (today's behaviour = Part A).
-- Source: KWSP Jadual Ketiga (eff 1 Oct 2025) + YiWei Law statutory deck (10 Jun 2026).
DO $$ BEGIN
  CREATE TYPE "public"."epf_citizenship" AS ENUM('citizen', 'pr', 'non_citizen');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my"
  ADD COLUMN IF NOT EXISTS "epf_citizenship" "public"."epf_citizenship" NOT NULL DEFAULT 'citizen';
