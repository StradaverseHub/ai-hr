-- AI provider configuration RLS (ADR-0023). This table holds tenant BYOK API keys ENCRYPTED at rest,
-- so the bar is higher than a normal tenant table:
--
--   * FORCE ROW LEVEL SECURITY — the FIRST forced table in this codebase, deliberately. Migrations,
--     seeds, and drizzle studio connect as the table OWNER, which ordinarily BYPASSES RLS; for an
--     encrypted-key table that means an owner connection forgetting a tenant filter could dump every
--     tenant's ciphertext. FORCE makes RLS apply to the owner too (fail-closed when no tenant GUC is
--     set), so the only way to read a row is with app.current_tenant_id() set.
--   * The app role is NEVER granted SELECT on api_key_ciphertext. UI reads see every other column; the
--     ciphertext is obtained ONLY through app.ai_active_provider_config(), a SECURITY DEFINER resolver
--     that returns the single active row for the current tenant. "Write-only key" is thus a privilege
--     fact, not a coding-discipline hope — a stray `select *` in app code cannot return it.
--   * Writes (INSERT/UPDATE/DELETE) are admin-only; reads are tenant-scoped (the resolver must succeed
--     for a non-admin manager generating an AI draft).
--   * At most one active config per tenant (partial-unique index).

ALTER TABLE ai_provider_config ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_provider_config FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Column-scoped grants. This cluster's default privileges hand ai_hr_app a TABLE-WIDE
-- SELECT/INSERT/UPDATE/DELETE on every new table, so a per-column GRANT alone does NOT hide the
-- ciphertext (a table-wide SELECT covers all columns). We must REVOKE the table-level SELECT, then
-- re-grant SELECT only on the non-secret columns. INSERT/UPDATE/DELETE stay (admin-gated by RLS) so the
-- service can store an encrypted key.
REVOKE SELECT ON ai_provider_config FROM ai_hr_app;--> statement-breakpoint
GRANT SELECT (id, tenant_id, provider, model, key_last4, is_active, created_by_user_id, updated_by_user_id, created_at, updated_at) ON ai_provider_config TO ai_hr_app;--> statement-breakpoint
GRANT INSERT, UPDATE, DELETE ON ai_provider_config TO ai_hr_app;--> statement-breakpoint

-- Read: any member of the tenant (the resolver runs for non-admin managers too). The ciphertext is
-- protected by the column grant above, not by this row policy.
CREATE POLICY ai_provider_config_read ON ai_provider_config FOR SELECT
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint

-- Write: admin only. (FOR ALL also covers SELECT, OR-combined with the read policy above → reads stay
-- tenant-scoped; INSERT/UPDATE/DELETE require app.is_admin().)
CREATE POLICY ai_provider_config_write ON ai_provider_config FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

-- At most one active provider per tenant.
CREATE UNIQUE INDEX ai_provider_config_one_active_uq ON ai_provider_config (tenant_id) WHERE is_active;--> statement-breakpoint

-- The ONLY path by which app code obtains the ciphertext. Owner-defined (SECURITY DEFINER) so it can
-- read the withheld column; FORCE RLS still row-scopes it to app.current_tenant_id() (returns nothing
-- when no tenant GUC is set). search_path is pinned to defeat function hijacking.
CREATE OR REPLACE FUNCTION app.ai_active_provider_config()
  RETURNS TABLE(provider text, model text, api_key_ciphertext text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
    SELECT c.provider::text, c.model, c.api_key_ciphertext
    FROM public.ai_provider_config c
    WHERE c.tenant_id = app.current_tenant_id() AND c.is_active
    LIMIT 1
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.ai_active_provider_config() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_active_provider_config() TO ai_hr_app;
