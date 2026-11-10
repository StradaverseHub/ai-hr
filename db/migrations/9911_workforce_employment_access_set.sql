-- UNALLOCATED DRAFT on branch claude/bulkjob-movement-20261110 (movement import catalogue speed): not a reservation,
-- not an installation allocation. The journal position (idx 9911, when 1793330099911) exists only so this branch's
-- schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the freshly
-- verified ledger, per docs/MIGRATION-ALLOCATION.md.
--
-- Set-wise form of app.access_workforce_employment(uuid,text) for readers that scan every employment the actor may
-- see (the movement import's manager catalogue). The per-row owner evaluates
-- app.access_workforce_company(e.company_id,capability) once per employment (about 1 ms each: 3.5 s for 3,140
-- employments, read about seven times per employee commit under the exclusive Access lock). That company check
-- depends only on the company and the session, so:
--  * app.access_workforce_permitted_companies(capability) runs it once per distinct company of the tenant's
--    employments (definer, as the owner reads);
--  * app.access_workforce_employment_permitted(...) keeps every per-employment condition of the owner as written
--    (tenant, not voided, import visibility: released, or the session's own staged attempt) over the reader's row
--    and checks the company against that set. It stays a definer (the release table and its visibility helper are
--    not the app role's) but no longer runs the company check per row. It is a filter on the reader's own
--    employment scan with the company set as an InitPlan, so the plan keeps the per-row owner's shape whatever the
--    table statistics (no join on a set).
-- For every employment row e of the reader's statement:
--   app.access_workforce_employment(e.id,c)
--   = app.access_workforce_employment_permitted(e.tenant_id,e.company_id,e.voided_at,e.import_pending_attempt_id,
--                                               app.access_workforce_permitted_companies(c)).
-- test/workforce-employment-access-set.test.ts pins the per-row owner's installed body and proves equality for each
-- actor shape; a change to the per-row owner must change these functions in the same migration.
CREATE FUNCTION app.access_workforce_permitted_companies(p_capability text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 -- MATERIALIZED: the company check must run on the distinct companies, never be pushed down to every employment.
 WITH companies AS MATERIALIZED (SELECT DISTINCT e.company_id FROM public.employment e WHERE e.tenant_id=app.current_tenant_id())
 SELECT coalesce(array_agg(c.company_id ORDER BY c.company_id),'{}'::uuid[]) FROM companies c
 WHERE app.access_workforce_company(c.company_id,p_capability);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_permitted_companies(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_permitted_companies(text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.access_workforce_employment_permitted(p_tenant uuid,p_company uuid,p_voided_at timestamptz,p_marker uuid,p_permitted uuid[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND p_voided_at IS NULL
  AND (app.import_marker_visible(p_marker) OR p_marker::text=current_setting('app.import_attempt',true))
  AND p_company=ANY(p_permitted);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_employment_permitted(uuid,uuid,timestamptz,uuid,uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_employment_permitted(uuid,uuid,timestamptz,uuid,uuid[]) TO ai_hr_app;
