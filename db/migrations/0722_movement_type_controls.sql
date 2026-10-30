-- 1d58019a — "Movement Settings Enhancement", Step 2 (ADR-0166).
--
-- THREE ADDITIVE TABLES. Nothing is backfilled, nothing is dropped, and a tenant that configures nothing
-- behaves exactly as before: no reason rows means every active reason is offered, no field-rule rows means
-- today's full comparison grid, and no attachment rows means a movement with no documents.
--
-- Custom Termination classification needs NO schema change: movement_event_type.behaviour_kind is already
-- free text (0340) and the allowed set is enforced in core/movement-type.ts on write AND read. The
-- classification itself is derived from the behaviour and is deliberately not stored anywhere.
--
-- ── 1. movement_type_termination_reason — which reasons a Termination type offers ───────────────────
-- One row per (tenant, type code, reason code). Rows exist only for a type whose behaviour is Termination
-- (enforced by the service, which owns both catalogues). No rows for a type = every active reason. Codes are
-- text with no foreign key, the same rule as employment.termination_reason_code: the reason catalogue is an
-- overlay on a code constant, so most reason codes have no table row to reference.
--
-- ── 2. movement_type_field_rule — Field Controls per comparison type ────────────────────────────────
-- One row per (tenant, type code, field). The CHECKs encode the grid's dependencies so no row can claim an
-- impossible combination: Allow to Edit needs Want to Change This; Required to Change needs Allow to Edit;
-- a document needs the field to be editable. The field list is the comparison set the New Event form can
-- move (lib/movement-form-contract.ts movementFormFields plus companyId for Entity Transfer).
--
-- ── 3. movement_attachment — supporting documents on a movement ──────────────────────────────────────
-- Follows profile_change_attachment (0683): PDF/PNG/JPEG only, bounded size, bytes in the row, append-only
-- (no UPDATE or DELETE grant — a document is evidence of the movement it was attached to). Keyed by the
-- movement's group id (the MovementTag.groupId every leg of one movement shares, also carried by a
-- scheduled movement and by the legs the sweep writes for it), plus the employment for RLS.
--
-- RLS. Settings tables: every tenant member may READ (the New Event form and the movement writer resolve
-- them for whoever records a movement); only an admin may write. Attachments: READ requires workforce view
-- of the employment (the same scope that sees Employment History), and a document filed against a pay field
-- additionally requires the compensation read predicate (0099 compensation_rls). INSERT requires an admin
-- with workforce maintain, and for a pay field the compensation write predicate. The service checks the
-- admin role and the movement's own visibility as well. New tables never inherit grants (ADR-0002), but
-- deploy/bootstrap-db.sql's ALTER DEFAULT PRIVILEGES makes every new table fully writable by ai_hr_app
-- (see 0313's header), so the privileges these tables must NOT have are revoked explicitly below.

CREATE TABLE IF NOT EXISTS "movement_type_termination_reason" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type_code" text NOT NULL,
	"reason_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movement_type_termination_reason_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "movement_type_termination_reason_type_code_check" CHECK ("type_code" ~ '^[a-zA-Z][a-zA-Z0-9_]{1,39}$'),
	CONSTRAINT "movement_type_termination_reason_reason_code_check" CHECK ("reason_code" ~ '^[a-z][a-z0-9_]{1,39}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "movement_type_termination_reason_uq" ON "movement_type_termination_reason" USING btree ("tenant_id","type_code","reason_code");--> statement-breakpoint
REVOKE ALL ON "movement_type_termination_reason" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "movement_type_termination_reason" TO ai_hr_app;--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON "movement_type_termination_reason" FROM ai_hr_app;--> statement-breakpoint
ALTER TABLE "movement_type_termination_reason" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "movement_type_termination_reason" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "movement_type_termination_reason_read" ON "movement_type_termination_reason" FOR SELECT
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY "movement_type_termination_reason_insert" ON "movement_type_termination_reason" FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
CREATE POLICY "movement_type_termination_reason_delete" ON "movement_type_termination_reason" FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
COMMENT ON TABLE "movement_type_termination_reason" IS
  '1d58019a — the termination reasons one Termination event type offers. No rows for a type = every active reason. Written only by core/movement-type-controls.ts under the movement-type catalogue lock. ADR-0166.';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "movement_type_field_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type_code" text NOT NULL,
	"field" text NOT NULL,
	"included" boolean NOT NULL,
	"editable" boolean NOT NULL,
	"must_change" boolean NOT NULL,
	"document" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movement_type_field_rule_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "movement_type_field_rule_type_code_check" CHECK ("type_code" ~ '^[a-zA-Z][a-zA-Z0-9_]{1,39}$'),
	CONSTRAINT "movement_type_field_rule_field_check" CHECK ("field" IN (
		'companyId','businessUnitId','departmentId','positionId','gradeId','employmentType','locationId',
		'managerEmploymentId','basicSalary','currency','payMode','paymentTerm','orgDivision','employmentCategory',
		'orgRegion','orgBranch','orgTeam','orgSection','orgLine','orgBase')),
	CONSTRAINT "movement_type_field_rule_document_check" CHECK ("document" IN ('none', 'optional', 'required')),
	CONSTRAINT "movement_type_field_rule_editable_check" CHECK (NOT "editable" OR "included"),
	CONSTRAINT "movement_type_field_rule_must_change_check" CHECK (NOT "must_change" OR "editable"),
	CONSTRAINT "movement_type_field_rule_document_editable_check" CHECK ("document" = 'none' OR "editable")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "movement_type_field_rule_uq" ON "movement_type_field_rule" USING btree ("tenant_id","type_code","field");--> statement-breakpoint
REVOKE ALL ON "movement_type_field_rule" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "movement_type_field_rule" TO ai_hr_app;--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON "movement_type_field_rule" FROM ai_hr_app;--> statement-breakpoint
ALTER TABLE "movement_type_field_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "movement_type_field_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "movement_type_field_rule_read" ON "movement_type_field_rule" FOR SELECT
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY "movement_type_field_rule_insert" ON "movement_type_field_rule" FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
CREATE POLICY "movement_type_field_rule_delete" ON "movement_type_field_rule" FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
COMMENT ON TABLE "movement_type_field_rule" IS
  '1d58019a — Field Controls for one comparison event type. No rows for a type = every comparison field included and editable, none required to change, no document. Enforced by core/movement.ts on create, correction and import; never re-applied to history. ADR-0166.';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "movement_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"movement_group_id" uuid NOT NULL,
	"field" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" bytea NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movement_attachment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "movement_attachment_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "movement_attachment_field_check" CHECK ("field" IN (
		'companyId','businessUnitId','departmentId','positionId','gradeId','employmentType','locationId',
		'managerEmploymentId','basicSalary','currency','payMode','paymentTerm','orgDivision','employmentCategory',
		'orgRegion','orgBranch','orgTeam','orgSection','orgLine','orgBase')),
	CONSTRAINT "movement_attachment_file_name_check" CHECK (char_length("file_name") BETWEEN 1 AND 200),
	CONSTRAINT "movement_attachment_mime_type_check" CHECK ("mime_type" IN ('application/pdf', 'image/png', 'image/jpeg')),
	CONSTRAINT "movement_attachment_size_check" CHECK ("size_bytes" BETWEEN 1 AND 5242880 AND octet_length("content") = "size_bytes")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "movement_attachment_group_idx" ON "movement_attachment" USING btree ("tenant_id","employment_id","movement_group_id");--> statement-breakpoint
REVOKE ALL ON "movement_attachment" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON "movement_attachment" TO ai_hr_app;--> statement-breakpoint
-- Append-only evidence: no UPDATE or DELETE for the application role, whatever the default privileges say.
REVOKE UPDATE, DELETE, TRUNCATE ON "movement_attachment" FROM ai_hr_app;--> statement-breakpoint
ALTER TABLE "movement_attachment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "movement_attachment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "movement_attachment_read" ON "movement_attachment" FOR SELECT
  USING (
    tenant_id = app.current_tenant_id()
    AND app.access_workforce_employment(employment_id, 'workforce.view')
    AND (
      field NOT IN ('basicSalary', 'currency', 'payMode', 'paymentTerm')
      OR app.can_admin_employment(employment_id)
      OR app.can_admin_perfcomp_employment(employment_id)
      OR app.can_admin_payroll_employment(employment_id)
    )
  );--> statement-breakpoint
CREATE POLICY "movement_attachment_insert" ON "movement_attachment" FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND app.is_admin()
    AND app.access_workforce_employment(employment_id, 'workforce.maintain')
    AND (
      field NOT IN ('basicSalary', 'currency', 'payMode', 'paymentTerm')
      OR app.can_admin_employment(employment_id)
      OR app.can_admin_perfcomp_employment(employment_id)
    )
  );--> statement-breakpoint
COMMENT ON TABLE "movement_attachment" IS
  '1d58019a — supporting documents on a movement, keyed by its group id. Append-only evidence. Read through core/movement-attachments.ts, which applies Employment History visibility; pay-field documents follow the compensation read predicate. ADR-0166.';
