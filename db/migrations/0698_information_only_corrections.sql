-- ADR-0163. Append-only metadata preserves persisted payroll outputs before an information-only correction.
CREATE TABLE information_payslip_snapshot (
 payslip_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenant(id),
 employment_id uuid NOT NULL REFERENCES employment(id),company_id uuid NOT NULL REFERENCES company(id),
 grade text,employment_type text,hired_on date NOT NULL,join_date date,
 recorded_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE information_payslip_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE information_payslip_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY information_snapshot_read ON information_payslip_snapshot FOR SELECT USING(
 tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM payslip p WHERE p.id=information_payslip_snapshot.payslip_id AND p.employment_id=information_payslip_snapshot.employment_id));
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
 INSERT INTO public.information_payslip_snapshot(payslip_id,tenant_id,employment_id,company_id,grade,employment_type,hired_on,join_date,recorded_by)
 SELECT p.id,e.tenant_id,e.id,b.company_id,g.name,a.employment_type::text,e.hired_on,e.join_date,app.current_user_id()
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
