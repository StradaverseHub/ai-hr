CREATE TABLE "payroll_input" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"overtime_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_input" ADD CONSTRAINT "payroll_input_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_input" ADD CONSTRAINT "payroll_input_batch_id_payroll_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payroll_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_input" ADD CONSTRAINT "payroll_input_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_input_batch_emp_uq" ON "payroll_input" USING btree ("batch_id","employment_id");--> statement-breakpoint
ALTER TABLE payroll_input ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_input TO ai_hr_app;--> statement-breakpoint
-- Per-employee overtime is sensitive payroll data: admin-only, scoped to the batch's company.
CREATE POLICY payroll_input_rls ON payroll_input FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = batch_id AND app.is_admin_for(b.company_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = batch_id AND app.is_admin_for(b.company_id))
  );