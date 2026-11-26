-- Restore the pre-7240 employment_rls and person_rls (ADR 0181 employment visibility), 25 November 2026.
-- 7240 restated both USING clauses to ask their company questions once per statement. Release 6's gate showed the
-- restatement costs more than it saves: test/transaction-view-history-scale-db.test.ts History rows went from 23 s
-- (J2) to 169 s, and a diagnostic on the same fixture (70 companies, 1,000 employments) isolated it to these two
-- policies: with the pre-7240 text and the 7240 function the History reads take 330/168/110 ms for a group
-- administrator / Payroll partner / employee, against 2,309/404/290 ms with the 7240 text. The planner reorders the
-- payslip, employment and person joins around the new company arrays (scanning every person of the tenant first).
-- This puts the reviewed pre-7240 text back exactly, as 7240's own guard recorded it. Everything else of 7240 stays:
-- app.visible_employment_ids, which these policies call, keeps its 7240 body and its stored relationship answer.
-- WITH CHECK, roles and commands are unchanged. Each installed USING is guarded by the 7240 text it replaces.
DO $restore$
DECLARE
 emp_now constant text := $q$(voided_at IS NULL) AND (tenant_id = app.current_tenant_id()) AND CASE WHEN ((SELECT current_setting('app.bank_import_point_read'::text, true)) = 'on'::text) THEN CASE WHEN (app.is_admin_for(company_id) OR app.can_admin_payroll_for(company_id)) THEN true ELSE ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((company_id = ANY ((SELECT app.employment_read_companies())::uuid[])) OR (id IN (SELECT unnest((SELECT app.access_visible_employment_ids()))))))) END ELSE ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((company_id = ANY ((SELECT app.employment_read_companies())::uuid[])) OR (id IN (SELECT unnest((SELECT app.access_visible_employment_ids()))))))) END$q$;
 emp_back constant text := $q$(voided_at IS NULL) AND (tenant_id = app.current_tenant_id()) AND CASE WHEN ((SELECT current_setting('app.bank_import_point_read'::text, true)) = 'on'::text) THEN CASE WHEN (app.is_admin_for(company_id) OR app.can_admin_payroll_for(company_id)) THEN true ELSE ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((id IN (SELECT unnest((SELECT app.visible_employment_ids())))) OR app.can_admin_payroll_for(company_id) OR app.can_admin_perfcomp_for(company_id)))) END ELSE ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((id IN (SELECT unnest((SELECT app.visible_employment_ids())))) OR app.can_admin_payroll_for(company_id) OR app.can_admin_perfcomp_for(company_id)))) END$q$;
 person_now constant text := $q$(voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((SELECT app.is_admin()) OR (id IN (SELECT unnest((SELECT app.access_visible_person_ids())))) OR (EXISTS ( SELECT 1 FROM employment e WHERE ((e.person_id = person.id) AND (e.tenant_id = app.current_tenant_id()) AND (e.company_id = ANY ((SELECT app.employment_partner_companies())::uuid[])))))))$q$;
 person_back constant text := $q$(voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND (((SELECT app.is_admin()) OR (id = ANY ((SELECT app.visible_person_ids())::uuid[]))) OR (EXISTS ( SELECT 1 FROM employment e WHERE ((e.person_id = person.id) AND (e.tenant_id = app.current_tenant_id()) AND (app.can_admin_payroll_for(e.company_id) OR app.can_admin_perfcomp_for(e.company_id)))))))$q$;
 installed text;expected text;
BEGIN
 SELECT pg_get_expr(p.polqual,p.polrelid) INTO installed FROM pg_policy p WHERE p.polrelid='public.employment'::regclass AND p.polname='employment_rls';
 EXECUTE format('CREATE POLICY access_visible_restore_guard ON public.employment FOR SELECT TO ai_hr_app USING (%s)',emp_now);
 SELECT pg_get_expr(p.polqual,p.polrelid) INTO expected FROM pg_policy p WHERE p.polrelid='public.employment'::regclass AND p.polname='access_visible_restore_guard';
 DROP POLICY access_visible_restore_guard ON public.employment;
 IF installed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Employment policy differs from the 7240 text' USING ERRCODE='55000'; END IF;
 EXECUTE format('ALTER POLICY employment_rls ON public.employment USING (%s)',emp_back);
 SELECT pg_get_expr(p.polqual,p.polrelid) INTO installed FROM pg_policy p WHERE p.polrelid='public.person'::regclass AND p.polname='person_rls';
 EXECUTE format('CREATE POLICY access_visible_restore_guard ON public.person FOR SELECT TO ai_hr_app USING (%s)',person_now);
 SELECT pg_get_expr(p.polqual,p.polrelid) INTO expected FROM pg_policy p WHERE p.polrelid='public.person'::regclass AND p.polname='access_visible_restore_guard';
 DROP POLICY access_visible_restore_guard ON public.person;
 IF installed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Person policy differs from the 7240 text' USING ERRCODE='55000'; END IF;
 EXECUTE format('ALTER POLICY person_rls ON public.person USING (%s)',person_back);
END;
$restore$;
