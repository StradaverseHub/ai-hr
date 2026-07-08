-- 6fadb036 (R17) — Approval Workflow Enhancement under Leave Config. Adds REUSABLE approval templates, a
-- tenant-wide default chain, and a bulk template→(company×leave-type) assignment layer ON TOP of the
-- existing ADR-0071 scoped rule matrix (leave_approval_policy). A template is a named tenant-level chain
-- (`levels`, same 'direct_manager' | 'hr_admin' vocabulary). Assigning it to a combination writes a
-- leave_approval_policy row with template_id set (the row's own levels cleared to []), so resolution is
-- unchanged; is_tenant_default marks the single org-wide default. Catalog RLS mirrors leave_type (readable
-- tenant-wide, writable by an admin) — the requester resolves the chain in its own transaction.

CREATE TABLE IF NOT EXISTS "leave_approval_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_tenant_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);--> statement-breakpoint

-- Case-insensitive unique name among a tenant's ACTIVE templates (mirrors leave_type_tenant_code_uq).
CREATE UNIQUE INDEX IF NOT EXISTS "leave_approval_template_name_uq"
  ON "leave_approval_template" ("tenant_id", lower("name")) WHERE "active";--> statement-breakpoint
-- Exactly one org-wide-default template per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "leave_approval_template_default_uq"
  ON "leave_approval_template" ("tenant_id") WHERE "is_tenant_default" AND "active";--> statement-breakpoint

-- A rule may draw its chain from a template instead of its own levels. FK-restrict: a referenced template
-- can never be hard-deleted (the service pre-checks for a friendly error; the FK is the backstop).
ALTER TABLE "leave_approval_policy" ADD COLUMN IF NOT EXISTS "template_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD CONSTRAINT "leave_approval_policy_template_id_leave_approval_template_id_fk"
  FOREIGN KEY ("template_id") REFERENCES "public"."leave_approval_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "leave_approval_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_approval_template" TO ai_hr_app;--> statement-breakpoint
CREATE POLICY "leave_approval_template_rls" ON "leave_approval_template" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
