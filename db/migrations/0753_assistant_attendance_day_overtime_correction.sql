-- UNAPPLIED PROVISIONAL DEVELOPMENT ONLY: 0753 / idx732 / version7 / when1793330000090.
-- Same native day owner; scoped opaque tuples and native summaries, never financial event evidence.
CREATE FUNCTION app.assistant_attendance_day_overtime_scope(p_employment uuid,p_date date) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject jsonb;
BEGIN
 PERFORM app._assistant_multi_cycle_run_review_identity(NULL,false);
 IF p_date IS NULL OR app.assistant_attendance_schedule_group_choice_scope(p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Day overtime unavailable' USING ERRCODE='42501';END IF;
 subject:=app.assistant_attendance_schedule_group_scope(p_employment);
 RETURN (subject-'attendanceRuleId')||jsonb_build_object('date',p_date);
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_day_overtime_scope(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_day_overtime_scope(uuid,date) TO ai_hr_app;

--> statement-breakpoint

-- Historical receipts authenticate immutable native evidence; current receipts additionally prove
-- actual top-transaction tuples. SAVEPOINT preview receipts deliberately do not use current proof.
CREATE FUNCTION app.assistant_attendance_day_overtime_receipt(p_employment uuid,p_date date,p_event uuid,p_current boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.domain_event;w jsonb;now_state jsonb;stored_after jsonb;protected_before jsonb;protected_after jsonb;event_xid xid;x text:=pg_current_xact_id()::xid::text;adjustment_id uuid;row_ref jsonb;new_calculation boolean;selected jsonb;prior_map jsonb;actual_map jsonb;expected_map jsonb;native_row jsonb;manual_entry jsonb;updated_stamp timestamptz;
BEGIN
 PERFORM app.assistant_attendance_day_overtime_scope(p_employment,p_date);
 SELECT e.* INTO d FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=app.current_tenant_id() AND e.aggregate_type='attendance-day-adjustment' AND e.event_type='attendance.day.corrected' AND e.subject_employment_id=p_employment AND e.actor_type='user' AND e.actor_id=app.current_user_id();
 IF NOT FOUND OR d.payload->>'date' IS DISTINCT FROM p_date::text OR d.payload->>'kind' IS DISTINCT FROM 'overtime' THEN RAISE EXCEPTION 'Day receipt unavailable' USING ERRCODE='42501';END IF;
 SELECT e.xmin INTO event_xid FROM public.domain_event e WHERE e.id=d.id AND e.tenant_id=d.tenant_id;
 w:=d.payload->'reviewOvertimeEffects';adjustment_id:=(d.payload->'after'->>'id')::uuid;
 IF w->>'version' IS DISTINCT FROM '1' OR w->>'date' IS DISTINCT FROM p_date::text OR adjustment_id IS DISTINCT FROM d.aggregate_id OR jsonb_typeof(w->'before'->'rows') IS DISTINCT FROM 'array' OR jsonb_typeof(w->'after'->'rows') IS DISTINCT FROM 'array'
 OR jsonb_array_length(w->'before'->'rows')>256 OR jsonb_array_length(w->'after'->'rows')>256 OR jsonb_typeof(w->'relatedEventIds') IS DISTINCT FROM 'array' OR jsonb_array_length(w->'relatedEventIds')>100 THEN RAISE EXCEPTION 'Day witness unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(j-'xid' ORDER BY j->>'kind',j->>'key'),'[]'::jsonb) INTO protected_before FROM jsonb_array_elements(w->'before'->'rows') j WHERE j->>'kind' IN('punch','attendance_clock');
 SELECT coalesce(jsonb_agg(j-'xid' ORDER BY j->>'kind',j->>'key'),'[]'::jsonb) INTO protected_after FROM jsonb_array_elements(w->'after'->'rows') j WHERE j->>'kind' IN('punch','attendance_clock');
 IF protected_before IS DISTINCT FROM protected_after OR (w->'after'->'summary'->'override'->>'version')::integer IS DISTINCT FROM (w->'before'->'summary'->'override'->>'version')::integer+1 OR w->'after'->'summary'->'override'->'shiftId' IS DISTINCT FROM d.payload->'after'->'shiftId' OR w->'after'->'summary'->'override'->'dayKind' IS DISTINCT FROM d.payload->'after'->'dayKind' OR w->'after'->'summary'->'override'->'reason' IS DISTINCT FROM d.payload->'after'->'reason' THEN RAISE EXCEPTION 'Day witness binding unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(w->'relatedEventIds') picked WHERE NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.id=picked.value::uuid AND e.tenant_id=d.tenant_id AND e.subject_employment_id=p_employment AND e.actor_type='user' AND e.actor_id=d.actor_id AND e.event_type IN('overtime.calculation.recorded','attendance.overtime-pattern.refused','payroll-batch.recalc-required'))) THEN RAISE EXCEPTION 'Day related audit unavailable' USING ERRCODE='42501';END IF;
 -- Authenticate exact normalized native inputs, including an explicit Auto reset that changes no map.
 IF octet_length(w::text)>120000 OR jsonb_typeof(w->'selectedRows') IS DISTINCT FROM 'array' OR jsonb_array_length(w->'selectedRows') NOT BETWEEN 1 AND 100
 OR (SELECT count(DISTINCT j->>'key') FROM jsonb_array_elements(w->'selectedRows') j)<>jsonb_array_length(w->'selectedRows') THEN RAISE EXCEPTION 'Day selected overtime input unavailable' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(d.payload->'after') IS DISTINCT FROM 'object' OR d.payload->'after'->>'id' IS DISTINCT FROM adjustment_id::text OR d.payload->'after'->>'tenantId' IS DISTINCT FROM d.tenant_id::text
 OR d.payload->'after'->>'employmentId' IS DISTINCT FROM p_employment::text OR d.payload->'after'->>'attendanceDate' IS DISTINCT FROM p_date::text OR d.payload->'after'->>'updatedBy' IS DISTINCT FROM d.actor_id::text
 OR d.payload->'after'->>'reason' IS DISTINCT FROM d.payload->>'reason' OR jsonb_typeof(d.payload->'after'->'updatedAt') IS DISTINCT FROM 'string' OR (d.payload->'after'->>'updatedAt') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' THEN RAISE EXCEPTION 'Day full adjustment identity unavailable' USING ERRCODE='42501';END IF;
 IF (d.payload->'after'->>'version')::integer IS DISTINCT FROM coalesce((d.payload->'before'->>'version')::integer,0)+1
 OR (w->'before'->'summary'->'override'->>'version')::integer IS DISTINCT FROM coalesce((d.payload->'before'->>'version')::integer,0)
 OR d.payload->'after'->'shiftId' IS DISTINCT FROM coalesce(d.payload->'before'->'shiftId','null'::jsonb)
 OR d.payload->'after'->'dayKind' IS DISTINCT FROM coalesce(d.payload->'before'->'dayKind','null'::jsonb)
 OR w->'before'->'summary'->'override'->'shiftId' IS DISTINCT FROM w->'after'->'summary'->'override'->'shiftId'
 OR w->'before'->'summary'->'override'->'dayKind' IS DISTINCT FROM w->'after'->'summary'->'override'->'dayKind'
 OR (d.payload->'before' IS DISTINCT FROM 'null'::jsonb AND d.payload->'before'->>'id' IS DISTINCT FROM adjustment_id::text) THEN RAISE EXCEPTION 'Day overtime schedule/version retention unavailable' USING ERRCODE='42501';END IF;
 prior_map:=coalesce(nullif(d.payload->'before'->'manualOtRows','null'::jsonb),'{}'::jsonb);actual_map:=d.payload->'after'->'manualOtRows';expected_map:=prior_map;
 IF jsonb_typeof(prior_map) IS DISTINCT FROM 'object' OR jsonb_typeof(actual_map) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Day manual map unavailable' USING ERRCODE='42501';END IF;
 updated_stamp:=(d.payload->'after'->>'updatedAt')::timestamptz;
 FOR selected IN SELECT * FROM jsonb_array_elements(w->'selectedRows') LOOP
  IF jsonb_typeof(selected) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(selected))<>2 OR NOT(selected ? 'key' AND selected ? 'minutes')
  OR jsonb_typeof(selected->'key') IS DISTINCT FROM 'string' OR length(selected->>'key') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Day selected row shape unavailable' USING ERRCODE='42501';END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(w->'before'->'summary'->'legacyRows') j WHERE j->>'key'=selected->>'key')<>1 THEN RAISE EXCEPTION 'Day native selected row unavailable' USING ERRCODE='42501';END IF;
  SELECT j INTO native_row FROM jsonb_array_elements(w->'before'->'summary'->'legacyRows') j WHERE j->>'key'=selected->>'key';
  IF selected->'minutes'='null'::jsonb THEN expected_map:=expected_map-(selected->>'key');
  ELSE
   IF jsonb_typeof(selected->'minutes') IS DISTINCT FROM 'number' OR (selected->>'minutes') !~ '^(0|[1-9][0-9]{0,3})$' OR (selected->>'minutes')::integer>1440
   OR w->'before'->'summary'->>'complete' IS DISTINCT FROM 'true' OR native_row->>'orphan' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Day native manual decision unavailable' USING ERRCODE='42501';END IF;
   manual_entry:=actual_map->(selected->>'key');
   IF jsonb_typeof(manual_entry) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(manual_entry))<>5
   OR manual_entry->'minutes' IS DISTINCT FROM selected->'minutes' OR manual_entry->'bucket' IS DISTINCT FROM native_row->'bucket' OR manual_entry->'calculatedMinutes' IS DISTINCT FROM native_row->'calculatedMinutes'
   OR manual_entry->>'actorId' IS DISTINCT FROM d.actor_id::text OR (manual_entry->>'recordedAt') IS NULL OR (manual_entry->>'recordedAt') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
   OR (manual_entry->>'recordedAt')::timestamptz>updated_stamp THEN RAISE EXCEPTION 'Day actual manual provenance unavailable' USING ERRCODE='42501';END IF;
   expected_map:=jsonb_set(expected_map,ARRAY[selected->>'key'],manual_entry,true);
  END IF;
 END LOOP;
 IF expected_map IS DISTINCT FROM actual_map THEN RAISE EXCEPTION 'Day unselected manual provenance changed' USING ERRCODE='42501';END IF;
 IF p_current THEN
  IF event_xid::text<>x THEN RAISE EXCEPTION 'Day current event unavailable' USING ERRCODE='42501';END IF;
  -- Full persisted adjustment and actual selected actor/timestamps, not just its version/opaque hash.
  IF NOT EXISTS(SELECT 1 FROM public.attendance_day_adjustment a WHERE a.id=adjustment_id AND a.tenant_id=d.tenant_id AND a.employment_id=p_employment AND a.attendance_date=p_date AND a.xmin::text=x
   AND jsonb_build_object('id',a.id,'tenantId',a.tenant_id,'employmentId',a.employment_id,'attendanceDate',a.attendance_date,'shiftId',a.shift_id,'dayKind',a.day_kind,'manualOtRows',a.manual_ot_rows,'version',a.version,'reason',a.reason,'updatedBy',a.updated_by,'updatedAt',to_char(a.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))=d.payload->'after') THEN RAISE EXCEPTION 'Day full native adjustment unavailable' USING ERRCODE='42501';END IF;
  now_state:=app.assistant_attendance_day_schedule_effect_state(p_employment,p_date,w->'payrollBatchIds');
  stored_after:=w->'after'->'summary';
  IF now_state->'rows' IS DISTINCT FROM w->'after'->'rows' OR now_state-'rows'-'privateRetention' IS DISTINCT FROM jsonb_build_object('override',stored_after->'override','day',stored_after->'day','pattern',stored_after->'pattern','payroll',stored_after->'payroll') THEN RAISE EXCEPTION 'Day actual effects changed' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM public.attendance a WHERE a.tenant_id=d.tenant_id AND a.employment_id=p_employment AND a.attendance_date=p_date AND a.check_in_at IS NOT NULL AND a.xmin::text<>x) THEN RAISE EXCEPTION 'Day calculation transaction unavailable' USING ERRCODE='42501';END IF;
  new_calculation:=stored_after->'pattern'->>'calculationId' IS DISTINCT FROM w->'before'->'summary'->'pattern'->>'calculationId';
  FOR row_ref IN SELECT * FROM jsonb_array_elements(w->'after'->'rows') LOOP
   IF (row_ref->>'kind'='adjustment' OR (new_calculation AND row_ref->>'kind' IN('pattern_source','pattern_calculation','pattern_evidence','pattern_part','pattern_line')) OR row_ref->>'kind'='payroll') AND row_ref->>'xid'<>x THEN RAISE EXCEPTION 'Day effect transaction unavailable' USING ERRCODE='42501';END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(w->'relatedEventIds') picked JOIN public.domain_event e ON e.id=picked.value::uuid AND e.tenant_id=d.tenant_id WHERE e.xmin::text<>x) THEN RAISE EXCEPTION 'Day related transaction unavailable' USING ERRCODE='42501';END IF;
  IF new_calculation AND stored_after->'pattern'->>'calculationId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=d.tenant_id AND e.id IN(SELECT value::uuid FROM jsonb_array_elements_text(w->'relatedEventIds')) AND e.event_type='overtime.calculation.recorded' AND e.aggregate_id=(stored_after->'pattern'->>'sourceId')::uuid AND e.payload->>'calculationId'=stored_after->'pattern'->>'calculationId') THEN RAISE EXCEPTION 'Day calculation audit unavailable' USING ERRCODE='42501';END IF;
  IF NOT new_calculation AND stored_after->'pattern'->>'marker'='refused' AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.tenant_id=d.tenant_id AND a.employment_id=p_employment AND a.attendance_date=p_date AND a.check_in_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM public.domain_event e JOIN public.attendance a ON a.id=e.aggregate_id AND a.tenant_id=e.tenant_id WHERE e.tenant_id=d.tenant_id AND a.employment_id=p_employment AND a.attendance_date=p_date AND e.id IN(SELECT value::uuid FROM jsonb_array_elements_text(w->'relatedEventIds')) AND e.event_type='attendance.overtime-pattern.refused' AND e.payload->>'date'=p_date::text) THEN RAISE EXCEPTION 'Day refusal audit unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(stored_after->'payroll') b WHERE b->>'recalcRequired' IS DISTINCT FROM 'true' OR (NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=d.tenant_id AND e.id IN(SELECT value::uuid FROM jsonb_array_elements_text(w->'relatedEventIds')) AND e.event_type='payroll-batch.recalc-required' AND e.aggregate_id=(b->>'batchId')::uuid AND e.payload=jsonb_build_object('addedEmploymentIds',jsonb_build_array(p_employment))))) THEN RAISE EXCEPTION 'Day payroll audit unavailable' USING ERRCODE='42501';END IF;
 END IF;
 RETURN jsonb_build_object('adjustmentId',adjustment_id,'eventId',d.id,'version',(d.payload->'after'->>'version')::integer,'witness',w);
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_day_overtime_receipt(uuid,date,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_day_overtime_receipt(uuid,date,uuid,boolean) TO ai_hr_app;

--> statement-breakpoint
-- Closed overtime-row-only action; registry FK from0704 remains the sole kind membership owner.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES ('attendance.day_overtime.correct','attendance','approve','personnel','attendance.day_overtime.correct');
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN day_overtime_date date,
 ADD CONSTRAINT assistant_day_overtime_nomination CHECK(CASE WHEN action_kind='attendance.day_overtime.correct' THEN day_overtime_date IS NOT NULL ELSE day_overtime_date IS NULL END);
--> statement-breakpoint
-- Select the real actor-scope constraint by its column dependencies before deparsing. No blanket
-- expansion of unrelated constraints; old predicates occur once and all dedicated checks survive.
DO $$ DECLARE item record;previous text;scope_name text;scope_keys smallint[];matches integer;
BEGIN
 SELECT array_agg(attnum ORDER BY attnum) INTO scope_keys FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attname IN('employment_id','testing_execution_id') AND NOT attisdropped;
 IF cardinality(scope_keys)<>2 THEN RAISE EXCEPTION '0753: actor columns unavailable';END IF;
 matches:=0;
 FOR item IN SELECT conname,octet_length(conbin::text) AS bytes FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conkey @> scope_keys LOOP
  RAISE NOTICE '0753 actor candidate % rawbytes %',item.conname,item.bytes;
  SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=item.conname;
  IF position('testing_execution_id IS NOT NULL' in previous)>0 AND position('employment_id IS NULL' in previous)>0 THEN matches:=matches+1;scope_name:=item.conname;END IF;
 END LOOP;
 IF matches<>1 THEN RAISE EXCEPTION '0753: actor constraint drift %',matches;END IF;
 FOR item IN SELECT * FROM (VALUES
 (scope_name,'employment_id IS NOT NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL'),
 ('assistant_review_kind_columns','leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND performance_ack_event_id IS NULL'),
 ('assistant_review_decision_columns','decision_subject_person_id IS NOT NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
 ('assistant_review_generic_receipt','receipt_subject_kind=''employment'' AND receipt_subject_id=employment_id AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')) requirements(name,expression) LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=item.name AND contype='c';
  IF previous IS NULL THEN RAISE EXCEPTION '0753: missing %',item.name;END IF;
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK(CASE WHEN action_kind=''attendance.day_overtime.correct'' THEN (%s) ELSE (%s) END)',item.name,item.expression,previous);
 END LOOP;
END $$;
--> statement-breakpoint
DO $$ DECLARE predicate text;index_name text;
BEGIN
 FOREACH index_name IN ARRAY ARRAY['assistant_review_generic_pending_subject','assistant_review_assigned_pending_subject'] LOOP
  SELECT pg_get_expr(indpred,indrelid) INTO predicate FROM pg_index WHERE indexrelid=('app.'||index_name)::regclass;
  IF predicate IS NULL THEN RAISE EXCEPTION '0753: missing %',index_name;END IF;
  EXECUTE format('DROP INDEX app.%I',index_name);
  EXECUTE format('CREATE UNIQUE INDEX %I ON app.assistant_own_leave_review(%s) WHERE (%s) AND action_kind<>''attendance.day_overtime.correct''',index_name,CASE WHEN index_name='assistant_review_generic_pending_subject' THEN 'tenant_id,action_kind,receipt_subject_id' ELSE 'tenant_id,action_kind,receipt_subject_id,user_id' END,predicate);
 END LOOP;
 CREATE UNIQUE INDEX assistant_day_overtime_pending ON app.assistant_own_leave_review(tenant_id,action_kind,employment_id,user_id,day_overtime_date) WHERE action_kind='attendance.day_overtime.correct' AND state='awaiting_confirmation';
END $$;
--> statement-breakpoint
CREATE FUNCTION app._assistant_attendance_day_overtime_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',q.id,'action',q.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',q.tenant_id,'userId',q.user_id,'personId',q.person_id,'employmentId',q.employment_id,'companyId',q.company_id,'subjectPersonId',q.decision_subject_person_id,'date',q.day_overtime_date),
 'intentDigest',q.intent_digest,'reviewedDigest',q.reviewed_digest,'state',q.state,'createdAt',to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(q.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN q.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,'eventId',q.receipt_event_id)
 FROM app.assistant_own_leave_review q LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=q.id WHERE q.id=p_id AND q.action_kind='attendance.day_overtime.correct';
$$;
REVOKE ALL ON FUNCTION app._assistant_attendance_day_overtime_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_attendance_day_overtime_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_employment uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_subject_person uuid DEFAULT NULL,p_date date DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE review_row app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();at_time timestamptz;output jsonb;subject jsonb;receipt jsonb;
BEGIN
 PERFORM app._assistant_multi_cycle_run_review_identity(NULL,false);
 IF p_operation IS NULL OR p_operation NOT IN('prepare','subject','read','discard','index','complete') THEN RAISE EXCEPTION 'Day review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',q.action_kind,'contractVersion',1,'actionId',q.id,'date',q.day_overtime_date,'state',q.state,'createdAt',to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(q.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY q.created_at DESC,q.id DESC),'[]'::jsonb) INTO output FROM (
   SELECT q.* FROM app.assistant_own_leave_review q JOIN public.employment e ON e.id=q.employment_id AND e.tenant_id=q.tenant_id AND e.company_id=q.company_id AND e.person_id=q.decision_subject_person_id
   WHERE q.tenant_id=t AND q.user_id=u AND q.action_kind='attendance.day_overtime.correct' AND q.created_at>now()-interval '30 days' AND q.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t) AND app.assistant_attendance_schedule_group_choice_scope(q.employment_id) ORDER BY q.created_at DESC,q.id DESC LIMIT 25) q;
  RETURN output;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_multi_cycle_run_review_identity(p_person);
  subject:=app.assistant_attendance_day_overtime_scope(p_employment,p_date);
  IF p_employment IS NULL OR p_company IS NULL OR p_subject_person IS NULL OR p_date IS NULL OR p_subject_person IS NOT DISTINCT FROM p_person OR subject->>'companyId' IS DISTINCT FROM p_company::text OR subject->>'subjectPersonId' IS DISTINCT FROM p_subject_person::text THEN RAISE EXCEPTION 'Day review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id IN(p_person,p_subject_person)) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id IN(p_person,p_subject_person)) THEN RAISE EXCEPTION 'Day review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Day review unavailable' USING ERRCODE='22023';END IF;
  at_time:=clock_timestamp();
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE tenant_id=t AND user_id=u AND action_kind='attendance.day_overtime.correct' AND employment_id=p_employment AND day_overtime_date=p_date AND state='awaiting_confirmation' AND expires_at<=at_time;
  DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review q WHERE c.action_id=q.id AND q.tenant_id=t AND q.user_id=u AND q.action_kind='attendance.day_overtime.correct' AND q.employment_id=p_employment AND q.day_overtime_date=p_date AND q.state='expired';
  IF (SELECT count(*) FROM app.assistant_own_leave_review q WHERE q.tenant_id=t AND q.user_id=u AND q.state='awaiting_confirmation' AND q.expires_at>at_time)>=5 OR (SELECT count(*) FROM app.assistant_own_leave_review q WHERE q.tenant_id=t AND q.user_id=u AND q.created_at>at_time-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Day review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,decision_subject_person_id,receipt_subject_kind,receipt_subject_id,day_overtime_date,intent_digest,reviewed_digest,state,created_at,expires_at) VALUES('attendance.day_overtime.correct',p_id,t,u,p_person,p_employment,p_company,p_subject_person,'employment',p_employment,p_date,p_intent,p_reviewed,'awaiting_confirmation',at_time,at_time+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);
  RETURN app._assistant_attendance_day_overtime_json(p_id);
 END IF;
 IF p_operation='subject' THEN SELECT * INTO review_row FROM app.assistant_own_leave_review q WHERE q.id=p_id AND q.tenant_id=t AND q.user_id=u AND q.action_kind='attendance.day_overtime.correct';
 ELSE SELECT * INTO review_row FROM app.assistant_own_leave_review q WHERE q.id=p_id AND q.tenant_id=t AND q.user_id=u AND q.action_kind='attendance.day_overtime.correct' FOR UPDATE NOWAIT;END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Day review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_multi_cycle_run_review_identity(review_row.person_id);
 IF p_operation='subject' THEN
  IF app.assistant_attendance_schedule_group_choice_scope(review_row.employment_id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=review_row.employment_id AND e.tenant_id=t AND e.company_id=review_row.company_id AND e.person_id=review_row.decision_subject_person_id) THEN RAISE EXCEPTION 'Day nomination unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation<>'discard' THEN
  subject:=app.assistant_attendance_day_overtime_scope(review_row.employment_id,review_row.day_overtime_date);
  IF subject->>'companyId' IS DISTINCT FROM review_row.company_id::text OR subject->>'subjectPersonId' IS DISTINCT FROM review_row.decision_subject_person_id::text THEN RAISE EXCEPTION 'Day review binding unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF p_operation='subject' THEN RETURN jsonb_build_object('employmentId',review_row.employment_id,'date',review_row.day_overtime_date,'state',CASE WHEN review_row.state='awaiting_confirmation' AND review_row.expires_at<=clock_timestamp() THEN 'expired' ELSE review_row.state END);END IF;
 IF p_operation='complete' THEN
  IF review_row.state='completed' THEN IF review_row.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Day review unavailable' USING ERRCODE='42501';END IF;
  ELSIF review_row.state='awaiting_confirmation' AND clock_timestamp()<review_row.expires_at THEN
   IF review_row.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=review_row.id) THEN RAISE EXCEPTION 'Day review unavailable' USING ERRCODE='42501';END IF;
   receipt:=app.assistant_attendance_day_overtime_receipt(review_row.employment_id,review_row.day_overtime_date,p_event,true);
   IF receipt->'witness'->>'date' IS DISTINCT FROM review_row.day_overtime_date::text THEN RAISE EXCEPTION 'Day review date unavailable' USING ERRCODE='42501';END IF;
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event WHERE id=review_row.id;
  ELSE RAISE EXCEPTION 'Day review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF review_row.state='completed' THEN RAISE EXCEPTION 'Day review unavailable' USING ERRCODE='42501';END IF;
  IF review_row.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=review_row.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=review_row.id;END IF;
 ELSIF p_operation='read' AND review_row.state='awaiting_confirmation' AND clock_timestamp()>=review_row.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=review_row.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review q WHERE c.action_id=q.id AND q.id=review_row.id AND q.state<>'awaiting_confirmation';
 IF p_operation='discard' THEN SELECT jsonb_build_object('action',q.action_kind,'contractVersion',1,'actionId',q.id,'state',q.state) INTO output FROM app.assistant_own_leave_review q WHERE q.id=review_row.id;RETURN output;END IF;
 RETURN app._assistant_attendance_day_overtime_json(review_row.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_attendance_day_overtime_command(text,uuid,uuid,uuid,uuid,uuid,date,text,text,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_attendance_day_overtime_command(text,uuid,uuid,uuid,uuid,uuid,date,text,text,text,text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)','app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN marker:='WHEN ''attendance.schedule_group.maintain'' THEN r.receipt_event_id';replacement:=marker||' WHEN ''attendance.day_overtime.correct'' THEN r.receipt_event_id';
  ELSE marker:='''attendance.schedule_group.maintain''';replacement:=marker||',''attendance.day_overtime.correct''';END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0753: outcome owner drift %',target;END IF;
  EXECUTE replace(definition,marker,replacement);
 END LOOP;
END $$;
