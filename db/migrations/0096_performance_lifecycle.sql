-- Performance Tracking — full lifecycle (ADR-0022 lifecycle extension).
--
-- Column-widening, NOT a stage table: the spec names exactly 3 fixed stages (goal-setting /
-- mid-year / year-end). Year-end reuses the canonical self/manager/overall columns on
-- performance_review, so calibration, comp, release, acknowledge, distribution, and AI keep
-- working untouched. Mid-year and goal-setting get their own column sets. review_cycle.stages
-- (JSONB) records which stages HR elected at initiation. Closure (G4) adds preliminary/final
-- scores + a 3-value ABC class. Goal approval (G2) adds a draft→proposed→approved status.
--
-- Only performance_attachment is a NEW table, so only it needs a fresh RLS policy — it is
-- subject-scoped (employment_id denormalized from the review's subject) exactly like
-- claim_attachment, so the policy is a direct can_see_employment(). The widened columns inherit
-- the existing performance_review / performance_goal / review_cycle table policies.

CREATE TYPE "public"."perf_goal_stage_status" AS ENUM('pending', 'locked');--> statement-breakpoint
CREATE TYPE "public"."perf_goal_approval" AS ENUM('draft', 'proposed', 'approved');--> statement-breakpoint
CREATE TYPE "public"."perf_abc_class" AS ENUM('A', 'B', 'C');--> statement-breakpoint

CREATE TABLE "performance_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"stage_kind" text,
	"content" "bytea" NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "performance_attachment" ADD CONSTRAINT "performance_attachment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_attachment" ADD CONSTRAINT "performance_attachment_review_id_performance_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."performance_review"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_attachment" ADD CONSTRAINT "performance_attachment_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_attachment" ADD CONSTRAINT "performance_attachment_uploaded_by_user_id_app_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "performance_attachment_review_idx" ON "performance_attachment" USING btree ("review_id");--> statement-breakpoint

ALTER TABLE "review_cycle" ADD COLUMN "stages" jsonb;--> statement-breakpoint

ALTER TABLE "performance_review" ADD COLUMN "mid_self_rating" integer;--> statement-breakpoint
ALTER TABLE "performance_review" ADD COLUMN "mid_self_comments" text;--> statement-breakpoint
ALTER TABLE "performance_review" ADD COLUMN "mid_self_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "performance_review" ADD COLUMN "mid_manager_rating" integer;--> statement-breakpoint
ALTER TABLE "performance_review" ADD COLUMN "mid_manager_comments" text;--> statement-breakpoint
ALTER TABLE "performance_review" ADD COLUMN "mid_manager_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "performance_review" ADD COLUMN "goal_stage_status" "perf_goal_stage_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "performance_review" ADD COLUMN "goal_stage_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "performance_review" ADD COLUMN "preliminary_score" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "performance_review" ADD COLUMN "final_score" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "performance_review" ADD COLUMN "abc_class" "perf_abc_class";--> statement-breakpoint
ALTER TABLE "performance_review" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "performance_goal" ADD COLUMN "approval_status" "perf_goal_approval" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "performance_goal" ADD COLUMN "approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "performance_goal" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE performance_attachment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON performance_attachment TO ai_hr_app;--> statement-breakpoint
CREATE POLICY performance_attachment_rls ON performance_attachment FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
