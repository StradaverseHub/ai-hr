-- Only the exact original native run/employment is replaced. Future additional runs remain independent.
CREATE FUNCTION app.payroll_history_native_replaced(subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch original_batch ON original_batch.id=p.batch_id AND original_batch.tenant_id=p.tenant_id JOIN app.payroll_history_native_capture c ON c.source_batch_id=p.batch_id AND c.tenant_id=p.tenant_id
 JOIN public.payroll_history_import_record identity ON identity.id=c.record_id AND identity.tenant_id=c.tenant_id AND identity.employment_id=p.employment_id
 JOIN public.payroll_history_import_revision adopted ON adopted.record_id=c.record_id AND adopted.ordinal=1 AND adopted.snapshot_id=c.snapshot_id AND adopted.kind='adopted' AND adopted.native_source=app.payroll_history_native_proof(c)
 JOIN LATERAL(SELECT r.snapshot_id FROM public.payroll_history_import_revision r WHERE r.record_id=c.record_id AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id WHERE sr.relation='payroll_history_import_revision' AND sr.row_id=r.id AND stage.state='staged') ORDER BY r.ordinal DESC LIMIT 1) latest ON latest.snapshot_id IS NOT NULL
 WHERE p.id=subject AND p.tenant_id=app.current_tenant_id() AND original_batch.company_id=identity.company_id AND original_batch.pay_period=identity.period AND(original_batch.payroll_cycle_id IS NULL OR original_batch.payroll_cycle_id=identity.cycle_id) AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id WHERE sr.relation='payroll_history_import_revision' AND sr.row_id=adopted.id AND stage.state='staged'))
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_replaced(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- CREATE OR REPLACE preserves the OID of every existing RLS/statutory reader dependency and its ACL.
CREATE OR REPLACE FUNCTION app.payroll_history_effective(subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s WHERE s.id=subject AND s.tenant_id=app.current_tenant_id()
 AND CASE WHEN app.payroll_history_row_visible('payroll_history_import_snapshot',s.id)
 THEN(SELECT r.snapshot_id FROM public.payroll_history_import_revision r WHERE r.record_id=s.record_id AND app.payroll_history_row_visible('payroll_history_import_revision',r.id) ORDER BY r.ordinal DESC LIMIT 1) IS DISTINCT FROM subject
 ELSE NOT app.payroll_history_row_visible('payslip',subject) END) AND NOT app.payroll_history_native_replaced(subject)
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_native_baseline(subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.payroll_history_native_module() AND EXISTS(SELECT 1 FROM app.payroll_history_native_capture c JOIN public.payroll_history_import_record identity ON identity.id=c.record_id AND identity.tenant_id=c.tenant_id
 JOIN public.employment e ON e.id=identity.employment_id AND e.tenant_id=identity.tenant_id
 JOIN public.payroll_history_import_revision r ON r.record_id=c.record_id AND r.ordinal=1 AND r.kind='adopted' AND r.snapshot_id=c.snapshot_id AND r.native_source=app.payroll_history_native_proof(c)
 WHERE c.snapshot_id=subject AND c.tenant_id=app.current_tenant_id() AND(app.can_admin_payroll_for(identity.company_id) OR app.is_self_person(e.person_id))
 AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id WHERE stage.state='staged' AND((sr.relation='payroll_history_import_revision' AND sr.row_id=r.id) OR(sr.relation='payslip' AND sr.row_id=subject))))
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_baseline(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_native_baseline(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_native_artifact_allowed(subject_batch uuid,subject_employment uuid,subject_payslip uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.payroll_history_native_module() AND app.can_admin_payroll_employment(subject_employment) AND EXISTS(SELECT 1 FROM public.payroll_batch b
 WHERE b.id=subject_batch AND b.tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(b.company_id)
 AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id WHERE stage.state='staged' AND((sr.relation='payroll_batch' AND sr.row_id=b.id) OR(sr.relation='payslip' AND sr.row_id=subject_payslip)))
 AND(app.payroll_history_effective(subject_payslip) OR b.history_import_attempt_id IS NULL AND(b.status IN('draft','processing','processed') AND EXISTS(SELECT 1 FROM public.pay_period period WHERE period.id=b.pay_period_id AND period.tenant_id=b.tenant_id AND period.status='open') OR EXISTS(SELECT 1 FROM app.payroll_history_native_capture c JOIN public.payroll_history_import_record r ON r.id=c.record_id AND r.tenant_id=c.tenant_id JOIN public.payroll_history_import_revision adopted ON adopted.record_id=r.id AND adopted.ordinal=1 AND adopted.native_source=app.payroll_history_native_proof(c) WHERE c.source_batch_id=b.id AND c.tenant_id=b.tenant_id AND r.company_id=b.company_id AND r.period=b.pay_period AND r.employment_id=subject_employment AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id WHERE sr.relation='payroll_history_import_revision' AND sr.row_id=adopted.id AND stage.state='staged')))))
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_artifact_allowed(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_native_artifact_allowed(uuid,uuid,uuid) TO ai_hr_app;
-- The owner view bypasses only effective-history visibility, never principal/tenant/company/employment/module checks.
CREATE VIEW public.payroll_history_native_payslip WITH(security_barrier=true) AS SELECT p.* FROM public.payslip p
 WHERE p.tenant_id=app.current_tenant_id() AND app.payroll_history_native_artifact_allowed(p.batch_id,p.employment_id,p.id);
REVOKE ALL ON public.payroll_history_native_payslip FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.payroll_history_native_payslip TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_native_write_allowed(subject_batch uuid,subject_employment uuid,subject_payslip uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b public.payroll_batch;
BEGIN
 IF NOT app.payroll_history_native_module() OR NOT app.can_admin_payroll_employment(subject_employment) THEN RETURN false;END IF;
 SELECT * INTO b FROM public.payroll_batch WHERE id=subject_batch AND tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(company_id) FOR SHARE;
 RETURN b.id IS NOT NULL AND b.history_import_attempt_id IS NULL AND b.status IN('draft','processing','processed') AND EXISTS(SELECT 1 FROM public.pay_period period WHERE period.id=b.pay_period_id AND period.tenant_id=b.tenant_id AND period.status='open')
 AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id WHERE stage.state='staged' AND((sr.relation='payroll_batch' AND sr.row_id=b.id) OR(sr.relation='payslip' AND sr.row_id=subject_payslip)));
END
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_write_allowed(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_native_write_allowed(uuid,uuid,uuid) TO ai_hr_app;
-- A separate automatically-updatable portal has no closed/imported branch. Base constraints and triggers still fire.
CREATE VIEW public.payroll_history_native_payslip_write WITH(security_barrier=true) AS SELECT p.* FROM public.payslip p
 WHERE p.tenant_id=app.current_tenant_id() AND app.payroll_history_native_write_allowed(p.batch_id,p.employment_id,p.id) WITH CASCADED CHECK OPTION;
REVOKE ALL ON public.payroll_history_native_payslip_write FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.payroll_history_native_payslip_write TO ai_hr_app;

--> statement-breakpoint
-- Later ordinary closing preserves this run's own issued artifact, through the existing explicit self-issued reader only.
CREATE OR REPLACE FUNCTION app.payroll_history_self_issued(subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce(current_setting('app.payslip_self_issued',true),'')='on' AND app.principal_snapshot_current() AND(
 EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s JOIN public.payslip p ON p.id=s.id JOIN public.payroll_batch b ON b.id=p.batch_id JOIN public.employment e ON e.id=p.employment_id WHERE s.id=subject AND s.tenant_id=app.current_tenant_id() AND b.history_import_attempt_id IS NULL AND app.payroll_history_row_visible('payroll_history_import_snapshot',s.id) AND app.is_self_person(e.person_id))
 OR EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=p.tenant_id JOIN public.employment e ON e.id=p.employment_id AND e.tenant_id=p.tenant_id
 JOIN app.payroll_history_native_capture c ON c.source_batch_id=b.id AND c.tenant_id=b.tenant_id JOIN public.payroll_history_import_record r ON r.id=c.record_id AND r.employment_id=p.employment_id AND r.company_id=b.company_id AND r.period=b.pay_period
 JOIN public.payroll_history_import_revision adopted ON adopted.record_id=r.id AND adopted.ordinal=1 AND adopted.native_source=app.payroll_history_native_proof(c)
 WHERE p.id=subject AND p.tenant_id=app.current_tenant_id() AND b.history_import_attempt_id IS NULL AND b.status='closed' AND app.is_self_person(e.person_id)
 AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id WHERE stage.state='staged' AND((sr.relation='payroll_history_import_revision' AND sr.row_id=adopted.id) OR(sr.relation='payslip' AND sr.row_id=p.id)))))
$$;
