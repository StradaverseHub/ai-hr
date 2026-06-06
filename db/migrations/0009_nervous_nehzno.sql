CREATE TYPE "public"."payroll_status" AS ENUM('draft', 'processed', 'closed');--> statement-breakpoint
CREATE TABLE "payroll_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"pay_period" text NOT NULL,
	"batch_date" date NOT NULL,
	"status" "payroll_status" DEFAULT 'draft' NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"totals" jsonb,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payslip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"basic_salary" numeric(12, 2) NOT NULL,
	"allowance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"overtime_pay" numeric(12, 2) DEFAULT '0' NOT NULL,
	"gross_pay" numeric(12, 2) NOT NULL,
	"statutory" jsonb NOT NULL,
	"other_deductions" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_deductions" numeric(12, 2) NOT NULL,
	"net_pay" numeric(12, 2) NOT NULL,
	"employer_cost" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_batch" ADD CONSTRAINT "payroll_batch_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_batch" ADD CONSTRAINT "payroll_batch_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip" ADD CONSTRAINT "payslip_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip" ADD CONSTRAINT "payslip_batch_id_payroll_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payroll_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip" ADD CONSTRAINT "payslip_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_batch_period_uq" ON "payroll_batch" USING btree ("company_id","pay_period");--> statement-breakpoint
CREATE UNIQUE INDEX "payslip_batch_employment_uq" ON "payslip" USING btree ("batch_id","employment_id");