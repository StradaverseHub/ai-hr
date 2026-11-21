-- Approved PCB history source boundary: immutable imported figures, additive input evidence only.
ALTER TABLE payroll_import_code DROP CONSTRAINT payroll_import_code_destination_ck;
--> statement-breakpoint
ALTER TABLE payroll_import_code ADD CONSTRAINT payroll_import_code_destination_ck CHECK(destination IN ('basic','allowance','overtime','bonus','other_deduction','noncash','epf_employee','epf_employer','socso_employee','socso_employer','socso_skbbk','eis_employee','eis_employer','pcb','cp38','zakat','lp','hrdf','gross','net'));
--> statement-breakpoint
-- An older reader must raise, never filter history away and calculate an incomplete YTD.
-- The definer checks batch/employment only, avoiding payslip policy recursion.
CREATE FUNCTION app.payroll_import_tax_reader_compatible(subject_employment uuid,source_batch uuid,stamp jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
 IF stamp IS NULL OR current_setting('app.payroll_import_tax_basis_reader',true)='1' THEN RETURN true;END IF;
 IF EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=source_batch AND b.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND (app.can_admin_payroll_for(b.company_id) OR EXISTS(SELECT 1 FROM public.employment e WHERE e.id=subject_employment AND e.tenant_id=b.tenant_id AND app.is_self_person(e.person_id)))) THEN
  RAISE EXCEPTION 'An import-aware income-tax reader is required for this payroll history' USING ERRCODE='55000';
 END IF;
 RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_import_tax_reader_compatible(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_import_tax_reader_compatible(uuid,uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY payroll_import_tax_basis_reader_guard ON payslip AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.payroll_import_tax_reader_compatible(employment_id,batch_id,statutory->'importedTaxBasis'));

--> statement-breakpoint
-- Exact import-revision metadata follows the existing payroll reader audience. It does not grant
-- source-file/import-log access; self annual readers must hash the same source as an administrator.
CREATE FUNCTION app.payroll_tax_import_source_revision(p_payslip uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 SELECT r.id FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id JOIN public.employment e ON e.id=p.employment_id JOIN public.payroll_history_import_snapshot s ON s.id=p.id JOIN public.payroll_history_import_revision r ON r.record_id=s.record_id
 WHERE p.id=p_payslip AND p.tenant_id=app.current_tenant_id() AND b.tenant_id=p.tenant_id AND e.tenant_id=p.tenant_id AND s.tenant_id=p.tenant_id AND r.tenant_id=p.tenant_id
 AND app.principal_snapshot_current() AND (app.can_admin_payroll_for(b.company_id) OR app.is_self_person(e.person_id)) AND app.payroll_history_effective(p.id)
 AND app.payroll_history_row_visible('payslip',p.id) AND app.payroll_history_row_visible('payroll_batch',b.id)
 AND app.payroll_history_row_visible('payroll_history_import_record',s.record_id) AND app.payroll_history_row_visible('payroll_history_import_snapshot',s.id) AND app.payroll_history_row_visible('payroll_history_import_revision',r.id)
 ORDER BY r.ordinal DESC LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_tax_import_source_revision(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_tax_import_source_revision(uuid) TO ai_hr_app;
