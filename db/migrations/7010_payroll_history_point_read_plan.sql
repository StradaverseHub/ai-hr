-- Reuse the set-based visibility owner for point reads. Keep the existing RLS dependency,
-- owner, grants, path and read semantics, including native replacement and staged custody.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = 'app.payroll_history_effective(uuid)'::regprocedure
      AND proowner = CURRENT_USER::regrole
      AND prosecdef AND provolatile = 's'
      AND md5(prosrc) = '2537e2bd3043497ef2103a9a85a224bf'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = 'app.payroll_history_effective_ids(uuid[])'::regprocedure
      AND proowner = CURRENT_USER::regrole
      AND NOT prosecdef AND provolatile = 's'
      AND md5(prosrc) = '9f768a50eb222bb2b2ab3140d0ee0616'
  ) THEN
    RAISE EXCEPTION 'Unexpected payroll history visibility owner or implementation' USING ERRCODE = '55000';
  END IF;
END
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_effective(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $effective$
  SELECT EXISTS (
    SELECT 1 FROM app.payroll_history_effective_ids(ARRAY[subject])
  );
$effective$;
