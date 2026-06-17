CREATE TYPE "public"."feedback_request_status" AS ENUM('pending', 'submitted', 'declined');--> statement-breakpoint
CREATE TABLE "peer_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"subject_employment_id" uuid NOT NULL,
	"strengths" text,
	"improvements" text,
	"named" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "peer_feedback_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"subject_employment_id" uuid NOT NULL,
	"peer_employment_id" uuid NOT NULL,
	"status" "feedback_request_status" DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "peer_feedback" ADD CONSTRAINT "peer_feedback_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_feedback" ADD CONSTRAINT "peer_feedback_request_id_peer_feedback_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."peer_feedback_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_feedback" ADD CONSTRAINT "peer_feedback_subject_employment_id_employment_id_fk" FOREIGN KEY ("subject_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_feedback_request" ADD CONSTRAINT "peer_feedback_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_feedback_request" ADD CONSTRAINT "peer_feedback_request_review_id_performance_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."performance_review"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_feedback_request" ADD CONSTRAINT "peer_feedback_request_subject_employment_id_employment_id_fk" FOREIGN KEY ("subject_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_feedback_request" ADD CONSTRAINT "peer_feedback_request_peer_employment_id_employment_id_fk" FOREIGN KEY ("peer_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "peer_feedback_request_uq" ON "peer_feedback" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "peer_feedback_subject_idx" ON "peer_feedback" USING btree ("subject_employment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "peer_feedback_request_review_peer_uq" ON "peer_feedback_request" USING btree ("review_id","peer_employment_id");--> statement-breakpoint
CREATE INDEX "peer_feedback_request_subject_idx" ON "peer_feedback_request" USING btree ("subject_employment_id");--> statement-breakpoint
CREATE INDEX "peer_feedback_request_peer_idx" ON "peer_feedback_request" USING btree ("peer_employment_id");