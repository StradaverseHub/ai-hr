-- ADR-0032 Phase C slice C1: shift templates + per-date roster assignments. The roster is the per-employee
-- "expected" schedule the time engine will consume (C2). Additive + opt-in: no roster row ⇒ company-policy
-- fallback ⇒ today's behaviour. Explicit ai_hr_app grants (not relying on cluster defaults).

-- A reusable named shift for a company. differential is a CONFIGURABLE (non-statutory) pay rule, ADR-0032 §2.4.
CREATE TABLE "shift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"crosses_midnight" boolean DEFAULT false NOT NULL,
	"differential" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One concrete (employment, date) → a shift OR an explicit rest day. No row = not rostered (company-policy
-- fallback). CHECK: exactly one of (assigned a shift) / (rest day).
CREATE TABLE "roster_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"shift_date" date NOT NULL,
	"shift_id" uuid,
	"is_rest_day" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_assignment_shift_xor_rest" CHECK (("shift_id" IS NOT NULL AND NOT "is_rest_day") OR ("shift_id" IS NULL AND "is_rest_day"))
);
--> statement-breakpoint
ALTER TABLE "shift" ADD CONSTRAINT "shift_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift" ADD CONSTRAINT "shift_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignment" ADD CONSTRAINT "roster_assignment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignment" ADD CONSTRAINT "roster_assignment_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignment" ADD CONSTRAINT "roster_assignment_shift_id_shift_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shift"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- shift name unique per company among non-archived
CREATE UNIQUE INDEX "shift_company_name_uq" ON "shift" USING btree ("tenant_id","company_id","name") WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "roster_assignment_emp_date_uq" ON "roster_assignment" USING btree ("tenant_id","employment_id","shift_date");--> statement-breakpoint
CREATE INDEX "roster_assignment_date_idx" ON "roster_assignment" USING btree ("tenant_id","shift_date");--> statement-breakpoint

ALTER TABLE "shift" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "shift_rls" ON "shift" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint
ALTER TABLE "roster_assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "roster_assignment_rls" ON "roster_assignment" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "shift" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "roster_assignment" TO ai_hr_app;
