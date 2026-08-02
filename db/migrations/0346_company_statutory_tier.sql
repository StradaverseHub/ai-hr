-- ADR-0077 slice 6 / ADR-0080 D-14 — company existence is DECOUPLED from statutory packs.
--
-- Until now `createCompany` called `requirePackFor(country)` and refused any country with no registered
-- pack. That guard was correct as an interim measure and is recorded as such in core/admin.ts: it closed
-- a real window where LEAVE failed SILENT for a packless company (the engines `continue` past a packless
-- employee, the holiday resolver yields an empty calendar, and the employee accrues nothing with nobody
-- told). But refusing onboarding is the wrong permanent answer, and it has a cost the plan names: a
-- customer with a Thai plant either cannot onboard it at all, or MISFILES Thai staff under the Malaysian
-- company to work around the refusal — which silently applies MY statutory rules to foreign employees.
-- That workaround is worse than the problem.
--
-- The Odoo precedent is the model: l10n modules gate LOCALIZATION, not the existence of res.company.
--
-- TWO TIERS, and a company is in exactly one:
--
--   'statutory'     — a country pack is registered. The statutory engines run: EPF, SOCSO, EIS, PCB,
--                     HRD Corp, the EA form, the gazette holiday calendar.
--   'non_statutory' — DECLARED, never inferred. Attendance and leave run on manually configured
--                     calendars and policies; payroll and every statutory computation are REFUSED for
--                     that company with a stated reason.
--
-- DEFAULT 'statutory' IS THE SAFE BACKFILL. Every existing company is MY, MY has a registered pack, and
-- the tier a pack-backed company should carry is exactly 'statutory' — so this column is byte-identical
-- to today's behaviour for every row that exists. No company can currently be non-statutory, because the
-- guard being retired here is what prevented one from being created.
--
-- THE CHECK CONSTRAINT IS THE POINT, not decoration. `tenant.status` was left as free text and r108 had
-- to handle "a status this code has never seen" as a real, reachable case (the 0275 widening lesson cuts
-- both ways). A tier is a closed two-valued domain owned by this migration, and an unrecognised value
-- here would mean a company that is neither covered by statutory rules nor declared exempt from them —
-- which is precisely the state D-14 exists to make impossible.
--
-- NOT a pgEnum, so widening later stays an ALTER on the constraint rather than a type migration.

ALTER TABLE "company"
  ADD COLUMN IF NOT EXISTS "statutory_tier" text NOT NULL DEFAULT 'statutory';

ALTER TABLE "company"
  DROP CONSTRAINT IF EXISTS "company_statutory_tier_check";

ALTER TABLE "company"
  ADD CONSTRAINT "company_statutory_tier_check"
  CHECK ("statutory_tier" IN ('statutory', 'non_statutory'));

COMMENT ON COLUMN "company"."statutory_tier" IS
  'ADR-0080 D-14. statutory = a country pack is registered and the statutory engines run. '
  'non_statutory = explicitly declared; attendance/leave on manual calendars, payroll and every '
  'statutory computation refused with a reason. Never inferred — see core/company-tier.ts.';
