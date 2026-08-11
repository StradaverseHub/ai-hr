-- 4157a498 — Transactions : Import Payroll History (long-format / seven-column contract).
--
-- Two pieces of master data the reporter's template needs and the system did not have:
--
--   1. payroll_cycle.code — the short code their file carries in the "Payroll Cycle" column ("ME").
--      The cycle catalog (ADR-0069) is name-only today; production's 44 cycles are Monthly / Bonus /
--      Mid-Month / Adjustment / Advance Salary / Off-cycle and NONE is called ME. Adding a code makes
--      "which cycle is ME" the customer's setting rather than our guess. Nullable, because every
--      existing row has none and the importer accepts either the code OR the name.
--
--   2. payroll_import_code — the catalog of DOE codes the importer accepts, and, crucially, WHERE each
--      one's money lands on the folded employee-month (basic / allowance / overtime / bonus / a
--      deduction / one of the statutory figures). Aliases live here too, so a customer whose prior
--      system called employee EPF "KWSP-E" is a data fix, not a code change.
--
-- WHAT THIS TABLE IS *NOT*: it is not the only source of accepted codes. core/payroll-history-import.ts
-- resolves a DOE code against three layers — the built-in statutory codes (STATUTORY_IMPORT_CODES, which
-- every tenant has whether or not this seed ran), the tenant's live pay_component catalog, and finally
-- these rows, which may add, alias or deactivate. That ordering is deliberate: a tenant provisioned after
-- this migration has zero rows here and must still be able to import, so the built-ins are the floor and
-- this table is the override layer. The seed below exists so an admin can SEE and edit the statutory
-- codes, not so the importer can function.
--
-- NO COMPANY CODE COLUMN, and that was a review correction: company.company_label already exists ("short
-- name / abbreviation / internal code", edited as "Company Label" on the company panel) and is already a
-- company lookup key for the leave importer. The payroll-history importer resolves Company Code against
-- it — but hard-errors on an unknown or ambiguous label instead of the leave importer's silent
-- first-writer-wins, because a mis-targeted payroll month is not recoverable.

-- ── 1. payroll_cycle.code ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "payroll_cycle" ADD COLUMN IF NOT EXISTS "code" text;
--> statement-breakpoint

-- One live code per company, case-insensitive — mirroring payroll_cycle_company_name_uq. Partial on
-- code IS NOT NULL as well as archived_at IS NULL: every existing row is NULL and Postgres would treat
-- those as distinct anyway, but stating it keeps the index's intent readable.
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_cycle_company_code_uq"
  ON "payroll_cycle" ("company_id", lower("code"))
  WHERE "archived_at" IS NULL AND "code" IS NOT NULL;
--> statement-breakpoint

-- ── 2. payroll_import_code ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payroll_import_code" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  -- The code as it appears in the DOE Code column. Compared case-insensitively by the importer.
  "code" text NOT NULL,
  "label" text NOT NULL,
  -- WHERE the money lands on the folded employee-month. Constrained in the DB because a typo here would
  -- silently route an employee's EPF into "allowance" and distort both the EA form and the CP39 file.
  -- The full list is PAYROLL_IMPORT_DESTINATIONS in lib/payroll-history-import-schema.ts.
  "destination" text NOT NULL,
  -- Which way the money moves: an earning adds to gross, a deduction is taken off net, an employer
  -- figure is a cost that never touches the employee's cash, and a check line is only cross-checked
  -- against the arithmetic of the other lines (GROSS / NETPAY).
  "direction" text NOT NULL,
  -- An ALIAS row: this code means the same as `alias_for`. Stored as the target CODE rather than an FK
  -- so an alias may point at a built-in statutory code or a pay_component code, neither of which has a
  -- row in this table. Resolution is one hop only — an alias of an alias is refused by the resolver.
  "alias_for" text,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_import_code_destination_ck" CHECK ("destination" IN (
    'basic', 'allowance', 'overtime', 'bonus', 'other_deduction',
    'epf_employee', 'epf_employer', 'socso_employee', 'socso_employer', 'socso_skbbk',
    'eis_employee', 'eis_employer', 'pcb', 'cp38', 'zakat', 'lp', 'hrdf',
    'gross', 'net'
  )),
  CONSTRAINT "payroll_import_code_direction_ck"
    CHECK ("direction" IN ('earning', 'deduction', 'employer', 'check'))
);
--> statement-breakpoint

-- One live row per code per tenant, case-insensitive (mirrors pay_component_code_uq, which is
-- case-sensitive; this one is not, because HR types the DOE code by hand into a spreadsheet).
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_import_code_tenant_code_uq"
  ON "payroll_import_code" ("tenant_id", lower("code"));
--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
-- Explicit and NOT optional: production's ALTER DEFAULT PRIVILEGES masks an omission, so a developer
-- cluster restored from a dump is where "permission denied for table payroll_import_code" would surface
-- — on the first validate of an import, after the deploy. Same reasoning as 0345 / 0354 / 0357 / 0425.
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_import_code" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- Exactly pay_component's shape: tenant-wide READ (the code list is reference data an importer screen
-- shows to any admin who can reach it), admin-only WRITE. The catalog carries no money and no personal
-- data — it is a mapping from a text code to a destination.
ALTER TABLE "payroll_import_code" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "payroll_import_code_rls" ON "payroll_import_code";
--> statement-breakpoint
CREATE POLICY "payroll_import_code_rls" ON "payroll_import_code" FOR ALL
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

-- ── SEED ─────────────────────────────────────────────────────────────────────────────────────────────
-- The ten statutory codes the plan names, following the reporter's own EEEPF example, plus the four the
-- payslip already stores alongside them (SOCSO SKBBK, the TP1/LP relief) and the two cross-check lines.
-- Seeded for EVERY EXISTING TENANT so an admin can see and rename them; a tenant created later gets the
-- same set from STATUTORY_IMPORT_CODES at resolve time without needing a row here.
--
-- ON CONFLICT DO NOTHING against the case-insensitive unique index: re-running this migration, or running
-- it on a tenant that already hand-created one of these codes, leaves the existing row alone.
INSERT INTO "payroll_import_code" ("tenant_id", "code", "label", "destination", "direction")
SELECT t."id", c."code", c."label", c."destination", c."direction"
FROM "tenant" t
CROSS JOIN (VALUES
  ('EEEPF',      'Employee EPF',                 'epf_employee',   'deduction'),
  ('EESOCSO',    'Employee SOCSO',               'socso_employee', 'deduction'),
  ('EEEIS',      'Employee EIS',                 'eis_employee',   'deduction'),
  ('PCB',        'Monthly tax deduction (MTD)',  'pcb',            'deduction'),
  ('CP38',       'CP38 instalment',              'cp38',           'deduction'),
  ('ZAKAT',      'Zakat via salary',             'zakat',          'deduction'),
  ('EREPF',      'Employer EPF',                 'epf_employer',   'employer'),
  ('ERSOCSO',    'Employer SOCSO',               'socso_employer', 'employer'),
  ('EREIS',      'Employer EIS',                 'eis_employer',   'employer'),
  ('HRDF',       'HRD levy',                     'hrdf',           'employer'),
  ('EESOCSOSKBBK','Employee SOCSO (SKBBK)',      'socso_skbbk',    'deduction'),
  ('LP',         'Approved deduction / TP1 (LP)','lp',             'deduction'),
  ('GROSS',      'Gross pay (cross-check only)', 'gross',          'check'),
  ('NETPAY',     'Net pay (cross-check only)',   'net',            'check')
) AS c("code", "label", "destination", "direction")
ON CONFLICT DO NOTHING;
