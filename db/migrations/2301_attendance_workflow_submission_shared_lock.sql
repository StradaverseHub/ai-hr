-- Submissions pin workflow configuration without excluding other submissions.
-- Keep the same key and trigger checks, and preserve function ownership and grants.
DO $workflow_submission_lock$
DECLARE
  previous pg_catalog.pg_proc%ROWTYPE;
  definition text;
BEGIN
  SELECT * INTO previous FROM pg_catalog.pg_proc
  WHERE oid = pg_catalog.to_regprocedure('app.attendance_workflow_links()');
  IF NOT FOUND OR pg_catalog.md5(previous.prosrc) IS DISTINCT FROM '4d4757fe139a597cc028772f0effade9'
    OR previous.prosecdef IS DISTINCT FROM true
    OR previous.provolatile <> 'v'
    OR previous.prorettype IS DISTINCT FROM 'trigger'::regtype::oid
    OR previous.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
  THEN
    RAISE EXCEPTION 'Unexpected Attendance workflow links predecessor' USING ERRCODE = '55000';
  END IF;

  definition := pg_catalog.pg_get_functiondef(previous.oid);
  EXECUTE pg_catalog.replace(definition,
    'PERFORM pg_advisory_xact_lock(',
    'PERFORM pg_advisory_xact_lock_shared(');
END;
$workflow_submission_lock$;
