-- Login artwork is explicitly public. Authentication and employee facts remain in their existing owners.
CREATE TABLE login_presentation (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  presentation jsonb NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT login_presentation_shape CHECK (
    jsonb_typeof(presentation) = 'object'
    AND presentation ?& ARRAY['mediaType','mediaUrl','alt','iconUrl']
    AND presentation->>'mediaType' IN ('none','image','gif','video')
    AND jsonb_typeof(presentation->'mediaUrl') = 'string'
    AND jsonb_typeof(presentation->'alt') = 'string'
    AND length(presentation->>'mediaUrl') <= 2048
    AND length(presentation->>'alt') <= 240
    AND jsonb_typeof(presentation->'iconUrl') = 'string'
    AND length(presentation->>'iconUrl') <= 2048
  )
);
--> statement-breakpoint
ALTER TABLE login_presentation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY login_presentation_read ON login_presentation FOR SELECT
  USING (tenant_id = app.current_tenant_id() AND app.is_group_admin());
--> statement-breakpoint
CREATE POLICY login_presentation_insert ON login_presentation FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin() AND app.principal_snapshot_current());
--> statement-breakpoint
CREATE POLICY login_presentation_update ON login_presentation FOR UPDATE
  USING (tenant_id = app.current_tenant_id() AND app.is_group_admin() AND app.principal_snapshot_current())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin() AND app.principal_snapshot_current());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON login_presentation TO ai_hr_app;
--> statement-breakpoint
-- Only the public presentation fields are projected; no table or identity data can be read through this function.
CREATE FUNCTION app.public_login_presentation(p_tenant uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT jsonb_build_object('mediaType', presentation->>'mediaType', 'mediaUrl', presentation->>'mediaUrl', 'alt', presentation->>'alt', 'iconUrl', presentation->>'iconUrl')
      FROM public.login_presentation WHERE tenant_id = p_tenant $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.public_login_presentation(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.public_login_presentation(uuid) TO ai_hr_app;
