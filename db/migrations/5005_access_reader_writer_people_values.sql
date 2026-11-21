-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5005_access_reader_writer_people_values, idx 4405, when 1793330004705.
-- Draft name on its branch: 9840_access_reader_writer_people_values. Any draft note below describes that unallocated branch position.
-- Reader/writer Access lock: people and workforce wave (draft number 5005; the integration step renumbers it).
--
-- The Personnel maintenance command (core/workforce-maintenance.ts) changes one person's or one
-- employment's values. It took the profile-policy lock exclusively here, so a writer holding the shared
-- Access and policy locks would have upgraded. It now joins the policy lock in value mode, like the other
-- register writers (5001, 5002). Only a profile-policy editor excludes it. Every row rule it enforces (one
-- Primary contact, one Highest qualification, the expected-version check) runs under the caller's
-- per-person or per-employment profile lock and the row locks below, which are unchanged. A caller that
-- already holds the policy lock exclusively keeps it. The body is otherwise byte-for-byte 0579's.
CREATE OR REPLACE FUNCTION app.access_workforce_maintain_record(p_employment uuid,p_kind text,p_row uuid,p_operation text,p_patch jsonb,p_expected text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.employment%ROWTYPE;before_row jsonb;after_row jsonb;normalized jsonb:='{}'::jsonb;
 version text;target_id uuid;table_name text;subject_column text;subject_id uuid;event_name text;aggregate_name text;
 assignments text;insert_columns text;insert_values text;field_names jsonb;pair record;binding record;value jsonb;
 previous record;previous_after jsonb;written_event_id uuid;instant timestamptz:=now();changed boolean;effect_id uuid;relationship text;
BEGIN
 IF p_kind IS NULL OR p_operation IS NULL OR p_kind NOT IN ('person','qualification','emergency','dependent') OR p_operation NOT IN ('add','update','archive')
  OR jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR octet_length(p_patch::text)>128000 THEN
  RAISE EXCEPTION 'Workforce input invalid' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_patch))>40 OR p_kind='person' AND (p_operation<>'update' OR p_row IS NOT NULL)
  OR p_kind<>'person' AND ((p_operation='add') IS DISTINCT FROM (p_row IS NULL)) THEN
  RAISE EXCEPTION 'Workforce input invalid' USING ERRCODE='22023'; END IF;
 -- Reader/writer lock (people wave): value mode of the profile-policy lock. A caller holding it exclusively
 -- keeps that; the caller's per-person (or per-employment) profile lock serialises this subject's rows.
 PERFORM app.access_profile_policy_value_lock();
 SELECT * INTO selected FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.current_user_id() IS NULL OR NOT app.access_workforce_command_company(selected.company_id)
  OR p_kind<>'qualification' AND NOT app.access_workforce_command_person(selected.id) THEN
  RAISE EXCEPTION 'Workforce command unavailable' USING ERRCODE='42501'; END IF;
 table_name:=CASE p_kind WHEN 'person' THEN 'person' WHEN 'qualification' THEN 'employee_qualification' WHEN 'dependent' THEN 'employee_dependent' ELSE 'person_emergency_contact' END;
 subject_column:=CASE WHEN p_kind='qualification' THEN 'employment_id' ELSE 'person_id' END;
 subject_id:=CASE WHEN p_kind='qualification' THEN selected.id ELSE selected.person_id END;
 aggregate_name:=CASE p_kind WHEN 'person' THEN 'person' WHEN 'qualification' THEN 'employee-qualification' WHEN 'dependent' THEN 'employee-dependent' ELSE 'person-emergency-contact' END;
 event_name:=CASE p_kind WHEN 'person' THEN 'person.updated' WHEN 'qualification' THEN 'qualification.' WHEN 'dependent' THEN 'dependent.' ELSE 'emergency-contact.' END;
 IF p_kind<>'person' THEN event_name:=event_name||CASE p_operation WHEN 'add' THEN 'added' WHEN 'update' THEN 'updated' ELSE 'archived' END; END IF;
 IF p_kind='person' THEN
  SELECT to_jsonb(p),p.xmin::text INTO before_row,version FROM public.person p WHERE p.id=selected.person_id AND p.tenant_id=selected.tenant_id FOR UPDATE;
  target_id:=selected.person_id;
 ELSE
  -- Same order as the canonical register writers: former Highest/Primary before the target row.
  IF p_kind='qualification' THEN
   PERFORM 1 FROM public.employee_qualification WHERE tenant_id=selected.tenant_id AND employment_id=selected.id AND archived_at IS NULL AND is_highest ORDER BY id FOR UPDATE;
  ELSE
   PERFORM 1 FROM public.person WHERE id=selected.person_id AND tenant_id=selected.tenant_id FOR UPDATE;
   PERFORM 1 FROM public.person_emergency_contact WHERE tenant_id=selected.tenant_id AND person_id=selected.person_id AND archived_at IS NULL AND priority='primary' ORDER BY id FOR UPDATE;
  END IF;
  target_id:=COALESCE(p_row,gen_random_uuid());
  IF p_operation='add' THEN before_row:='{}'::jsonb;
  ELSE
   EXECUTE format('SELECT to_jsonb(r),r.xmin::text FROM public.%I r WHERE r.id=$1 AND r.tenant_id=$2 AND r.%I=$3 AND r.archived_at IS NULL FOR UPDATE',table_name,subject_column)
    INTO before_row,version USING target_id,selected.tenant_id,subject_id;
  END IF;
 END IF;
 IF before_row IS NULL OR p_operation<>'add' AND (p_expected IS NULL OR version IS DISTINCT FROM p_expected) THEN
  RAISE EXCEPTION 'Workforce record changed' USING ERRCODE='40001'; END IF;
 IF p_operation='add' AND p_expected IS NOT NULL THEN RAISE EXCEPTION 'Workforce input invalid' USING ERRCODE='22023'; END IF;
 IF p_operation='archive' THEN
  IF p_patch<>'{}'::jsonb THEN RAISE EXCEPTION 'Workforce archive input invalid' USING ERRCODE='22023'; END IF;
  normalized:=jsonb_build_object('archived_at',instant,'updated_at',instant);
 ELSE
  relationship:=COALESCE(NULLIF(app.access_profile_value_normalized(p_patch->'relationship')#>>'{}',''),before_row->>'relationship');
  FOR pair IN SELECT * FROM jsonb_each(p_patch) LOOP
   SELECT * INTO binding FROM app.access_profile_value_bindings() b WHERE b.field_name=pair.key
    AND CASE WHEN p_kind='person' THEN b.owner IN ('person','compliance') ELSE b.owner=p_kind END
    AND b.field_name=ANY(app.access_workforce_command_fields(p_kind));
   IF NOT FOUND THEN RAISE EXCEPTION 'Workforce field unavailable' USING ERRCODE='22023'; END IF;
   IF p_kind='dependent' AND ((relationship IS DISTINCT FROM 'spouse' AND pair.key IN ('marriageDate','marriageStatus','spouseWorking')) OR
     (relationship IS DISTINCT FROM 'child' AND pair.key IN ('isStudent','schoolName','studyLevel','studyCountry','childReliefCategory','childTaxRelief','childReliefPercentage'))) THEN CONTINUE; END IF;
   value:=app.access_profile_value_normalized(pair.value);
   -- An unchanged, already-retained relationship on any live contact keeps the existing legacy
   -- tolerance. The public caller cannot supply a fake legacy value to the catalog owner.
   IF NOT (p_kind='emergency' AND pair.key='relationship' AND EXISTS(SELECT 1 FROM public.person_emergency_contact c
     WHERE c.person_id=selected.person_id AND c.tenant_id=selected.tenant_id AND c.archived_at IS NULL AND to_jsonb(c.relationship)=value))
    AND NOT app.access_workforce_value_shape(p_kind,pair.key,value,before_row->binding.column_name) THEN
    RAISE EXCEPTION 'Workforce field invalid' USING ERRCODE='22023'; END IF;
   normalized:=normalized||jsonb_build_object(binding.column_name,value);
  END LOOP;
  IF p_operation='add' THEN
   normalized:=CASE WHEN p_kind='qualification' THEN jsonb_build_object('is_highest',false) WHEN p_kind='dependent' THEN jsonb_build_object('is_beneficiary',false,'is_deceased',false) ELSE jsonb_build_object('priority','other') END||normalized;
   IF COALESCE(normalized->>'qualification',normalized->>'full_name','')='' THEN RAISE EXCEPTION 'Workforce name required' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_kind='dependent' THEN
   IF relationship IS NULL THEN RAISE EXCEPTION 'Family relationship required' USING ERRCODE='22023'; END IF;
   IF p_operation='add' OR relationship IS DISTINCT FROM before_row->>'relationship' THEN
    IF relationship<>'spouse' THEN normalized:=normalized||jsonb_build_object('marriage_date',NULL,'marriage_status',NULL,'spouse_working',NULL,'company_name',NULL,'employer_address',NULL); END IF;
    IF relationship<>'child' THEN normalized:=normalized||jsonb_build_object('is_student',NULL,'school_name',NULL,'study_level',NULL,'study_country',NULL,'child_relief_category',NULL,'child_tax_relief',NULL,'child_relief_percentage',NULL); END IF;
   END IF;
  END IF;
  IF p_kind='qualification' THEN
   after_row:=before_row||normalized;
   IF after_row->>'from_ym'>after_row->>'to_ym' OR left(after_row->>'graduation_date',7)<after_row->>'from_ym' THEN
    RAISE EXCEPTION 'Qualification date order invalid' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_kind='person' AND normalized ? 'marital_status' THEN normalized:=normalized||jsonb_build_object('marital_status_source_request_id',NULL); END IF;
  IF p_operation<>'add' AND NOT EXISTS(SELECT 1 FROM jsonb_each(normalized) d WHERE d.value IS DISTINCT FROM before_row->d.key) THEN
   -- Existing Family saves refresh age-dependent facts even when the edited row itself is unchanged.
   IF p_kind='dependent' THEN PERFORM app.my_sync_family_child_relief(selected.person_id); END IF;
   -- Generic Family notice is independent of private tax mode or other-company payroll state.
   RETURN jsonb_build_object('id',target_id,'changed',false,'hrReviewNotice',p_kind='dependent'); END IF;
  IF p_kind<>'person' THEN normalized:=normalized||jsonb_build_object('updated_at',instant); END IF;
 END IF;
 -- Transfer exactly one Primary/Highest using the same finite fields as the existing canonical owner.
 -- Every affected row has its own exact private before/after witness, tied to the one main event.
 IF p_kind='qualification' AND normalized->'is_highest'='true'::jsonb OR p_kind='emergency' AND normalized->>'priority'='primary' THEN
  FOR previous IN EXECUTE format('SELECT to_jsonb(r) value FROM public.%I r WHERE r.tenant_id=$1 AND r.%I=$2 AND r.id<>$3 AND r.archived_at IS NULL AND %s ORDER BY r.id FOR UPDATE',
   table_name,subject_column,CASE WHEN p_kind='qualification' THEN 'r.is_highest' ELSE 'r.priority=''primary''' END) USING selected.tenant_id,subject_id,target_id
  LOOP
   previous_after:=previous.value||jsonb_build_object(CASE WHEN p_kind='qualification' THEN 'is_highest' ELSE 'priority' END,
    CASE WHEN p_kind='qualification' THEN 'false'::jsonb ELSE '"secondary"'::jsonb END,'updated_at',instant);
   INSERT INTO app.access_workforce_value_intent(xact_id,tenant_id,user_id,employment_id,kind,row_id,before_hash,after_hash,audit_root,event_type)
    VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,p_kind,(previous.value->>'id')::uuid,
     encode(sha256(convert_to(previous.value::text,'UTF8')),'hex'),encode(sha256(convert_to(previous_after::text,'UTF8')),'hex'),target_id,event_name);
   EXECUTE format('UPDATE public.%I SET %s,updated_at=$1 WHERE id=$2 AND tenant_id=$3',table_name,
    CASE WHEN p_kind='qualification' THEN 'is_highest=false' ELSE 'priority=''secondary''' END)
    USING instant,(previous.value->>'id')::uuid,selected.tenant_id;
   effect_id:=(previous.value->>'id')::uuid;
  END LOOP;
 END IF;
 IF p_operation='add' THEN
  normalized:=normalized||jsonb_build_object('id',target_id,'tenant_id',selected.tenant_id,subject_column,subject_id);
  SELECT string_agg(format('%I',key),',' ORDER BY key),string_agg(format('v.%I',key),',' ORDER BY key)
   INTO insert_columns,insert_values FROM jsonb_object_keys(normalized) key;
  EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) v RETURNING to_jsonb(%I.*)',table_name,insert_columns,insert_values,table_name,table_name)
   INTO after_row USING normalized;
 ELSE
  after_row:=before_row||normalized;
  INSERT INTO app.access_workforce_value_intent(xact_id,tenant_id,user_id,employment_id,kind,row_id,before_hash,after_hash,audit_root,event_type)
   VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,p_kind,target_id,
    encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'),target_id,event_name);
  SELECT string_agg(format('%I=v.%I',key,key),',' ORDER BY key) INTO assignments FROM jsonb_object_keys(normalized) key;
  EXECUTE format('UPDATE public.%I r SET %s FROM jsonb_populate_record(NULL::public.%I,$1) v WHERE r.id=$2 AND r.tenant_id=$3 RETURNING to_jsonb(r.*)',table_name,assignments,table_name)
   INTO after_row USING normalized,target_id,selected.tenant_id;
 END IF;
 IF p_operation='add' THEN
  INSERT INTO app.access_workforce_value_intent(xact_id,tenant_id,user_id,employment_id,kind,row_id,before_hash,after_hash,audit_root,event_type)
   VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,p_kind,target_id,
    encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'),target_id,event_name);
 END IF;
 SELECT COALESCE(jsonb_agg(key ORDER BY key),'[]'::jsonb) INTO field_names FROM jsonb_object_keys(p_patch) key;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(selected.tenant_id,aggregate_name,target_id,event_name,'user',app.current_user_id(),selected.id,
   jsonb_build_object('fields',field_names,'via','workforce-maintenance','transferFromId',effect_id)) RETURNING id INTO written_event_id;
 UPDATE app.access_workforce_value_intent SET event_id=written_event_id
  WHERE xact_id=pg_current_xact_id() AND tenant_id=selected.tenant_id AND user_id=app.current_user_id() AND audit_root=target_id AND event_type=event_name;
 IF p_kind='dependent' THEN PERFORM app.my_sync_family_child_relief(selected.person_id); END IF;
 RETURN jsonb_build_object('id',target_id,'changed',true,'hrReviewNotice',p_kind='dependent');
END; $$;
