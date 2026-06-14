-- Knowledge Base RLS (ADR-0017).
--
-- The KB is shared organizational knowledge: any tenant member READS all of it (audience is a UI
-- filter, not access control). Contributions are open (any member may INSERT). Mutations are scoped:
-- an admin manages everything; a member may only modify/delete their OWN non-system documents — the
-- seeded official guides (is_system = true) are admin-managed. The UPDATE WITH CHECK also blocks a
-- non-admin from flipping is_system to true (privilege escalation): the post-image must still satisfy
-- (admin OR own-and-not-system), so a member setting is_system = true fails the check.

ALTER TABLE kb_document ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kb_document TO ai_hr_app;--> statement-breakpoint

CREATE POLICY kb_document_read ON kb_document FOR SELECT
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY kb_document_insert ON kb_document FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY kb_document_update ON kb_document FOR UPDATE
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_admin()
      OR (created_by_user_id = app.current_user_id() AND is_system = false)
    )
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_admin()
      OR (created_by_user_id = app.current_user_id() AND is_system = false)
    )
  );--> statement-breakpoint

CREATE POLICY kb_document_delete ON kb_document FOR DELETE
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_admin()
      OR (created_by_user_id = app.current_user_id() AND is_system = false)
    )
  );
