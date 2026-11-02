-- BK19: anomaly facts and working notes retain the native payroll-employment audience,
-- including events already in the immutable ledger. Other event audiences are unchanged.
CREATE POLICY anomaly_event_private_read ON public.domain_event AS RESTRICTIVE FOR SELECT TO ai_hr_app
USING (
 event_type NOT IN ('payroll.anomaly.flagged','payroll.anomaly.resolved')
 OR (app.principal_snapshot_current() AND subject_employment_id IS NOT NULL
     AND app.can_admin_payroll_employment(subject_employment_id))
);
