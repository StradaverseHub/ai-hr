CREATE TYPE "public"."checkin_status" AS ENUM('scheduled', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "performance_checkin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_employment_id" uuid NOT NULL,
	"manager_employment_id" uuid,
	"scheduled_on" date NOT NULL,
	"status" "checkin_status" DEFAULT 'scheduled' NOT NULL,
	"notes" text,
	"completed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "performance_checkin" ADD CONSTRAINT "performance_checkin_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_checkin" ADD CONSTRAINT "performance_checkin_subject_employment_id_employment_id_fk" FOREIGN KEY ("subject_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_checkin" ADD CONSTRAINT "performance_checkin_manager_employment_id_employment_id_fk" FOREIGN KEY ("manager_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "performance_checkin_subject_idx" ON "performance_checkin" USING btree ("subject_employment_id");--> statement-breakpoint
CREATE INDEX "performance_checkin_manager_idx" ON "performance_checkin" USING btree ("manager_employment_id");