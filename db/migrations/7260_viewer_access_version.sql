-- ADR 0181 Phase 3, decision 3: the cached viewer menu profile (owner decision 25 November 2026, "access version +
-- 60 s"). The web caches each viewer's menu visibility in process, keyed by this tenant's access version from 7210:
-- every change to roles, access memberships, overrides, groups, grants, the access configuration's initialized flag,
-- the capability catalogue and the company tree increments it in the changing transaction, so a cached menu is
-- recomputed at once after any of them. Facts that also depend on business data are bounded by the cache's time limit.
--
-- access_company_state is owner-only (row security forced, no ai_hr_app privilege). This function returns only the
-- counter of the caller's own tenant, never a row, and 0 before the tenant's first maintenance. It reads no other
-- table and grants nothing: every page, action and service still checks its own authority.
CREATE FUNCTION app.viewer_access_version() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT s.access_version FROM public.access_company_state s WHERE s.tenant_id=app.current_tenant_id()),0::bigint)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.viewer_access_version() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.viewer_access_version() TO ai_hr_app;
