-- Retain the canonical visibility owner and its statement-local scalar InitPlan.
-- A hashable positive membership replaces repeated UUID-array probes. No cache,
-- grant, writer predicate, history rule or database setting changes.
DO $assignment_membership_initplan$
DECLARE
  policy_row record;
  original_qual text;
  rewritten_qual text;
  match_count integer;
  membership_pattern constant text := '\(employment_id\s*=\s*ANY\s*\(\(\s*SELECT\s+app\.visible_employment_ids\(\)\s+AS\s+visible_employment_ids\s*\)::uuid\[\]\)\)';
  expected_qual constant text := '((tenant_id=app.current_tenant_id())AND(employment_id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[])))';
BEGIN
  SELECT * INTO policy_row FROM pg_policy
    WHERE polrelid='public.assignment'::regclass AND polname='assignment_rls';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assignment membership policy is missing' USING ERRCODE='55000';
  END IF;
  original_qual := pg_get_expr(policy_row.polqual,policy_row.polrelid);
  IF policy_row.polcmd <> '*' OR NOT policy_row.polpermissive
    OR policy_row.polroles IS DISTINCT FROM ARRAY[(SELECT oid FROM pg_roles WHERE rolname='ai_hr_app')]
    OR regexp_replace(original_qual,'\s+','','g') IS DISTINCT FROM expected_qual
    OR regexp_replace(pg_get_expr(policy_row.polwithcheck,policy_row.polrelid),'\s+','','g')
      IS DISTINCT FROM '((tenant_id=app.current_tenant_id())ANDapp.can_admin_employment(employment_id))'
  THEN
    RAISE EXCEPTION 'Assignment membership policy differs from the reviewed predecessor' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid='app.visible_employment_ids()'::regprocedure
      AND md5(p.prosrc)='1bc7e85a740a98b9db79efb2b7768c8b'
      AND l.lanname='plpgsql' AND p.prosecdef AND p.provolatile='s'
      AND p.proconfig=ARRAY['search_path=public']::text[]
      AND p.prorettype='uuid[]'::regtype AND NOT p.proretset
      AND NOT p.proisstrict AND NOT p.proleakproof AND p.prokind='f'
      AND p.proparallel='u' AND p.pronargs=0
  ) THEN
    RAISE EXCEPTION 'Assignment visibility owner differs from the reviewed predecessor' USING ERRCODE='55000';
  END IF;
  SELECT count(*) INTO match_count FROM regexp_matches(original_qual,membership_pattern,'g');
  IF match_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one positive Assignment membership' USING ERRCODE='55000';
  END IF;
  rewritten_qual := regexp_replace(original_qual,membership_pattern,
    '(employment_id IN (SELECT unnest((SELECT app.visible_employment_ids()))))','g');
  EXECUTE format('ALTER POLICY assignment_rls ON public.assignment USING (%s)',rewritten_qual);
END;
$assignment_membership_initplan$;
