-- ADR-0164 revision 2. Preserve issued metadata before correcting an ended employment.
CREATE OR REPLACE FUNCTION app.preserve_information_payroll(p_employment uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment%ROWTYPE; a public.assignment%ROWTYPE; n integer; assignment_count integer;
BEGIN
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.principal_snapshot_current() OR app.current_user_id() IS NULL
 OR NOT app.is_admin_for(e.company_id) OR NOT app.access_workforce_employment(e.id,'workforce.maintain') THEN
  RAISE EXCEPTION 'Information correction unavailable' USING ERRCODE='42501';
 END IF;
 IF NOT app.information_payroll_ready(e.id) THEN RAISE EXCEPTION 'Historical original information requires reconciliation'; END IF;
 -- An ended employment legitimately has no open assignment. Retain exactly the nullable
 -- metadata the existing document reader showed; never guess an old assignment as current.
 SELECT count(*) INTO assignment_count FROM public.assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND valid_to IS NULL AND superseded_at IS NULL;
 IF assignment_count>1 OR (assignment_count=0 AND e.terminated_on IS NULL) THEN
  RAISE EXCEPTION 'Historical assignment evidence requires reconciliation';
 END IF;
 SELECT * INTO a FROM public.assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND valid_to IS NULL AND superseded_at IS NULL;
 IF EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
 WHERE p.employment_id=e.id AND (p.tenant_id<>e.tenant_id OR b.tenant_id<>e.tenant_id OR NOT app.is_admin_for(b.company_id))) THEN
  RAISE EXCEPTION 'Historical payroll company permission is required' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.information_payslip_snapshot(payslip_id,tenant_id,employment_id,company_id,grade,employment_type,hired_on,join_date,document_metadata,recorded_by)
 SELECT p.id,e.tenant_id,e.id,b.company_id,g.name,a.employment_type::text,e.hired_on,e.join_date,app.information_document_metadata(p.id),app.current_user_id()
 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
 LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 WHERE p.employment_id=e.id ON CONFLICT(payslip_id) DO NOTHING;
 SELECT count(*) INTO n FROM public.payslip WHERE employment_id=e.id;
 IF n<>(SELECT count(*) FROM public.information_payslip_snapshot WHERE employment_id=e.id) THEN
  RAISE EXCEPTION 'Historical metadata coverage is incomplete';
 END IF;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.preserve_information_payroll(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.preserve_information_payroll(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.information_payroll_ready(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
 AND app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND app.is_admin_for(e.company_id)
 AND app.access_workforce_employment(e.id,'workforce.maintain')
 AND NOT EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
 WHERE p.employment_id=e.id AND NOT EXISTS(SELECT 1 FROM public.information_payslip_snapshot f WHERE f.payslip_id=p.id)
 AND EXISTS(SELECT 1 FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id
 AND ev.occurred_at>coalesce(b.closed_at,b.created_at)
 AND ((ev.subject_employment_id=e.id AND ev.event_type IN ('employment.grade.changed','employment.info.updated','employment.company.transferred','employment.company.changed','employment.company.transfer.reverted','employment.assignment.changed','assignment.transferred','employment.hire.corrected','employment.information.corrected','employment.terminated','employment.termination.reversed','employment.blacklisted','employment.blacklist.cleared'))
 OR (ev.aggregate_type='job-grade' AND ev.aggregate_id=e.grade_id AND ev.event_type IN ('job-grade.updated','job-grade.archived','job-grade.deleted'))))));
$$;
REVOKE ALL ON FUNCTION app.information_payroll_ready(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.information_payroll_ready(uuid) TO ai_hr_app;
