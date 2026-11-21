-- Payroll history reads at production size (12 November 2026). Allocated 5129 / idx 4529 / when 1793330004829,
-- above production's installed 5127 and PR 240's reserved 5128 (docs/MIGRATION-ALLOCATION.md).
-- Functions and one view only: no table, column, constraint, index, policy, grant on a table or data change. Every
-- replaced object is checked against its reviewed predecessor first. No lock is taken on payslip or payroll_batch
-- beyond the catalogue locks of CREATE OR REPLACE (the view and functions are replaced in place; their OIDs, the
-- policies and the grants that reference them stay).
--
-- Measured on production after 2a2495919 (pg_stat_activity, no wait events, pure CPU): the Payroll dashboard's batch
-- list ~16 s and its count ~5 s, Reconciliation 14-17 s, Transaction View 7 s. Two causes, both per payslip row:
--
-- 1. 5055 rewrote app.payroll_history_effective with three calls of app.payroll_history_row_visible. That helper is
--    `SELECT NOT EXISTS(...)`, and PostgreSQL never inlines a scalar SQL function whose body has a sublink, so each
--    call is a nested SQL function whose plan is rebuilt on every outer call: ~65 us per payslip instead of ~9 us. The
--    effective rule is evaluated for every payslip a tenant reads (policy payroll_history_effective_only), so every
--    payslip reader slowed down. Section 1 moves the rule, unchanged, into one set-returning owner that the planner
--    does inline (SQL, invoker, no SET clause, single SELECT), and app.payroll_history_effective delegates to it.
-- 2. The effective-batch view (0602/0660/5051) called the invoker app.payroll_history_batch_totals twice per history
--    batch (totals and employee_count); each call aggregated the batch's payslips under the reader's payslip row
--    security, i.e. four policy functions per payslip. Section 2 computes each batch's figures once, from one definer
--    aggregate for the payroll-administration arm and one invoker read of the reader's own payslips, so no policy
--    function runs per payslip. Visible result: identical (see the equivalence note in section 2).
-- 3. app.information_payslip_documents (0698) called the definer app.information_payslip_document per candidate row,
--    re-running the principal check and the effective rule in a nested function each time. Section 3 builds the same
--    document set in its own statement.
-- 4. The other per-payslip policy term, app.can_admin_payroll_employment (2100), wraps app.can_admin_payroll_for in an
--    EXISTS, so the grant check is again a nested SQL function re-planned on every row (~28 us). Section 4 looks the
--    employer up and asks app.can_admin_payroll_for once, as a PL/pgSQL expression whose state persists, with the same
--    answer for every input.

-- 0. Reviewed predecessors.
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('app.payroll_history_effective(uuid)','d42a54bcea041c4709ad388a7f5a8321'),
  ('app.payroll_history_row_visible(text,uuid)','14c63a67316d2de42a32ff05e75947f1'),
  ('app.payroll_history_batch_totals(uuid)',NULL),
  ('app.payroll_history_batch_adopted(uuid)','9ff1c1ad211fee2f2121316a0b42041a'),
  ('app.can_admin_payroll_employment(uuid)','296a916754bb3978e45b5e4ad641e8c1'),
  ('app.information_payslip_document(uuid)','7569896c3dc86748f357f6216bd9d306'),
  ('app.information_payslip_documents(uuid[],integer,integer,text,uuid,boolean)','a8bc29bf935896ef1a9f0335827b26b6')
 ) v(sig,body) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure(r.sig) AND (r.body IS NULL OR md5(p.prosrc)=r.body)) THEN
   RAISE EXCEPTION 'payroll history effective reads: % differs from its reviewed predecessor',r.sig USING ERRCODE='55000';
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
-- 1. The effective-snapshot rule, one owner, set-wise. Exactly 5055's rule with app.payroll_history_row_visible
--    expanded: of the given ids, those that are not an imported snapshot of the current tenant superseded by a later
--    visible revision of its record, nor a staged imported payslip another open stage hides. Same result as before
--    for every id and every stage state (test/payroll-history-effective-batch-totals.test.ts compares it with the
--    5055 body). Private: only definers and the policy-side owner below use it.
CREATE FUNCTION app.payroll_history_effective_ids(p_ids uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
 SELECT candidate.id FROM unnest(p_ids) AS candidate(id)
 WHERE NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s
  WHERE s.id=candidate.id AND s.tenant_id=app.current_tenant_id()
  AND CASE WHEN NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage st ON st.stage_id=sr.stage_id
     WHERE sr.relation='payroll_history_import_snapshot' AND sr.row_id=s.id AND st.state='staged'
      AND st.stage_id::text IS DISTINCT FROM current_setting('app.payroll_history_stage',true))
   THEN (SELECT r.snapshot_id FROM public.payroll_history_import_revision r WHERE r.record_id=s.record_id
     AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage st ON st.stage_id=sr.stage_id
      WHERE sr.relation='payroll_history_import_revision' AND sr.row_id=r.id AND st.state='staged'
       AND st.stage_id::text IS DISTINCT FROM current_setting('app.payroll_history_stage',true))
     ORDER BY r.ordinal DESC LIMIT 1) IS DISTINCT FROM candidate.id
   ELSE EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage st ON st.stage_id=sr.stage_id
     WHERE sr.relation='payslip' AND sr.row_id=candidate.id AND st.state='staged'
      AND st.stage_id::text IS DISTINCT FROM current_setting('app.payroll_history_stage',true)) END)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_effective_ids(uuid[]) FROM PUBLIC;
--> statement-breakpoint
-- The scalar owner every policy and reader calls keeps its signature, privileges and SET clause; its body is now the
-- set-wise owner for one id, which the planner inlines into it.
CREATE OR REPLACE FUNCTION app.payroll_history_effective(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.payroll_history_effective_ids(ARRAY[subject]))
$$;
--> statement-breakpoint
-- 2. Batch figures for the effective-batch view.
--
-- What a reader saw before (0602 app.payroll_history_batch_totals, SECURITY INVOKER): the aggregate of the batch's
-- payslips p with app.payroll_history_effective(p.id) that pass the reader's payslip row security:
--   payslip_rls                     tenant AND (app.can_admin_payroll_employment(employment) OR own employment)
--   payroll_history_effective_only  effective OR self-issued (implied: the function itself requires effective)
--   payroll_tax_basis_reader_guard  true, or an error; every tenant transaction sets app.payroll_tax_basis_reader=1,
--                                   which makes it true without reading anything
--   payslip_history_stage           not staged by another open stage
-- That is per payslip, not per batch: a company-scoped administrator sees only the payslips whose EMPLOYMENT's
-- current company they administer (an employment corrected to another company leaves its earlier payslips in the
-- old company's batch), and an employee sees only their own payslips. A batch-level check would show both of them
-- figures they could not see before, so the split below keeps the per-payslip rule:
--   A (definer, aggregate only)  tenant, not hidden, effective, and the employment's company is payroll-administered
--                                by the reader: app.can_admin_payroll_for once per distinct employment company of the
--                                batch, the same test app.can_admin_payroll_employment makes per row;
--   S (invoker, ordinary RLS)    the reader's own employments' payslips in the batch (one index probe each), effective, not
--                                already in A. Read under the reader's own payslip row security, so the self arm,
--                                including its employment visibility, is exactly the policy's.
-- A and S are disjoint and their union is the old visible set. Readers without row security on payslip (the table
-- owner, e.g. the reconciliation capture trigger) and transactions that are not correction-aware tax readers keep the
-- old function unchanged.
CREATE FUNCTION app.payroll_history_batch_admin_totals(subject uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH slip AS MATERIALIZED (
  SELECT p.id,p.gross_pay,p.net_pay,p.statutory,e.company_id
  FROM public.payslip p JOIN public.employment e ON e.id=p.employment_id AND e.tenant_id=p.tenant_id
  WHERE p.batch_id=subject AND p.tenant_id=app.current_tenant_id()
   AND NOT (p.id IN (SELECT unnest(app.payroll_history_hidden_rows('payslip'))))
 ), employer AS MATERIALIZED (SELECT DISTINCT s.company_id FROM slip s),
 administered AS MATERIALIZED (SELECT c.company_id FROM employer c WHERE app.can_admin_payroll_for(c.company_id)),
 counted AS MATERIALIZED (
  SELECT s.* FROM slip s WHERE s.company_id IN (SELECT a.company_id FROM administered a)
   AND s.id IN (SELECT e.id FROM app.payroll_history_effective_ids(ARRAY(
    SELECT c.id FROM slip c WHERE c.company_id IN (SELECT a.company_id FROM administered a))) AS e(id))
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
REVOKE ALL ON FUNCTION app.payroll_history_batch_admin_totals(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_batch_admin_totals(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The reader's own employments (app.is_self_person's rule: the signed-in user's person in this tenant). A superset
-- for S's index probe only; S's rows still pass the reader's own payslip row security.
CREATE FUNCTION app.payroll_history_self_employment_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce(array_agg(e.id ORDER BY e.id),'{}'::uuid[]) FROM public.app_user u JOIN public.employment e ON e.person_id=u.person_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_self_employment_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_self_employment_ids() TO ai_hr_app;
--> statement-breakpoint
-- A + S, with 0602's object shape and numeric scales (sums add exactly; an empty arm contributes zero).
CREATE FUNCTION app.payroll_history_batch_visible_totals(subject uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
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
  FROM unnest(app.payroll_history_self_employment_ids()) AS own(employment_id)
  CROSS JOIN LATERAL (SELECT q.* FROM public.payslip q WHERE q.batch_id=subject AND q.employment_id=own.employment_id OFFSET 0) p
  WHERE NOT app.can_admin_payroll_employment(p.employment_id) AND app.payroll_history_effective(p.id)) s
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_batch_visible_totals(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_batch_visible_totals(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The view keeps 5051's column list, names, types and order. Each history (or adopted) batch's figures are computed
-- once, in a lateral subquery kept apart from the outer query (OFFSET 0) so totals and employee_count share it; a
-- reader that selects neither computes neither. Batch row security on payroll_batch is unchanged.
DO $$ DECLARE columns text; BEGIN
 SELECT string_agg(CASE a.attname
  WHEN 'totals' THEN 'CASE WHEN h.derived IS NULL THEN b.totals ELSE h.totals END AS totals'
  WHEN 'employee_count' THEN 'CASE WHEN h.derived IS NULL THEN b.employee_count ELSE (h.totals->>''employeeCount'')::integer END AS employee_count'
  ELSE format('b.%I',a.attname) END,',' ORDER BY a.attnum) INTO columns
 FROM pg_attribute a WHERE a.attrelid='public.payroll_batch'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.payroll_history_effective_batch'::regclass AND attnum>0 AND NOT attisdropped)
  IS DISTINCT FROM (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.payroll_batch'::regclass AND attnum>0 AND NOT attisdropped) THEN
  RAISE EXCEPTION 'payroll_history_effective_batch no longer projects payroll_batch column for column' USING ERRCODE='55000';
 END IF;
 EXECUTE 'CREATE OR REPLACE VIEW public.payroll_history_effective_batch WITH (security_invoker=true) AS SELECT '||columns
  ||' FROM public.payroll_batch b LEFT JOIN LATERAL (SELECT true AS derived,'
  ||'CASE WHEN row_security_active(''public.payslip''::regclass) AND current_setting(''app.payroll_tax_basis_reader'',true)=''1'''
  ||' THEN app.payroll_history_batch_visible_totals(b.id) ELSE app.payroll_history_batch_totals(b.id) END AS totals'
  ||' WHERE b.history_import_attempt_id IS NOT NULL OR app.payroll_history_batch_adopted(b.id) OFFSET 0) h ON true';
END $$;
--> statement-breakpoint
-- 3. Retained payroll documents (0698): the same rows, columns, order and limit as before, built in this statement.
--    Each row met the outer conditions (tenant, current principal, payroll-administered batch company, filters) and
--    app.information_payslip_document's own: the snapshot's employment and company equal the payslip's and its
--    batch's, the employment exists in the tenant, and the payslip is effective or self-issued (its admin-or-self
--    test is already the outer administered company). The single-document function is unchanged.
CREATE OR REPLACE FUNCTION app.information_payslip_documents(p_companies uuid[],p_year integer,p_month integer,p_cycle text,p_employment uuid DEFAULT NULL,p_intended boolean DEFAULT false) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',f.document_metadata||jsonb_build_object('jobGrade',f.grade,'employmentType',f.employment_type),
 'batch',to_jsonb(b),'payslip',to_jsonb(p)||jsonb_build_object(
 'basic_salary',p.basic_salary::text,'allowance',p.allowance::text,'overtime_pay',p.overtime_pay::text,'bonus',p.bonus::text,
 'gross_pay',p.gross_pay::text,'other_deductions',p.other_deductions::text,'total_deductions',p.total_deductions::text,
 'net_pay',p.net_pay::text,'employer_cost',p.employer_cost::text,'days_worked',p.days_worked::text))
 FROM public.information_payslip_snapshot f JOIN public.payslip p ON p.id=f.payslip_id AND p.tenant_id=f.tenant_id AND p.employment_id=f.employment_id
 JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=f.tenant_id AND b.company_id=f.company_id
 JOIN public.employment e ON e.id=p.employment_id AND e.tenant_id=f.tenant_id
 WHERE f.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND cardinality(p_companies)<=100
 AND b.company_id=ANY(p_companies) AND app.can_admin_payroll_for(b.company_id)
 AND (p_employment IS NULL OR p.employment_id=p_employment)
 AND (p_year IS NULL OR left(b.pay_period,4)=p_year::text) AND (p_month IS NULL OR substring(b.pay_period,6,2)=lpad(p_month::text,2,'0'))
 AND (p_cycle IS NULL OR (CASE WHEN p_intended THEN app.payroll_filter_run_type(b.history_import_attempt_id,b.run_type::text,(select pc.run_type::text from public.payroll_cycle pc where pc.id=b.payroll_cycle_id)) ELSE b.run_type::text END)=p_cycle)
 AND (app.payroll_history_effective(p.id) OR app.payroll_history_self_issued(p.id))
 ORDER BY b.pay_period DESC,b.run_seq,p.id LIMIT 5001;
$$;
--> statement-breakpoint
-- 4. The payroll-administration test for one employment (2100: the employment of the current tenant whose company the
--    caller payroll-administers). Same signature, owner, privileges, SECURITY DEFINER and search_path; employment.id
--    is the primary key, so the lookup returns the employer of at most one row, and an absent employment, another
--    tenant's employment or a null id is false as before. app.can_admin_payroll_for stays the only owner of the grant
--    rule.
CREATE OR REPLACE FUNCTION app.can_admin_payroll_employment(emp_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE employer uuid;
BEGIN
 SELECT e.company_id INTO employer FROM public.employment e WHERE e.id=emp_id AND e.tenant_id=app.current_tenant_id();
 RETURN FOUND AND app.can_admin_payroll_for(employer);
END
$$;
