-- Exact original-native correction custody, metadata only. An old source hash is never relabelled.
CREATE FUNCTION app.payroll_history_native_tax_predecessors(p_sources uuid[])
RETURNS TABLE("sourceId" uuid,id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_sources IS NULL OR cardinality(p_sources) NOT BETWEEN 1 AND 50000 OR array_position(p_sources,NULL) IS NOT NULL THEN RAISE EXCEPTION 'Invalid native tax source selection' USING ERRCODE='22023';END IF;
 IF NOT app.payroll_history_native_module() THEN RETURN;END IF;
 RETURN QUERY
 WITH hidden AS MATERIALIZED(SELECT pending.relation,pending.row_id FROM app.payroll_history_staged_row pending JOIN app.payroll_history_stage stage ON stage.stage_id=pending.stage_id WHERE stage.tenant_id=app.current_tenant_id() AND stage.state='staged'),
 selected AS MATERIALIZED(SELECT current.id,current.record_id FROM public.payroll_history_import_snapshot current JOIN public.payroll_history_import_record record ON record.id=current.record_id AND record.tenant_id=current.tenant_id
  JOIN app.payroll_history_native_capture candidate ON candidate.record_id=record.id AND candidate.tenant_id=record.tenant_id
  JOIN public.payslip slip ON slip.id=current.id AND slip.tenant_id=current.tenant_id AND slip.employment_id=record.employment_id
  JOIN public.payroll_batch batch ON batch.id=slip.batch_id AND batch.tenant_id=record.tenant_id AND batch.company_id=record.company_id AND batch.pay_period=record.period
  JOIN public.employment employment ON employment.id=record.employment_id AND employment.tenant_id=record.tenant_id
  WHERE (batch.payroll_cycle_id=record.cycle_id OR batch.payroll_cycle_id IS NULL AND EXISTS(SELECT 1 FROM app.payroll_history_native_capture baseline WHERE baseline.snapshot_id=current.id AND baseline.record_id=record.id AND baseline.tenant_id=record.tenant_id)) AND current.id=ANY(p_sources) AND current.tenant_id=app.current_tenant_id()
  AND(app.can_admin_payroll_for(record.company_id) OR app.is_self_person(employment.person_id))
  AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_snapshot' AND h.row_id=current.id OR h.relation='payroll_history_import_record' AND h.row_id=record.id OR h.relation='payslip' AND h.row_id=slip.id OR h.relation='payroll_batch' AND h.row_id=batch.id)
  AND current.id=(SELECT latest.snapshot_id FROM public.payroll_history_import_revision latest WHERE latest.record_id=record.id AND latest.tenant_id=record.tenant_id AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_revision' AND h.row_id=latest.id) ORDER BY latest.ordinal DESC LIMIT 1))
 SELECT DISTINCT selected.id,correction.id FROM selected JOIN app.payroll_history_native_capture capture ON capture.record_id=selected.record_id AND capture.tenant_id=app.current_tenant_id()
 JOIN public.payroll_history_import_record record ON record.id=capture.record_id AND record.tenant_id=capture.tenant_id
 JOIN public.payroll_history_import_revision adopted ON adopted.record_id=record.id AND adopted.tenant_id=record.tenant_id AND adopted.ordinal=1 AND adopted.kind='adopted' AND adopted.snapshot_id=capture.snapshot_id AND adopted.native_source=app.payroll_history_native_proof(capture)
 JOIN public.payroll_history_import_snapshot baseline ON baseline.id=capture.snapshot_id AND baseline.record_id=record.id AND baseline.tenant_id=record.tenant_id
 JOIN public.payslip retained ON retained.id=baseline.id AND retained.tenant_id=record.tenant_id AND retained.employment_id=record.employment_id
 JOIN public.payroll_batch batch ON batch.id=retained.batch_id AND batch.id=capture.baseline_batch_id AND batch.tenant_id=record.tenant_id AND batch.company_id=record.company_id AND batch.pay_period=record.period AND batch.status='closed' AND(batch.payroll_cycle_id=record.cycle_id OR batch.payroll_cycle_id IS NULL)
 JOIN public.payroll_tax_basis_revision correction ON correction.payslip_id=capture.source_payslip_id AND correction.tenant_id=record.tenant_id AND correction.company_id=record.company_id AND correction.employment_id=record.employment_id AND correction.period=record.period
 WHERE app.payroll_history_native_snapshot_bound(baseline)
 AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_revision' AND h.row_id=adopted.id OR h.relation='payroll_history_import_snapshot' AND h.row_id=baseline.id OR h.relation='payslip' AND h.row_id=retained.id OR h.relation='payroll_batch' AND h.row_id=batch.id)
 ORDER BY selected.id,correction.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_native_tax_predecessors(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_native_tax_predecessors(uuid[]) TO ai_hr_app;
