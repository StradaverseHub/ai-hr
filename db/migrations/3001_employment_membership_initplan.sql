-- Hashable positive membership with the SAME statement-local visibility owner.
-- Preserve the scalar InitPlan around the STABLE function: exposing the function
-- directly to unnest also evaluates its population during planning and can
-- trigger costly JIT optimization. No permission/result cache or JIT setting.
-- Only the two positive Employment USING memberships change. WITH CHECK, the
-- bank-import point branch, tenant/void guards and partner authority stay intact.
DO $employment_membership_initplan$
DECLARE
  policy_row record;
  original_qual text;
  rewritten_qual text;
  match_count integer;
  membership_pattern constant text := '\(id\s*=\s*ANY\s*\(\(\s*SELECT\s+app\.visible_employment_ids\(\)\s+AS\s+visible_employment_ids\s*\)::uuid\[\]\)\)';
  membership_replacement constant text := '(id IN (SELECT unnest((SELECT app.visible_employment_ids()))))';
  expected_qual constant text := '((voided_atISNULL)AND(tenant_id=app.current_tenant_id())ANDCASEWHEN((SELECTcurrent_setting(''app.bank_import_point_read''::text,true)AScurrent_setting)=''on''::text)THENCASEWHENapp.is_admin_for(company_id)THENtrueELSE((voided_atISNULL)AND((tenant_id=app.current_tenant_id())AND((id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[]))ORapp.can_admin_payroll_for(company_id)ORapp.can_admin_perfcomp_for(company_id))))ENDELSE((voided_atISNULL)AND((tenant_id=app.current_tenant_id())AND((id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[]))ORapp.can_admin_payroll_for(company_id)ORapp.can_admin_perfcomp_for(company_id))))END)';
BEGIN
  SELECT * INTO policy_row FROM pg_policy
    WHERE polrelid='public.employment'::regclass AND polname='employment_rls';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employment membership policy is missing' USING ERRCODE='55000';
  END IF;
  original_qual := pg_get_expr(policy_row.polqual,policy_row.polrelid);
  IF policy_row.polcmd <> '*' OR NOT policy_row.polpermissive
    OR policy_row.polroles IS DISTINCT FROM ARRAY[(SELECT oid FROM pg_roles WHERE rolname='ai_hr_app')]
    OR regexp_replace(original_qual,'\s+','','g') IS DISTINCT FROM expected_qual
    OR regexp_replace(pg_get_expr(policy_row.polwithcheck,policy_row.polrelid),'\s+','','g')
      IS DISTINCT FROM '((tenant_id=app.current_tenant_id())ANDapp.is_admin_for(company_id))'
  THEN
    RAISE EXCEPTION 'Employment membership policy differs from the reviewed predecessor' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid='app.visible_employment_ids()'::regprocedure
      AND md5(p.prosrc)='1bc7e85a740a98b9db79efb2b7768c8b'
      AND l.lanname='plpgsql' AND p.prosecdef AND p.provolatile='s'
      AND p.proconfig=ARRAY['search_path=public']::text[]
  ) THEN
    RAISE EXCEPTION 'Employment visibility owner differs from the reviewed predecessor' USING ERRCODE='55000';
  END IF;
  SELECT count(*) INTO match_count FROM regexp_matches(original_qual,membership_pattern,'g');
  IF match_count <> 2 THEN
    RAISE EXCEPTION 'Expected exactly two positive employment memberships' USING ERRCODE='55000';
  END IF;
  rewritten_qual := regexp_replace(original_qual,membership_pattern,membership_replacement,'g');
  -- The entire predecessor is guarded above. Replacing its two exact positive
  -- terms avoids reconstructing or simplifying the surrounding authority CASE.
  EXECUTE format('ALTER POLICY employment_rls ON public.employment USING (%s)',rewritten_qual);
END;
$employment_membership_initplan$;
