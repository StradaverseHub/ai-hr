-- 65f466e2 — leave_type gets an explicit ROLE marker, so special treatment stops depending on a code
-- literal the software invented.
--
-- THE DEFECT, MEASURED ON PRODUCTION. core/leave.ts declared EMERGENCY_LEAVE_CODE = 'EMERGENCY' and about
-- a dozen sites compared a tenant's leave-type code against that and other literals ('REPLACEMENT',
-- 'MATERNITY', 'PATERNITY'). This tenant's catalogue does not come from the pack seed: its codes are EL,
-- RL, MTL, PTL. Every one of those comparisons was therefore dead, silently, and three designed behaviours
-- never applied:
--   * the advance-notice EXEMPTION for Emergency Leave (so the type that exists FOR short notice was
--     itself gated by minimum advance notice);
--   * the statutory LOCK on Maternity/Paternity/Emergency (so they could be renamed or altered);
--   * the "Emergency Leave with no balance source" guards.
-- The conversion bug the reporter raised is the same defect in its loudest form.
--
-- WHY A COLUMN AND NOT A LOOKUP TABLE: the question "what IS this type" is an attribute of the row, one
-- value, read on nearly every leave path. A join would be a second thing to keep in step.
--
-- THE BACKFILL DOES NOT GUESS. Two passes, both exact:
--   1. by CODE, against the codes the pack seeds;
--   2. by exact NAME (case-insensitively, trimmed), against the pack's own English names — this is what
--      classifies EL/MTL/PTL/RL on this tenant.
-- Anything still unmatched stays NULL and KEEPS TODAY'S BEHAVIOUR. Deliberately NOT used for inference:
--   * balance_source_type_id (pointing at Annual does not make a type Emergency — Replacement does too);
--   * substring/fuzzy name matching. 'Unpaid Medical Leave' and 'Prolonged Illness (Full Pay)' would both
--     capture 'sick' under a LIKE, and misclassifying a type is worse than leaving it unclassified,
--     because a wrong marker silently changes which statutory rules apply to real applications.
-- Verified against production's 25 rows before writing: exactly 7 classify (ANNUAL, SICK,
-- HOSPITALIZATION by code; Emergency/Maternity/Paternity/Replacement Leave by name) and 18 stay NULL,
-- with no row matching two roles.
--
-- NO application, entitlement, balance or history row is read or written by this migration.

ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS role text;

-- Values are closed. A typo'd marker is a silently-wrong statutory rule, so the database refuses it
-- rather than the reader having to defend against it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_role_check') THEN
    ALTER TABLE leave_type ADD CONSTRAINT leave_type_role_check
      CHECK (role IS NULL OR role IN
        ('annual','sick','hospitalization','maternity','paternity','emergency','replacement'));
  END IF;
END $$;

COMMENT ON COLUMN leave_type.role IS
  '65f466e2 — what this leave type IS, independent of the tenant''s own code/name. NULL means '
  'unclassified, which keeps pre-65f466e2 behaviour. Never infer it from a balance source or a fuzzy name.';

-- Pass 1 — by seeded code.
UPDATE leave_type SET role = c.role
  FROM (VALUES
    ('ANNUAL','annual'),
    ('SICK','sick'),
    ('HOSPITALIZATION','hospitalization'),
    ('MATERNITY','maternity'),
    ('PATERNITY','paternity'),
    ('EMERGENCY','emergency'),
    ('REPLACEMENT','replacement')
  ) AS c(code, role)
 WHERE leave_type.role IS NULL
   AND upper(btrim(leave_type.code)) = c.code;

-- Pass 2 — by the pack's own English name, for tenants whose codes differ (this is the EL/MTL/PTL/RL case).
UPDATE leave_type SET role = n.role
  FROM (VALUES
    ('annual leave','annual'),
    ('sick leave','sick'),
    ('hospitalization leave','hospitalization'),
    ('maternity leave','maternity'),
    ('paternity leave','paternity'),
    ('emergency leave','emergency'),
    ('replacement leave','replacement')
  ) AS n(name, role)
 WHERE leave_type.role IS NULL
   AND lower(btrim(leave_type.name)) = n.name;

-- REPORT, never guess. The release note must be able to say which rows were classified and which were not,
-- and a tenant with two rows claiming one role is a configuration question for a human, not something to
-- resolve silently here.
DO $$
DECLARE classified int; unclassified int; dupes text;
BEGIN
  SELECT count(*) FILTER (WHERE role IS NOT NULL), count(*) FILTER (WHERE role IS NULL)
    INTO classified, unclassified FROM leave_type WHERE archived_at IS NULL;
  RAISE NOTICE '0387 leave_type.role: % classified, % left NULL (unclassified rows keep today''s behaviour)',
    classified, unclassified;

  SELECT string_agg(t, '; ') INTO dupes FROM (
    SELECT tenant_id::text || ' role=' || role || ' x' || count(*)::text AS t
      FROM leave_type WHERE role IS NOT NULL AND archived_at IS NULL
     GROUP BY tenant_id, role HAVING count(*) > 1
  ) d;
  IF dupes IS NOT NULL THEN
    RAISE WARNING '0387 leave_type.role: MORE THAN ONE ROW CLAIMS A ROLE — %. Readers take the lowest id; a human should decide.', dupes;
  END IF;
END $$;
