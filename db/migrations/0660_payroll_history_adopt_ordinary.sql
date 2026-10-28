-- d28501b8 r2 — Import Payroll History may overwrite payroll that was PROCESSED in AIHR, append-only.
--
-- Nothing is updated or deleted. A processed payslip is ADOPTED into the 0602 revision owner as the first
-- revision of its identity (kind 'adopted', snapshot = that payslip, values = its own columns), and the
-- imported figures follow as a 'correction'. The 0602 restrictive policy then hides the adopted payslip
-- from every ordinary reader, exactly as it hides a superseded import; a revert puts it back.
--
-- Three guards keep the adoption honest:
--  * the adopted values are the payslip's own columns, checked here, so nothing can be adopted under
--    figures it never had;
--  * an adopted payslip can no longer be edited (unlock/regenerate paths), so a revert restores what was
--    set aside rather than something changed afterwards;
--  * an employee keeps seeing the payslip they were ISSUED on their own payslip screens — only when the
--    self-service reader asks for it (app.payslip_self_issued), only their own, only an adopted original.

ALTER TABLE payroll_history_import_revision DROP CONSTRAINT payroll_history_import_revision_kind_check;
ALTER TABLE payroll_history_import_revision ADD CONSTRAINT payroll_history_import_revision_kind_check
 CHECK(kind IN ('import','correction','revert','adopted'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_bind_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 -- Adoption of an ordinary processed payslip: the record's first snapshot, values are its own columns.
 IF EXISTS(SELECT 1 FROM public.payroll_history_import_record r JOIN public.payslip p ON p.id=NEW.id
  JOIN public.payroll_batch b ON b.id=p.batch_id
  WHERE r.id=NEW.record_id AND r.tenant_id=NEW.tenant_id AND p.tenant_id=r.tenant_id AND b.tenant_id=r.tenant_id
  AND p.employment_id=r.employment_id AND b.company_id=r.company_id AND b.pay_period=r.period
  AND (b.payroll_cycle_id=r.cycle_id OR b.payroll_cycle_id IS NULL)
  AND b.history_import_attempt_id IS NULL AND b.status='closed'
  AND NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot o WHERE o.record_id=r.id)
  AND NEW."values"=jsonb_build_object('basicSalary',p.basic_salary::text,'allowance',p.allowance::text,
   'overtimePay',p.overtime_pay::text,'bonus',p.bonus::text,'grossPay',p.gross_pay::text,'statutory',p.statutory,
   'otherDeductions',p.other_deductions::text,'totalDeductions',p.total_deductions::text,'netPay',p.net_pay::text,'employerCost',p.employer_cost::text))
 THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payroll_history_import_record r JOIN public.payslip p ON p.id=NEW.id
  JOIN public.payroll_batch b ON b.id=p.batch_id
  WHERE r.id=NEW.record_id AND r.tenant_id=NEW.tenant_id AND p.tenant_id=r.tenant_id AND b.tenant_id=r.tenant_id
  AND p.employment_id=r.employment_id AND b.company_id=r.company_id AND b.pay_period=r.period
  AND b.payroll_cycle_id=r.cycle_id AND b.history_import_attempt_id IS NOT NULL AND b.status='closed'
  AND NEW."values"=jsonb_build_object('basicSalary',p.basic_salary::text,'allowance',p.allowance::text,
   'overtimePay',p.overtime_pay::text,'bonus',p.bonus::text,'grossPay',p.gross_pay::text,'statutory',p.statutory,
   'otherDeductions',p.other_deductions::text,'totalDeductions',p.total_deductions::text,'netPay',p.net_pay::text,'employerCost',p.employer_cost::text)
  AND EXISTS(SELECT 1 FROM public.payroll_history_import_attempt a, jsonb_array_elements(a.plan->'rows') planned
   WHERE a.id=b.history_import_attempt_id AND a.tenant_id=r.tenant_id
   AND planned->>'companyId'=r.company_id::text AND planned->>'employmentId'=r.employment_id::text
   AND planned->>'period'=r.period AND planned->>'cycleId'=r.cycle_id::text
   AND planned->>'operation' IN ('create','replace') AND planned->'values'=NEW."values" AND planned->>'valueHash'=NEW.value_hash))
 THEN RAISE EXCEPTION 'Payroll import snapshot identity mismatch'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- An adopted snapshot is an ordinary payslip and enters only as ordinal 1 of kind 'adopted'; every
-- imported snapshot enters only as an import or correction. The ordinal/previous chain check is 0602's.
CREATE OR REPLACE FUNCTION app.payroll_history_bind_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE r public.payroll_history_import_record;previous public.payroll_history_import_revision;ordinary boolean;
BEGIN
 SELECT * INTO r FROM public.payroll_history_import_record WHERE id=NEW.record_id FOR UPDATE;
 IF r.id IS NULL OR r.tenant_id<>NEW.tenant_id THEN RAISE EXCEPTION 'Payroll import revision identity mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payroll_history_import_attempt a WHERE a.id=NEW.attempt_id AND a.tenant_id=r.tenant_id AND r.company_id=ANY(a.company_ids))
 THEN RAISE EXCEPTION 'Payroll import attempt identity mismatch'; END IF;
 IF NEW.snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s WHERE s.id=NEW.snapshot_id AND s.record_id=r.id AND s.tenant_id=r.tenant_id)
 THEN RAISE EXCEPTION 'Payroll import snapshot belongs to another record'; END IF;
 IF NEW.snapshot_id IS NOT NULL THEN
  SELECT b.history_import_attempt_id IS NULL INTO ordinary FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id WHERE p.id=NEW.snapshot_id;
  IF ordinary AND NEW.kind NOT IN ('adopted','revert') THEN RAISE EXCEPTION 'A processed payslip enters payroll history only by adoption'; END IF;
  IF NOT ordinary AND NEW.kind='adopted' THEN RAISE EXCEPTION 'Only a processed payslip can be adopted'; END IF;
 END IF;
 IF NEW.kind='adopted' AND (NEW.ordinal<>1 OR NEW.snapshot_id IS NULL) THEN RAISE EXCEPTION 'Adoption is the first revision of a payroll record'; END IF;
 SELECT * INTO previous FROM public.payroll_history_import_revision WHERE record_id=r.id ORDER BY ordinal DESC LIMIT 1;
 IF NEW.ordinal<>coalesce(previous.ordinal,0)+1 OR NEW.previous_revision_id IS DISTINCT FROM previous.id
 THEN RAISE EXCEPTION 'Payroll import record changed; validate a new attempt'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- An adopted payslip is frozen: the unlock/regenerate paths may not change what a revert would restore.
CREATE FUNCTION app.payroll_history_guard_adopted_payslip() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Imported snapshots are already immutable through their closed batch (0011/0602); this guards the
 -- adopted processed payslips, whose run can be unlocked.
 IF EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s JOIN public.payroll_batch b ON b.id=OLD.batch_id
  WHERE s.id=OLD.id AND b.history_import_attempt_id IS NULL) THEN
  RAISE EXCEPTION 'This payslip was overwritten by Import Payroll History; revert that import before changing it'
   USING ERRCODE='check_violation';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER payroll_history_adopted_payslip_frozen BEFORE UPDATE OR DELETE ON payslip
 FOR EACH ROW EXECUTE FUNCTION app.payroll_history_guard_adopted_payslip();
--> statement-breakpoint
-- The employee's own issued original, for the self-service payslip readers only.
CREATE FUNCTION app.payroll_history_self_issued(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce(current_setting('app.payslip_self_issued',true),'')='on'
 AND EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s
  JOIN public.payslip p ON p.id=s.id JOIN public.payroll_batch b ON b.id=p.batch_id
  JOIN public.employment e ON e.id=p.employment_id
  WHERE s.id=subject AND s.tenant_id=app.current_tenant_id() AND b.history_import_attempt_id IS NULL
  AND app.principal_snapshot_current() AND app.is_self_person(e.person_id))
$$;
REVOKE ALL ON FUNCTION app.payroll_history_self_issued(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_self_issued(uuid) TO ai_hr_app;
DROP POLICY payroll_history_effective_only ON payslip;
CREATE POLICY payroll_history_effective_only ON payslip AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.payroll_history_effective(id) OR app.payroll_history_self_issued(id));
--> statement-breakpoint
-- An ordinary run with an overwritten payslip reports derived totals, like an imported batch does.
CREATE FUNCTION app.payroll_history_batch_adopted(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s JOIN public.payslip p ON p.id=s.id
  WHERE p.batch_id=subject AND s.tenant_id=app.current_tenant_id())
$$;
REVOKE ALL ON FUNCTION app.payroll_history_batch_adopted(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_batch_adopted(uuid) TO ai_hr_app;
DO $$ DECLARE columns text; BEGIN
 SELECT string_agg(CASE a.attname
  WHEN 'totals' THEN 'CASE WHEN b.history_import_attempt_id IS NULL AND NOT app.payroll_history_batch_adopted(b.id) THEN b.totals ELSE app.payroll_history_batch_totals(b.id) END AS totals'
  WHEN 'employee_count' THEN 'CASE WHEN b.history_import_attempt_id IS NULL AND NOT app.payroll_history_batch_adopted(b.id) THEN b.employee_count ELSE (app.payroll_history_batch_totals(b.id)->>''employeeCount'')::integer END AS employee_count'
  ELSE format('b.%I',a.attname) END,',' ORDER BY a.attnum) INTO columns
 FROM pg_attribute a WHERE a.attrelid='public.payroll_batch'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 EXECUTE 'CREATE OR REPLACE VIEW public.payroll_history_effective_batch WITH (security_invoker=true) AS SELECT '||columns||' FROM public.payroll_batch b';
END $$;
GRANT SELECT ON payroll_history_effective_batch TO ai_hr_app;
