-- Detached open-native evidence uses the existing history owners; no live native payslip is frozen.
ALTER TABLE public.payroll_history_import_revision ADD COLUMN native_source jsonb;
ALTER TABLE public.payroll_history_import_revision ADD CONSTRAINT payroll_history_native_source_shape CHECK(native_source IS NULL OR (jsonb_typeof(native_source)='object' AND native_source->>'version'='1' AND native_source->>'sourceHash' ~ '^[0-9a-f]{64}$'));
--> statement-breakpoint
CREATE TABLE app.payroll_history_native_capture(
 snapshot_id uuid PRIMARY KEY REFERENCES public.payroll_history_import_snapshot(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),record_id uuid NOT NULL REFERENCES public.payroll_history_import_record(id),
 attempt_id uuid NOT NULL REFERENCES public.payroll_history_import_attempt(id),baseline_batch_id uuid NOT NULL REFERENCES public.payroll_batch(id) ON DELETE CASCADE,
 source_batch_id uuid NOT NULL,source_payslip_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL REFERENCES public.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(record_id)
);
CREATE INDEX payroll_history_native_capture_source ON app.payroll_history_native_capture(tenant_id,source_batch_id,record_id);
ALTER TABLE app.payroll_history_native_capture ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.payroll_history_native_capture FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_native_module() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.current_user_id() IS NOT NULL AND EXISTS(SELECT 1 FROM public.tenant t JOIN public.tenant_module m ON m.tenant_id=t.id
 WHERE t.id=app.current_tenant_id() AND t.status IN('active','trial') AND m.module_code='payroll' AND m.company_id IS NULL AND m.status IN('active','trial') AND m.activated_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now()))
$$;
CREATE FUNCTION app.payroll_history_native_permission(target uuid,permission text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH configured AS(SELECT role,allowed,company_id FROM public.payroll_permission_grant WHERE tenant_id=app.current_tenant_id() AND permission_key=permission AND (company_id=target OR company_id IS NULL)),
 effective AS(SELECT role,allowed FROM configured WHERE(company_id=target AND EXISTS(SELECT 1 FROM configured WHERE company_id=target)) OR(company_id IS NULL AND NOT EXISTS(SELECT 1 FROM configured WHERE company_id=target)))
 SELECT permission IN('payroll.history.import','payroll.history.revert') AND app.payroll_history_native_module() AND app.can_admin_payroll_for(target) AND
 CASE WHEN EXISTS(SELECT 1 FROM effective) THEN EXISTS(SELECT 1 FROM effective a WHERE a.allowed AND app.has_role_for(a.role,target) AND NOT EXISTS(SELECT 1 FROM effective d WHERE d.role=a.role AND NOT d.allowed)) ELSE app.has_role_for('hr_admin',target) OR app.has_role_for('super_admin',target) END
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_module(),app.payroll_history_native_permission(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_native_module(),app.payroll_history_native_permission(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_native_values(p public.payslip) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('basicSalary',p.basic_salary::text,'allowance',p.allowance::text,'overtimePay',p.overtime_pay::text,'bonus',p.bonus::text,'grossPay',p.gross_pay::text,'statutory',p.statutory,'otherDeductions',p.other_deductions::text,'totalDeductions',p.total_deductions::text,'netPay',p.net_pay::text,'employerCost',p.employer_cost::text)
$$;
CREATE FUNCTION app.payroll_history_native_source_hash(p public.payslip,b public.payroll_batch,period_state text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('tenant',p.tenant_id,'sourceBatchId',p.batch_id,'sourcePayslipId',p.id,'employmentId',p.employment_id,'version',p.version,'companyId',b.company_id,'period',b.pay_period,'cycleId',b.payroll_cycle_id,'status',b.status,'periodStatus',period_state,'values',app.payroll_history_native_values(p),'physical',to_jsonb(p))::text,'UTF8')),'hex')
$$;
CREATE FUNCTION app.payroll_history_native_id(p_attempt uuid,p_source uuid,p_kind text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h text:=encode(sha256(convert_to('history-native-baseline-v1:'||p_attempt::text||':'||p_source::text||':'||p_kind,'UTF8')),'hex');BEGIN
 h:=overlay(overlay(substr(h,1,32) placing '5' from 13 for 1) placing '8' from 17 for 1);RETURN(substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21,12))::uuid;END
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_values(public.payslip),app.payroll_history_native_source_hash(public.payslip,public.payroll_batch,text),app.payroll_history_native_id(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_native_sources(wanted uuid[]) RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.payroll_history_native_module() OR wanted IS NULL OR cardinality(wanted)>50000 THEN RAISE EXCEPTION 'Native payroll source scope unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT jsonb_build_object('sourceBatchId',b.id,'sourcePayslipId',p.id,'sourceVersion',p.version,'sourceHash',app.payroll_history_native_source_hash(p,b,period.status::text),'values',app.payroll_history_native_values(p))
 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=p.tenant_id JOIN public.pay_period period ON period.id=b.pay_period_id AND period.tenant_id=b.tenant_id
 WHERE p.id=ANY(wanted) AND p.tenant_id=app.current_tenant_id() AND b.history_import_attempt_id IS NULL AND b.status IN('draft','processing','processed') AND period.status='open'
 AND app.payroll_history_native_permission(b.company_id,'payroll.history.import') AND app.can_admin_payroll_employment(p.employment_id)
 AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id WHERE stage.state='staged' AND((sr.relation='payslip' AND sr.row_id=p.id) OR(sr.relation='payroll_batch' AND sr.row_id=b.id))) ORDER BY p.id;
END
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_sources(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_native_sources(uuid[]) TO ai_hr_app;
