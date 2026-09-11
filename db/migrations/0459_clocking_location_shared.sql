-- f9afd1ce — clocking_location becomes a SHARED, TENANT-LEVEL master (ADR-0070, amended 2026-09-11).
--
-- ── WHAT CHANGES AND WHY ─────────────────────────────────────────────────────────────────────────────
-- A clocking location was owned by ONE company (company_id NOT NULL, 0144). Two companies sharing one
-- building therefore kept two records for one gate, and the personnel screen offered an employee only
-- their own company's sites. The approved plan makes a clocking location a shared record: created once,
-- available to every company, with what it holds (name, coordinates, radius, address, remarks) unchanged.
--
-- ── NO DATA STEP, AND WHY THAT IS SAFE ───────────────────────────────────────────────────────────────
-- Measured on production 2026-09-10 (read-only): clocking_location held 0 rows INCLUDING archived, and
-- employee_clocking_location held 0 rows. There is nothing to consolidate and no judgement call about
-- which duplicates are the same place, so this migration carries no data step. The DO block below
-- REPORTS the row count it actually finds at apply time — so if a row appears between now and the
-- deploy, the release log says so and the column drop is the only thing that would have touched it.
--
-- ── EACH STEP, IN THE ORDER POSTGRES REQUIRES ────────────────────────────────────────────────────────
-- 1. DROP POLICY clocking_location_rls — the single FOR ALL policy from 0144, whose WITH CHECK tied the
--    write to the admin of the site's own company. It goes FIRST because its WITH CHECK references
--    company_id: Postgres refuses to drop a column a policy depends on (2BP01), and a CASCADE would hide
--    exactly the dependency this file is about. Two things were wrong with the policy once rows are
--    shared: (a) there is no company_id to judge against, and (b) a FOR ALL policy governs DELETE by
--    USING alone, so the database never restricted who deletes.
-- 2. DROP the FK clocking_location → company. A shared master has no owner company.
-- 3. DROP INDEX clocking_location_company_idx (tenant, company). Nothing scopes by company any more.
-- 4. DROP INDEX clocking_location_name_uq (tenant, company, name). Re-created in step 6 without company.
-- 5. DROP COLUMN company_id. DROPPED, NOT MADE NULLABLE, on purpose: a nullable owner would create two
--    kinds of row (owned / shared) that nobody asked for and every reader would have to branch on.
--    With 0 rows this is free; later it would not be.
-- 6. CREATE UNIQUE INDEX clocking_location_name_uq (tenant_id, name). One name per physical place per
--    tenant is exactly the "one gate, one record" the plan promises. Not partial on archived_at — the
--    0144 index was not either, and an archived site keeping its name reserved is the intended behaviour
--    (restore brings the same record back rather than letting a duplicate be created meanwhile).
-- 7. CREATE four verb policies. READ stays tenant-wide (every tenant member, ADR-0070 §2 — the clock-in
--    screen and name resolution in attendance history depend on it). INSERT, UPDATE and DELETE require
--    app.is_group_admin() (0016: super_admin, or hr_admin with company_id NULL). A shared record may be
--    in use by companies an administrator does not manage, so creating and editing it is a group
--    administrator's job. ASSIGNING a site to an employee is unchanged: employee_clocking_location's
--    policy (can_admin_employment) is untouched and is the guard that matters there.
--
-- Between steps 1 and 7 the table has RLS enabled and NO policy, which in Postgres means no row is
-- visible or writable to the app role — fail closed, not open — and the whole file runs in drizzle's
-- single migration transaction, so no request ever observes that state.
--
-- NOT a CHECK constraint for authority (a NOT VALID check still fires on every UPDATE and would have
-- aborted an unrelated erasure — see what 0405-era verification found). Authority is RLS + the service
-- (core/clocking-location.ts assertGroupAdmin) + the screen (forms rendered for group admins only).
-- No GRANT: nothing is created; the 0144 table grant to ai_hr_app carries over.
--
-- Journal entry: idx 459 (see meta/_journal.json).

DO $$
DECLARE total int; archived int; assigned int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE archived_at IS NOT NULL) INTO total, archived FROM clocking_location;
  SELECT count(*) INTO assigned FROM employee_clocking_location;
  RAISE NOTICE '0459 clocking_location → shared master: % rows found (% archived), % employee assignments. Expected 0 / 0 / 0 (production measured 2026-09-10); no data step — company_id is dropped as-is.',
    total, archived, assigned;
END $$;
--> statement-breakpoint

-- 1. The 0144 FOR ALL policy — first, because it references company_id.
DROP POLICY "clocking_location_rls" ON "clocking_location";--> statement-breakpoint

-- 2. The owner-company FK.
ALTER TABLE "clocking_location" DROP CONSTRAINT "clocking_location_company_id_company_id_fk";--> statement-breakpoint

-- 3 + 4. Both company-keyed indexes.
DROP INDEX "clocking_location_company_idx";--> statement-breakpoint
DROP INDEX "clocking_location_name_uq";--> statement-breakpoint

-- 5. The column itself.
ALTER TABLE "clocking_location" DROP COLUMN "company_id";--> statement-breakpoint

-- 6. One name per place per tenant.
CREATE UNIQUE INDEX "clocking_location_name_uq" ON "clocking_location" USING btree ("tenant_id","name");--> statement-breakpoint

-- 7. Four verb policies: tenant-wide read, group-admin write.
CREATE POLICY "clocking_location_select" ON "clocking_location" FOR SELECT
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY "clocking_location_insert" ON "clocking_location" FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin());--> statement-breakpoint
CREATE POLICY "clocking_location_update" ON "clocking_location" FOR UPDATE
  USING (tenant_id = app.current_tenant_id() AND app.is_group_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin());--> statement-breakpoint
CREATE POLICY "clocking_location_delete" ON "clocking_location" FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND app.is_group_admin());--> statement-breakpoint

COMMENT ON TABLE "clocking_location" IS
  'Shared, tenant-level register of geofenced clocking sites (ADR-0070, amended f9afd1ce 2026-09-11). No owner company: one record per physical place, available to every company in the tenant. READ is tenant-wide (the clock-in screen and attendance history resolve site names under non-admin sessions). INSERT/UPDATE/DELETE require app.is_group_admin(). Assignment to an employee lives on employee_clocking_location and stays with the admin of that employment. location_id is an OPTIONAL link to the holiday-calendar location master and may point at a location of any company.';
