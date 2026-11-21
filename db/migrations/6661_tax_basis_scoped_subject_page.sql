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
 SELECT EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=source_batch AND b.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.payroll_tax_basis_permission(b.company_id,'payroll.tax-basis.view'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_tax_basis_original_employer_read(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_tax_basis_original_employer_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY payslip_original_employer_read ON payslip FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.payroll_tax_basis_original_employer_read(batch_id));

--> statement-breakpoint
-- Match the newly additive original-employer payslip SELECT arm in the optimized A + S totals.
-- Keep the applied 5129 owner, signatures, security modes, ACLs, effective/stage filters and numeric JSON shape.
-- Each owner evaluates original-employer permission once per batch, never once per payslip. Current-company
-- permission remains one check per distinct company. The invoker self arm excludes BOTH administration arms.
CREATE OR REPLACE FUNCTION app.payroll_history_batch_admin_totals(subject uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH original_employer AS MATERIALIZED (SELECT app.payroll_tax_basis_original_employer_read(subject) AS allowed),
 slip AS MATERIALIZED (
  SELECT p.id,p.gross_pay,p.net_pay,p.statutory,e.company_id
  FROM public.payslip p JOIN public.employment e ON e.id=p.employment_id AND e.tenant_id=p.tenant_id
  WHERE p.batch_id=subject AND p.tenant_id=app.current_tenant_id()
   AND NOT (p.id IN (SELECT unnest(app.payroll_history_hidden_rows('payslip'))))
 ), employer AS MATERIALIZED (SELECT DISTINCT s.company_id FROM slip s),
 administered AS MATERIALIZED (SELECT c.company_id FROM employer c WHERE app.can_admin_payroll_for(c.company_id)),
 counted AS MATERIALIZED (
  SELECT s.* FROM slip s WHERE ((SELECT allowed FROM original_employer) OR s.company_id IN (SELECT a.company_id FROM administered a))
   AND s.id IN (SELECT e.id FROM app.payroll_history_effective_ids(ARRAY(
    SELECT c.id FROM slip c WHERE (SELECT allowed FROM original_employer) OR c.company_id IN (SELECT a.company_id FROM administered a))) AS e(id))
 )
 SELECT (SELECT jsonb_build_object('employeeCount',count(*),'gross',coalesce(sum(gross_pay),0),'net',coalesce(sum(net_pay),0),
 'epfEmployee',coalesce(sum((statutory->>'epfEmployee')::numeric),0),'epfEmployer',coalesce(sum((statutory->>'epfEmployer')::numeric),0),
 'socsoEmployee',coalesce(sum((statutory->>'socsoEmployee')::numeric),0),'socsoEmployer',coalesce(sum((statutory->>'socsoEmployer')::numeric),0),
 'eisEmployee',coalesce(sum((statutory->>'eisEmployee')::numeric),0),'eisEmployer',coalesce(sum((statutory->>'eisEmployer')::numeric),0),'pcb',coalesce(sum((statutory->>'pcb')::numeric),0))
 FROM counted)
 -- Only for a correction-aware tax reader: anyone else keeps the guarded per-payslip read.
 WHERE current_setting('app.payroll_tax_basis_reader',true)='1'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_batch_visible_totals(subject uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
 WITH original_employer AS MATERIALIZED (SELECT app.payroll_tax_basis_original_employer_read(subject) AS allowed),
 own_employments AS MATERIALIZED (
  SELECT e.id,e.company_id FROM unnest(app.payroll_history_self_employment_ids()) own(employment_id)
  JOIN public.employment e ON e.id=own.employment_id AND e.tenant_id=app.current_tenant_id()
 ), own_companies AS MATERIALIZED (SELECT DISTINCT company_id FROM own_employments),
 administered AS MATERIALIZED (SELECT company_id FROM own_companies WHERE app.can_admin_payroll_for(company_id))
 SELECT CASE WHEN s.n=0 THEN a.t ELSE jsonb_build_object('employeeCount',(a.t->>'employeeCount')::bigint+s.n,
  'gross',(a.t->>'gross')::numeric+s.gross,'net',(a.t->>'net')::numeric+s.net,
  'epfEmployee',(a.t->>'epfEmployee')::numeric+s.epf_ee,'epfEmployer',(a.t->>'epfEmployer')::numeric+s.epf_er,
  'socsoEmployee',(a.t->>'socsoEmployee')::numeric+s.socso_ee,'socsoEmployer',(a.t->>'socsoEmployer')::numeric+s.socso_er,
  'eisEmployee',(a.t->>'eisEmployee')::numeric+s.eis_ee,'eisEmployer',(a.t->>'eisEmployer')::numeric+s.eis_er,
  'pcb',(a.t->>'pcb')::numeric+s.pcb) END
 FROM (SELECT app.payroll_history_batch_admin_totals(subject) AS t) a,
 (SELECT count(*) AS n,coalesce(sum(p.gross_pay),0) AS gross,coalesce(sum(p.net_pay),0) AS net,
   coalesce(sum((p.statutory->>'epfEmployee')::numeric),0) AS epf_ee,coalesce(sum((p.statutory->>'epfEmployer')::numeric),0) AS epf_er,
   coalesce(sum((p.statutory->>'socsoEmployee')::numeric),0) AS socso_ee,coalesce(sum((p.statutory->>'socsoEmployer')::numeric),0) AS socso_er,
   coalesce(sum((p.statutory->>'eisEmployee')::numeric),0) AS eis_ee,coalesce(sum((p.statutory->>'eisEmployer')::numeric),0) AS eis_er,
   coalesce(sum((p.statutory->>'pcb')::numeric),0) AS pcb
  -- One probe of payslip_batch_employment_uq per own employment (none for a reader without one); the lateral read
  -- is kept apart (OFFSET 0) so row security only ever runs on those payslips.
  FROM own_employments own
  CROSS JOIN LATERAL (SELECT q.* FROM public.payslip q WHERE q.batch_id=subject AND q.employment_id=own.id OFFSET 0) p
  WHERE NOT (SELECT allowed FROM original_employer)
   AND own.company_id NOT IN (SELECT company_id FROM administered) AND app.payroll_history_effective(p.id)) s
$$;
