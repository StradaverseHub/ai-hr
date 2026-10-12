-- Clock corrections retain original punch evidence and apply through the existing approval workflow.
-- Actor attribution also supports service contexts without an app-user UUID. No existing row is rewritten.
ALTER TYPE clock_method ADD VALUE IF NOT EXISTS 'admin';--> statement-breakpoint
ALTER TABLE attendance_punch ADD COLUMN voided_at timestamptz,
 ADD COLUMN voided_by text, ADD COLUMN void_reason text,
 ADD CONSTRAINT attendance_punch_void_metadata_ck CHECK (
 (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR
 (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL AND length(btrim(void_reason)) > 0)
 );--> statement-breakpoint
-- Separate accepted web captures can share a wall-clock second. Keep both original receipts.
-- Corrections validate the entire effective set under the same subject lock used by every writer.
CREATE UNIQUE INDEX attendance_punch_live_clock_uq ON attendance_punch(attendance_id,punch_at,direction)
 WHERE voided_at IS NULL AND clock_capture_id IS NULL;--> statement-breakpoint
ALTER TABLE attendance_correction ADD COLUMN clock_changes jsonb;--> statement-breakpoint
ALTER TABLE attendance_correction DROP CONSTRAINT attendance_correction_at_least_one;--> statement-breakpoint
ALTER TABLE attendance_correction ADD CONSTRAINT attendance_correction_at_least_one CHECK (
 proposed_check_in IS NOT NULL OR proposed_check_out IS NOT NULL OR requested_ot_minutes IS NOT NULL OR clock_changes IS NOT NULL
);
--> statement-breakpoint
-- Shared database backstop for synthetic corrections and status-only payroll protection.
CREATE FUNCTION app.can_correct_attendance(subject_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS (
  SELECT 1 FROM employment subject
  WHERE subject.id=subject_id AND subject.tenant_id=app.current_tenant_id()
    AND (
     app.is_admin_for(subject.company_id)
     OR EXISTS (
      SELECT 1 FROM app_user caller
      WHERE caller.id=app.current_user_id() AND caller.tenant_id=subject.tenant_id
        AND caller.person_id IS NOT NULL AND caller.person_id<>subject.person_id
        AND (
         EXISTS (
          SELECT 1 FROM reporting_line line JOIN employment manager ON manager.id=line.manager_employment_id
          WHERE line.subordinate_employment_id=subject.id AND manager.person_id=caller.person_id
            AND line.line_type='administrative' AND line.superseded_at IS NULL
            AND line.valid_from<=current_date AND (line.valid_to IS NULL OR line.valid_to>current_date)
         ) OR app.can_decide_via_delegation(subject.id,'attendance','attendance.correction')
        )
     )
    )
 );
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.can_correct_attendance(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.can_correct_attendance(uuid) TO ai_hr_app;--> statement-breakpoint

-- Managers must not read payslips to protect attendance already used by payroll.
-- Return only run status and cut-off configuration; never expose pay or bank data.
-- Lock every existing company run (including draft) before inspecting slip membership,
-- so payroll generation/closing and a correction serialize on the same batch rows.
CREATE FUNCTION app.attendance_payroll_protection(subject_id uuid)
RETURNS TABLE(batch_id uuid, status text, pay_period text, policy_config jsonb, attendance_cutoff_day integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE subject employment;
BEGIN
 IF NOT app.can_correct_attendance(subject_id) THEN RAISE EXCEPTION 'Attendance correction authority required'; END IF;
 SELECT * INTO STRICT subject FROM employment WHERE id=subject_id AND tenant_id=app.current_tenant_id();
 PERFORM b.id FROM payroll_batch b WHERE b.tenant_id=subject.tenant_id AND b.company_id=subject.company_id ORDER BY b.id FOR UPDATE;
 RETURN QUERY
 SELECT b.id,b.status::text,b.pay_period::text,
        CASE WHEN policy.status='active' THEN jsonb_build_object('cutOff',policy.config->'cutOff','frequency',policy.config->'frequency') ELSE NULL END,
        cfg.attendance_cut_off_day
 FROM payroll_batch b
 LEFT JOIN company_payroll_config cfg ON cfg.company_id=subject.company_id AND cfg.tenant_id=subject.tenant_id
 LEFT JOIN payroll_policy policy ON policy.id=coalesce(subject.payroll_policy_id,cfg.default_payroll_policy_id) AND policy.tenant_id=subject.tenant_id
 WHERE b.tenant_id=subject.tenant_id AND b.company_id=subject.company_id AND b.status IN ('processed','closed')
   AND EXISTS(SELECT 1 FROM payslip ps WHERE ps.batch_id=b.id AND ps.employment_id=subject.id AND ps.tenant_id=subject.tenant_id)
 ORDER BY b.id;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_payroll_protection(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.attendance_payroll_protection(uuid) TO ai_hr_app;--> statement-breakpoint

-- Mark only an unclosed run containing this authorised subject, without returning
-- any payslip or another employee's recalculation membership to the approver.
CREATE FUNCTION app.mark_attendance_payroll_recalc(subject_id uuid, wanted_batch uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT app.can_correct_attendance(subject_id) THEN RAISE EXCEPTION 'Attendance correction authority required'; END IF;
 UPDATE payroll_batch b SET
  needs_recalc_at=coalesce(b.needs_recalc_at,now()),
  recalc_employment_ids=CASE WHEN coalesce(b.recalc_employment_ids,'[]'::jsonb) @> jsonb_build_array(subject_id::text)
   THEN b.recalc_employment_ids ELSE coalesce(b.recalc_employment_ids,'[]'::jsonb)||jsonb_build_array(subject_id::text) END
 WHERE b.id=wanted_batch AND b.tenant_id=app.current_tenant_id() AND b.status='processed'
   AND EXISTS(SELECT 1 FROM payslip ps WHERE ps.batch_id=b.id AND ps.employment_id=subject_id AND ps.tenant_id=b.tenant_id);
 RETURN FOUND;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.mark_attendance_payroll_recalc(uuid,uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.mark_attendance_payroll_recalc(uuid,uuid) TO ai_hr_app;--> statement-breakpoint

-- A synthetic correction is not an employee receipt. Keep the original capture
-- checks and legacy anchor exception; only authorised admin-method punches differ.
CREATE OR REPLACE FUNCTION app.attendance_capture_punch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE cap attendance_clock_capture;
BEGIN
 IF NEW.clock_capture_id IS NOT NULL THEN
  SELECT * INTO cap FROM attendance_clock_capture WHERE id=NEW.clock_capture_id;
  IF NOT FOUND OR cap.tenant_id<>NEW.tenant_id OR cap.employment_id<>NEW.employment_id OR cap.attendance_date<>NEW.attendance_date OR cap.direction<>NEW.direction OR NEW.method<>'web' THEN
   RAISE EXCEPTION 'Invalid attendance capture reference';
  END IF;
 ELSIF current_user='ai_hr_app' AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND app.is_admin_for(e.company_id)) THEN
  IF NOT (
   (NEW.method::text='admin' AND app.can_correct_attendance(NEW.employment_id))
   OR
   (NEW.direction='in' AND EXISTS(SELECT 1 FROM attendance a WHERE a.id=NEW.attendance_id AND a.check_in_at=NEW.punch_at AND NOT EXISTS(SELECT 1 FROM attendance_punch p WHERE p.attendance_id=a.id)) AND EXISTS(SELECT 1 FROM attendance_clock_capture c WHERE c.employment_id=NEW.employment_id AND c.attendance_date=NEW.attendance_date AND c.direction='out' AND c.server_recorded_at>=statement_timestamp()-interval '5 seconds'))
  ) THEN
   RAISE EXCEPTION 'Employee clocking requires a photo capture';
  END IF;
 END IF;
 RETURN NEW;
END $$;
