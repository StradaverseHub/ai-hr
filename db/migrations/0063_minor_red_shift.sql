CREATE TYPE "public"."absence_reason" AS ENUM('sick', 'casual', 'medical', 'unpaid', 'emergency', 'other');--> statement-breakpoint
CREATE TYPE "public"."termination_type" AS ENUM('voluntary', 'involuntary', 'retired', 'contract_end', 'death', 'other');--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "absence_reason" "absence_reason";--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "termination_type" "termination_type";--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "termination_reason" text;