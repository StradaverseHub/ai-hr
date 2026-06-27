-- ADR-0054: location master data. Company-scoped physical-site records that carry an optional `state`
-- override for holiday resolution, feeding BOTH the leave and attendance engines so they never disagree on
-- a state-specific holiday. The employee↔location link is a nullable assignment.location_id (no second
-- bitemporal table — reuses assignment's CLOSE+INSERT history). Additive: existing assignment rows are
-- valid with location_id NULL, which is location-blind = today's behaviour. Explicit ai_hr_app grants.

CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"country" text DEFAULT 'MY' NOT NULL,
	"state" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_company_idx" ON "location" USING btree ("tenant_id","company_id");--> statement-breakpoint
-- code unique per tenant among non-archived (mirrors shift_company_name_uq)
CREATE UNIQUE INDEX "location_code_uq" ON "location" USING btree ("tenant_id","code") WHERE "archived_at" IS NULL;--> statement-breakpoint

-- The entire employee↔location link: a nullable column on the existing effective-dated assignment row.
ALTER TABLE "assignment" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- RLS: a location is visible AND writable only to an admin OF ITS COMPANY (is_admin_for in BOTH clauses,
-- so an out-of-company admin genuinely cannot SEE it, not just cannot write it). assignment already has its
-- own RLS (can_admin_employment); the new nullable column needs no policy change.
ALTER TABLE "location" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "location_rls" ON "location" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "location" TO ai_hr_app;
