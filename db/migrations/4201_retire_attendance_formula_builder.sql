-- Preserve immutable evidence and the canonical draft reversal paths while fencing old writers.
CREATE FUNCTION app.reject_retired_attendance_formula_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 RAISE EXCEPTION 'Attendance Formula Builder has been retired' USING ERRCODE='check_violation';
END $$;
REVOKE ALL ON FUNCTION app.reject_retired_attendance_formula_write() FROM PUBLIC;

DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY[
  'attendance_formula','attendance_formula_revision','attendance_formula_test','attendance_formula_event',
  'attendance_formula_result','attendance_formula_ot_binding','attendance_formula_ot_binding_result',
  'attendance_formula_ot_binding_day'
 ] LOOP
  EXECUTE format('REVOKE INSERT ON public.%I FROM ai_hr_app',relation);
  EXECUTE format('CREATE TRIGGER aa_retired_attendance_formula_insert BEFORE INSERT ON public.%I
   FOR EACH ROW EXECUTE FUNCTION app.reject_retired_attendance_formula_write()',relation);
 END LOOP;
END $$;

CREATE TRIGGER aa_retired_attendance_formula_event BEFORE INSERT ON public.attendance_formula_result_event
 FOR EACH ROW WHEN (NEW.kind <> 'reversed') EXECUTE FUNCTION app.reject_retired_attendance_formula_write();
CREATE TRIGGER aa_retired_attendance_formula_allowance_insert BEFORE INSERT ON public.payroll_attendance_allowance_source
 FOR EACH ROW WHEN (NEW.formula_result_id IS NOT NULL) EXECUTE FUNCTION app.reject_retired_attendance_formula_write();
CREATE TRIGGER aa_retired_attendance_formula_overtime_insert BEFORE INSERT ON public.overtime_source_settlement
 FOR EACH ROW WHEN (NEW.formula_binding_id IS NOT NULL) EXECUTE FUNCTION app.reject_retired_attendance_formula_write();
--> statement-breakpoint

-- This reader now resolves an exact retained result only. A bookmarked old client can no
-- longer use it to discover live versions, eligibility or potential calculation conflicts.
CREATE OR REPLACE FUNCTION app.attendance_formula_subject_versions(
 p_company uuid,p_employment uuid,p_date date,p_formula uuid DEFAULT NULL,p_result uuid DEFAULT NULL,
 p_item uuid DEFAULT NULL,p_include_overtime boolean DEFAULT false
) RETURNS SETOF public.attendance_formula_revision
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
 SELECT (jsonb_populate_record(v,jsonb_build_object('company_id',p_company,'created_by',NULL,'definition',
  (v.definition-'companyScope')||jsonb_build_object('companyId',p_company::text,'eligibility',
   CASE WHEN v.definition->'eligibility'->>'mode'='selected'
    THEN jsonb_build_object('mode','selected','employmentIds',jsonb_build_array(p_employment::text))
    ELSE v.definition->'eligibility' END)))).*
 FROM public.attendance_formula_result result
 JOIN public.attendance_formula f ON f.id=result.formula_id AND f.tenant_id=result.tenant_id
 JOIN public.attendance_formula_revision v ON v.id=result.revision_id AND v.tenant_id=result.tenant_id
 WHERE result.id=p_result AND result.tenant_id=app.current_tenant_id()
  AND result.company_id=p_company AND result.employment_id=p_employment AND result.period_to=p_date
  AND (p_formula IS NULL OR f.id=p_formula)
  AND p_company=ANY(app.attendance_formula_companies(f.company_id,v.definition))
  AND (p_item IS NULL OR v.pay_component_id=p_item OR (p_include_overtime AND v.definition->>'purpose'='overtime'))
  AND app.attendance_formula_trace_access(p_company,p_employment,result.read_requirements)
 LIMIT 1
$$;
--> statement-breakpoint

-- The underlying check also runs for restricted payroll roles and sees all affected inputs of
-- the exact run. Keep it private. The public application entry point adds financial authority.
CREATE FUNCTION app.retired_attendance_formula_inputs_exist(p_tenant uuid,p_batch uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.payroll_attendance_allowance_source s
  WHERE s.tenant_id=p_tenant AND s.batch_id=p_batch AND s.formula_result_id IS NOT NULL
 ) OR EXISTS(
  SELECT 1 FROM public.overtime_source_settlement s
  WHERE s.tenant_id=p_tenant AND s.payroll_batch_id=p_batch AND s.formula_binding_id IS NOT NULL
   AND s.released_at IS NULL
 );
$$;
REVOKE ALL ON FUNCTION app.retired_attendance_formula_inputs_exist(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION app.payroll_has_retired_attendance_formula_inputs(p_batch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce((
  SELECT app.retired_attendance_formula_inputs_exist(b.tenant_id,b.id)
  FROM public.payroll_batch b
  WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id() AND b.status IN ('draft','processed')
   AND app.principal_snapshot_current() AND app.can_admin_payroll_for(b.company_id)
 ),false);
$$;
REVOKE ALL ON FUNCTION app.payroll_has_retired_attendance_formula_inputs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_has_retired_attendance_formula_inputs(uuid) TO ai_hr_app;

CREATE FUNCTION app.payroll_retired_attendance_formula_status_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF app.retired_attendance_formula_inputs_exist(OLD.tenant_id,OLD.id) THEN
  RAISE EXCEPTION 'Review and reverse retired Attendance Formula inputs before continuing this Payroll run.'
   USING ERRCODE='check_violation';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.payroll_retired_attendance_formula_status_guard() FROM PUBLIC;
CREATE TRIGGER payroll_retired_attendance_formula_status BEFORE UPDATE OF status ON public.payroll_batch
 FOR EACH ROW WHEN (
  (OLD.status='draft' AND NEW.status IN ('processed','closed'))
  OR (OLD.status='processed' AND NEW.status IN ('processed','closed'))
 ) EXECUTE FUNCTION app.payroll_retired_attendance_formula_status_guard();
--> statement-breakpoint

-- Hosts may use a migration owner subject to FORCE RLS. Give the private fixed-purpose
-- guards the same owner-only read policy used by the existing overtime coverage guard.
DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['payroll_batch','payroll_attendance_allowance_source','overtime_source_settlement'] LOOP
  EXECUTE format('CREATE POLICY retired_attendance_formula_guard_owner_read ON public.%I FOR SELECT USING (
   current_user=pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=%L::regprocedure))
   OR current_user=pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=%L::regprocedure))
  )',relation,'app.payroll_has_retired_attendance_formula_inputs(uuid)','app.payroll_retired_attendance_formula_status_guard()');
 END LOOP;
END $$;
--> statement-breakpoint

-- Retire the feature's AI Centre switches. Historical switch changes stay in the event log.
ALTER TABLE app.ai_centre_read_control NO FORCE ROW LEVEL SECURITY;
DELETE FROM app.ai_centre_read_control WHERE function_key IN (
 'read:operation_attendance_formula_draft','read:attendance_formula_library_guidance','read:attendance_formula_authoring_guidance'
);
ALTER TABLE app.ai_centre_read_control FORCE ROW LEVEL SECURITY;
DELETE FROM app.ai_centre_function_kind WHERE function_key IN (
 'read:operation_attendance_formula_draft','read:attendance_formula_library_guidance','read:attendance_formula_authoring_guidance'
);
