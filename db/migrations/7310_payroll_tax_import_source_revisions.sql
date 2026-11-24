-- ADR 0181 (write side): the reprocess tax review (Payroll > Reprocess > Review) read every earlier payslip of the year
-- for the selected employees through taxBasisSourceRowsTx, whose select list called the definer
-- app.payroll_tax_import_source_revision(p.id) once per payslip. Each call plans and runs its own body
-- (principal_snapshot_current, payroll administration, the effective rule and five stage checks), about 3 ms per row
-- for a group administrator and about 10 ms for one holding 70 company grants. Production 24 November 2026: 18.9 s for
-- one review; focused diagnostic: 5.4 s of a 6.1 s source read of 1,800 payslips was this column alone.
--
-- This is the same answer for a set of payslips in one statement. The 6660 body (row_security on since 7051) is
-- restated set-wise, condition for condition: only a payslip joined to an import snapshot in the current tenant can
-- answer; the principal is checked once for the statement (it is STABLE and takes no row); payroll administration
-- once per company; the effective rule through app.payroll_history_effective_ids over the candidates (element-wise,
-- exactly what app.payroll_history_effective asks for one id, as 5129 and 7170 use it); the five stage checks per row;
-- and the highest-ordinal admitted revision. Only non-null answers are returned, so a caller learns exactly what
-- calling the single-payslip function for each id told it. The guard below refuses if either restated body changed.
DO $restated_guard$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.payroll_tax_import_source_revision(uuid)'::regprocedure)
    IS DISTINCT FROM 'cd7cc63d192dcfd49025b3b43056a443'
  OR NOT (SELECT coalesce('row_security=on'=ANY(proconfig),false) AND prosecdef FROM pg_proc WHERE oid='app.payroll_tax_import_source_revision(uuid)'::regprocedure)
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.payroll_history_effective(uuid)'::regprocedure)
    IS DISTINCT FROM '0b6f7d01e84d4d37145e3cf48564c5c2' THEN
  RAISE EXCEPTION 'app.payroll_tax_import_source_revision or app.payroll_history_effective changed; review app.payroll_tax_import_source_revisions against them';
 END IF;
END $restated_guard$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_tax_import_source_revisions(p_payslips uuid[])
RETURNS TABLE(payslip_id uuid,revision_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
 WITH candidate AS MATERIALIZED (
  SELECT DISTINCT p.id,b.id AS batch_id,b.company_id,e.person_id,s.record_id
  FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id JOIN public.employment e ON e.id=p.employment_id
   JOIN public.payroll_history_import_snapshot s ON s.id=p.id
  WHERE p.id=ANY(p_payslips) AND p.tenant_id=app.current_tenant_id() AND b.tenant_id=p.tenant_id AND e.tenant_id=p.tenant_id
   AND s.tenant_id=p.tenant_id
 ), principal AS MATERIALIZED (
  SELECT coalesce(app.principal_snapshot_current(),false) AS current
 ), administered AS MATERIALIZED (
  SELECT c.company_id,coalesce(app.can_admin_payroll_for(c.company_id),false) AS allowed FROM (SELECT DISTINCT company_id FROM candidate) c
 ), effective AS MATERIALIZED (
  SELECT DISTINCT x.id FROM app.payroll_history_effective_ids(ARRAY(SELECT c.id FROM candidate c)) AS x(id)
 ), admitted AS MATERIALIZED (
  SELECT c.* FROM candidate c JOIN administered a ON a.company_id=c.company_id CROSS JOIN principal pr
  WHERE pr.current AND (a.allowed OR app.is_self_person(c.person_id)) AND c.id IN (SELECT f.id FROM effective f)
   AND app.payroll_history_row_visible('payslip',c.id) AND app.payroll_history_row_visible('payroll_batch',c.batch_id)
   AND app.payroll_history_row_visible('payroll_history_import_record',c.record_id)
   AND app.payroll_history_row_visible('payroll_history_import_snapshot',c.id)
 )
 SELECT DISTINCT ON (a.id) a.id,r.id FROM admitted a
  JOIN public.payroll_history_import_revision r ON r.record_id=a.record_id AND r.tenant_id=app.current_tenant_id()
 WHERE app.payroll_history_row_visible('payroll_history_import_revision',r.id)
 ORDER BY a.id,r.ordinal DESC
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_tax_import_source_revisions(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_tax_import_source_revisions(uuid[]) TO ai_hr_app;
