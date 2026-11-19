-- Disposable performance proof for the ordered, capped retained-document path.
CREATE FUNCTION app.test_bounded_retained_payroll_documents(
 p_companies uuid[], p_year integer, p_month integer, p_cycle text, p_employment uuid, p_limit integer
) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH administered AS MATERIALIZED (
  SELECT c.id FROM (SELECT DISTINCT unnest(p_companies) AS id) c
  WHERE cardinality(p_companies)<=100 AND p_limit BETWEEN 1 AND 5000
   AND app.principal_snapshot_current() AND app.can_admin_payroll_for(c.id)
 ), runs AS MATERIALIZED (
  SELECT b.id,b.tenant_id,b.company_id,b.pay_period,b.run_seq
  FROM public.payroll_batch b JOIN administered a ON a.id=b.company_id
  WHERE b.tenant_id=app.current_tenant_id()
   AND (p_year IS NULL OR left(b.pay_period,4)=p_year::text)
   AND (p_month IS NULL OR substring(b.pay_period,6,2)=lpad(p_month::text,2,'0'))
   AND (p_cycle IS NULL OR app.payroll_filter_run_type(
    b.history_import_attempt_id,b.run_type::text,
    (SELECT pc.run_type::text FROM public.payroll_cycle pc WHERE pc.id=b.payroll_cycle_id)
   )=p_cycle)
 ), page AS MATERIALIZED (
  SELECT b.id AS batch_id,b.pay_period,b.run_seq,visible.id AS payslip_id
  FROM runs b
  JOIN LATERAL (
   SELECT retained.id
   FROM (
    SELECT p.id,p.employment_id
    FROM public.payslip p
    JOIN LATERAL (
     SELECT f.payslip_id FROM public.information_payslip_snapshot f
     WHERE f.payslip_id=p.id AND f.tenant_id=p.tenant_id
      AND f.employment_id=p.employment_id AND f.company_id=b.company_id
     OFFSET 0
    ) snapshot ON true
    WHERE p.tenant_id=b.tenant_id AND p.batch_id=b.id
     AND (p_employment IS NULL OR p.employment_id=p_employment)
    OFFSET 0
   ) retained
   JOIN public.employment e ON e.id=retained.employment_id AND e.tenant_id=b.tenant_id
   WHERE app.payroll_history_effective(retained.id) OR app.payroll_history_self_issued(retained.id)
   ORDER BY retained.id
   LIMIT greatest(0,least(coalesce(p_limit,0),5000))
  ) visible ON true
  ORDER BY b.pay_period DESC,b.run_seq,visible.id
  LIMIT greatest(0,least(coalesce(p_limit,0),5000))
 )
 SELECT jsonb_build_object(
  'metadata',f.document_metadata||jsonb_build_object('jobGrade',f.grade,'employmentType',f.employment_type),
  'batch',to_jsonb(b),
  'payslip',to_jsonb(p)||jsonb_build_object(
   'basic_salary',p.basic_salary::text,'allowance',p.allowance::text,'overtime_pay',p.overtime_pay::text,'bonus',p.bonus::text,
   'gross_pay',p.gross_pay::text,'other_deductions',p.other_deductions::text,'total_deductions',p.total_deductions::text,
   'net_pay',p.net_pay::text,'employer_cost',p.employer_cost::text,'days_worked',p.days_worked::text
  )
 )
 FROM page
 JOIN public.payroll_batch b ON b.id=page.batch_id
 JOIN public.payslip p ON p.id=page.payslip_id
 JOIN public.information_payslip_snapshot f ON f.payslip_id=page.payslip_id
 ORDER BY page.pay_period DESC,page.run_seq,page.payslip_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.test_bounded_retained_payroll_documents(uuid[],integer,integer,text,uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.test_bounded_retained_payroll_documents(uuid[],integer,integer,text,uuid,integer) TO ai_hr_app;
