-- Board 8cff7fef: Workforce may invalidate precisely the subject's open payroll inputs without reading pay.
CREATE FUNCTION app.workforce_payroll_inputs_changed(wanted uuid,from_day date,until_day date,category text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); n integer;
BEGIN
 IF NOT app.access_workforce_employment(wanted,'workforce.maintain')
  OR category IS NULL OR category NOT IN ('employment_information','transfer','compensation','hire_date','termination','statutory')
  OR from_day IS NULL OR (until_day IS NOT NULL AND until_day<=from_day)
  OR coalesce(app.access_lock_mode_held(t),'') NOT IN ('S','X') THEN
  RAISE EXCEPTION 'Payroll input invalidation unavailable' USING ERRCODE='42501';
 END IF;
 -- The native writer must own ALL current/former payroll-input keys before it changes rows.
 -- A public EXECUTE grant supplies neither the Access barrier nor payroll-input serialization.
 IF EXISTS(SELECT 1 FROM app.payroll_input_lock_keys(ARRAY[wanted],NULL) AS keys(key) WHERE NOT EXISTS(
  SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
   AND l.granted AND l.objsubid=1 AND l.mode IN ('ShareLock','ExclusiveLock')
   AND ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended(keys.key,0))) THEN
  RAISE EXCEPTION 'Payroll inputs must be serialized before invalidation' USING ERRCODE='42501';
 END IF;
 WITH locked AS MATERIALIZED (
  SELECT b.id FROM public.payroll_batch b WHERE b.tenant_id=t AND b.status IN ('processed','processing')
   AND b.pay_period>=to_char(from_day,'YYYY-MM')
   AND (until_day IS NULL OR b.pay_period<=to_char(until_day-1,'YYYY-MM'))
   AND EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=t AND p.batch_id=b.id AND p.employment_id=wanted
    AND app.payroll_history_row_visible('payslip',p.id))
  ORDER BY b.id FOR UPDATE
 ), changed AS (
  UPDATE public.payroll_batch b SET needs_recalc_at=coalesce(b.needs_recalc_at,now()),
   recalc_employment_ids=(SELECT jsonb_agg(DISTINCT item.value ORDER BY item.value) FROM jsonb_array_elements_text(coalesce(b.recalc_employment_ids,'[]'::jsonb)||to_jsonb(ARRAY[wanted])) AS item(value))
  FROM locked l WHERE b.id=l.id AND b.status IN ('processed','processing') RETURNING b.id,b.recalc_employment_ids
 ) INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  SELECT t,'payroll-batch',c.id,'payroll-batch.recalc-required',
   (CASE WHEN app.current_user_id() IS NULL THEN 'system' ELSE 'user' END)::public.actor_type,app.current_user_id(),
   jsonb_build_object('employmentIds',c.recalc_employment_ids,'addedEmploymentIds',ARRAY[wanted],
    'changeCategory',category,'from',from_day,'until',until_day)
  FROM changed c;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.workforce_payroll_inputs_changed(uuid,date,date,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.workforce_payroll_inputs_changed(uuid,date,date,text) TO ai_hr_app;
