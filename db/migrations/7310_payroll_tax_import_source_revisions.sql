-- ADR 0181 (write side): the reprocess tax review (Payroll > Reprocess > Review) read every earlier payslip of the year
-- for the selected employees through taxBasisSourceRowsTx, whose select list called the definer
-- app.payroll_tax_import_source_revision(p.id) once per payslip. Each call plans and runs its own body
-- (principal_snapshot_current, payroll administration, the effective rule and five stage checks), about 3 ms per row
-- for a group administrator and more for one holding many company grants. Production 24 November 2026: 18.9 s for one
-- review; focused diagnostic: 5.6 s of a 6.4 s source read for 1,800 payslips was this column alone.
--
-- Only an imported payslip can have an import revision: the 6660 body joins payroll_history_import_snapshot on the
-- payslip id in the current tenant. This set form picks those payslips once and calls the UNCHANGED 6660/7051 function
-- for them only, returning only its non-null answers, so a caller learns exactly what calling it per payslip told it.
CREATE FUNCTION app.payroll_tax_import_source_revisions(p_payslips uuid[])
RETURNS TABLE(payslip_id uuid,revision_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
 WITH imported AS MATERIALIZED (
  SELECT DISTINCT p.id FROM public.payslip p JOIN public.payroll_history_import_snapshot s ON s.id=p.id
  WHERE p.id=ANY(p_payslips) AND p.tenant_id=app.current_tenant_id() AND s.tenant_id=p.tenant_id
 ), answered AS MATERIALIZED (
  SELECT i.id,app.payroll_tax_import_source_revision(i.id) AS revision FROM imported i
 )
 SELECT a.id,a.revision FROM answered a WHERE a.revision IS NOT NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_tax_import_source_revisions(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_tax_import_source_revisions(uuid[]) TO ai_hr_app;
