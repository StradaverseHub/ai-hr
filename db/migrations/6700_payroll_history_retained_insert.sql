-- Original-employer maintenance of an EXISTING accepted identity. No current Personnel authority is added.
-- IDs select an immutable reviewed row; callers cannot supply financial/statutory/tax values.
CREATE FUNCTION app.payroll_history_maintenance_payslip(p_attempt uuid,p_preview_hash text,p_batch uuid,p_record uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.payroll_history_import_attempt; r public.payroll_history_import_record; b public.payroll_batch;
 previous public.payroll_history_import_revision; planned jsonb; proof jsonb; stage_ uuid; values_ jsonb; result_ uuid; key_ text;
BEGIN
 -- Shared barriers freeze inputs/authority without upgrading the kernel's per-step Access hold.
 -- Fail fast if invoked from an incompatible order; synchronous confirmation already owns exclusive barriers.
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('payroll-history:'||app.current_tenant_id()::text,0))
 OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0)) THEN
  RAISE EXCEPTION 'Payroll history is busy; retry the operation' USING ERRCODE='55P03'; END IF;
 IF NOT app.payroll_history_native_module() THEN
  RAISE EXCEPTION 'payroll_history_retained_insert_forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public.payroll_history_import_attempt WHERE id=p_attempt AND tenant_id=app.current_tenant_id();
 SELECT * INTO r FROM public.payroll_history_import_record WHERE id=p_record AND tenant_id=app.current_tenant_id() FOR UPDATE;
 key_:=CASE WHEN a.plan->'maintenance'->>'mode' IN('remove_items','remove_batch') THEN 'payroll.history.revert' ELSE 'payroll.history.import' END;
 IF a.id IS NULL OR r.id IS NULL OR a.created_by IS DISTINCT FROM app.current_user_id()
 OR NOT app.payroll_history_attempt_access(a.id) OR NOT app.payroll_history_maintenance_permission(r.company_id,key_)
 OR a.plan->>'previewHash' IS DISTINCT FROM p_preview_hash OR coalesce(p_preview_hash,'')!~'^[0-9a-f]{64}$'
 OR a.source_hash IS DISTINCT FROM encode(sha256(a.source_content),'hex') OR a.plan->>'sourceHash' IS DISTINCT FROM a.source_hash
 OR a.plan->'maintenance'->>'version' IS DISTINCT FROM '1'
 OR coalesce(a.plan->'maintenance'->>'mode','') NOT IN('replace','update_listed','edit','remove_items','remove_batch')
 OR coalesce((a.plan->'counts'->>'invalid')::integer,1)<>0 OR a.plan->'issues' IS DISTINCT FROM '[]'::jsonb
 OR EXISTS(SELECT 1 FROM public.payroll_history_import_event e WHERE e.attempt_id=a.id AND e.kind IN('confirmed','reverted'))
 THEN RAISE EXCEPTION 'payroll_history_retained_insert_forbidden' USING ERRCODE='42501'; END IF;
 IF (CASE WHEN a.plan->'maintenance'->>'mode' IN('edit','remove_items','remove_batch') THEN
  a.plan->'maintenance'->'request'->>'operation' IS DISTINCT FROM a.plan->'maintenance'->>'mode'
  OR a.plan->'maintenance'->'request'->>'reason' IS DISTINCT FROM a.plan->'maintenance'->>'reason'
  OR a.plan->'maintenance'->'request'->>'version' IS DISTINCT FROM '1'
 ELSE a.plan->'maintenance'->'request' IS NOT NULL AND a.plan->'maintenance'->'request'<>'null'::jsonb END) THEN
  RAISE EXCEPTION 'payroll_history_retained_insert_forbidden' USING ERRCODE='42501'; END IF;
 SELECT value INTO planned FROM jsonb_array_elements(a.plan->'rows') WHERE value->>'recordId'=r.id::text
 AND value->>'companyId'=r.company_id::text AND value->>'employmentId'=r.employment_id::text
 AND value->>'period'=r.period AND value->>'cycleId'=r.cycle_id::text;
 IF planned IS NULL OR planned->>'operation' IS DISTINCT FROM 'replace' OR planned->>'withdrawal'='true'
 OR jsonb_typeof(planned->'contributions') IS DISTINCT FROM 'object' OR jsonb_typeof(planned->'values') IS DISTINCT FROM 'object'
 OR coalesce(planned->>'valueHash','')!~'^[0-9a-f]{64}$' OR planned->'reasons' IS DISTINCT FROM '[]'::jsonb THEN
  RAISE EXCEPTION 'payroll_history_retained_insert_row_unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO previous FROM public.payroll_history_import_revision WHERE record_id=r.id ORDER BY ordinal DESC LIMIT 1;
 IF previous.id IS NULL OR previous.id::text IS DISTINCT FROM planned->>'expectedRevisionId'
 OR previous.snapshot_id::text IS DISTINCT FROM planned->>'expectedSnapshotId' THEN
  RAISE EXCEPTION 'payroll_history_retained_insert_revision_changed' USING ERRCODE='40001'; END IF;
 SELECT s.stage_id INTO stage_ FROM app.payroll_history_stage s WHERE s.tenant_id=r.tenant_id AND s.state='staged';
 IF stage_ IS NULL THEN RAISE EXCEPTION 'payroll_history_retained_insert_step_required' USING ERRCODE='42501'; END IF;
 proof:=app.payroll_history_stage_payload(stage_);
 IF current_setting('app.payroll_history_stage',true) IS DISTINCT FROM stage_::text OR proof->>'kind' IS DISTINCT FROM 'row'
 OR proof->>'attemptId' IS DISTINCT FROM a.id::text OR proof->'plan'->>'operation' IS DISTINCT FROM 'confirm'
 OR proof->'plan'->'input'->>'previewHash' IS DISTINCT FROM p_preview_hash
 OR proof->'payload'->'row' IS DISTINCT FROM planned THEN
  RAISE EXCEPTION 'payroll_history_retained_insert_step_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO b FROM public.payroll_batch WHERE id=p_batch AND tenant_id=r.tenant_id FOR UPDATE;
 IF b.id IS NULL OR b.history_import_attempt_id IS DISTINCT FROM a.id OR b.company_id IS DISTINCT FROM r.company_id
 OR b.pay_period IS DISTINCT FROM r.period OR b.payroll_cycle_id IS DISTINCT FROM r.cycle_id OR b.status::text<>'draft'
 OR b.history_import_cycle_name IS DISTINCT FROM planned->>'cycleName' THEN
  RAISE EXCEPTION 'payroll_history_retained_insert_batch_mismatch' USING ERRCODE='42501'; END IF;
 values_:=planned->'values';
 SELECT p.id INTO result_ FROM public.payslip p WHERE p.batch_id=b.id AND p.employment_id=r.employment_id;
 IF result_ IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.payslip p WHERE p.id=result_ AND app.payroll_history_native_values(p)=values_) THEN
   RAISE EXCEPTION 'payroll_history_retained_insert_values_changed' USING ERRCODE='23514'; END IF;
  RETURN result_;
 END IF;
 INSERT INTO public.payslip(tenant_id,batch_id,employment_id,basic_salary,allowance,overtime_pay,bonus,gross_pay,statutory,other_deductions,total_deductions,net_pay,employer_cost)
 VALUES(r.tenant_id,b.id,r.employment_id,(values_->>'basicSalary')::numeric,(values_->>'allowance')::numeric,
 (values_->>'overtimePay')::numeric,(values_->>'bonus')::numeric,(values_->>'grossPay')::numeric,values_->'statutory',
 (values_->>'otherDeductions')::numeric,(values_->>'totalDeductions')::numeric,(values_->>'netPay')::numeric,(values_->>'employerCost')::numeric)
 RETURNING id INTO result_;
 RETURN result_;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_payslip(uuid,text,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_maintenance_payslip(uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- A direct RPC must not publish a financial row without the canonical immutable snapshot/revision.
-- Deferred checking permits the existing group-close -> snapshot -> revision transaction protocol.
CREATE FUNCTION app.payroll_history_retained_insert_custody() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b public.payroll_batch; a public.payroll_history_import_attempt; planned jsonb; p public.payslip;
BEGIN
 SELECT * INTO p FROM public.payslip WHERE id=NEW.id;
 IF p.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO b FROM public.payroll_batch WHERE id=p.batch_id;
 SELECT * INTO a FROM public.payroll_history_import_attempt WHERE id=b.history_import_attempt_id;
 IF a.plan->'maintenance'->>'version' IS DISTINCT FROM '1' THEN RETURN NULL; END IF;
 SELECT value INTO planned FROM jsonb_array_elements(a.plan->'rows') WHERE value->>'recordId' IS NOT NULL
 AND value->>'companyId'=b.company_id::text AND value->>'period'=b.pay_period AND value->>'cycleId'=b.payroll_cycle_id::text
 AND value->>'employmentId'=p.employment_id::text;
 IF planned IS NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s JOIN public.payroll_history_import_revision v
  ON v.snapshot_id=s.id AND v.record_id=s.record_id AND v.tenant_id=s.tenant_id
  WHERE s.id=p.id AND s.tenant_id=p.tenant_id AND s.record_id::text=planned->>'recordId'
  AND s."values"=planned->'values' AND s."values"=app.payroll_history_native_values(p) AND s.value_hash=planned->>'valueHash'
  AND v.attempt_id=a.id AND v.previous_revision_id::text=planned->>'expectedRevisionId'
  AND v.maintenance->'state'=planned->'contributions' AND v.maintenance->>'operation'=a.plan->'maintenance'->>'mode'
  AND v.maintenance->>'reason'=a.plan->'maintenance'->>'reason') THEN
  RAISE EXCEPTION 'payroll_history_retained_insert_requires_accepted_revision' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_retained_insert_custody() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payroll_history_retained_insert_custody AFTER INSERT ON public.payslip
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.payroll_history_retained_insert_custody();
