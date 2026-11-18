-- Physical membership is metadata only. Effective-history RLS must not suppress a later Needs Reprocess mark.
CREATE FUNCTION app.payroll_history_native_affected(targets jsonb) RETURNS TABLE(id uuid,existing jsonb,at timestamptz,ids text[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.payroll_history_native_module() OR jsonb_typeof(targets) IS DISTINCT FROM 'array' OR jsonb_array_length(targets)>50000 OR octet_length(targets::text)>16777216 THEN RAISE EXCEPTION 'Invalid native payroll impact scope' USING ERRCODE='42501';END IF;
 RETURN QUERY WITH source AS(SELECT DISTINCT * FROM jsonb_to_recordset(targets) s("companyId" uuid,"employmentId" uuid,period text)),candidate AS(
 SELECT DISTINCT b.id FROM public.payroll_batch b JOIN public.pay_period period ON period.id=b.pay_period_id AND period.tenant_id=b.tenant_id JOIN source s ON s."companyId"=b.company_id
 WHERE b.tenant_id=app.current_tenant_id() AND b.history_import_attempt_id IS NULL AND b.status IN('processed','processing') AND period.status='open' AND b.pay_period>=s.period AND left(b.pay_period,4)=left(s.period,4)
 AND(app.payroll_history_native_permission(b.company_id,'payroll.history.import') OR app.payroll_history_native_permission(b.company_id,'payroll.history.revert'))
 AND EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=b.tenant_id AND p.batch_id=b.id AND p.employment_id=s."employmentId")
 AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id WHERE sr.relation='payroll_batch' AND sr.row_id=b.id AND stage.state='staged')),
 locked AS(SELECT b.id,b.company_id,b.pay_period,b.recalc_employment_ids,b.needs_recalc_at FROM public.payroll_batch b JOIN candidate c ON c.id=b.id ORDER BY b.id FOR UPDATE OF b)
 SELECT l.id,l.recalc_employment_ids,l.needs_recalc_at,ARRAY(SELECT DISTINCT s."employmentId"::text FROM source s WHERE s."companyId"=l.company_id AND l.pay_period>=s.period AND left(l.pay_period,4)=left(s.period,4) AND EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=app.current_tenant_id() AND p.batch_id=l.id AND p.employment_id=s."employmentId") ORDER BY s."employmentId"::text) FROM locked l ORDER BY l.id;
END
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_affected(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_native_affected(jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_native_capture_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id WHERE sr.relation='payroll_history_import_snapshot' AND sr.row_id=OLD.snapshot_id AND stage.state='staged') THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Native history capture evidence is immutable';
END
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_capture_immutable() FROM PUBLIC;
CREATE TRIGGER payroll_history_native_capture_frozen BEFORE UPDATE OR DELETE ON app.payroll_history_native_capture FOR EACH ROW EXECUTE FUNCTION app.payroll_history_native_capture_immutable();
