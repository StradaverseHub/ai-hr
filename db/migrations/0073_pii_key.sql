-- ADR-0030 Layer 1: per-subject crypto-shred key custody. Holds a per-subject DEK wrapped by the master
-- key; destroying it (NULL wrapped_dek + destroyed_at) voids every value sealed under it across the
-- append-only log without deleting an event row. Admin/DPO-only (key custody). subject_employment_id is a
-- soft reference (no FK) to avoid the person↔employment cascade-deadlock seen in migration 0069. No DELETE
-- grant — key rows are append + shred only, never deleted.
CREATE TABLE "pii_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_employment_id" uuid NOT NULL,
	"kid" text NOT NULL,
	"wrapped_dek" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destroyed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pii_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pii_key" ADD CONSTRAINT "pii_key_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pii_key_subject_kid_uq" ON "pii_key" USING btree ("tenant_id","subject_employment_id","kid");--> statement-breakpoint
CREATE POLICY "pii_key_rls" ON "pii_key" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "pii_key" TO ai_hr_app;
