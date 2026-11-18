-- INACTIVE SOURCE PROPOSAL. Not a migration, not registered, not applied.
-- Actual3acca failures: public Org reader denied the group-only canonical inverse;
-- literal restricted ai_hr_owner was denied by0698 snapshot INSERT RLS during protect.
-- No public grants, role substitution, new decision/money writer or general owner exception.
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.company_organisation_tags(uuid,date)'::regprocedure)<>'7f31153095c15f65fb2767f83424cf6c'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.employment_organisation_tags(uuid,date)'::regprocedure)<>'7737d5c28b4f27e37b8fc8d737483ac3'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.record_employment_organisation_tags(uuid,uuid,date,text)'::regprocedure)<>'10d8a6536f16220910fa24a4bc7d8a06'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.company_org_assignment_record()'::regprocedure)<>'bc1ed008d9cbf0fe8e869c9f769a8c99'
 THEN RAISE EXCEPTION 'Canonical Org owner source drift; review before factoring';END IF;
END $$;
--> statement-breakpoint
-- Passive before-row evidence from the actual native frame INSERT, never caller rows/hashes.
CREATE TABLE app.contract_posting_assignment_org_before(
 tenant_id uuid NOT NULL,job_id uuid NOT NULL,employment_id uuid NOT NULL,xact_id bigint NOT NULL,
 backend_pid integer NOT NULL,login_name text NOT NULL,source_hash bytea NOT NULL,
 rows jsonb NOT NULL,row_count integer NOT NULL CHECK(row_count>0),rows_hash bytea NOT NULL,
 PRIMARY KEY(tenant_id,job_id,xact_id,backend_pid,employment_id),
 FOREIGN KEY(tenant_id,xact_id,backend_pid,employment_id) REFERENCES app.contract_posting_job_tx(tenant_id,xact_id,backend_pid,employment_id) ON DELETE CASCADE
);
ALTER TABLE app.contract_posting_assignment_org_before ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_assignment_org_before FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_posting_assignment_org_before_owner ON app.contract_posting_assignment_org_before FOR ALL TO ai_hr_owner
 USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.contract_posting_assignment_org_before FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,DELETE ON app.contract_posting_assignment_org_before TO ai_hr_owner;
CREATE FUNCTION app.contract_posting_assignment_org_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE images jsonb;
BEGIN
 IF TG_RELID<>'app.contract_posting_job_tx'::regclass OR TG_NAME<>'contract_posting_assignment_org_capture' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.job_id::text IS DISTINCT FROM current_setting('app.bulk_job',true)
 OR NEW.xact_id<>txid_current() OR NEW.backend_pid<>pg_backend_pid() OR NEW.login_name<>session_user
 OR NEW.protected OR NEW.intent_hash IS NOT NULL OR NEW.preserved_count IS NOT NULL
 OR app.contract_posting_job_held(NEW.job_id) IS NOT TRUE OR app.contract_posting_original_source_intact(NEW.job_id,NEW.employment_id) IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.employment_id AND to_jsonb(e)=NEW.original_employment)
 THEN RAISE EXCEPTION 'Capture only actual untouched native Contract frame rows' USING ERRCODE='42501';END IF;
 -- One set-wise subject read. The native begin already holds the statutory/Employment lock family.
 SELECT jsonb_agg(to_jsonb(source) ORDER BY source.id) INTO images FROM
 (SELECT a.* FROM public.assignment a WHERE a.tenant_id=NEW.tenant_id AND a.employment_id=NEW.employment_id ORDER BY a.id FOR SHARE) source;
 IF images IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(images) image WHERE image=NEW.original_assignment)
 THEN RAISE EXCEPTION 'Complete actual Assignment before-row capture required' USING ERRCODE='42501';END IF;
 INSERT INTO app.contract_posting_assignment_org_before(tenant_id,job_id,employment_id,xact_id,backend_pid,login_name,source_hash,rows,row_count,rows_hash)
 VALUES(NEW.tenant_id,NEW.job_id,NEW.employment_id,NEW.xact_id,NEW.backend_pid,session_user,NEW.source_hash,images,jsonb_array_length(images),app.bulk_job_value_digest(images));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_assignment_org_capture() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_posting_assignment_org_capture AFTER INSERT ON app.contract_posting_job_tx FOR EACH ROW EXECUTE FUNCTION app.contract_posting_assignment_org_capture();
CREATE FUNCTION app.contract_posting_assignment_org_before_row(p_job uuid,p_employment uuid,p_assignment uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT image FROM app.contract_posting_assignment_org_before captured
 JOIN app.contract_posting_job_tx frame ON frame.tenant_id=captured.tenant_id AND frame.job_id=captured.job_id
 AND frame.employment_id=captured.employment_id AND frame.xact_id=captured.xact_id AND frame.backend_pid=captured.backend_pid AND frame.login_name=captured.login_name
 CROSS JOIN LATERAL jsonb_array_elements(captured.rows) image
 WHERE captured.tenant_id=app.current_tenant_id() AND captured.job_id=p_job AND captured.employment_id=p_employment
 AND captured.xact_id=txid_current() AND captured.backend_pid=pg_backend_pid() AND captured.login_name=session_user
 AND captured.source_hash=frame.source_hash AND captured.row_count=jsonb_array_length(captured.rows)
 AND captured.rows_hash=app.bulk_job_value_digest(captured.rows)
 AND image->>'id'=p_assignment::text AND image->>'tenant_id'=captured.tenant_id::text AND image->>'employment_id'=p_employment::text
 AND app.contract_posting_original_source_intact(p_job,p_employment)
$$;
REVOKE ALL ON FUNCTION app.contract_posting_assignment_org_before_row(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Org-only transform witness. This table grants no Assignment mutation authority.
CREATE TABLE app.contract_posting_assignment_org_permit(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,job_id uuid NOT NULL REFERENCES app.contract_posting_job_source(job_id),
 employment_id uuid NOT NULL,xact_id bigint NOT NULL,backend_pid integer NOT NULL,login_name text NOT NULL,source_hash bytea NOT NULL,
 source_assignment_id uuid NOT NULL,source_assignment jsonb NOT NULL,source_assignment_hash bytea NOT NULL,
 retained_assignment_id uuid,retained_assignment jsonb,retained_assignment_hash bytea,retained_before_hash bytea NOT NULL,original_events jsonb NOT NULL,original_events_hash bytea NOT NULL,
 candidate jsonb NOT NULL,candidate_hash bytea NOT NULL,company_id uuid NOT NULL,effective_on date NOT NULL,
 inserted_id uuid,inserted_hash bytea,
 UNIQUE(tenant_id,job_id,xact_id,backend_pid,employment_id)
);
ALTER TABLE app.contract_posting_assignment_org_permit ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_assignment_org_permit FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_posting_assignment_org_permit_owner ON app.contract_posting_assignment_org_permit FOR ALL TO ai_hr_owner
 USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.contract_posting_assignment_org_permit FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.contract_posting_assignment_org_permit TO ai_hr_owner;
CREATE FUNCTION app.contract_posting_assignment_org_normalized(p_row jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT to_jsonb(jsonb_populate_record(NULL::public.assignment,p_row))-ARRAY['id','created_at','recorded_at']
$$;
REVOKE ALL ON FUNCTION app.contract_posting_assignment_org_normalized(jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_posting_assignment_org_prepare(p_job uuid,p_employment uuid,p_source uuid,p_retained uuid,p_values jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frame app.contract_posting_job_tx;state app.contract_posting_replay_state;
 source_row public.assignment;retained_row public.assignment;candidate jsonb;old_image jsonb;before_image jsonb;events jsonb;allowed text[];
 key_name text;company_key uuid;day_key date;permit_key uuid;native_tags jsonb;
BEGIN
 IF p_retained IS NULL OR p_values IS NULL OR jsonb_typeof(p_values)<>'object'
 OR p_values ?| ARRAY['id','created_at','recorded_at','superseded_at']
 OR app.contract_posting_history_write_held(p_job,p_employment) IS NOT TRUE
 OR app.contract_posting_original_source_intact(p_job,p_employment) IS NOT TRUE
 THEN RAISE EXCEPTION 'Actual canonical Assignment transform required' USING ERRCODE='42501';END IF;
 SELECT x.* INTO frame FROM app.contract_posting_job_tx x WHERE x.tenant_id=app.current_tenant_id() AND x.job_id=p_job
 AND x.employment_id=p_employment AND x.xact_id=txid_current() AND x.backend_pid=pg_backend_pid() AND x.login_name=session_user AND x.protected;
 SELECT st.* INTO state FROM app.contract_posting_replay_state st WHERE st.tenant_id=frame.tenant_id AND st.job_id=p_job
 AND st.xact_id=frame.xact_id AND st.backend_pid=frame.backend_pid AND st.login_name=session_user AND st.source_hash=frame.source_hash;
 SELECT a.* INTO source_row FROM public.assignment a WHERE a.tenant_id=frame.tenant_id AND a.employment_id=p_employment AND a.id=p_source FOR UPDATE;
 IF frame.job_id IS NULL OR state.job_id IS NULL OR source_row.id IS NULL OR source_row.superseded_at IS NOT NULL
 THEN RAISE EXCEPTION 'Use the actual retained source Assignment' USING ERRCODE='42501';END IF;
 candidate:=app.contract_posting_assignment_org_normalized(p_values);old_image:=app.contract_posting_assignment_org_normalized(to_jsonb(source_row));
 day_key:=(candidate->>'valid_from')::date;company_key:=coalesce((candidate->>'company_id')::uuid,(SELECT e.company_id FROM public.employment e WHERE e.tenant_id=frame.tenant_id AND e.id=p_employment));
 IF candidate->>'tenant_id' IS DISTINCT FROM frame.tenant_id::text OR candidate->>'employment_id' IS DISTINCT FROM p_employment::text
 OR candidate->>'superseded_at' IS NOT NULL OR day_key IS NULL OR NOT isfinite(day_key) OR day_key>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR company_key IS NULL
 THEN RAISE EXCEPTION 'Use the exact normalized native Assignment subject/date' USING ERRCODE='42501';END IF;
 -- No Org effect exists when the unchanged native callback predicate is false. Do not constrain legacy DML.
 IF NOT EXISTS(SELECT 1 FROM public.company_organisation_run r WHERE r.tenant_id=frame.tenant_id AND r.state='published' AND r.kind<>'retag' AND r.effective_on<=day_key) THEN RETURN NULL;END IF;
  SELECT a.* INTO retained_row FROM public.assignment a WHERE a.tenant_id=frame.tenant_id AND a.employment_id=p_employment AND a.id=p_retained FOR SHARE;
  IF NOT state.target_open OR state.target_completed OR state.active_ordinal IS NOT NULL OR retained_row.id IS NULL
  OR retained_row.superseded_at IS NULL OR retained_row.valid_from IS DISTINCT FROM day_key
  OR day_key<=(SELECT (s.requested_values->>'effectiveDate')::date FROM app.contract_posting_job_source s WHERE s.job_id=p_job AND s.tenant_id=frame.tenant_id)
  OR source_row.valid_from>=day_key OR source_row.valid_to IS NOT NULL AND source_row.valid_to<=day_key
  THEN RAISE EXCEPTION 'Use only the actual lifted independent correction boundary' USING ERRCODE='42501';END IF;
  before_image:=app.contract_posting_assignment_org_before_row(p_job,p_employment,p_retained);
  IF before_image IS NULL OR before_image->>'superseded_at' IS NOT NULL
   OR before_image-ARRAY['valid_to','superseded_at'] IS DISTINCT FROM to_jsonb(retained_row)-ARRAY['valid_to','superseded_at']
   OR (before_image->>'valid_to' IS NOT NULL AND (before_image->>'valid_to')::date<=(before_image->>'valid_from')::date)
  THEN RAISE EXCEPTION 'Use the actual live retained Assignment sealed before job mutations' USING ERRCODE='42501';END IF;
  -- The unchanged canonical planner chooses the boundary. Native proof pins its actual before-row,
  -- real correction date/fields and exact normalized transform; no missing audit ID edge is invented.
  SELECT jsonb_agg(to_jsonb(d) ORDER BY d.sequence) INTO events FROM public.domain_event d
   WHERE d.tenant_id=frame.tenant_id AND d.subject_employment_id=p_employment AND d.sequence<=frame.ledger_max_sequence
    AND d.event_type='employment.information.corrected' AND d.payload->>'effectiveOn'=day_key::text;
  SELECT array_agg(DISTINCT column_name) INTO allowed FROM jsonb_array_elements(coalesce(events,'[]'::jsonb)) proof
  CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(proof->'payload'->'fields','[]'::jsonb)) field_name
  JOIN (VALUES('companyId','company_id'),('employmentType','employment_type'),('businessUnitId','business_unit_id'),('departmentId','department_id'),('positionId','position_id'),('costCenterId','cost_center_id'),('locationId','location_id')) names(field_name,column_name) ON names.field_name=field_name.value;
  IF events IS NULL OR allowed IS NULL THEN RAISE EXCEPTION 'Original retained correction evidence is unavailable' USING ERRCODE='42501';END IF;
  FOR key_name IN SELECT jsonb_object_keys(candidate) LOOP
   IF key_name IN('valid_from','business_unit_id') OR candidate->key_name IS NOT DISTINCT FROM old_image->key_name THEN CONTINUE;END IF;
   IF NOT key_name=ANY(allowed) OR candidate->key_name IS DISTINCT FROM to_jsonb(retained_row)->key_name
   THEN RAISE EXCEPTION 'Only actual retained correction fields may cross this Org witness' USING ERRCODE='42501';END IF;
  END LOOP;
 IF events IS NULL THEN RAISE EXCEPTION 'Immutable original transform event required' USING ERRCODE='42501';END IF;
 -- The canonical Assignment BEFORE owner derives BU. Invoke the same mapping owner, not a copied mapping calculation.
 native_tags:=app.company_org_tags_unchecked(company_key,day_key);
 IF native_tags->>'status'<>'legacy' THEN
  -- The real Assignment BEFORE trigger overwrites this derived field from this same native owner.
  -- Never accept a caller-authored BU delta as an independently corrected placement fact.
  candidate:=jsonb_set(candidate,'{business_unit_id}',coalesce(native_tags->'businessUnitId','null'::jsonb));
 ELSIF candidate->'business_unit_id' IS DISTINCT FROM old_image->'business_unit_id' THEN
  IF NOT 'business_unit_id'=ANY(allowed) OR candidate->'business_unit_id' IS DISTINCT FROM to_jsonb(retained_row)->'business_unit_id'
  THEN RAISE EXCEPTION 'Use only the actual retained legacy Business Unit correction' USING ERRCODE='42501';END IF;
 END IF;
 INSERT INTO app.contract_posting_assignment_org_permit(tenant_id,job_id,employment_id,xact_id,backend_pid,login_name,source_hash,
  source_assignment_id,source_assignment,source_assignment_hash,retained_assignment_id,retained_assignment,retained_assignment_hash,retained_before_hash,original_events,original_events_hash,candidate,candidate_hash,company_id,effective_on)
 VALUES(frame.tenant_id,p_job,p_employment,frame.xact_id,frame.backend_pid,session_user,frame.source_hash,
  source_row.id,to_jsonb(source_row),app.bulk_job_value_digest(to_jsonb(source_row)),retained_row.id,to_jsonb(retained_row),app.bulk_job_value_digest(to_jsonb(retained_row)),app.bulk_job_value_digest(before_image),events,app.bulk_job_value_digest(events),candidate,app.bulk_job_value_digest(candidate),company_key,day_key)
 RETURNING id INTO permit_key;
 RETURN permit_key;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_assignment_org_prepare(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_posting_assignment_org_consumed_company(p_job uuid,p_employment uuid,p_day date) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT permit.company_id FROM app.contract_posting_assignment_org_permit permit JOIN public.assignment actual ON actual.tenant_id=permit.tenant_id AND actual.id=permit.inserted_id AND actual.employment_id=permit.employment_id
 WHERE permit.tenant_id=app.current_tenant_id() AND permit.job_id=p_job AND permit.employment_id=p_employment AND permit.effective_on=p_day
 AND permit.xact_id=txid_current() AND permit.backend_pid=pg_backend_pid() AND permit.login_name=session_user
 AND permit.inserted_hash=app.bulk_job_value_digest(to_jsonb(actual))
 AND app.contract_posting_history_write_held(p_job,p_employment) AND app.contract_posting_original_source_intact(p_job,p_employment)
$$;
REVOKE ALL ON FUNCTION app.contract_posting_assignment_org_consumed_company(uuid,uuid,date) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_posting_assignment_org_finish(p_permit uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE permit app.contract_posting_assignment_org_permit;
BEGIN
 SELECT p.* INTO permit FROM app.contract_posting_assignment_org_permit p WHERE p.id=p_permit AND p.tenant_id=app.current_tenant_id()
 AND p.job_id::text=current_setting('app.bulk_job',true) AND p.xact_id=txid_current() AND p.backend_pid=pg_backend_pid() AND p.login_name=session_user FOR UPDATE;
 IF permit.id IS NULL OR app.contract_posting_assignment_org_consumed_company(permit.job_id,permit.employment_id,permit.effective_on) IS DISTINCT FROM permit.company_id
 THEN RAISE EXCEPTION 'Actual native Assignment Org callback required' USING ERRCODE='42501';END IF;
 DELETE FROM app.contract_posting_assignment_org_permit p WHERE p.id=permit.id;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_assignment_org_finish(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.contract_posting_group_hash(uuid,uuid)'::regprocedure)<>'03912f3a421ca78cc63bb8aecf4789c5' THEN RAISE EXCEPTION 'Immutable native date-group source drift; review the canonical projection';END IF;
END $$;
--> statement-breakpoint
-- Read-only equivalent of the single native projectRows/date owner. The source guard test pins
-- its actual TS date-selection/calendar/clock fragments; all effect admission stays in the bound wrapper.
CREATE FUNCTION app.contract_posting_calendar_day(p_value text) RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parsed date;
BEGIN
 IF p_value IS NULL OR p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR left(p_value,4)='0000' THEN RETURN NULL;END IF;
 BEGIN parsed:=p_value::date;EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;END;
 IF NOT isfinite(parsed) OR to_char(parsed,'YYYY-MM-DD') IS DISTINCT FROM p_value THEN RETURN NULL;END IF;
 RETURN parsed;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_calendar_day(text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_posting_projected_org_day(p_event jsonb,p_group jsonb) RETURNS date
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
 WHEN 'employment.terminated' THEN raw:=coalesce(nullif(payload->'terminationDate','null'::jsonb),to_jsonb(occurrence::text));
 ELSE RETURN NULL;END CASE;
 IF jsonb_typeof(raw) IS DISTINCT FROM 'string' THEN RETURN NULL;END IF;
 RETURN app.contract_posting_calendar_day(raw#>>'{}');
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_projected_org_day(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_posting_recorded_org_day(p_job uuid,p_event uuid) RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frame app.contract_posting_job_tx;state app.contract_posting_replay_state;step app.contract_posting_replay_step;root public.domain_event;original_group jsonb;
BEGIN
 SELECT x.* INTO frame FROM app.contract_posting_job_tx x WHERE x.tenant_id=app.current_tenant_id() AND x.job_id=p_job
 AND x.xact_id=txid_current() AND x.backend_pid=pg_backend_pid() AND x.login_name=session_user AND x.protected;
 SELECT st.* INTO state FROM app.contract_posting_replay_state st WHERE st.tenant_id=frame.tenant_id AND st.job_id=p_job AND st.xact_id=frame.xact_id AND st.backend_pid=frame.backend_pid AND st.login_name=frame.login_name;
 SELECT sp.* INTO step FROM app.contract_posting_replay_step sp WHERE sp.tenant_id=state.tenant_id AND sp.job_id=p_job AND sp.xact_id=state.xact_id AND sp.backend_pid=state.backend_pid AND sp.ordinal=state.active_ordinal;
 SELECT d.* INTO root FROM public.domain_event d WHERE d.tenant_id=frame.tenant_id AND d.subject_employment_id=frame.employment_id AND d.id=p_event AND d.sequence<=frame.ledger_max_sequence;
 IF frame.job_id IS NULL OR state.job_id IS NULL OR state.target_open OR state.source_hash IS DISTINCT FROM frame.source_hash
 OR step.ordinal IS NULL OR step.completed OR step.event_id IS DISTINCT FROM p_event OR root.id IS NULL
 OR root.payload->'movement'->'secondary'='true'::jsonb OR step.group_hash IS DISTINCT FROM app.contract_posting_group_hash(p_job,p_event)
 OR app.contract_posting_history_write_held(p_job,frame.employment_id) IS NOT TRUE OR app.contract_posting_original_source_intact(p_job,frame.employment_id) IS NOT TRUE
 THEN RAISE EXCEPTION 'Use only the actual immutable active recorded date source' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.sequence),'[]'::jsonb) INTO original_group FROM public.domain_event d
 WHERE d.tenant_id=frame.tenant_id AND d.subject_employment_id=frame.employment_id AND d.sequence<=frame.ledger_max_sequence
 AND (d.id=root.id OR root.payload->'movement'->>'groupId' IS NOT NULL AND d.payload->'movement'->>'groupId'=root.payload->'movement'->>'groupId');
 RETURN app.contract_posting_projected_org_day(to_jsonb(root),original_group);
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_recorded_org_day(uuid,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.contract_posting_org_scope(p_job uuid,p_employment uuid,p_day date,p_trigger text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source app.contract_posting_job_source;frame app.contract_posting_job_tx;state app.contract_posting_replay_state;
 step app.contract_posting_replay_step;root public.domain_event;effective date;company uuid;recorded_kind text;
BEGIN
 IF p_day IS NULL OR NOT isfinite(p_day)
 OR p_trigger IS NOT NULL AND p_trigger NOT IN('movement','assignment')
 OR app.contract_posting_history_write_held(p_job,p_employment) IS NOT TRUE
 OR app.contract_posting_original_source_intact(p_job,p_employment) IS NOT TRUE
 THEN RAISE EXCEPTION 'Exact recorded Contract organisation scope required' USING ERRCODE='42501';END IF;
 IF p_trigger='assignment' THEN
  IF p_day>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'No early future Assignment classification' USING ERRCODE='42501';END IF;
  company:=app.contract_posting_assignment_org_consumed_company(p_job,p_employment,p_day);
  IF company IS NOT NULL THEN RETURN company;END IF;
 END IF;
 SELECT source_row.* INTO source FROM app.contract_posting_job_source source_row
 WHERE source_row.tenant_id=app.current_tenant_id() AND source_row.job_id=p_job AND source_row.employment_id=p_employment;
 SELECT frame_row.* INTO frame FROM app.contract_posting_job_tx frame_row WHERE frame_row.tenant_id=source.tenant_id
 AND frame_row.job_id=p_job AND frame_row.employment_id=p_employment AND frame_row.xact_id=txid_current()
 AND frame_row.backend_pid=pg_backend_pid() AND frame_row.login_name=session_user AND frame_row.protected;
 SELECT state_row.* INTO state FROM app.contract_posting_replay_state state_row WHERE state_row.tenant_id=source.tenant_id
 AND state_row.job_id=p_job AND state_row.employment_id=p_employment AND state_row.xact_id=frame.xact_id
 AND state_row.backend_pid=frame.backend_pid AND state_row.login_name=session_user;
 IF frame.job_id IS NULL OR state.job_id IS NULL OR state.source_hash IS DISTINCT FROM frame.source_hash
 THEN RAISE EXCEPTION 'Protected native organisation frame unavailable' USING ERRCODE='42501';END IF;
 IF state.active_ordinal IS NOT NULL THEN
  SELECT step_row.* INTO step FROM app.contract_posting_replay_step step_row WHERE step_row.tenant_id=state.tenant_id
  AND step_row.job_id=p_job AND step_row.xact_id=state.xact_id AND step_row.backend_pid=state.backend_pid AND step_row.ordinal=state.active_ordinal;
  SELECT event_row.* INTO root FROM public.domain_event event_row WHERE event_row.tenant_id=state.tenant_id
  AND event_row.id=step.event_id AND event_row.subject_employment_id=p_employment AND event_row.sequence<=frame.ledger_max_sequence;
  IF state.target_open OR step.ordinal IS NULL OR step.completed OR root.id IS NULL
  OR step.direction NOT IN('inverse','replay') OR step.group_hash IS DISTINCT FROM app.contract_posting_group_hash(p_job,step.event_id)
  THEN RAISE EXCEPTION 'Immutable recorded organisation leg unavailable' USING ERRCODE='42501';END IF;
  recorded_kind:=root.payload->'movement'->>'type';
  effective:=app.contract_posting_recorded_org_day(p_job,root.id);
  company:=CASE step.direction WHEN 'inverse' THEN step.company_before ELSE step.company_after END;
  IF p_day IS DISTINCT FROM effective THEN
   RAISE EXCEPTION 'Use the exact recorded movement date' USING ERRCODE='42501';
  END IF;
  IF p_day>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN
   -- Existing date-only commands apply their master fact immediately even at a future Effective Date.
   -- Only that already-applied immutable leg may be read/retagged during its real paired replay.
   IF p_trigger IS NOT NULL AND p_trigger<>'movement' OR root.event_type<>'employment.info.updated'
    OR recorded_kind IS NULL OR recorded_kind NOT IN('joinDateChange','probationExtension')
    OR root.payload->'movement'->'secondary'='true'::jsonb
    OR jsonb_typeof(root.payload->'fields') IS DISTINCT FROM 'array'
    OR jsonb_typeof(root.payload->'before') IS DISTINCT FROM 'object' OR jsonb_typeof(root.payload->'after') IS DISTINCT FROM 'object'
   THEN RAISE EXCEPTION 'Use only the exact already-applied date-only replay leg' USING ERRCODE='42501';END IF;
   IF recorded_kind='joinDateChange' THEN
    IF (root.payload->'fields' ? 'joinDate') IS NOT TRUE
     OR (root.payload->'before' ? 'joinDate') IS NOT TRUE OR (root.payload->'after' ? 'joinDate') IS NOT TRUE
     OR jsonb_typeof(root.payload->'after'->'joinDate') IS DISTINCT FROM 'string'
     OR root.payload->'before'->'joinDate' IS NOT DISTINCT FROM root.payload->'after'->'joinDate'
    THEN RAISE EXCEPTION 'Actual recorded Join Date change required' USING ERRCODE='42501';END IF;
   ELSE
    IF (root.payload->'fields' ? 'extendedConfirmationDate') IS NOT TRUE
     OR (root.payload->'before' ? 'extendedConfirmationDate') IS NOT TRUE OR (root.payload->'after' ? 'extendedConfirmationDate') IS NOT TRUE
     OR jsonb_typeof(root.payload->'after'->'extendedConfirmationDate') IS DISTINCT FROM 'string'
     OR coalesce(root.payload->'after'->>'extendedConfirmationDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR root.payload->'before'->'extendedConfirmationDate' IS NOT DISTINCT FROM root.payload->'after'->'extendedConfirmationDate'
    THEN RAISE EXCEPTION 'Actual recorded Probation Extension required' USING ERRCODE='42501';END IF;
    BEGIN
     IF NOT isfinite((root.payload->'after'->>'extendedConfirmationDate')::date) THEN RAISE EXCEPTION 'Finite recorded extension date required' USING ERRCODE='42501';END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
     RAISE EXCEPTION 'Valid recorded extension calendar date required' USING ERRCODE='42501';
    END;
   END IF;
  END IF;
 ELSIF state.target_open AND NOT state.target_completed THEN
  effective:=(source.requested_values->>'effectiveDate')::date;company:=source.company_id;
  IF p_day IS DISTINCT FROM effective OR p_day>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  THEN RAISE EXCEPTION 'Use only the signed Contract target organisation date' USING ERRCODE='42501';END IF;
 ELSE RAISE EXCEPTION 'No active canonical organisation leg' USING ERRCODE='42501';END IF;
 IF company IS NULL OR NOT EXISTS(SELECT 1 FROM public.company actual_company
  WHERE actual_company.tenant_id=source.tenant_id AND actual_company.id=company)
 THEN RAISE EXCEPTION 'Recorded legal-company endpoint unavailable' USING ERRCODE='42501';END IF;
 RETURN company;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_org_scope(uuid,uuid,date,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_posting_company_org_tags(p_job uuid,p_employment uuid,p_company uuid,p_day date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.contract_posting_org_scope(p_job,p_employment,p_day) IS DISTINCT FROM p_company
 THEN RAISE EXCEPTION 'Use the actual recorded organisation company' USING ERRCODE='42501';END IF;
 RETURN app.company_org_tags_unchecked(p_company,p_day);
END $$;
CREATE FUNCTION app.contract_posting_employment_org_tags(p_job uuid,p_employment uuid,p_day date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE company uuid;
BEGIN
 company:=app.contract_posting_org_scope(p_job,p_employment,p_day);
 IF app.company_org_employment_company(p_employment,p_day) IS DISTINCT FROM company
 THEN RAISE EXCEPTION 'Actual dated organisation company changed' USING ERRCODE='42501';END IF;
 RETURN app.company_org_employment_unchecked(p_employment,p_day);
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_company_org_tags(uuid,uuid,uuid,date),
 app.contract_posting_employment_org_tags(uuid,uuid,date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- ONE canonical classification/audit writer. Public Maintain admission stays in the same-OID wrapper.
-- The private extra argument adds only the existing bulk-job audit envelope after exact native proof.
CREATE FUNCTION app.record_employment_organisation_tags_owner(p_employment uuid,p_company uuid,p_day date,p_trigger text,p_source_job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_tags jsonb;previous jsonb;k text;new_id uuid;v_actor_kind text;detail jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF p_day IS NULL OR NOT isfinite(p_day) OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id())
 OR p_company IS DISTINCT FROM app.company_org_employment_company(p_employment,p_day)
 OR p_trigger NOT IN('hire','correction','transfer','restructure','import','retag','assignment','movement')
 THEN RAISE EXCEPTION 'Organisation write scope is unavailable' USING ERRCODE='42501';END IF;
 IF p_source_job IS NULL AND (NOT(app.principal_snapshot_current() OR app.access_workforce_owner_company(p_company))
  OR NOT app.access_workforce_employment(p_employment,'workforce.maintain'))
 THEN RAISE EXCEPTION 'Organisation write scope is unavailable' USING ERRCODE='42501';END IF;
 IF p_source_job IS NOT NULL AND p_trigger IS NULL THEN RAISE EXCEPTION 'Exact recorded organisation trigger required' USING ERRCODE='42501';END IF;
 IF p_source_job IS NOT NULL AND app.contract_posting_org_scope(p_source_job,p_employment,p_day,p_trigger) IS DISTINCT FROM p_company
 THEN RAISE EXCEPTION 'Exact Contract classification source required' USING ERRCODE='42501';END IF;
 v_actor_kind:=CASE WHEN app.current_user_id() IS NULL THEN 'system' ELSE 'user' END;
 v_tags:=app.company_org_tags_unchecked(p_company,p_day);IF v_tags->>'status'='legacy' THEN RETURN v_tags;END IF;
 SELECT c.tags INTO previous FROM employment_organisation_classification c WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=p_employment AND c.effective_on<=p_day ORDER BY c.effective_on DESC,c.created_at DESC,c.id DESC LIMIT 1;
 IF EXISTS(SELECT 1 FROM employment_organisation_classification c WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=p_employment AND c.company_id=p_company AND c.effective_on=p_day AND c.tags=v_tags) THEN RETURN v_tags;END IF;
 k:=encode(sha256(convert_to(jsonb_build_array(p_employment,p_company,p_day,p_trigger,v_tags)::text,'UTF8')),'hex');
 INSERT INTO employment_organisation_classification(tenant_id,employment_id,company_id,effective_on,mapping_version_id,tags,trigger,actor_kind,actor_id,idempotency_key) VALUES(app.current_tenant_id(),p_employment,p_company,p_day,(v_tags->>'mappingVersionId')::uuid,v_tags,p_trigger,v_actor_kind,app.current_user_id(),k) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id INTO new_id;
 IF new_id IS NOT NULL THEN
  detail:=jsonb_build_object('companyId',p_company,'before',previous,'after',v_tags,'effectiveOn',p_day,'trigger',p_trigger,'mappingVersionId',v_tags->'mappingVersionId');
  IF p_source_job IS NOT NULL THEN detail:=detail||jsonb_build_object('bulkJob',jsonb_build_object('id',p_source_job,'kind','contract_posting_apply'));END IF;
  PERFORM app.company_org_append_event(app.current_tenant_id(),'employment',p_employment,'employment.organisation-tagged',v_actor_kind,app.current_user_id(),p_employment,detail);
 END IF;
 RETURN v_tags;
END $$;
REVOKE ALL ON FUNCTION app.record_employment_organisation_tags_owner(uuid,uuid,date,text,uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.record_employment_organisation_tags(p_employment uuid,p_company uuid,p_day date,p_trigger text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF p_day IS NULL OR NOT isfinite(p_day) OR NOT(app.principal_snapshot_current() OR app.access_workforce_owner_company(p_company)) OR NOT app.access_workforce_employment(p_employment,'workforce.maintain') OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()) OR p_company IS DISTINCT FROM app.company_org_employment_company(p_employment,p_day) OR p_trigger NOT IN('hire','correction','transfer','restructure','import','retag','assignment','movement') THEN RAISE EXCEPTION 'Organisation write scope is unavailable' USING ERRCODE='42501';END IF;
 RETURN app.record_employment_organisation_tags_owner(p_employment,p_company,p_day,p_trigger,NULL);
END $$;
-- CREATE OR REPLACE preserves existing app EXECUTE; its public admission is byte-identical.
CREATE FUNCTION app.contract_posting_record_org_tags(p_job uuid,p_employment uuid,p_company uuid,p_day date,p_trigger text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_trigger IS NULL OR app.contract_posting_org_scope(p_job,p_employment,p_day,p_trigger) IS DISTINCT FROM p_company
 THEN RAISE EXCEPTION 'Actual recorded classification scope required' USING ERRCODE='42501';END IF;
 RETURN app.record_employment_organisation_tags_owner(p_employment,p_company,p_day,p_trigger,p_job);
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_record_org_tags(uuid,uuid,uuid,date,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.company_org_assignment_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_company uuid;frame app.contract_posting_job_tx;permit app.contract_posting_assignment_org_permit;source_row public.assignment;retained_row public.assignment;actual_events jsonb;
BEGIN
 IF TG_RELID<>'public.assignment'::regclass OR TG_NAME<>'organisation_assignment_record' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE')
 THEN RAISE EXCEPTION 'Use only the real native Assignment callback' USING ERRCODE='42501';END IF;
 v_company:=coalesce(NEW.company_id,(SELECT company_id FROM employment WHERE id=NEW.employment_id AND tenant_id=NEW.tenant_id));
 IF NEW.tenant_id=app.current_tenant_id() AND (app.current_user_id() IS NOT NULL OR app.access_workforce_owner_company(v_company)) AND NEW.superseded_at IS NULL AND (NEW.valid_to IS NULL OR NEW.valid_to>NEW.valid_from) AND EXISTS(SELECT 1 FROM company_organisation_run WHERE tenant_id=NEW.tenant_id AND state='published' AND kind<>'retag' AND effective_on<=NEW.valid_from) THEN
  SELECT x.* INTO frame FROM app.contract_posting_job_tx x WHERE x.tenant_id=NEW.tenant_id AND x.employment_id=NEW.employment_id
   AND x.job_id::text=current_setting('app.bulk_job',true) AND x.xact_id=txid_current() AND x.backend_pid=pg_backend_pid() AND x.login_name=session_user AND x.protected;
  IF frame.job_id IS NOT NULL AND app.contract_posting_history_write_held(frame.job_id,NEW.employment_id) AND app.contract_posting_original_source_intact(frame.job_id,NEW.employment_id) THEN
   IF NOT EXISTS(SELECT 1 FROM public.assignment actual WHERE actual.id=NEW.id AND actual.tenant_id=NEW.tenant_id AND to_jsonb(actual)=to_jsonb(NEW))
   THEN RAISE EXCEPTION 'Use the actual persisted native Assignment image' USING ERRCODE='42501';END IF;
   SELECT p.* INTO permit FROM app.contract_posting_assignment_org_permit p WHERE p.tenant_id=frame.tenant_id AND p.job_id=frame.job_id
    AND p.employment_id=NEW.employment_id AND p.xact_id=frame.xact_id AND p.backend_pid=frame.backend_pid AND p.login_name=session_user FOR UPDATE;
   IF permit.id IS NOT NULL THEN
    SELECT a.* INTO source_row FROM public.assignment a WHERE a.id=permit.source_assignment_id AND a.tenant_id=permit.tenant_id AND a.employment_id=permit.employment_id;
    SELECT a.* INTO retained_row FROM public.assignment a WHERE a.id=permit.retained_assignment_id AND a.tenant_id=permit.tenant_id AND a.employment_id=permit.employment_id;
    SELECT jsonb_agg(to_jsonb(d) ORDER BY d.sequence) INTO actual_events FROM public.domain_event d
     WHERE d.tenant_id=permit.tenant_id AND d.subject_employment_id=permit.employment_id AND d.sequence<=frame.ledger_max_sequence
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(permit.original_events) proof WHERE proof->>'id'=d.id::text);
    IF TG_OP<>'INSERT' OR permit.inserted_id IS NOT NULL OR permit.source_hash IS DISTINCT FROM frame.source_hash
     OR permit.source_assignment_hash IS DISTINCT FROM app.bulk_job_value_digest(permit.source_assignment)
     OR permit.original_events_hash IS DISTINCT FROM app.bulk_job_value_digest(actual_events)
     OR permit.company_id IS DISTINCT FROM v_company OR permit.effective_on IS DISTINCT FROM NEW.valid_from
     OR permit.candidate_hash IS DISTINCT FROM app.bulk_job_value_digest(app.contract_posting_assignment_org_normalized(to_jsonb(NEW)))
     OR source_row.id IS NULL
    THEN RAISE EXCEPTION 'Exact retained Assignment transform witness required' USING ERRCODE='42501';END IF;
    IF source_row.valid_to IS DISTINCT FROM NEW.valid_from OR to_jsonb(source_row)-'valid_to' IS DISTINCT FROM permit.source_assignment-'valid_to'
     OR retained_row.id IS NULL OR app.bulk_job_value_digest(to_jsonb(retained_row)) IS DISTINCT FROM permit.retained_assignment_hash
     OR permit.retained_before_hash IS DISTINCT FROM app.bulk_job_value_digest(app.contract_posting_assignment_org_before_row(permit.job_id,permit.employment_id,permit.retained_assignment_id))
    THEN RAISE EXCEPTION 'The canonical retained boundary and cover must be unchanged' USING ERRCODE='42501';END IF;
    UPDATE app.contract_posting_assignment_org_permit p SET inserted_id=NEW.id,inserted_hash=app.bulk_job_value_digest(to_jsonb(NEW)) WHERE p.id=permit.id;
   END IF;
   -- With no retained-transform permit, the strict existing movement/target date+company gate still applies.
   PERFORM app.record_employment_organisation_tags_owner(NEW.employment_id,v_company,NEW.valid_from,'assignment',frame.job_id);
  ELSE
   PERFORM app.record_employment_organisation_tags(NEW.employment_id,v_company,NEW.valid_from,'assignment');
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- Same OID and private ACL; no app/PUBLIC EXECUTE is introduced.

--> statement-breakpoint
--> statement-breakpoint
-- Exact canonical historical rows, not flat current-employment approximations.
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.preserve_payroll_metadata_owner(uuid,boolean,boolean)'::regprocedure)<>'8d966d3a8376dc89404208e1cd728064'
 OR (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.information_payslip_snapshot'::regclass AND attnum>0 AND NOT attisdropped)
  IS DISTINCT FROM ARRAY['payslip_id','tenant_id','employment_id','company_id','grade','employment_type','hired_on','join_date','document_metadata','recorded_by','created_at']::text[]
 THEN RAISE EXCEPTION 'Canonical snapshot reconstruction/row shape drift; review before factoring';END IF;
END $$;
CREATE TABLE app.contract_posting_snapshot_permit(
 tenant_id uuid NOT NULL,job_id uuid NOT NULL REFERENCES app.contract_posting_job_source(job_id),xact_id bigint NOT NULL,
 backend_pid integer NOT NULL,login_name text NOT NULL,employment_id uuid NOT NULL,payslip_id uuid NOT NULL,row_hash bytea NOT NULL,
 PRIMARY KEY(tenant_id,job_id,xact_id,backend_pid,payslip_id)
);
ALTER TABLE app.contract_posting_snapshot_permit ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_snapshot_permit FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_posting_snapshot_permit_owner ON app.contract_posting_snapshot_permit FOR ALL TO ai_hr_owner
 USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.contract_posting_snapshot_permit FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,DELETE ON app.contract_posting_snapshot_permit TO ai_hr_owner;
CREATE FUNCTION app.contract_posting_snapshot_identity_allowed(p_tenant uuid,p_employment uuid,p_payslip uuid,p_company uuid,p_recorded_by uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p_tenant=app.current_tenant_id() AND p_recorded_by=app.current_user_id() AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM app.contract_posting_job_tx frame
  JOIN app.contract_posting_job_source source ON source.tenant_id=frame.tenant_id AND source.job_id=frame.job_id
  JOIN public.employment employee ON employee.tenant_id=source.tenant_id AND employee.id=source.employment_id
  JOIN public.personnel_posting posting ON posting.tenant_id=source.tenant_id AND posting.id=source.posting_id
  JOIN public.payslip slip ON slip.tenant_id=source.tenant_id AND slip.id=p_payslip AND slip.employment_id=source.employment_id
  JOIN public.payroll_batch batch ON batch.tenant_id=slip.tenant_id AND batch.id=slip.batch_id AND batch.company_id=p_company
  WHERE frame.tenant_id=p_tenant AND frame.employment_id=p_employment AND source.employment_id=p_employment
  AND frame.job_id::text=current_setting('app.bulk_job',true) AND frame.xact_id=txid_current()
  AND frame.backend_pid=pg_backend_pid() AND frame.login_name=session_user AND NOT frame.protected
  AND frame.actor_user_id=p_recorded_by AND frame.actor_person_id=app.contract_actor_person(p_recorded_by)
  AND source.requester_user_id=frame.actor_user_id AND source.requester_person_id=frame.actor_person_id
  AND employee.person_id=source.subject_person_id AND employee.company_id=source.company_id
  AND to_jsonb(employee)=frame.original_employment AND EXISTS(SELECT 1 FROM public.assignment original_assignment
   WHERE original_assignment.tenant_id=employee.tenant_id AND original_assignment.employment_id=employee.id
   AND original_assignment.valid_to IS NULL AND original_assignment.superseded_at IS NULL AND to_jsonb(original_assignment)=frame.original_assignment)
  AND posting.status='approved' AND posting.approved_by=p_recorded_by AND posting.revision=source.posting_revision+1
  AND app.bulk_job_value_digest(posting.applied)=source.values_hash
  AND app.contract_posting_original_source_intact(frame.job_id,p_employment)
  AND app.payroll_history_row_visible('payslip',slip.id)
  AND NOT EXISTS(SELECT 1 FROM app.contract_posting_replay_state replay WHERE replay.tenant_id=frame.tenant_id
   AND replay.job_id=frame.job_id AND replay.xact_id=frame.xact_id AND replay.backend_pid=frame.backend_pid)
 ),false)
$$;
REVOKE ALL ON FUNCTION app.contract_posting_snapshot_identity_allowed(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.preserve_payroll_metadata_owner(p_employment uuid,p_closed_only boolean,p_contract boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $owner$
DECLARE e public.employment%ROWTYPE; a public.assignment%ROWTYPE; n integer; assignment_count integer;snapshot_rows jsonb;frame app.contract_posting_job_tx;
BEGIN
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;

 -- An ended employment legitimately has no open assignment. Two open records is a data fault, not payroll history.
 SELECT count(*) INTO assignment_count FROM public.assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND valid_to IS NULL AND superseded_at IS NULL;
 IF assignment_count>1 OR (assignment_count=0 AND e.terminated_on IS NULL) THEN
  RAISE EXCEPTION 'Historical assignment evidence requires reconciliation';
 END IF;
 SELECT * INTO a FROM public.assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND valid_to IS NULL AND superseded_at IS NULL;
 IF EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
 WHERE app.payroll_history_row_visible('payslip',p.id) AND p.employment_id=e.id AND (NOT p_closed_only OR b.status='closed') AND (p.tenant_id<>e.tenant_id OR b.tenant_id<>e.tenant_id OR NOT (CASE WHEN p_contract THEN true ELSE app.is_admin_for(b.company_id) END))) THEN
  RAISE EXCEPTION 'Historical payroll company permission is required' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(canonical_row)),'[]'::jsonb) INTO snapshot_rows FROM (
 SELECT s.id AS payslip_id,e.tenant_id,e.id AS employment_id,s.company_id,
  CASE WHEN gr.found THEN hg.name ELSE g.name END AS grade,
  coalesce(ha.employment_type::text,a.employment_type::text) AS employment_type,
  CASE WHEN ho.found THEN ho.value::date ELSE e.hired_on END AS hired_on,
  CASE WHEN jo.found THEN jo.value::date ELSE e.join_date END AS join_date,
  app.information_document_metadata(s.id)
   ||CASE WHEN ha.id IS NOT NULL THEN jsonb_build_object('businessUnit',hbu.name,'department',hd.name,'position',hpos.title,'employmentType',ha.employment_type) ELSE '{}'::jsonb END
   ||CASE WHEN gr.found THEN jsonb_build_object('jobGrade',hg.name) ELSE '{}'::jsonb END
   ||jsonb_build_object('preservationActor',CASE WHEN app.current_user_id() IS NULL THEN 'system' ELSE 'user' END)
   ||jsonb_build_object('snapshotBasis',jsonb_build_object(
     'at',s.t,
     'reconstructed',to_jsonb(array_remove(ARRAY[CASE WHEN ho.found THEN 'hiredOn' END,CASE WHEN jo.found THEN 'joinDate' END,CASE WHEN gr.found THEN 'jobGrade' END,
       CASE WHEN ha.id IS NOT NULL THEN 'employmentType' END,CASE WHEN ha.id IS NOT NULL THEN 'businessUnit' END,CASE WHEN ha.id IS NOT NULL THEN 'department' END,CASE WHEN ha.id IS NOT NULL THEN 'position' END],NULL)),
     'unchangedSince',to_jsonb(array_remove(ARRAY[CASE WHEN NOT ho.found THEN 'hiredOn' END,CASE WHEN NOT jo.found THEN 'joinDate' END,CASE WHEN NOT gr.found THEN 'jobGrade' END],NULL)),
     'asDisplayed',to_jsonb(CASE WHEN ha.id IS NULL THEN ARRAY['employmentType','businessUnit','department','position'] ELSE ARRAY[]::text[] END))) AS document_metadata,
  app.current_user_id() AS recorded_by,now() AS created_at
 FROM (SELECT p.id,b.company_id,coalesce(b.closed_at,b.created_at) AS t FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
   WHERE app.payroll_history_row_visible('payslip',p.id) AND p.employment_id=e.id
   AND (NOT p_closed_only OR b.status='closed')
   AND NOT EXISTS(SELECT 1 FROM public.information_payslip_snapshot f WHERE f.payslip_id=p.id)) s
 LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 -- Job Grade before the first recorded grade change after T.
 LEFT JOIN LATERAL (SELECT true AS found,CASE WHEN ev.event_type='employment.grade.changed' THEN ev.payload->>'before' ELSE ev.payload->'before'->>'gradeId' END AS value
   FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.occurred_at>s.t
   AND (ev.event_type='employment.grade.changed' OR (ev.event_type='employment.information.corrected' AND ev.payload->'fields' ? 'gradeId'))
   ORDER BY ev.sequence LIMIT 1) gr0 ON true
 LEFT JOIN LATERAL (SELECT coalesce(gr0.found,false) AS found,gr0.value) gr ON true
 LEFT JOIN public.job_grade hg ON gr.found AND hg.id=gr.value::uuid AND hg.tenant_id=e.tenant_id
 -- Group Join Date before the first recorded change of it after T.
 LEFT JOIN LATERAL (SELECT true AS found,ev.payload->'before'->>'hiredOn' AS value
   FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.occurred_at>s.t
   AND ev.event_type IN ('employment.info.updated','employment.information.corrected') AND ev.payload->'fields' ? 'hiredOn'
   AND ev.payload->'before'->>'hiredOn' IS NOT NULL
   ORDER BY ev.sequence LIMIT 1) ho0 ON true
 LEFT JOIN LATERAL (SELECT coalesce(ho0.found,false) AS found,ho0.value) ho ON true
 -- Join Date before the first recorded change of it after T (a null Join Date is a recorded value).
 LEFT JOIN LATERAL (SELECT true AS found,ev.payload->'before'->>'joinDate' AS value
   FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.occurred_at>s.t
   AND ev.event_type IN ('employment.info.updated','employment.information.corrected') AND ev.payload->'fields' ? 'joinDate'
   AND ev.payload->'before' ? 'joinDate'
   ORDER BY ev.sequence LIMIT 1) jo0 ON true
 LEFT JOIN LATERAL (SELECT coalesce(jo0.found,false) AS found,jo0.value) jo ON true
 -- The assignment that was the open record at T (what the document read then): existed by T, not yet superseded,
 -- started by T's date and not ended by it. None (the employment had ended, or a later backdated change closed it
 -- before T's date) keeps the record as displayed today: a value the document never showed is never invented.
 LEFT JOIN LATERAL (SELECT x.id,x.employment_type,x.business_unit_id,x.department_id,x.position_id FROM public.assignment x
   WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.created_at<=s.t AND (x.superseded_at IS NULL OR x.superseded_at>s.t)
   AND x.valid_from<=(s.t AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>(s.t AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   ORDER BY x.valid_from DESC,x.created_at DESC LIMIT 1) ha ON true
 LEFT JOIN public.business_unit hbu ON hbu.id=ha.business_unit_id
 LEFT JOIN public.department hd ON hd.id=ha.department_id
 LEFT JOIN public.position hpos ON hpos.id=ha.position_id

 ) canonical_row;
 IF p_contract THEN
  IF p_closed_only IS DISTINCT FROM false THEN RAISE EXCEPTION 'Preserve all issued outputs for the exact Contract source' USING ERRCODE='42501';END IF;
  SELECT actual_frame.* INTO frame FROM app.contract_posting_job_tx actual_frame
  WHERE actual_frame.tenant_id=e.tenant_id AND actual_frame.employment_id=e.id
   AND actual_frame.job_id::text=current_setting('app.bulk_job',true) AND actual_frame.xact_id=txid_current()
   AND actual_frame.backend_pid=pg_backend_pid() AND actual_frame.login_name=session_user AND NOT actual_frame.protected
   AND app.contract_posting_original_source_intact(actual_frame.job_id,e.id);
  IF frame.job_id IS NULL OR EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::public.information_payslip_snapshot,snapshot_rows) row_data
   WHERE app.contract_posting_snapshot_identity_allowed(row_data.tenant_id,row_data.employment_id,row_data.payslip_id,row_data.company_id,row_data.recorded_by) IS NOT TRUE)
  THEN RAISE EXCEPTION 'Actual original Contract preservation frame required' USING ERRCODE='42501';END IF;
  -- Only this canonical historical reconstruction emits these permits. No callable hash/row mint exists.
  INSERT INTO app.contract_posting_snapshot_permit(tenant_id,job_id,xact_id,backend_pid,login_name,employment_id,payslip_id,row_hash)
  SELECT frame.tenant_id,frame.job_id,frame.xact_id,frame.backend_pid,frame.login_name,frame.employment_id,
   row_data.payslip_id,app.bulk_job_value_digest(to_jsonb(row_data))
  FROM jsonb_populate_recordset(NULL::public.information_payslip_snapshot,snapshot_rows) row_data
  ON CONFLICT(tenant_id,job_id,xact_id,backend_pid,payslip_id) DO NOTHING;
 END IF;
 -- A separate statement makes the canonical permits visible to INSERT RLS in this same transaction.
 INSERT INTO public.information_payslip_snapshot
 SELECT row_data.* FROM jsonb_populate_recordset(NULL::public.information_payslip_snapshot,snapshot_rows) row_data
 ON CONFLICT(payslip_id) DO NOTHING;
 SELECT count(*) INTO n FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
 WHERE app.payroll_history_row_visible('payslip',p.id) AND p.employment_id=e.id AND (NOT p_closed_only OR b.status='closed');
 IF n<>(SELECT count(*) FROM public.information_payslip_snapshot f JOIN public.payroll_batch b ON b.id=(SELECT p.batch_id FROM public.payslip p WHERE p.id=f.payslip_id) WHERE f.employment_id=e.id AND (NOT p_closed_only OR b.status='closed')) THEN
  RAISE EXCEPTION 'Historical metadata coverage is incomplete';
 END IF;
 IF p_contract THEN DELETE FROM app.contract_posting_snapshot_permit permit
  WHERE permit.tenant_id=frame.tenant_id AND permit.job_id=frame.job_id AND permit.xact_id=frame.xact_id
   AND permit.backend_pid=frame.backend_pid AND permit.login_name=frame.login_name;END IF;
 RETURN n;
END $owner$;
REVOKE ALL ON FUNCTION app.preserve_payroll_metadata_owner(uuid,boolean,boolean) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.contract_posting_snapshot_insert_allowed(p_row jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_posting_snapshot_identity_allowed((p_row->>'tenant_id')::uuid,(p_row->>'employment_id')::uuid,
  (p_row->>'payslip_id')::uuid,(p_row->>'company_id')::uuid,(p_row->>'recorded_by')::uuid)
 AND EXISTS(SELECT 1 FROM app.contract_posting_snapshot_permit permit
  WHERE permit.tenant_id=app.current_tenant_id() AND permit.tenant_id=(p_row->>'tenant_id')::uuid
   AND permit.job_id::text=current_setting('app.bulk_job',true) AND permit.xact_id=txid_current()
   AND permit.backend_pid=pg_backend_pid() AND permit.login_name=session_user
   AND permit.employment_id=(p_row->>'employment_id')::uuid AND permit.payslip_id=(p_row->>'payslip_id')::uuid
   AND permit.row_hash=app.bulk_job_value_digest(p_row))
$$;
REVOKE ALL ON FUNCTION app.contract_posting_snapshot_insert_allowed(jsonb) FROM PUBLIC,ai_hr_app;
CREATE POLICY contract_posting_snapshot_insert ON public.information_payslip_snapshot FOR INSERT TO ai_hr_owner
 WITH CHECK(app.contract_posting_snapshot_insert_allowed(to_jsonb(information_payslip_snapshot)));
-- Existing snapshot app SELECT-only grant, ordinary policies and immutable UPDATE/DELETE trigger remain.
