-- Statutory data-pack RLS — the enforced trust boundary (ADR-0020 §3).
--
-- These tables are NATIONAL (no tenant_id): every tenant reads the same vendor packs. The trust boundary is
-- "tenants read, only the owner writes". Two facts make the config non-obvious:
--   1. The cluster's DEFAULT PRIVILEGES auto-grant `arwd` (incl. INSERT/UPDATE/DELETE) to ai_hr_app on every
--      new public table (verified: pg_default_acl = {ai_hr_app=arwd/postgres}). So "grant only SELECT" by
--      omission does NOT make a table read-only — an explicit REVOKE is required.
--   2. RLS is ENABLED but NOT FORCEd. ENABLE subjects the non-owner app role (ai_hr_app) to RLS while the
--      table OWNER bypasses it — so `pnpm statutory:sync`, run as the owner role, can ingest, while ai_hr_app
--      cannot write. FORCE would also block the owner (unless superuser), breaking ingest — so we do not FORCE.
-- Net: ai_hr_app may SELECT (USING(true) — national data, never a tenant_id predicate, which would return
-- zero rows and silently kill propagation) and may NOT write (REVOKE + no write policy = belt and braces).

ALTER TABLE statutory_pack ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE statutory_signing_key ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE statutory_pack_sync_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT ON statutory_pack TO ai_hr_app;--> statement-breakpoint
GRANT SELECT ON statutory_signing_key TO ai_hr_app;--> statement-breakpoint
GRANT SELECT ON statutory_pack_sync_log TO ai_hr_app;--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON statutory_pack FROM ai_hr_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON statutory_signing_key FROM ai_hr_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON statutory_pack_sync_log FROM ai_hr_app;--> statement-breakpoint

CREATE POLICY statutory_pack_read ON statutory_pack FOR SELECT USING (true);--> statement-breakpoint
CREATE POLICY statutory_signing_key_read ON statutory_signing_key FOR SELECT USING (true);--> statement-breakpoint
CREATE POLICY statutory_pack_sync_log_read ON statutory_pack_sync_log FOR SELECT USING (true);
