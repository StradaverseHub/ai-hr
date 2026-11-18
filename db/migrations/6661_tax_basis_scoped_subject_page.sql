-- Set-paged extension of the canonical historical subject reader. Original payroll employer owns history,
-- including transferred/departed people; present-employment RLS must not narrow that authorized source.
CREATE FUNCTION app.payroll_tax_basis_subject_page(targets uuid[],p_offset integer,p_limit integer)
RETURNS TABLE(id uuid,"companyId" uuid,"employeeNo" text,name text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF targets IS NULL OR p_offset IS NULL OR p_limit IS NULL OR coalesce(cardinality(targets),0)>500 OR p_offset<0 OR p_offset>1000000 OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid historical subject page' USING ERRCODE='22023';END IF;
 RETURN QUERY SELECT DISTINCT e.id,b.company_id,coalesce(e.employee_code,''),p.full_name FROM public.employment e JOIN public.person p ON p.id=e.person_id
 JOIN public.payslip s ON s.employment_id=e.id JOIN public.payroll_batch b ON b.id=s.batch_id
 WHERE b.tenant_id=app.current_tenant_id() AND s.tenant_id=b.tenant_id AND e.tenant_id=b.tenant_id AND p.tenant_id=b.tenant_id
 AND app.payroll_history_row_visible('payslip',s.id) AND app.payroll_history_row_visible('payroll_batch',b.id) AND b.company_id=ANY(targets) AND app.payroll_tax_basis_permission(b.company_id,'payroll.tax-basis.view') AND b.status IN ('processed','closed') AND app.payroll_history_effective(s.id)
 ORDER BY b.company_id,coalesce(e.employee_code,''),e.id LIMIT p_limit OFFSET p_offset;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_tax_basis_subject_page(uuid[],integer,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_tax_basis_subject_page(uuid[],integer,integer) TO ai_hr_app;
--> statement-breakpoint
-- Read only: keep every existing write policy, self reader and restrictive source/reader guard.
CREATE FUNCTION app.payroll_tax_basis_original_employer_read(source_batch uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=source_batch AND b.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.can_admin_payroll_for(b.company_id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_tax_basis_original_employer_read(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_tax_basis_original_employer_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY payslip_original_employer_read ON payslip FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.payroll_tax_basis_original_employer_read(batch_id));
