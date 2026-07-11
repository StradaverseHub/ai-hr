-- R33 f21d6eee — Shared shift library. Shift templates become TENANT-GLOBAL rather than per-company, so one
-- template can be assigned to ANY employee in the tenant (Employee Profile / Roster Management) without being
-- duplicated per company. Three coordinated, idempotent changes:
--
--   1. shift.company_id → NULLABLE. New templates are authored tenant-wide (company_id = NULL). Legacy
--      per-company rows keep their company_id untouched — NO data migration: existing default_shift_id and
--      roster_assignment.shift_id references stay valid and every employee's current shift is unchanged.
--
--   2. RLS write policy: was WITH CHECK app.is_admin_for(company_id) (a per-company admin grant). With
--      company_id now nullable AND the library shared tenant-wide, gate writes on app.is_admin() (any
--      tenant admin grant). Read stays tenant-scoped (USING tenant_id = current_tenant_id()). is_admin_for
--      is unusable against a NULL company_id anyway, so this is the only coherent policy for a shared library.
--      Non-admins still cannot write shifts (is_admin() is false for employee/manager/partners).
--
--   3. Uniqueness: replace the per-(tenant,company) unique indexes shift_company_name_uq /
--      shift_company_code_uq with TENANT-WIDE partial unique indexes on lower(name) / lower(code) among
--      NON-archived rows. Name and code are now unique across the whole tenant (the shared-library
--      guarantee), case-insensitive; archived rows are excluded so archiving frees the name/code for reuse
--      exactly as before.
--
--   DOCUMENTED LIMITATION (deliberate — feedback f21d6eee "what to do about shifts already copied into
--   several companies"): a tenant that duplicated the same shift into several companies under the OLD
--   per-company model may hold cross-company duplicate names/codes. This migration does NOT auto-merge or
--   dedupe them — auto-merge risks repointing existing staff at the wrong pattern; manual cleanup (archive
--   or rename the extra copies) is the sanctioned path. On such a tenant the CREATE UNIQUE INDEX statements
--   below would fail until those duplicates are cleaned up. Fresh installs and the demo/seed carry no shift
--   rows, so they apply cleanly. Going forward the service (core/roster.ts) maps this constraint's violation
--   to a friendly tenant-wide "a shift with this name/code already exists" message.

ALTER TABLE "shift" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint

-- Tenant-admin write policy (replaces the per-company one from 0075).
DROP POLICY IF EXISTS "shift_rls" ON "shift";--> statement-breakpoint
CREATE POLICY "shift_rls" ON "shift" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

-- Deploy-safety backfill (feedback f21d6eee asks what to do about shifts already copied into several
-- companies). An existing tenant may hold cross-company duplicate names/codes from the old per-company model,
-- which would make the tenant-wide unique indexes below FAIL on real data. Disambiguate them NON-DESTRUCTIVELY
-- — rename, never merge or delete: keep the earliest row of each duplicate group unchanged and suffix the rest
-- (" #2" for name, "-2" for code). Every row plus all default_shift_id / roster_assignment.shift_id references
-- survive with distinct labels; HR can rename or archive the extras properly afterwards. Idempotent: on a
-- re-run there are no duplicate groups left, so both UPDATEs touch zero rows.
UPDATE "shift" s SET "name" = s."name" || ' #' || d.rn
  FROM (
    SELECT id, row_number() OVER (PARTITION BY tenant_id, lower(name) ORDER BY created_at, id) AS rn
    FROM "shift" WHERE archived_at IS NULL
  ) d WHERE s.id = d.id AND d.rn > 1;--> statement-breakpoint
UPDATE "shift" s SET "code" = s."code" || '-' || d.rn
  FROM (
    SELECT id, row_number() OVER (PARTITION BY tenant_id, lower(code) ORDER BY created_at, id) AS rn
    FROM "shift" WHERE archived_at IS NULL
  ) d WHERE s.id = d.id AND d.rn > 1;--> statement-breakpoint

-- Tenant-wide, case-insensitive, non-archived partial unique indexes (replace the per-company ones).
DROP INDEX IF EXISTS "shift_company_name_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "shift_company_code_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shift_tenant_name_uq" ON "shift" ("tenant_id", lower("name")) WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shift_tenant_code_uq" ON "shift" ("tenant_id", lower("code")) WHERE "archived_at" IS NULL;
