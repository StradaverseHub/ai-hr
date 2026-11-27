-- Board 2c1b2fba (approved plan item 3): the Draft Employee page gains the record's Upload photo control. A draft
-- creates no person (person_photo is keyed to one), so the photo waits in this 1:1 side table until Activate moves it to
-- person_photo through the canonical owner (core/person-photo.ts setPersonPhotoTx) inside the activation transaction
-- and the draft row's deletion removes this row (ON DELETE CASCADE). Discard removes it the same way.
-- Visible and writable exactly where its draft is: the EXISTS reads employee_draft under the caller's own row security
-- (its company/author policy and the restrictive Workforce draft policies), so the photo never widens draft access.
-- Writers additionally require HR administration of the draft's company with Workforce maintain (core/employee-draft-photo.ts).
-- No existing table, row, policy or function changes; the new table starts empty.
CREATE TABLE public.employee_draft_photo(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 draft_id uuid NOT NULL,
 content bytea NOT NULL,
 file_name text NOT NULL,
 mime_type text NOT NULL,
 size_bytes integer NOT NULL,
 uploaded_by_user_id uuid,
 created_at timestamp with time zone NOT NULL DEFAULT now(),
 updated_at timestamp with time zone NOT NULL DEFAULT now(),
 CONSTRAINT employee_draft_photo_tenant_fk FOREIGN KEY(tenant_id) REFERENCES public.tenant(id),
 CONSTRAINT employee_draft_photo_draft_fk FOREIGN KEY(draft_id) REFERENCES public.employee_draft(id) ON DELETE CASCADE,
 CONSTRAINT employee_draft_photo_uploader_fk FOREIGN KEY(uploaded_by_user_id) REFERENCES public.app_user(id),
 CONSTRAINT employee_draft_photo_draft_id_unique UNIQUE(draft_id),
 CONSTRAINT employee_draft_photo_mime CHECK(mime_type IN ('image/png','image/jpeg')),
 CONSTRAINT employee_draft_photo_size CHECK(size_bytes BETWEEN 1 AND 2097152 AND size_bytes=octet_length(content))
);
--> statement-breakpoint
CREATE INDEX employee_draft_photo_tenant_draft_idx ON public.employee_draft_photo(tenant_id,draft_id);
--> statement-breakpoint
ALTER TABLE public.employee_draft_photo ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employee_draft_photo FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.employee_draft_photo FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON public.employee_draft_photo TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY employee_draft_photo_rls ON public.employee_draft_photo FOR ALL TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.employee_draft d
  WHERE d.id=employee_draft_photo.draft_id AND d.tenant_id=employee_draft_photo.tenant_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.employee_draft d
  WHERE d.id=employee_draft_photo.draft_id AND d.tenant_id=employee_draft_photo.tenant_id));
