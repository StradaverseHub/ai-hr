-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5082_home_own_clock_day, idx 4482, when 1793330004782.
-- Draft name on its branch: 9870_home_own_clock_day. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT (Home per-card reads, 10 November 2026). Final tag, idx and when are assigned at integration.
-- One read of the rows the own live clock and its schedule read for one employment on yesterday and today: the open
-- day probe, the attendance rows, their unvoided punches with each capture's true instant, the day adjustments, the
-- company policy row, the roster rows, the dated shift arrangements, every shift and Schedule Group rule those can
-- name (with OT rows, exception revisions and shift OT windows), the rotation versions, the geofencing and photo
-- switches and the usable assigned clocking site names. Each part is the existing reader's own predicate
-- (core/attendance-clock-read.ts, core/attendance.ts scheduleFor, core/attendance-rule.ts resolveRuleTx,
-- core/attendance-rotation.ts rotationLookupTx, core/clocking-location.ts employeeClockingLocationLabelsTx).
-- SECURITY INVOKER: every table is read under the caller's own row-level security, exactly as those readers are, so
-- this returns no row they could not. It writes nothing, decides no authority and computes no figure: the caller
-- proves the own subject first and runs the unchanged TypeScript schedule and clock logic on the result.
-- Full rows are to_jsonb plus the driver text of their timestamp and numeric columns (db/json-row.ts); the
-- capture's offline instant is named only where draft 0647's effective_at column exists, like clockCaptureInstantTx.
CREATE FUNCTION app.home_own_clock_day(p_employment uuid, p_today date, p_yesterday date) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $bundle$
DECLARE
 wanted_dates date[] := ARRAY[p_yesterday, p_today];
 shift_ids uuid[];
 rule_ids uuid[];
 default_rule uuid;
 punch_rows jsonb;
BEGIN
 SELECT coalesce(array_agg(DISTINCT x) FILTER (WHERE x IS NOT NULL), '{}') INTO shift_ids FROM (
  SELECT ra.shift_id AS x FROM roster_assignment ra WHERE ra.employment_id = p_employment AND ra.shift_date = ANY (wanted_dates)
  UNION ALL SELECT sa.shift_id FROM employment_shift_arrangement sa WHERE sa.employment_id = p_employment AND sa.superseded_at IS NULL
  UNION ALL SELECT e.default_shift_id FROM employment e WHERE e.id = p_employment
  UNION ALL SELECT d.shift_id FROM attendance_day_adjustment d WHERE d.employment_id = p_employment AND d.attendance_date = ANY (wanted_dates)
  UNION ALL SELECT unnest(v.allowed_shift_ids) FROM attendance_rotation v
 ) ids;
 SELECT r.id INTO default_rule FROM attendance_rule r WHERE r.is_default = true LIMIT 1;
 SELECT coalesce(array_agg(DISTINCT x) FILTER (WHERE x IS NOT NULL), '{}') INTO rule_ids FROM (
  SELECT e.attendance_rule_id AS x FROM employment e WHERE e.id = p_employment
  UNION ALL SELECT default_rule
  UNION ALL SELECT s.rule_id FROM shift s WHERE s.id = ANY (shift_ids)
  UNION ALL SELECT v.rule_id FROM attendance_rotation v
 ) ids;
 IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('attendance_clock_capture') AND attname = 'effective_at' AND NOT attisdropped) THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('attendanceId', p.attendance_id, 'id', p.id, 'direction', p.direction, 'time', p.punch_at,
   'captureId', p.clock_capture_id, 'recordedAt', coalesce(c.effective_at, c.server_recorded_at)::text) ORDER BY p.created_at, p.id), '[]'::jsonb)
  INTO punch_rows FROM attendance_punch p LEFT JOIN attendance_clock_capture c ON c.id = p.clock_capture_id
  WHERE p.voided_at IS NULL AND p.attendance_id IN (SELECT a.id FROM attendance a WHERE a.employment_id = p_employment AND a.attendance_date = ANY (wanted_dates));
 ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('attendanceId', p.attendance_id, 'id', p.id, 'direction', p.direction, 'time', p.punch_at,
   'captureId', p.clock_capture_id, 'recordedAt', c.server_recorded_at::text) ORDER BY p.created_at, p.id), '[]'::jsonb)
  INTO punch_rows FROM attendance_punch p LEFT JOIN attendance_clock_capture c ON c.id = p.clock_capture_id
  WHERE p.voided_at IS NULL AND p.attendance_id IN (SELECT a.id FROM attendance a WHERE a.employment_id = p_employment AND a.attendance_date = ANY (wanted_dates));
 END IF;
 RETURN jsonb_build_object(
  'openDay', (SELECT a.attendance_date FROM attendance a WHERE a.employment_id = p_employment AND a.attendance_date >= p_yesterday
   AND a.check_in_at IS NOT NULL AND a.check_out_at IS NULL ORDER BY a.attendance_date DESC LIMIT 1),
  'days', (SELECT coalesce(jsonb_agg(jsonb_build_object('attendanceDate', a.attendance_date, 'id', a.id, 'checkIn', a.check_in_at,
   'checkOut', a.check_out_at, 'checkInMethod', a.check_in_method, 'trace', a.calc_trace) ORDER BY a.attendance_date, a.ctid), '[]'::jsonb)
   FROM attendance a WHERE a.employment_id = p_employment AND a.attendance_date = ANY (wanted_dates)),
  'punches', punch_rows,
  'control', (SELECT jsonb_build_object('enabled', e.geofencing_enabled, 'attendancePhotoSetting', e.attendance_photo_setting)
   FROM employment e WHERE e.id = p_employment LIMIT 1),
  'policy', (SELECT jsonb_build_object('scheduleGroupId', e.attendance_rule_id, 'lateAfter', ap.late_after, 'halfDayBefore', ap.half_day_before,
   'workStart', ap.work_start, 'workEnd', ap.work_end, 'breakMinutes', ap.break_minutes, 'workingDays', ap.working_days,
   'halfWorkingDays', ap.half_working_days)
   FROM employment e LEFT JOIN attendance_policy ap ON ap.company_id = e.company_id WHERE e.id = p_employment LIMIT 1),
  'adjustments', (SELECT coalesce(jsonb_agg(to_jsonb(d) || jsonb_build_object('updated_at', d.updated_at::text) ORDER BY d.attendance_date, d.ctid), '[]'::jsonb)
   FROM attendance_day_adjustment d WHERE d.employment_id = p_employment AND d.attendance_date = ANY (wanted_dates)),
  'roster', (SELECT coalesce(jsonb_agg(jsonb_build_object('shiftDate', ra.shift_date, 'isRestDay', ra.is_rest_day, 'shiftId', ra.shift_id)
   ORDER BY ra.shift_date, ra.ctid), '[]'::jsonb)
   FROM roster_assignment ra WHERE ra.employment_id = p_employment AND ra.shift_date = ANY (wanted_dates)),
  'arrangements', (SELECT coalesce(jsonb_agg(jsonb_build_object('employmentId', sa.employment_id, 'shiftType', sa.shift_type, 'shiftId', sa.shift_id,
   'validFrom', sa.valid_from) ORDER BY sa.valid_from, sa.ctid), '[]'::jsonb)
   FROM employment_shift_arrangement sa WHERE sa.employment_id = p_employment AND sa.superseded_at IS NULL),
  'defaultShiftId', (SELECT s.id FROM employment e JOIN shift s ON s.id = e.default_shift_id WHERE e.id = p_employment LIMIT 1),
  'shiftIds', to_jsonb(shift_ids),
  'shifts', (SELECT coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('archived_at', s.archived_at::text, 'created_at', s.created_at::text,
   'updated_at', s.updated_at::text) ORDER BY s.ctid), '[]'::jsonb) FROM shift s WHERE s.id = ANY (shift_ids)),
  'otWindows', (SELECT coalesce(jsonb_agg(jsonb_build_object('shiftId', w.shift_id, 'label', w.label, 'startTime', w.start_time, 'endTime', w.end_time,
   'endNextDay', w.end_next_day, 'minMinutes', w.min_minutes, 'maxMinutes', w.max_minutes, 'adjustAfterMinutes', w.adjust_after_minutes,
   'adjustDeltaMinutes', w.adjust_delta_minutes) ORDER BY w.shift_id, w.sort_order, w.ctid), '[]'::jsonb)
   FROM shift_ot_window w WHERE w.shift_id = ANY (shift_ids)),
  'rotations', (SELECT coalesce(jsonb_agg(to_jsonb(v) || jsonb_build_object('created_at', v.created_at::text) ORDER BY v.rule_id, v.effective_from, v.ctid), '[]'::jsonb)
   FROM attendance_rotation v),
  'defaultRuleId', default_rule,
  'ruleIds', to_jsonb(rule_ids),
  'rules', (SELECT coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('created_at', r.created_at::text, 'updated_at', r.updated_at::text)
   ORDER BY r.ctid), '[]'::jsonb) FROM attendance_rule r WHERE r.id = ANY (rule_ids)),
  'otRows', (SELECT coalesce(jsonb_agg(to_jsonb(o) || jsonb_build_object('rate', o.rate::text, 'ph_rate', o.ph_rate::text, 'created_at', o.created_at::text)
   ORDER BY o.rule_id, o.ctid), '[]'::jsonb) FROM attendance_rule_ot_row o WHERE o.rule_id = ANY (rule_ids)),
  'exceptions', (SELECT coalesce(jsonb_agg(jsonb_build_object('ruleId', x.rule_id, 'id', x.id, 'effectiveFrom', x.effective_from, 'enabled', x.enabled)
   ORDER BY x.rule_id, x.effective_from, x.ctid), '[]'::jsonb) FROM attendance_exception_revision x WHERE x.rule_id = ANY (rule_ids)),
  'locations', (SELECT jsonb_build_object('total', coalesce(max(q.total), 0), 'names', coalesce(jsonb_agg(q.name ORDER BY q.ord), '[]'::jsonb)) FROM (
   SELECT cl.name, count(*) OVER () AS total, row_number() OVER (ORDER BY cl.name, cl.id) AS ord
   FROM employee_clocking_location ecl JOIN clocking_location cl ON cl.id = ecl.clocking_location_id
   WHERE ecl.employment_id = p_employment AND (cl.archived_at IS NULL AND EXISTS (
    SELECT 1 FROM clocking_location_company uc JOIN employment ue ON ue.company_id = uc.company_id
    WHERE uc.clocking_location_id = cl.id AND ue.id = ecl.employment_id))
   ORDER BY cl.name, cl.id LIMIT 3) q)
 );
END $bundle$;
REVOKE ALL ON FUNCTION app.home_own_clock_day(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_own_clock_day(uuid, date, date) TO ai_hr_app;
