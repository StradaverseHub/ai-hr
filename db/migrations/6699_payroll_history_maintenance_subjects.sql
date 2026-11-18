-- Metadata-only identity seam for maintaining an ALREADY accepted original-employer record after
-- transfer. It cannot authorize a new company/employment/month/cycle or expose the current employer.
-- Dates below are retained coverage, never invented hire/termination dates or current-employer facts.
CREATE FUNCTION app.payroll_history_maintenance_segment(value jsonb,company uuid,month text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE first_day date;last_day date;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value->>'companyId' IS DISTINCT FROM company::text OR coalesce(value->>'from','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR coalesce(value->>'to','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL;END IF;
 BEGIN first_day:=(value->>'from')::date;last_day:=(value->>'to')::date;EXCEPTION WHEN OTHERS THEN RETURN NULL;END;
 IF first_day::text IS DISTINCT FROM value->>'from' OR last_day::text IS DISTINCT FROM value->>'to' OR first_day>last_day OR left(first_day::text,7) IS DISTINCT FROM month OR left(last_day::text,7) IS DISTINCT FROM month THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('companyId',company,'from',first_day::text,'to',last_day::text);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_segment(jsonb,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_maintenance_identity_page(targets uuid[],record_ids uuid[],employee_codes text[],periods text[],p_offset integer,p_limit integer)
RETURNS TABLE("recordId" uuid,"companyId" uuid,"employmentId" uuid,"employeeNo" text,"hiredOn" text,"terminatedOn" text,period text,"cycleId" uuid,"calendarEvidence" text,segment jsonb,"unavailableReason" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_offset IS NULL OR p_limit IS NULL OR p_offset<0 OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid accepted history identity page' USING ERRCODE='22023';END IF;
 RETURN QUERY
 WITH hidden AS MATERIALIZED(SELECT s.relation,s.row_id FROM app.payroll_history_staged_row s JOIN app.payroll_history_stage stage ON stage.stage_id=s.stage_id WHERE stage.tenant_id=app.current_tenant_id() AND stage.state='staged'),
 permissions AS MATERIALIZED(SELECT p.company_id FROM app.payroll_history_maintenance_permissions(CASE WHEN targets IS NULL THEN ARRAY(SELECT DISTINCT r.company_id FROM public.payroll_history_import_record r WHERE r.tenant_id=app.current_tenant_id() AND r.id=ANY(record_ids)) ELSE targets END) p WHERE p.can_edit OR p.can_remove),
 records AS MATERIALIZED(SELECT r.* FROM public.payroll_history_import_record r JOIN permissions p ON p.company_id=r.company_id WHERE r.tenant_id=app.current_tenant_id() AND (periods IS NULL OR r.period=ANY(periods)) AND (record_ids IS NULL OR r.id=ANY(record_ids)) AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_record' AND h.row_id=r.id)),
 revisions AS MATERIALIZED(SELECT DISTINCT ON(r.record_id) r.* FROM public.payroll_history_import_revision r JOIN records subject ON subject.id=r.record_id WHERE r.tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_revision' AND h.row_id=r.id) ORDER BY r.record_id,r.ordinal DESC),
 attempts AS MATERIALIZED(SELECT a.id,a.plan FROM public.payroll_history_import_attempt a JOIN(SELECT DISTINCT attempt_id FROM revisions) chosen ON chosen.attempt_id=a.id WHERE a.tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_attempt' AND h.row_id=a.id)),
 planned AS MATERIALIZED(SELECT DISTINCT ON(a.id,value->>'companyId',value->>'employmentId',value->>'period',value->>'cycleId') a.id attempt_id,value AS planned_value FROM attempts a CROSS JOIN LATERAL jsonb_array_elements(coalesce(a.plan->'rows','[]'::jsonb)) WITH ORDINALITY item(value,ordinality) ORDER BY a.id,value->>'companyId',value->>'employmentId',value->>'period',value->>'cycleId',ordinality),
 evidence AS MATERIALIZED(SELECT DISTINCT ON(rev.record_id) rev.record_id,s.id snapshot_id,s."values"->'statutory'->'segment' saved_segment FROM public.payroll_history_import_revision rev JOIN records r ON r.id=rev.record_id JOIN public.payroll_history_import_snapshot s ON s.id=rev.snapshot_id AND s.record_id=r.id AND s.tenant_id=r.tenant_id JOIN public.payslip slip ON slip.id=s.id AND slip.tenant_id=r.tenant_id AND slip.employment_id=r.employment_id JOIN public.payroll_batch batch ON batch.id=slip.batch_id AND batch.tenant_id=r.tenant_id AND batch.company_id=r.company_id AND batch.pay_period=r.period AND (batch.payroll_cycle_id=r.cycle_id OR batch.payroll_cycle_id IS NULL AND rev.kind='adopted') WHERE rev.tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.relation='payroll_history_import_revision' AND h.row_id=rev.id OR h.relation='payroll_history_import_snapshot' AND h.row_id=s.id OR h.relation='payslip' AND h.row_id=slip.id OR h.relation='payroll_batch' AND h.row_id=batch.id OR h.relation='payroll_history_import_attempt' AND h.row_id=rev.attempt_id) ORDER BY rev.record_id,rev.ordinal),
 subjects AS(SELECT r.id,r.company_id,r.employment_id,r.period,r.cycle_id,coalesce(nullif(planned.planned_value->>'employeeNo',''),'') employee_no,evidence.snapshot_id,evidence.saved_segment,app.payroll_history_maintenance_segment(evidence.saved_segment,r.company_id,r.period) segment FROM records r JOIN revisions rev ON rev.record_id=r.id JOIN attempts a ON a.id=rev.attempt_id JOIN public.payroll_cycle cycle ON cycle.id=r.cycle_id AND cycle.tenant_id=r.tenant_id AND cycle.company_id=r.company_id LEFT JOIN evidence ON evidence.record_id=r.id LEFT JOIN planned ON planned.attempt_id=a.id AND planned.planned_value->>'companyId'=r.company_id::text AND planned.planned_value->>'employmentId'=r.employment_id::text AND planned.planned_value->>'period'=r.period AND planned.planned_value->>'cycleId'=r.cycle_id::text)
 SELECT s.id,s.company_id,s.employment_id,s.employee_no,NULL::text,NULL::text,s.period,s.cycle_id,
 CASE WHEN s.snapshot_id IS NULL OR s.saved_segment IS NOT NULL AND s.saved_segment<>'null'::jsonb AND s.segment IS NULL THEN 'unavailable' WHEN s.segment IS NOT NULL THEN 'retained_segment' ELSE 'retained_record' END,s.segment,
 CASE WHEN s.employee_no='' THEN 'The retained original employee code is unavailable.' WHEN s.snapshot_id IS NULL THEN 'The accepted original-employer calendar record is unavailable.' WHEN s.saved_segment IS NOT NULL AND s.saved_segment<>'null'::jsonb AND s.segment IS NULL THEN 'The retained original-employer calendar segment conflicts with its accepted record.' ELSE NULL END
 FROM subjects s WHERE (employee_codes IS NULL OR upper(btrim(s.employee_no))=ANY(ARRAY(SELECT upper(btrim(code)) FROM unnest(employee_codes) code))) ORDER BY s.company_id,s.employee_no,s.employment_id,s.period,s.cycle_id,s.id LIMIT p_limit OFFSET p_offset;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_identity_page(uuid[],uuid[],text[],text[],integer,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_maintenance_subjects(targets uuid[],employee_codes text[],periods text[],p_offset integer,p_limit integer)
RETURNS TABLE("recordId" uuid,"companyId" uuid,"employmentId" uuid,"employeeNo" text,"hiredOn" text,"terminatedOn" text,period text,"cycleId" uuid,"calendarEvidence" text,segment jsonb,"unavailableReason" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF targets IS NULL OR employee_codes IS NULL OR periods IS NULL OR p_offset IS NULL OR p_limit IS NULL OR p_offset<0 OR p_limit NOT BETWEEN 1 AND 500 OR cardinality(targets) NOT BETWEEN 1 AND 500 OR cardinality(employee_codes) NOT BETWEEN 1 AND 5000 OR cardinality(periods) NOT BETWEEN 1 AND 1200 OR array_position(targets,NULL) IS NOT NULL OR array_position(employee_codes,NULL) IS NOT NULL OR array_position(periods,NULL) IS NOT NULL OR EXISTS(SELECT 1 FROM unnest(employee_codes) code WHERE length(btrim(code)) NOT BETWEEN 1 AND 200) OR EXISTS(SELECT 1 FROM unnest(periods) month WHERE month!~'^[0-9]{4}-(0[1-9]|1[0-2])$') THEN RAISE EXCEPTION 'Invalid accepted history subject page' USING ERRCODE='22023';END IF;
 RETURN QUERY SELECT * FROM app.payroll_history_maintenance_identity_page(targets,NULL,employee_codes,periods,p_offset,p_limit);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_subjects(uuid[],text[],text[],integer,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_maintenance_subjects(uuid[],text[],text[],integer,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_maintenance_identity(record_ids uuid[],p_offset integer,p_limit integer)
RETURNS TABLE("recordId" uuid,"companyId" uuid,"employmentId" uuid,"employeeNo" text,"hiredOn" text,"terminatedOn" text,period text,"cycleId" uuid,"calendarEvidence" text,segment jsonb,"unavailableReason" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF record_ids IS NULL OR cardinality(record_ids) NOT BETWEEN 1 AND 5000 OR array_position(record_ids,NULL) IS NOT NULL OR p_offset IS NULL OR p_limit IS NULL OR p_offset<0 OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid accepted history identity page' USING ERRCODE='22023';END IF;
 RETURN QUERY SELECT * FROM app.payroll_history_maintenance_identity_page(NULL,record_ids,NULL,NULL,p_offset,p_limit);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_identity(uuid[],integer,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_maintenance_identity(uuid[],integer,integer) TO ai_hr_app;
