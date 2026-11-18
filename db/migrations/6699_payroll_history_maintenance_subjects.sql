-- Metadata-only identity seam for maintaining an ALREADY accepted original-employer record after
-- transfer. It cannot authorize a new company/employment/month/cycle or expose the current employer.
CREATE FUNCTION app.payroll_history_maintenance_identity_page(targets uuid[],record_ids uuid[],employee_codes text[],periods text[],p_offset integer,p_limit integer)
RETURNS TABLE("recordId" uuid,"companyId" uuid,"employmentId" uuid,"employeeNo" text,"hiredOn" text,"terminatedOn" text,period text,"cycleId" uuid)
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
 subjects AS(SELECT r.id,r.company_id,r.employment_id,r.period,r.cycle_id,e.hired_on,e.terminated_on,coalesce(nullif(planned.planned_value->>'employeeNo',''),CASE WHEN e.company_id=r.company_id THEN e.employee_code END,'') employee_no FROM records r JOIN revisions rev ON rev.record_id=r.id JOIN attempts a ON a.id=rev.attempt_id JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN public.payroll_cycle cycle ON cycle.id=r.cycle_id AND cycle.tenant_id=r.tenant_id AND cycle.company_id=r.company_id LEFT JOIN planned ON planned.attempt_id=a.id AND planned.planned_value->>'companyId'=r.company_id::text AND planned.planned_value->>'employmentId'=r.employment_id::text AND planned.planned_value->>'period'=r.period AND planned.planned_value->>'cycleId'=r.cycle_id::text)
 SELECT s.id,s.company_id,s.employment_id,s.employee_no,s.hired_on::text,s.terminated_on::text,s.period,s.cycle_id FROM subjects s WHERE (employee_codes IS NULL OR upper(btrim(s.employee_no))=ANY(ARRAY(SELECT upper(btrim(code)) FROM unnest(employee_codes) code))) ORDER BY s.company_id,s.employee_no,s.employment_id,s.period,s.cycle_id,s.id LIMIT p_limit OFFSET p_offset;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_identity_page(uuid[],uuid[],text[],text[],integer,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_maintenance_subjects(targets uuid[],employee_codes text[],periods text[],p_offset integer,p_limit integer)
RETURNS TABLE("recordId" uuid,"companyId" uuid,"employmentId" uuid,"employeeNo" text,"hiredOn" text,"terminatedOn" text,period text,"cycleId" uuid)
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
RETURNS TABLE("recordId" uuid,"companyId" uuid,"employmentId" uuid,"employeeNo" text,"hiredOn" text,"terminatedOn" text,period text,"cycleId" uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF record_ids IS NULL OR cardinality(record_ids) NOT BETWEEN 1 AND 5000 OR array_position(record_ids,NULL) IS NOT NULL OR p_offset IS NULL OR p_limit IS NULL OR p_offset<0 OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid accepted history identity page' USING ERRCODE='22023';END IF;
 RETURN QUERY SELECT * FROM app.payroll_history_maintenance_identity_page(NULL,record_ids,NULL,NULL,p_offset,p_limit);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_identity(uuid[],integer,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_maintenance_identity(uuid[],integer,integer) TO ai_hr_app;
