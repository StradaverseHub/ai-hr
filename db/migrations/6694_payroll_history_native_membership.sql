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
DECLARE stage_id_ uuid; job_ public.bulk_job;
BEGIN
 IF TG_OP='DELETE' THEN
  SELECT stage.stage_id INTO stage_id_ FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id
  WHERE sr.relation='payroll_history_import_snapshot' AND sr.row_id=OLD.snapshot_id AND stage.state='staged'
   AND stage.tenant_id=OLD.tenant_id AND stage.attempt_id=OLD.attempt_id AND stage.created_by=OLD.created_by AND stage.job_id=stage.stage_id;
  IF stage_id_ IS NOT NULL THEN
   job_:=app.bulk_job_held(stage_id_);
   IF job_.id=stage_id_ AND job_.tenant_id=OLD.tenant_id AND job_.kind='payroll_history' AND job_.state='discarding'
    THEN RETURN OLD;END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'Native history capture evidence is immutable' USING ERRCODE='42501';
END
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_capture_immutable() FROM PUBLIC;
CREATE TRIGGER payroll_history_native_capture_frozen BEFORE UPDATE OR DELETE ON app.payroll_history_native_capture FOR EACH ROW EXECUTE FUNCTION app.payroll_history_native_capture_immutable();
--> statement-breakpoint
-- The existing reset receipt seals the physical rows its native owner deletes. Its identity/permission/budget proof is unchanged.
DO $migration$ DECLARE body text;a text:='(app.payroll_history_effective(q.id) OR app.payroll_history_self_issued(q.id))';b text:='(app.payroll_history_effective(slip.id) OR app.payroll_history_self_issued(slip.id))';BEGIN
 SELECT pg_get_functiondef('app._payroll_reset_source(uuid,uuid[],uuid[])'::regprocedure) INTO body;
 IF(length(body)-length(replace(body,a,'')))/length(a)<>1 OR(length(body)-length(replace(body,b,'')))/length(b)<>1 THEN RAISE EXCEPTION 'Unexpected native reset source predicates';END IF;
 body:=replace(replace(body,a,'app.payroll_history_native_artifact_allowed(q.batch_id,q.employment_id,q.id)'),b,'app.payroll_history_native_artifact_allowed(slip.batch_id,slip.employment_id,slip.id)');EXECUTE body;
END $migration$;
