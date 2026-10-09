-- Tenant presentation, not HR policy. Drafts are admin-private; releases are immutable and readable only within their tenant.
CREATE TABLE mobile_design_draft (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND config->>'schemaVersion' = '1' AND octet_length(config::text) <= 60000),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE mobile_design_release (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  revision integer NOT NULL CHECK (revision > 0),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND config->>'schemaVersion' = '1' AND octet_length(config::text) <= 60000),
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, revision)
);--> statement-breakpoint
ALTER TABLE mobile_design_draft ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE mobile_design_release ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON mobile_design_draft, mobile_design_release FROM ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON mobile_design_draft TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON mobile_design_release TO ai_hr_app;--> statement-breakpoint
CREATE POLICY mobile_design_draft_admin ON mobile_design_draft FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_group_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin() AND (updated_by IS NULL OR updated_by = app.current_user_id()));--> statement-breakpoint
CREATE POLICY mobile_design_release_read ON mobile_design_release FOR SELECT
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY mobile_design_release_publish ON mobile_design_release FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin() AND published_by = app.current_user_id());

--> statement-breakpoint
CREATE FUNCTION app.stamp_mobile_design_time() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'mobile_design_draft' THEN NEW.updated_at := now();
  ELSE NEW.published_at := now(); END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER mobile_design_draft_stamp BEFORE INSERT OR UPDATE ON mobile_design_draft
  FOR EACH ROW EXECUTE FUNCTION app.stamp_mobile_design_time();--> statement-breakpoint
CREATE TRIGGER mobile_design_release_stamp BEFORE INSERT ON mobile_design_release
  FOR EACH ROW EXECUTE FUNCTION app.stamp_mobile_design_time();
