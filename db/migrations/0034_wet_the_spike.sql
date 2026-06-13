CREATE TYPE "public"."comp_action_status" AS ENUM('none', 'recommended', 'enacted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."performance_review_status" AS ENUM('not_started', 'self_review', 'manager_review', 'submitted', 'acknowledged');--> statement-breakpoint
CREATE TYPE "public"."review_cycle_status" AS ENUM('draft', 'open', 'calibration', 'closed');--> statement-breakpoint
CREATE TABLE "performance_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"reviewer_employment_id" uuid,
	"status" "performance_review_status" DEFAULT 'not_started' NOT NULL,
	"self_rating" integer,
	"self_comments" text,
	"goals_summary" text,
	"manager_rating" integer,
	"manager_comments" text,
	"overall_rating" integer,
	"recommended_merit_pct" numeric(5, 2),
	"recommended_bonus" numeric(12, 2),
	"comp_action_status" "comp_action_status" DEFAULT 'none' NOT NULL,
	"enacted_compensation_id" uuid,
	"enacted_batch_id" uuid,
	"enacted_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_cycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid,
	"name" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "review_cycle_status" DEFAULT 'draft' NOT NULL,
	"rating_scale" jsonb NOT NULL,
	"merit_budget" jsonb,
	"exclude_probation" boolean DEFAULT true NOT NULL,
	"hired_before" date,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "performance_review" ADD CONSTRAINT "performance_review_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_review" ADD CONSTRAINT "performance_review_cycle_id_review_cycle_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."review_cycle"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_review" ADD CONSTRAINT "performance_review_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_review" ADD CONSTRAINT "performance_review_reviewer_employment_id_employment_id_fk" FOREIGN KEY ("reviewer_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycle" ADD CONSTRAINT "review_cycle_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycle" ADD CONSTRAINT "review_cycle_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "performance_review_cycle_emp_uq" ON "performance_review" USING btree ("cycle_id","employment_id");--> statement-breakpoint
CREATE INDEX "performance_review_employment_idx" ON "performance_review" USING btree ("employment_id");--> statement-breakpoint
CREATE INDEX "performance_review_reviewer_idx" ON "performance_review" USING btree ("reviewer_employment_id");--> statement-breakpoint
CREATE INDEX "review_cycle_tenant_idx" ON "review_cycle" USING btree ("tenant_id","company_id");