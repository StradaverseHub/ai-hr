CREATE TABLE "statutory_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"report_type" text NOT NULL,
	"period_kind" text NOT NULL,
	"period_key" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"statutory_version" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"totals" jsonb,
	"generated_by" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "statutory_report" ADD CONSTRAINT "statutory_report_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_report" ADD CONSTRAINT "statutory_report_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "statutory_report_tenant_idx" ON "statutory_report" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "statutory_report_company_period_idx" ON "statutory_report" USING btree ("company_id","report_type","period_key");--> statement-breakpoint
-- RLS (ADR-0010): filed per legal entity — visible/writable to admins of that company's subtree.
ALTER TABLE statutory_report ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON statutory_report TO ai_hr_app;--> statement-breakpoint
CREATE POLICY statutory_report_rls ON statutory_report FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));