-- df35d60d (r329, STAGE 1) — FORM TP3: THE PREVIOUS-EMPLOYMENT RECORD THE FORM CAN ACTUALLY BE FILLED FROM.
--
-- ── WHY A TABLE AND NOT FOUR MORE COLUMNS ───────────────────────────────────────────────────────────
--
-- `employee_statutory_my` holds five TP3 columns (tp3_year, tp3_net_remuneration, tp3_epf_claimed,
-- tp3_pcb_paid, tp3_zakat_paid) and this migration DOES NOT TOUCH ONE OF THEM. They stay exactly what
-- they are: the PCB accumulator seed core/payroll.ts reads (`tp3Applies = e.tp3Year === pYear`), pinned
-- by the accumulator tests, and on production exactly ONE employee has figures in them. That row keeps
-- working byte-for-byte after this migration, because nothing here reads, writes or reinterprets it.
--
-- What those columns cannot do is render PCB FORM /TP3 (1/2026). `tp3_net_remuneration` is LHDN's
-- accumulated (Y − K) — that is (C1 − ΣC2) − C3 already combined — and the form asks for C1, C2(i)…(v)
-- and C3 as seven separate boxes. The combination is not invertible; no arithmetic recovers seven
-- figures from one. Add to that a Section A that repeats for TWO previous employers and a Section D of
-- seventeen relief categories with lettered sub-lines, and the shape is a table keyed on
-- (person, assessment year), not four more columns on a row that is already 60 wide.
--
-- ── THE RELIEF SCHEDULE IS NOT DUPLICATED, AND THE JSONB SHAPE IS WHY ───────────────────────────────
--
-- `payload.sectionD` is stored in EXACTLY the shape `tp1_relief.categories.items` is stored in, keyed by
-- the SAME item codes (c1…c17) against the SAME pack catalogue, because it is the same seventeen
-- statutory reliefs read for a DIFFERENT employer. One validator reads both payloads, one type describes
-- both, and a limit that moves moves in one place. Three child tables would be a second storage idiom
-- for the identical taxonomy — the competing source of truth CLAUDE.md §1 forbids. The precedent is
-- `employee_statutory_my.child_relief_table` (migration 0250): a JSONB column rather than a child table,
-- inheriting this row's RLS unchanged and landing whole in the domain event's before/after.
--
-- ── GRAIN AND HISTORY ───────────────────────────────────────────────────────────────────────────────
--
-- UNIQUE (tenant_id, person_id, assessment_year): ONE record per person per year, UPDATEd in place,
-- where `tp1_relief` appends a row per correction. A TP1 is a DECLARATION with a status, a submission
-- and an employer consent, so its corrections have to be rows. A TP3 is a RECORD OF FACT about a
-- previous employer that HR keys from a paper form; its history is the before/after of the
-- `employee.tp3form.updated` domain event, which is where every other HR-maintained statutory fact in
-- this schema keeps its history.
--
-- PERSON-KEYED, NOT EMPLOYMENT-KEYED — the precedent tp1_relief (0102), employee_statutory_my (0004) and
-- employee_dependent (0137) set. Employment-keying would orphan the record when that employment ends,
-- which for a form about a PREVIOUS employment is precisely backwards.
--
-- ── NO CHECK CONSTRAINTS ON THE MONEY, DELIBERATELY ─────────────────────────────────────────────────
--
-- The annual limits are statutory numbers that live in the country pack (localization/my/statutory-tables
-- MY_TP1_2026_ITEMS) and they are enforced in `core/tp3.ts`, the one service that decides a save. A CHECK
-- here would freeze a 2026 limit into the schema, where changing it next year needs a migration and a
-- backfill of rows that were correct when they were written. CLAUDE.md §6: enforce how a row is decided
-- in the service that decides it.
--
-- `deduction_month` carries a range CHECK and money does not, and that is not inconsistent: 1–12 is a
-- property of the Gregorian calendar, not of a tax year, and it can never need a backfill.
--
-- ── GRANT ───────────────────────────────────────────────────────────────────────────────────────────
--
-- The GRANT looks redundant and is not: production's ALTER DEFAULT PRIVILEGES (deploy/bootstrap-db.sql)
-- hands ai_hr_app full CRUD on every owner-created table, so an omission is invisible on every cluster
-- bootstrapped that way AND on the suite (which connects as the owner), and surfaces as "permission
-- denied" only on a RESTORED developer cluster, after the deploy. Same reasoning as 0345 / 0354 / 0452.
--
-- DELETE is granted: unlike a measurement ledger, a TP3 record keyed against the wrong person or the
-- wrong year is a data-entry mistake with no statutory meaning, and tenant erasure has to be able to
-- remove it.
--
-- ── RLS ─────────────────────────────────────────────────────────────────────────────────────────────
--
-- Mirrors `employee_dependent_rls` (0137), the person-keyed admin-write precedent:
--   read  = app.can_see_person(person_id)  → the employee can read their OWN TP3 record, and so can an
--           admin scoped to them. This row carries the employee's previous employers and their reliefs;
--           a tenant-wide read would let any employee enumerate their colleagues' tax affairs.
--   write = app.is_admin()                 → HR maintains it from the paper form the employee hands in.
--           (app.can_admin_employment is for EMPLOYMENT-keyed tables per 0016; this is person-keyed.)
-- ai_hr_app is NOSUPERUSER / NOBYPASSRLS, so a missing policy fails CLOSED (ADR-0002).
--
-- NO BACKFILL. Every existing tp3_* figure stays where it is and means what it meant; this table starts
-- empty, and a person with no row has no TP3 form — which is the truth, not a gap.
--
-- Rollback:
--   DROP TABLE employee_tp3;
--
-- Journal entry: idx 480.

CREATE TABLE IF NOT EXISTS "employee_tp3" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "person_id" uuid NOT NULL REFERENCES "person"("id"),

  -- The form's DEDUCTION YEAR.
  "assessment_year" integer NOT NULL,
  -- The form's DEDUCTION MONTH box. NULL is "the employee left it blank", NOT January.
  "deduction_month" smallint,

  -- SECTION A — [{ name, tin }], in the form's own order (A1/A2 then A3/A4). The COUNT the printed form
  -- is ruled for is the pack's `tp3Catalogue.maxEmployers`, enforced in core/tp3.ts, not here: it is a
  -- property of a jurisdiction's form, and a second jurisdiction would need a different number.
  "previous_employers" jsonb,

  -- SECTIONS C and D. { form: 'tp3-2026', sectionC: {...}, sectionD: {...} } — sectionD in the exact
  -- shape tp1_relief.categories.items uses, keyed by the same catalogue codes.
  "payload" jsonb,

  -- SECTION E — when the employee confirmed the declaration. A timestamp, not a tick.
  "declared_at" timestamptz,
  -- HR's own note. Never printed: the agency's form has no box for it.
  "remarks" text,

  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "employee_tp3_deduction_month_ck"
    CHECK ("deduction_month" IS NULL OR ("deduction_month" BETWEEN 1 AND 12))
);
--> statement-breakpoint

-- THE GRAIN, enforced by the database rather than by the service remembering to check.
CREATE UNIQUE INDEX IF NOT EXISTS "employee_tp3_person_year_uq"
  ON "employee_tp3" USING btree ("tenant_id", "person_id", "assessment_year");
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_tp3" TO ai_hr_app;
--> statement-breakpoint

ALTER TABLE "employee_tp3" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "employee_tp3_rls" ON "employee_tp3";
--> statement-breakpoint
CREATE POLICY "employee_tp3_rls" ON "employee_tp3" FOR ALL
  USING ("tenant_id" = app.current_tenant_id() AND app.can_see_person("person_id"))
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND app.is_admin());
