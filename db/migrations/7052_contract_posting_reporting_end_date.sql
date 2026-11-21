-- Keep the private Contract replay date projection aligned with recorded reporting ends.
-- CREATE OR REPLACE retains the restricted owner and the prior EXECUTE privileges.
CREATE OR REPLACE FUNCTION app.contract_posting_projected_org_day(p_event jsonb,p_group jsonb) RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE payload jsonb;tag jsonb;event_kind text;kind text;occurrence date;comparison date;raw jsonb;item jsonb;key_name text;parsed date;dates date[]:=ARRAY[]::date[];
BEGIN
 IF jsonb_typeof(p_event) IS DISTINCT FROM 'object' OR jsonb_typeof(p_group) IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 BEGIN occurrence:=((p_event->>'occurred_at')::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;END;
 IF occurrence IS NULL OR NOT isfinite(occurrence) THEN RETURN NULL;END IF;
 payload:=p_event->'payload';tag:=payload->'movement';event_kind:=p_event->>'event_type';kind:=tag->>'type';
 IF jsonb_typeof(tag->'effectiveDate')='string' THEN comparison:=app.contract_posting_calendar_day(tag->>'effectiveDate');END IF;
 IF comparison IS NULL THEN
  IF jsonb_typeof(tag->'groupId')='string' AND tag->>'groupId'<>'' THEN
   FOR item IN SELECT value FROM jsonb_array_elements(p_group) LOOP
    IF item->'payload'->'movement'->'groupId' IS DISTINCT FROM tag->'groupId' THEN CONTINUE;END IF;
    key_name:=CASE item->>'event_type' WHEN 'compensation.set' THEN 'effectiveFrom' WHEN 'reporting-line.set' THEN 'validFrom'
     WHEN 'reporting-line.ended' THEN CASE WHEN item->'payload'->>'lineType'='administrative'
      AND jsonb_typeof(item->'payload'->'movement')='object' THEN 'validFrom' END
     WHEN 'assignment.transferred' THEN 'effectiveDate' WHEN 'employment.assignment.changed' THEN 'effectiveDate' WHEN 'employment.company.transferred' THEN 'effectiveDate' ELSE NULL END;
    IF key_name IS NULL OR (item->>'event_type'='reporting-line.set' AND item->'payload'->>'lineType'='delegate')
     OR jsonb_typeof(item->'payload'->key_name) IS DISTINCT FROM 'string' THEN CONTINUE;END IF;
    parsed:=app.contract_posting_calendar_day(item->'payload'->>key_name);
    IF parsed IS NOT NULL AND NOT parsed=ANY(dates) THEN dates:=array_append(dates,parsed);END IF;
   END LOOP;
  END IF;
  IF cardinality(dates)=1 THEN comparison:=dates[1];ELSE comparison:=occurrence;END IF;
 END IF;
 -- These are the immutable primary-row source fields from projectRows, not new date adjudication.
 CASE event_kind
 WHEN 'employment.info.updated' THEN
  CASE kind
  WHEN 'confirmation' THEN raw:=coalesce(nullif(payload->'after'->'confirmationDate','null'::jsonb),to_jsonb(occurrence::text));
  WHEN 'resignation' THEN raw:=coalesce(nullif(tag->'effectiveDate','null'::jsonb),nullif(payload->'after'->'tenderResignationDate','null'::jsonb),to_jsonb(occurrence::text));
  WHEN 'joinDateChange' THEN raw:=coalesce(nullif(payload->'after'->'joinDate','null'::jsonb),to_jsonb(occurrence::text));
  WHEN 'groupJoinDateCorrection' THEN raw:=coalesce(nullif(payload->'after'->'hiredOn','null'::jsonb),to_jsonb(occurrence::text));
  ELSE RETURN comparison;END CASE;
 WHEN 'employment.grade.changed' THEN RETURN comparison;
 WHEN 'compensation.set' THEN raw:=coalesce(nullif(tag->'effectiveDate','null'::jsonb),nullif(payload->'effectiveFrom','null'::jsonb),to_jsonb(occurrence::text));
 WHEN 'assignment.transferred','employment.company.transferred','employment.assignment.changed','employment.payment-method.changed','employment.movement.recorded','employment.movement.scheduled'
  THEN raw:=coalesce(nullif(payload->'effectiveDate','null'::jsonb),to_jsonb(occurrence::text));
 WHEN 'reporting-line.set' THEN
  IF payload->>'lineType'='delegate' THEN RETURN NULL;END IF;
  raw:=coalesce(nullif(payload->'validFrom','null'::jsonb),to_jsonb(occurrence::text));
 WHEN 'reporting-line.ended' THEN
  IF payload->>'lineType' IS DISTINCT FROM 'administrative' OR coalesce(kind,'')='' THEN RETURN NULL;END IF;
  raw:=coalesce(nullif(payload->'validFrom','null'::jsonb),to_jsonb(occurrence::text));
 WHEN 'employment.terminated' THEN raw:=coalesce(nullif(payload->'terminationDate','null'::jsonb),to_jsonb(occurrence::text));
 ELSE RETURN NULL;END CASE;
 IF jsonb_typeof(raw) IS DISTINCT FROM 'string' THEN RETURN NULL;END IF;
 RETURN app.contract_posting_calendar_day(raw#>>'{}');
END $$;
