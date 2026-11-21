-- Metadata only: completeness does not grant permission to project any physical financial row.
CREATE FUNCTION app.payroll_history_native_anomaly_complete(p_batch uuid,p_visible uuid[]) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b public.payroll_batch; physical_ids uuid[]; denied boolean; hidden boolean; physical_n integer;
BEGIN
 IF p_batch IS NULL OR p_visible IS NULL OR cardinality(p_visible)>50000 OR coalesce(array_ndims(p_visible),1)<>1
 OR array_position(p_visible,NULL) IS NOT NULL OR app.current_tenant_id() IS NULL
 OR(app.current_user_id() IS NOT NULL AND NOT app.principal_snapshot_current())
 OR cardinality(p_visible)<>(SELECT count(DISTINCT id) FROM unnest(p_visible) supplied(id)) THEN RETURN false; END IF;
 -- NULL-USER uses the same existing legacy payroll-admin predicate as the nightly sweep's ordinary RLS.
 -- There is no new SYSTEM selector, financial read grant, or permission to borrow another actor's scope.
 SELECT * INTO b FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id()
 AND history_import_attempt_id IS NULL AND app.can_admin_payroll_for(company_id);
 IF b.id IS NULL OR EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage
 ON stage.stage_id=sr.stage_id WHERE stage.state='staged' AND sr.relation='payroll_batch' AND sr.row_id=b.id) THEN RETURN false; END IF;
 -- Bound the physical scan, then resolve shared policy facts once per batch/company, never per member.
 WITH physical AS MATERIALIZED(
  SELECT p.id,p.tenant_id,p.employment_id,e.id employee_id,e.tenant_id employee_tenant,e.company_id
  FROM public.payslip p LEFT JOIN public.employment e ON e.id=p.employment_id WHERE p.batch_id=b.id LIMIT 50001
 ), original_permission AS MATERIALIZED(SELECT app.payroll_tax_basis_original_employer_read(b.id) allowed),
 self_employments AS MATERIALIZED(SELECT unnest(app.payroll_history_self_employment_ids()) id),
 companies AS MATERIALIZED(SELECT DISTINCT company_id FROM physical),
 administered AS MATERIALIZED(SELECT c.company_id FROM companies c WHERE app.can_admin_payroll_for(c.company_id)),
 hidden_members AS MATERIALIZED(SELECT sr.row_id FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage
  ON stage.stage_id=sr.stage_id WHERE stage.state='staged' AND stage.tenant_id=b.tenant_id AND sr.relation='payslip')
 SELECT array_agg(p.id ORDER BY p.id),bool_or((p.tenant_id=b.tenant_id AND p.employee_id IS NOT NULL AND p.employee_tenant=b.tenant_id
  AND(p.company_id IN(SELECT company_id FROM administered) OR p.employment_id IN(SELECT id FROM self_employments)
   OR(SELECT allowed FROM original_permission))) IS NOT TRUE),
 bool_or(p.id IN(SELECT row_id FROM hidden_members)),count(*)::integer
 INTO physical_ids,denied,hidden,physical_n FROM physical p;
 IF physical_n>50000 THEN RETURN false; END IF;
 IF coalesce(denied,false) OR coalesce(hidden,false) THEN RETURN false; END IF;
 -- Zero is known only from this unfiltered physical owner read of an already authorized native batch.
 physical_ids:=coalesce(physical_ids,'{}'::uuid[]);
 RETURN physical_ids=ARRAY(SELECT id FROM unnest(p_visible) supplied(id) ORDER BY id);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_native_anomaly_complete(uuid,uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_native_anomaly_complete(uuid,uuid[]) TO ai_hr_app;
