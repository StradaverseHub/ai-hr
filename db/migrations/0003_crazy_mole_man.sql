CREATE TABLE "compensation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"basic_salary" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'MYR' NOT NULL,
	"monthly_allowance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_statutory_my" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"ic_number" text NOT NULL,
	"epf_number" text,
	"socso_number" text,
	"tax_number" text,
	"eis_eligible" boolean DEFAULT true NOT NULL,
	"bank_name" text,
	"bank_account_no" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_counter" (
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_counter_tenant_id_kind_pk" PRIMARY KEY("tenant_id","kind")
);
--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "employee_code" text;--> statement-breakpoint
ALTER TABLE "compensation" ADD CONSTRAINT "compensation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation" ADD CONSTRAINT "compensation_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD CONSTRAINT "employee_statutory_my_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD CONSTRAINT "employee_statutory_my_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_counter" ADD CONSTRAINT "tenant_counter_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compensation_employment_idx" ON "compensation" USING btree ("employment_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_statutory_my_person_uq" ON "employee_statutory_my" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_statutory_my_ic_uq" ON "employee_statutory_my" USING btree ("tenant_id","ic_number");--> statement-breakpoint
CREATE UNIQUE INDEX "employment_employee_code_uq" ON "employment" USING btree ("tenant_id","employee_code");