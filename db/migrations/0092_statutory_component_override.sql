-- Per-body statutory override (overlay) — ADR-0037 / consultant #6.
--
-- One row overrides ONE statutory body (epf/socso/eis/pcb/ot/hrdf) for an effective date; `data` holds
-- just that body's slice of the StatutoryRuleset. The resolver overlays the newest-effective component
-- per body on top of the bundled baseline (pack ∪ ruleset ∪ default), so a single body can be corrected
-- on its own legal timeline without re-issuing the others. Empty table ⇒ baseline unchanged.
--
-- RLS mirrors statutory_ruleset (ADR-0019): tenant-wide read (the /payroll/configuration surface is a
-- transparency view), admin-only writes (editing legal figures produces real payslips). Rows are
-- appended, never mutated by the service; UPDATE is granted only so an admin can archive (set
-- archived_at), and every WITH CHECK keeps the row inside the tenant.
CREATE TABLE "statutory_component_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"country" text DEFAULT 'MY' NOT NULL,
	"body" text NOT NULL,
	"version" text NOT NULL,
	"effective_from" date NOT NULL,
	"data" jsonb NOT NULL,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "statutory_component_override" ADD CONSTRAINT "statutory_component_override_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_component_override" ADD CONSTRAINT "statutory_component_override_body_check" CHECK ("body" IN ('epf','socso','eis','pcb','ot','hrdf'));--> statement-breakpoint
CREATE INDEX "statutory_component_override_lookup_idx" ON "statutory_component_override" USING btree ("tenant_id","country","body","effective_from");--> statement-breakpoint
ALTER TABLE "statutory_component_override" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON statutory_component_override TO ai_hr_app;--> statement-breakpoint
CREATE POLICY statutory_component_override_read ON statutory_component_override FOR SELECT
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY statutory_component_override_insert ON statutory_component_override FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
CREATE POLICY statutory_component_override_update ON statutory_component_override FOR UPDATE
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
CREATE POLICY statutory_component_override_delete ON statutory_component_override FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND app.is_admin());
