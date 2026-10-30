-- 0745 / idx724 / when1793330000082: UNAPPLIED PROVISIONAL DEVELOPMENT ONLY.
-- Coordinator source allocation; reconcile against the accepted ordered ledger before any installation.
-- Company-specific template status only; native owner preserves counters, formats and issuance behavior.
CREATE FUNCTION app.employee_id_template_status_source(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.employee_id_config;result jsonb;
BEGIN
 IF app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR app.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Employee ID template unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM public.employee_id_config WHERE id=p_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR p.company_id IS NULL OR app.is_admin_for(p.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Employee ID template unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('configId',q.id,'companyId',q.company_id,'companyName',c.legal_name,'status',q.status,
 'fields',jsonb_build_object('companyId',q.company_id,'templateName',q.template_name,'prefix',q.prefix,'suffix',q.suffix,'startNumber',q.start_number,'numberLength',q.number_length,'increment',q.increment,'allowManualOverride',q.allow_manual_override,'currentRunningNumber',q.current_running_number,'createdAt',q.created_at),
 'revision',q.xmin::text,'companyRevision',c.xmin::text,
 'activePeers',jsonb_build_object('scopeCount',(SELECT count(*) FROM public.employee_id_config a WHERE a.tenant_id=q.tenant_id AND a.status='active' AND a.company_id=q.company_id),'prefixCount',(SELECT count(*) FROM public.employee_id_config a WHERE a.tenant_id=q.tenant_id AND a.status='active' AND a.prefix=q.prefix)),
 'authority',jsonb_build_object('configuration',(SELECT a.revision FROM public.access_configuration a WHERE a.tenant_id=q.tenant_id),'userRevision',(SELECT a.xmin::text FROM public.app_user a WHERE a.tenant_id=q.tenant_id AND a.id=app.current_user_id()),'roleRows',(SELECT jsonb_agg(jsonb_build_object('id',a.id,'role',a.role,'companyId',a.company_id,'revision',a.xmin::text) ORDER BY a.id) FROM public.role_assignment a WHERE a.tenant_id=q.tenant_id AND a.app_user_id=app.current_user_id()),'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.role,g.company_id) FROM app.current_grants() g))) INTO result
 FROM public.employee_id_config q JOIN public.company c ON c.id=q.company_id AND c.tenant_id=q.tenant_id WHERE q.id=p.id AND q.tenant_id=p.tenant_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.employee_id_template_status_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employee_id_template_status_source(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.employee_id_template_status_current_event(p_id uuid,p_status text) RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;proof uuid;matches integer;
BEGIN
 source:=app.employee_id_template_status_source(p_id);
 IF p_status IS NULL OR p_status NOT IN('active','inactive') THEN RAISE EXCEPTION 'Employee ID template event unavailable' USING ERRCODE='42501';END IF;
 SELECT count(*),min(d.id::text)::uuid INTO matches,proof FROM public.domain_event d JOIN public.employee_id_config c ON c.id=d.aggregate_id AND c.tenant_id=d.tenant_id
 WHERE c.id=p_id AND c.tenant_id=app.current_tenant_id() AND c.status=p_status AND c.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid
 AND d.aggregate_type='employee-id-config' AND d.event_type=CASE p_status WHEN 'active' THEN 'employee-id-config.activated' ELSE 'employee-id-config.deactivated' END
 AND d.actor_type='user' AND d.actor_id=app.current_user_id() AND d.subject_employment_id IS NULL AND d.payload=jsonb_build_object('status',p_status);
 IF matches<>1 THEN RAISE EXCEPTION 'Employee ID template event unavailable' USING ERRCODE='42501';END IF;RETURN proof;
END $$;
REVOKE ALL ON FUNCTION app.employee_id_template_status_current_event(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employee_id_template_status_current_event(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.employee_id_template_status_receipt(p_id uuid,p_event uuid,p_desired text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;result jsonb;
BEGIN
 source:=app.employee_id_template_status_source(p_id);
 IF p_desired IS NULL OR p_desired NOT IN('active','inactive') THEN RAISE EXCEPTION 'Employee ID template receipt unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('kind','recorded','configId',c.id,'companyId',c.company_id,'templateName',c.template_name,'prefix',c.prefix,'suffix',c.suffix,'status',c.status,'eventId',d.id,'semantics','native_employee_id_template_status_current_record') INTO result
 FROM public.employee_id_config c JOIN public.domain_event d ON d.tenant_id=c.tenant_id AND d.aggregate_id=c.id AND d.id=p_event
 WHERE c.id=p_id AND c.tenant_id=app.current_tenant_id() AND c.status=p_desired AND c.xmin=d.xmin AND d.aggregate_type='employee-id-config'
 AND d.event_type=CASE p_desired WHEN 'active' THEN 'employee-id-config.activated' ELSE 'employee-id-config.deactivated' END
 AND d.actor_type='user' AND d.actor_id=app.current_user_id() AND d.subject_employment_id IS NULL AND d.payload=jsonb_build_object('status',p_desired);
 IF result IS NULL THEN RAISE EXCEPTION 'Employee ID template receipt unavailable' USING ERRCODE='42501';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.employee_id_template_status_receipt(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employee_id_template_status_receipt(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Same encrypted physical ledger; explicit new-kind invariants, old expressions retained ONCE.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES('org.employee_id_template.status','org','approve','personnel','org.employee_id_template.status');
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN employee_id_template_desired_status text,
 ADD CONSTRAINT assistant_employee_id_template_desired_status CHECK(((action_kind='org.employee_id_template.status')=(employee_id_template_desired_status IS NOT NULL)) AND (employee_id_template_desired_status IS NULL OR employee_id_template_desired_status IN('active','inactive')));
--> statement-breakpoint
DO $$ DECLARE item record;previous text;scope_name text;matches integer;
BEGIN
 SELECT count(*),min(conname) INTO matches,scope_name FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND pg_get_expr(conbin,conrelid) LIKE '%testing_execution_id IS NOT NULL%' AND pg_get_expr(conbin,conrelid) LIKE '%employment_id IS NULL%';
 IF matches<>1 THEN RAISE EXCEPTION '0745: actor scope drift';END IF;
 FOR item IN SELECT * FROM (VALUES
 (scope_name,'employment_id IS NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL'),
 ('assistant_review_kind_columns','performance_ack_event_id IS NULL AND leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL'),
 ('assistant_review_decision_columns','decision_subject_person_id IS NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
 ('assistant_review_generic_receipt','receipt_subject_kind IS NOT DISTINCT FROM ''employee_id_config'' AND receipt_subject_id IS NOT NULL AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')) requirements(name,expression) LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=item.name;
  IF previous IS NULL THEN RAISE EXCEPTION '0745: missing %',item.name;END IF;
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK(CASE WHEN action_kind=''org.employee_id_template.status'' THEN (%s) ELSE (%s) END)',item.name,item.expression,previous);
 END LOOP;
END $$;
--> statement-breakpoint
DO $$ DECLARE predicate text;
BEGIN
 SELECT pg_get_expr(indpred,indrelid) INTO predicate FROM pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 IF predicate IS NULL THEN RAISE EXCEPTION '0745: pending index drift';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||predicate||') AND action_kind<>''org.employee_id_template.status''';
END $$;
CREATE UNIQUE INDEX assistant_employee_id_template_status_pending ON app.assistant_own_leave_review(tenant_id,user_id,receipt_subject_id) WHERE action_kind='org.employee_id_template.status' AND state='awaiting_confirmation';
--> statement-breakpoint

CREATE FUNCTION app._assistant_employee_id_template_status_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'companyId',r.company_id,'configId',r.receipt_subject_id,'status',r.employee_id_template_desired_status),'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,'eventId',r.receipt_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='org.employee_id_template.status';
$$;
REVOKE ALL ON FUNCTION app._assistant_employee_id_template_status_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_employee_id_template_status_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_config uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_desired text DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();stamp timestamptz;source jsonb;result jsonb;
BEGIN
 PERFORM app._assistant_pay_component_review_identity(NULL,false);
 IF p_operation IS NULL OR p_operation NOT IN('prepare','subject','read','discard','index','complete') THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',s.action_kind,'contractVersion',1,'actionId',s.id,'state',s.state,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.created_at DESC,s.id DESC),'[]'::jsonb) INTO result FROM
  (SELECT saved.* FROM app.assistant_own_leave_review saved JOIN public.employee_id_config p ON p.id=saved.receipt_subject_id AND p.tenant_id=saved.tenant_id AND p.company_id=saved.company_id
  WHERE saved.tenant_id=t AND saved.user_id=u AND saved.action_kind='org.employee_id_template.status' AND saved.person_id IS NOT DISTINCT FROM(SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t)
  AND app.is_admin() AND p.company_id IS NOT NULL AND app.is_admin_for(p.company_id)
  ORDER BY saved.created_at DESC,saved.id DESC LIMIT 25) s;RETURN result;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_pay_component_review_identity(p_person);
  source:=app.employee_id_template_status_source(p_config);
  IF p_company IS NULL OR (source->>'companyId')::uuid IS DISTINCT FROM p_company OR p_desired IS NULL OR p_desired NOT IN('active','inactive') OR p_desired=source->>'status' THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='22023';END IF;
  stamp:=clock_timestamp();
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE tenant_id=t AND user_id=u AND action_kind='org.employee_id_template.status' AND receipt_subject_id=p_config AND state='awaiting_confirmation' AND expires_at<=stamp;
  DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review expired WHERE c.action_id=expired.id AND expired.tenant_id=t AND expired.user_id=u AND expired.action_kind='org.employee_id_template.status' AND expired.receipt_subject_id=p_config AND expired.state='expired';
  IF(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>stamp)>=5 OR(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>stamp-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,company_id,receipt_subject_kind,receipt_subject_id,employee_id_template_desired_status,intent_digest,reviewed_digest,state,created_at,expires_at)
  VALUES('org.employee_id_template.status',p_id,t,u,p_person,p_company,'employee_id_config',p_config,p_desired,p_intent,p_reviewed,'awaiting_confirmation',stamp,stamp+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);RETURN app._assistant_employee_id_template_status_json(p_id);
 END IF;
 IF p_operation='subject' THEN SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.employee_id_template.status';
 ELSE SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.employee_id_template.status' FOR UPDATE NOWAIT;END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_pay_component_review_identity(r.person_id);
 IF p_operation<>'discard' THEN
  source:=app.employee_id_template_status_source(r.receipt_subject_id);
  IF(source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF p_operation='subject' THEN RETURN jsonb_build_object('configId',r.receipt_subject_id,'companyId',r.company_id);END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN IF r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) OR app.employee_id_template_status_current_event(r.receipt_subject_id,r.employee_id_template_desired_status) IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event WHERE id=r.id;
  ELSE RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Employee ID template review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 ELSIF p_operation='read' AND r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review ended WHERE c.action_id=ended.id AND ended.id=p_id AND ended.state<>'awaiting_confirmation';
 IF p_operation='discard' THEN SELECT jsonb_build_object('action',ended.action_kind,'contractVersion',1,'actionId',ended.id,'state',ended.state) INTO result FROM app.assistant_own_leave_review ended WHERE ended.id=p_id;RETURN result;END IF;
 RETURN app._assistant_employee_id_template_status_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_employee_id_template_status_command(text,uuid,uuid,uuid,uuid,text,text,text,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_employee_id_template_status_command(text,uuid,uuid,uuid,uuid,text,text,text,text,text,text,uuid) TO ai_hr_app;

--> statement-breakpoint
-- Extend closed outcome dispatch only for this genuine catalogue receipt.
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)','app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN marker:='WHEN ''employees.qualification.maintain'' THEN r.receipt_event_id';replacement:=marker||' WHEN ''org.employee_id_template.status'' THEN r.receipt_event_id';
  ELSE marker:='''employees.qualification.maintain''';replacement:=marker||',''org.employee_id_template.status''';END IF;
  IF(length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0745: closed outcome drift %',target;END IF;
  EXECUTE replace(definition,marker,replacement);
 END LOOP;
END $$;

--> statement-breakpoint
CREATE FUNCTION app.employee_id_template_status_entry_available() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND app.is_admin() AND EXISTS(SELECT 1 FROM public.employee_id_config c WHERE c.tenant_id=app.current_tenant_id() AND c.company_id IS NOT NULL AND app.is_admin_for(c.company_id));
$$;
REVOKE ALL ON FUNCTION app.employee_id_template_status_entry_available() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employee_id_template_status_entry_available() TO ai_hr_app;
