-- Board 511aa74a — Rehired (docs/adr/2026-11-15-rehired-movement.md). A resigned employee who returns gets a NEW
-- employment for the SAME person (new Employee ID, new period); the previous employment is not changed. This
-- migration adds the one fact that links the two periods and the guarded way to undo a Rehired event.
--
-- 1. employment.rehired_from_employment_id: the previous period a rehire started from. Nullable, no default and no
--    backfill (every existing row stays NULL). Same tenant (composite key), never itself, and a live (not voided)
--    previous period is rehired at most once (partial unique index). Written only by the rehire command: the
--    guard trigger refuses any other writer of the column (a transaction-local marker names the employment the
--    command is linking, the source must be a live employment of the same person and both must be maintainable
--    by the actor) and the link never changes once set. The storage owner keeps its repair authority.
-- 2. Roll Back of a Rehired event voids the new employment through the 0676 void columns. The void CHECK now
--    also accepts a rehire void (no import attempt; the link names the rehire), and the void guard accepts it
--    only from app.employment_rehire_rollback, which re-checks the actor, Workforce maintain and the blockers.
--    The person is never voided (they keep their previous period and login). The Employee ID is released.
-- 3. app.employment_rehire_rollback_blockers: why a rehire cannot be undone — the new period's lifecycle has
--    ended, a later assignment or salary revision, a leave debit or time-off-in-lieu credit, a direct report,
--    or any row of any other table that references the employment and is not written by the hire itself
--    (derived from the foreign keys at run time, as 0676 does, so a table added later blocks by default).
-- 4. app.employment_rehire_person_state: the admission facts about the person's other periods (open periods,
--    blacklisted periods, latest end date, an existing rehire of the source), as counts and dates only.
--
-- Applies as the restricted owner: employment and the 0676 functions are owner-owned; no purpose-owned object is
-- replaced. employment keeps its table-level grants (0001), which cover the new column, and its row security.
ALTER TABLE public.employment ADD COLUMN rehired_from_employment_id uuid;
--> statement-breakpoint
ALTER TABLE public.employment ADD CONSTRAINT employment_rehired_from_fk
 FOREIGN KEY (rehired_from_employment_id,tenant_id) REFERENCES public.employment(id,tenant_id);
--> statement-breakpoint
ALTER TABLE public.employment ADD CONSTRAINT employment_rehired_from_not_self_ck
 CHECK (rehired_from_employment_id IS NULL OR rehired_from_employment_id<>id);
--> statement-breakpoint
CREATE UNIQUE INDEX employment_rehired_from_uq ON public.employment(rehired_from_employment_id)
 WHERE rehired_from_employment_id IS NOT NULL AND voided_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION app.employment_rehire_link_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.rehired_from_employment_id IS NOT DISTINCT FROM OLD.rehired_from_employment_id THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' AND NEW.rehired_from_employment_id IS NULL THEN RETURN NEW; END IF;
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' OR OLD.rehired_from_employment_id IS NOT NULL OR NEW.rehired_from_employment_id IS NULL
  OR OLD.voided_at IS NOT NULL OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR pg_catalog.current_setting('app.rehire_link',true) IS DISTINCT FROM NEW.id::text
  OR NOT EXISTS(SELECT 1 FROM public.employment s WHERE s.id=NEW.rehired_from_employment_id AND s.tenant_id=NEW.tenant_id
   AND s.person_id=NEW.person_id AND s.id<>NEW.id AND s.voided_at IS NULL)
  OR NOT app.access_workforce_employment(NEW.rehired_from_employment_id,'workforce.maintain')
  OR NOT app.access_workforce_employment(NEW.id,'workforce.maintain') THEN
  RAISE EXCEPTION 'employment_rehire_link_forbidden' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employment_rehire_link_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER employment_rehire_link_insert_guard BEFORE INSERT ON public.employment
FOR EACH ROW WHEN (NEW.rehired_from_employment_id IS NOT NULL) EXECUTE FUNCTION app.employment_rehire_link_guard();
--> statement-breakpoint
CREATE TRIGGER employment_rehire_link_update_guard BEFORE UPDATE OF rehired_from_employment_id ON public.employment
FOR EACH ROW WHEN (NEW.rehired_from_employment_id IS DISTINCT FROM OLD.rehired_from_employment_id) EXECUTE FUNCTION app.employment_rehire_link_guard();
--> statement-breakpoint
ALTER TABLE public.employment DROP CONSTRAINT employment_void_complete_ck;
--> statement-breakpoint
ALTER TABLE public.employment ADD CONSTRAINT employment_void_complete_ck CHECK (
 (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL AND voided_import_attempt_id IS NULL AND voided_employee_code IS NULL)
 OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(void_reason) BETWEEN 3 AND 1000
  AND (voided_import_attempt_id IS NOT NULL OR rehired_from_employment_id IS NOT NULL) AND employee_code IS NULL));
--> statement-breakpoint
-- 0676's guard, unchanged except for the rehire Roll Back branch (marker set only by app.employment_rehire_rollback).
CREATE OR REPLACE FUNCTION app.employment_void_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at AND NEW.voided_by IS NOT DISTINCT FROM OLD.voided_by
  AND NEW.void_reason IS NOT DISTINCT FROM OLD.void_reason AND NEW.voided_import_attempt_id IS NOT DISTINCT FROM OLD.voided_import_attempt_id
  AND NEW.voided_employee_code IS NOT DISTINCT FROM OLD.voided_employee_code THEN RETURN NEW; END IF;
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;
 IF OLD.voided_at IS NOT NULL THEN RAISE EXCEPTION 'employment_void_final' USING ERRCODE='42501'; END IF;
 IF NEW.voided_import_attempt_id IS NULL AND OLD.rehired_from_employment_id IS NOT NULL
  AND NEW.rehired_from_employment_id IS NOT DISTINCT FROM OLD.rehired_from_employment_id
  AND OLD.tenant_id=app.current_tenant_id() AND NEW.voided_by=app.current_user_id()
  AND pg_catalog.current_setting('app.rehire_rollback',true)=OLD.id::text
  AND app.access_workforce_employment(OLD.id,'workforce.maintain') THEN
  RETURN NEW;
 END IF;
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
-- Counts are taken as the definer, so row security cannot hide an activity row from the check.
CREATE FUNCTION app.employment_rehire_rollback_blockers(p_employment uuid) RETURNS TABLE(source text,row_count bigint)
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employment_rehire_rollback_blockers(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employment_rehire_rollback_blockers(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The Roll Back writer. A definer because a voided row no longer satisfies the row-security policy its own UPDATE is
-- checked against; it re-checks the actor, the blockers (which re-check Workforce maintain) and the link itself.
CREATE FUNCTION app.employment_rehire_rollback(p_employment uuid,p_reason text)
RETURNS TABLE(employment_id uuid,employee_code text,rehired_from_employment_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); u uuid:=app.current_user_id(); source uuid;
BEGIN
 IF t IS NULL OR u IS NULL OR p_employment IS NULL OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 1000 THEN
  RAISE EXCEPTION 'employment_rehire_rollback_invalid' USING ERRCODE='22023';
 END IF;
 SELECT e.rehired_from_employment_id INTO source FROM public.employment e
  WHERE e.id=p_employment AND e.tenant_id=t AND e.voided_at IS NULL FOR UPDATE;
 IF source IS NULL THEN RAISE EXCEPTION 'employment_rehire_rollback_unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM app.employment_rehire_rollback_blockers(p_employment)) THEN
  RAISE EXCEPTION 'employment_rehire_rollback_blocked' USING ERRCODE='55000';
 END IF;
 PERFORM pg_catalog.set_config('app.rehire_rollback',p_employment::text,true);
 RETURN QUERY UPDATE public.employment e SET voided_at=now(),voided_by=u,void_reason=p_reason,
  voided_employee_code=e.employee_code,employee_code=NULL
  WHERE e.id=p_employment RETURNING e.id,e.voided_employee_code,e.rehired_from_employment_id;
 PERFORM pg_catalog.set_config('app.rehire_rollback','',true);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employment_rehire_rollback(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employment_rehire_rollback(uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- The rehire admission facts about the person's OTHER employment periods, counted as the definer so an
-- administrator who cannot see a period in another company still cannot start a second current employment.
-- Discloses counts and dates only, and only to an actor who may maintain the source period. A period is open
-- unless the earliest of its resignation, last working and termination dates is on or before p_today (the HR
-- date the caller passes, core/employment-status.ts); a blacklisted period blocks rehire.
CREATE FUNCTION app.employment_rehire_person_state(p_source uuid,p_today date)
RETURNS TABLE(open_periods integer,blacklisted_periods integer,latest_end date,rehired_as_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); who uuid;
BEGIN
 SELECT s.person_id INTO who FROM public.employment s WHERE s.id=p_source AND s.tenant_id=t AND s.voided_at IS NULL;
 IF t IS NULL OR who IS NULL OR p_today IS NULL OR NOT app.access_workforce_employment(p_source,'workforce.maintain') THEN
  RAISE EXCEPTION 'employment_rehire_unavailable' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT
  (count(*) FILTER (WHERE e.id<>p_source AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
   OR least(e.resignation_date,e.last_working_date,e.terminated_on)>p_today)))::integer,
  (count(*) FILTER (WHERE e.blacklisted_at IS NOT NULL))::integer,
  max(least(e.resignation_date,e.last_working_date,e.terminated_on)),
  (SELECT r.employee_code FROM public.employment r WHERE r.rehired_from_employment_id=p_source AND r.tenant_id=t AND r.voided_at IS NULL)
 FROM public.employment e WHERE e.person_id=who AND e.tenant_id=t AND e.voided_at IS NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employment_rehire_person_state(uuid,date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employment_rehire_person_state(uuid,date) TO ai_hr_app;
