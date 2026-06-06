CREATE TABLE "company_statutory_my" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"epf_employer_no" text,
	"socso_employer_code" text,
	"lhdn_employer_no" text,
	"myinvois_tin" text,
	"ssm_registration_no" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "parent_company_id" uuid;--> statement-breakpoint
ALTER TABLE "company_statutory_my" ADD CONSTRAINT "company_statutory_my_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_statutory_my" ADD CONSTRAINT "company_statutory_my_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_statutory_my_company_uq" ON "company_statutory_my" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_parent_company_id_company_id_fk" FOREIGN KEY ("parent_company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_parent_idx" ON "company" USING btree ("parent_company_id");