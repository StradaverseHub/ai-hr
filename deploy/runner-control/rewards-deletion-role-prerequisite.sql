-- Run as the installation DBA on the application database after the Rewards migrations.
BEGIN;

DO $$
BEGIN
  IF (SELECT proowner FROM pg_catalog.pg_proc
      WHERE oid = 'app.reward_deletion_reason(uuid)'::regprocedure)
       IS DISTINCT FROM 'ai_hr_owner'::regrole
     OR (SELECT proowner FROM pg_catalog.pg_proc
         WHERE oid = 'app.reward_setup_allowed(uuid,text)'::regprocedure)
       IS DISTINCT FROM 'ai_hr_reward_setup_reader'::regrole
  THEN
    RAISE EXCEPTION 'Unexpected Rewards function ownership';
  END IF;
END $$;

-- The deletion guard reads Rewards tables whose row policies call this predicate.
GRANT EXECUTE ON FUNCTION app.reward_setup_allowed(uuid,text) TO ai_hr_owner;

COMMIT;
