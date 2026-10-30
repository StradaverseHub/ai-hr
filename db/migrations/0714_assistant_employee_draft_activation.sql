-- PROVISIONAL source reservation0714/idx695/when1793330000043. Reallocate above live ledger at freeze.
-- Human activation of an existing employee Draft, on the one existing prepared-action ledger.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('employees.draft.activate','employees','approve','hiring','employees.draft.activate');
--> statement-breakpoint
DO $$
DECLARE definition text;constraint_name text;found integer;marker constant text:='''employees.qualification.maintain''::text]';
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO definition FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname='assistant_review_kind_columns';
 IF definition IS NULL OR (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0714: unexpected generic column predicate';END IF;
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK ('||replace(definition,marker,'''employees.qualification.maintain''::text, ''employees.draft.activate''::text]')||')';
 SELECT count(*),min(conname) INTO found,constraint_name FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND pg_get_expr(conbin,conrelid) LIKE '%testing_execution_id IS NOT NULL%' AND pg_get_expr(conbin,conrelid) LIKE '%employment_id IS NULL%';
 IF found<>1 THEN RAISE EXCEPTION '0714: unexpected actor subject predicate';END IF;
 SELECT pg_get_expr(conbin,conrelid) INTO definition FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=constraint_name;
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',constraint_name);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''employees.draft.activate'' THEN company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL AND ((state=''completed'')=(employment_id IS NOT NULL)) ELSE (%s) END)',constraint_name,definition);
 SELECT pg_get_expr(conbin,conrelid) INTO definition FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname='assistant_review_decision_columns';
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_decision_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_decision_columns CHECK (CASE WHEN action_kind=''employees.draft.activate'' THEN decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL AND ((state=''completed'')=(decision_subject_person_id IS NOT NULL)) ELSE ('||definition||') END)';
 SELECT pg_get_expr(conbin,conrelid) INTO definition FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname='assistant_review_generic_receipt';
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_generic_receipt;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_generic_receipt CHECK (CASE WHEN action_kind=''employees.draft.activate'' THEN receipt_subject_kind=''employee_draft'' AND receipt_subject_id IS NOT NULL AND ((state=''completed'')=(receipt_event_id IS NOT NULL)) ELSE ('||definition||') END)';
END $$;
--> statement-breakpoint
-- A pending Draft review belongs to its login; another authorized HR login may review the same Draft.
DO $$
DECLARE generic_predicate text;assigned_predicate text;
BEGIN
 SELECT pg_get_expr(indpred,indrelid) INTO generic_predicate FROM pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 SELECT pg_get_expr(indpred,indrelid) INTO assigned_predicate FROM pg_index WHERE indexrelid='app.assistant_review_assigned_pending_subject'::regclass;
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION '0714: missing pending indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''employees.draft.activate''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') OR (action_kind=''employees.draft.activate'' AND receipt_subject_id IS NOT NULL AND state=''awaiting_confirmation'')';
END $$;
--> statement-breakpoint
CREATE FUNCTION app._assistant_employee_draft_activation_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',NULL,'companyId',r.company_id,'draftId',r.receipt_subject_id),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'eventId',r.receipt_event_id,'employmentId',r.employment_id,'subjectPersonId',r.decision_subject_person_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='employees.draft.activate';
$$;
REVOKE ALL ON FUNCTION app._assistant_employee_draft_activation_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_employee_draft_activation_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_draft uuid DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_employment uuid DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();at_time timestamptz;new_person uuid;output jsonb;
BEGIN
 PERFORM app._assistant_multi_cycle_run_review_identity(NULL,false);
 IF app.is_admin() IS NOT TRUE OR p_operation IS NULL OR p_operation NOT IN('prepare','subject','read','discard','index','complete') THEN RAISE EXCEPTION 'Draft activation review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',action_kind,'contractVersion',1,'actionId',id,'state',state,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO output FROM (SELECT * FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND action_kind='employees.draft.activate' AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t) AND app.is_admin_for(company_id) AND app.access_workforce_company(company_id,'workforce.maintain') ORDER BY created_at DESC,id DESC LIMIT 25) selected;
  RETURN output;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_multi_cycle_run_review_identity(p_person);
  IF p_company IS NULL OR app.is_admin_for(p_company) IS NOT TRUE OR app.access_workforce_company(p_company,'workforce.maintain') IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.employee_draft d WHERE d.id=p_draft AND d.tenant_id=t AND d.company_id=p_company AND d.reserved_employee_code IS NOT NULL) THEN RAISE EXCEPTION 'Draft activation review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) THEN RAISE EXCEPTION 'Draft activation review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Draft activation review unavailable' USING ERRCODE='22023';END IF;
  at_time:=clock_timestamp();
  IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5 OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Draft activation review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,receipt_subject_kind,receipt_subject_id,intent_digest,reviewed_digest,state,created_at,expires_at) VALUES('employees.draft.activate',p_id,t,u,p_person,NULL,p_company,'employee_draft',p_draft,p_intent,p_reviewed,'awaiting_confirmation',at_time,at_time+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);
  RETURN app._assistant_employee_draft_activation_json(p_id);
 END IF;
 IF p_operation='subject' THEN
  SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='employees.draft.activate';
 ELSE
  SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='employees.draft.activate' FOR UPDATE NOWAIT;
 END IF;
 IF NOT FOUND OR app.is_admin_for(r.company_id) IS NOT TRUE OR app.access_workforce_company(r.company_id,'workforce.maintain') IS NOT TRUE THEN RAISE EXCEPTION 'Draft activation review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_multi_cycle_run_review_identity(r.person_id);
 IF p_operation='subject' THEN RETURN jsonb_build_object('draftId',r.receipt_subject_id,'companyId',r.company_id);END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN
   IF r.receipt_event_id IS DISTINCT FROM p_event OR r.employment_id IS DISTINCT FROM p_employment THEN RAISE EXCEPTION 'Draft activation review unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_employment IS NULL OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN RAISE EXCEPTION 'Draft activation review unavailable' USING ERRCODE='42501';END IF;
   SELECT e.person_id INTO new_person FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN public.domain_event d ON d.tenant_id=e.tenant_id AND d.subject_employment_id=e.id
    WHERE e.id=p_employment AND e.tenant_id=t AND e.company_id=r.company_id AND e.xmin=pg_current_xact_id()::xid AND p.xmin=pg_current_xact_id()::xid
     AND d.id=p_event AND d.xmin=pg_current_xact_id()::xid AND d.aggregate_type='employee-draft' AND d.aggregate_id=r.receipt_subject_id AND d.event_type='employee-draft.completed' AND d.actor_type='user' AND d.actor_id=u
     AND d.payload->>'employmentId'=e.id::text AND d.payload->>'companyId'=e.company_id::text AND d.payload->>'reservedEmployeeCode'=e.employee_code
     AND NOT EXISTS(SELECT 1 FROM public.employee_draft old WHERE old.id=r.receipt_subject_id AND old.tenant_id=t);
   IF new_person IS NULL OR new_person IS NOT DISTINCT FROM r.person_id THEN RAISE EXCEPTION 'Draft activation review unavailable' USING ERRCODE='42501';END IF;
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,employment_id=p_employment,decision_subject_person_id=new_person,receipt_event_id=p_event WHERE id=r.id;
  ELSE RAISE EXCEPTION 'Draft activation review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Draft activation review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 ELSIF p_operation='read' AND r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;
 END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 IF p_operation='discard' THEN SELECT jsonb_build_object('action',action_kind,'contractVersion',1,'actionId',id,'state',state) INTO output FROM app.assistant_own_leave_review WHERE id=r.id;RETURN output;END IF;
 RETURN app._assistant_employee_draft_activation_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_employee_draft_activation_command(text,uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_employee_draft_activation_command(text,uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Extend only the new generic receipt to the native-outcome closed readers. Every inherited rule stays.
DO $$
DECLARE definition text;function_name text;
BEGIN
 FOREACH function_name IN ARRAY ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_completed_review_choices(jsonb)'] LOOP
  SELECT pg_get_functiondef(function_name::regprocedure) INTO definition;
  IF position('''employees.qualification.maintain''' in definition)=0 THEN RAISE EXCEPTION '0714: native outcome drift';END IF;
  definition:=replace(definition,'''employees.qualification.maintain''','''employees.qualification.maintain'',''employees.draft.activate''');
  IF function_name='app.native_outcome_completed_review_choices(jsonb)' THEN definition:=replace(definition,'NOT BETWEEN 1 AND 30','NOT BETWEEN 1 AND 31');END IF;
  EXECUTE definition;
 END LOOP;
 SELECT pg_get_functiondef('app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure) INTO definition;
 IF position('WHEN ''employees.qualification.maintain'' THEN r.receipt_event_id' in definition)=0 THEN RAISE EXCEPTION '0714: native outcome event drift';END IF;
 EXECUTE replace(definition,'WHEN ''employees.qualification.maintain'' THEN r.receipt_event_id','WHEN ''employees.qualification.maintain'' THEN r.receipt_event_id WHEN ''employees.draft.activate'' THEN r.receipt_event_id');
END $$;
