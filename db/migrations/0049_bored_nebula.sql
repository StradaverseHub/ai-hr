CREATE TYPE "public"."goal_status" AS ENUM('active', 'achieved', 'missed', 'dropped');--> statement-breakpoint
CREATE TABLE "performance_goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"cycle_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"metric" text,
	"target" text,
	"weight" numeric(5, 2),
	"progress" integer DEFAULT 0 NOT NULL,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"due_on" date,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "performance_goal" ADD CONSTRAINT "performance_goal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_goal" ADD CONSTRAINT "performance_goal_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_goal" ADD CONSTRAINT "performance_goal_cycle_id_review_cycle_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."review_cycle"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_goal" ADD CONSTRAINT "review_goal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_goal" ADD CONSTRAINT "review_goal_review_id_performance_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."performance_review"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_goal" ADD CONSTRAINT "review_goal_goal_id_performance_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."performance_goal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "performance_goal_employment_idx" ON "performance_goal" USING btree ("employment_id");--> statement-breakpoint
CREATE INDEX "performance_goal_cycle_idx" ON "performance_goal" USING btree ("cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_goal_review_goal_uq" ON "review_goal" USING btree ("review_id","goal_id");