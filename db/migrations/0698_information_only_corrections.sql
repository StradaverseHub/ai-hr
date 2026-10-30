-- ADR-0163. Append-only metadata preserves persisted payroll outputs before an information-only correction.
CREATE TABLE information_payslip_snapshot (
 payslip_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenant(id),
 employment_id uuid NOT NULL REFERENCES employment(id),company_id uuid NOT NULL REFERENCES company(id),
 grade text,employment_type text,hired_on date NOT NULL,join_date date,document_metadata jsonb NOT NULL CHECK(jsonb_typeof(document_metadata)='object'),
 recorded_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE information_payslip_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE information_payslip_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY information_snapshot_read ON information_payslip_snapshot FOR SELECT USING(
 tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND (app.can_admin_payroll_for(company_id) OR EXISTS(SELECT 1 FROM payslip p WHERE p.id=information_payslip_snapshot.payslip_id AND p.employment_id=information_payslip_snapshot.employment_id)));
CREATE POLICY information_snapshot_insert ON information_payslip_snapshot FOR INSERT WITH CHECK(
 tenant_id=app.current_tenant_id() AND recorded_by=app.current_user_id() AND app.principal_snapshot_current()
 AND app.is_admin_for(company_id) AND app.access_workforce_employment(employment_id,'workforce.maintain')
 AND EXISTS(SELECT 1 FROM payslip p JOIN payroll_batch b ON b.id=p.batch_id WHERE p.id=information_payslip_snapshot.payslip_id AND p.employment_id=information_payslip_snapshot.employment_id AND b.company_id=information_payslip_snapshot.company_id));
REVOKE ALL ON information_payslip_snapshot FROM PUBLIC,ai_hr_app;
GRANT SELECT ON information_payslip_snapshot TO ai_hr_app;
CREATE TRIGGER information_snapshot_immutable BEFORE UPDATE OR DELETE ON information_payslip_snapshot FOR EACH ROW EXECUTE FUNCTION app.import_attempt_immutable();
--> statement-breakpoint
ALTER TABLE import_attempt DROP CONSTRAINT import_attempt_kind_check;
ALTER TABLE import_attempt ADD CONSTRAINT import_attempt_kind_check CHECK(kind IN ('cost_allocations','bank_statutory','employee_full','movement','information_correction'));
CREATE OR REPLACE FUNCTION app.import_company_access(p_kind text,p_company uuid,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_company IS NOT NULL AND p_operation IN ('view','maintain')
 AND p_kind IN ('cost_allocations','bank_statutory','employee_full','movement','information_correction')
 AND app.access_workforce_company(p_company,'workforce.'||p_operation)
 AND (p_kind<>'information_correction' OR app.is_admin_for(p_company));
$$;
REVOKE ALL ON FUNCTION app.import_company_access(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_company_access(text,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Correction imports contain both source and destination facts. Read them only while both remain authorised.
CREATE FUNCTION app.information_import_history_access(p_attempt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM import_attempt a WHERE a.id=p_attempt AND a.tenant_id=app.current_tenant_id()
 AND (a.kind<>'information_correction' OR app.import_attempt_access(a.id,'view',true)));
$$;
REVOKE ALL ON FUNCTION app.information_import_history_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.information_import_history_access(uuid) TO ai_hr_app;
CREATE POLICY information_attempt_scope ON import_attempt AS RESTRICTIVE FOR SELECT USING(
 kind<>'information_correction' OR (app.principal_snapshot_current() AND CASE WHEN cardinality(company_ids)=0 THEN created_by=app.current_user_id()
 ELSE NOT EXISTS(SELECT 1 FROM unnest(company_ids) c WHERE NOT app.import_company_access(kind,c,'view')) END));
CREATE POLICY information_item_scope ON import_attempt_item AS RESTRICTIVE FOR SELECT USING(app.information_import_history_access(attempt_id));
CREATE POLICY information_event_scope ON import_attempt_event AS RESTRICTIVE FOR SELECT USING(app.information_import_history_access(attempt_id));
--> statement-breakpoint
-- Fixed metadata-only command. HR need not read salary amounts to preserve every historical output.
-- Values come from the locked canonical records, never from the caller. No payroll transaction is updated.
CREATE FUNCTION app.preserve_information_payroll(p_employment uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment%ROWTYPE; a public.assignment%ROWTYPE; n integer;
BEGIN
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.principal_snapshot_current() OR app.current_user_id() IS NULL
 OR NOT app.is_admin_for(e.company_id) OR NOT app.access_workforce_employment(e.id,'workforce.maintain') THEN
  RAISE EXCEPTION 'Information correction unavailable' USING ERRCODE='42501';
 END IF;
 IF NOT app.information_payroll_ready(e.id) THEN RAISE EXCEPTION 'Historical original information requires reconciliation'; END IF;
 SELECT * INTO STRICT a FROM public.assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND valid_to IS NULL AND superseded_at IS NULL;
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
-- A current master value is not evidence of an old issued document after intervening changes.
-- Such legacy outputs require independently verified snapshot reconciliation before correction.
CREATE FUNCTION app.information_payroll_ready(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
 AND app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND app.is_admin_for(e.company_id)
 AND app.access_workforce_employment(e.id,'workforce.maintain')
 AND NOT EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
 WHERE p.employment_id=e.id AND NOT EXISTS(SELECT 1 FROM public.information_payslip_snapshot f WHERE f.payslip_id=p.id)
 AND EXISTS(SELECT 1 FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id
 AND ev.occurred_at>coalesce(b.closed_at,b.created_at)
 AND ((ev.subject_employment_id=e.id AND ev.event_type IN ('employment.grade.changed','employment.info.updated','employment.company.transferred','employment.company.changed','employment.company.transfer.reverted','employment.assignment.changed','assignment.transferred','employment.hire.corrected','employment.information.corrected'))
 OR (ev.aggregate_type='job-grade' AND ev.aggregate_id=e.grade_id AND ev.event_type IN ('job-grade.updated','job-grade.archived','job-grade.deleted'))))));
$$;
REVOKE ALL ON FUNCTION app.information_payroll_ready(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.information_payroll_ready(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Shared pure SQL status owner, also called by core/employment-status-sql.ts.
CREATE FUNCTION app.employment_status_on(p_blacklisted timestamptz,p_resignation date,p_last date,p_terminated date,p_final date,p_confirmation date,p_probation date,p_provisional date,p_day date) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN p_blacklisted IS NOT NULL THEN 'blacklisted'
 WHEN least(p_resignation,p_last,p_terminated) IS NOT NULL AND p_day>=least(p_resignation,p_last,p_terminated) THEN 'resigned'
 WHEN least(p_resignation,p_last,p_terminated) IS NOT NULL THEN 'active_serving_notice'
 WHEN app.employment_confirmation_date(p_final,p_confirmation,p_probation,p_provisional) IS NOT NULL AND p_day<app.employment_confirmation_date(p_final,p_confirmation,p_probation,p_provisional) THEN 'probation' ELSE 'active' END;
$$;
REVOKE ALL ON FUNCTION app.employment_status_on(timestamptz,date,date,date,date,date,date,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employment_status_on(timestamptz,date,date,date,date,date,date,date,date) TO ai_hr_app;
--> statement-breakpoint
-- Internal fixed metadata projection. No salaries, transaction amounts or caller-supplied JSON.
CREATE FUNCTION app.information_document_metadata(p_payslip uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
 'employeeName',p.full_name,'employee',p.full_name,'employeeCode',e.employee_code,
 'company',c.legal_name,'companyReg',c.registration_no,'currency',c.currency,
 'cycleName',CASE WHEN b.history_import_attempt_id IS NOT NULL THEN b.history_import_cycle_name||' - By Import' ELSE pc.name END,
 'informationFields',s.fields,'businessUnit',bu.name,'department',d.name,'position',pos.title,'jobGrade',g.name,'employmentType',a.employment_type,
 'division',e.org_division,'branch',e.org_branch,'region',e.org_region,'line',e.org_line,'section',e.org_section,'team',e.org_team,'base',e.org_base,'category',e.employment_category,
 'paymentMethod',e.payment_method,'bankName',st.bank_name,'bankAccountNo',st.bank_account_no,
 'icNumber',st.ic_number,'passportNumber',st.passport_number,'epfNumber',st.epf_number,'socsoNumber',st.socso_number,'taxNumber',st.tax_number,
 'employmentStatus',app.employment_status_on(e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on,e.final_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on,(now() at time zone 'Asia/Kuala_Lumpur')::date))
 FROM public.payslip sl JOIN public.payroll_batch b ON b.id=sl.batch_id AND b.tenant_id=sl.tenant_id
 JOIN public.employment e ON e.id=sl.employment_id AND e.tenant_id=sl.tenant_id JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company c ON c.id=b.company_id AND c.tenant_id=b.tenant_id
 LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
 LEFT JOIN public.department d ON d.id=a.department_id LEFT JOIN public.position pos ON pos.id=a.position_id
 LEFT JOIN public.business_unit bu ON bu.id=a.business_unit_id LEFT JOIN public.job_grade g ON g.id=e.grade_id
 LEFT JOIN public.employee_statutory_my st ON st.person_id=e.person_id AND st.tenant_id=e.tenant_id
 LEFT JOIN public.payroll_cycle pc ON pc.id=b.payroll_cycle_id LEFT JOIN public.payslip_information_setting s ON s.company_id=b.company_id
 WHERE sl.id=p_payslip AND sl.tenant_id=app.current_tenant_id();
$$;
REVOKE ALL ON FUNCTION app.information_document_metadata(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Salary-document authority follows its paying company, without granting Workforce access to the
-- employee's current destination profile. Self access retains the ordinary closed/released gate.
CREATE FUNCTION app.information_payslip_document(p_payslip uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',f.document_metadata||jsonb_build_object('jobGrade',f.grade,'employmentType',f.employment_type),
 'batch',to_jsonb(b),'payslip',to_jsonb(p)||jsonb_build_object(
 'basic_salary',p.basic_salary::text,'allowance',p.allowance::text,'overtime_pay',p.overtime_pay::text,'bonus',p.bonus::text,
 'gross_pay',p.gross_pay::text,'other_deductions',p.other_deductions::text,'total_deductions',p.total_deductions::text,
 'net_pay',p.net_pay::text,'employer_cost',p.employer_cost::text,'days_worked',p.days_worked::text))
 FROM public.information_payslip_snapshot f JOIN public.payslip p ON p.id=f.payslip_id AND p.employment_id=f.employment_id AND p.tenant_id=f.tenant_id
 JOIN public.payroll_batch b ON b.id=p.batch_id AND b.company_id=f.company_id AND b.tenant_id=f.tenant_id
 JOIN public.employment e ON e.id=p.employment_id AND e.tenant_id=f.tenant_id
 WHERE p.id=p_payslip AND f.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND (app.payroll_history_effective(p.id) OR app.payroll_history_self_issued(p.id))
 AND (app.can_admin_payroll_for(b.company_id) OR (app.is_self_person(e.person_id) AND b.status='closed' AND (b.released_at IS NULL OR b.released_at<=now())));
$$;
REVOKE ALL ON FUNCTION app.information_payslip_document(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.information_payslip_document(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The same imported-history cycle filter used by normal and retained payroll lists.
CREATE FUNCTION app.payroll_filter_run_type(p_import uuid,p_stored text,p_configured text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_import IS NOT NULL THEN coalesce(p_configured,p_stored) ELSE p_stored END $$;
REVOKE ALL ON FUNCTION app.payroll_filter_run_type(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_filter_run_type(uuid,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.information_payslip_documents(p_companies uuid[],p_year integer,p_month integer,p_cycle text,p_employment uuid DEFAULT NULL,p_intended boolean DEFAULT false) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT document FROM public.information_payslip_snapshot f JOIN public.payslip p ON p.id=f.payslip_id AND p.tenant_id=f.tenant_id
 JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=f.tenant_id
 CROSS JOIN LATERAL (SELECT app.information_payslip_document(p.id) AS document) value
 WHERE f.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND cardinality(p_companies)<=100
 AND b.company_id=ANY(p_companies) AND app.can_admin_payroll_for(b.company_id)
 AND (p_employment IS NULL OR p.employment_id=p_employment)
 AND (p_year IS NULL OR left(b.pay_period,4)=p_year::text) AND (p_month IS NULL OR substring(b.pay_period,6,2)=lpad(p_month::text,2,'0'))
 AND (p_cycle IS NULL OR (CASE WHEN p_intended THEN app.payroll_filter_run_type(b.history_import_attempt_id,b.run_type::text,(select pc.run_type::text from public.payroll_cycle pc where pc.id=b.payroll_cycle_id)) ELSE b.run_type::text END)=p_cycle) AND document IS NOT NULL
 ORDER BY b.pay_period DESC,b.run_seq,p.id LIMIT 5001;
$$;
REVOKE ALL ON FUNCTION app.information_payslip_documents(uuid[],integer,integer,text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.information_payslip_documents(uuid[],integer,integer,text,uuid,boolean) TO ai_hr_app;

--> statement-breakpoint
-- Report-only fixed projections supplement missing former-employer sources. The underlying Workforce
-- tables and their RLS stay unchanged. Canonical transactions remain the sole financial source.
CREATE FUNCTION app.information_report_records(p_kind text,p_company uuid,p_period text) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_kind NOT IN ('employment','person','employee_statutory_my','payslip','assignment','tp1_relief','ea_override')
 OR p_period !~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$' OR NOT app.principal_snapshot_current() THEN RETURN; END IF;
 RETURN QUERY
 SELECT item FROM public.information_payslip_snapshot f
 JOIN public.payslip sl ON sl.id=f.payslip_id AND sl.employment_id=f.employment_id AND sl.tenant_id=f.tenant_id
 JOIN public.payroll_batch b ON b.id=sl.batch_id AND b.company_id=f.company_id AND b.tenant_id=f.tenant_id
 JOIN public.employment e ON e.id=f.employment_id AND e.tenant_id=f.tenant_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 LEFT JOIN public.employee_statutory_my st ON st.person_id=e.person_id AND st.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT ev.payload->'before' AS value FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>CASE WHEN length(p_period)=4 THEN p_period||'-12-31' ELSE p_period||'-01' END ORDER BY ev.sequence LIMIT 1) prior ON true
 CROSS JOIN LATERAL jsonb_array_elements(CASE p_kind
 WHEN 'employment' THEN jsonb_build_array(jsonb_build_object('id',e.id,'tenant_id',e.tenant_id,'person_id',e.person_id,
 'company_id',coalesce(prior.value->>'companyId',e.company_id::text),'employee_code',f.document_metadata->>'employeeCode',
 'hired_on',coalesce(prior.value->>'hiredOn',e.hired_on::text),'join_date',CASE WHEN prior.value IS NOT NULL THEN prior.value->>'joinDate' ELSE e.join_date::text END,
 'terminated_on',e.terminated_on,'termination_type',e.termination_type))
 WHEN 'person' THEN jsonb_build_array(jsonb_build_object('id',p.id,'tenant_id',p.tenant_id,'full_name',f.document_metadata->>'employeeName','nationality',p.nationality))
 WHEN 'employee_statutory_my' THEN jsonb_build_array(jsonb_build_object('person_id',st.person_id,'tenant_id',st.tenant_id,'ic_number',st.ic_number,'passport_number',st.passport_number,
 'tax_number',st.tax_number,'epf_number',st.epf_number,'socso_number',st.socso_number,'tax_category',st.tax_category,'num_children',st.num_children,'child_relief_mode',st.child_relief_mode,'child_relief_table',st.child_relief_table,
 'epf_citizenship',st.epf_citizenship,'old_ic_number',st.old_ic_number,'passport_issuing_country_code',st.passport_issuing_country_code))
 WHEN 'payslip' THEN jsonb_build_array(app.information_payslip_document(sl.id)->'payslip')
 WHEN 'assignment' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'tenant_id',a.tenant_id,'employment_id',a.employment_id,'position_id',a.position_id,'valid_from',a.valid_from,'valid_to',a.valid_to,'superseded_at',a.superseded_at) ORDER BY a.valid_from,a.id)
 FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.valid_from<=CASE WHEN length(p_period)=4 THEN (p_period||'-12-31')::date ELSE (p_period||'-01')::date END),'[]'::jsonb)
 WHEN 'tp1_relief' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'tenant_id',r.tenant_id,'person_id',r.person_id,'deduction_month',r.deduction_month,'approved_month',r.approved_month,'created_at',r.created_at,'tp1_amount',r.tp1_amount::text,'categories',r.categories,'assessment_year',r.assessment_year,'status',r.status) ORDER BY r.created_at,r.id)
 FROM public.tp1_relief r WHERE r.tenant_id=e.tenant_id AND r.person_id=e.person_id AND r.assessment_year=left(p_period,4)::integer AND r.status='approved'),'[]'::jsonb)
 WHEN 'ea_override' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'tenant_id',r.tenant_id,'employment_id',r.employment_id,'year',r.year,'field',r.field,'amount',r.amount::text,'reason',r.reason) ORDER BY r.field)
 FROM public.ea_override r WHERE r.tenant_id=e.tenant_id AND r.employment_id=e.id AND r.year=left(p_period,4)),'[]'::jsonb)
 ELSE '[]'::jsonb END) item
 WHERE f.tenant_id=app.current_tenant_id() AND (p_company IS NULL OR b.company_id=p_company)
 AND left(b.pay_period,length(p_period))=p_period AND app.can_admin_payroll_for(b.company_id)
 AND app.information_payslip_document(sl.id) IS NOT NULL
 ORDER BY b.pay_period DESC,b.run_seq DESC,sl.id;
END $$;
REVOKE ALL ON FUNCTION app.information_report_records(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.information_report_records(text,uuid,text) TO ai_hr_app;

--> statement-breakpoint
-- The existing signatory owner retains its self/effective-year rules, with the same retained paying-company authority.
CREATE OR REPLACE FUNCTION app.ea_signatory(p_employment_id uuid, p_company_id uuid, p_year text)
RETURNS TABLE(officer_name text, officer_position text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT sp.full_name, title.title
  FROM public.employment subject
  JOIN public.company co ON co.id = p_company_id AND co.tenant_id = subject.tenant_id
  JOIN public.company_statutory_authority auth
    ON auth.company_id = co.id AND auth.tenant_id = co.tenant_id AND auth.authority = 'lhdn'
  JOIN public.person sp ON sp.id = auth.signatory_person_id AND sp.tenant_id = co.tenant_id
  LEFT JOIN LATERAL (
    SELECT pos.title
    FROM public.employment se
    JOIN public.assignment a ON a.employment_id = se.id AND a.tenant_id = se.tenant_id
    JOIN public.position pos ON pos.id = a.position_id AND pos.tenant_id = se.tenant_id
    WHERE se.person_id = sp.id AND se.company_id = co.id AND se.tenant_id = co.tenant_id
      AND se.hired_on <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (se.terminated_on IS NULL OR se.terminated_on >= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND a.superseded_at IS NULL
      AND a.valid_from <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (a.valid_to IS NULL OR a.valid_to > (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND COALESCE(a.company_id, se.company_id) = co.id
    ORDER BY a.valid_from DESC, se.hired_on DESC, a.id
    LIMIT 1
  ) title ON true
  WHERE subject.id = p_employment_id AND subject.tenant_id = app.current_tenant_id()
    AND p_year ~ '^[0-9]{4}$'
    AND (
      EXISTS (SELECT 1 FROM public.app_user u
        WHERE u.id = app.current_user_id() AND u.tenant_id = subject.tenant_id AND u.person_id = subject.person_id)
      OR (app.can_admin_payroll_for(co.id) AND (app.can_admin_payroll_for(subject.company_id)
        OR EXISTS(SELECT 1 FROM public.information_payslip_snapshot f
          JOIN public.payslip sl ON sl.id=f.payslip_id AND sl.employment_id=f.employment_id AND sl.tenant_id=f.tenant_id
          JOIN public.payroll_batch b ON b.id=sl.batch_id AND b.company_id=f.company_id AND b.tenant_id=f.tenant_id
          WHERE f.employment_id=subject.id AND f.tenant_id=subject.tenant_id AND b.company_id=co.id
          AND b.pay_period LIKE p_year||'-%' AND app.information_payslip_document(sl.id) IS NOT NULL)))
    )
    AND (subject.company_id = co.id OR EXISTS (
      SELECT 1 FROM public.payslip ps
      JOIN public.payroll_batch pb ON pb.id = ps.batch_id AND pb.tenant_id = ps.tenant_id
      WHERE app.payroll_history_effective(ps.id) AND ps.employment_id = subject.id AND ps.tenant_id = subject.tenant_id
        AND pb.company_id = co.id AND pb.pay_period LIKE p_year || '-%'
    ));
$$;
