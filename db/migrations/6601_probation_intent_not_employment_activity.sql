-- Approved c20f82c3: automatic reconciliation intent is operational queue metadata, not employment activity.
-- Preserve both canonical blocker owners, authority, all real activity checks and their existing ACLs.
-- The queue keeps its tenant/employment FK and owner-only RLS; actual probation_case references still block.
-- Restricted ai_hr_owner owns both functions. Existing applied migrations remain byte-identical.
CREATE OR REPLACE FUNCTION app.employment_void_reference_blockers(ids uuid[]) RETURNS TABLE(employment_id uuid,source text,row_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fk record;
BEGIN
 RETURN QUERY SELECT e.id,'employment.lifecycle'::text,1::bigint FROM public.employment e WHERE e.id=ANY(ids)
  AND (e.terminated_on IS NOT NULL OR e.resignation_date IS NOT NULL OR e.last_working_date IS NOT NULL OR e.blacklisted_at IS NOT NULL);
 RETURN QUERY SELECT x.employment_id,'assignment.employment_id'::text,count(*)-1 FROM public.assignment x WHERE x.employment_id=ANY(ids) GROUP BY 1 HAVING count(*)>1;
 RETURN QUERY SELECT x.employment_id,'compensation.employment_id'::text,count(*)-1 FROM public.compensation x WHERE x.employment_id=ANY(ids) GROUP BY 1 HAVING count(*)>1;
 RETURN QUERY SELECT x.employment_id,'leave_ledger.employment_id'::text,count(*) FROM public.leave_ledger x JOIN public.employment e ON e.id=x.employment_id
  WHERE x.employment_id=ANY(ids) AND NOT (x.entry_type='accrual' AND x.effective_on=e.hired_on) GROUP BY 1;
 RETURN QUERY SELECT x.manager_employment_id,'reporting_line.manager_employment_id'::text,count(*) FROM public.reporting_line x
  WHERE x.manager_employment_id=ANY(ids) AND NOT x.subordinate_employment_id=ANY(ids) GROUP BY 1;
 RETURN QUERY SELECT e.id,'employment.person_id'::text,count(*) FROM public.employment e JOIN public.employment o ON o.person_id=e.person_id AND o.id<>e.id
  WHERE e.id=ANY(ids) AND o.voided_at IS NULL AND NOT o.id=ANY(ids) GROUP BY 1;
 FOR fk IN SELECT c.conrelid::regclass::text AS tbl,a.attname::text AS col,c.confrelid='public.person'::regclass AS on_person
  FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey,c.confkey) k(att,fatt)
  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.att
  JOIN pg_attribute fa ON fa.attrelid=c.confrelid AND fa.attnum=k.fatt AND fa.attname='id'
  WHERE c.contype='f' AND c.confrelid IN ('public.employment'::regclass,'public.person'::regclass)
   AND (c.conrelid::regclass::text||'.'||a.attname) <> ALL(ARRAY[
    -- judged by shape above
    'employment.person_id','assignment.employment_id','compensation.employment_id','leave_ledger.employment_id',
    'reporting_line.manager_employment_id',
    -- written by the hire or by the same import file (its statutory, profile, family, register and allocation sheets)
    'reporting_line.subordinate_employment_id','employment_tax_selection_my.employment_id','employment_tax_scheme_my.employment_id',
    'employee_statutory_my.person_id','employee_dependent.person_id','person_emergency_contact.person_id',
    'employee_qualification.employment_id','employment_cost_allocation_head.employment_id',
    -- configuration of the employment, not activity
    'employment_holiday_calendar.employment_id','employment_shift_arrangement.employment_id','overtime_pattern_assignment_employment.employment_id',
    'employee_clocking_location.employment_id','notification_pref.recipient_employment_id',
    -- system projections and audit
    'probation_reconciliation_intent.employment_id',
    'domain_event.subject_employment_id','import_attempt_item.employment_id','leave_generation_run_item.employment_id',
    'leave_entitlement_recalc_audit.employment_id','notification.recipient_employment_id','notice_recipient.employment_id',
    -- replacement-holiday entitlement projection queued at hire (a holiday TAKEN is a leave request and blocks)
    'replacement_holiday_queue.employment_id','replacement_holiday.employment_id','replacement_holiday_revision.employment_id'])
  ORDER BY 1,2
 LOOP
  IF fk.on_person THEN
   RETURN QUERY EXECUTE format('SELECT e.id,%L::text,count(*)::bigint FROM %s x JOIN public.employment e ON e.person_id=x.%I WHERE e.id=ANY($1) GROUP BY e.id',fk.tbl||'.'||fk.col,fk.tbl,fk.col) USING ids;
  ELSE
   RETURN QUERY EXECUTE format('SELECT x.%I,%L::text,count(*)::bigint FROM %s x WHERE x.%I=ANY($1) GROUP BY x.%I',fk.col,fk.tbl||'.'||fk.col,fk.tbl,fk.col,fk.col) USING ids;
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employment_rehire_rollback_blockers(p_employment uuid) RETURNS TABLE(source text,row_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); target uuid; fk record;
BEGIN
 SELECT e.id INTO target FROM public.employment e
  WHERE e.id=p_employment AND e.tenant_id=t AND e.voided_at IS NULL AND e.rehired_from_employment_id IS NOT NULL;
 IF t IS NULL OR target IS NULL OR NOT app.access_workforce_employment(target,'workforce.maintain') THEN
  RAISE EXCEPTION 'employment_rehire_rollback_unavailable' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT 'employment.lifecycle'::text,1::bigint FROM public.employment e WHERE e.id=target
  AND (e.terminated_on IS NOT NULL OR e.resignation_date IS NOT NULL OR e.last_working_date IS NOT NULL OR e.blacklisted_at IS NOT NULL);
 RETURN QUERY SELECT 'assignment.employment_id'::text,count(*)-1 FROM public.assignment x WHERE x.employment_id=target HAVING count(*)>1;
 RETURN QUERY SELECT 'compensation.employment_id'::text,count(*)-1 FROM public.compensation x WHERE x.employment_id=target HAVING count(*)>1;
 -- Entitlement credits and recalculations are the system's; leave taken and time off in lieu earned are activity.
 RETURN QUERY SELECT 'leave_ledger.employment_id'::text,count(*) FROM public.leave_ledger x
  WHERE x.employment_id=target AND x.entry_type::text IN ('debit','in_lieu_accrual') HAVING count(*)>0;
 RETURN QUERY SELECT 'reporting_line.manager_employment_id'::text,count(*) FROM public.reporting_line x
  WHERE x.manager_employment_id=target HAVING count(*)>0;
 FOR fk IN SELECT c.conrelid::regclass::text AS tbl,a.attname::text AS col
  FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey,c.confkey) k(att,fatt)
  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.att
  JOIN pg_attribute fa ON fa.attrelid=c.confrelid AND fa.attnum=k.fatt AND fa.attname='id'
  WHERE c.contype='f' AND c.confrelid='public.employment'::regclass
   AND (c.conrelid::regclass::text||'.'||a.attname) <> ALL(ARRAY[
    -- judged above
    'assignment.employment_id','compensation.employment_id','leave_ledger.employment_id','reporting_line.manager_employment_id',
    -- written by the hire itself
    'reporting_line.subordinate_employment_id','employment_tax_selection_my.employment_id','employment_tax_scheme_my.employment_id',
    'employment_organisation_classification.employment_id',
    -- configuration of the employment, not activity
    'employment_holiday_calendar.employment_id','employment_shift_arrangement.employment_id','overtime_pattern_assignment_employment.employment_id',
    'employee_clocking_location.employment_id','notification_pref.recipient_employment_id',
    -- system projections and audit
    'probation_reconciliation_intent.employment_id',
    'domain_event.subject_employment_id','import_attempt_item.employment_id','leave_generation_run_item.employment_id',
    'leave_entitlement_recalc_audit.employment_id','notification.recipient_employment_id','notice_recipient.employment_id',
    'company_organisation_run_row.employment_id',
    'replacement_holiday_queue.employment_id','replacement_holiday.employment_id','replacement_holiday_revision.employment_id'])
  GROUP BY 1,2 ORDER BY 1,2
 LOOP
  RETURN QUERY EXECUTE format('SELECT %L::text,count(*)::bigint FROM %s x WHERE x.%I=$1 HAVING count(*)>0',fk.tbl||'.'||fk.col,fk.tbl,fk.col) USING target;
 END LOOP;
END;
$$;
