-- Retained payroll documents planned with their filter values (measured on staging 24 November 2026).
-- Transaction View's History tab calls app.information_payslip_documents for every load. As a SQL function it is
-- never inlined (SECURITY DEFINER with SET), and PostgreSQL plans a SQL function's statement without its argument
-- values, so the `p_year IS NULL OR ...` filters cannot narrow the plan: every call walked every retained document in
-- scope and ran the effective-snapshot rule for each. Staging (2,010 retained documents, 6,823 payslips): 441 ms for
-- one month, against 15 ms for the same statement planned with the values; 785 ms for the whole scope.
-- This replaces the body only. The statement is the 5129 statement character for character with $1..$6 in place of
-- the six arguments, run by RETURN QUERY EXECUTE ... USING, which plans it once per call with the values known. Same
-- signature, return type, owner, SECURITY DEFINER, search_path, rows and order; CREATE OR REPLACE keeps the 0698
-- EXECUTE grant to ai_hr_app. Guarded by the exact 5129 body.
DO $source_guard$
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.information_payslip_documents(uuid[],integer,integer,text,uuid,boolean)'::regprocedure) IS DISTINCT FROM '9170464ecf45b91cb17a82d27f01d155514a7ecbd4078adbf3b77b043baf5dd3' THEN RAISE EXCEPTION 'Expected the 5129 retained payroll documents source';END IF;
END;
$source_guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.information_payslip_documents(p_companies uuid[],p_year integer,p_month integer,p_cycle text,p_employment uuid DEFAULT NULL,p_intended boolean DEFAULT false) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN QUERY EXECUTE $statement$
 SELECT jsonb_build_object('metadata',f.document_metadata||jsonb_build_object('jobGrade',f.grade,'employmentType',f.employment_type),
 'batch',to_jsonb(b),'payslip',to_jsonb(p)||jsonb_build_object(
 'basic_salary',p.basic_salary::text,'allowance',p.allowance::text,'overtime_pay',p.overtime_pay::text,'bonus',p.bonus::text,
 'gross_pay',p.gross_pay::text,'other_deductions',p.other_deductions::text,'total_deductions',p.total_deductions::text,
 'net_pay',p.net_pay::text,'employer_cost',p.employer_cost::text,'days_worked',p.days_worked::text))
 FROM public.information_payslip_snapshot f JOIN public.payslip p ON p.id=f.payslip_id AND p.tenant_id=f.tenant_id AND p.employment_id=f.employment_id
 JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=f.tenant_id AND b.company_id=f.company_id
 JOIN public.employment e ON e.id=p.employment_id AND e.tenant_id=f.tenant_id
 WHERE f.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND cardinality($1)<=100
 AND b.company_id=ANY($1) AND app.can_admin_payroll_for(b.company_id)
 AND ($5 IS NULL OR p.employment_id=$5)
 AND ($2 IS NULL OR left(b.pay_period,4)=$2::text) AND ($3 IS NULL OR substring(b.pay_period,6,2)=lpad($3::text,2,'0'))
 AND ($4 IS NULL OR (CASE WHEN $6 THEN app.payroll_filter_run_type(b.history_import_attempt_id,b.run_type::text,(select pc.run_type::text from public.payroll_cycle pc where pc.id=b.payroll_cycle_id)) ELSE b.run_type::text END)=$4)
 AND (app.payroll_history_effective(p.id) OR app.payroll_history_self_issued(p.id))
 ORDER BY b.pay_period DESC,b.run_seq,p.id LIMIT 5001
 $statement$ USING p_companies,p_year,p_month,p_cycle,p_employment,p_intended;
END
$$;
