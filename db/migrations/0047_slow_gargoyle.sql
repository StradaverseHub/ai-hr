CREATE TYPE "public"."claim_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled', 'paid');--> statement-breakpoint
CREATE TABLE "claim_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"claim_request_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"content" "bytea" NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"claim_type_id" uuid NOT NULL,
	"annual_budget" numeric(12, 2),
	"per_claim_cap" numeric(12, 2),
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"claim_type_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"incurred_on" date NOT NULL,
	"description" text,
	"taxable" boolean DEFAULT false NOT NULL,
	"status" "claim_status" DEFAULT 'pending' NOT NULL,
	"decided_by_employment_id" uuid,
	"decided_at" timestamp with time zone,
	"payroll_batch_id" uuid,
	"paid_at" timestamp with time zone,
	"payout_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"default_taxable" boolean DEFAULT false NOT NULL,
	"requires_receipt" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_input" ADD COLUMN "claim_allowance" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_attachment" ADD CONSTRAINT "claim_attachment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_attachment" ADD CONSTRAINT "claim_attachment_claim_request_id_claim_request_id_fk" FOREIGN KEY ("claim_request_id") REFERENCES "public"."claim_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_attachment" ADD CONSTRAINT "claim_attachment_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_attachment" ADD CONSTRAINT "claim_attachment_uploaded_by_user_id_app_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_policy" ADD CONSTRAINT "claim_policy_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_policy" ADD CONSTRAINT "claim_policy_claim_type_id_claim_type_id_fk" FOREIGN KEY ("claim_type_id") REFERENCES "public"."claim_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_request" ADD CONSTRAINT "claim_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_request" ADD CONSTRAINT "claim_request_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_request" ADD CONSTRAINT "claim_request_claim_type_id_claim_type_id_fk" FOREIGN KEY ("claim_type_id") REFERENCES "public"."claim_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_request" ADD CONSTRAINT "claim_request_decided_by_employment_id_employment_id_fk" FOREIGN KEY ("decided_by_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_request" ADD CONSTRAINT "claim_request_payroll_batch_id_payroll_batch_id_fk" FOREIGN KEY ("payroll_batch_id") REFERENCES "public"."payroll_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_type" ADD CONSTRAINT "claim_type_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_attachment_claim_idx" ON "claim_attachment" USING btree ("claim_request_id");--> statement-breakpoint
CREATE INDEX "claim_policy_type_idx" ON "claim_policy" USING btree ("claim_type_id","valid_from");--> statement-breakpoint
CREATE INDEX "claim_request_employment_idx" ON "claim_request" USING btree ("employment_id","status");--> statement-breakpoint
CREATE INDEX "claim_type_tenant_idx" ON "claim_type" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_type_tenant_code_uq" ON "claim_type" USING btree ("tenant_id","code") WHERE archived_at IS NULL;