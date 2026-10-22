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
 INSERT INTO public.attendance_policy_request_contract(correction_id,tenant_id,employment_id,attendance_date,company_id,kind,visible_epoch)
  VALUES(NEW.id,NEW.tenant_id,NEW.employment_id,NEW.attendance_date,v_company,v_kind,v_epoch);
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
