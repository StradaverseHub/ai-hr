-- ADR-0039 2B-2: the configurable leave approval chain. A per-company policy (optionally per leave-type)
-- whose `levels` jsonb is an ordered list of level kinds ('direct_manager' | 'hr_admin'). Resolved at
-- request time. Catalog RLS: readable tenant-wide (the requester, an ordinary employee, must read it to
-- generate steps) and writable only by an admin for the company. Additive; companies with no row fall
-- back to the built-in [direct_manager, hr_admin] chain (identical to 2B-1).
CREATE TABLE "leave_approval_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"leave_type_id" uuid,
	"levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD CONSTRAINT "leave_approval_policy_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD CONSTRAINT "leave_approval_policy_leave_type_id_leave_type_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leave_approval_policy_company_default_uq" ON "leave_approval_policy" USING btree ("company_id") WHERE "leave_type_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "leave_approval_policy_company_type_uq" ON "leave_approval_policy" USING btree ("company_id","leave_type_id") WHERE "leave_type_id" is not null;--> statement-breakpoint
ALTER TABLE leave_approval_policy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_approval_policy TO ai_hr_app;--> statement-breakpoint
CREATE POLICY leave_approval_policy_rls ON leave_approval_policy FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
