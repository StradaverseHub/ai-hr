-- Locked income-tax recalculation opening at production scale (measured 24 November 2026).
-- Opening a recalculation batch recomputes one digest of the company-year's source rows under the exclusive
-- payroll-history and Access locks, and every payroll page waits behind those locks. On production that digest took
-- 18 to 37 s per company (the worker logs "Tax-basis batch opening held the payroll-history lock"), while the same
-- query took 20 ms without row security. Cause (focused diagnostic run 45320620220): for each payroll_tax_basis_revision
-- row the planner checks the permissive policy tax_basis_payroll_source_read first, an EXISTS over the employee's
-- payslips that runs the whole payslip policy stack on each of them, before the admin policy that already admits it.
--
-- The opening has already required, in the same transaction, the current principal, payroll administration of the
-- company and the Income Tax recalculation permission. With those, the reader's row security on the six relations the
-- digest reads reduces to (policies as of this migration, guarded below):
--   payroll_batch                   company C, tenant, not hidden by another open history stage
--                                   (payroll_batch_rls via app.can_admin_payroll_for(C); current_human_read is true)
--   payslip                         its batch above, tenant, not hidden, effective or self-issued
--                                   (payslip_original_employer_read admits every payslip of a C batch for a tax-basis
--                                   viewer; the two reader guards are true for a correction-aware reader)
--   payroll_tax_basis_revision      company C, tenant (tax_basis_admin_read)
--   payroll_history_import_record   company C, tenant, not hidden (payroll_history_record_read)
--   payroll_history_import_snapshot / _revision  their record above, tenant, not hidden
-- This function computes exactly that set once, set-wise (the effective rule through app.payroll_history_effective_ids
-- as in 5129), and returns the same md5 of the same tokens the row-security query produced, so a preview prepared
-- before this migration still matches after it. It refuses unless every precondition above holds.
DO $policy_guard$
DECLARE actual text;
BEGIN
 SELECT string_agg(format('%s.%s.%s',tablename,policyname,permissive),',' ORDER BY tablename,policyname) INTO actual
 FROM pg_policies WHERE schemaname='public' AND cmd IN ('SELECT','ALL') AND tablename IN
  ('payroll_batch','payslip','payroll_tax_basis_revision','payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision');
 IF actual IS DISTINCT FROM concat_ws(',',
  'payroll_batch.overtime_batch_context_owner_read.PERMISSIVE','payroll_batch.payroll_batch_current_human_read.RESTRICTIVE',
  'payroll_batch.payroll_batch_history_stage.RESTRICTIVE','payroll_batch.payroll_batch_rls.PERMISSIVE',
  'payroll_batch.retired_attendance_formula_guard_owner_read.PERMISSIVE',
  'payroll_history_import_record.payroll_history_import_record_history_stage.RESTRICTIVE','payroll_history_import_record.payroll_history_record_read.PERMISSIVE',
  'payroll_history_import_revision.payroll_history_import_revision_history_stage.RESTRICTIVE','payroll_history_import_revision.payroll_history_revision_read.PERMISSIVE',
  'payroll_history_import_snapshot.payroll_history_import_snapshot_history_stage.RESTRICTIVE','payroll_history_import_snapshot.payroll_history_snapshot_read.PERMISSIVE',
  'payroll_tax_basis_revision.tax_basis_admin_read.PERMISSIVE','payroll_tax_basis_revision.tax_basis_own_read.PERMISSIVE','payroll_tax_basis_revision.tax_basis_payroll_source_read.PERMISSIVE',
  'payslip.payroll_history_effective_only.RESTRICTIVE','payslip.payroll_import_tax_basis_reader_guard.RESTRICTIVE','payslip.payroll_tax_basis_reader_guard.RESTRICTIVE',
  'payslip.payslip_current_human_read.RESTRICTIVE','payslip.payslip_history_stage.RESTRICTIVE','payslip.payslip_original_employer_read.PERMISSIVE','payslip.payslip_rls.PERMISSIVE') THEN
  RAISE EXCEPTION 'The payroll source row policies changed; review app.payroll_tax_basis_source_digest against them (found %)',actual;
 END IF;
END $policy_guard$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_tax_basis_source_digest(p_company uuid,p_year integer) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE tenant uuid:=app.current_tenant_id();period_prefix text:=p_year::text||'-%';result text;
BEGIN
 IF p_company IS NULL OR p_year IS NULL OR p_year<1900 OR p_year>2999 OR tenant IS NULL
  OR coalesce(current_setting('app.payroll_tax_basis_reader',true),'')<>'1'
  OR coalesce(current_setting('app.payroll_import_tax_basis_reader',true),'')<>'1'
  OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=tenant)
  OR NOT coalesce(app.principal_snapshot_current(),false) OR NOT coalesce(app.can_admin_payroll_for(p_company),false)
  OR NOT coalesce(app.payroll_tax_basis_permission(p_company,'payroll.tax-basis.view'),false) THEN
  RAISE EXCEPTION 'Income-tax recalculation access is unavailable for this company.' USING ERRCODE='42501';
 END IF;
 WITH slip AS MATERIALIZED (
  SELECT p.id,p.xmin AS slip_xmin,b.id AS batch_id,b.xmin AS batch_xmin
  FROM public.payroll_batch b JOIN public.payslip p ON p.batch_id=b.id
  WHERE b.company_id=p_company AND b.tenant_id=tenant AND p.tenant_id=tenant AND b.pay_period LIKE period_prefix
   AND NOT (b.id IN (SELECT unnest(app.payroll_history_hidden_rows('payroll_batch'))))
   AND NOT (p.id IN (SELECT unnest(app.payroll_history_hidden_rows('payslip'))))
 ), effective AS MATERIALIZED (
  SELECT DISTINCT e.id FROM app.payroll_history_effective_ids(ARRAY(SELECT s.id FROM slip s)) AS e(id)
 ), record AS MATERIALIZED (
  SELECT h.id FROM public.payroll_history_import_record h
  WHERE h.company_id=p_company AND h.tenant_id=tenant AND h.period LIKE period_prefix
   AND NOT (h.id IN (SELECT unnest(app.payroll_history_hidden_rows('payroll_history_import_record'))))
 )
 SELECT md5(coalesce(string_agg(q.x,',' ORDER BY q.x),'')) INTO result FROM (
  SELECT 'p:'||s.id||':'||s.slip_xmin||':'||s.batch_id||':'||s.batch_xmin AS x FROM slip s
   WHERE s.id IN (SELECT f.id FROM effective f) OR app.payroll_history_self_issued(s.id)
  UNION ALL SELECT 'r:'||r.id||':'||r.xmin FROM public.payroll_tax_basis_revision r
   WHERE r.company_id=p_company AND r.tenant_id=tenant AND r.period LIKE period_prefix
  UNION ALL SELECT 's:'||s.id FROM public.payroll_history_import_snapshot s JOIN record h ON h.id=s.record_id
   WHERE s.tenant_id=tenant AND NOT (s.id IN (SELECT unnest(app.payroll_history_hidden_rows('payroll_history_import_snapshot'))))
  UNION ALL SELECT 'v:'||v.id FROM public.payroll_history_import_revision v JOIN record h ON h.id=v.record_id
   WHERE v.tenant_id=tenant AND NOT (v.id IN (SELECT unnest(app.payroll_history_hidden_rows('payroll_history_import_revision'))))
 ) q;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_tax_basis_source_digest(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_tax_basis_source_digest(uuid,integer) TO ai_hr_app;
