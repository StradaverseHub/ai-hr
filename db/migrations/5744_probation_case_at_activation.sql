-- A probation case opens at activation (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 6).
-- Tag 5744 / idx 5144 / when 1793330005444.
--
-- 1. Personnel source for an employment activated before its start date: the source read the assignment in effect
--    today, so a future starter had no employment type, department or unit and could not be admitted. When there is
--    no assignment today and the start date is still ahead, the assignment that takes effect on the start date is
--    used. Employments that have started read exactly as before, so no intake digest or pinned fact changes.
-- 2. No part is issued before the start date (probation_issue), so there are no tasks or reminders until then;
--    Part 1 timing still counts from the start date.
-- 3. Did not join: a hire voided as created in error, an employment that ends on or before its start date, or an
--    exit recorded while the start date is still ahead closes the case as withdrawn with data.closure
--    'did_not_join' (other withdrawals record 'exit'), cancels its unissued parts and audits 'did_not_join'. The case
--    state stays 'withdrawn', so every existing open/closed test keeps its meaning.
-- Owner-owned functions only; no table, row, grant or purpose-owned object changes.
CREATE FUNCTION app.probation_source_from_start(p_source jsonb,p_employment uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;a public.assignment;start_on date;
BEGIN
 IF p_source IS NULL OR p_source->>'employmentType' IS NOT NULL THEN RETURN p_source;END IF;
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN p_source;END IF;
 start_on:=coalesce(e.join_date,e.hired_on);
 IF start_on IS NULL OR start_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RETURN p_source;END IF;
 SELECT * INTO a FROM public.assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND superseded_at IS NULL AND valid_from<=start_on AND (valid_to IS NULL OR valid_to>start_on) ORDER BY valid_from DESC,id LIMIT 1;
 IF a.id IS NULL THEN RETURN p_source;END IF;
 RETURN p_source||jsonb_build_object('employmentType',a.employment_type,'departmentId',a.department_id,'businessUnitId',a.business_unit_id,
  'department',(SELECT name FROM public.department WHERE id=a.department_id AND tenant_id=e.tenant_id),
  'businessUnit',(SELECT name FROM public.business_unit WHERE id=a.business_unit_id AND tenant_id=e.tenant_id),
  'title',(SELECT title FROM public.position WHERE id=a.position_id AND tenant_id=e.tenant_id));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_source_from_start(jsonb,uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_personnel_source_unchecked(p_employment uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_organisation_facts(app.probation_source_from_start(app.probation_personnel_source_legacy_organisation(p_employment),p_employment),jsonb_build_object('organisationMapping',app.probation_organisation_mapping()));
$$;
--> statement-breakpoint
-- The hire did not join: voided as created in error, ended on or before the start date, or an exit is recorded while
-- the start date is still ahead.
CREATE FUNCTION app.probation_did_not_join(p_case uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((
  SELECT e.voided_at IS NOT NULL
   OR least(e.terminated_on,e.resignation_date,e.last_working_date)<=(c.data->>'startOn')::date
   OR (e.terminated_on IS NOT NULL OR e.resignation_date IS NOT NULL OR e.last_working_date IS NOT NULL OR e.tender_resignation_date IS NOT NULL)
      AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<(c.data->>'startOn')::date
  FROM public.probation_case c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
  WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id()),false);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_did_not_join(uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_issue(p_part uuid,p_today date) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RETURN false;END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs')) OR p_today IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Verified current-day probation scheduling required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF p.data->>'state'<>'not_issued' OR (p.data->>'issueOn')::date>p_today OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN RETURN false;END IF;
 -- Waiting for the start date: nothing is issued, so no task or reminder exists before the employee starts.
 IF (c.data->>'startOn')::date>p_today THEN RETURN false;END IF;
 IF p.data->>'type'<>'1' AND c.data->'config'->>'kpiGate'='block' AND c.data->>'kpiAcknowledged'<>'true' AND p.data->>'kpiException' IS NULL THEN RETURN false;END IF;
 UPDATE probation_part SET data=jsonb_set(data,'{state}','"issued"'::jsonb),revision=revision+1 WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'form_issued');RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_withdraw(p_case uuid,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;not_joined boolean;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp')) THEN RAISE EXCEPTION 'Probation withdrawal authority required';END IF;
 IF NOT EXISTS(SELECT 1 FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id AND (resignation_date IS NOT NULL OR terminated_on IS NOT NULL OR voided_at IS NOT NULL)) THEN RAISE EXCEPTION 'Record the resignation or exit in Personnel first';END IF;
 IF EXISTS(SELECT 1 FROM probation_outcome outcome WHERE outcome.case_id=c.id AND outcome.tenant_id=c.tenant_id AND outcome.released_at IS NOT NULL AND outcome.state<>'completed') THEN
  RAISE EXCEPTION 'A released outcome and the recorded Personnel exit require reconciliation';
 END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 not_joined:=app.probation_did_not_join(c.id);
 UPDATE probation_case SET data=data||jsonb_build_object('state','withdrawn','closure',CASE WHEN not_joined THEN 'did_not_join' ELSE 'exit' END),revision=revision+1 WHERE id=c.id;
 UPDATE probation_occurrence SET state='cancelled' WHERE tenant_id=c.tenant_id AND case_id=c.id AND state IN('ready','scheduled');
 IF not_joined THEN
  UPDATE probation_part SET data=jsonb_set(data,'{state}','"cancelled"'::jsonb),revision=revision+1 WHERE case_id=c.id AND tenant_id=c.tenant_id AND data->>'state'='not_issued';
 END IF;
 PERFORM app.probation_audit(c.id,NULL,CASE WHEN not_joined THEN 'did_not_join' ELSE 'withdrawn' END,p_reason);
END $$;
