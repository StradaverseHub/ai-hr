CREATE TYPE "public"."calibration_status" AS ENUM('open', 'committed');--> statement-breakpoint
CREATE TABLE "calibration_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"proposed_rating" integer,
	"committed_rating" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibration_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"status" "calibration_status" DEFAULT 'open' NOT NULL,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calibration_entry" ADD CONSTRAINT "calibration_entry_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_entry" ADD CONSTRAINT "calibration_entry_session_id_calibration_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."calibration_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_entry" ADD CONSTRAINT "calibration_entry_review_id_performance_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."performance_review"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_session" ADD CONSTRAINT "calibration_session_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_session" ADD CONSTRAINT "calibration_session_cycle_id_review_cycle_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."review_cycle"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_entry_session_review_uq" ON "calibration_entry" USING btree ("session_id","review_id");--> statement-breakpoint
CREATE INDEX "calibration_session_cycle_idx" ON "calibration_session" USING btree ("cycle_id");