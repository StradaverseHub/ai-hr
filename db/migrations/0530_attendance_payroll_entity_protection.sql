-- A payslip retains its employment identity when that employment moves to another legal entity.
-- Current attendance authority protects those older runs without granting access to their payslips.
CREATE OR REPLACE FUNCTION app.attendance_payroll_protection(subject_id uuid)
RETURNS TABLE(batch_id uuid, status text, pay_period text, policy_config jsonb, attendance_cutoff_day integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE subject employment;
BEGIN
 IF NOT app.can_correct_attendance(subject_id) THEN RAISE EXCEPTION 'Attendance correction authority required'; END IF;
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
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_payroll_protection(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.attendance_payroll_protection(uuid) TO ai_hr_app;
