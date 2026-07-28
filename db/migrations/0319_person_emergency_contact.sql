-- Feedback 23ad620e — Personnel (Admin) > Profile > Emergency Contact: an employee may need a spouse AND a
-- parent AND a guardian on file, but the emergency contact lives in FIVE FLAT COLUMNS on `person`
-- (emergency_contact_name / _relationship / _phone / _phone2 / _address), so only ONE can ever be recorded.
-- This gives the emergency contact its own register, keyed per person, with a priority so HR knows who to
-- try first.
--
-- KEYING: person_id, mirroring employee_dependent (0137). An emergency contact is a PERSON fact — keying it
-- on one employment would orphan it on termination and hide it from a second company's admin.
--
-- PRIORITY: 'primary' | 'secondary' | 'other' (the values the request enumerates), NOT a free integer.
-- "Only one Primary per employee" is therefore expressible as a partial UNIQUE index — the DB-level backstop
-- that makes a concurrent double-primary structurally impossible. The service demotes the previous primary
-- to 'secondary' in the same transaction (the request's rule 4), so the index never trips on the happy path.
--
-- RLS: USING app.can_see_person (self + admin + manager-chain read, the employee_dependent precedent) and
-- WITH CHECK (app.is_admin() OR app.is_self_person(person_id)) — DELIBERATELY the person_rls write check
-- (0099), not employee_dependent's admin-only one. The emergency contact is self-maintained on /me today
-- (app/me/actions.ts writes the person columns under person_rls); routing that form at this table must not
-- silently take the privilege away. This grants exactly what the columns it replaces already granted.
--
-- BACKFILL: every person carrying any emergency-contact value gets ONE 'primary' row. Nobody re-enters what
-- is already there. The five person.emergency_contact_* columns are deliberately LEFT IN PLACE (not dropped)
-- so this migration is reversible without data loss; core/emergency-contacts.ts is the only writer from here
-- on and core/read.ts + core/profile.ts read the primary row instead of the columns.
--
-- Rollback:
--   DROP TABLE person_emergency_contact;   -- the person.emergency_contact_* columns still hold the pre-r74
--                                          -- primary contact; only post-migration edits are lost.
CREATE TABLE person_emergency_contact (
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
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX person_emergency_contact_person_idx ON person_emergency_contact (tenant_id, person_id);--> statement-breakpoint

-- One Primary per person. Archived rows never block a new primary.
CREATE UNIQUE INDEX person_emergency_contact_one_primary_uq ON person_emergency_contact (tenant_id, person_id)
  WHERE priority = 'primary' AND archived_at IS NULL;--> statement-breakpoint

ALTER TABLE person_emergency_contact ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON person_emergency_contact TO ai_hr_app;--> statement-breakpoint
CREATE POLICY person_emergency_contact_rls ON person_emergency_contact FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_person(person_id))
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.is_admin() OR app.is_self_person(person_id))
  );--> statement-breakpoint

-- Carry the existing single contact in as the primary. A person with nothing recorded gets no row (an empty
-- register, not a blank contact). full_name is NOT NULL, so a person who only ever had a phone number keeps
-- it under an explicit placeholder name rather than being dropped on the floor.
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
               NULLIF(btrim(p.emergency_contact_address), '')) IS NOT NULL;
