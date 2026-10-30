-- UNAPPLIED PROVISIONAL DEVELOPMENT ONLY: 0738 / idx717 / when1793330000075.
-- Same native day owner; scoped opaque tuples and native summaries, never financial event evidence.
CREATE FUNCTION app.assistant_attendance_day_schedule_scope(p_employment uuid,p_date date) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject jsonb;
BEGIN
 PERFORM app._assistant_multi_cycle_run_review_identity(NULL,false);
 IF p_date IS NULL OR app.assistant_attendance_schedule_group_choice_scope(p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Day schedule unavailable' USING ERRCODE='42501';END IF;
 subject:=app.assistant_attendance_schedule_group_scope(p_employment);
 RETURN (subject-'attendanceRuleId')||jsonb_build_object('date',p_date);
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_day_schedule_scope(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_day_schedule_scope(uuid,date) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_attendance_day_schedule_effect_state(p_employment uuid,p_date date,p_batches jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;day_row public.attendance;adjustment public.attendance_day_adjustment;pattern public.attendance_overtime_source;row_refs jsonb;payroll jsonb;marker text;
BEGIN
 PERFORM app.assistant_attendance_day_schedule_scope(p_employment,p_date);
 IF jsonb_typeof(p_batches) IS DISTINCT FROM 'array' OR jsonb_array_length(p_batches)>25 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_batches) j WHERE jsonb_typeof(j)<>'string')
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(p_batches))<>jsonb_array_length(p_batches) THEN RAISE EXCEPTION 'Day effect bounds unavailable' USING ERRCODE='22023';END IF;
 SELECT * INTO day_row FROM public.attendance WHERE employment_id=p_employment AND attendance_date=p_date AND tenant_id=app.current_tenant_id();
 SELECT * INTO adjustment FROM public.attendance_day_adjustment WHERE employment_id=p_employment AND attendance_date=p_date AND tenant_id=app.current_tenant_id();
 SELECT * INTO pattern FROM public.attendance_overtime_source WHERE employment_id=p_employment AND attendance_date=p_date AND tenant_id=app.current_tenant_id();
 IF pattern.id IS NOT NULL AND app.can_admin_payroll_for(pattern.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Review native financial evidence in Attendance' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_batches) picked WHERE NOT EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.payslip p ON p.batch_id=b.id AND p.tenant_id=b.tenant_id AND p.employment_id=p_employment WHERE b.id=picked.value::uuid AND b.tenant_id=app.current_tenant_id() AND b.status='processed' AND app.can_admin_payroll_for(b.company_id))) THEN RAISE EXCEPTION 'Processed day evidence unavailable' USING ERRCODE='42501';END IF;
 IF (SELECT count(*) FROM public.attendance_punch WHERE tenant_id=app.current_tenant_id() AND employment_id=p_employment AND attendance_date=p_date)>128
 OR (SELECT count(*) FROM public.attendance_overtime_line WHERE tenant_id=app.current_tenant_id() AND calculation_id=pattern.current_calculation_id)>64
 OR (SELECT count(*) FROM public.attendance_overtime_policy_part WHERE tenant_id=app.current_tenant_id() AND calculation_id=pattern.current_calculation_id)>64 THEN RAISE EXCEPTION 'Review large day on native Attendance screen' USING ERRCODE='54000';END IF;
 marker:=CASE WHEN day_row.calc_trace->'overtimePattern'->>'status'='refused' THEN 'refused' WHEN day_row.calc_trace->'overtimePattern'->>'status'='recorded' THEN 'recorded' ELSE 'none' END;
 SELECT coalesce(jsonb_agg(jsonb_build_object('batchId',b.id,'payPeriod',b.pay_period,'recalcRequired',b.needs_recalc_at IS NOT NULL AND coalesce(b.recalc_employment_ids,'[]'::jsonb) ? p_employment::text) ORDER BY b.id),'[]'::jsonb) INTO payroll FROM public.payroll_batch b WHERE b.tenant_id=app.current_tenant_id() AND b.id IN(SELECT value::uuid FROM jsonb_array_elements_text(p_batches));
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'key',key,'digest',encode(sha256(convert_to(record::text,'UTF8')),'hex'),'xid',xid) ORDER BY kind,key),'[]'::jsonb) INTO row_refs FROM (
 SELECT 'attendance' kind,a.id::text key,to_jsonb(a) record,a.xmin::text xid FROM public.attendance a WHERE a.tenant_id=app.current_tenant_id() AND a.id=day_row.id
 UNION ALL SELECT 'attendance_clock',a.id::text,to_jsonb(a)-ARRAY['worked_minutes','ot_minutes','late_minutes','early_out_minutes','under_minutes','late_deduct_minutes','early_out_deduct_minutes','ot_flat_minutes','ot00_minutes','ot10_minutes','ot15_minutes','ot20_minutes','ot30_minutes','status','day_type','calc_trace'],a.xmin::text FROM public.attendance a WHERE a.tenant_id=app.current_tenant_id() AND a.id=day_row.id
 UNION ALL SELECT 'adjustment',a.id::text,to_jsonb(a),a.xmin::text FROM public.attendance_day_adjustment a WHERE a.tenant_id=app.current_tenant_id() AND a.id=adjustment.id
 UNION ALL SELECT 'punch',a.id::text,to_jsonb(a),a.xmin::text FROM public.attendance_punch a WHERE a.tenant_id=app.current_tenant_id() AND a.employment_id=p_employment AND a.attendance_date=p_date
 UNION ALL SELECT 'pattern_source',a.id::text,to_jsonb(a),a.xmin::text FROM public.attendance_overtime_source a WHERE a.tenant_id=app.current_tenant_id() AND a.id=pattern.id
 UNION ALL SELECT 'pattern_calculation',a.id::text,to_jsonb(a),a.xmin::text FROM public.attendance_overtime_calculation a WHERE a.tenant_id=app.current_tenant_id() AND a.id=pattern.current_calculation_id
 UNION ALL SELECT 'pattern_evidence',a.calculation_id::text,to_jsonb(a),a.xmin::text FROM public.attendance_overtime_calculation_evidence a WHERE a.tenant_id=app.current_tenant_id() AND a.calculation_id=pattern.current_calculation_id
 UNION ALL SELECT 'pattern_part',a.calculation_id::text||':'||a.sequence::text,to_jsonb(a),a.xmin::text FROM public.attendance_overtime_policy_part a WHERE a.tenant_id=app.current_tenant_id() AND a.calculation_id=pattern.current_calculation_id
 UNION ALL SELECT 'pattern_line',a.id::text,to_jsonb(a),a.xmin::text FROM public.attendance_overtime_line a WHERE a.tenant_id=app.current_tenant_id() AND a.calculation_id=pattern.current_calculation_id
 UNION ALL SELECT 'payroll',a.id::text,to_jsonb(a),a.xmin::text FROM public.payroll_batch a WHERE a.tenant_id=app.current_tenant_id() AND a.id IN(SELECT value::uuid FROM jsonb_array_elements_text(p_batches))
 UNION ALL SELECT 'payroll_other',a.id::text,(to_jsonb(a)-ARRAY['needs_recalc_at','recalc_employment_ids'])||jsonb_build_object('otherRecalcIds',coalesce(a.recalc_employment_ids,'[]'::jsonb)-p_employment::text),a.xmin::text FROM public.payroll_batch a WHERE a.tenant_id=app.current_tenant_id() AND a.id IN(SELECT value::uuid FROM jsonb_array_elements_text(p_batches))
 ) scoped;
 IF jsonb_array_length(row_refs)>256 THEN RAISE EXCEPTION 'Review large day on native Attendance screen' USING ERRCODE='54000';END IF;
 SELECT jsonb_build_object('override',jsonb_build_object('shiftId',adjustment.shift_id,'dayKind',adjustment.day_kind,'reason',adjustment.reason,'version',coalesce(adjustment.version,0)),
 'day',(SELECT jsonb_build_object('status',a.status,'dayType',a.day_type,'figures',jsonb_build_object('workedMinutes',a.worked_minutes,'otMinutes',a.ot_minutes,'lateMinutes',a.late_minutes,'earlyOutMinutes',a.early_out_minutes,'underMinutes',a.under_minutes,'lateDeductMinutes',a.late_deduct_minutes,'earlyOutDeductMinutes',a.early_out_deduct_minutes,'otFlatMinutes',a.ot_flat_minutes,'ot00Minutes',a.ot00_minutes,'ot10Minutes',a.ot10_minutes,'ot15Minutes',a.ot15_minutes,'ot20Minutes',a.ot20_minutes,'ot30Minutes',a.ot30_minutes)) FROM public.attendance a WHERE a.id=day_row.id AND a.tenant_id=app.current_tenant_id()),
 'pattern',jsonb_build_object('sourceId',pattern.id,'calculationId',pattern.current_calculation_id,'revision',coalesce(pattern.revision,0),'marker',marker),'payroll',payroll,'rows',row_refs) INTO result;
 IF octet_length(result::text)>120000 THEN RAISE EXCEPTION 'Review large day on native Attendance screen' USING ERRCODE='54000';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_day_schedule_effect_state(uuid,date,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_day_schedule_effect_state(uuid,date,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- Historical receipts authenticate immutable native evidence; current receipts additionally prove
-- actual top-transaction tuples. SAVEPOINT preview receipts deliberately do not use current proof.
CREATE FUNCTION app.assistant_attendance_day_schedule_receipt(p_employment uuid,p_date date,p_event uuid,p_current boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.domain_event;w jsonb;now_state jsonb;stored_after jsonb;protected_before jsonb;protected_after jsonb;event_xid xid;x text:=pg_current_xact_id()::xid::text;adjustment_id uuid;row_ref jsonb;new_calculation boolean;
BEGIN
 PERFORM app.assistant_attendance_day_schedule_scope(p_employment,p_date);
 SELECT e.* INTO d FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=app.current_tenant_id() AND e.aggregate_type='attendance-day-adjustment' AND e.event_type='attendance.day.corrected' AND e.subject_employment_id=p_employment AND e.actor_type='user' AND e.actor_id=app.current_user_id();
 IF NOT FOUND OR d.payload->>'date' IS DISTINCT FROM p_date::text OR d.payload->>'kind' IS DISTINCT FROM 'schedule' THEN RAISE EXCEPTION 'Day receipt unavailable' USING ERRCODE='42501';END IF;
 SELECT e.xmin INTO event_xid FROM public.domain_event e WHERE e.id=d.id AND e.tenant_id=d.tenant_id;
 w:=d.payload->'reviewEffects';adjustment_id:=(d.payload->'after'->>'id')::uuid;
 IF w->>'version' IS DISTINCT FROM '1' OR w->>'date' IS DISTINCT FROM p_date::text OR adjustment_id IS DISTINCT FROM d.aggregate_id OR jsonb_typeof(w->'before'->'rows') IS DISTINCT FROM 'array' OR jsonb_typeof(w->'after'->'rows') IS DISTINCT FROM 'array'
 OR jsonb_array_length(w->'before'->'rows')>256 OR jsonb_array_length(w->'after'->'rows')>256 OR jsonb_typeof(w->'relatedEventIds') IS DISTINCT FROM 'array' OR jsonb_array_length(w->'relatedEventIds')>100 THEN RAISE EXCEPTION 'Day witness unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(j-'xid' ORDER BY j->>'kind',j->>'key'),'[]'::jsonb) INTO protected_before FROM jsonb_array_elements(w->'before'->'rows') j WHERE j->>'kind' IN('punch','attendance_clock','payroll_other');
 SELECT coalesce(jsonb_agg(j-'xid' ORDER BY j->>'kind',j->>'key'),'[]'::jsonb) INTO protected_after FROM jsonb_array_elements(w->'after'->'rows') j WHERE j->>'kind' IN('punch','attendance_clock','payroll_other');
 IF protected_before IS DISTINCT FROM protected_after OR (w->'after'->'summary'->'override'->>'version')::integer IS DISTINCT FROM (w->'before'->'summary'->'override'->>'version')::integer+1 OR w->'after'->'summary'->'override'->'shiftId' IS DISTINCT FROM d.payload->'after'->'shiftId' OR w->'after'->'summary'->'override'->'dayKind' IS DISTINCT FROM d.payload->'after'->'dayKind' OR w->'after'->'summary'->'override'->'reason' IS DISTINCT FROM d.payload->'after'->'reason' THEN RAISE EXCEPTION 'Day witness binding unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(w->'relatedEventIds') picked WHERE NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.id=picked.value::uuid AND e.tenant_id=d.tenant_id AND e.subject_employment_id=p_employment AND e.actor_type='user' AND e.actor_id=d.actor_id AND e.event_type IN('overtime.calculation.recorded','attendance.overtime-pattern.refused','payroll-batch.recalc-required'))) THEN RAISE EXCEPTION 'Day related audit unavailable' USING ERRCODE='42501';END IF;
 IF p_current THEN
  IF event_xid::text<>x THEN RAISE EXCEPTION 'Day current event unavailable' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.attendance_day_adjustment a WHERE a.id=adjustment_id AND a.tenant_id=d.tenant_id AND a.employment_id=p_employment AND a.attendance_date=p_date AND a.xmin::text=x AND a.version=(d.payload->'after'->>'version')::integer AND a.shift_id IS NOT DISTINCT FROM (d.payload->'after'->>'shiftId')::uuid AND a.day_kind IS NOT DISTINCT FROM d.payload->'after'->>'dayKind' AND a.reason=d.payload->'after'->>'reason' AND a.updated_by=d.actor_id::text AND a.manual_ot_rows IS NOT DISTINCT FROM coalesce(nullif(d.payload->'before'->'manualOtRows','null'::jsonb),'{}'::jsonb)) THEN RAISE EXCEPTION 'Day native adjustment unavailable' USING ERRCODE='42501';END IF;
  now_state:=app.assistant_attendance_day_schedule_effect_state(p_employment,p_date,w->'payrollBatchIds');
  stored_after:=w->'after'->'summary';
  IF now_state->'rows' IS DISTINCT FROM w->'after'->'rows' OR now_state-'rows' IS DISTINCT FROM jsonb_build_object('override',stored_after->'override','day',stored_after->'day','pattern',stored_after->'pattern','payroll',stored_after->'payroll') THEN RAISE EXCEPTION 'Day actual effects changed' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM public.attendance a WHERE a.tenant_id=d.tenant_id AND a.employment_id=p_employment AND a.attendance_date=p_date AND a.check_in_at IS NOT NULL AND a.xmin::text<>x) THEN RAISE EXCEPTION 'Day calculation transaction unavailable' USING ERRCODE='42501';END IF;
  new_calculation:=stored_after->'pattern'->>'calculationId' IS DISTINCT FROM w->'before'->'summary'->'pattern'->>'calculationId';
  FOR row_ref IN SELECT * FROM jsonb_array_elements(w->'after'->'rows') LOOP
   IF (row_ref->>'kind'='adjustment' OR (new_calculation AND row_ref->>'kind' IN('pattern_source','pattern_calculation','pattern_evidence','pattern_part','pattern_line')) OR (row_ref->>'kind'='payroll' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(w->'before'->'rows') old WHERE old->>'kind'='payroll' AND old->>'key'=row_ref->>'key' AND old->>'digest'=row_ref->>'digest'))) AND row_ref->>'xid'<>x THEN RAISE EXCEPTION 'Day effect transaction unavailable' USING ERRCODE='42501';END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(w->'relatedEventIds') picked JOIN public.domain_event e ON e.id=picked.value::uuid AND e.tenant_id=d.tenant_id WHERE e.xmin::text<>x) THEN RAISE EXCEPTION 'Day related transaction unavailable' USING ERRCODE='42501';END IF;
  IF new_calculation AND stored_after->'pattern'->>'calculationId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=d.tenant_id AND e.id IN(SELECT value::uuid FROM jsonb_array_elements_text(w->'relatedEventIds')) AND e.event_type='overtime.calculation.recorded' AND e.aggregate_id=(stored_after->'pattern'->>'sourceId')::uuid AND e.payload->>'calculationId'=stored_after->'pattern'->>'calculationId') THEN RAISE EXCEPTION 'Day calculation audit unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(stored_after->'payroll') b WHERE b->>'recalcRequired' IS DISTINCT FROM 'true' OR (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(w->'before'->'summary'->'payroll') old WHERE old->>'batchId'=b->>'batchId' AND old->>'recalcRequired'='true') AND NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=d.tenant_id AND e.id IN(SELECT value::uuid FROM jsonb_array_elements_text(w->'relatedEventIds')) AND e.event_type='payroll-batch.recalc-required' AND e.aggregate_id=(b->>'batchId')::uuid AND e.payload=jsonb_build_object('addedEmploymentIds',jsonb_build_array(p_employment))))) THEN RAISE EXCEPTION 'Day payroll audit unavailable' USING ERRCODE='42501';END IF;
 END IF;
 RETURN jsonb_build_object('adjustmentId',adjustment_id,'eventId',d.id,'version',(d.payload->'after'->>'version')::integer,'witness',w);
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_day_schedule_receipt(uuid,date,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_day_schedule_receipt(uuid,date,uuid,boolean) TO ai_hr_app;
