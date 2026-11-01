-- Immutable normalized artwork. Existing design snapshots store only bounded tenant-owned ids.
CREATE TABLE mobile_design_asset (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 content bytea NOT NULL,
 sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 240000 AND size_bytes = octet_length(content)),
 uploaded_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (substring(content from 1 for 2) = decode('ffd8','hex') AND substring(content from octet_length(content)-1 for 2) = decode('ffd9','hex'))
);--> statement-breakpoint
CREATE UNIQUE INDEX mobile_design_asset_tenant_sha_unique ON mobile_design_asset(tenant_id,sha256);--> statement-breakpoint
ALTER TABLE mobile_design_asset ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON mobile_design_asset FROM ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON mobile_design_asset TO ai_hr_app;--> statement-breakpoint
CREATE POLICY mobile_design_asset_read ON mobile_design_asset FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND (app.is_group_admin() OR EXISTS (
  SELECT 1 FROM mobile_design_release r WHERE r.tenant_id = mobile_design_asset.tenant_id
   AND (r.config->'backgrounds'->>'light' = mobile_design_asset.id::text OR r.config->'backgrounds'->>'dark' = mobile_design_asset.id::text)
 )));--> statement-breakpoint
CREATE POLICY mobile_design_asset_upload ON mobile_design_asset FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin() AND uploaded_by = app.current_user_id());
