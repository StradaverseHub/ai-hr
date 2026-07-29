-- Feedback 23ad620e (round r76, RE-BUILD) — Personnel (Admin) > Profile > Emergency Contact becomes a
-- REGISTER instead of a single form.
--
-- WHY
-- ---
-- The emergency contact lived in FIVE FLAT COLUMNS on `person` (emergency_contact_name / _relationship /
-- _phone / _phone2 / _address), so exactly ONE contact could ever be recorded. An employee who needs a
-- spouse AND a parent on file had nowhere to put the second, and when HR could not reach the first there
-- was nobody to try. This gives the emergency contact its own per-person register with a priority.
--
-- WHY THE COLUMNS ARE DROPPED HERE, NOT LEFT BEHIND
-- ------------------------------------------------
-- An earlier attempt at this item (never merged) created the register but LEFT the five person columns in
-- place "for reversibility". The reporter refuted that build: two writable homes for the same fact is worse
-- than the one place they started with, and a column that is still readable but no longer written is a trap
-- for the next reader — the profile card and /me would each be one careless `select` away from showing a
-- stale contact that HR believes they updated. So the columns are carried across and then DROPPED, in this
-- one transaction: after this migration there is exactly ONE home for an emergency contact.
--
-- KEYING: person_id, mirroring employee_dependent (0137). An emergency contact is a PERSON fact — keying it
-- on one employment would orphan it on termination and hide it from a second company's admin.
--
-- PRIORITY: 'primary' | 'secondary' | 'other' (the values the request enumerates), NOT a free integer, and
-- constrained by name (person_emergency_contact_priority_ck) so a typo cannot reach the column. "Only one
-- Primary per employee" is then expressible as a partial UNIQUE index — the DB-level backstop that makes a
-- concurrent double-primary structurally impossible. core/emergency-contacts.ts demotes the previous primary
-- to 'secondary' in the same transaction (the request's rule 4), so the index never trips on the happy path.
--
-- RLS: USING app.can_see_person (self + admin + manager-chain read, the employee_dependent precedent) and
-- WITH CHECK (app.is_admin() OR app.is_self_person(person_id)) — DELIBERATELY the person_rls write check
-- (0099), not employee_dependent's admin-only one. The emergency contact is self-maintained on /me today
-- (app/me/actions.ts wrote the person columns under person_rls); routing that form at this table must not
-- silently take the privilege away. This grants exactly what the columns it replaces already granted.
-- ENABLEd, not FORCEd: ai_hr_owner must keep writing it (migrations, provisioning, the test harness) — the
-- boundary being defended is ai_hr_app, per the 0313 header.
--
-- CARRY-OVER + IDEMPOTENCE
-- ------------------------
-- Every person carrying any emergency-contact value gets ONE 'primary' row, so nobody re-enters what is
-- already recorded and anyone who has a contact today finds it as the FIRST entry of the new list.
-- The whole file is re-runnable:
--   * CREATE TABLE / CREATE INDEX use IF NOT EXISTS; the policy is DROP ... IF EXISTS then CREATE.
--   * the carry-over is wrapped in a DO block that first checks pg_attribute for the source column, so once
--     the columns are dropped the step becomes a no-op instead of a parse error;
--   * and inside it, `WHERE NOT EXISTS (SELECT 1 FROM person_emergency_contact ec WHERE ec.person_id = p.id)`
--     is what makes a duplicate first entry impossible — a person who already has ANY register row (carried
--     over, or added by hand since) is skipped entirely rather than given a second copy of their old value.
--     The partial unique index would also refuse a second live 'primary', but that would ABORT the migration;
--     the NOT EXISTS guard is what makes a re-run quietly correct rather than merely loud.
--
-- ROLLBACK: not reversible by DDL — the five person columns are gone and the register is the only copy.
--   To go back, re-add the columns and copy the highest-priority live row back into them:
--     ALTER TABLE person ADD COLUMN emergency_contact_name text, …;
--     UPDATE person p SET emergency_contact_name = ec.full_name, … FROM person_emergency_contact ec
--       WHERE ec.person_id = p.id AND ec.archived_at IS NULL AND ec.priority = 'primary';
--   Contacts beyond the first cannot be represented by the old shape and would be lost — which is the point
--   of the feature.

CREATE TABLE IF NOT EXISTS person_emergency_contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  person_id uuid NOT NULL REFERENCES person(id),
  full_name text NOT NULL,
  relationship text,
  mobile_phone text,
  home_phone text,
  address text,
  remarks text,
  priority text NOT NULL DEFAULT 'other',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_emergency_contact_priority_ck CHECK (priority IN ('primary', 'secondary', 'other'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS person_emergency_contact_person_idx
  ON person_emergency_contact (tenant_id, person_id);--> statement-breakpoint

-- One Primary per person. Archived rows never block a new primary.
CREATE UNIQUE INDEX IF NOT EXISTS person_emergency_contact_one_primary_uq
  ON person_emergency_contact (tenant_id, person_id)
  WHERE priority = 'primary' AND archived_at IS NULL;--> statement-breakpoint

ALTER TABLE person_emergency_contact ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON person_emergency_contact TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS person_emergency_contact_rls ON person_emergency_contact;--> statement-breakpoint
CREATE POLICY person_emergency_contact_rls ON person_emergency_contact FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_person(person_id))
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.is_admin() OR app.is_self_person(person_id))
  );--> statement-breakpoint

-- Carry the existing single contact in as the primary. A person with nothing recorded gets no row (an empty
-- register, not a blank contact). full_name is NOT NULL, so a person who only ever had a phone number keeps
-- it under an explicit placeholder name rather than being dropped on the floor.
--
-- The pg_attribute guard makes this a no-op on a re-run (the columns are dropped below). On a fresh database
-- built from 0000 the columns DO still exist at this point and `person` is empty, so the INSERT selects
-- nothing — same outcome, reached honestly.
DO $mig0322$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'person'::regclass
      AND attname = 'emergency_contact_name'
      AND NOT attisdropped
  ) THEN
    EXECUTE $sql$
      INSERT INTO person_emergency_contact
        (tenant_id, person_id, full_name, relationship, mobile_phone, home_phone, address, priority)
      SELECT
        p.tenant_id,
        p.id,
        COALESCE(NULLIF(btrim(p.emergency_contact_name), ''), 'Emergency contact'),
        NULLIF(btrim(p.emergency_contact_relationship), ''),
        NULLIF(btrim(p.emergency_contact_phone), ''),
        NULLIF(btrim(p.emergency_contact_phone2), ''),
        NULLIF(btrim(p.emergency_contact_address), ''),
        'primary'
      FROM person p
      WHERE COALESCE(NULLIF(btrim(p.emergency_contact_name), ''),
                     NULLIF(btrim(p.emergency_contact_relationship), ''),
                     NULLIF(btrim(p.emergency_contact_phone), ''),
                     NULLIF(btrim(p.emergency_contact_phone2), ''),
                     NULLIF(btrim(p.emergency_contact_address), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM person_emergency_contact ec WHERE ec.person_id = p.id
        )
    $sql$;
  END IF;
END
$mig0322$;--> statement-breakpoint

-- The old single home is now gone: person_emergency_contact is the only place an emergency contact lives.
-- Runs AFTER the carry-over above, in the same transaction, so a failed carry-over takes the DROP with it.
ALTER TABLE person
  DROP COLUMN IF EXISTS emergency_contact_name,
  DROP COLUMN IF EXISTS emergency_contact_relationship,
  DROP COLUMN IF EXISTS emergency_contact_phone,
  DROP COLUMN IF EXISTS emergency_contact_phone2,
  DROP COLUMN IF EXISTS emergency_contact_address;
