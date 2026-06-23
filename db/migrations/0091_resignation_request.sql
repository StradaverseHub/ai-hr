-- ADR-0042 (#29): self-service resignation requests. An employee raises one; HR accepts it, which triggers
-- the existing terminateEmployment (recorded as a 'voluntary' termination). RLS mirrors
-- profile_change_request: can_see_employment for read+write (employee acts on own, admin sees their scope);
-- the decide authorization (admin-only, never self) lives in the service, like decideProfileChange.
CREATE TYPE "resignation_status" AS ENUM('pending', 'accepted', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TABLE "resignation_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"last_working_day" date NOT NULL,
	"reason" text,
	"status" "resignation_status" DEFAULT 'pending' NOT NULL,
	"decided_by_employment_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resignation_request" ADD CONSTRAINT "resignation_request_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignation_request" ADD CONSTRAINT "resignation_request_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignation_request" ADD CONSTRAINT "resignation_request_decided_by_fk" FOREIGN KEY ("decided_by_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resignation_request_employment_idx" ON "resignation_request" USING btree ("employment_id","status");--> statement-breakpoint
ALTER TABLE resignation_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON resignation_request TO ai_hr_app;--> statement-breakpoint
CREATE POLICY resignation_request_rls ON resignation_request FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
