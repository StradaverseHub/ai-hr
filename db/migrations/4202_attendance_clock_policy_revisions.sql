-- Independently dated clock settings. Installing this migration neither enables overtime
-- execution policy nor rewrites existing Schedule Groups, punches, results or payroll.
CREATE UNIQUE INDEX attendance_rule_id_tenant_clock_policy_uq ON public.attendance_rule(id,tenant_id);
CREATE TABLE public.attendance_clock_policy_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,rule_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>0),
 effective_from date NOT NULL CHECK(isfinite(effective_from)),
 policy jsonb NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 created_by_user_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT attendance_clock_policy_company_fk FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT attendance_clock_policy_rule_fk FOREIGN KEY(rule_id,tenant_id) REFERENCES public.attendance_rule(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT attendance_clock_policy_actor_fk FOREIGN KEY(created_by_user_id,tenant_id) REFERENCES public.app_user(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT attendance_clock_policy_revision_ordinal_uq UNIQUE(tenant_id,company_id,rule_id,ordinal),
 CONSTRAINT attendance_clock_policy_revision_date_uq UNIQUE(tenant_id,company_id,rule_id,effective_from),
 CONSTRAINT attendance_clock_policy_document_ck CHECK ((
  jsonb_typeof(policy)='object' AND policy ?& ARRAY['pairing','minimumIntervalMinutes']
  AND policy-ARRAY['pairing','minimumIntervalMinutes']='{}'::jsonb
  AND jsonb_typeof(policy->'pairing')='object'
  AND policy->'pairing' ?& ARRAY['normal','rest','off','publicHoliday']
  AND (policy->'pairing')-ARRAY['normal','rest','off','publicHoliday']='{}'::jsonb
  AND policy->'pairing'->>'normal' IN ('auto','firstInLastOut')
  AND policy->'pairing'->>'rest' IN ('auto','firstInLastOut')
  AND policy->'pairing'->>'off' IN ('auto','firstInLastOut')
  AND policy->'pairing'->>'publicHoliday' IN ('auto','firstInLastOut')
  AND jsonb_typeof(policy->'minimumIntervalMinutes')='number'
  AND policy->>'minimumIntervalMinutes' ~ '^[0-9]{1,4}$'
  AND policy->'minimumIntervalMinutes' <= '4320'::jsonb
 ) IS TRUE)
);
CREATE INDEX attendance_clock_policy_tenant_date_idx ON public.attendance_clock_policy_revision(tenant_id,effective_from);
--> statement-breakpoint

ALTER TABLE public.attendance_clock_policy_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_clock_policy_revision FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_clock_policy_revision FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON public.attendance_clock_policy_revision TO ai_hr_app;

-- The internal reader takes a canonical dated employer and group. Company history is
-- further restricted to company administrators by the owner service.
CREATE POLICY attendance_clock_policy_read ON public.attendance_clock_policy_revision FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.attendance_policy_principal_current()) AND (
  app.is_admin_for(company_id)
  OR EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=attendance_clock_policy_revision.tenant_id
   AND e.company_id=attendance_clock_policy_revision.company_id AND e.id=ANY((SELECT app.visible_employment_ids())::uuid[]))
  OR EXISTS(SELECT 1 FROM public.assignment a WHERE a.tenant_id=attendance_clock_policy_revision.tenant_id
   AND a.company_id=attendance_clock_policy_revision.company_id AND a.superseded_at IS NULL
   AND a.employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]))
 ));
CREATE POLICY attendance_clock_policy_insert ON public.attendance_clock_policy_revision FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND (SELECT app.attendance_policy_principal_current())
  AND app.is_admin_for(company_id) AND created_by_user_id=app.current_user_id());
--> statement-breakpoint

-- Synchronize with the existing raw clock and batch import barrier. Retain the overtime
-- epoch's value and the independent group overtime contract.
CREATE FUNCTION app.lock_attendance_clock_policy_configuration(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM app.current_tenant_id() OR app.is_admin() IS NOT TRUE THEN
  RAISE EXCEPTION 'Attendance clock configuration is outside administrator scope' USING ERRCODE='42501';
 END IF;
 PERFORM app.access_profile_policy_write_lock();
 IF app.attendance_policy_principal_current() IS NOT TRUE OR app.is_admin() IS NOT TRUE THEN
  RAISE EXCEPTION 'Current Attendance administrator required' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.overtime_pattern_epoch(tenant_id,revision) VALUES(p_tenant,0) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.overtime_pattern_epoch WHERE tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Attendance clock configuration is unavailable' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.lock_attendance_clock_policy_configuration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_attendance_clock_policy_configuration(uuid) TO ai_hr_app;
--> statement-breakpoint

CREATE FUNCTION app.guard_attendance_clock_policy_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE previous public.attendance_clock_policy_revision;
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'Retain immutable Attendance clock policy history' USING ERRCODE='23514';
 END IF;
 PERFORM app.lock_attendance_clock_policy_configuration(NEW.tenant_id);
 IF app.attendance_policy_principal_current() IS NOT TRUE OR app.is_admin_for(NEW.company_id) IS NOT TRUE
  OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Attendance clock policy is outside company administrator scope' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.company WHERE id=NEW.company_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM public.attendance_rule WHERE id=NEW.rule_id AND tenant_id=NEW.tenant_id AND status='active') THEN
  RAISE EXCEPTION 'Choose an active company and Schedule Group in this tenant' USING ERRCODE='23514';
 END IF;
 NEW.created_at:=clock_timestamp();
 IF NEW.effective_from<=(NEW.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN
  RAISE EXCEPTION 'Choose a future date for Attendance clock settings' USING ERRCODE='23514';
 END IF;
 SELECT * INTO previous FROM public.attendance_clock_policy_revision
 WHERE tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND rule_id=NEW.rule_id
 ORDER BY ordinal DESC LIMIT 1;
 IF NEW.ordinal<>coalesce(previous.ordinal,0)+1 OR previous.effective_from>=NEW.effective_from THEN
  RAISE EXCEPTION 'Attendance clock policy history changed. Reload before scheduling.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_attendance_clock_policy_revision() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_clock_policy_revision_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.attendance_clock_policy_revision FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_clock_policy_revision();
--> statement-breakpoint

-- A legacy company-owned Schedule Group may now be used by a clock policy for a
-- different company. Its original company's deletion check returns existence only.
CREATE FUNCTION app.attendance_clock_rule_company_in_use(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT wanted_company IS NOT NULL AND app.current_tenant_id() IS NOT NULL
  AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(wanted_company)
  AND EXISTS(
   SELECT 1 FROM public.attendance_clock_policy_revision r
   JOIN public.attendance_rule g ON g.id=r.rule_id AND g.tenant_id=r.tenant_id
   WHERE r.tenant_id=app.current_tenant_id() AND g.company_id=wanted_company
  );
$$;
REVOKE ALL ON FUNCTION app.attendance_clock_rule_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_clock_rule_company_in_use(uuid) TO ai_hr_app;

CREATE POLICY attendance_clock_policy_rule_retention ON public.attendance_clock_policy_revision FOR SELECT
 USING(current_user=pg_get_userbyid((SELECT proowner FROM pg_proc
  WHERE oid='app.attendance_clock_rule_company_in_use(uuid)'::regprocedure))
  AND tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current())
  AND EXISTS(SELECT 1 FROM public.attendance_rule g
   WHERE g.id=attendance_clock_policy_revision.rule_id AND g.tenant_id=attendance_clock_policy_revision.tenant_id
    AND g.company_id IS NOT NULL AND app.is_admin_for(g.company_id)));
