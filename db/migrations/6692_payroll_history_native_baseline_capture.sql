CREATE FUNCTION app.payroll_history_native_proof(c app.payroll_history_native_capture) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('version',1,'sourceBatchId',c.source_batch_id,'sourcePayslipId',c.source_payslip_id,'sourceVersion',c.source_version,'sourceHash',c.source_hash,'baselineBatchId',c.baseline_batch_id,'baselineSnapshotId',c.snapshot_id)
$$;
CREATE FUNCTION app.payroll_history_native_snapshot_bound(s public.payroll_history_import_snapshot) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.payroll_history_native_capture c JOIN public.payslip p ON p.id=c.snapshot_id AND p.tenant_id=c.tenant_id JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=p.tenant_id JOIN public.payroll_history_import_record r ON r.id=c.record_id AND r.tenant_id=c.tenant_id
 WHERE c.snapshot_id=s.id AND c.record_id=s.record_id AND c.tenant_id=s.tenant_id AND c.baseline_batch_id=b.id AND b.history_import_attempt_id=c.attempt_id AND p.employment_id=r.employment_id AND b.company_id=r.company_id AND b.pay_period=r.period AND s.values=app.payroll_history_native_values(p))
$$;
CREATE FUNCTION app.payroll_history_native_revision_bound(r public.payroll_history_import_revision) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.payroll_history_native_capture c JOIN public.payroll_history_import_snapshot s ON s.id=c.snapshot_id AND s.record_id=c.record_id AND s.tenant_id=c.tenant_id WHERE r.kind='adopted' AND r.ordinal=1 AND r.previous_revision_id IS NULL AND r.maintenance IS NULL AND c.snapshot_id=r.snapshot_id AND c.record_id=r.record_id AND c.tenant_id=r.tenant_id AND c.attempt_id=r.attempt_id AND r.native_source=app.payroll_history_native_proof(c) AND app.payroll_history_native_snapshot_bound(s))
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_proof(app.payroll_history_native_capture),app.payroll_history_native_snapshot_bound(public.payroll_history_import_snapshot),app.payroll_history_native_revision_bound(public.payroll_history_import_revision) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Preserve the installed closed/imported/staged snapshot checks verbatim, preceding them only with the independently captured baseline branch.
DO $migration$ DECLARE body text; BEGIN
 SELECT pg_get_functiondef('app.payroll_history_bind_snapshot()'::regprocedure) INTO body;
 IF (length(body)-length(replace(body,E'BEGIN\n','')))/length(E'BEGIN\n')<>1 THEN RAISE EXCEPTION 'Unexpected snapshot binding definition';END IF;
 body:=replace(body,E'BEGIN\n',E'BEGIN\n IF app.payroll_history_native_snapshot_bound(NEW) THEN RETURN NEW;END IF;\n IF EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id WHERE p.id=NEW.id AND b.history_import_attempt_id IS NULL AND b.status<>''closed'') THEN RAISE EXCEPTION ''An open native payslip needs a detached baseline'';END IF;\n');EXECUTE body;
 SELECT pg_get_functiondef('app.payroll_history_bind_revision()'::regprocedure) INTO body;
 IF strpos(body,'IF NOT ordinary AND NEW.kind=''adopted'' THEN')=0 THEN RAISE EXCEPTION 'Unexpected adopted revision definition';END IF;
 body:=replace(body,'IF NOT ordinary AND NEW.kind=''adopted'' THEN','IF NOT ordinary AND NEW.kind=''adopted'' AND NOT app.payroll_history_native_revision_bound(NEW) THEN');EXECUTE body;
END $migration$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_native_revision_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN IF NEW.native_source IS NOT NULL AND NOT app.payroll_history_native_revision_bound(NEW) THEN RAISE EXCEPTION 'Native baseline proof does not match the captured source' USING ERRCODE='23514';END IF;RETURN NEW;END
$$;
REVOKE ALL ON FUNCTION app.payroll_history_native_revision_guard() FROM PUBLIC;
CREATE TRIGGER payroll_history_native_revision_binding BEFORE INSERT ON public.payroll_history_import_revision FOR EACH ROW EXECUTE FUNCTION app.payroll_history_native_revision_guard();
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_capture_native(p_attempt uuid,p_record uuid,input jsonb,p_cycle_name text,p_value_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.payroll_history_import_record; a public.payroll_history_import_attempt; p public.payslip; b public.payroll_batch; period public.pay_period;
 c app.payroll_history_native_capture; copy_batch public.payroll_batch; batch_id uuid; slip_id uuid; stage uuid:=nullif(current_setting('app.payroll_history_stage',true),'')::uuid;
BEGIN
 IF NOT app.payroll_history_native_module() OR jsonb_typeof(input) IS DISTINCT FROM 'object' OR input-ARRAY['batchId','snapshotId','sourceBatchId','sourcePayslipId','sourceVersion','sourceHash','values']<>'{}'::jsonb OR p_value_hash !~ '^[0-9a-f]{64}$' OR length(p_cycle_name) NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid native baseline capture' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM public.payroll_history_import_record WHERE id=p_record AND tenant_id=app.current_tenant_id() FOR UPDATE;
 SELECT * INTO a FROM public.payroll_history_import_attempt WHERE id=p_attempt AND tenant_id=r.tenant_id;
 IF r.id IS NULL OR a.id IS NULL OR a.created_by IS DISTINCT FROM app.current_user_id() OR NOT app.payroll_history_native_permission(r.company_id,'payroll.history.import') OR a.plan->'maintenance'->>'version' IS DISTINCT FROM '1'
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.plan->'rows') planned WHERE planned->>'companyId'=r.company_id::text AND planned->>'employmentId'=r.employment_id::text AND planned->>'period'=r.period AND planned->>'cycleId'=r.cycle_id::text AND planned->>'operation' IN('create','replace') AND planned->'detachedNativeBaseline'=input)
 THEN RAISE EXCEPTION 'The native baseline is not in the reviewed source' USING ERRCODE='42501';END IF;
 IF stage IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.stage_id=stage AND s.tenant_id=r.tenant_id AND s.attempt_id=a.id AND s.created_by=app.current_user_id() AND s.state='staged') THEN RAISE EXCEPTION 'Native baseline stage unavailable' USING ERRCODE='42501';END IF;
 SELECT period_owner.* INTO period FROM public.pay_period period_owner WHERE period_owner.id=(SELECT source.pay_period_id FROM public.payroll_batch source WHERE source.id=(input->>'sourceBatchId')::uuid AND source.tenant_id=r.tenant_id) AND period_owner.tenant_id=r.tenant_id FOR SHARE;
 SELECT x.* INTO b FROM public.payroll_batch x WHERE x.id=(input->>'sourceBatchId')::uuid AND x.tenant_id=r.tenant_id FOR UPDATE;
 SELECT x.* INTO p FROM public.payslip x WHERE x.id=(input->>'sourcePayslipId')::uuid AND x.tenant_id=r.tenant_id FOR UPDATE;

 IF p.id IS NULL OR b.id IS NULL OR p.batch_id<>b.id OR p.employment_id<>r.employment_id OR b.company_id<>r.company_id OR b.pay_period<>r.period OR(b.payroll_cycle_id IS NOT NULL AND b.payroll_cycle_id<>r.cycle_id) OR b.history_import_attempt_id IS NOT NULL OR b.status NOT IN('draft','processing','processed') OR period.id IS NULL OR b.pay_period_id IS DISTINCT FROM period.id
 OR p.version IS DISTINCT FROM (input->>'sourceVersion')::integer OR input->>'sourceHash' IS DISTINCT FROM app.payroll_history_native_source_hash(p,b,period.status::text) OR input->'values' IS DISTINCT FROM app.payroll_history_native_values(p)
 THEN RAISE EXCEPTION 'The native payroll source changed. Review a new preview.' USING ERRCODE='40001';END IF;
 batch_id:=app.payroll_history_native_id(a.id,b.id,'batch');slip_id:=app.payroll_history_native_id(a.id,p.id,'snapshot');
 IF input->>'batchId' IS DISTINCT FROM batch_id::text OR input->>'snapshotId' IS DISTINCT FROM slip_id::text THEN RAISE EXCEPTION 'Native baseline identity mismatch';END IF;
 SELECT * INTO c FROM app.payroll_history_native_capture WHERE snapshot_id=slip_id;
 IF c.snapshot_id IS NOT NULL THEN
  IF c.record_id<>r.id OR c.attempt_id<>a.id OR c.source_hash<>input->>'sourceHash' OR NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s WHERE s.id=slip_id AND s.value_hash=p_value_hash AND s.values=input->'values') THEN RAISE EXCEPTION 'Native baseline replay differs';END IF;
  RETURN jsonb_build_object('snapshotId',slip_id,'nativeSource',app.payroll_history_native_proof(c));
 END IF;
 SELECT * INTO copy_batch FROM public.payroll_batch WHERE id=batch_id;
 IF copy_batch.id IS NULL THEN
  INSERT INTO public.payroll_batch(id,tenant_id,company_id,pay_period_id,pay_period,run_type,run_seq,status,batch_date,payroll_cycle_id,remarks,history_import_attempt_id,history_import_cycle_name)
  VALUES(batch_id,r.tenant_id,r.company_id,NULL,r.period,'adjustment',0,'draft',b.batch_date,b.payroll_cycle_id,'Retained native baseline',a.id,p_cycle_name);
 ELSIF copy_batch.tenant_id<>r.tenant_id OR copy_batch.company_id<>r.company_id OR copy_batch.pay_period<>r.period OR copy_batch.history_import_attempt_id IS DISTINCT FROM a.id OR copy_batch.status<>'draft' OR NOT EXISTS(SELECT 1 FROM app.payroll_history_native_capture old WHERE old.baseline_batch_id=batch_id AND old.source_batch_id=b.id AND old.attempt_id=a.id) THEN RAISE EXCEPTION 'Native baseline batch changed';END IF;
 INSERT INTO app.payroll_history_native_capture(snapshot_id,tenant_id,record_id,attempt_id,baseline_batch_id,source_batch_id,source_payslip_id,source_version,source_hash,created_by)
 VALUES(slip_id,r.tenant_id,r.id,a.id,batch_id,b.id,p.id,p.version,input->>'sourceHash',app.current_user_id()) RETURNING * INTO c;
 INSERT INTO public.payslip(id,tenant_id,batch_id,employment_id,basic_salary,allowance,overtime_pay,bonus,days_worked,coverage_from,coverage_to,gross_pay,statutory,other_deductions,total_deductions,net_pay,employer_cost,version,created_at)
 VALUES(slip_id,r.tenant_id,batch_id,p.employment_id,p.basic_salary,p.allowance,p.overtime_pay,p.bonus,p.days_worked,p.coverage_from,p.coverage_to,p.gross_pay,p.statutory,p.other_deductions,p.total_deductions,p.net_pay,p.employer_cost,p.version,p.created_at);
 INSERT INTO public.payroll_history_import_snapshot(id,tenant_id,record_id,value_hash,"values") VALUES(slip_id,r.tenant_id,r.id,p_value_hash,input->'values');
 RETURN jsonb_build_object('snapshotId',slip_id,'nativeSource',app.payroll_history_native_proof(c));
END
$$;
REVOKE ALL ON FUNCTION app.payroll_history_capture_native(uuid,uuid,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_capture_native(uuid,uuid,jsonb,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_finalize_native(p_attempt uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE batch_ids uuid[];
BEGIN
 IF NOT app.payroll_history_native_module() OR NOT EXISTS(SELECT 1 FROM public.payroll_history_import_attempt a WHERE a.id=p_attempt AND a.tenant_id=app.current_tenant_id() AND a.created_by=app.current_user_id()) THEN RAISE EXCEPTION 'Native baseline release unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT c.baseline_batch_id),'{}') INTO batch_ids FROM app.payroll_history_native_capture c WHERE c.attempt_id=p_attempt AND c.tenant_id=app.current_tenant_id();
 IF cardinality(batch_ids)=0 THEN RETURN;END IF;
 -- Fence direct RPC callers as well as the canonical writer: source cannot mutate after the final hash check.
 PERFORM 1 FROM public.pay_period period_owner WHERE period_owner.id IN(SELECT source.pay_period_id FROM app.payroll_history_native_capture c JOIN public.payroll_batch source ON source.id=c.source_batch_id WHERE c.attempt_id=p_attempt AND c.tenant_id=app.current_tenant_id()) ORDER BY period_owner.id FOR SHARE;
 PERFORM 1 FROM public.payroll_batch source WHERE source.id IN(SELECT c.source_batch_id FROM app.payroll_history_native_capture c WHERE c.attempt_id=p_attempt AND c.tenant_id=app.current_tenant_id()) ORDER BY source.id FOR UPDATE;
 PERFORM 1 FROM public.payslip source WHERE source.id IN(SELECT c.source_payslip_id FROM app.payroll_history_native_capture c WHERE c.attempt_id=p_attempt AND c.tenant_id=app.current_tenant_id()) ORDER BY source.id FOR UPDATE;
 PERFORM 1 FROM public.payroll_batch b WHERE b.id=ANY(batch_ids) ORDER BY b.id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM app.payroll_history_native_capture c JOIN public.payroll_history_import_snapshot s ON s.id=c.snapshot_id JOIN public.payroll_history_import_record r ON r.id=c.record_id
 LEFT JOIN public.payslip original ON original.id=c.source_payslip_id LEFT JOIN public.payroll_batch source ON source.id=c.source_batch_id LEFT JOIN public.pay_period period ON period.id=source.pay_period_id
 WHERE c.attempt_id=p_attempt AND(c.tenant_id<>app.current_tenant_id() OR NOT app.payroll_history_native_permission(r.company_id,'payroll.history.import') OR NOT app.payroll_history_native_snapshot_bound(s) OR original.id IS NULL OR source.id IS NULL OR source.status NOT IN('draft','processing','processed') OR period.id IS NULL OR c.source_hash IS DISTINCT FROM app.payroll_history_native_source_hash(original,source,period.status::text))) THEN RAISE EXCEPTION 'The native baseline source changed before release' USING ERRCODE='40001';END IF;
 -- The existing history write barrier serializes allocation with normal native period ownership.
 WITH wanted AS(SELECT DISTINCT copy.id,source.pay_period_id FROM public.payroll_batch copy JOIN app.payroll_history_native_capture c ON c.baseline_batch_id=copy.id JOIN public.payroll_batch source ON source.id=c.source_batch_id WHERE copy.id=ANY(batch_ids) AND copy.status='draft'),
 numbered AS(SELECT w.*,coalesce((SELECT max(b.run_seq) FROM public.payroll_batch b WHERE b.pay_period_id=w.pay_period_id),0)+row_number()OVER(PARTITION BY w.pay_period_id ORDER BY w.id) seq FROM wanted w),
 totals AS(SELECT p.batch_id,count(*) n,jsonb_build_object('gross',sum(p.gross_pay),'net',sum(p.net_pay),'epfEmployee',sum(coalesce((p.statutory->>'epfEmployee')::numeric,0)),'epfEmployer',sum(coalesce((p.statutory->>'epfEmployer')::numeric,0)),'socsoEmployee',sum(coalesce((p.statutory->>'socsoEmployee')::numeric,0)),'socsoEmployer',sum(coalesce((p.statutory->>'socsoEmployer')::numeric,0)),'eisEmployee',sum(coalesce((p.statutory->>'eisEmployee')::numeric,0)),'eisEmployer',sum(coalesce((p.statutory->>'eisEmployer')::numeric,0)),'pcb',sum(coalesce((p.statutory->>'pcb')::numeric,0))) amount FROM public.payslip p WHERE p.batch_id=ANY(batch_ids) GROUP BY p.batch_id)
 UPDATE public.payroll_batch b SET pay_period_id=n.pay_period_id,run_seq=n.seq::integer,status='closed',employee_count=t.n,totals=t.amount FROM numbered n JOIN totals t ON t.batch_id=n.id WHERE b.id=n.id;
END
$$;
REVOKE ALL ON FUNCTION app.payroll_history_finalize_native(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_finalize_native(uuid) TO ai_hr_app;
