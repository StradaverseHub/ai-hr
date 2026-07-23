-- Feedback a949184a — Personnel (Admin) Qualification tab: a per-EMPLOYMENT register of an employee's
-- academic / professional qualification history (level, study period, institute, major, graduation date,
-- result, single Highest Qualification flag).
--
-- KEYING: employment_id (per the approved plan). Unlike employee_dependent (person-keyed), a qualification
-- record is maintained on the Personnel (Admin) employee profile, which is employment-keyed; the record
-- follows that profile.
--
-- SINGLE-HIGHEST RULE: at most ONE live (non-archived) record per employment may carry is_highest. The
-- service transfers the flag transactionally (clears the previous holder in the same tx); this partial
-- UNIQUE index is the DB-level backstop that makes a concurrent double-highest structurally impossible.
--
-- RLS (decision, not copy-paste): mirror employee_cp38 (0117) — the employment-keyed admin-write precedent.
-- USING app.can_see_employment grants SELF + manager-chain + admin read (an employee may see their own
-- qualification history; it discloses nothing sensitive beyond what HR keyed for them); WITH CHECK
-- app.is_admin() keeps WRITES admin-only (HR maintains; employees do NOT self-edit in this version).
--
-- The table-level GRANT to ai_hr_app is explicit (new tables don't inherit prior GRANTs); the app role is
-- NOSUPERUSER/NOBYPASSRLS, so a missing policy fails CLOSED (ADR-0002).
--
-- Rollback:
--   DROP TABLE employee_qualification;
CREATE TABLE employee_qualification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  employment_id uuid NOT NULL REFERENCES employment(id),
  qualification text NOT NULL,
  description text,
  from_ym text,
  to_ym text,
  institute text,
  major text,
  graduation_date date,
  result text,
  is_highest boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX employee_qualification_employment_idx ON employee_qualification (tenant_id, employment_id);--> statement-breakpoint

-- The single-highest backstop: one live highest per employment (archived rows never block a new highest).
CREATE UNIQUE INDEX employee_qualification_one_highest_uq ON employee_qualification (tenant_id, employment_id)
  WHERE is_highest AND archived_at IS NULL;--> statement-breakpoint

ALTER TABLE employee_qualification ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_qualification TO ai_hr_app;--> statement-breakpoint
CREATE POLICY employee_qualification_rls ON employee_qualification FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

-- Qualification dropdown catalog — new profile_option category 'qualificationLevel', centrally maintainable
-- under System Settings > System Labels > Profile Options (the 0300_person_salutation / 0305 dependent-
-- relationship top-up pattern). Seed for EVERY existing tenant, kept BYTE-IDENTICAL with
-- QUALIFICATION_LEVEL_DEFAULTS in core/qualifications.ts (this category post-dates the 0180 seed, so its
-- seed site is here). IDEMPOTENT + NON-DESTRUCTIVE via ON CONFLICT DO NOTHING: never deletes, renames, or
-- reactivates rows an admin curated. New tenants are seeded by core/profile-options.ts::seedProfileOptions.
INSERT INTO "profile_option" ("tenant_id", "category", "value", "label", "sort_order")
SELECT t.id, d.category, d.value, d.value, d.sort_order
FROM "tenant" t
CROSS JOIN (VALUES
  ('qualificationLevel', 'SPM', 0),
  ('qualificationLevel', 'STPM', 1),
  ('qualificationLevel', 'Certificate', 2),
  ('qualificationLevel', 'Diploma', 3),
  ('qualificationLevel', 'Advanced Diploma', 4),
  ('qualificationLevel', 'Bachelor', 5),
  ('qualificationLevel', 'Master', 6),
  ('qualificationLevel', 'Doctorate', 7),
  ('qualificationLevel', 'Professional Certification', 8)
) AS d(category, value, sort_order)
ON CONFLICT ("tenant_id", "category", "value") DO NOTHING;
