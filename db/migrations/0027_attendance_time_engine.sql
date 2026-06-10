CREATE TYPE "public"."attendance_day_type" AS ENUM('workday', 'rest_day', 'holiday');--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "day_type" "attendance_day_type";--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "worked_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "ot_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance_policy" ADD COLUMN "work_start" time DEFAULT '09:00:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_policy" ADD COLUMN "work_end" time DEFAULT '18:00:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_policy" ADD COLUMN "break_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_policy" ADD COLUMN "working_days" integer[] DEFAULT '{1,2,3,4,5}'::integer[] NOT NULL;