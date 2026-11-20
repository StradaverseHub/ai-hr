-- Resolve original-employer scope once per company and historical visibility once per page.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = 'app.payroll_tax_basis_subject_page(uuid[],integer,integer)'::regprocedure
      AND proowner = CURRENT_USER::regrole
      AND prosecdef AND provolatile = 's'
      AND md5(prosrc) = '4fbec591796b966d8012d43b48cf3b57'
  ) THEN
    RAISE EXCEPTION 'Unexpected payroll tax-basis picker owner or implementation' USING ERRCODE = '55000';
  END IF;
END
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_tax_basis_subject_page(targets uuid[],p_offset integer,p_limit integer)
RETURNS TABLE(id uuid,"companyId" uuid,"employeeNo" text,name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $subject_page$
BEGIN
  IF targets IS NULL OR p_offset IS NULL OR p_limit IS NULL OR cardinality(targets)>500
     OR p_offset<0 OR p_offset>1000000 OR p_limit<1 OR p_limit>500 THEN
    RAISE EXCEPTION 'Invalid historical subject page' USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  WITH permitted_companies AS MATERIALIZED (
    SELECT requested.company_id
    FROM (SELECT DISTINCT company_id FROM unnest(targets) AS target(company_id)) requested
    WHERE requested.company_id IS NOT NULL
      AND app.payroll_tax_basis_permission(requested.company_id,'payroll.tax-basis.view')
  ), candidate_slips AS MATERIALIZED (
    SELECT s.id,s.employment_id,b.company_id
    FROM permitted_companies permitted
    JOIN public.payroll_batch b ON b.company_id=permitted.company_id
    JOIN public.payslip s ON s.batch_id=b.id AND s.tenant_id=b.tenant_id
    WHERE b.tenant_id=app.current_tenant_id()
      AND b.status IN ('processed','closed')
      AND app.payroll_history_row_visible('payroll_batch',b.id)
      AND app.payroll_history_row_visible('payslip',s.id)
  ), effective_slips AS MATERIALIZED (
    SELECT visible.id
    FROM app.payroll_history_effective_ids(ARRAY(SELECT slip.id FROM candidate_slips slip)) AS visible(id)
  )
  SELECT DISTINCT e.id,s.company_id,coalesce(e.employee_code,''),p.full_name
  FROM candidate_slips s
  JOIN effective_slips visible ON visible.id=s.id
  JOIN public.employment e ON e.id=s.employment_id AND e.tenant_id=app.current_tenant_id()
  JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
  ORDER BY s.company_id,coalesce(e.employee_code,''),e.id
  LIMIT p_limit OFFSET p_offset;
END
$subject_page$;
