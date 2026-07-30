-- r84 · 00659c34 — "Employees on probation will drop out of the 2026 Annual review".
--
-- WHY THIS EXISTS. 0331 retires three employee statuses and remaps every review cycle's stored
-- eligibility rules onto the surviving vocabulary. That remap is faithful, but it cannot invent a status
-- that was never storable: `probation` never appeared in any stored rule, because before 0331 nobody ever
-- displayed as being on probation — the deriver read only the confirmation dates and everybody showed as
-- Active from their first day. That display fault IS 9cbf5e0d's subject.
--
-- So the moment 0331 makes probation a real, derived status, a cycle written as "everyone" silently stops
-- meaning everyone. On production the 2026 Annual cycle carries
--     {"statuses": ["active", "on_leave", "offboarding", "terminated"]}
-- which is all four pre-0331 values, i.e. deliberately everybody. 0331 remaps that to
--     ["active", "active_serving_notice", "resigned"]
-- and 12 of 22 active employments have a probation end date in the future. Without this migration those
-- twelve drop out of their own annual review, and nothing anywhere would have said so.
--
-- THE REPORTER WAS ASKED AND ANSWERED, 2026-07-30: "Please include employees on probation in the 2026
-- Annual Review cycle as well." This applies that answer.
--
-- THE RULE, AND WHY IT IS NOT KEYED TO ONE CYCLE ID. Any cycle that includes `active` is asking for
-- employees who are currently working. Somebody serving probation is currently working. So `active`
-- implies `probation` unless the cycle explicitly says otherwise — and no cycle can have said otherwise,
-- because the value did not exist to be excluded. Keying this to the single production UUID would be
-- narrower but would leave the same trap armed for the next cycle anyone creates from an old template.
--
-- ORDERING. Must run AFTER 0331, which is what supplies the post-remap vocabulary this reads. It is
-- expressed against the NEW values only, so it is a no-op if 0331 has not run (no cycle would contain
-- 'active' in the new sense) rather than a corruption.
--
-- IDEMPOTENT. The NOT-contains guard means re-running adds nothing, and jsonb_agg(DISTINCT …) cannot
-- produce a duplicate even if the guard were removed.
--
-- WHAT IT DOES NOT DO. It does not change anyone's status, their probation dates, or any review content.
-- It changes which employees a cycle SELECTS, and only by adding.

DO $$
DECLARE
  touched int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'review_cycle' AND column_name = 'eligibility_rules'
  ) THEN
    RAISE NOTICE '[0332] review_cycle.eligibility_rules absent — nothing to do.';
    RETURN;
  END IF;

  UPDATE review_cycle rc
  SET eligibility_rules = jsonb_set(
        rc.eligibility_rules,
        '{statuses}',
        (
          SELECT jsonb_agg(DISTINCT v)
          FROM (
            SELECT jsonb_array_elements_text(rc.eligibility_rules -> 'statuses') AS v
            UNION ALL
            SELECT 'probation'
          ) AS merged
        )
      )
  WHERE rc.eligibility_rules IS NOT NULL
    AND jsonb_typeof(rc.eligibility_rules -> 'statuses') = 'array'
    -- Only cycles that ask for currently-working employees. A cycle naming neither `active` nor any
    -- working status is asking for something else entirely and is left alone.
    AND rc.eligibility_rules -> 'statuses' ? 'active'
    -- Already correct, or already fixed by an earlier run.
    AND NOT (rc.eligibility_rules -> 'statuses' ? 'probation');

  GET DIAGNOSTICS touched = ROW_COUNT;
  RAISE NOTICE '[0332] added probation to % review cycle(s).', touched;
END $$;
