-- Shared draft protection is safe only when EVERY new payslip membership first owns its parent.
DO $attendance_draft_parent_rows$
DECLARE
 f_identity text; f_oid oid; f_definition text; f_body text; f_attributes jsonb;
 f_expected_hash text; f_new_body text; f_segment text; f_filter text; f_loop text;
 f_start integer; f_end integer; native_owner name;
BEGIN
 IF to_regprocedure('app.lock_payslip_attendance_membership()') IS NOT NULL THEN
  RAISE EXCEPTION 'Absent native payslip membership lock owner required';
 END IF;
 SELECT pg_get_userbyid(proowner) INTO STRICT native_owner FROM pg_proc
  WHERE oid='app.attendance_payroll_protection_rows(uuid)'::regprocedure;
 EXECUTE $create_membership_lock$
 CREATE FUNCTION app.lock_payslip_attendance_membership() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
 BEGIN
  IF TG_OP='UPDATE' THEN
   IF ROW(OLD.batch_id,OLD.employment_id,OLD.tenant_id) IS NOT DISTINCT FROM ROW(NEW.batch_id,NEW.employment_id,NEW.tenant_id) THEN RETURN NEW; END IF;
  END IF;
  -- Own the incoming FK parent before its membership can become visible. Existing write RLS
  -- still decides permission. A move keeps the FK's incoming-parent order, without owning its donor.
  PERFORM b.id FROM public.payroll_batch b WHERE b.id=NEW.batch_id FOR UPDATE;
  RETURN NEW;
 END;
 $body$;
 $create_membership_lock$;
 EXECUTE format('ALTER FUNCTION app.lock_payslip_attendance_membership() OWNER TO %I',native_owner);
 REVOKE ALL ON FUNCTION app.lock_payslip_attendance_membership() FROM PUBLIC,ai_hr_app;
 CREATE TRIGGER payslip_attendance_membership_lock BEFORE INSERT OR UPDATE OF batch_id,employment_id,tenant_id ON public.payslip
 FOR EACH ROW EXECUTE FUNCTION app.lock_payslip_attendance_membership();
 FOREACH f_identity IN ARRAY ARRAY['app.attendance_payroll_protection_rows(uuid)','app.attendance_payroll_protection_rows(uuid,date[])'] LOOP
  f_oid:=f_identity::regprocedure;
  SELECT pg_get_functiondef(p.oid),p.prosrc,to_jsonb(p)-'prosrc' INTO STRICT f_definition,f_body,f_attributes FROM pg_proc p WHERE oid=f_oid;
  f_expected_hash:=CASE f_identity WHEN 'app.attendance_payroll_protection_rows(uuid)' THEN
   '2c3c43da69872cc3fd9324460f481614f6893fc596940c09d29e64cf102cbfae'
   ELSE 'ea4663f252dff4008d8663b44e8598ee4b873a284636922a63345573678f4cb8' END;
  IF encode(sha256(convert_to(f_body,'UTF8')),'hex') IS DISTINCT FROM f_expected_hash OR
   f_attributes->>'provolatile'<>'v' OR NOT (f_attributes->>'prosecdef')::boolean THEN
   RAISE EXCEPTION 'Reviewed native Attendance Payroll row owner required';
  END IF;
  IF length(f_body)-length(replace(f_body,'DECLARE subject employment;',''))<>length('DECLARE subject employment;') OR
   length(f_body)-length(replace(f_body,'ORDER BY b.id FOR UPDATE;',''))<>length('ORDER BY b.id FOR UPDATE;') THEN
   RAISE EXCEPTION 'Exact native Attendance Payroll lock sites required';
  END IF;
  f_start:=strpos(f_body,' PERFORM b.id FROM payroll_batch b');
  f_end:=strpos(f_body,'ORDER BY b.id FOR UPDATE;')+length('ORDER BY b.id FOR UPDATE;');
  IF f_start=0 OR f_end<=f_start THEN RAISE EXCEPTION 'Native ordered batch predicate required'; END IF;
  f_segment:=substring(f_body FROM f_start FOR f_end-f_start);
  f_filter:=replace(replace(f_segment,' PERFORM b.id FROM payroll_batch b',''),' ORDER BY b.id FOR UPDATE;','');
  f_loop:=replace(replace(f_segment,' PERFORM b.id FROM','SELECT b.id,b.status::text AS expected_status FROM'),' FOR UPDATE;','');
  f_new_body:=replace(f_body,'DECLARE subject employment;','DECLARE subject employment; selected_batch record; locked_status text;');
  f_new_body:=replace(f_new_body,f_segment,
   ' FOR selected_batch IN '||f_loop||E' LOOP\n'||
   E'  IF selected_batch.expected_status=''draft'' THEN\n   BEGIN\n'||
   '    SELECT b.status::text INTO locked_status FROM payroll_batch b'||f_filter||E' AND b.id=selected_batch.id FOR SHARE;\n'||
   E'    IF locked_status IS DISTINCT FROM ''draft'' THEN RAISE EXCEPTION ''Reacquire changed Payroll source'' USING ERRCODE=''PFD01''; END IF;\n'||
   E'   EXCEPTION WHEN SQLSTATE ''PFD01'' THEN\n'||
   '    PERFORM b.id FROM payroll_batch b'||f_filter||E' AND b.id=selected_batch.id FOR UPDATE;\n'||
   E'   END;\n  ELSE\n'||
   '   PERFORM b.id FROM payroll_batch b'||f_filter||E' AND b.id=selected_batch.id FOR UPDATE;\n'||
   E'  END IF;\n END LOOP;');
  EXECUTE replace(f_definition,f_body,f_new_body);
  IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=f_oid) IS DISTINCT FROM f_attributes OR
   (SELECT prosrc FROM pg_proc WHERE oid=f_oid) IS DISTINCT FROM f_new_body THEN
   RAISE EXCEPTION 'Native Attendance financial owner attributes changed unexpectedly';
  END IF;
 END LOOP;
END;
$attendance_draft_parent_rows$;
