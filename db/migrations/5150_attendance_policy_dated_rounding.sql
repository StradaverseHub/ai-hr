-- 2f803985 (Schedule Group Overtime Setting, round 2) — reserved block 5150–5159, draft numbering.
-- The approved order finalizes threshold, maximum and rounding LAST and separately for each calendar
-- date's portion of a split source. The duration proposal therefore carries one class row per
-- (day class, calendar date) with a calendarDate field. This replaces only the private invoker count
-- owner from 0590 so it accepts those rows: a part matches the row of its own date and its rounding
-- anchor is chosen among that date's allocations. Rows recorded before this (no calendarDate) keep the
-- original one-row-per-class reading; a mixture refuses. No table, grant, RLS or stored row changes.
CREATE OR REPLACE FUNCTION app.attendance_policy_part_payable_count(arg_part public.attendance_overtime_policy_part,arg_duration jsonb,arg_formulas jsonb)
 RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE class_row jsonb;declared jsonb;attribution jsonb;anchor jsonb;anchor_part jsonb;
 class_count integer;per_date boolean;physical integer;eligible integer;remainder integer;payable integer;chosen_sequence integer;direction text;plan_quantity jsonb;
BEGIN
 declared:=arg_duration->'parts'->arg_part.sequence;
 plan_quantity:=arg_part.duration_evidence->'planQuantity';
 IF plan_quantity IS NOT NULL THEN
  IF arg_duration->>'intervalBasis' IS DISTINCT FROM 'approvedPlan' OR arg_part.raw_minutes<>0 OR arg_part.allocated_payable_minutes<>0
   OR arg_part.source_intervals<>'[]'::jsonb OR arg_part.duration_evidence->'allocatedIntervals' IS DISTINCT FROM '[]'::jsonb
   OR plan_quantity->>'v' IS DISTINCT FROM '1'
   OR plan_quantity->'rawMinutes' IS DISTINCT FROM declared->'minutes'
   OR plan_quantity->'selectedMinutes' IS DISTINCT FROM declared->'allocatedPayableMinutes'
   OR plan_quantity->'sourceIntervals' IS DISTINCT FROM declared->'intervals'
   OR plan_quantity->'allocatedIntervals' IS DISTINCT FROM declared->'allocations'
   OR coalesce(plan_quantity->>'payableMinutes','')!~'^[0-9]{1,4}$'
   OR jsonb_typeof(plan_quantity->'roundingCountAttributions') IS DISTINCT FROM 'array'
   OR jsonb_array_length(plan_quantity->'roundingCountAttributions')>1 THEN
   RAISE EXCEPTION 'Approved-plan part requires its exact separate quantity coordinates' USING ERRCODE='23514';END IF;
  arg_part.raw_minutes:=(declared->>'minutes')::integer;arg_part.allocated_payable_minutes:=(declared->>'allocatedPayableMinutes')::integer;
  arg_part.source_intervals:=declared->'intervals';
  arg_part.duration_evidence:=jsonb_build_object('allocatedIntervals',declared->'allocations')||
   CASE WHEN jsonb_array_length(plan_quantity->'roundingCountAttributions')=1 THEN jsonb_build_object(
    'roundingCountAttributions',plan_quantity->'roundingCountAttributions','attributedPayableMinutes',plan_quantity->'payableMinutes') ELSE '{}'::jsonb END;
  IF (plan_quantity->>'payableMinutes')::integer<>arg_part.allocated_payable_minutes+coalesce((plan_quantity#>>'{roundingCountAttributions,0,minutes}')::integer,0) THEN
   RAISE EXCEPTION 'Approved-plan payable count changed' USING ERRCODE='23514';END IF;
 END IF;
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
 -- 2f803985: rows are either all per (day class, calendar date) or all per day class (recorded before).
 SELECT count(DISTINCT value?'calendarDate')=1 AND bool_and(value?'calendarDate') INTO per_date FROM jsonb_array_elements(arg_duration->'classes');
 IF per_date IS NULL OR (NOT per_date AND EXISTS(SELECT 1 FROM jsonb_array_elements(arg_duration->'classes') WHERE value?'calendarDate')) THEN
  RAISE EXCEPTION 'Complete rounded count class required' USING ERRCODE='23514';END IF;
 SELECT count(*),jsonb_agg(value)->0 INTO class_count,class_row FROM jsonb_array_elements(arg_duration->'classes')
  WHERE value->>'dayClass'=arg_part.day_class AND (NOT per_date OR value->>'calendarDate'=arg_part.calendar_date::text);
 IF class_count<>1 OR coalesce(class_row->>'unplacedPayableMinutes','')!~'^[0-9]{1,4}$'
  OR coalesce(class_row->>'payableMinutes','')!~'^[0-9]{1,4}$' OR coalesce(class_row->>'eligibleMinutes','')!~'^[0-9]{1,4}$' THEN
  RAISE EXCEPTION 'Complete rounded count class required' USING ERRCODE='23514';END IF;
 remainder:=(class_row->>'unplacedPayableMinutes')::integer;payable:=(class_row->>'payableMinutes')::integer;
 SELECT coalesce(sum((value->>'allocatedPayableMinutes')::integer),0),coalesce(sum((value->>'minutes')::integer),0) INTO physical,eligible
  FROM jsonb_array_elements(arg_duration->'parts') WHERE value->>'dayClass'=arg_part.day_class
   AND (NOT per_date OR value->>'date'=arg_part.calendar_date::text);
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
  WHERE p.value->>'dayClass'=arg_part.day_class AND (NOT per_date OR p.value->>'date'=arg_part.calendar_date::text)
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_policy_part_payable_count(public.attendance_overtime_policy_part,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
