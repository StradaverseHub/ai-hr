CREATE TYPE "public"."profile_change_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "profile_change_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"proposed" jsonb NOT NULL,
	"status" "profile_change_status" DEFAULT 'pending' NOT NULL,
	"decided_by_employment_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "emergency_contact_name" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "emergency_contact_phone" text;--> statement-breakpoint
ALTER TABLE "profile_change_request" ADD CONSTRAINT "profile_change_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_request" ADD CONSTRAINT "profile_change_request_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_request" ADD CONSTRAINT "profile_change_request_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_change_request" ADD CONSTRAINT "profile_change_request_decided_by_employment_id_employment_id_fk" FOREIGN KEY ("decided_by_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_change_request_employment_idx" ON "profile_change_request" USING btree ("employment_id","status");--> statement-breakpoint

-- ── ESS (ADR-0012): RLS for profile change requests ────────────────
ALTER TABLE profile_change_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON profile_change_request TO ai_hr_app;--> statement-breakpoint
CREATE POLICY profile_change_request_rls ON profile_change_request FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));--> statement-breakpoint

-- ── ESS: let an employee write their OWN person row (contact fields only) ──
-- RLS scopes the row; the service layer scopes the columns (never name/email). Admins keep full write.
CREATE OR REPLACE FUNCTION app.is_self_person(p_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_user u
    WHERE u.id = app.current_user_id() AND u.person_id = p_id AND u.tenant_id = app.current_tenant_id()
  );
$$;--> statement-breakpoint
DROP POLICY IF EXISTS person_rls ON person;--> statement-breakpoint
CREATE POLICY person_rls ON person FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_person(id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND (app.is_admin() OR app.is_self_person(id)));