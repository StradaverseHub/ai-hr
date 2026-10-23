-- Board 1 reservation: 0590 / 1791900000070. DRAFT, UNREGISTERED AND UNAPPLIED.
-- Add immutable policy-part storage and explicit policy financial evidence below the existing OT
-- parent. The settlement admission fence remains until actual current consumer replay is complete.
-- Existing assignment calculations, source identity and the single cash/TOIL settlement are retained.
ALTER TABLE public.attendance_overtime_calculation
 ADD COLUMN binding_kind text NOT NULL DEFAULT 'assignedPattern',
 ADD COLUMN policy_revision_id uuid REFERENCES public.attendance_group_policy_revision(id) ON DELETE RESTRICT,
 ADD COLUMN policy_part_count integer NOT NULL DEFAULT 0,
 ADD CONSTRAINT attendance_overtime_binding_kind_ck CHECK(binding_kind IN('assignedPattern','attendanceGroupPolicy')),
 ADD CONSTRAINT attendance_overtime_policy_part_count_ck CHECK(policy_part_count BETWEEN 0 AND 3),
 ADD CONSTRAINT attendance_overtime_policy_staged_ck CHECK(
  (binding_kind='assignedPattern' AND policy_revision_id IS NULL AND policy_part_count=0)
  OR(binding_kind='attendanceGroupPolicy' AND policy_revision_id IS NOT NULL
   AND version_id IS NULL AND assignment_id IS NULL
   AND ((outcome='refused' AND duration_outcome IN('refused','ready') AND NOT transferable)
    OR(outcome='ready' AND duration_outcome='ready' AND transferable AND policy_part_count>0
     AND approval_status IN('approved','notRequired')))));
-- Extend only the original version/assignment admission CHECK, preserving its assigned branch.
-- Discover its generated name by its columns, fail closed on unexpected schema rather than
-- dropping an arbitrary constraint or rewriting the frozen 0551 migration.
DO $$ DECLARE names text[];BEGIN
 SELECT array_agg(conname ORDER BY conname) INTO names FROM pg_constraint
  WHERE conrelid='public.attendance_overtime_calculation'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%version_id IS NOT NULL%'
   AND pg_get_constraintdef(oid) LIKE '%assignment_id IS NOT NULL%';
 IF coalesce(array_length(names,1),0)<>1 THEN
  RAISE EXCEPTION 'Expected one original version-assignment admission constraint';END IF;
 EXECUTE format('ALTER TABLE public.attendance_overtime_calculation DROP CONSTRAINT %I',names[1]);
END $$;
ALTER TABLE public.attendance_overtime_calculation ADD CONSTRAINT attendance_overtime_binding_admission_ck CHECK(
 (binding_kind='assignedPattern' AND ((version_id IS NOT NULL AND assignment_id IS NOT NULL)
  OR(outcome='refused' AND version_id IS NULL AND assignment_id IS NULL)))
 OR(binding_kind='attendanceGroupPolicy' AND policy_revision_id IS NOT NULL AND version_id IS NULL AND assignment_id IS NULL));
--> statement-breakpoint
CREATE TABLE public.attendance_overtime_policy_part(
 calculation_id uuid NOT NULL REFERENCES public.attendance_overtime_calculation(id) ON DELETE RESTRICT,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL REFERENCES public.company(id) ON DELETE RESTRICT,
 sequence integer NOT NULL CHECK(sequence BETWEEN 0 AND 2),
 calendar_date date NOT NULL,
 day_class text NOT NULL CHECK(day_class IN('normal','off','rest','publicHoliday','replacementHoliday')),
 money_day text NOT NULL CHECK(money_day IN('workday','rest_day','holiday')),
 version_id uuid NOT NULL REFERENCES public.overtime_pattern_version(id) ON DELETE RESTRICT,
 input_digest text NOT NULL CHECK(input_digest ~ '^[0-9a-f]{64}$'),
 raw_minutes integer NOT NULL CHECK(raw_minutes BETWEEN 1 AND 4320),
 allocated_payable_minutes integer NOT NULL CHECK(allocated_payable_minutes BETWEEN 0 AND raw_minutes),
 source_intervals jsonb NOT NULL CHECK(jsonb_typeof(source_intervals)='array' AND octet_length(source_intervals::text)<=262144),
 calendar_references jsonb NOT NULL CHECK(jsonb_typeof(calendar_references)='array' AND octet_length(calendar_references::text)<=32768),
 duration_evidence jsonb NOT NULL CHECK(jsonb_typeof(duration_evidence)='object' AND octet_length(duration_evidence::text)<=262144
  AND (duration_evidence->>'authority') IS NOT DISTINCT FROM 'proposalOnly'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(calculation_id,sequence),
 UNIQUE(calculation_id,calendar_date),
 CONSTRAINT attendance_overtime_policy_money_day_ck CHECK(
  (day_class IN('normal','off') AND money_day='workday')
  OR(day_class='rest' AND money_day='rest_day')
  OR(day_class IN('publicHoliday','replacementHoliday') AND money_day='holiday'))
);
CREATE INDEX attendance_overtime_policy_part_scope_idx
 ON public.attendance_overtime_policy_part(tenant_id,company_id,calculation_id);
ALTER TABLE public.attendance_overtime_policy_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_overtime_policy_part FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_overtime_policy_part FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON public.attendance_overtime_policy_part TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_attendance_overtime_policy_header() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.attendance_overtime_source;policy public.attendance_group_policy_revision;recorded_group text;
BEGIN
 IF NEW.binding_kind<>'attendanceGroupPolicy' THEN RETURN NEW;END IF;
 IF NOT app.principal_snapshot_current() THEN
  RAISE EXCEPTION 'Current Attendance principal required' USING ERRCODE='42501';END IF;
 SELECT * INTO source FROM public.attendance_overtime_source
  WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 IF NOT FOUND OR NOT app.overtime_attendance_visible(source.tenant_id,source.employment_id,source.attendance_date) THEN
  RAISE EXCEPTION 'Policy calculation is outside Attendance subject authority' USING ERRCODE='42501';END IF;
 SELECT * INTO policy FROM public.attendance_group_policy_revision
  WHERE id=NEW.policy_revision_id AND tenant_id=source.tenant_id AND company_id=source.company_id
   AND effective_from<=source.attendance_date;
 IF NOT FOUND THEN RAISE EXCEPTION 'Policy revision does not cover this source employer/date' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_group_policy_revision newer
  WHERE newer.tenant_id=policy.tenant_id AND newer.company_id=policy.company_id AND newer.rule_id=policy.rule_id
   AND newer.effective_from<=source.attendance_date AND newer.ordinal>policy.ordinal) THEN
  RAISE EXCEPTION 'Policy revision does not own the dated source' USING ERRCODE='23514';END IF;
 SELECT calc_trace#>>'{schedule,ruleId}' INTO recorded_group FROM public.attendance WHERE id=source.attendance_id;
 IF recorded_group IS DISTINCT FROM policy.rule_id::text THEN
  RAISE EXCEPTION 'Policy group must match the canonical recorded schedule' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_attendance_overtime_policy_header() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_overtime_policy_header_guard BEFORE INSERT ON public.attendance_overtime_calculation
 FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_overtime_policy_header();
--> statement-breakpoint
CREATE FUNCTION app.guard_attendance_overtime_policy_part() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE header public.attendance_overtime_calculation;source public.attendance_overtime_source;
 policy public.attendance_group_policy_revision;version public.overtime_pattern_version;state text;
 item jsonb;from_text text;to_text text;start_minute integer;end_minute integer;previous_end integer:=-1;
 total_minutes integer:=0;keys_count integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Policy parts are immutable' USING ERRCODE='23514';END IF;
 IF NOT app.principal_snapshot_current() THEN
  RAISE EXCEPTION 'Current Attendance principal required' USING ERRCODE='42501';END IF;
 SELECT * INTO header FROM public.attendance_overtime_calculation
  WHERE id=NEW.calculation_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 IF NOT FOUND OR header.binding_kind<>'attendanceGroupPolicy' OR NEW.sequence>=header.policy_part_count THEN
  RAISE EXCEPTION 'Policy part requires its exact declared parent calculation' USING ERRCODE='23514';END IF;
 SELECT * INTO source FROM public.attendance_overtime_source WHERE id=header.source_id;
 IF NOT FOUND OR NOT app.overtime_attendance_visible(source.tenant_id,source.employment_id,source.attendance_date) THEN
  RAISE EXCEPTION 'Policy part is outside Attendance subject authority' USING ERRCODE='42501';END IF;
 SELECT * INTO policy FROM public.attendance_group_policy_revision WHERE id=header.policy_revision_id;
 IF NEW.input_digest IS DISTINCT FROM header.input_digest OR NEW.calendar_date<source.attendance_date
  OR NEW.calendar_date>source.attendance_date+2
  OR policy.policy->'overtime'->'days'->NEW.day_class->>'patternVersionId' IS DISTINCT FROM NEW.version_id::text THEN
  RAISE EXCEPTION 'Policy part binding/date/digest does not match its parent' USING ERRCODE='23514';END IF;
 IF policy.policy->'overtime'->>'splitAtMidnight'='false' AND NEW.calendar_date<>source.attendance_date THEN
  RAISE EXCEPTION 'Unsplit policy retains its parent attendance date' USING ERRCODE='23514';END IF;
 SELECT v.* INTO version FROM public.overtime_pattern_version v JOIN public.overtime_pattern p
  ON p.id=v.pattern_id AND p.tenant_id=v.tenant_id AND p.archived_at IS NULL
  WHERE v.id=NEW.version_id AND v.tenant_id=NEW.tenant_id AND v.kind='formula' AND v.activated_at IS NOT NULL;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.overtime_pattern_version_company
  WHERE version_id=version.id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id) THEN
  RAISE EXCEPTION 'Policy part requires an activated formula for its employer' USING ERRCODE='23514';END IF;
 SELECT s.state INTO state FROM public.overtime_pattern_version_state s WHERE s.version_id=version.id
  AND s.tenant_id=NEW.tenant_id AND s.effective_from<=NEW.calendar_date ORDER BY s.effective_from DESC,s.sequence DESC LIMIT 1;
 IF state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'Policy formula is inactive on the part date' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(NEW.source_intervals) NOT BETWEEN 1 AND 4320
  OR jsonb_array_length(NEW.calendar_references) NOT BETWEEN 1 AND 32 THEN
  RAISE EXCEPTION 'Retain bounded positioned work and calendar provenance' USING ERRCODE='23514';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.source_intervals) LOOP
  IF jsonb_typeof(item)<>'object' THEN RAISE EXCEPTION 'Invalid policy interval' USING ERRCODE='23514';END IF;
  SELECT count(*) INTO keys_count FROM jsonb_object_keys(item);
  from_text:=item->>'from';to_text:=item->>'to';
  IF keys_count<>2 OR jsonb_typeof(item->'from') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'to') IS DISTINCT FROM 'number'
   OR from_text !~ '^[0-9]{1,4}$' OR to_text !~ '^[0-9]{1,4}$' THEN
   RAISE EXCEPTION 'Policy intervals require exact whole-minute boundaries' USING ERRCODE='23514';END IF;
  start_minute:=from_text::integer;end_minute:=to_text::integer;
  IF start_minute<previous_end OR start_minute>=end_minute OR end_minute>4320 THEN
   RAISE EXCEPTION 'Policy intervals must be ordered, disjoint and bounded' USING ERRCODE='23514';END IF;
  IF policy.policy->'overtime'->>'splitAtMidnight'='true'
   AND(start_minute<(NEW.calendar_date-source.attendance_date)*1440
    OR end_minute>(NEW.calendar_date-source.attendance_date+1)*1440) THEN
   RAISE EXCEPTION 'Split policy intervals must belong to their actual calendar date' USING ERRCODE='23514';END IF;
  previous_end:=end_minute;total_minutes:=total_minutes+end_minute-start_minute;
 END LOOP;
 IF total_minutes<>NEW.raw_minutes THEN RAISE EXCEPTION 'Policy raw count must equal its positioned intervals' USING ERRCODE='23514';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.calendar_references) LOOP
  IF jsonb_typeof(item)<>'string' OR length(btrim(item#>>'{}')) NOT BETWEEN 1 AND 500 THEN
   RAISE EXCEPTION 'Invalid policy calendar provenance' USING ERRCODE='23514';END IF;
 END LOOP;
 IF(SELECT count(DISTINCT value) FROM jsonb_array_elements(NEW.calendar_references))<>jsonb_array_length(NEW.calendar_references) THEN
  RAISE EXCEPTION 'Policy calendar references must be distinct' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_attendance_overtime_policy_part() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_overtime_policy_part_guard BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_overtime_policy_part
 FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_overtime_policy_part();
--> statement-breakpoint
CREATE FUNCTION app.attendance_overtime_policy_part_set_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent_id uuid;header public.attendance_overtime_calculation;actual_count integer;low_sequence integer;high_sequence integer;
BEGIN
 IF TG_TABLE_NAME='attendance_overtime_calculation' THEN parent_id:=NEW.id;ELSE parent_id:=NEW.calculation_id;END IF;
 SELECT * INTO header FROM public.attendance_overtime_calculation WHERE id=parent_id;
 IF NOT FOUND OR header.binding_kind<>'attendanceGroupPolicy' THEN RETURN NULL;END IF;
 SELECT count(*),min(sequence),max(sequence) INTO actual_count,low_sequence,high_sequence
  FROM public.attendance_overtime_policy_part WHERE calculation_id=parent_id;
 IF actual_count<>header.policy_part_count OR(actual_count>0 AND(low_sequence<>0 OR high_sequence<>actual_count-1)) THEN
  RAISE EXCEPTION 'Policy calculation requires its entire declared part set' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_overtime_policy_part a JOIN public.attendance_overtime_policy_part b
  ON a.calculation_id=b.calculation_id AND a.sequence<b.sequence
  CROSS JOIN LATERAL jsonb_array_elements(a.source_intervals) AS x(value)
  CROSS JOIN LATERAL jsonb_array_elements(b.source_intervals) AS y(value)
  WHERE a.calculation_id=parent_id AND(x.value->>'from')::integer<(y.value->>'to')::integer
   AND(y.value->>'from')::integer<(x.value->>'to')::integer) THEN
  RAISE EXCEPTION 'Policy parts cannot claim overlapping parent intervals' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.attendance_overtime_policy_part_set_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER attendance_overtime_policy_header_complete AFTER INSERT ON public.attendance_overtime_calculation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.attendance_overtime_policy_part_set_complete();
CREATE CONSTRAINT TRIGGER attendance_overtime_policy_parts_complete AFTER INSERT ON public.attendance_overtime_policy_part
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.attendance_overtime_policy_part_set_complete();
--> statement-breakpoint
CREATE POLICY attendance_overtime_policy_part_read ON public.attendance_overtime_policy_part FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND(SELECT app.principal_snapshot_current()) AND EXISTS(
  SELECT 1 FROM public.attendance_overtime_calculation c JOIN public.attendance_overtime_source source ON source.id=c.source_id
  JOIN public.employment e ON e.id=source.employment_id
  WHERE c.id=attendance_overtime_policy_part.calculation_id AND c.tenant_id=attendance_overtime_policy_part.tenant_id
   AND c.company_id=attendance_overtime_policy_part.company_id
   AND(app.can_admin_payroll_for(c.company_id) OR app.is_self_person(e.person_id))));
CREATE POLICY attendance_overtime_policy_part_insert ON public.attendance_overtime_policy_part FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND(SELECT app.principal_snapshot_current()) AND EXISTS(
  SELECT 1 FROM public.attendance_overtime_calculation c JOIN public.attendance_overtime_source source ON source.id=c.source_id
  WHERE c.id=attendance_overtime_policy_part.calculation_id AND c.tenant_id=attendance_overtime_policy_part.tenant_id
   AND c.company_id=attendance_overtime_policy_part.company_id
   AND app.overtime_attendance_visible(source.tenant_id,source.employment_id,source.attendance_date)));
--> statement-breakpoint
-- A submission contract is NOT an approval or financial capability. The owner records the policy
-- epoch visible under one company lock; callers cannot backdate a request into legacy processing.
-- Existing policy rows conservatively receive epoch zero. Existing requests have no receipt and
-- are legacy only when no applicable epoch-zero policy was already installed at this cutover.
ALTER TABLE public.attendance_group_policy_revision ADD COLUMN activation_epoch bigint NOT NULL DEFAULT 0
 CHECK(activation_epoch BETWEEN 0 AND 9007199254740991);
CREATE UNIQUE INDEX attendance_group_policy_company_epoch_uq
 ON public.attendance_group_policy_revision(tenant_id,company_id,activation_epoch) WHERE activation_epoch>0;
CREATE TABLE app.attendance_policy_company_epoch(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 company_id uuid NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
 epoch bigint NOT NULL DEFAULT 0 CHECK(epoch BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(tenant_id,company_id));
ALTER TABLE app.attendance_policy_company_epoch ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attendance_policy_company_epoch FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_policy_company_epoch_owner ON app.attendance_policy_company_epoch FOR ALL
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='app.attendance_policy_company_epoch'::regclass)))
 WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='app.attendance_policy_company_epoch'::regclass)));
REVOKE ALL ON app.attendance_policy_company_epoch FROM PUBLIC,ai_hr_app;
CREATE TABLE public.attendance_policy_request_contract(
 correction_id uuid PRIMARY KEY REFERENCES public.attendance_correction(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 employment_id uuid NOT NULL REFERENCES public.employment(id),attendance_date date NOT NULL,
 company_id uuid REFERENCES public.company(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN('epoch','unavailable')),
 visible_epoch bigint CHECK(visible_epoch BETWEEN 0 AND 9007199254740991),
 planned_window jsonb CHECK(planned_window IS NULL OR jsonb_typeof(planned_window)='object'),
 attested_work jsonb CHECK(attested_work IS NULL OR jsonb_typeof(attested_work)='object'),
 policy_binding jsonb CHECK(policy_binding IS NULL OR jsonb_typeof(policy_binding)='object'),
 manual_approval_method text CHECK(manual_approval_method IS NULL OR manual_approval_method IN('requested','system_calculated','smaller_of','greater_of')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='epoch' AND company_id IS NOT NULL AND visible_epoch IS NOT NULL AND manual_approval_method IS NOT NULL)
   OR(kind='unavailable' AND company_id IS NULL AND visible_epoch IS NULL AND manual_approval_method IS NULL)));
ALTER TABLE public.attendance_policy_request_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_policy_request_contract FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_policy_request_contract_owner ON public.attendance_policy_request_contract FOR ALL
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.attendance_policy_request_contract'::regclass)))
 WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.attendance_policy_request_contract'::regclass)));
CREATE POLICY attendance_policy_request_contract_read ON public.attendance_policy_request_contract FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.attendance_policy_principal_current())
  AND EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=correction_id AND c.tenant_id=attendance_policy_request_contract.tenant_id));
REVOKE ALL ON public.attendance_policy_request_contract FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.attendance_policy_request_contract TO ai_hr_app;
REVOKE TRIGGER ON public.attendance_correction FROM ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.lock_attendance_policy_epoch(p_tenant uuid,p_company uuid) RETURNS bigint
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result bigint;
BEGIN
 IF p_tenant IS DISTINCT FROM app.current_tenant_id() OR app.attendance_policy_principal_current() IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.company WHERE id=p_company AND tenant_id=p_tenant) THEN
  RAISE EXCEPTION 'Current policy company authority required' USING ERRCODE='42501';END IF;
 INSERT INTO app.attendance_policy_company_epoch(tenant_id,company_id) VALUES(p_tenant,p_company) ON CONFLICT DO NOTHING;
 SELECT epoch INTO result FROM app.attendance_policy_company_epoch WHERE tenant_id=p_tenant AND company_id=p_company FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Policy epoch is unavailable' USING ERRCODE='23514';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.lock_attendance_policy_epoch(uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.capture_attendance_policy_activation_epoch() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous bigint;
BEGIN
 -- The original 0581 guard runs first and retains scoped admin, actor, future date and formula checks.
 previous:=app.lock_attendance_policy_epoch(NEW.tenant_id,NEW.company_id);
 IF previous>=9007199254740991 THEN RAISE EXCEPTION 'Policy epoch limit reached' USING ERRCODE='23514';END IF;
 UPDATE app.attendance_policy_company_epoch SET epoch=previous+1 WHERE tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 NEW.activation_epoch:=previous+1;NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.capture_attendance_policy_activation_epoch() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER zz_attendance_policy_activation_epoch BEFORE INSERT ON public.attendance_group_policy_revision
 FOR EACH ROW EXECUTE FUNCTION app.capture_attendance_policy_activation_epoch();
--> statement-breakpoint
CREATE FUNCTION app.capture_attendance_policy_request_contract() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_count integer;v_company uuid;v_epoch bigint;v_kind text:='unavailable';
 plan jsonb;start_min integer;end_min integer;duration_min integer;manual_method text;
 binding jsonb;bound public.attendance_group_policy_revision;
 work jsonb;attested jsonb;span jsonb;from_ms bigint;to_ms bigint;previous_ms bigint;midnight_ms bigint;requested_total integer:=0;
BEGIN
 IF NEW.original_clock_snapshot->'unclockedWork' IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.employment_id::text,0));
  PERFORM 1 FROM public.attendance_overtime_source source WHERE source.tenant_id=NEW.tenant_id
   AND source.employment_id=NEW.employment_id AND source.attendance_date=NEW.attendance_date FOR SHARE;
 END IF;
 IF NEW.tenant_id=app.current_tenant_id() AND app.attendance_policy_principal_current() THEN
  SELECT count(*),min(a.company_id::text)::uuid INTO v_count,v_company
   FROM public.employment e JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
   JOIN public.company company ON company.id=a.company_id AND company.tenant_id=e.tenant_id
   WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND a.superseded_at IS NULL
    AND a.valid_from<=NEW.attendance_date AND(a.valid_to IS NULL OR a.valid_to>NEW.attendance_date)
    AND NEW.attendance_date>=e.hired_on AND(e.terminated_on IS NULL OR NEW.attendance_date<=e.terminated_on);
  IF v_count=1 AND v_company IS NOT NULL THEN
   v_epoch:=app.lock_attendance_policy_epoch(NEW.tenant_id,v_company);
   IF app.attendance_policy_principal_current() IS NOT TRUE THEN RAISE EXCEPTION 'Current request principal required' USING ERRCODE='42501';END IF;
   -- Freeze the existing company's actual method observed at this submission. This is
   -- not a group-policy binding or an interval intersection calculation. No historical backfill.
   SELECT coalesce((SELECT p.ot_approval_calculation::text FROM public.attendance_policy p
    WHERE p.tenant_id=NEW.tenant_id AND p.company_id=v_company),'system_calculated') INTO manual_method;
   v_kind:='epoch';
  END IF;
 END IF;
 IF v_kind='unavailable' THEN v_company:=NULL;v_epoch:=NULL;END IF;
 -- The kernel's canonical resolver writes this identity into the existing immutable original
 -- snapshot. A posted/GUC policy ID never selects a schedule here. Check its exact immutable
 -- revision; future consumers must independently match the actual subject's current resolver.
 binding:=NEW.original_clock_snapshot->'executionPolicy';
 IF binding IS NOT NULL THEN
  SELECT * INTO bound FROM public.attendance_group_policy_revision r
   WHERE r.id=(binding->>'revisionId')::uuid AND r.tenant_id=NEW.tenant_id AND r.company_id=v_company;
  IF v_kind<>'epoch' OR NOT FOUND OR bound.effective_from>NEW.attendance_date
   OR bound.activation_epoch>v_epoch OR bound.created_at>clock_timestamp()
   -- The canonical JS Date reader retains milliseconds; PostgreSQL stores finer precision.
   -- Compare that same representable projection without rewriting the immutable timestamp.
   OR (binding->'activation'->>'recordedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',bound.created_at)
   OR binding IS DISTINCT FROM jsonb_build_object('authority','datedPolicyOnly','sourceDate',NEW.attendance_date,
    'employmentId',NEW.employment_id,'companyId',v_company,'revisionId',bound.id,'ruleId',bound.rule_id,
    'ordinal',bound.ordinal,'effectiveFrom',bound.effective_from,'pairing',bound.policy->'clock'->>'pairing',
    'activation',jsonb_build_object('epoch',bound.activation_epoch,'actorUserId',bound.created_by_user_id,
     'recordedAt',binding->'activation'->>'recordedAt')) THEN
   RAISE EXCEPTION 'The submitted canonical policy identity is unavailable' USING ERRCODE='23514';
  END IF;
 END IF;


 -- Actual-work testimony is an explicit HR-only submission, not a clock or approved-plan alias.
 -- The immutable contract records the database principal/time; supplied actor or authority is ignored.
 work:=NEW.original_clock_snapshot->'unclockedWork';
 IF work IS NOT NULL THEN
  IF v_kind<>'epoch' OR binding IS NULL OR bound.id IS NULL OR bound.activation_epoch<1
   OR bound.policy#>>'{overtime,enabled}' IS DISTINCT FROM 'true'
   OR bound.policy#>>'{overtime,allowBackdatedWithoutClock}' IS DISTINCT FROM 'true'
   OR app.can_admin_employment(NEW.employment_id) IS NOT TRUE
   OR EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.employment_id AND app.is_self_person(e.person_id)) THEN
   RAISE EXCEPTION 'Scoped HR authority and an active unclocked-work policy are required' USING ERRCODE='42501';END IF;
  IF NEW.attendance_date>(clock_timestamp() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   OR NEW.requested_ot_minutes IS NULL OR NEW.requested_ot_minutes<=0
   OR NEW.proposed_check_in IS NOT NULL OR NEW.proposed_check_out IS NOT NULL OR NEW.clock_changes IS NOT NULL
   OR NEW.planned_start_time IS NOT NULL OR NEW.planned_end_time IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.attendance_punch p JOIN public.attendance a ON a.id=p.attendance_id AND a.tenant_id=p.tenant_id
    WHERE a.tenant_id=NEW.tenant_id AND a.employment_id=NEW.employment_id
    AND a.attendance_date=NEW.attendance_date AND p.voided_at IS NULL)
   OR work IS DISTINCT FROM(jsonb_build_object('version',1,'completeWorkedDay',true,'sourceDate',NEW.attendance_date,
    'reason',NEW.reason,'intervals',work->'intervals')||CASE WHEN work?'requestedIntervals' THEN jsonb_build_object('requestedIntervals',work->'requestedIntervals') ELSE '{}'::jsonb END)
   OR char_length(btrim(NEW.reason)) NOT BETWEEN 1 AND 500 OR NEW.reason IS DISTINCT FROM btrim(NEW.reason)
   OR jsonb_typeof(work->'intervals') IS DISTINCT FROM 'array'
   OR jsonb_array_length(work->'intervals') NOT BETWEEN 1 AND 16 THEN
   RAISE EXCEPTION 'Record separate actual completed unclocked work and its reason' USING ERRCODE='23514';END IF;
  midnight_ms:=(extract(epoch FROM(NEW.attendance_date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'))*1000)::bigint;
  previous_ms:=midnight_ms;
  FOR span IN SELECT value FROM jsonb_array_elements(work->'intervals') LOOP
   IF coalesce(span->>'fromEpochMillisecond','') !~ '^[0-9]{1,16}$'
    OR coalesce(span->>'toEpochMillisecond','') !~ '^[0-9]{1,16}$' THEN
    RAISE EXCEPTION 'Unclocked work requires exact integer instants' USING ERRCODE='23514';END IF;
   from_ms:=(span->>'fromEpochMillisecond')::bigint;to_ms:=(span->>'toEpochMillisecond')::bigint;
   IF span IS DISTINCT FROM jsonb_build_object('fromEpochMillisecond',from_ms,'toEpochMillisecond',to_ms)
    OR from_ms<previous_ms OR to_ms<=from_ms OR to_ms>midnight_ms+259200000
    OR to_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
    RAISE EXCEPTION 'Unclocked work intervals must be completed and ordered in the dated period' USING ERRCODE='23514';END IF;
   previous_ms:=to_ms;
  END LOOP;
  IF work?'requestedIntervals' THEN
   IF jsonb_typeof(work->'requestedIntervals') IS DISTINCT FROM 'array' OR jsonb_array_length(work->'requestedIntervals') NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION 'Complete requested actual-work intervals required' USING ERRCODE='23514';END IF;
   previous_ms:=midnight_ms;
   FOR span IN SELECT value FROM jsonb_array_elements(work->'requestedIntervals') LOOP
    IF coalesce(span->>'fromEpochMillisecond','')!~'^[0-9]{1,16}$' OR coalesce(span->>'toEpochMillisecond','')!~'^[0-9]{1,16}$' THEN
     RAISE EXCEPTION 'Exact requested actual-work instants required' USING ERRCODE='23514';END IF;
    from_ms:=(span->>'fromEpochMillisecond')::bigint;to_ms:=(span->>'toEpochMillisecond')::bigint;
    IF span IS DISTINCT FROM jsonb_build_object('fromEpochMillisecond',from_ms,'toEpochMillisecond',to_ms)
     OR from_ms<previous_ms OR to_ms<=from_ms
     OR floor((to_ms-midnight_ms)::numeric/60000)<=floor((from_ms-midnight_ms)::numeric/60000)
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(work->'intervals') actual
      WHERE(actual->>'fromEpochMillisecond')::bigint<=from_ms AND(actual->>'toEpochMillisecond')::bigint>=to_ms) THEN
     RAISE EXCEPTION 'Requested overtime must retain ordered exact actual-work subsets' USING ERRCODE='23514';END IF;
    requested_total:=requested_total+floor((to_ms-midnight_ms)::numeric/60000)::integer-floor((from_ms-midnight_ms)::numeric/60000)::integer;
    previous_ms:=to_ms;
   END LOOP;
   IF requested_total<>NEW.requested_ot_minutes THEN RAISE EXCEPTION 'Requested count differs from its actual positioned intervals' USING ERRCODE='23514';END IF;
  END IF;
  attested:=jsonb_build_object('version',1,'authority','hrAttestedWorkSubmission','correctionId',NEW.id,
   'tenantId',NEW.tenant_id,'companyId',v_company,'employmentId',NEW.employment_id,'date',NEW.attendance_date,
   'actorUserId',app.current_user_id(),'recordedAt',clock_timestamp(),'work',work);
 END IF;

 -- Only newly submitted explicit minute windows acquire the dated plan contract. Historical
 -- labels, missing/equal/subminute endpoints and count-only requests cannot acquire one by replay.
 -- Reuse the existing Plan OT convention: date belongs to start; earlier end is the next day.
 IF v_kind='epoch' AND NEW.planned_start_time IS NOT NULL AND NEW.planned_end_time IS NOT NULL
  AND extract(second FROM NEW.planned_start_time)=0 AND extract(second FROM NEW.planned_end_time)=0
  AND extract(hour FROM NEW.planned_start_time)<24 AND extract(hour FROM NEW.planned_end_time)<24 THEN
  start_min:=extract(hour FROM NEW.planned_start_time)::integer*60+extract(minute FROM NEW.planned_start_time)::integer;
  end_min:=extract(hour FROM NEW.planned_end_time)::integer*60+extract(minute FROM NEW.planned_end_time)::integer;
  duration_min:=(end_min-start_min+1440)%1440;
  IF duration_min>0 AND NEW.requested_ot_minutes=duration_min THEN
   plan:=jsonb_build_object('version',1,'basis','startDateEarlierEndNextDay','sourceDate',NEW.attendance_date,
    'startLabel',NEW.planned_start_time,'endLabel',NEW.planned_end_time,
    'from',start_min,'to',start_min+duration_min,'requestedMinutes',duration_min);
  END IF;
 END IF;
 INSERT INTO public.attendance_policy_request_contract(correction_id,tenant_id,employment_id,attendance_date,company_id,kind,visible_epoch,planned_window,attested_work,manual_approval_method,policy_binding)
  VALUES(NEW.id,NEW.tenant_id,NEW.employment_id,NEW.attendance_date,v_company,v_kind,v_epoch,plan,attested,manual_method,binding);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.capture_attendance_policy_request_contract() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_policy_submission_contract AFTER INSERT ON public.attendance_correction
 FOR EACH ROW EXECUTE FUNCTION app.capture_attendance_policy_request_contract();
CREATE FUNCTION app.guard_attendance_policy_request_contract() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' AND pg_trigger_depth()>1 THEN RETURN NEW;END IF;
 IF TG_OP='DELETE' AND pg_trigger_depth()>1 AND NOT EXISTS(SELECT 1 FROM public.attendance_correction WHERE id=OLD.correction_id) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Retain the owner-issued immutable application contract' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION app.guard_attendance_policy_request_contract() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_policy_request_contract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_policy_request_contract
 FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_policy_request_contract();

--> statement-breakpoint
-- Permit only the table owner behind the checked SECURITY DEFINER barrier to reach the epoch under
-- forced RLS, including restricted migration owners. No new application table capability is granted.
CREATE POLICY overtime_epoch_execution_owner ON public.overtime_pattern_epoch FOR ALL
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.overtime_pattern_epoch'::regclass)))
 WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.overtime_pattern_epoch'::regclass)));
--> statement-breakpoint
-- Read-only execution barrier: serialize live policy/formula reads with their existing configuration
-- writer without giving ordinary Attendance subjects admin configuration access or incrementing it.
CREATE FUNCTION app.lock_attendance_policy_execution_context(p_employment uuid,p_date date) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid:=app.current_tenant_id();
BEGIN
 IF app.attendance_policy_principal_current() IS NOT TRUE
  OR NOT(app.can_see_employment(p_employment) OR app.can_admin_payroll_employment(p_employment)) THEN
  RAISE EXCEPTION 'Current Attendance subject authority required' USING ERRCODE='42501';END IF;
 -- SECURITY DEFINER must repeat the Attendance RLS subject predicate above; calling a visibility
 -- helper that relies only on invoker RLS here would inherit this owner's table authority.
 IF NOT EXISTS(SELECT 1 FROM public.attendance_overtime_source source
  JOIN public.attendance a ON a.id=source.attendance_id AND a.tenant_id=source.tenant_id
   AND a.employment_id=source.employment_id AND a.attendance_date=source.attendance_date
  JOIN public.attendance_group_policy_revision policy ON policy.tenant_id=source.tenant_id
   AND policy.company_id=source.company_id AND policy.rule_id::text=a.calc_trace#>>'{schedule,ruleId}'
   AND policy.effective_from<=source.attendance_date
  WHERE source.tenant_id=tenant AND source.employment_id=p_employment AND source.attendance_date=p_date) THEN
  RAISE EXCEPTION 'Dated policy source is unavailable' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM public.overtime_pattern_epoch WHERE tenant_id=tenant FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Policy configuration epoch is unavailable' USING ERRCODE='23514';END IF;
 IF app.attendance_policy_principal_current() IS NOT TRUE
  OR NOT(app.can_see_employment(p_employment) OR app.can_admin_payroll_employment(p_employment)) THEN
  RAISE EXCEPTION 'Current Attendance subject authority required' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.lock_attendance_policy_execution_context(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_attendance_policy_execution_context(uuid,date) TO ai_hr_app;

--> statement-breakpoint
-- First raw derivation has no calc_trace or overtime source yet. This separate checked barrier
-- admits only a real visible Attendance subject/day, never a posted policy/company or approval.
-- The invoker must resolve the canonical dated schedule/policy again AFTER acquiring this lock.
CREATE FUNCTION app.lock_attendance_policy_raw_context(p_employment uuid,p_date date) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid:=app.current_tenant_id();
BEGIN
 IF app.attendance_policy_principal_current() IS NOT TRUE
  OR NOT(app.can_see_employment(p_employment) OR app.can_admin_payroll_employment(p_employment)) THEN
  RAISE EXCEPTION 'Current Attendance subject authority required' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.attendance a JOIN public.employment e
  ON e.id=a.employment_id AND e.tenant_id=a.tenant_id
  WHERE a.tenant_id=tenant AND a.employment_id=p_employment AND a.attendance_date=p_date
   AND p_date>=e.hired_on AND(e.terminated_on IS NULL OR p_date<=e.terminated_on)) THEN
  RAISE EXCEPTION 'Raw Attendance subject day is unavailable' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM public.overtime_pattern_epoch WHERE tenant_id=tenant FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Policy configuration epoch is unavailable' USING ERRCODE='23514';END IF;
 IF app.attendance_policy_principal_current() IS NOT TRUE
  OR NOT(app.can_see_employment(p_employment) OR app.can_admin_payroll_employment(p_employment)) THEN
  RAISE EXCEPTION 'Current Attendance subject authority required' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.attendance a JOIN public.employment e
  ON e.id=a.employment_id AND e.tenant_id=a.tenant_id
  WHERE a.tenant_id=tenant AND a.employment_id=p_employment AND a.attendance_date=p_date
   AND p_date>=e.hired_on AND(e.terminated_on IS NULL OR p_date<=e.terminated_on)) THEN
  RAISE EXCEPTION 'Raw Attendance subject day is unavailable' USING ERRCODE='23514';END IF;
END $$;
REVOKE ALL ON FUNCTION app.lock_attendance_policy_raw_context(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_attendance_policy_raw_context(uuid,date) TO ai_hr_app;

--> statement-breakpoint
-- Batched import has no raw aggregate yet. Check all real visible subjects/dates together before
-- the caller builds its schedule memo. A missing lock row is initialized at revision ZERO only;
-- this grants neither policy mutation nor the administrator's revision-increment capability.
CREATE FUNCTION app.lock_attendance_policy_import_context(p_points jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid:=app.current_tenant_id();configured boolean;
BEGIN
 IF app.attendance_policy_principal_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Current Attendance principal required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_points) IS DISTINCT FROM 'array' OR jsonb_array_length(p_points)>25000 THEN
  RAISE EXCEPTION 'Invalid canonical import point set' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_points) AS point("employmentId" uuid,date date)
  LEFT JOIN public.employment e ON e.id=point."employmentId" AND e.tenant_id=tenant
  WHERE point."employmentId" IS NULL OR point.date IS NULL OR e.id IS NULL
   OR point.date<e.hired_on OR(e.terminated_on IS NOT NULL AND point.date>e.terminated_on)
   OR (app.can_see_employment(e.id) OR app.can_admin_payroll_employment(e.id)) IS NOT TRUE) THEN
  RAISE EXCEPTION 'Current Attendance import subjects required' USING ERRCODE='42501';END IF;
 IF jsonb_array_length(p_points)=0 THEN RETURN false;END IF;
 INSERT INTO public.overtime_pattern_epoch(tenant_id,revision) VALUES(tenant,0) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.overtime_pattern_epoch WHERE tenant_id=tenant FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Policy configuration epoch is unavailable' USING ERRCODE='23514';END IF;
 IF app.attendance_policy_principal_current() IS NOT TRUE OR EXISTS(
  SELECT 1 FROM jsonb_to_recordset(p_points) AS point("employmentId" uuid,date date)
  LEFT JOIN public.employment e ON e.id=point."employmentId" AND e.tenant_id=tenant
  WHERE e.id IS NULL OR point.date<e.hired_on OR(e.terminated_on IS NOT NULL AND point.date>e.terminated_on)
   OR (app.can_see_employment(e.id) OR app.can_admin_payroll_employment(e.id)) IS NOT TRUE) THEN
  RAISE EXCEPTION 'Current Attendance import subjects required' USING ERRCODE='42501';END IF;
 -- Writers need this same epoch row. Even absence stays serialized until the import commits.
 SELECT EXISTS(SELECT 1 FROM public.attendance_group_policy_revision revision
  WHERE revision.tenant_id=tenant AND revision.effective_from<=
   (SELECT max(point.date) FROM jsonb_to_recordset(p_points) AS point("employmentId" uuid,date date))) INTO configured;
 IF app.attendance_policy_principal_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Current Attendance principal required' USING ERRCODE='42501';END IF;
 RETURN configured;
END $$;
REVOKE ALL ON FUNCTION app.lock_attendance_policy_import_context(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_attendance_policy_import_context(jsonb) TO ai_hr_app;

--> statement-breakpoint
-- Preserve 0548's exact legacy label/deferral owner and its private ACL. The shared API only
-- dispatches a narrowly identified raw-policy OT-only effect; v2/v3/v4 scope remains owned by the
-- existing dynamically resolved effect_scope helper. No receipt/event can reopen that capability.
-- An actual HR-work attestation has its own live final effect. It never writes clock labels,
-- raw work/OT figures, or a schedule-only AttendanceTraceV1.
ALTER TABLE public.attendance ADD COLUMN attested_work_correction_id uuid REFERENCES public.attendance_correction(id) ON DELETE RESTRICT,
 ADD COLUMN attested_work_context jsonb;
CREATE TABLE public.attendance_policy_attested_effect(
 attendance_id uuid NOT NULL REFERENCES public.attendance(id) ON DELETE RESTRICT,
 correction_id uuid PRIMARY KEY REFERENCES public.attendance_correction(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),company_id uuid NOT NULL REFERENCES public.company(id),
 employment_id uuid NOT NULL REFERENCES public.employment(id),attendance_date date NOT NULL,
 workflow_request_id uuid NOT NULL,actor_user_id text NOT NULL,
 authority text NOT NULL DEFAULT 'attestedActualWorkOnly' CHECK(authority='attestedActualWorkOnly'),
 requested_minutes integer NOT NULL CHECK(requested_minutes>0),approved_minutes integer NOT NULL CHECK(approved_minutes>=0),
 manual_method text NOT NULL CHECK(manual_method IN('requested','system_calculated','smaller_of','greater_of')),
 attested_work jsonb NOT NULL,context_evidence jsonb NOT NULL,policy_binding jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE public.attendance_policy_attested_effect ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_policy_attested_effect FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_policy_attested_effect_owner ON public.attendance_policy_attested_effect FOR ALL
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.attendance_policy_attested_effect'::regclass)))
 WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.attendance_policy_attested_effect'::regclass)));
CREATE POLICY attendance_policy_attested_effect_read ON public.attendance_policy_attested_effect FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND app.attendance_policy_principal_current()
  AND EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=correction_id AND c.tenant_id=attendance_policy_attested_effect.tenant_id));
REVOKE ALL ON public.attendance_policy_attested_effect FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.attendance_policy_attested_effect TO ai_hr_app;
CREATE FUNCTION app.guard_attendance_policy_attested_effect() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' AND pg_trigger_depth()>1 AND current_user=pg_get_userbyid((SELECT proowner FROM pg_proc
  WHERE oid='app.capture_attendance_policy_attested_effect()'::regprocedure)) THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Retain the owner-issued immutable unclocked-work effect' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION app.guard_attendance_policy_attested_effect() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_policy_attested_effect_guard BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_policy_attested_effect
 FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_policy_attested_effect();
CREATE FUNCTION app.capture_attendance_policy_attested_effect() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE contract public.attendance_policy_request_contract;w public.attendance_workflow_request;
 completion public.attendance_workflow_decision;anchor public.attendance;
BEGIN
 SELECT * INTO contract FROM public.attendance_policy_request_contract WHERE correction_id=OLD.id AND tenant_id=OLD.tenant_id;
 IF NOT FOUND OR contract.attested_work IS NULL THEN RETURN NEW;END IF;
 IF OLD.status<>'pending' OR NEW.status<>'pending' OR NEW.approved_ot_minutes IS NULL THEN RETURN NEW;END IF;
 IF NEW.approved_ot_minutes IS NOT DISTINCT FROM OLD.approved_ot_minutes AND NEW.ot_approval_method IS NOT DISTINCT FROM OLD.ot_approval_method THEN RETURN NEW;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(OLD.tenant_id::text||':'||OLD.employment_id::text,0));
 IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR app.attendance_policy_principal_current() IS NOT TRUE
  OR app.can_see_employment(OLD.employment_id) IS NOT TRUE
  OR current_setting('app.attendance_workflow_effect',true) IS DISTINCT FROM OLD.id::text
  OR app.attendance_workflow_effect_scope(OLD.employment_id,OLD.attendance_date) IS NOT TRUE
  OR contract.kind<>'epoch' OR contract.policy_binding IS NULL
  OR contract.employment_id IS DISTINCT FROM OLD.employment_id OR contract.attendance_date IS DISTINCT FROM OLD.attendance_date
  OR NEW.ot_approval_method::text IS DISTINCT FROM contract.manual_approval_method OR NEW.approved_ot_minutes<0
  OR NEW.requested_ot_minutes IS DISTINCT FROM OLD.requested_ot_minutes OR OLD.requested_ot_minutes<=0
  OR NEW.admin_amendment IS NOT NULL OR NEW.proposed_check_in IS NOT NULL OR NEW.proposed_check_out IS NOT NULL
  OR NEW.clock_changes IS NOT NULL OR NEW.planned_start_time IS NOT NULL OR NEW.planned_end_time IS NOT NULL
  OR contract.attested_work->'work' IS DISTINCT FROM NEW.original_clock_snapshot->'unclockedWork'
  OR contract.attested_work->>'authority' IS DISTINCT FROM 'hrAttestedWorkSubmission'
  OR EXISTS(SELECT 1 FROM public.attendance_punch p WHERE p.tenant_id=OLD.tenant_id AND p.employment_id=OLD.employment_id
   AND p.attendance_date=OLD.attendance_date AND p.voided_at IS NULL) THEN
  RAISE EXCEPTION 'Exact active unclocked-work final workflow authority required' USING ERRCODE='42501';END IF;
 SELECT * INTO w FROM public.attendance_workflow_request WHERE correction_id=OLD.id AND tenant_id=OLD.tenant_id
  AND employment_id=OLD.employment_id AND routing_version>=2;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unclocked work requires a versioned final workflow' USING ERRCODE='23514';END IF;
 SELECT * INTO completion FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id
  AND d.stage_index=jsonb_array_length(w.stages)-1 AND d.decision='approved' AND d.resulting_status='approved'
  AND d.actual_user_id=app.current_user_id()::text AND app.attendance_workflow_active_write(d.xmin);
 IF NOT FOUND THEN RAISE EXCEPTION 'The completing unclocked-work decision must remain active' USING ERRCODE='42501';END IF;
 SELECT * INTO anchor FROM public.attendance a WHERE a.tenant_id=OLD.tenant_id AND a.employment_id=OLD.employment_id
  AND a.attendance_date=OLD.attendance_date AND a.attested_work_correction_id=OLD.id AND app.attendance_workflow_active_write(a.xmin);
 IF NOT FOUND OR anchor.attested_work_context->>'state' IS DISTINCT FROM 'policy'
  OR anchor.attested_work_context->>'employmentId' IS DISTINCT FROM OLD.employment_id::text
  OR anchor.attested_work_context->>'date' IS DISTINCT FROM OLD.attendance_date::text
  OR anchor.attested_work_context->>'companyId' IS DISTINCT FROM contract.company_id::text
  OR anchor.attested_work_context#>>'{selected,id}' IS DISTINCT FROM contract.policy_binding->>'revisionId'
  OR NOT EXISTS(SELECT 1 FROM public.attendance_group_policy_revision r WHERE r.id=(contract.policy_binding->>'revisionId')::uuid
   AND r.tenant_id=OLD.tenant_id AND r.company_id=contract.company_id
   AND r.policy=anchor.attested_work_context#>'{selected,policy}' AND r.activation_epoch>0)
  OR anchor.check_in_at IS NOT NULL OR anchor.check_out_at IS NOT NULL OR anchor.worked_minutes IS NOT NULL
  OR anchor.ot_minutes IS NOT NULL OR anchor.calc_trace IS NOT NULL OR anchor.ot_flat_minutes IS NOT NULL
  OR anchor.ot00_minutes IS NOT NULL OR anchor.ot10_minutes IS NOT NULL OR anchor.ot15_minutes IS NOT NULL
  OR anchor.ot20_minutes IS NOT NULL OR anchor.ot30_minutes IS NOT NULL OR anchor.late_minutes IS NOT NULL
  OR anchor.early_out_minutes IS NOT NULL OR anchor.under_minutes IS NOT NULL
  OR anchor.late_deduct_minutes IS NOT NULL OR anchor.early_out_deduct_minutes IS NOT NULL THEN
  RAISE EXCEPTION 'The active unclocked-work identity must not contain invented raw clock figures' USING ERRCODE='23514';END IF;
 INSERT INTO public.attendance_policy_attested_effect(attendance_id,correction_id,tenant_id,company_id,employment_id,attendance_date,
  workflow_request_id,actor_user_id,requested_minutes,approved_minutes,manual_method,attested_work,context_evidence,policy_binding)
 VALUES(anchor.id,OLD.id,OLD.tenant_id,contract.company_id,OLD.employment_id,OLD.attendance_date,w.id,app.current_user_id()::text,
  OLD.requested_ot_minutes,NEW.approved_ot_minutes,contract.manual_approval_method,contract.attested_work,anchor.attested_work_context,contract.policy_binding);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.capture_attendance_policy_attested_effect() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER zz_attendance_policy_attested_effect AFTER UPDATE OF approved_ot_minutes,ot_approval_method ON public.attendance_correction
 FOR EACH ROW EXECUTE FUNCTION app.capture_attendance_policy_attested_effect();
--> statement-breakpoint
ALTER FUNCTION app.attendance_workflow_final_effect(uuid,integer) RENAME TO attendance_workflow_legacy_labels_final_effect;
CREATE FUNCTION app.attendance_workflow_final_effect(p_correction_id uuid,approved_minutes integer) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.attendance_correction;contract public.attendance_policy_request_contract;
 a public.attendance;capture_count integer;attested public.attendance_policy_attested_effect;
BEGIN
 SELECT * INTO c FROM public.attendance_correction WHERE id=p_correction_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO contract FROM public.attendance_policy_request_contract WHERE correction_id=c.id AND tenant_id=c.tenant_id
  AND employment_id=c.employment_id AND attendance_date=c.attendance_date;
 IF contract.policy_binding IS NULL OR c.admin_amendment IS NOT NULL OR c.requested_ot_minutes IS NULL
  OR c.proposed_check_in IS NOT NULL OR c.proposed_check_out IS NOT NULL OR c.clock_changes IS NOT NULL
  OR c.attendance_date>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN
  RETURN app.attendance_workflow_legacy_labels_final_effect(p_correction_id,approved_minutes);
 END IF;
 IF c.status<>'pending' OR approved_minutes IS NULL OR approved_minutes<0
  OR app.attendance_policy_principal_current() IS NOT TRUE OR app.can_see_employment(c.employment_id) IS NOT TRUE
  OR current_setting('app.attendance_workflow_effect',true) IS DISTINCT FROM c.id::text
  OR app.attendance_workflow_effect_scope(c.employment_id,c.attendance_date) IS NOT TRUE THEN RETURN false;END IF;
 IF contract.attested_work IS NOT NULL THEN
  SELECT * INTO attested FROM public.attendance_policy_attested_effect e WHERE e.correction_id=c.id AND e.tenant_id=c.tenant_id
   AND e.employment_id=c.employment_id AND e.attendance_date=c.attendance_date AND app.attendance_workflow_active_write(e.xmin);
  RETURN FOUND AND attested.company_id=contract.company_id AND attested.actor_user_id=app.current_user_id()::text
   AND attested.authority='attestedActualWorkOnly' AND attested.requested_minutes=c.requested_ot_minutes
   AND attested.approved_minutes=approved_minutes AND attested.manual_method=contract.manual_approval_method
   AND attested.attested_work=contract.attested_work AND attested.policy_binding=contract.policy_binding
   AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.id=attested.attendance_id AND a.tenant_id=c.tenant_id
    AND a.employment_id=c.employment_id AND a.attendance_date=c.attendance_date AND a.attested_work_correction_id=c.id
    AND a.check_in_at IS NULL AND a.check_out_at IS NULL AND a.worked_minutes IS NULL AND a.ot_minutes IS NULL
    AND a.calc_trace IS NULL AND a.attested_work_context=attested.context_evidence AND app.attendance_workflow_active_write(a.xmin))
   AND NOT EXISTS(SELECT 1 FROM public.attendance_punch p WHERE p.tenant_id=c.tenant_id AND p.employment_id=c.employment_id
    AND p.attendance_date=c.attendance_date AND p.voided_at IS NULL);
 END IF;
 SELECT * INTO a FROM public.attendance d WHERE d.tenant_id=c.tenant_id AND d.employment_id=c.employment_id
  AND d.attendance_date=c.attendance_date AND app.attendance_workflow_active_write(d.xmin);
 IF NOT FOUND OR a.calc_trace->'executionPolicy' IS DISTINCT FROM contract.policy_binding
  OR contract.kind<>'epoch' OR contract.company_id IS NULL OR a.check_in_at IS NULL OR a.check_out_at IS NULL
  OR a.worked_minutes IS NULL OR a.worked_minutes<0 OR a.calc_trace->'punch'->>'outAbs' IS NULL
  OR a.calc_trace->'punch'->>'workedMinutes' IS NULL
  OR jsonb_typeof(a.calc_trace->'punch'->'calculationIntervals') IS DISTINCT FROM 'array'
  OR a.ot_minutes IS NOT NULL OR a.ot_flat_minutes IS NOT NULL OR a.ot00_minutes IS NOT NULL
  OR a.ot10_minutes IS NOT NULL OR a.ot15_minutes IS NOT NULL OR a.ot20_minutes IS NOT NULL OR a.ot30_minutes IS NOT NULL
  THEN RETURN false;END IF;
 SELECT count(*) INTO capture_count FROM public.attendance_punch p
  WHERE p.tenant_id=c.tenant_id AND p.employment_id=c.employment_id AND p.attendance_date=c.attendance_date
   AND p.attendance_id=a.id AND p.voided_at IS NULL;
 IF capture_count<2 OR capture_count>128 OR EXISTS(
  SELECT 1 FROM public.attendance_punch p LEFT JOIN public.attendance_clock_capture capture
   ON capture.id=p.clock_capture_id AND capture.tenant_id=p.tenant_id AND capture.employment_id=p.employment_id
    AND capture.attendance_date=p.attendance_date AND capture.direction=p.direction
  WHERE p.tenant_id=c.tenant_id AND p.employment_id=c.employment_id AND p.attendance_date=c.attendance_date
   AND p.attendance_id=a.id AND p.voided_at IS NULL
   AND (capture.id IS NULL OR p.punch_at IS DISTINCT FROM date_trunc('second',capture.server_recorded_at AT TIME ZONE 'Asia/Kuala_Lumpur')::time))
  THEN RETURN false;END IF;
 -- This proves the actively written raw target-day effect only. The independent canonical
 -- millisecond replay, full approved count allocation and financial consumers remain mandatory.
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_legacy_labels_final_effect(uuid,integer) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.attendance_workflow_final_effect(uuid,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Durable final-workflow evidence is minted ONLY by the actual pending->approved transition.
-- It records the decision/effect, not a payable policy outcome, positioned plan or unclocked attestation.
CREATE TABLE public.attendance_policy_final_receipt(
 correction_id uuid PRIMARY KEY REFERENCES public.attendance_correction(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 employment_id uuid NOT NULL REFERENCES public.employment(id),attendance_date date NOT NULL,
 company_id uuid NOT NULL REFERENCES public.company(id) ON DELETE RESTRICT,
 workflow_request_id uuid NOT NULL,actor_user_id text NOT NULL,
 authority text NOT NULL DEFAULT 'finalWorkflowDecisionOnly' CHECK(authority='finalWorkflowDecisionOnly'),
 submission_epoch bigint NOT NULL CHECK(submission_epoch BETWEEN 0 AND 9007199254740991),
 request_evidence jsonb NOT NULL CHECK(jsonb_typeof(request_evidence)='object'),
 workflow_evidence jsonb NOT NULL CHECK(jsonb_typeof(workflow_evidence)='object'),
 raw_evidence jsonb CHECK(raw_evidence IS NULL OR jsonb_typeof(raw_evidence)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.attendance_policy_final_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_policy_final_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_policy_final_receipt_owner ON public.attendance_policy_final_receipt FOR ALL
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.attendance_policy_final_receipt'::regclass)))
 WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.attendance_policy_final_receipt'::regclass)));
CREATE POLICY attendance_policy_final_receipt_read ON public.attendance_policy_final_receipt FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.attendance_policy_principal_current())
  AND(app.can_see_employment(employment_id) OR app.can_admin_payroll_for(company_id)));
REVOKE ALL ON public.attendance_policy_final_receipt FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.attendance_policy_final_receipt TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_attendance_policy_final_receipt() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' AND pg_trigger_depth()>1 THEN RETURN NEW;END IF;
 IF TG_OP='DELETE' AND pg_trigger_depth()>1 AND NOT EXISTS(SELECT 1 FROM public.attendance_correction WHERE id=OLD.correction_id) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Retain the owner-issued final workflow receipt' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION app.guard_attendance_policy_final_receipt() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_policy_final_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_policy_final_receipt
 FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_policy_final_receipt();
--> statement-breakpoint
CREATE FUNCTION app.capture_attendance_policy_final_receipt() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE contract public.attendance_policy_request_contract;w public.attendance_workflow_request;
 completion public.attendance_workflow_decision;raw jsonb;participants jsonb;attested_effect jsonb;
BEGIN
 IF OLD.status<>'pending' OR NEW.status<>'approved' OR NEW.requested_ot_minutes IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO contract FROM public.attendance_policy_request_contract WHERE correction_id=OLD.id
  AND tenant_id=OLD.tenant_id AND employment_id=OLD.employment_id AND attendance_date=OLD.attendance_date AND kind='epoch';
 -- No backfill and no promotion of legacy approvals into a fresh final effect.
 IF NOT FOUND THEN RETURN NEW;END IF;
 IF contract.manual_approval_method IS DISTINCT FROM NEW.ot_approval_method::text THEN
  RAISE EXCEPTION 'Retain the submitted overtime calculation method' USING ERRCODE='23514';
 END IF;
 SELECT * INTO w FROM public.attendance_workflow_request WHERE correction_id=OLD.id
  AND tenant_id=OLD.tenant_id AND employment_id=OLD.employment_id AND routing_version>=2;
 IF NOT FOUND THEN RETURN NEW;END IF;
 IF app.attendance_policy_principal_current() IS NOT TRUE OR OLD.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR current_setting('app.attendance_workflow_effect',true) IS DISTINCT FROM OLD.id::text
  OR app.attendance_workflow_effect_scope(OLD.employment_id,OLD.attendance_date) IS NOT TRUE
  OR app.attendance_workflow_final_effect(OLD.id,NEW.approved_ot_minutes) IS NOT TRUE THEN
  RAISE EXCEPTION 'An exact active final workflow effect is required for its receipt' USING ERRCODE='42501';END IF;
 SELECT * INTO completion FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id
  AND d.stage_index=jsonb_array_length(w.stages)-1 AND d.decision='approved' AND d.resulting_status='approved'
  AND d.actual_user_id=app.current_user_id()::text AND app.attendance_workflow_active_write(d.xmin);
 IF NOT FOUND THEN RAISE EXCEPTION 'The completing workflow write must remain active' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.stage_index,d.participant_slot,d.id),'[]'::jsonb) INTO participants
  FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id;
 SELECT jsonb_build_object('attendanceId',a.id,'checkIn',a.check_in_at,'checkOut',a.check_out_at,
  'status',a.status,'dayType',a.day_type,'workedMinutes',a.worked_minutes,'otMinutes',a.ot_minutes,
  'lateMinutes',a.late_minutes,'earlyOutMinutes',a.early_out_minutes,'trace',a.calc_trace,
  'punchCount',(SELECT count(*) FROM public.attendance_punch p WHERE p.attendance_id=a.id AND p.tenant_id=a.tenant_id AND p.voided_at IS NULL),
  'punches',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM
   (SELECT p.id,p.punch_at,p.direction,p.clock_capture_id FROM public.attendance_punch p
    WHERE p.attendance_id=a.id AND p.tenant_id=a.tenant_id AND p.voided_at IS NULL ORDER BY p.id LIMIT 129)p)) INTO raw
  FROM public.attendance a WHERE a.tenant_id=OLD.tenant_id AND a.employment_id=OLD.employment_id
   AND a.attendance_date=OLD.attendance_date AND contract.attested_work IS NULL AND app.attendance_workflow_active_write(a.xmin);
 IF contract.attested_work IS NOT NULL THEN
  SELECT to_jsonb(e) INTO attested_effect FROM public.attendance_policy_attested_effect e WHERE e.correction_id=OLD.id
   AND e.tenant_id=OLD.tenant_id AND e.workflow_request_id=w.id AND app.attendance_workflow_active_write(e.xmin);
  IF NOT FOUND THEN RAISE EXCEPTION 'The scoped unclocked-work effect must remain active for its receipt' USING ERRCODE='42501';END IF;
 END IF;
 INSERT INTO public.attendance_policy_final_receipt(correction_id,tenant_id,employment_id,attendance_date,company_id,
  workflow_request_id,actor_user_id,submission_epoch,request_evidence,workflow_evidence,raw_evidence)
 VALUES(OLD.id,OLD.tenant_id,OLD.employment_id,OLD.attendance_date,contract.company_id,w.id,app.current_user_id()::text,contract.visible_epoch,
  jsonb_build_object('requestedMinutes',NEW.requested_ot_minutes,'approvedMinutes',NEW.approved_ot_minutes,'method',NEW.ot_approval_method,
   'plannedStartLabel',NEW.planned_start_time,'plannedEndLabel',NEW.planned_end_time,
   'checkIn',NEW.proposed_check_in,'checkOut',NEW.proposed_check_out,'clockChanges',NEW.clock_changes),
  jsonb_build_object('requestId',w.id,'routingVersion',w.routing_version,'stageCount',jsonb_array_length(w.stages),
   'completion',to_jsonb(completion),'participants',participants,'submittedPlan',contract.planned_window,'submittedManualMethod',contract.manual_approval_method,'submittedPolicy',contract.policy_binding)
   ||CASE WHEN contract.attested_work IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('submittedAttestedWork',contract.attested_work,'unclockedEffect',attested_effect) END,raw);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.capture_attendance_policy_final_receipt() FROM PUBLIC,ai_hr_app;
-- The existing workflow authority guards run first. Any later refusal rolls this receipt back with
-- the status transition. The private final-effect proof is still pending/live here, not replayed later.
CREATE TRIGGER zz_attendance_policy_final_receipt BEFORE UPDATE ON public.attendance_correction
 FOR EACH ROW EXECUTE FUNCTION app.capture_attendance_policy_final_receipt();

--> statement-breakpoint
-- Retain the single parent settlement owner. A new policy claim must match its complete current
-- mode-specific contract; the original cash/TOIL owner checks and derived coverage still apply.
CREATE FUNCTION app.guard_attendance_policy_settlement_stage() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.attendance_overtime_source;header public.attendance_overtime_calculation;data jsonb;clock jsonb;
BEGIN
 IF NEW.released_at IS NOT NULL THEN RETURN NEW;END IF;
 SELECT * INTO source FROM public.attendance_overtime_source
  WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Current settlement subject is unavailable' USING ERRCODE='42501';END IF;
 IF source.current_calculation_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO header FROM public.attendance_overtime_calculation
  WHERE id=source.current_calculation_id AND source_id=source.id AND tenant_id=source.tenant_id AND company_id=source.company_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Current settlement calculation is unavailable' USING ERRCODE='42501';END IF;
 IF header.binding_kind<>'attendanceGroupPolicy' THEN RETURN NEW;END IF;
 IF app.attendance_policy_principal_current() IS NOT TRUE OR header.ordinal<>source.revision
  OR header.duration_outcome<>'ready' OR header.approval_status NOT IN('approved','notRequired')
  OR header.policy_part_count<1 THEN
  RAISE EXCEPTION 'Complete current policy duration and approval required' USING ERRCODE='23514';END IF;
 PERFORM app.lock_attendance_policy_execution_context(source.employment_id,source.attendance_date);
 SELECT evidence INTO data FROM public.attendance_overtime_calculation_evidence WHERE calculation_id=header.id
  AND tenant_id=source.tenant_id AND company_id=source.company_id;
 IF NOT FOUND OR data#>>'{policyFinancialDurationContract,state}' IS DISTINCT FROM 'prepared'
  OR data#>>'{policyFinancialDurationContract,durationDigest}' IS DISTINCT FROM header.duration_input_digest THEN
  RAISE EXCEPTION 'Complete retained policy duration contract required' USING ERRCODE='23514';END IF;
 IF NEW.mode='cash' AND (NEW.calculation_id IS DISTINCT FROM header.id OR header.outcome<>'ready' OR NOT header.transferable
  OR data#>>'{policyFinancialContract,state}' IS DISTINCT FROM 'prepared') THEN
  RAISE EXCEPTION 'Complete current policy cash contract required' USING ERRCODE='23514';END IF;
 -- Historical capture evidence alone survives voiding; a NEW reservation must also retain the
 -- entire current nonvoided source. Canonical consumers separately replay policy/approval/refs.
 IF data#>>'{policyRawEffectSource,attested,authority}'='attestedSourceOnly' THEN
  IF EXISTS(SELECT 1 FROM public.attendance_punch WHERE attendance_id=source.attendance_id AND tenant_id=source.tenant_id AND voided_at IS NULL) THEN
   RAISE EXCEPTION 'Clock evidence was added to the attested work source' USING ERRCODE='23514';END IF;
 ELSE
 IF jsonb_typeof(data#>'{policyClockSource,clocks}') IS DISTINCT FROM 'array'
  OR (SELECT count(*) FROM public.attendance_punch WHERE attendance_id=source.attendance_id AND tenant_id=source.tenant_id
   AND voided_at IS NULL)<>jsonb_array_length(data#>'{policyClockSource,clocks}') THEN
  RAISE EXCEPTION 'Current policy clock source changed' USING ERRCODE='23514';END IF;
 FOR clock IN SELECT value FROM jsonb_array_elements(data#>'{policyClockSource,clocks}') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.attendance_punch WHERE id=(clock->>'id')::uuid
   AND tenant_id=source.tenant_id AND attendance_id=source.attendance_id AND employment_id=source.employment_id
   AND clock_capture_id=(clock->>'captureId')::uuid AND voided_at IS NULL) THEN
   RAISE EXCEPTION 'Current policy clock source changed' USING ERRCODE='23514';END IF;
 END LOOP;
 END IF;
 IF NEW.mode='toil' AND NOT EXISTS(SELECT 1 FROM public.toil_accrual credit
  WHERE credit.id=NEW.toil_accrual_id AND credit.tenant_id=source.tenant_id
   AND credit.employment_id=source.employment_id AND credit.worked_date=source.attendance_date
   AND credit.status<>'reversed' AND credit.ot_minutes>0
   AND credit.ot_minutes::numeric*header.payable_denominator::numeric<=header.payable_numerator::numeric
   AND credit.worked_day_kind IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM public.attendance_overtime_policy_part part
    WHERE part.calculation_id=header.id AND part.allocated_payable_minutes>0
     AND credit.worked_day_kind::text IS DISTINCT FROM CASE part.day_class
      WHEN 'normal' THEN 'workday' WHEN 'off' THEN 'off_day' WHEN 'rest' THEN 'rest_day'
      WHEN 'publicHoliday' THEN 'holiday' WHEN 'replacementHoliday' THEN 'holiday' ELSE NULL END)) THEN
  RAISE EXCEPTION 'TOIL credit must bind a reviewed subset of the current policy duration and class' USING ERRCODE='23514';END IF;
 -- The mandatory SECURITY DEFINER ab coverage trigger independently validates the private
 -- physical proof next. This invoker trigger must never grant app EXECUTE on that owner.

 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_attendance_policy_settlement_stage() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER aa_attendance_policy_settlement_stage BEFORE INSERT OR UPDATE ON public.overtime_source_settlement
 FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_policy_settlement_stage();

--> statement-breakpoint
-- Derived reservation integrity on the EXISTING settlement, never a second payment ledger.
-- Old tuples stay NULL/unmodified. New legacy claims conservatively retain their possible bounded
-- three-day source envelope; this does not assert that they worked or were paid every such minute.
-- A new policy claim needs exact allocated coverage. It may not overlap another policy claim or
-- even potentially overlap a legacy claim whose physical count attribution is unavailable.
ALTER TABLE public.overtime_source_settlement
 ADD COLUMN coverage_employment_id uuid REFERENCES public.employment(id) ON DELETE RESTRICT,
 ADD COLUMN coverage_calculation_id uuid REFERENCES public.attendance_overtime_calculation(id) ON DELETE RESTRICT,
 ADD COLUMN coverage_kind text,
 ADD COLUMN reservation_coverage int8multirange,
 ADD CONSTRAINT overtime_settlement_coverage_shape_ck CHECK(
  (coverage_employment_id IS NULL AND coverage_calculation_id IS NULL AND coverage_kind IS NULL AND reservation_coverage IS NULL)
  OR(coverage_employment_id IS NOT NULL AND coverage_kind IS NOT NULL AND coverage_kind IN('legacyUnknown','policyPhysical') AND reservation_coverage IS NOT NULL
   AND NOT isempty(reservation_coverage) AND(coverage_kind='legacyUnknown' OR coverage_calculation_id IS NOT NULL)));
-- btree_gist is already installed by0001. Company and cash/TOIL mode deliberately are NOT keys.
ALTER TABLE public.overtime_source_settlement ADD CONSTRAINT overtime_policy_physical_no_overlap
 EXCLUDE USING gist(tenant_id WITH =,coverage_employment_id WITH =,reservation_coverage WITH &&)
 WHERE(released_at IS NULL AND coverage_kind='policyPhysical');
-- <> makes only mixed legacy/policy pairs conflict. Legacy/legacy keeps its existing treatment.
ALTER TABLE public.overtime_source_settlement ADD CONSTRAINT overtime_policy_legacy_possible_overlap
 EXCLUDE USING gist(tenant_id WITH =,coverage_employment_id WITH =,coverage_kind WITH <>,reservation_coverage WITH &&)
 WHERE(released_at IS NULL AND coverage_kind IS NOT NULL);
--> statement-breakpoint
-- Private count/dated-source integrity; this validates the retained result of the SAME TS
-- duration owner, never a second schedule, threshold, rounding or pricing calculator.
CREATE FUNCTION app.attendance_policy_part_payable_count(arg_part public.attendance_overtime_policy_part,arg_duration jsonb,arg_formulas jsonb)
 RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE class_row jsonb;declared jsonb;attribution jsonb;anchor jsonb;anchor_part jsonb;
 class_count integer;physical integer;eligible integer;remainder integer;payable integer;chosen_sequence integer;direction text;
BEGIN
 declared:=arg_duration->'parts'->arg_part.sequence;
 IF arg_duration->>'status' IS DISTINCT FROM 'calculated' OR jsonb_typeof(arg_duration->'parts') IS DISTINCT FROM 'array'
  OR jsonb_array_length(arg_duration->'parts')>3 OR jsonb_typeof(arg_duration->'classes') IS DISTINCT FROM 'array'
  OR jsonb_array_length(arg_duration->'classes')>5
  OR declared->>'date' IS DISTINCT FROM arg_part.calendar_date::text OR declared->>'dayClass' IS DISTINCT FROM arg_part.day_class
  OR declared->>'companyId' IS DISTINCT FROM arg_part.company_id::text OR declared->>'moneyDay' IS DISTINCT FROM arg_part.money_day
  OR declared->>'minutes' IS DISTINCT FROM arg_part.raw_minutes::text
  OR declared->>'allocatedPayableMinutes' IS DISTINCT FROM arg_part.allocated_payable_minutes::text
  OR declared->'allocations' IS DISTINCT FROM arg_part.duration_evidence->'allocatedIntervals'
  OR declared->'intervals' IS DISTINCT FROM arg_part.source_intervals THEN
  RAISE EXCEPTION 'Rounded count requires its exact original dated part' USING ERRCODE='23514';END IF;
 SELECT count(*),jsonb_agg(value)->0 INTO class_count,class_row FROM jsonb_array_elements(arg_duration->'classes') WHERE value->>'dayClass'=arg_part.day_class;
 IF class_count<>1 OR coalesce(class_row->>'unplacedPayableMinutes','')!~'^[0-9]{1,4}$'
  OR coalesce(class_row->>'payableMinutes','')!~'^[0-9]{1,4}$' OR coalesce(class_row->>'eligibleMinutes','')!~'^[0-9]{1,4}$' THEN
  RAISE EXCEPTION 'Complete rounded count class required' USING ERRCODE='23514';END IF;
 remainder:=(class_row->>'unplacedPayableMinutes')::integer;payable:=(class_row->>'payableMinutes')::integer;
 SELECT coalesce(sum((value->>'allocatedPayableMinutes')::integer),0),coalesce(sum((value->>'minutes')::integer),0) INTO physical,eligible
  FROM jsonb_array_elements(arg_duration->'parts') WHERE value->>'dayClass'=arg_part.day_class;
 IF remainder>4320 OR payable>4320 OR physical+remainder<>payable OR class_row->>'eligibleMinutes' IS DISTINCT FROM eligible::text THEN
  RAISE EXCEPTION 'Rounded class quantity changed' USING ERRCODE='23514';END IF;
 IF remainder=0 THEN
  IF class_row?'roundingCountAttribution' OR arg_part.duration_evidence?'roundingCountAttributions'
   OR arg_part.duration_evidence?'attributedPayableMinutes' THEN
   RAISE EXCEPTION 'An unrounded part cannot claim rounded quantity' USING ERRCODE='23514';END IF;
  RETURN arg_part.allocated_payable_minutes;
 END IF;
 attribution:=class_row->'roundingCountAttribution';direction:=attribution->>'direction';
 IF jsonb_typeof(attribution) IS DISTINCT FROM 'object' OR attribution->>'kind' IS DISTINCT FROM 'roundingCount'
  OR attribution->>'minutes' IS DISTINCT FROM remainder::text OR attribution->>'dayClass' IS DISTINCT FROM arg_part.day_class
  OR direction IS NULL OR direction NOT IN('earliest','latest') OR coalesce(attribution->>'partSequence','')!~'^[0-2]$'
  OR jsonb_typeof(class_row->'steps') IS DISTINCT FROM 'array' OR class_row#>>'{steps,-1,after}' IS DISTINCT FROM payable::text
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(class_row->'steps') step WHERE step->>'kind'='rounding'
   AND coalesce(step->>'before','')~'^[0-9]{1,4}$' AND coalesce(step->>'after','')~'^[0-9]{1,4}$'
   AND(step->>'after')::integer-(step->>'before')::integer>=remainder)
  OR arg_formulas->>'state' IS DISTINCT FROM 'known' OR jsonb_typeof(arg_formulas->'references') IS DISTINCT FROM 'array'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(arg_formulas->'references') ref WHERE ref->>'date'=arg_part.calendar_date::text
    AND ref->>'state'='known' AND ref->>'dayClass'=arg_part.day_class AND ref->>'versionId'=arg_part.version_id::text
    AND ref->>'durationAllocation'=direction)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(arg_formulas->'references') ref WHERE ref->>'dayClass'=arg_part.day_class
    AND(ref->>'state' IS DISTINCT FROM 'known' OR ref->>'durationAllocation' IS DISTINCT FROM direction)) THEN
  RAISE EXCEPTION 'Rounded quantity requires its canonical formula direction and finalizer evidence' USING ERRCODE='23514';END IF;
 SELECT (p.ordinality-1)::integer,p.value,a.value INTO chosen_sequence,anchor_part,anchor
  FROM jsonb_array_elements(arg_duration->'parts') WITH ORDINALITY p(value,ordinality)
  CROSS JOIN LATERAL jsonb_array_elements(p.value->'allocations') a(value)
  WHERE p.value->>'dayClass'=arg_part.day_class
  ORDER BY CASE WHEN direction='earliest' THEN(a.value->>'from')::integer END ASC,
   CASE WHEN direction='latest' THEN(a.value->>'from')::integer END DESC,
   CASE WHEN direction='earliest' THEN(a.value->>'to')::integer END ASC,
   CASE WHEN direction='latest' THEN(a.value->>'to')::integer END DESC LIMIT 1;
 IF anchor IS NULL OR attribution->>'partSequence' IS DISTINCT FROM chosen_sequence::text
  OR attribution->>'calendarDate' IS DISTINCT FROM anchor_part->>'date' OR attribution->'anchor' IS DISTINCT FROM anchor THEN
  RAISE EXCEPTION 'Rounded quantity changed its existing dated source anchor' USING ERRCODE='23514';END IF;
 IF arg_part.sequence<>chosen_sequence THEN
  IF arg_part.duration_evidence?'roundingCountAttributions' OR arg_part.duration_evidence?'attributedPayableMinutes' THEN
   RAISE EXCEPTION 'Rounded quantity belongs to one exact dated source' USING ERRCODE='23514';END IF;
  RETURN arg_part.allocated_payable_minutes;
 END IF;
 payable:=arg_part.allocated_payable_minutes+remainder;
 IF payable>4320 OR arg_part.duration_evidence->'roundingCountAttributions' IS DISTINCT FROM jsonb_build_array(attribution)
  OR arg_part.duration_evidence->>'attributedPayableMinutes' IS DISTINCT FROM payable::text THEN
  RAISE EXCEPTION 'Rounded dated part quantity changed' USING ERRCODE='23514';END IF;
 RETURN payable;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN
 RAISE EXCEPTION 'Invalid rounded count evidence' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION app.attendance_policy_part_payable_count(public.attendance_overtime_policy_part,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Original capture geometry is a separate contract from boundary-floor minute attribution.
-- Private source validation only: no app EXECUTE and no payable/settlement admission authority.
CREATE FUNCTION app.attendance_policy_captured_coverage(arg_calculation_id uuid) RETURNS int8multirange
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE header public.attendance_overtime_calculation;source public.attendance_overtime_source;
 part public.attendance_overtime_policy_part;proof jsonb;data jsonb;inputs jsonb;clock_source jsonb;
 item jsonb;clock_row jsonb;expected jsonb;epoch_ms bigint;in_ms bigint;out_ms bigint;from_ms bigint;to_ms bigint;
 lo integer;hi integer;part_total integer;part_payable integer;payable_total integer:=0;count_parts jsonb:='[]'::jsonb;total integer:=0;part_count integer:=0;used integer:=0;
 ranges int8multirange:='{}'::int8multirange;recorded int8multirange:='{}'::int8multirange;
 count_ranges int8multirange;expected_ranges int8multirange;span int8range;last_ms bigint;
 is_attested boolean:=false;attested public.attendance_policy_attested_effect;anchor public.attendance;testimony jsonb;testimony_span jsonb;
 requested_basis boolean:=false;requested_span jsonb;selected_from bigint;selected_to bigint;
 pin public.attendance_punch;pout public.attendance_punch;cin public.attendance_clock_capture;cout public.attendance_clock_capture;
BEGIN
 IF app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Current captured coverage principal required' USING ERRCODE='42501';END IF;
 SELECT * INTO header FROM public.attendance_overtime_calculation WHERE id=arg_calculation_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR header.binding_kind IS DISTINCT FROM 'attendanceGroupPolicy' THEN RAISE EXCEPTION 'Policy capture parent unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO source FROM public.attendance_overtime_source WHERE id=header.source_id AND tenant_id=header.tenant_id AND company_id=header.company_id;
 IF NOT FOUND OR(app.overtime_attendance_visible(source.tenant_id,source.employment_id,source.attendance_date)
  OR app.can_admin_payroll_for(source.company_id)) IS NOT TRUE THEN RAISE EXCEPTION 'Captured coverage source outside authority' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(source.tenant_id::text||':'||source.employment_id::text,0));
 SELECT * INTO source FROM public.attendance_overtime_source WHERE id=header.source_id AND tenant_id=header.tenant_id AND company_id=header.company_id FOR SHARE;
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE OR(app.overtime_attendance_visible(source.tenant_id,source.employment_id,source.attendance_date)
  OR app.can_admin_payroll_for(source.company_id)) IS NOT TRUE THEN RAISE EXCEPTION 'Captured coverage authority changed while waiting' USING ERRCODE='42501';END IF;
 SELECT e.inputs,e.evidence INTO inputs,data FROM public.attendance_overtime_calculation_evidence e WHERE e.calculation_id=header.id AND e.tenant_id=header.tenant_id AND e.company_id=header.company_id;
 proof:=data->'policyCapturedCoverage';clock_source:=data->'policyClockSource';
 is_attested:=proof->>'countBasis'='attestedBoundaryFloor';
 IF proof->>'state' IS DISTINCT FROM 'prepared' OR proof->>'authority' IS DISTINCT FROM (CASE WHEN is_attested THEN 'attestedCountCoverageProposalOnly' ELSE 'capturedCountCoverageProposalOnly' END)
  OR proof->>'countBasis' IS DISTINCT FROM (CASE WHEN is_attested THEN 'attestedBoundaryFloor' ELSE 'capturedBoundaryFloor' END) OR data#>>'{policyDurationReplay,state}' IS DISTINCT FROM 'known'
  OR coalesce(proof->>'durationDigest','')!~'^[0-9a-f]{64}$' OR proof->>'durationDigest' IS DISTINCT FROM data#>>'{policyDurationReplay,digest}'
  OR data#>>'{attendanceGroupPolicy,id}' IS DISTINCT FROM header.policy_revision_id::text
  OR data#>>'{policyExecutionProposal,state}' IS DISTINCT FROM 'proposed' OR data#>>'{policyExecutionProposal,policyRevisionId}' IS DISTINCT FROM header.policy_revision_id::text
  OR data#>>'{policyExecutionProposal,duration,status}' IS DISTINCT FROM 'calculated'
  OR proof#>>'{identity,tenantId}' IS DISTINCT FROM source.tenant_id::text OR proof#>>'{identity,companyId}' IS DISTINCT FROM source.company_id::text
  OR proof#>>'{identity,employmentId}' IS DISTINCT FROM source.employment_id::text OR proof#>>'{identity,sourceId}' IS DISTINCT FROM source.id::text
  OR proof#>>'{identity,calculationId}' IS DISTINCT FROM header.id::text OR proof#>>'{identity,date}' IS DISTINCT FROM source.attendance_date::text
  OR inputs#>>'{source,tenantId}' IS DISTINCT FROM source.tenant_id::text OR inputs#>>'{source,employmentId}' IS DISTINCT FROM source.employment_id::text
  OR inputs#>>'{source,attendanceId}' IS DISTINCT FROM source.attendance_id::text OR inputs#>>'{source,date}' IS DISTINCT FROM source.attendance_date::text
  OR inputs#>>'{source,inputDigest}' IS DISTINCT FROM header.input_digest OR inputs#>>'{source,approvalDigest}' IS DISTINCT FROM header.approval_digest
  OR(NOT is_attested AND(clock_source->>'state' IS DISTINCT FROM 'known' OR data#>>'{policyClockReview,state}' IS DISTINCT FROM 'known'
  OR data#>>'{policyClockReview,evidence,complete}' IS DISTINCT FROM 'true' OR data#>>'{policyClockReview,evidence,requiresReview}' IS DISTINCT FROM 'false'))
  OR jsonb_typeof(proof->'allocations') IS DISTINCT FROM 'array' OR jsonb_typeof(proof->'intervals') IS DISTINCT FROM 'array'
  OR(NOT is_attested AND(jsonb_typeof(clock_source->'clocks') IS DISTINCT FROM 'array' OR jsonb_typeof(data#>'{policyClockReview,evidence,intervals}') IS DISTINCT FROM 'array')) THEN
  RAISE EXCEPTION 'Complete bound captured coverage evidence required' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(proof->'allocations')>4320 OR jsonb_array_length(proof->'intervals')>4320 OR(NOT is_attested AND(jsonb_array_length(clock_source->'clocks')>128
  OR(SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(clock_source->'clocks') x)<>jsonb_array_length(clock_source->'clocks')
  OR(SELECT count(DISTINCT x->>'captureId') FROM jsonb_array_elements(clock_source->'clocks') x)<>jsonb_array_length(clock_source->'clocks'))) THEN
  RAISE EXCEPTION 'Captured coverage exceeds source bounds' USING ERRCODE='23514';END IF;
 epoch_ms:=(extract(epoch FROM(source.attendance_date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'))*1000)::bigint;
 IF is_attested THEN
  -- The existing private owner admits a DISTINCT HR-work basis, never fictitious punches.
  SELECT * INTO attested FROM public.attendance_policy_attested_effect e WHERE e.tenant_id=source.tenant_id
   AND e.correction_id=(proof->>'correctionId')::uuid AND e.attendance_id=source.attendance_id
   AND e.company_id=source.company_id AND e.employment_id=source.employment_id AND e.attendance_date=source.attendance_date;
  IF NOT FOUND OR proof->>'workflowRequestId' IS DISTINCT FROM attested.workflow_request_id::text
   OR data#>>'{policyRawEffectSource,attested,authority}' IS DISTINCT FROM 'attestedSourceOnly'
   OR data#>>'{policyRawEffectSource,attested,punchCount}' IS DISTINCT FROM '0'
   OR(data#>'{policyRawEffectSource,attested,ownerEffect}'-'recorded_at') IS DISTINCT FROM(to_jsonb(attested)-'recorded_at')
   OR(data#>>'{policyRawEffectSource,attested,ownerEffect,recorded_at}')::timestamptz IS DISTINCT FROM attested.recorded_at
   OR attested.context_evidence IS DISTINCT FROM data->'policyExecutionContext'
   OR attested.context_evidence#>>'{selected,id}' IS DISTINCT FROM header.policy_revision_id::text
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(data#>'{policyApprovalInput,requests}') request
    WHERE request->>'id'=attested.correction_id::text AND request#>'{submissionContract,policyBinding}'=attested.policy_binding) THEN
   RAISE EXCEPTION 'Exact retained attested work owner required' USING ERRCODE='23514';END IF;
  SELECT * INTO anchor FROM public.attendance a WHERE a.id=source.attendance_id AND a.tenant_id=source.tenant_id
   AND a.employment_id=source.employment_id AND a.attendance_date=source.attendance_date
   AND a.attested_work_correction_id=attested.correction_id;
  IF NOT FOUND OR anchor.status<>'present' OR anchor.attested_work_context IS DISTINCT FROM attested.context_evidence
   OR anchor.check_in_at IS NOT NULL OR anchor.check_out_at IS NOT NULL OR anchor.worked_minutes IS NOT NULL
   OR anchor.ot_minutes IS NOT NULL OR anchor.late_minutes IS NOT NULL OR anchor.early_out_minutes IS NOT NULL
   OR anchor.under_minutes IS NOT NULL OR anchor.late_deduct_minutes IS NOT NULL OR anchor.early_out_deduct_minutes IS NOT NULL
   OR anchor.ot_flat_minutes IS NOT NULL OR anchor.ot00_minutes IS NOT NULL OR anchor.ot10_minutes IS NOT NULL
   OR anchor.ot15_minutes IS NOT NULL OR anchor.ot20_minutes IS NOT NULL OR anchor.ot30_minutes IS NOT NULL
   OR(anchor.calc_trace IS NOT NULL AND anchor.calc_trace-'overtimePattern'<>'{}'::jsonb)
   OR EXISTS(SELECT 1 FROM public.attendance_punch p WHERE p.tenant_id=source.tenant_id AND p.attendance_id=anchor.id AND p.voided_at IS NULL)
   OR(SELECT count(*) FROM public.attendance_correction c WHERE c.tenant_id=source.tenant_id AND c.employment_id=source.employment_id
    AND c.attendance_date=source.attendance_date AND c.requested_ot_minutes IS NOT NULL AND c.cancelled_at IS NULL AND c.status<>'rejected')<>1
   OR NOT EXISTS(SELECT 1 FROM public.attendance_correction c JOIN public.attendance_policy_request_contract contract ON contract.correction_id=c.id AND contract.tenant_id=c.tenant_id
    JOIN public.attendance_policy_final_receipt receipt ON receipt.correction_id=c.id AND receipt.tenant_id=c.tenant_id
    WHERE c.id=attested.correction_id AND c.tenant_id=source.tenant_id AND c.employment_id=source.employment_id
     AND c.attendance_date=source.attendance_date AND c.status='approved' AND c.cancelled_at IS NULL AND c.applied_at IS NULL
     AND c.requested_ot_minutes=attested.requested_minutes AND c.approved_ot_minutes=attested.approved_minutes
     AND c.ot_approval_method::text=attested.manual_method AND contract.attested_work=attested.attested_work
     AND contract.policy_binding=attested.policy_binding AND contract.company_id=source.company_id
     AND receipt.raw_evidence IS NULL AND receipt.workflow_request_id=attested.workflow_request_id AND receipt.actor_user_id=attested.actor_user_id
     AND receipt.workflow_evidence->'submittedAttestedWork'=attested.attested_work
     AND(receipt.workflow_evidence->'unclockedEffect'-'recorded_at')=(to_jsonb(attested)-'recorded_at')
     AND(receipt.workflow_evidence#>>'{unclockedEffect,recorded_at}')::timestamptz=attested.recorded_at) THEN
   RAISE EXCEPTION 'Current uncancelled HR actual-work source changed' USING ERRCODE='23514';END IF;
  testimony:=attested.attested_work->'work';
  IF testimony->>'completeWorkedDay' IS DISTINCT FROM 'true' OR testimony->>'sourceDate' IS DISTINCT FROM source.attendance_date::text
   OR jsonb_typeof(testimony->'intervals') IS DISTINCT FROM 'array' OR jsonb_array_length(testimony->'intervals') NOT BETWEEN 1 AND 16 THEN
   RAISE EXCEPTION 'Complete actual attested day required' USING ERRCODE='23514';END IF;
  requested_basis:=coalesce(data#>>'{policyExecutionProposal,manualEvidence,basis}'='completeAttestedRequest',false);
  IF attested.context_evidence#>>'{selected,policy,overtime,approval}'='manual' AND testimony?'requestedIntervals'
   AND attested.manual_method<>'system_calculated' AND attested.approved_minutes=attested.requested_minutes THEN
   IF NOT requested_basis OR data#>>'{policyExecutionProposal,manualEvidence,correctionId}' IS DISTINCT FROM attested.correction_id::text
    OR data#>>'{policyExecutionProposal,manualEvidence,workflowRequestId}' IS DISTINCT FROM attested.workflow_request_id::text THEN
    RAISE EXCEPTION 'Retain the complete submitted actual overtime request positions' USING ERRCODE='23514';END IF;
  ELSIF requested_basis THEN RAISE EXCEPTION 'This scalar method did not choose the submitted actual overtime positions' USING ERRCODE='23514';END IF;

 ELSE
 FOR clock_row IN SELECT value FROM jsonb_array_elements(clock_source->'clocks') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.attendance_punch p JOIN public.attendance_clock_capture c ON c.id=p.clock_capture_id AND c.tenant_id=p.tenant_id
   WHERE p.id=(clock_row->>'id')::uuid AND c.id=(clock_row->>'captureId')::uuid AND p.tenant_id=source.tenant_id AND p.attendance_id=source.attendance_id
    AND p.employment_id=source.employment_id AND c.employment_id=source.employment_id AND p.attendance_date=source.attendance_date AND c.attendance_date=source.attendance_date
    AND p.direction::text=clock_row->>'direction' AND c.direction::text=p.direction::text
    AND clock_row->>'atMilliseconds'=(floor(extract(epoch FROM c.server_recorded_at)*1000)::bigint-epoch_ms)::text
    AND clock_row->>'recordedAt'=to_char(date_trunc('milliseconds',c.server_recorded_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND left(p.punch_at::text,8)=to_char(c.server_recorded_at AT TIME ZONE 'Asia/Kuala_Lumpur','HH24:MI:SS')) THEN
   RAISE EXCEPTION 'Captured coverage clock identity changed' USING ERRCODE='23514';END IF;
 END LOOP;
 END IF;
 FOR part IN SELECT * FROM public.attendance_overtime_policy_part WHERE calculation_id=header.id AND tenant_id=header.tenant_id AND company_id=header.company_id ORDER BY sequence LOOP
  IF part.sequence<>part_count OR part.input_digest<>header.input_digest OR jsonb_typeof(part.duration_evidence->'allocatedIntervals') IS DISTINCT FROM 'array'
   OR jsonb_array_length(part.duration_evidence->'allocatedIntervals')>4320 THEN RAISE EXCEPTION 'Complete captured count parts required' USING ERRCODE='23514';END IF;
  part_count:=part_count+1;part_total:=0;count_ranges:='{}'::int8multirange;expected_ranges:='{}'::int8multirange;
  FOR expected IN SELECT value FROM jsonb_array_elements(part.duration_evidence->'allocatedIntervals') LOOP
   IF coalesce(expected->>'from','')!~'^[0-9]{1,4}$' OR coalesce(expected->>'to','')!~'^[0-9]{1,4}$' THEN RAISE EXCEPTION 'Invalid captured count coordinates' USING ERRCODE='23514';END IF;
   lo:=(expected->>'from')::integer;hi:=(expected->>'to')::integer;
   IF lo>=hi OR hi>4320 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(part.source_intervals) original WHERE(original->>'from')::integer<=lo AND(original->>'to')::integer>=hi) THEN
    RAISE EXCEPTION 'Captured count lacks original allocated source' USING ERRCODE='23514';END IF;
   span:=int8range(lo,hi,'[)');IF expected_ranges&&span THEN RAISE EXCEPTION 'Captured count allocations overlap' USING ERRCODE='23514';END IF;
   expected_ranges:=expected_ranges+int8multirange(span);
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(proof->'allocations') WHERE value->>'sequence'=part.sequence::text LOOP
   IF coalesce(item->>'fromMinute','')!~'^[0-9]{1,4}$' OR coalesce(item->>'toMinute','')!~'^[0-9]{1,4}$' OR item->>'calendarDate' IS DISTINCT FROM part.calendar_date::text THEN
    RAISE EXCEPTION 'Invalid dated captured count allocation' USING ERRCODE='23514';END IF;
   lo:=(item->>'fromMinute')::integer;hi:=(item->>'toMinute')::integer;
   IF lo>=hi OR hi>4320 OR item->>'minutes' IS DISTINCT FROM(hi-lo)::text THEN RAISE EXCEPTION 'Captured quantity changed' USING ERRCODE='23514';END IF;
   IF is_attested THEN
    IF coalesce(item->>'attestedIntervalIndex','')!~'^[0-9]{1,2}$' THEN
     RAISE EXCEPTION 'Attested interval identity required' USING ERRCODE='23514';END IF;
    testimony_span:=testimony->'intervals'->((item->>'attestedIntervalIndex')::integer);
    IF testimony_span IS NULL OR coalesce(testimony_span->>'fromEpochMillisecond','')!~'^[0-9]{1,16}$'
     OR coalesce(testimony_span->>'toEpochMillisecond','')!~'^[0-9]{1,16}$' THEN
     RAISE EXCEPTION 'Original attested interval unavailable' USING ERRCODE='23514';END IF;
    in_ms:=(testimony_span->>'fromEpochMillisecond')::bigint;out_ms:=(testimony_span->>'toEpochMillisecond')::bigint;
    IF in_ms<epoch_ms OR out_ms<=in_ms OR out_ms>epoch_ms+259200000
     OR lo<floor((in_ms-epoch_ms)::numeric/60000) OR hi>floor((out_ms-epoch_ms)::numeric/60000)
     OR item->>'attestedFromEpochMillisecond' IS DISTINCT FROM in_ms::text
     OR item->>'attestedToEpochMillisecond' IS DISTINCT FROM out_ms::text THEN
     RAISE EXCEPTION 'Attested allocation changed original testimony' USING ERRCODE='23514';END IF;
   ELSE
   SELECT * INTO pin FROM public.attendance_punch WHERE id=(item->>'inPunchId')::uuid AND tenant_id=source.tenant_id AND attendance_id=source.attendance_id AND direction='in';
   SELECT * INTO pout FROM public.attendance_punch WHERE id=(item->>'outPunchId')::uuid AND tenant_id=source.tenant_id AND attendance_id=source.attendance_id AND direction='out';
   SELECT * INTO cin FROM public.attendance_clock_capture WHERE id=pin.clock_capture_id AND id=(item->>'inCaptureId')::uuid AND tenant_id=source.tenant_id;
   SELECT * INTO cout FROM public.attendance_clock_capture WHERE id=pout.clock_capture_id AND id=(item->>'outCaptureId')::uuid AND tenant_id=source.tenant_id;
   IF cin.id IS NULL OR cout.id IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(clock_source->'clocks') x WHERE x->>'id'=pin.id::text AND x->>'captureId'=cin.id::text)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(clock_source->'clocks') x WHERE x->>'id'=pout.id::text AND x->>'captureId'=cout.id::text) THEN RAISE EXCEPTION 'Captured allocation boundary identity missing' USING ERRCODE='23514';END IF;
   in_ms:=floor(extract(epoch FROM cin.server_recorded_at)*1000)::bigint;out_ms:=floor(extract(epoch FROM cout.server_recorded_at)*1000)::bigint;
   IF in_ms>=out_ms OR lo<floor((in_ms-epoch_ms)::numeric/60000) OR hi>floor((out_ms-epoch_ms)::numeric/60000)
    OR item->>'captureInEpochMillisecond' IS DISTINCT FROM in_ms::text OR item->>'captureOutEpochMillisecond' IS DISTINCT FROM out_ms::text
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(data#>'{policyClockReview,evidence,intervals}') x WHERE x->>'inMillisecond'=(in_ms-epoch_ms)::text AND x->>'outMillisecond'=(out_ms-epoch_ms)::text) THEN
    RAISE EXCEPTION 'Captured allocation changed original geometry' USING ERRCODE='23514';END IF;
   END IF;
   selected_from:=in_ms;selected_to:=out_ms;
   IF is_attested AND requested_basis THEN
    IF coalesce(item->>'requestedIntervalIndex','')!~'^[0-9]{1,2}$' THEN
     RAISE EXCEPTION 'Exact requested interval identity required' USING ERRCODE='23514';END IF;
    requested_span:=testimony->'requestedIntervals'->((item->>'requestedIntervalIndex')::integer);
    IF requested_span IS NULL OR coalesce(requested_span->>'fromEpochMillisecond','')!~'^[0-9]{1,16}$'
     OR coalesce(requested_span->>'toEpochMillisecond','')!~'^[0-9]{1,16}$' THEN
     RAISE EXCEPTION 'Original requested actual-work interval unavailable' USING ERRCODE='23514';END IF;
    selected_from:=(requested_span->>'fromEpochMillisecond')::bigint;selected_to:=(requested_span->>'toEpochMillisecond')::bigint;
    IF selected_from<in_ms OR selected_to>out_ms OR selected_to<=selected_from
     OR lo<floor((selected_from-epoch_ms)::numeric/60000) OR hi>floor((selected_to-epoch_ms)::numeric/60000)
     OR item->>'requestedFromEpochMillisecond' IS DISTINCT FROM selected_from::text OR item->>'requestedToEpochMillisecond' IS DISTINCT FROM selected_to::text THEN
     RAISE EXCEPTION 'Requested physical subset changed its original actual-work positions' USING ERRCODE='23514';END IF;
   END IF;
   from_ms:=greatest(selected_from,epoch_ms+lo::bigint*60000);to_ms:=least(selected_to,epoch_ms+hi::bigint*60000);
   IF from_ms>=to_ms OR item->>'fromEpochMillisecond' IS DISTINCT FROM from_ms::text OR item->>'toEpochMillisecond' IS DISTINCT FROM to_ms::text THEN RAISE EXCEPTION 'Captured footprint is not original source intersection' USING ERRCODE='23514';END IF;
   IF is_attested AND item IS DISTINCT FROM(jsonb_build_object('sequence',part.sequence,'calendarDate',part.calendar_date,
    'fromMinute',lo,'toMinute',hi,'minutes',hi-lo,'attestedIntervalIndex',(item->>'attestedIntervalIndex')::integer,
    'attestedFromEpochMillisecond',in_ms,'attestedToEpochMillisecond',out_ms,'fromEpochMillisecond',from_ms,'toEpochMillisecond',to_ms)
    ||CASE WHEN requested_basis THEN jsonb_build_object('requestedIntervalIndex',(item->>'requestedIntervalIndex')::integer,
     'requestedFromEpochMillisecond',selected_from,'requestedToEpochMillisecond',selected_to) ELSE '{}'::jsonb END) THEN
    RAISE EXCEPTION 'Distinct complete attested allocation required' USING ERRCODE='23514';END IF;
   span:=int8range(lo,hi,'[)');IF count_ranges&&span THEN RAISE EXCEPTION 'Captured count claimed twice' USING ERRCODE='23514';END IF;count_ranges:=count_ranges+int8multirange(span);
   span:=int8range(from_ms,to_ms,'[)');IF ranges&&span THEN RAISE EXCEPTION 'Captured physical source claimed twice' USING ERRCODE='23514';END IF;ranges:=ranges+int8multirange(span);
   part_total:=part_total+hi-lo;used:=used+1;
  END LOOP;
  IF part_total<>part.allocated_payable_minutes OR count_ranges IS DISTINCT FROM expected_ranges THEN RAISE EXCEPTION 'Complete exact captured count partition required' USING ERRCODE='23514';END IF;
  part_payable:=app.attendance_policy_part_payable_count(part,data#>'{policyExecutionProposal,duration}',data->'policyDurationFormulaInput');
  payable_total:=payable_total+part_payable;
  count_parts:=count_parts||jsonb_build_array(jsonb_build_object('sequence',part.sequence,'calendarDate',part.calendar_date,'dayClass',part.day_class,
   'physicalMinutes',part_total,'roundedMinutes',part_payable-part_total,'minutes',part_payable,
   'roundingCountAttributions',coalesce(part.duration_evidence->'roundingCountAttributions','[]'::jsonb)));
  total:=total+part_total;
 END LOOP;
 IF payable_total>total THEN
  IF proof->'countAttribution' IS DISTINCT FROM jsonb_build_object('state','known','physicalMinutes',total,
   'roundedMinutes',payable_total-total,'minutes',payable_total,'parts',count_parts) THEN
   RAISE EXCEPTION 'Captured rounded count attribution changed' USING ERRCODE='23514';END IF;
 ELSIF proof?'countAttribution' THEN RAISE EXCEPTION 'Unexpected captured rounded count attribution' USING ERRCODE='23514';END IF;
 IF part_count<>header.policy_part_count OR used<>jsonb_array_length(proof->'allocations') OR proof->>'minutes' IS DISTINCT FROM payable_total::text
  OR data#>>'{policyDurationReplay,minutes}' IS DISTINCT FROM payable_total::text OR data#>>'{policyExecutionProposal,duration,payableMinutes}' IS DISTINCT FROM payable_total::text THEN
  RAISE EXCEPTION 'Captured parent count partition changed' USING ERRCODE='23514';END IF;
 last_ms:=NULL;
 FOR item IN SELECT value FROM jsonb_array_elements(proof->'intervals') LOOP
  IF coalesce(item->>'fromEpochMillisecond','')!~'^-?[0-9]{1,16}$' OR coalesce(item->>'toEpochMillisecond','')!~'^-?[0-9]{1,16}$' THEN RAISE EXCEPTION 'Invalid captured footprint' USING ERRCODE='23514';END IF;
  from_ms:=(item->>'fromEpochMillisecond')::bigint;to_ms:=(item->>'toEpochMillisecond')::bigint;
  IF from_ms>=to_ms OR(last_ms IS NOT NULL AND from_ms<=last_ms) THEN RAISE EXCEPTION 'Captured footprint is not normalized' USING ERRCODE='23514';END IF;
  recorded:=recorded+int8multirange(int8range(from_ms,to_ms,'[)'));last_ms:=to_ms;
 END LOOP;
 IF recorded IS DISTINCT FROM ranges THEN RAISE EXCEPTION 'Captured footprint does not replay' USING ERRCODE='23514';END IF;
 RETURN ranges;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RAISE EXCEPTION 'Invalid captured source evidence' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION app.attendance_policy_captured_coverage(uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['attendance_overtime_source','attendance_overtime_calculation','attendance_overtime_calculation_evidence','attendance_overtime_policy_part','attendance_punch','attendance_clock_capture','attendance','attendance_correction','attendance_policy_request_contract','attendance_policy_final_receipt','attendance_policy_attested_effect'] LOOP
  EXECUTE format('CREATE POLICY overtime_capture_proof_owner_read ON public.%I FOR SELECT USING(current_user=pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=%L::regprocedure)))',table_name,'app.attendance_policy_captured_coverage(uuid)');
 END LOOP;
END $$;
CREATE FUNCTION app.guard_attendance_policy_captured_evidence() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.evidence#>>'{policyCapturedCoverage,state}'='prepared' THEN PERFORM app.attendance_policy_captured_coverage(NEW.calculation_id);END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_attendance_policy_captured_evidence() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER attendance_policy_captured_evidence_complete AFTER INSERT ON public.attendance_overtime_calculation_evidence
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_policy_captured_evidence();
--> statement-breakpoint
CREATE FUNCTION app.capture_overtime_settlement_coverage() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.attendance_overtime_source;header public.attendance_overtime_calculation;
 part public.attendance_overtime_policy_part;proof jsonb;duration jsonb;item jsonb;class_row jsonb;
 from_text text;to_text text;lo integer;hi integer;part_total integer;total integer:=0;part_count integer:=0;
 epoch_ms bigint;span int8range;ranges int8multirange:='{}'::int8multirange;recorded int8multirange:='{}'::int8multirange;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF(NEW.coverage_employment_id,NEW.coverage_calculation_id,NEW.coverage_kind,NEW.reservation_coverage)
   IS DISTINCT FROM(OLD.coverage_employment_id,OLD.coverage_calculation_id,OLD.coverage_kind,OLD.reservation_coverage) THEN
   RAISE EXCEPTION 'Reservation coverage is immutable; use the canonical release owner' USING ERRCODE='23514';END IF;
  -- Original0551 guards still own release, closed Payroll and reversed TOIL/FK teardown checks.
  RETURN NEW;
 END IF;
 IF NEW.coverage_employment_id IS NOT NULL OR NEW.coverage_calculation_id IS NOT NULL
  OR NEW.coverage_kind IS NOT NULL OR NEW.reservation_coverage IS NOT NULL THEN
  RAISE EXCEPTION 'Only the settlement owner derives reservation coverage' USING ERRCODE='42501';END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR app.principal_snapshot_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Current settlement principal required' USING ERRCODE='42501';END IF;
 SELECT * INTO source FROM public.attendance_overtime_source WHERE id=NEW.source_id
  AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 IF NOT FOUND OR(app.overtime_attendance_visible(source.tenant_id,source.employment_id,source.attendance_date)
  OR app.can_admin_payroll_for(source.company_id)) IS NOT TRUE THEN
  RAISE EXCEPTION 'Settlement source is outside current authority' USING ERRCODE='42501';END IF;
 -- Same canonical employee key as Attendance/Payroll/TOIL. Re-read AFTER waiting and retain the
 -- source row lock through commit; exclusion constraints independently arbitrate concurrent inserts.
 PERFORM pg_advisory_xact_lock(hashtextextended(source.tenant_id::text||':'||source.employment_id::text,0));
 SELECT * INTO source FROM public.attendance_overtime_source WHERE id=NEW.source_id
  AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id FOR SHARE;
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE
  OR(app.overtime_attendance_visible(source.tenant_id,source.employment_id,source.attendance_date)
   OR app.can_admin_payroll_for(source.company_id)) IS NOT TRUE THEN
  RAISE EXCEPTION 'Settlement authority changed while waiting' USING ERRCODE='42501';END IF;
 NEW.coverage_employment_id:=source.employment_id;
 epoch_ms:=(extract(epoch FROM(source.attendance_date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'))*1000)::bigint;
 IF source.current_calculation_id IS NOT NULL THEN
  SELECT * INTO header FROM public.attendance_overtime_calculation WHERE id=source.current_calculation_id
   AND source_id=source.id AND tenant_id=source.tenant_id AND company_id=source.company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current reservation calculation is unavailable' USING ERRCODE='23514';END IF;
 END IF;
 IF header.binding_kind IS DISTINCT FROM 'attendanceGroupPolicy' THEN
  NEW.coverage_kind:='legacyUnknown';NEW.coverage_calculation_id:=NULL;
  NEW.reservation_coverage:=int8multirange(int8range(epoch_ms,epoch_ms+259200000,'[)'));
  RETURN NEW;
 END IF;
 -- Mode-specific contract admission runs before derived physical reservation coverage.
 IF (NEW.mode='cash' AND(header.outcome<>'ready' OR NOT header.transferable)) OR header.duration_outcome<>'ready'
  OR header.approval_status NOT IN('approved','notRequired') OR header.policy_part_count<1
  OR header.payable_numerator IS NULL OR header.payable_denominator IS NULL THEN
  RAISE EXCEPTION 'Complete payable policy execution is required before physical reservation' USING ERRCODE='23514';END IF;
 SELECT evidence->'policyCoverage',evidence#>'{policyExecutionProposal,duration}' INTO proof,duration
  FROM public.attendance_overtime_calculation_evidence WHERE calculation_id=header.id
   AND tenant_id=source.tenant_id AND company_id=source.company_id;
 IF NOT FOUND OR proof->>'state' IS DISTINCT FROM 'prepared'
  OR proof->>'authority' IS DISTINCT FROM 'coverageProposalOnly'
  OR proof#>>'{identity,tenantId}' IS DISTINCT FROM source.tenant_id::text
  OR proof#>>'{identity,companyId}' IS DISTINCT FROM source.company_id::text
  OR proof#>>'{identity,employmentId}' IS DISTINCT FROM source.employment_id::text
  OR proof#>>'{identity,sourceId}' IS DISTINCT FROM source.id::text
  OR proof#>>'{identity,calculationId}' IS DISTINCT FROM header.id::text
  OR proof#>>'{identity,date}' IS DISTINCT FROM source.attendance_date::text
  OR proof->>'basis' IS NULL OR proof->>'basis' NOT IN('actual','approvedPlan')
  OR proof->>'basis' IS DISTINCT FROM duration->>'intervalBasis'
  OR duration->>'status' IS DISTINCT FROM 'calculated'
  OR jsonb_typeof(proof->'intervals') IS DISTINCT FROM 'array'
  OR jsonb_typeof(duration->'classes') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Exact immutable reservation evidence is required' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(proof->'intervals')>4320 OR jsonb_array_length(duration->'classes')<1 OR jsonb_array_length(duration->'classes')>5 THEN
  RAISE EXCEPTION 'Reservation evidence exceeds its canonical bound' USING ERRCODE='23514';END IF;
 FOR part IN SELECT * FROM public.attendance_overtime_policy_part WHERE calculation_id=header.id
  AND tenant_id=source.tenant_id AND company_id=source.company_id ORDER BY sequence LOOP
  IF part.sequence<>part_count OR part.input_digest<>header.input_digest
   OR jsonb_typeof(part.duration_evidence->'allocatedIntervals') IS DISTINCT FROM 'array'
   OR jsonb_array_length(part.duration_evidence->'allocatedIntervals')>4320 THEN
   RAISE EXCEPTION 'Complete ordered policy allocations are required' USING ERRCODE='23514';END IF;
  part_count:=part_count+1;part_total:=0;
  FOR item IN SELECT value FROM jsonb_array_elements(part.duration_evidence->'allocatedIntervals') LOOP
   from_text:=item->>'from';to_text:=item->>'to';
   IF from_text IS NULL OR to_text IS NULL OR from_text!~'^[0-9]{1,4}$' OR to_text!~'^[0-9]{1,4}$' THEN
    RAISE EXCEPTION 'Invalid allocated physical interval' USING ERRCODE='23514';END IF;
   lo:=from_text::integer;hi:=to_text::integer;
   IF lo<0 OR lo>=hi OR hi>4320 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(part.source_intervals) AS original(value)
    WHERE(original.value->>'from')::integer<=lo AND(original.value->>'to')::integer>=hi) THEN
    RAISE EXCEPTION 'Allocated physical interval lacks source coverage' USING ERRCODE='23514';END IF;
   span:=int8range(epoch_ms+lo::bigint*60000,epoch_ms+hi::bigint*60000,'[)');
   IF ranges&&span THEN RAISE EXCEPTION 'Policy allocations overlap within their parent' USING ERRCODE='23514';END IF;
   ranges:=ranges+int8multirange(span);part_total:=part_total+hi-lo;
  END LOOP;
  IF part_total<>part.allocated_payable_minutes THEN
   RAISE EXCEPTION 'Physical allocation count changed' USING ERRCODE='23514';END IF;
  total:=total+app.attendance_policy_part_payable_count(part,duration,
   (SELECT evidence->'policyDurationFormulaInput' FROM public.attendance_overtime_calculation_evidence WHERE calculation_id=header.id));
 END LOOP;
 IF part_count<>header.policy_part_count OR total<=0
  OR header.payable_numerator!~'^[0-9]{1,80}$' OR header.payable_denominator!~'^[0-9]{1,80}$'
  OR header.payable_denominator::numeric<=0
  OR header.payable_numerator::numeric<>total::numeric*header.payable_denominator::numeric
  OR(duration->>'payableMinutes') IS DISTINCT FROM total::text THEN
  RAISE EXCEPTION 'Every payable minute needs exact complete physical coverage' USING ERRCODE='23514';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(proof->'intervals') LOOP
  from_text:=item->>'fromEpochMillisecond';to_text:=item->>'toEpochMillisecond';
  IF from_text IS NULL OR to_text IS NULL OR from_text!~'^-?[0-9]{1,16}$' OR to_text!~'^-?[0-9]{1,16}$'
   OR from_text::bigint>=to_text::bigint THEN
   RAISE EXCEPTION 'Invalid recorded physical coverage' USING ERRCODE='23514';END IF;
  span:=int8range(from_text::bigint,to_text::bigint,'[)');
  IF recorded&&span THEN RAISE EXCEPTION 'Recorded physical coverage overlaps itself' USING ERRCODE='23514';END IF;
  recorded:=recorded+int8multirange(span);
 END LOOP;
 IF recorded IS DISTINCT FROM ranges THEN
  RAISE EXCEPTION 'Recorded coverage does not replay from all dated parts' USING ERRCODE='23514';END IF;
 -- Count coordinates above retain their original owner. Reservation geometry instead binds
 -- exact original captures; payable minute quantity need not equal footprint milliseconds.
 IF proof->'countAttribution' IS DISTINCT FROM(SELECT evidence#>'{policyCapturedCoverage,countAttribution}'
  FROM public.attendance_overtime_calculation_evidence WHERE calculation_id=header.id) THEN
  RAISE EXCEPTION 'Count-coordinate and captured-source attribution differ' USING ERRCODE='23514';END IF;
 ranges:=app.attendance_policy_captured_coverage(header.id);
 -- Rows predating this migration retain all-NULL metadata. Never backfill/rewrite paid history;
 -- conservatively refuse new policy overlap with their possible bounded source period instead.
 IF EXISTS(SELECT 1 FROM public.overtime_source_settlement old_claim
  JOIN public.attendance_overtime_source old_source ON old_source.id=old_claim.source_id AND old_source.tenant_id=old_claim.tenant_id
  WHERE old_claim.tenant_id=source.tenant_id AND old_source.employment_id=source.employment_id
   AND old_source.attendance_date BETWEEN source.attendance_date-2 AND source.attendance_date+2
   AND old_claim.released_at IS NULL AND old_claim.coverage_kind IS NULL
   AND ranges&&int8range((extract(epoch FROM(old_source.attendance_date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'))*1000)::bigint,
    (extract(epoch FROM(old_source.attendance_date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'))*1000)::bigint+259200000,'[)')) THEN
  RAISE EXCEPTION 'An older active reservation has unknown potentially overlapping physical coverage' USING ERRCODE='23514';END IF;
 NEW.coverage_kind:='policyPhysical';NEW.coverage_calculation_id:=header.id;NEW.reservation_coverage:=ranges;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.capture_overtime_settlement_coverage() FROM PUBLIC,ai_hr_app;
-- Restricted migration owners must be able to check hidden same-employment reservations inside
-- the checked definer hook. Use its actual function owner, which may differ from restored table
-- owners. The application role gains no additional table or function authority.
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['attendance_overtime_source','attendance_overtime_calculation',
  'attendance_overtime_calculation_evidence','attendance_overtime_policy_part','overtime_source_settlement'] LOOP
  EXECUTE format('CREATE POLICY overtime_coverage_owner_read ON public.%I FOR SELECT USING(current_user=pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=%L::regprocedure)))',table_name,'app.capture_overtime_settlement_coverage()');
 END LOOP;
END $$;
--> statement-breakpoint
-- Validate mode-specific policy admission before deriving actual source coverage.
CREATE TRIGGER ab_overtime_settlement_coverage BEFORE INSERT OR UPDATE ON public.overtime_source_settlement
 FOR EACH ROW EXECUTE FUNCTION app.capture_overtime_settlement_coverage();

--> statement-breakpoint
-- Complete stored financial parent/dated-line integrity. This does not perform pricing in SQL
-- or establish current source authority. Financial consumers independently replay the one engine;
-- the earlier aa current mode-specific settlement admission owner remains mandatory.
-- Private structural comparison only: no duration, schedule, rate or money evaluation.
-- Hourly expressions may differ only with the same explicit shared money-rule identity.
CREATE FUNCTION app.attendance_policy_dated_rate_shape(arg_definition jsonb) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_set(arg_definition,'{rates}',(
  SELECT coalesce(jsonb_agg(jsonb_set(rate,'{tiers}',(
   SELECT coalesce(jsonb_agg(CASE WHEN tier#>>'{payment,method}'='hourly'
    THEN jsonb_set(tier,'{payment}',(tier->'payment')||jsonb_build_object('rate',NULL,'multiplier',NULL))
    ELSE tier END ORDER BY tier_ordinal),'[]'::jsonb)
   FROM jsonb_array_elements(rate->'tiers') WITH ORDINALITY AS tiers(tier,tier_ordinal)
  )) ORDER BY rate_ordinal),'[]'::jsonb)
  FROM jsonb_array_elements(arg_definition->'rates') WITH ORDINALITY AS rates(rate,rate_ordinal)
 ))
$$;
REVOKE ALL ON FUNCTION app.attendance_policy_dated_rate_shape(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_attendance_policy_financial_evidence() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent_id uuid;header public.attendance_overtime_calculation;source public.attendance_overtime_source;
 evidence public.attendance_overtime_calculation_evidence;duration jsonb;cash jsonb;identity jsonb;
 part_json jsonb;line_json jsonb;actual_count integer;version_count integer;definition_count integer;shape_count integer;money_scope text;part_versions jsonb;total numeric;item jsonb;priced jsonb;previous_sequence integer:=-1;
BEGIN
 IF TG_TABLE_NAME='attendance_overtime_calculation' THEN parent_id:=NEW.id;ELSE parent_id:=NEW.calculation_id;END IF;
 SELECT * INTO header FROM public.attendance_overtime_calculation WHERE id=parent_id;
 IF NOT FOUND OR header.binding_kind<>'attendanceGroupPolicy' THEN RETURN NULL;END IF;
 SELECT * INTO source FROM public.attendance_overtime_source WHERE id=header.source_id
  AND tenant_id=header.tenant_id AND company_id=header.company_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Financial policy parent source is unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO evidence FROM public.attendance_overtime_calculation_evidence WHERE calculation_id=header.id
  AND tenant_id=header.tenant_id AND company_id=header.company_id;
 IF NOT FOUND THEN
  IF header.outcome='refused' AND header.duration_outcome='refused' AND NOT header.transferable
   AND NOT EXISTS(SELECT 1 FROM public.attendance_overtime_line WHERE calculation_id=header.id) THEN RETURN NULL;END IF;
  RAISE EXCEPTION 'Financial policy requires complete immutable evidence' USING ERRCODE='23514';END IF;
 duration:=evidence.evidence->'policyFinancialDurationContract';cash:=evidence.evidence->'policyFinancialContract';
 identity:=jsonb_build_object('tenantId',source.tenant_id,'companyId',source.company_id,'employmentId',source.employment_id,
  'sourceId',source.id,'calculationId',header.id,'date',source.attendance_date);
 SELECT coalesce(jsonb_agg(jsonb_build_object('sequence',sequence,'calendarDate',calendar_date,'dayClass',day_class,
  'moneyDay',money_day,'versionId',version_id,'rawMinutes',raw_minutes,'allocatedPayableMinutes',allocated_payable_minutes,
  'sourceIntervals',source_intervals,'calendarReferences',calendar_references,'durationEvidence',duration_evidence)
  ORDER BY sequence),'[]'::jsonb),count(*),coalesce(sum(CASE WHEN header.duration_outcome='ready'
   THEN app.attendance_policy_part_payable_count(part,evidence.evidence#>'{policyExecutionProposal,duration}',evidence.evidence->'policyDurationFormulaInput')
   ELSE allocated_payable_minutes END),0)
 INTO part_json,actual_count,total FROM public.attendance_overtime_policy_part part WHERE calculation_id=header.id;
 IF actual_count<>header.policy_part_count THEN
  RAISE EXCEPTION 'Financial policy requires its entire dated part set' USING ERRCODE='23514';END IF;
 IF header.duration_outcome='ready' THEN
  IF evidence.inputs->>'mode' IS DISTINCT FROM 'actual' OR evidence.inputs->>'layer' IS DISTINCT FROM 'raw'
   OR evidence.inputs->'patternVersionId' IS DISTINCT FROM 'null'::jsonb
   OR evidence.inputs->'assignmentId' IS DISTINCT FROM 'null'::jsonb THEN
   RAISE EXCEPTION 'Financial policy evidence must retain its actual raw policy identity' USING ERRCODE='23514';END IF;
  IF duration->>'state' IS DISTINCT FROM 'prepared' OR duration->>'authority' IS DISTINCT FROM 'policyFinancialDurationContractOnly'
   OR duration->'identity' IS DISTINCT FROM identity OR duration->>'policyRevisionId' IS DISTINCT FROM header.policy_revision_id::text
   OR duration->>'approvalStatus' IS DISTINCT FROM header.approval_status OR header.approval_status NOT IN('approved','notRequired')
   OR duration->>'durationDigest' IS DISTINCT FROM header.duration_input_digest
   OR jsonb_typeof(duration->'minutes') IS DISTINCT FROM 'number' OR duration->>'minutes' IS DISTINCT FROM total::text
   OR header.payable_numerator IS DISTINCT FROM total::text OR header.payable_denominator IS DISTINCT FROM '1'
   OR total<=0 OR duration->'parts' IS DISTINCT FROM part_json
   OR duration->'coverage' IS DISTINCT FROM evidence.evidence->'policyCapturedCoverage'
   OR evidence.evidence#>>'{policyDurationReplay,state}' IS DISTINCT FROM 'known'
   OR evidence.evidence#>>'{policyDurationReplay,digest}' IS DISTINCT FROM header.duration_input_digest
   OR evidence.evidence#>>'{policyDurationReplay,minutes}' IS DISTINCT FROM total::text THEN
   RAISE EXCEPTION 'Financial policy duration/header/parts mismatch' USING ERRCODE='23514';END IF;
  PERFORM app.attendance_policy_captured_coverage(header.id);
 ELSIF duration->>'state'='prepared' THEN
  RAISE EXCEPTION 'Prepared policy duration requires its exact ready duration header' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(jsonb_agg(line.evidence ORDER BY line.sequence,line.id),'[]'::jsonb),count(*),coalesce(sum(line.amount_minor_units::numeric),0)
 INTO line_json,actual_count,total FROM public.attendance_overtime_line line WHERE line.calculation_id=header.id;
 IF header.outcome='ready' THEN
  IF cash->>'state' IS DISTINCT FROM 'prepared' OR cash->>'authority' IS DISTINCT FROM 'policyFinancialContractOnly'
   OR cash->'identity' IS DISTINCT FROM identity OR cash->>'policyRevisionId' IS DISTINCT FROM header.policy_revision_id::text
   OR cash->>'inputDigest' IS DISTINCT FROM header.input_digest OR cash->>'approvalDigest' IS DISTINCT FROM header.approval_digest
   OR cash->>'referenceDigest' IS DISTINCT FROM header.reference_digest OR cash->>'approvalStatus' IS DISTINCT FROM header.approval_status
   OR cash->>'durationDigest' IS DISTINCT FROM header.duration_input_digest OR cash->>'minutes' IS DISTINCT FROM header.payable_numerator
   OR cash->'currency' IS DISTINCT FROM jsonb_build_object('code',header.currency,'minorScale',header.minor_scale)
   OR cash->'parts' IS DISTINCT FROM part_json OR cash->'coverage' IS DISTINCT FROM duration->'coverage'
   OR cash->'cash' IS DISTINCT FROM evidence.evidence->'policyCashReplay'
   OR cash#>>'{cash,state}' IS DISTINCT FROM 'known' OR cash#>>'{cash,amountMinorUnits}' IS DISTINCT FROM total::text
   OR cash->>'amountMinorUnits' IS DISTINCT FROM total::text OR actual_count<1 OR actual_count>16384
   OR cash->'lines' IS DISTINCT FROM line_json OR NOT header.transferable OR header.duration_outcome<>'ready' THEN
   RAISE EXCEPTION 'Financial policy cash/header/dated lines mismatch' USING ERRCODE='23514';END IF;
  -- Distinct immutable versions share one money scope only through an explicit new
  -- retained contract and identical definitions or an exact shared hourly-expression shape. Names/company metadata remain
  -- bound by EACH original version digest; SQL compares identity, never recomputes money.
  SELECT count(DISTINCT part.version_id),count(DISTINCT version.definition),count(DISTINCT app.attendance_policy_dated_rate_shape(version.definition)),jsonb_agg(part.version_id ORDER BY part.sequence)
   INTO version_count,definition_count,shape_count,part_versions FROM public.attendance_overtime_policy_part part
   JOIN public.overtime_pattern_version version ON version.id=part.version_id AND version.tenant_id=header.tenant_id
   WHERE part.calculation_id=header.id AND part.tenant_id=header.tenant_id AND part.allocated_payable_minutes>0;
  IF version_count>1 THEN
   money_scope:=evidence.evidence->>'policyMoneyScope';
   IF money_scope IS NULL OR money_scope NOT IN('identicalDefinitions','datedRateExpressions','datedFormulaRules')
    OR(money_scope='identicalDefinitions' AND definition_count<>1)
    OR(money_scope='datedRateExpressions' AND(definition_count<2 OR shape_count<>1))
    OR(money_scope='datedFormulaRules' AND definition_count<2)
    OR evidence.evidence#>>'{policyPricingProposal,state}' IS DISTINCT FROM 'proposed'
    OR jsonb_typeof(evidence.evidence#>'{policyPricingProposal,parts}') IS DISTINCT FROM 'array'
    OR jsonb_array_length(evidence.evidence#>'{policyPricingProposal,parts}')<>jsonb_array_length(part_versions) THEN
    RAISE EXCEPTION 'Distinct policy versions require one exact compatible definition scope' USING ERRCODE='23514';END IF;
   FOR priced IN SELECT value FROM jsonb_array_elements(evidence.evidence#>'{policyPricingProposal,parts}') LOOP
    IF priced#>'{pricing,moneyScope,formulaScope}' IS DISTINCT FROM jsonb_build_object('kind',money_scope,'partVersionIds',part_versions)
     OR NOT EXISTS(SELECT 1 FROM public.attendance_overtime_policy_part part JOIN public.overtime_pattern_version version
      ON version.id=part.version_id AND version.tenant_id=header.tenant_id WHERE part.calculation_id=header.id
      AND part.sequence::text=priced->>'sequence' AND part.calendar_date::text=priced->>'date'
      AND version.id::text=priced#>>'{pricing,patternVersionId}' AND version.digest=priced->>'definitionDigest') THEN
     RAISE EXCEPTION 'Compatible policy scope must retain every exact dated version digest' USING ERRCODE='23514';END IF;
   END LOOP;
  ELSIF version_count<>1 OR evidence.evidence?'policyMoneyScope' THEN
   RAISE EXCEPTION 'Policy money scope does not match its dated immutable versions' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(line_json) LOOP
   previous_sequence:=previous_sequence+1;
   IF item->>'sequence' IS DISTINCT FROM previous_sequence::text
    OR NOT EXISTS(SELECT 1 FROM public.attendance_overtime_policy_part part
     WHERE part.calculation_id=header.id AND part.sequence::text=item->>'partSequence'
      AND part.calendar_date::text=item->>'calendarDate' AND part.day_class=item->>'dayClass'
      AND part.money_day=item->>'moneyDay' AND part.version_id::text=item->>'versionId'
      AND part.allocated_payable_minutes>0)
    OR NOT EXISTS(SELECT 1 FROM public.attendance_overtime_line line WHERE line.calculation_id=header.id
     AND line.sequence=previous_sequence AND line.line_key=item#>>'{line,id}'
     AND line.component_id::text=item#>>'{line,mapping,earningItemId}'
     AND line.amount_minor_units=item#>>'{line,amountMinorUnits}'
     AND item#>>'{line,mapping,currency}'=header.currency) THEN
    RAISE EXCEPTION 'Financial policy line must retain exact dated formula ownership' USING ERRCODE='23514';END IF;
  END LOOP;
 ELSIF actual_count<>0 OR header.transferable OR cash->>'state'='prepared' THEN
  RAISE EXCEPTION 'Refused policy cash cannot retain payable lines or transfer authority' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.guard_attendance_policy_financial_evidence() FROM PUBLIC,ai_hr_app;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['attendance_overtime_source','attendance_overtime_calculation',
  'attendance_overtime_calculation_evidence','attendance_overtime_policy_part','attendance_overtime_line','overtime_pattern_version'] LOOP
  EXECUTE format('CREATE POLICY overtime_financial_proof_owner_read ON public.%I FOR SELECT USING(current_user=pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=%L::regprocedure)))',
   table_name,'app.guard_attendance_policy_financial_evidence()');
 END LOOP;
END $$;
CREATE CONSTRAINT TRIGGER attendance_policy_financial_header_complete AFTER INSERT ON public.attendance_overtime_calculation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_policy_financial_evidence();
CREATE CONSTRAINT TRIGGER attendance_policy_financial_evidence_complete AFTER INSERT ON public.attendance_overtime_calculation_evidence
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_policy_financial_evidence();
CREATE CONSTRAINT TRIGGER attendance_policy_financial_lines_complete AFTER INSERT ON public.attendance_overtime_line
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_policy_financial_evidence();

--> statement-breakpoint
-- Batch-level consumer barrier uses the SAME tenant epoch as individual canonical readers.
-- Generation, close and selective reprocessing take it BEFORE the batch row, with no source row
-- lock (Attendance owns employee/day/source -> epoch -> batch). A transfer adds claims under its
-- source/epoch barrier and the same batch row, so a new claim cannot bypass a locked run.
CREATE FUNCTION app.lock_overtime_payroll_batch_context(p_batch uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid:=app.current_tenant_id();employer uuid;
BEGIN
 SELECT company_id INTO employer FROM public.payroll_batch WHERE id=p_batch AND tenant_id=tenant;
 IF NOT FOUND THEN RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.overtime_source_settlement claim
  JOIN public.attendance_overtime_calculation header ON header.id=claim.calculation_id AND header.source_id=claim.source_id
   AND header.tenant_id=claim.tenant_id AND header.company_id=claim.company_id
  WHERE claim.tenant_id=tenant AND claim.company_id=employer AND claim.payroll_batch_id=p_batch
   AND claim.mode='cash' AND claim.released_at IS NULL AND header.binding_kind='attendanceGroupPolicy') THEN RETURN;END IF;
 IF app.attendance_policy_principal_current() IS NOT TRUE OR NOT app.can_admin_payroll_for(employer) THEN
  RAISE EXCEPTION 'Current scoped Payroll authority required' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.overtime_pattern_epoch WHERE tenant_id=tenant FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Financial policy configuration is unavailable' USING ERRCODE='23514';END IF;
 IF app.attendance_policy_principal_current() IS NOT TRUE OR NOT app.can_admin_payroll_for(employer)
  OR NOT EXISTS(SELECT 1 FROM public.payroll_batch WHERE id=p_batch AND tenant_id=tenant AND company_id=employer) THEN
  RAISE EXCEPTION 'Current scoped Payroll authority required' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.lock_overtime_payroll_batch_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_overtime_payroll_batch_context(uuid) TO ai_hr_app;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['payroll_batch','overtime_source_settlement','attendance_overtime_calculation','overtime_pattern_epoch'] LOOP
  EXECUTE format('CREATE POLICY overtime_batch_context_owner_read ON public.%I FOR SELECT USING(current_user=pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=%L::regprocedure)))',
   table_name,'app.lock_overtime_payroll_batch_context(uuid)');
 END LOOP;
END $$;
