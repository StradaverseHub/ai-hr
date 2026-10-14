-- Nullable evidence: historical missing locations remain unknown. No backfill inference.
ALTER TABLE attendance_clock_capture ADD COLUMN location_capture_status text;
ALTER TABLE attendance_clock_capture ADD COLUMN geofencing_required boolean;
ALTER TABLE attendance_correction ADD COLUMN removal_punch_id uuid REFERENCES attendance_punch(id);
-- Service validates coordinate/status consistency; erasure may clear coordinates independently.
ALTER TABLE attendance_clock_capture ADD CONSTRAINT attendance_capture_location_status CHECK
  (location_capture_status IS NULL OR location_capture_status IN ('recorded','denied','unavailable','timeout','unsupported'));

--> statement-breakpoint
-- One private coverage/locking owner, consumed through separately authorized entry points.
CREATE OR REPLACE FUNCTION app.attendance_payroll_protection_rows(subject_id uuid)
RETURNS TABLE(batch_id uuid, status text, pay_period text, policy_config jsonb, attendance_cutoff_day integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE subject employment;
BEGIN
 SELECT * INTO STRICT subject FROM employment WHERE id=subject_id AND tenant_id=app.current_tenant_id();
 -- Include former assignment companies even before a draft has generated its first payslip.
 -- Membership also covers older runs whose original placement predates dated entity history.
 PERFORM b.id FROM payroll_batch b
 WHERE b.tenant_id=subject.tenant_id AND (
  b.company_id=subject.company_id
  OR EXISTS (SELECT 1 FROM assignment a LEFT JOIN department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id
             WHERE a.tenant_id=subject.tenant_id AND a.employment_id=subject.id AND coalesce(a.company_id,d.company_id)=b.company_id)
  OR EXISTS (SELECT 1 FROM payslip ps WHERE ps.tenant_id=subject.tenant_id AND ps.batch_id=b.id AND ps.employment_id=subject.id)
 ) ORDER BY b.id FOR UPDATE;
 RETURN QUERY
 SELECT b.id,b.status::text,b.pay_period::text,
        CASE WHEN policy.status='active' THEN jsonb_build_object('cutOff',policy.config->'cutOff','frequency',policy.config->'frequency') ELSE NULL END,
        cfg.attendance_cut_off_day
 FROM payroll_batch b
 LEFT JOIN company_payroll_config cfg ON cfg.company_id=b.company_id AND cfg.tenant_id=subject.tenant_id
 -- A newly assigned destination-company policy cannot change an earlier employer's cut-off.
 LEFT JOIN payroll_policy assigned ON assigned.id=subject.payroll_policy_id AND assigned.tenant_id=subject.tenant_id AND assigned.company_id=b.company_id
 LEFT JOIN payroll_policy policy ON policy.id=coalesce(assigned.id,cfg.default_payroll_policy_id) AND policy.tenant_id=subject.tenant_id AND policy.company_id=b.company_id
 WHERE b.tenant_id=subject.tenant_id AND b.status IN ('processed','closed')
   AND EXISTS (SELECT 1 FROM payslip ps WHERE ps.batch_id=b.id AND ps.employment_id=subject.id AND ps.tenant_id=subject.tenant_id)
 ORDER BY b.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_payroll_protection_rows(uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_payroll_protection(subject_id uuid)
RETURNS TABLE(batch_id uuid, status text, pay_period text, policy_config jsonb, attendance_cutoff_day integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT app.can_correct_attendance(subject_id) THEN RAISE EXCEPTION 'Attendance correction authority required'; END IF;
 RETURN QUERY SELECT * FROM app.attendance_payroll_protection_rows(subject_id);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_payroll_protection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_payroll_protection(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.own_attendance_removal_payroll_protection(subject_id uuid)
RETURNS TABLE(batch_id uuid, status text, pay_period text, policy_config jsonb, attendance_cutoff_day integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
   WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
     AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
     AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 ) THEN RAISE EXCEPTION 'Active own employment required'; END IF;
 RETURN QUERY SELECT * FROM app.attendance_payroll_protection_rows(subject_id);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.own_attendance_removal_payroll_protection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.own_attendance_removal_payroll_protection(uuid) TO ai_hr_app;
