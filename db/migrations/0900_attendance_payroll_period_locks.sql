-- Date-bounded Attendance guard; undated callers retain their original all-period protection.
-- The native bound is a conservative superset of canonical cutOffWindowFor coverage,
-- not a second financial cutoff calculator. Exact coverage is still resolved by its owner.
DO $attendance_period_locks$
DECLARE
 f_name text;
 f_oid oid;
 f_new_oid oid;
 f_definition text;
 f_body text;
 f_attributes jsonb;
 f_owner name;
 f_expected_hash text;
 f_new_body text;
 excluded_attributes constant text[] := ARRAY['oid','prosrc','pronargs','proargtypes','proallargtypes','proargmodes','proargnames'];
 declaration_before constant text := E'DECLARE subject employment;\nBEGIN';
 declaration_after constant text := $bounded_declaration$DECLARE subject employment; lower_period text; upper_period text;
BEGIN
 -- Unusual/empty direct calls keep the old conservative locks instead of silently narrowing.
 IF attendance_dates IS NULL OR cardinality(attendance_dates)=0 OR EXISTS (
  SELECT 1 FROM unnest(attendance_dates) wanted(on_date)
  WHERE on_date IS NULL OR NOT isfinite(on_date) OR on_date<date '0001-01-01' OR on_date>=date '9999-12-01'
 ) THEN
  RETURN QUERY SELECT * FROM app.attendance_payroll_protection_rows(subject_id);
  RETURN;
 END IF;
 SELECT to_char(min(on_date),'YYYY-MM'),to_char(max(on_date)+interval '1 month','YYYY-MM')
 INTO lower_period,upper_period FROM unnest(attendance_dates) wanted(on_date);$bounded_declaration$;
 predicate_before constant text := 'WHERE b.tenant_id=subject.tenant_id AND ';
 predicate_after constant text := $bounded_predicate$WHERE b.tenant_id=subject.tenant_id AND
 (b.pay_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR b.pay_period BETWEEN lower_period AND upper_period) AND $bounded_predicate$;
BEGIN
 FOREACH f_name IN ARRAY ARRAY['attendance_payroll_protection_rows','attendance_payroll_protection'] LOOP
  f_oid:=to_regprocedure(format('app.%I(uuid)',f_name));
  IF f_oid IS NULL OR to_regprocedure(format('app.%I(uuid,date[])',f_name)) IS NOT NULL THEN
   RAISE EXCEPTION 'Reviewed Attendance Payroll donor and absent bounded overload required';
  END IF;
  SELECT pg_get_functiondef(p.oid),p.prosrc,to_jsonb(p),pg_get_userbyid(p.proowner)
  INTO f_definition,f_body,f_attributes,f_owner FROM pg_proc p WHERE p.oid=f_oid;
  f_expected_hash:=CASE f_name
   WHEN 'attendance_payroll_protection_rows' THEN '2c3c43da69872cc3fd9324460f481614f6893fc596940c09d29e64cf102cbfae'
   ELSE 'bcd928a5f75ba61c7ef3adda7e9b0accbd1d2fee3357557a2642ff60b92dda67' END;
  IF encode(sha256(convert_to(f_body,'UTF8')),'hex') IS DISTINCT FROM f_expected_hash OR
     NOT (f_attributes->>'prosecdef')::boolean OR f_attributes->>'provolatile'<>'v' THEN
   RAISE EXCEPTION 'Unexpected Attendance Payroll donor; reviewed predecessor required';
  END IF;
  IF f_name='attendance_payroll_protection_rows' THEN
   IF length(f_body)-length(replace(f_body,declaration_before,''))<>length(declaration_before) OR
      length(f_body)-length(replace(f_body,predicate_before,''))<>2*length(predicate_before) THEN
    RAISE EXCEPTION 'Unexpected private Attendance Payroll bound sites';
   END IF;
   f_new_body:=replace(replace(f_body,declaration_before,declaration_after),predicate_before,predicate_after);
  ELSE
   f_new_body:=replace(f_body,'app.attendance_payroll_protection_rows(subject_id)','app.attendance_payroll_protection_rows(subject_id,attendance_dates)');
   IF f_new_body=f_body THEN RAISE EXCEPTION 'Missing authorized Attendance Payroll delegate';END IF;
  END IF;
  IF length(f_definition)-length(replace(f_definition,'subject_id uuid)',''))<>length('subject_id uuid)') THEN
   RAISE EXCEPTION 'Unexpected Attendance Payroll signature';
  END IF;
  f_definition:=replace(replace(f_definition,f_body,f_new_body),'subject_id uuid)','subject_id uuid, attendance_dates date[])');
  EXECUTE f_definition;
  EXECUTE format('ALTER FUNCTION app.%I(uuid,date[]) OWNER TO %I',f_name,f_owner);
  EXECUTE format('REVOKE ALL ON FUNCTION app.%I(uuid,date[]) FROM PUBLIC,ai_hr_app',f_name);
  IF f_name='attendance_payroll_protection' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION app.%I(uuid,date[]) TO ai_hr_app',f_name);
  END IF;
  f_new_oid:=to_regprocedure(format('app.%I(uuid,date[])',f_name));
  IF (SELECT to_jsonb(p)-excluded_attributes FROM pg_proc p WHERE oid=f_new_oid) IS DISTINCT FROM f_attributes-excluded_attributes OR
     (SELECT prosrc FROM pg_proc WHERE oid=f_new_oid) IS DISTINCT FROM f_new_body OR
     (SELECT to_jsonb(p) FROM pg_proc p WHERE oid=f_oid) IS DISTINCT FROM f_attributes THEN
   RAISE EXCEPTION 'Attendance Payroll donor or bounded attributes changed unexpectedly';
  END IF;
 END LOOP;
END;
$attendance_period_locks$;
