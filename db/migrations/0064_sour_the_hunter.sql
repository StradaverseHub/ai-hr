CREATE TYPE "public"."pay_component_kind" AS ENUM('allowance', 'deduction', 'contribution', 'non_payable');--> statement-breakpoint
CREATE TABLE "employment_pay_component" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_component" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "pay_component_kind" NOT NULL,
	"included_in_epf" boolean DEFAULT false NOT NULL,
	"included_in_socso_eis" boolean DEFAULT false NOT NULL,
	"included_in_pcb" boolean DEFAULT true NOT NULL,
	"included_in_hrdf_base" boolean DEFAULT false NOT NULL,
	"is_non_payable" boolean DEFAULT false NOT NULL,
	"prorates" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_batch_component" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employment_pay_component" ADD CONSTRAINT "employment_pay_component_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_pay_component" ADD CONSTRAINT "employment_pay_component_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_pay_component" ADD CONSTRAINT "employment_pay_component_component_id_pay_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."pay_component"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_component" ADD CONSTRAINT "pay_component_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_batch_component" ADD CONSTRAINT "payroll_batch_component_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_batch_component" ADD CONSTRAINT "payroll_batch_component_batch_id_payroll_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payroll_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_batch_component" ADD CONSTRAINT "payroll_batch_component_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_batch_component" ADD CONSTRAINT "payroll_batch_component_component_id_pay_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."pay_component"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employment_pay_component_idx" ON "employment_pay_component" USING btree ("employment_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_component_code_uq" ON "pay_component" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_batch_component_uq" ON "payroll_batch_component" USING btree ("batch_id","employment_id","component_id");