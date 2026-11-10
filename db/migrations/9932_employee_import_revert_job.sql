-- UNALLOCATED DRAFT on branch claude/bulkjob-register-20261110 (employee import Revert as a background job): not a
-- reservation, not an installation allocation. The journal position (idx 9932, when 1793330099320) exists only so this
-- branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when.
--
-- The employee import Revert (ADR-0155, ADR-0157; core/employee-import-history.ts) voided every employment of the
-- attempt in one request transaction under the Access and leave-dependency locks: 18.8 s for 500 hires on the loaded
-- rehearsal host, most of it the per-row guards and the per-employment authority calls in its eligibility review and
-- in app.employment_void_blockers. It now runs as a job (docs/adr/2026-11-10-register-section-import-jobs.md): the
-- eligibility review runs without locks, then this owner-only routine performs the whole revert in one short
-- transaction with set-based checks, exactly as before: the same refusals, the same voids, the same audit events in
-- the same order and the same Import History event.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive) VALUES('employee_import_revert','employee_full','creator');
--> statement-breakpoint
-- The reference blockers of app.employment_void_blockers (0676) without its per-employment authority calls, so a caller
-- that has already decided workforce maintain for the whole set reads the same blockers once. The 0676 function now
-- calls this one, so there is one list of judged references.
CREATE FUNCTION app.employment_void_reference_blockers(ids uuid[]) RETURNS TABLE(employment_id uuid,source text,row_count bigint)
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
REVOKE ALL ON FUNCTION app.employment_void_reference_blockers(uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employment_void_blockers(p_employments uuid[]) RETURNS TABLE(employment_id uuid,source text,row_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); ids uuid[]; wanted int;
BEGIN
 wanted:=cardinality(ARRAY(SELECT DISTINCT x FROM unnest(p_employments) x WHERE x IS NOT NULL));
 IF t IS NULL OR wanted IS NULL OR wanted=0 OR wanted>5000 THEN RAISE EXCEPTION 'employment_void_invalid' USING ERRCODE='22023'; END IF;
 SELECT array_agg(e.id ORDER BY e.id) INTO ids FROM public.employment e
  WHERE e.id=ANY(p_employments) AND e.tenant_id=t AND e.voided_at IS NULL;
 IF ids IS NULL OR cardinality(ids)<>wanted OR EXISTS(SELECT 1 FROM unnest(ids) x WHERE NOT app.access_workforce_employment(x,'workforce.maintain')) THEN
  RAISE EXCEPTION 'employment_void_unavailable' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT * FROM app.employment_void_reference_blockers(ids);
END $$;
--> statement-breakpoint
-- The revert, in one statement on the protected worker's queue-owner connection, under the creator's session captured at
-- admission (readable only while those grants stay current). Returns {released:true,restored} or {refused:<reason>}
-- with nothing written; the worker turns a refusal into the synchronous revert's own message.
CREATE FUNCTION app.employee_import_revert_release(p_job uuid,p_chain boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job%ROWTYPE; t uuid; u uuid; attempt_ uuid; reason_ text; a public.import_attempt%ROWTYPE; ids uuid[]; persons uuid[];
 confirmed_ uuid; n integer;
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN RAISE EXCEPTION 'employee_import_revert_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM set_config('application_name','aihr-bulk:employee_import_revert:release',true);
 SELECT * INTO j FROM public.bulk_job b WHERE b.id=p_job FOR UPDATE;
 IF NOT FOUND OR j.kind<>'employee_import_revert' OR j.state<>'finalizing' OR j.lease_expires_at IS NULL OR j.lease_expires_at<now()
  OR coalesce((j.plan->>'released')::boolean,false) THEN
  RAISE EXCEPTION 'employee_import_revert_unavailable' USING ERRCODE='55000';
 END IF;
 t:=j.tenant_id;u:=j.created_by;attempt_:=(j.input->>'attemptId')::uuid;reason_:=j.input->>'reason';
 IF (j.context->>'tenantId') IS DISTINCT FROM t::text OR (j.context->>'userId') IS DISTINCT FROM u::text OR attempt_ IS NULL
  OR reason_ IS NULL OR length(reason_) NOT BETWEEN 3 AND 1000 THEN
  RAISE EXCEPTION 'employee_import_revert_unavailable' USING ERRCODE='55000';
 END IF;
 PERFORM set_config('app.tenant_id',t::text,true),set_config('app.user_id',u::text,true),
  set_config('app.roles',coalesce((SELECT string_agg(r,',') FROM jsonb_array_elements_text(j.context->'roles') r),''),true),
  set_config('app.grants',coalesce(j.context->'grants','[]'::jsonb)::text,true),set_config('app.agent_principal_id','',true),
  set_config('app.payroll_tax_basis_reader','1',true);
 IF p_chain THEN PERFORM set_config('app.audit_hash_chain','on',true); END IF;
 -- The synchronous revert's locks, in its order: the Workforce writer barrier, the leave-dependency configuration
 -- (no wait: busy is retried by the worker), then the attempt row.
 PERFORM app.access_workforce_write_lock();
 IF NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||lower(t::text),0)) THEN
  RAISE EXCEPTION 'leave_dependency_busy' USING ERRCODE='55P03';
 END IF;
 IF NOT app.bank_import_context_current(j.context) THEN RETURN jsonb_build_object('refused','access'); END IF;
 SELECT * INTO a FROM public.import_attempt x WHERE x.id=attempt_ AND x.tenant_id=t FOR UPDATE;
 IF NOT FOUND OR a.kind<>'employee_full' THEN RETURN jsonb_build_object('refused','unavailable'); END IF;
 IF NOT app.import_attempt_access(attempt_,'maintain',true) THEN RETURN jsonb_build_object('refused','maintain'); END IF;
 IF EXISTS(SELECT 1 FROM public.import_attempt_event ev WHERE ev.attempt_id=attempt_ AND ev.kind='reverted') THEN RETURN jsonb_build_object('refused','reverted'); END IF;
 SELECT ev.id INTO confirmed_ FROM public.import_attempt_event ev WHERE ev.attempt_id=attempt_ AND ev.kind='confirmed' ORDER BY ev.created_at,ev.id LIMIT 1;
 IF confirmed_ IS NULL THEN RETURN jsonb_build_object('refused','unsaved'); END IF;
 SELECT array_agg(DISTINCT i.employment_id ORDER BY i.employment_id) INTO ids FROM public.import_attempt_item i
  WHERE i.attempt_id=attempt_ AND i.tenant_id=t AND i.status='applied' AND i.employment_id IS NOT NULL;
 -- The reviewed plan (the same items, the same confirmation) still holds.
 IF confirmed_::text IS DISTINCT FROM j.plan->>'confirmedEventId' OR ids IS NULL
  OR ids IS DISTINCT FROM ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(j.plan->'employmentIds') x ORDER BY x::uuid) THEN
  RETURN jsonb_build_object('refused','changed');
 END IF;
 -- Every employee still available: live, not voided, visible, and in a company the creator maintains, decided once per
 -- company (app.access_workforce_employment is exactly these conditions per employment).
 PERFORM 1 FROM public.employment e WHERE e.id=ANY(ids) ORDER BY e.id FOR UPDATE;
 IF EXISTS(
  WITH companies AS (SELECT c.company_id,app.access_workforce_company(c.company_id,'workforce.maintain') AS ok
   FROM (SELECT DISTINCT e.company_id FROM public.employment e WHERE e.id=ANY(ids) AND e.tenant_id=t) c)
  SELECT 1 FROM unnest(ids) x LEFT JOIN public.employment e ON e.id=x AND e.tenant_id=t LEFT JOIN companies c ON c.company_id=e.company_id
  WHERE e.id IS NULL OR e.voided_at IS NOT NULL OR NOT app.import_marker_visible(e.import_pending_attempt_id) OR NOT coalesce(c.ok,false))
  -- The person void guard's maintain (app.access_workforce_person): no employment of these persons in a denied company.
  OR EXISTS(SELECT 1 FROM (SELECT DISTINCT o.company_id FROM public.employment e JOIN public.employment o ON o.person_id=e.person_id AND o.tenant_id=e.tenant_id
   WHERE e.id=ANY(ids)) c WHERE NOT app.access_workforce_not_denied(c.company_id,'workforce.maintain'))
  OR EXISTS(SELECT 1 FROM app.employment_void_reference_blockers(ids)) THEN
  RETURN jsonb_build_object('refused','blocked');
 END IF;
 -- Every check above ran as the creator. The writes below run in the staged import discard's environment (owner
 -- connection, no request tenant or user: app.import_discard_batch), so the per-row guards take their owner path instead
 -- of re-deciding, per row, what was just decided for the set. No trigger on these tables records the session's user
 -- (the audit events below name the creator and tenant explicitly) and a void changes no system label. The
 -- last-administrator constraint, which each voided row would otherwise re-assert at COMMIT, is asserted once for the
 -- tenant below: none of these persons has a login (an app_user is a void blocker).
 PERFORM set_config('app.tenant_id','',true),set_config('app.user_id','',true),set_config('app.roles','',true),set_config('app.grants','[]',true);
 -- app.employment_void, as one statement per table.
 SELECT array_agg(DISTINCT e.person_id) INTO persons FROM public.employment e WHERE e.id=ANY(ids);
 UPDATE public.person p SET voided_at=now(),voided_ic_number=(SELECT s.ic_number FROM public.employee_statutory_my s WHERE s.person_id=p.id)
  WHERE p.id=ANY(persons) AND p.tenant_id=t;
 UPDATE public.employee_statutory_my s SET ic_number=NULL WHERE s.person_id=ANY(persons) AND s.tenant_id=t AND s.ic_number IS NOT NULL;
 WITH voided AS (
  UPDATE public.employment e SET voided_at=now(),voided_by=u,void_reason=reason_,voided_import_attempt_id=attempt_,
   voided_employee_code=e.employee_code,employee_code=NULL WHERE e.id=ANY(ids) RETURNING e.id,e.voided_employee_code)
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 SELECT t,'employment',v.id,'employment.voided','user',u,v.id,jsonb_build_object('importAttemptId',attempt_,'reason',reason_,'employeeCode',v.voided_employee_code)
 -- File order (the attempt's item ordinal): the synchronous void emitted its events in its UPDATE's scan order, which
 -- for an attempt's own rows is the order the import wrote them.
 FROM voided v ORDER BY (SELECT min(i.ordinal) FROM public.import_attempt_item i WHERE i.attempt_id=attempt_ AND i.employment_id=v.id),v.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>cardinality(ids) THEN RAISE EXCEPTION 'employee_import_revert_unavailable' USING ERRCODE='55000'; END IF;
 -- Import History: the attempt's once-only reverted event and its audit event (recordImportEventTx).
 INSERT INTO public.import_attempt_event(tenant_id,attempt_id,kind,actor_id,reason,detail)
 VALUES(t,attempt_,'reverted',u,reason_,jsonb_build_object('restored',n,'voided',n));
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'import-attempt',attempt_,'import-attempt.reverted','user',u,jsonb_build_object('kind','employee_full','reason',reason_,'restored',n,'voided',n));
 PERFORM set_config('app.tenant_id',t::text,true);
 PERFORM app.access_assert_administrator();
 PERFORM set_config('app.tenant_id','',true);
 UPDATE public.bulk_job SET plan=coalesce(plan,'{}'::jsonb)||jsonb_build_object('released',true,'restored',n),updated_at=now() WHERE id=p_job;
 RETURN jsonb_build_object('released',true,'restored',n);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employee_import_revert_release(uuid,boolean) FROM PUBLIC,ai_hr_app;
