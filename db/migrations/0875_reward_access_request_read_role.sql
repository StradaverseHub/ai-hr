-- 0681's reward_access_request_read policy had no role clause, so it also applied to the table owner.
-- reward_access_request_authorised is SECURITY DEFINER (runs as the owner) and reads this FORCE RLS
-- table, so on an installation whose owner is not a superuser the policy re-entered the function until
-- PostgreSQL refused (54001 stack depth). Superuser-owned CI databases bypass RLS and never saw it.
-- Scope the read policy to the application role, as later policies do; the condition is unchanged.
-- Owner-run definers keep only reward_access_request_owner (acting_as_owner) and filter by tenant.
DROP POLICY reward_access_request_read ON reward_access_request;
--> statement-breakpoint
CREATE POLICY reward_access_request_read ON reward_access_request FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.reward_access_request_authorised(id));
