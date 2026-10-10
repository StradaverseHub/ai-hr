-- Preserve immutable version-1 releases; allow bounded declarative version-2 presentation.
ALTER TABLE mobile_design_draft DROP CONSTRAINT mobile_design_draft_config_check,
  ADD CONSTRAINT mobile_design_draft_config_check CHECK (jsonb_typeof(config) = 'object' AND config->>'schemaVersion' IS NOT NULL AND config->>'schemaVersion' IN ('1','2') AND octet_length(config::text) <= 120000);
--> statement-breakpoint
ALTER TABLE mobile_design_release DROP CONSTRAINT mobile_design_release_config_check,
  ADD CONSTRAINT mobile_design_release_config_check CHECK (jsonb_typeof(config) = 'object' AND config->>'schemaVersion' IS NOT NULL AND config->>'schemaVersion' IN ('1','2') AND octet_length(config::text) <= 120000);
