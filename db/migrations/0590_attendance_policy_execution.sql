-- Board 1 reservation: 0590 / 1791900000070. DRAFT, UNREGISTERED AND UNAPPLIED.
-- Add immutable policy-part storage below the existing OT parent. The staged contract is explicitly
-- non-payable until canonical execution, approval receipts and independent financial replay exist.
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
   AND version_id IS NULL AND assignment_id IS NULL AND outcome='refused'
   AND duration_outcome='refused' AND NOT transferable));
-- The original 0551 version/assignment constraint and evidence trigger are deliberately unchanged.
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
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='epoch' AND company_id IS NOT NULL AND visible_epoch IS NOT NULL)
   OR(kind='unavailable' AND company_id IS NULL AND visible_epoch IS NULL)));
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
 plan jsonb;start_min integer;end_min integer;duration_min integer;
BEGIN
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
   v_kind:='epoch';
  END IF;
 END IF;
 IF v_kind='unavailable' THEN v_company:=NULL;v_epoch:=NULL;END IF;
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
 INSERT INTO public.attendance_policy_request_contract(correction_id,tenant_id,employment_id,attendance_date,company_id,kind,visible_epoch,planned_window)
  VALUES(NEW.id,NEW.tenant_id,NEW.employment_id,NEW.attendance_date,v_company,v_kind,v_epoch,plan);
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
 completion public.attendance_workflow_decision;raw jsonb;participants jsonb;
BEGIN
 IF OLD.status<>'pending' OR NEW.status<>'approved' OR NEW.requested_ot_minutes IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO contract FROM public.attendance_policy_request_contract WHERE correction_id=OLD.id
  AND tenant_id=OLD.tenant_id AND employment_id=OLD.employment_id AND attendance_date=OLD.attendance_date AND kind='epoch';
 -- No backfill and no promotion of legacy approvals into a fresh final effect.
 IF NOT FOUND THEN RETURN NEW;END IF;
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
   AND a.attendance_date=OLD.attendance_date AND app.attendance_workflow_active_write(a.xmin);
 INSERT INTO public.attendance_policy_final_receipt(correction_id,tenant_id,employment_id,attendance_date,company_id,
  workflow_request_id,actor_user_id,submission_epoch,request_evidence,workflow_evidence,raw_evidence)
 VALUES(OLD.id,OLD.tenant_id,OLD.employment_id,OLD.attendance_date,contract.company_id,w.id,app.current_user_id()::text,contract.visible_epoch,
  jsonb_build_object('requestedMinutes',NEW.requested_ot_minutes,'approvedMinutes',NEW.approved_ot_minutes,'method',NEW.ot_approval_method,
   'plannedStartLabel',NEW.planned_start_time,'plannedEndLabel',NEW.planned_end_time,
   'checkIn',NEW.proposed_check_in,'checkOut',NEW.proposed_check_out,'clockChanges',NEW.clock_changes),
  jsonb_build_object('requestId',w.id,'routingVersion',w.routing_version,'stageCount',jsonb_array_length(w.stages),
   'completion',to_jsonb(completion),'participants',participants,'submittedPlan',contract.planned_window),raw);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.capture_attendance_policy_final_receipt() FROM PUBLIC,ai_hr_app;
-- The existing workflow authority guards run first. Any later refusal rolls this receipt back with
-- the status transition. The private final-effect proof is still pending/live here, not replayed later.
CREATE TRIGGER zz_attendance_policy_final_receipt BEFORE UPDATE ON public.attendance_correction
 FOR EACH ROW EXECUTE FUNCTION app.capture_attendance_policy_final_receipt();

--> statement-breakpoint
-- This draft is a non-payable storage stage in BOTH settlement modes. The old cash guard already
-- requires a ready calculation; the old TOIL guard checks its accrual but does not inspect that outcome.
-- Keep the single parent settlement owner and refuse a new staged policy claim before either branch.
CREATE FUNCTION app.guard_attendance_policy_settlement_stage() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.attendance_overtime_source;kind text;
BEGIN
 IF NEW.released_at IS NOT NULL THEN RETURN NEW;END IF;
 SELECT * INTO source FROM public.attendance_overtime_source
  WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Current settlement subject is unavailable' USING ERRCODE='42501';END IF;
 -- Use the parent's current header in either mode; a null TOIL calculation_id cannot hide its policy.
 IF source.current_calculation_id IS NOT NULL THEN
  SELECT binding_kind INTO kind FROM public.attendance_overtime_calculation
   WHERE id=source.current_calculation_id AND source_id=source.id AND tenant_id=source.tenant_id AND company_id=source.company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current settlement calculation is unavailable' USING ERRCODE='42501';END IF;
  IF kind='attendanceGroupPolicy' THEN
   RAISE EXCEPTION 'Policy overtime settlement remains unavailable before complete execution and independent replay' USING ERRCODE='23514';END IF;
 END IF;
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
 -- This additional guard does NOT remove the earlier unconditional staged-policy payment fence.
 IF header.outcome<>'ready' OR header.duration_outcome<>'ready' OR NOT header.transferable
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
 FOR class_row IN SELECT value FROM jsonb_array_elements(duration->'classes') LOOP
  IF(class_row->>'unplacedPayableMinutes') IS DISTINCT FROM '0' THEN
   RAISE EXCEPTION 'Unplaced rounded counts require separate proved coverage' USING ERRCODE='23514';END IF;
 END LOOP;
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
  total:=total+part_total;
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
CREATE TRIGGER a0_overtime_settlement_coverage BEFORE INSERT OR UPDATE ON public.overtime_source_settlement
 FOR EACH ROW EXECUTE FUNCTION app.capture_overtime_settlement_coverage();
