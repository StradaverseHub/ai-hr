-- 524303d9 — VOID an employment created in error by an import (ADR-0157). Revert of an "Everything — new
-- employees" import never deletes: the person, employment and every row and event the hire wrote stay for
-- audit. A void is one-way, final and tied to the applied item of the import attempt (0675) that created
-- the employment. Voided rows leave every ordinary read through the employment/person RLS policies (the one
-- chokepoint all ai_hr_app reads share), the Workforce list projection and the Workforce access function.
-- Their Employee ID and NRIC are released (moved to the void columns) so a corrected file re-imports; the
-- work email is released by the voided person leaving every duplicate-email read (it stays on the row).
ALTER TABLE employment
 ADD COLUMN voided_at timestamptz,
 -- app_user id of the reverting administrator; not a foreign key so a void never pins a login row.
 ADD COLUMN voided_by uuid,
 ADD COLUMN void_reason text,
 -- import_attempt (0675) whose applied item created this employment; attempts are append-only.
 ADD COLUMN voided_import_attempt_id uuid,
 -- The Employee ID the employment held when voided; employee_code is cleared to release the unique index.
 ADD COLUMN voided_employee_code text;
--> statement-breakpoint
-- Every existing row has all five NULL. Writers of employee_code cannot reach a voided row (RLS below).
ALTER TABLE employment ADD CONSTRAINT employment_void_complete_ck CHECK (
 (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL AND voided_import_attempt_id IS NULL AND voided_employee_code IS NULL)
 OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(void_reason) BETWEEN 3 AND 1000
  AND voided_import_attempt_id IS NOT NULL AND employee_code IS NULL));
--> statement-breakpoint
ALTER TABLE person
 ADD COLUMN voided_at timestamptz,
 -- The identity number the person's statutory row held when voided; that row's ic_number is cleared.
 ADD COLUMN voided_ic_number text;
--> statement-breakpoint
-- Voided rows leave every ordinary read. Latest USING definitions: 0515_set_based_visibility.sql.
ALTER POLICY "employment_rls" ON "employment"
  USING ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((id = ANY ((SELECT app.visible_employment_ids())::uuid[])) OR app.can_admin_payroll_for(company_id) OR app.can_admin_perfcomp_for(company_id))));
--> statement-breakpoint
ALTER POLICY "person_rls" ON "person"
  USING ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND (((SELECT app.is_admin()) OR (id = ANY ((SELECT app.visible_person_ids())::uuid[]))) OR (EXISTS ( SELECT 1
   FROM employment e
  WHERE ((e.person_id = person.id) AND (e.tenant_id = app.current_tenant_id()) AND (app.can_admin_payroll_for(e.company_id) OR app.can_admin_perfcomp_for(e.company_id))))))));
--> statement-breakpoint
-- A void is final, and only an applied item of the named import attempt can be voided, by an actor who
-- can maintain the employment. The owner role (repair/restore) keeps its authority.
CREATE FUNCTION app.employment_void_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at AND NEW.voided_by IS NOT DISTINCT FROM OLD.voided_by
  AND NEW.void_reason IS NOT DISTINCT FROM OLD.void_reason AND NEW.voided_import_attempt_id IS NOT DISTINCT FROM OLD.voided_import_attempt_id
  AND NEW.voided_employee_code IS NOT DISTINCT FROM OLD.voided_employee_code THEN RETURN NEW; END IF;
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF OLD.voided_at IS NOT NULL THEN RAISE EXCEPTION 'employment_void_final' USING ERRCODE='42501'; END IF;
 IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.voided_by IS DISTINCT FROM app.current_user_id()
  OR NOT app.access_workforce_employment(OLD.id,'workforce.maintain')
  OR NOT EXISTS(SELECT 1 FROM public.import_attempt_item i JOIN public.import_attempt a ON a.id=i.attempt_id AND a.tenant_id=i.tenant_id
   WHERE i.attempt_id=NEW.voided_import_attempt_id AND i.employment_id=OLD.id AND i.status='applied'
    AND i.tenant_id=OLD.tenant_id AND a.kind='employee_full') THEN
  RAISE EXCEPTION 'employment_void_forbidden' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employment_void_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER employment_void_guard BEFORE UPDATE OF voided_at,voided_by,void_reason,voided_import_attempt_id,voided_employee_code ON employment
FOR EACH ROW EXECUTE FUNCTION app.employment_void_guard();
--> statement-breakpoint
CREATE FUNCTION app.person_void_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at AND NEW.voided_ic_number IS NOT DISTINCT FROM OLD.voided_ic_number THEN RETURN NEW; END IF;
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 -- Final, and only for a person whose every employment is being voided by the same import revert.
 IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL OR OLD.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR NOT app.access_workforce_person(OLD.id,'workforce.maintain')
  OR EXISTS(SELECT 1 FROM public.app_user u WHERE u.person_id=OLD.id)
  OR NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.import_attempt_item i ON i.employment_id=e.id AND i.status='applied'
   JOIN public.import_attempt a ON a.id=i.attempt_id AND a.kind='employee_full' WHERE e.person_id=OLD.id AND e.tenant_id=OLD.tenant_id) THEN
  RAISE EXCEPTION 'person_void_forbidden' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.person_void_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER person_void_guard BEFORE UPDATE OF voided_at,voided_ic_number ON person
FOR EACH ROW EXECUTE FUNCTION app.person_void_guard();
--> statement-breakpoint
-- Eligibility, derived from the foreign keys to employment and person at run time, so a table added later
-- blocks a void by default. Counts are taken as the definer (RLS cannot hide a payslip from the check).
-- Non-blocking references (written by the hire or the import itself, configuration, or audit) are listed
-- below with ADR-0157 §3's reasons; the hire's own rows are judged by shape (one assignment, one salary
-- revision, opening leave grants on the hire date).
CREATE FUNCTION app.employment_void_blockers(p_employments uuid[]) RETURNS TABLE(employment_id uuid,source text,row_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); ids uuid[]; wanted int; fk record;
BEGIN
 wanted:=cardinality(ARRAY(SELECT DISTINCT x FROM unnest(p_employments) x WHERE x IS NOT NULL));
 IF t IS NULL OR wanted IS NULL OR wanted=0 OR wanted>5000 THEN RAISE EXCEPTION 'employment_void_invalid' USING ERRCODE='22023'; END IF;
 SELECT array_agg(e.id ORDER BY e.id) INTO ids FROM public.employment e
  WHERE e.id=ANY(p_employments) AND e.tenant_id=t AND e.voided_at IS NULL;
 IF ids IS NULL OR cardinality(ids)<>wanted OR EXISTS(SELECT 1 FROM unnest(ids) x WHERE NOT app.access_workforce_employment(x,'workforce.maintain')) THEN
  RAISE EXCEPTION 'employment_void_unavailable' USING ERRCODE='42501';
 END IF;
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
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employment_void_blockers(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employment_void_blockers(uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- The void writer. A definer because a voided row no longer satisfies the RLS read policy its own UPDATE is
-- checked against; it re-checks every rule itself (actor, maintain access, the attempt's applied items, every
-- blocker), and the guard triggers above still run for each row it writes.
CREATE FUNCTION app.employment_void(p_employments uuid[],p_attempt uuid,p_reason text) RETURNS TABLE(employment_id uuid,employee_code text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); u uuid:=app.current_user_id(); ids uuid[]; persons uuid[];
BEGIN
 IF t IS NULL OR u IS NULL OR p_attempt IS NULL OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 1000 THEN
  RAISE EXCEPTION 'employment_void_invalid' USING ERRCODE='22023';
 END IF;
 SELECT array_agg(l.id ORDER BY l.id),array_agg(DISTINCT l.person_id) INTO ids,persons FROM (
  SELECT e.id,e.person_id FROM public.employment e WHERE e.id=ANY(p_employments) AND e.tenant_id=t AND e.voided_at IS NULL ORDER BY e.id FOR UPDATE) l;
 IF ids IS NULL OR cardinality(ids)<>cardinality(ARRAY(SELECT DISTINCT x FROM unnest(p_employments) x WHERE x IS NOT NULL))
  OR EXISTS(SELECT 1 FROM unnest(ids) x WHERE NOT EXISTS(SELECT 1 FROM public.import_attempt_item i JOIN public.import_attempt a ON a.id=i.attempt_id
   WHERE i.attempt_id=p_attempt AND i.employment_id=x AND i.status='applied' AND i.tenant_id=t AND a.kind='employee_full')) THEN
  RAISE EXCEPTION 'employment_void_unavailable' USING ERRCODE='42501';
 END IF;
 -- employment_void_blockers also checks workforce.maintain on every employment.
 IF EXISTS(SELECT 1 FROM app.employment_void_blockers(ids)) THEN RAISE EXCEPTION 'employment_void_blocked' USING ERRCODE='55000'; END IF;
 UPDATE public.person p SET voided_at=now(),voided_ic_number=(SELECT s.ic_number FROM public.employee_statutory_my s WHERE s.person_id=p.id)
  WHERE p.id=ANY(persons) AND p.tenant_id=t;
 UPDATE public.employee_statutory_my s SET ic_number=NULL WHERE s.person_id=ANY(persons) AND s.tenant_id=t AND s.ic_number IS NOT NULL;
 RETURN QUERY UPDATE public.employment e SET voided_at=now(),voided_by=u,void_reason=p_reason,voided_import_attempt_id=p_attempt,
  voided_employee_code=e.employee_code,employee_code=NULL WHERE e.id=ANY(ids) RETURNING e.id,e.voided_employee_code;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employment_void(uuid[],uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employment_void(uuid[],uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Workforce access and the Personnel list projection (latest: 0579_configurable_access.sql) exclude voided rows.
CREATE OR REPLACE FUNCTION app.access_workforce_employment(p_employment uuid,p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
  AND e.voided_at IS NULL AND app.access_workforce_company(e.company_id,p_capability));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_list_rows() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH permitted AS MATERIALIZED (
  SELECT c.id FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 )
 SELECT jsonb_build_object(
  'employmentId',e.id,'name',p.full_name,'email',p.primary_email,'employeeCode',e.employee_code,
  'department',COALESCE(NULLIF(btrim(d.label),''),d.name),'departmentId',a.department_id,
  'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title),'company',co.legal_name,'companyId',e.company_id,
  'hiredOn',e.hired_on,'terminatedOn',e.terminated_on,'confirmationDate',e.confirmation_date,
  'finalConfirmationDate',e.final_confirmation_date,'probationEndDate',e.probation_end_date,
  'provisionalEndOn',e.provisional_end_on,'resignationDate',e.resignation_date,'lastWorkingDate',e.last_working_date,
  'blacklistedAt',e.blacklisted_at,'jobGrade',g.name,'employmentType',a.employment_type,
  'businessUnit',COALESCE(NULLIF(btrim(bu.label),''),bu.code),'costCenter',cc.name,'workLocation',loc.name,
  'joinDate',e.join_date,'reportingTo',(
   SELECT mp.full_name FROM public.reporting_line rl
   JOIN public.employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id AND me.voided_at IS NULL
   JOIN permitted manager_scope ON manager_scope.id=me.company_id
   JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
   WHERE rl.tenant_id=e.tenant_id AND rl.subordinate_employment_id=e.id AND rl.line_type='administrative'
    AND rl.valid_to IS NULL AND rl.superseded_at IS NULL ORDER BY rl.valid_from DESC,rl.id LIMIT 1))
 FROM public.employment e JOIN permitted allowed ON allowed.id=e.company_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
 LEFT JOIN public.department d ON d.id=a.department_id AND d.tenant_id=e.tenant_id
 LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id
 LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=a.business_unit_id AND bu.tenant_id=e.tenant_id
 LEFT JOIN public.cost_center cc ON cc.id=a.cost_center_id AND cc.tenant_id=e.tenant_id
 LEFT JOIN public.location loc ON loc.id=a.location_id AND loc.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL;
$$;
--> statement-breakpoint
-- Login identity (latest: 0612_standalone_user_enrollment.sql): a voided person no longer holds its email.
CREATE OR REPLACE FUNCTION app.create_login_person(p_name text,p_email text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_person uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0));
 IF NOT app.access_legacy_configuration_permitted(NULL,NULL,NULL) OR NOT EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r
   ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
   WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
   AND NOT app.login_blocked(u.id)
   AND (r.role='super_admin' OR (r.role='hr_admin' AND r.company_id IS NULL))) THEN
  RAISE EXCEPTION 'manual_identity_forbidden' USING ERRCODE='insufficient_privilege';
 END IF;
 IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200
 OR p_email IS NULL OR length(p_email)>255 OR p_email<>lower(btrim(p_email))
 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
  RAISE EXCEPTION 'manual_identity_invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('login-person:'||app.current_tenant_id()::text||':'||p_email,0));
 IF EXISTS(SELECT 1 FROM public.person p WHERE p.tenant_id=app.current_tenant_id() AND p.voided_at IS NULL AND lower(btrim(p.primary_email))=p_email) THEN
  RAISE EXCEPTION 'manual_identity_conflict';
 END IF;
 INSERT INTO public.person(tenant_id,full_name,primary_email)
 VALUES(app.current_tenant_id(),btrim(p_name),p_email) RETURNING id INTO v_person;
 PERFORM app.append_auth_event(app.current_tenant_id(),'person',v_person,'person.login-contact-created','user',app.current_user_id(),
   jsonb_build_object('personId',v_person));
 RETURN v_person;
END;
$$;
