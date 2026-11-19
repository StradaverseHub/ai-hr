-- Forward SQL under development. The scale fixture installs this into its owned
-- database. Allocation and a restricted-owner upgrade rehearsal precede release.
CREATE FUNCTION app.information_latest_retained_payslip_period(
 p_companies uuid[], p_year integer, p_month integer, p_cycle text, p_employment uuid
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH administered AS MATERIALIZED (
  SELECT c.id FROM (SELECT DISTINCT unnest(p_companies) AS id) c
  WHERE cardinality(p_companies)<=100 AND app.principal_snapshot_current()
   AND app.can_admin_payroll_for(c.id)
 )
 SELECT batches.pay_period
 FROM (
  SELECT b.id,b.tenant_id,b.company_id,b.pay_period
  FROM public.payroll_batch b JOIN administered a ON a.id=b.company_id
  WHERE b.tenant_id=app.current_tenant_id()
   AND (p_year IS NULL OR left(b.pay_period,4)=p_year::text)
   AND (p_month IS NULL OR substring(b.pay_period,6,2)=lpad(p_month::text,2,'0'))
   AND (p_cycle IS NULL OR app.payroll_filter_run_type(
    b.history_import_attempt_id,b.run_type::text,
    (SELECT pc.run_type::text FROM public.payroll_cycle pc WHERE pc.id=b.payroll_cycle_id)
   )=p_cycle)
  ORDER BY b.pay_period DESC
  OFFSET 0
 ) batches
 WHERE EXISTS (
  SELECT 1
  FROM (
   SELECT p.id,p.employment_id
   FROM public.payslip p
   -- Use each batch's indexed payslip keys and each snapshot's primary key.
   -- The existence of a snapshot precedes the history visibility check.
   JOIN LATERAL (
    SELECT f.payslip_id FROM public.information_payslip_snapshot f
    WHERE f.payslip_id=p.id AND f.tenant_id=p.tenant_id
     AND f.employment_id=p.employment_id AND f.company_id=batches.company_id
    OFFSET 0
   ) snapshot ON true
   WHERE p.tenant_id=batches.tenant_id AND p.batch_id=batches.id
    AND (p_employment IS NULL OR p.employment_id=p_employment)
   OFFSET 0
  ) retained
  JOIN public.employment e ON e.id=retained.employment_id AND e.tenant_id=batches.tenant_id
  WHERE app.payroll_history_effective(retained.id) OR app.payroll_history_self_issued(retained.id)
  OFFSET 0
 )
 ORDER BY batches.pay_period DESC
 LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.information_latest_retained_payslip_period(uuid[],integer,integer,text,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.information_latest_retained_payslip_period(uuid[],integer,integer,text,uuid) TO ai_hr_app;
