-- UNALLOCATED DRAFT on branch claude/bulkjob-movement-20261110 (movement import catalogue speed): not a reservation,
-- not an installation allocation. The journal position (idx 9911, when 1793330099911) exists only so this branch's
-- schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the freshly
-- verified ledger, per docs/MIGRATION-ALLOCATION.md.
--
-- Set-wise variant of app.access_workforce_employment(uuid,text) for readers that list every employment the actor
-- may see (the movement import's manager catalogue). The per-row predicate evaluates
-- app.access_workforce_company(e.company_id,capability) once per employment (about 1 ms each: 3.5 s for 3,140
-- employments, read about seven times per employee commit under the exclusive Access lock). That company check
-- depends only on the company and the session, so here it runs once per distinct company of the tenant's
-- employments; every per-employment condition of the per-row owner is kept as written: tenant, not voided, and
-- import visibility (released, or the session's own staged attempt). The result is exactly
--   { e.id | app.access_workforce_employment(e.id,capability) }.
-- test/workforce-employment-access-set.test.ts pins the per-row owner's installed body and proves set equality
-- for each actor shape; a change to the per-row owner must change this function in the same migration.
CREATE FUNCTION app.access_workforce_employment_ids(p_capability text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 -- Both CTEs are MATERIALIZED fences: without them the planner pushes the company check below the DISTINCT and
 -- evaluates it per employment again.
 WITH companies AS MATERIALIZED (SELECT DISTINCT e.company_id FROM public.employment e WHERE e.tenant_id=app.current_tenant_id()),
 permitted AS MATERIALIZED (SELECT c.company_id FROM companies c WHERE app.access_workforce_company(c.company_id,p_capability))
 SELECT e.id FROM public.employment e
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
  AND (app.import_marker_visible(e.import_pending_attempt_id) OR e.import_pending_attempt_id::text=current_setting('app.import_attempt',true))
  AND e.company_id IN (SELECT p.company_id FROM permitted p);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_employment_ids(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_employment_ids(text) TO ai_hr_app;
