-- Canonical import revisions retain item contribution lineage. No separate money ledger or artifact mutation.
ALTER TABLE public.payroll_history_import_revision ADD COLUMN maintenance jsonb
 CHECK(maintenance IS NULL OR coalesce((jsonb_typeof(maintenance)='object' AND maintenance->>'version'='1' AND maintenance->'state'->>'version'='1' AND jsonb_typeof(maintenance->'state'->'chains')='object' AND length(maintenance->>'reason') BETWEEN 1 AND 2000),false));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_bind_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE attempt_ uuid; planned_rows jsonb;
BEGIN
 -- Adoption of an ordinary processed payslip: the record's first snapshot, values are its own columns.
 IF EXISTS(SELECT 1 FROM public.payroll_history_import_record r JOIN public.payslip p ON p.id=NEW.id
  JOIN public.payroll_batch b ON b.id=p.batch_id
  WHERE r.id=NEW.record_id AND r.tenant_id=NEW.tenant_id AND p.tenant_id=r.tenant_id AND b.tenant_id=r.tenant_id
  AND p.employment_id=r.employment_id AND b.company_id=r.company_id AND b.pay_period=r.period
  AND (b.payroll_cycle_id=r.cycle_id OR b.payroll_cycle_id IS NULL)
  AND b.history_import_attempt_id IS NULL AND (b.status='closed' OR EXISTS(
   SELECT 1 FROM public.payroll_history_import_attempt a, jsonb_array_elements(a.plan->'rows') planned
   WHERE a.tenant_id=NEW.tenant_id AND a.created_by=app.current_user_id() AND a.plan->'maintenance'->>'version'='1'
   AND planned->>'expectedOrdinaryPayslipId'=NEW.id::text AND planned->>'companyId'=r.company_id::text
   AND planned->>'employmentId'=r.employment_id::text AND planned->>'period'=r.period AND planned->>'cycleId'=r.cycle_id::text
   AND app.payroll_history_maintenance_permission(r.company_id,'payroll.history.import')))
  AND NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot o WHERE o.record_id=r.id)
  AND NEW."values"=jsonb_build_object('basicSalary',p.basic_salary::text,'allowance',p.allowance::text,
   'overtimePay',p.overtime_pay::text,'bonus',p.bonus::text,'grossPay',p.gross_pay::text,'statutory',p.statutory,
   'otherDeductions',p.other_deductions::text,'totalDeductions',p.total_deductions::text,'netPay',p.net_pay::text,'employerCost',p.employer_cost::text))
 THEN RETURN NEW; END IF;
 SELECT b.history_import_attempt_id INTO attempt_ FROM public.payroll_history_import_record r JOIN public.payslip p ON p.id=NEW.id
  JOIN public.payroll_batch b ON b.id=p.batch_id
  WHERE r.id=NEW.record_id AND r.tenant_id=NEW.tenant_id AND p.tenant_id=r.tenant_id AND b.tenant_id=r.tenant_id
  AND p.employment_id=r.employment_id AND b.company_id=r.company_id AND b.pay_period=r.period
  AND b.payroll_cycle_id=r.cycle_id AND b.history_import_attempt_id IS NOT NULL
  AND (b.status='closed' OR (b.status='draft' AND EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage st ON st.stage_id=sr.stage_id
   WHERE sr.relation='payroll_batch' AND sr.row_id=b.id AND st.state='staged' AND st.stage_id::text=current_setting('app.payroll_history_stage',true))))
  AND NEW."values"=jsonb_build_object('basicSalary',p.basic_salary::text,'allowance',p.allowance::text,
   'overtimePay',p.overtime_pay::text,'bonus',p.bonus::text,'grossPay',p.gross_pay::text,'statutory',p.statutory,
   'otherDeductions',p.other_deductions::text,'totalDeductions',p.total_deductions::text,'netPay',p.net_pay::text,'employerCost',p.employer_cost::text);
 IF attempt_ IS NOT NULL THEN
  SELECT a.plan->'rows' INTO planned_rows FROM public.payroll_history_import_attempt a WHERE a.id=attempt_ AND a.tenant_id=NEW.tenant_id;
 END IF;
 IF attempt_ IS NULL OR planned_rows IS NULL OR NOT EXISTS(SELECT 1 FROM public.payroll_history_import_record r, jsonb_array_elements(planned_rows) planned
   WHERE r.id=NEW.record_id AND planned->>'companyId'=r.company_id::text AND planned->>'employmentId'=r.employment_id::text
   AND planned->>'period'=r.period AND planned->>'cycleId'=r.cycle_id::text
   AND planned->>'operation' IN ('create','replace') AND planned->'values'=NEW."values" AND planned->>'valueHash'=NEW.value_hash)
 THEN RAISE EXCEPTION 'Payroll import snapshot identity mismatch'; END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE FUNCTION app.payroll_history_maintenance_revision_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE identity public.payroll_history_import_record; source public.payroll_history_import_attempt; planned jsonb; permission_key text;
BEGIN
 IF NEW.maintenance IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO identity FROM public.payroll_history_import_record WHERE id=NEW.record_id AND tenant_id=NEW.tenant_id;
 SELECT * INTO source FROM public.payroll_history_import_attempt WHERE id=NEW.attempt_id AND tenant_id=NEW.tenant_id;
 permission_key:=CASE WHEN source.plan->'maintenance'->>'mode' IN ('remove_items','remove_batch') THEN 'payroll.history.revert' ELSE 'payroll.history.import' END;
 IF identity.id IS NULL OR source.id IS NULL OR NOT app.principal_snapshot_current() OR source.created_by IS DISTINCT FROM app.current_user_id()
 OR NOT app.payroll_history_maintenance_permission(identity.company_id,permission_key)
 OR source.plan->'maintenance'->>'version' IS DISTINCT FROM '1'
 OR NEW.maintenance->>'operation' IS DISTINCT FROM source.plan->'maintenance'->>'mode'
 OR NEW.maintenance->>'reason' IS DISTINCT FROM source.plan->'maintenance'->>'reason'
 THEN RAISE EXCEPTION 'Payroll history maintenance authority or source unavailable' USING ERRCODE='42501'; END IF;
 SELECT value INTO planned FROM jsonb_array_elements(source.plan->'rows') WHERE value->>'companyId'=identity.company_id::text
 AND value->>'employmentId'=identity.employment_id::text AND value->>'period'=identity.period AND value->>'cycleId'=identity.cycle_id::text;
 IF planned IS NULL OR planned->'contributions' IS DISTINCT FROM NEW.maintenance->'state'
 OR (planned->>'restoreSnapshotId' IS NOT NULL AND (planned->>'restoreSnapshotId')::uuid IS DISTINCT FROM NEW.snapshot_id)
 OR (planned->>'withdrawal'='true' AND planned->>'restoreSnapshotId' IS NULL AND NEW.snapshot_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Payroll history maintenance revision does not match its reviewed plan' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_revision_bind() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER payroll_history_maintenance_revision_binding BEFORE INSERT ON public.payroll_history_import_revision FOR EACH ROW EXECUTE FUNCTION app.payroll_history_maintenance_revision_bind();
