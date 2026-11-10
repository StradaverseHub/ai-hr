-- UNALLOCATED DRAFT on branch claude/bulkjob-payroll-20261110 (payroll's last long holders, 11 Nov 2026): not a
-- reservation, not an installation allocation. The journal position (idx 9954, when 1793330099954) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md.
--
-- The transaction-local point-read marker (0691; set by the bank import worker and the payroll processing job's
-- units) lets an employment read skip rebuilding the whole visible-employment array, which costs about 9 ms per
-- statement on a 3,000-employee tenant. It short-circuited only for a company administrator, so a payroll partner who
-- is not one still paid the rebuild on every statement of every processing chunk.
--
-- Extended only where the authority proof is equivalent. The original predicate (both arms of the CASE, unchanged
-- below) is `voided_at IS NULL AND tenant_id = current AND (id IN visible ids OR app.can_admin_payroll_for(company_id)
-- OR app.can_admin_perfcomp_for(company_id))`, and the same voided/tenant guards are ANDed outside the CASE. So for a
-- row where app.can_admin_payroll_for(company_id) is true the original predicate is already true: answering true
-- without the array returns exactly the same rows, for any grant. (app.is_admin_for implies it as well; it stays.)
-- Nothing else changes: the marker-off arm, the ELSE arm, WITH CHECK, roles and command; an unset or unrecognised
-- marker still takes the original predicate. The predecessor is checked exactly, as 3001 did.
DO $partner_point_read$
DECLARE
  policy_row record;
  original_qual text;
  rewritten_qual text;
  match_count integer;
  arm_pattern constant text := 'WHEN app\.is_admin_for\(company_id\) THEN true';
  arm_replacement constant text := 'WHEN (app.is_admin_for(company_id) OR app.can_admin_payroll_for(company_id)) THEN true';
  expected_qual constant text := '((voided_atISNULL)AND(tenant_id=app.current_tenant_id())ANDCASEWHEN((SELECTcurrent_setting(''app.bank_import_point_read''::text,true)AScurrent_setting)=''on''::text)THENCASEWHENapp.is_admin_for(company_id)THENtrueELSE((voided_atISNULL)AND((tenant_id=app.current_tenant_id())AND((idIN(SELECTunnest((SELECTapp.visible_employment_ids()ASvisible_employment_ids))ASunnest))ORapp.can_admin_payroll_for(company_id)ORapp.can_admin_perfcomp_for(company_id))))ENDELSE((voided_atISNULL)AND((tenant_id=app.current_tenant_id())AND((idIN(SELECTunnest((SELECTapp.visible_employment_ids()ASvisible_employment_ids))ASunnest))ORapp.can_admin_payroll_for(company_id)ORapp.can_admin_perfcomp_for(company_id))))END)';
BEGIN
  SELECT * INTO policy_row FROM pg_policy WHERE polrelid='public.employment'::regclass AND polname='employment_rls';
  IF NOT FOUND THEN RAISE EXCEPTION 'Employment policy is missing' USING ERRCODE='55000'; END IF;
  original_qual := pg_get_expr(policy_row.polqual,policy_row.polrelid);
  IF policy_row.polcmd <> '*' OR NOT policy_row.polpermissive
    OR policy_row.polroles IS DISTINCT FROM ARRAY[(SELECT oid FROM pg_roles WHERE rolname='ai_hr_app')]
    OR regexp_replace(original_qual,'\s+','','g') IS DISTINCT FROM expected_qual
    OR regexp_replace(pg_get_expr(policy_row.polwithcheck,policy_row.polrelid),'\s+','','g')
      IS DISTINCT FROM '((tenant_id=app.current_tenant_id())ANDapp.is_admin_for(company_id))'
  THEN
    RAISE EXCEPTION 'Employment policy differs from the reviewed predecessor' USING ERRCODE='55000';
  END IF;
  -- The partner arm proves nothing the original predicate does not already contain.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='app.can_admin_payroll_for(uuid)'::regprocedure AND p.provolatile='s' AND NOT p.prosecdef
    AND regexp_replace(p.prosrc,'\s+','','g')='SELECTEXISTS(SELECT1FROMapp.current_grants()gWHEREg.roleIN(''hr_admin'',''super_admin'',''payroll_partner'')AND(g.company_idISNULLORg.company_id=p_companyORapp.is_company_descendant(p_company,g.company_id)))')
  THEN
    RAISE EXCEPTION 'Payroll authority owner differs from the reviewed predecessor' USING ERRCODE='55000';
  END IF;
  SELECT count(*) INTO match_count FROM regexp_matches(original_qual,arm_pattern,'g');
  IF match_count <> 1 THEN RAISE EXCEPTION 'Expected exactly one point-read administrator arm' USING ERRCODE='55000'; END IF;
  rewritten_qual := regexp_replace(original_qual,arm_pattern,arm_replacement);
  EXECUTE format('ALTER POLICY employment_rls ON public.employment USING (%s)',rewritten_qual);
END;
$partner_point_read$;
