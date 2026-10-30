-- DRAFT ONLY: department allocation is pending; no executable tag/index/when is claimed.
-- Mounted System Labels catalogue custody; no new table, raw event grant or employee impersonation.
CREATE FUNCTION app.department_archive_grid_source(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.department;result jsonb;
BEGIN
 IF app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR app.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM public.department WHERE id=p_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.is_admin_for(p.company_id) IS NOT TRUE OR p.is_global OR EXISTS(SELECT 1 FROM public.label_company_assignment a WHERE a.tenant_id=p.tenant_id AND a.label_kind='department' AND a.label_id=p.id AND a.company_id<>p.company_id) THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('departmentId',q.id,'companyId',q.company_id,'companyName',c.legal_name,'name',q.name,'archived',q.archived_at IS NOT NULL,
 'inUse',EXISTS(SELECT 1 FROM public.assignment a WHERE a.tenant_id=q.tenant_id AND a.department_id=q.id AND a.superseded_at IS NULL),
 'fields',jsonb_build_object('name',q.name,'businessUnitId',q.business_unit_id,'headEmploymentId',q.head_employment_id,'parentDepartmentId',q.parent_department_id,'label',q.label,'description',q.description,'isGlobal',q.is_global,'companyId',q.company_id),
 'revision',q.xmin::text,'companyRevision',c.xmin::text,'routing',jsonb_build_object('headRevision',(SELECT e.xmin::text FROM public.employment e WHERE e.tenant_id=q.tenant_id AND e.id=q.head_employment_id AND e.company_id=q.company_id),'businessUnitRevision',(SELECT b.xmin::text FROM public.business_unit b WHERE b.tenant_id=q.tenant_id AND b.id=q.business_unit_id)),
 'criteria',coalesce((SELECT jsonb_agg(jsonb_build_object('companyId',a.company_id,'revision',a.xmin::text) ORDER BY a.company_id) FROM public.label_company_assignment a WHERE a.tenant_id=q.tenant_id AND a.label_kind='department' AND a.label_id=q.id),'[]'::jsonb),
 'epoch',coalesce((SELECT e.revision::text FROM public.system_label_criteria_epoch e WHERE e.tenant_id=q.tenant_id AND e.label_kind='department'),'0'),
 'authority',jsonb_build_object('configuration',(SELECT a.revision FROM public.access_configuration a WHERE a.tenant_id=q.tenant_id),'userRevision',(SELECT a.xmin::text FROM public.app_user a WHERE a.tenant_id=q.tenant_id AND a.id=app.current_user_id()),'roleRows',(SELECT jsonb_agg(jsonb_build_object('id',a.id,'role',a.role,'companyId',a.company_id,'revision',a.xmin::text) ORDER BY a.id) FROM public.role_assignment a WHERE a.tenant_id=q.tenant_id AND a.app_user_id=app.current_user_id()),'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.role,g.company_id) FROM app.current_grants() g))) INTO result
 FROM public.department q JOIN public.company c ON c.id=q.company_id AND c.tenant_id=q.tenant_id WHERE q.id=p.id AND q.tenant_id=p.tenant_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.department_archive_grid_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.department_archive_grid_source(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.department_archive_grid_current_event(p_id uuid,p_archived boolean) RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;proof uuid;matches integer;
BEGIN
 source:=app.department_archive_grid_source(p_id);
 SELECT count(*),min(d.id::text)::uuid INTO matches,proof FROM public.domain_event d JOIN public.department p ON p.id=d.aggregate_id AND p.tenant_id=d.tenant_id
 WHERE p.id=p_id AND p.tenant_id=app.current_tenant_id() AND (p.archived_at IS NOT NULL)=p_archived
 AND p.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid
 AND d.aggregate_type='department' AND d.event_type='department.updated' AND d.actor_type='user' AND d.actor_id=app.current_user_id() AND d.subject_employment_id IS NULL
 AND d.payload=jsonb_build_object('name',p.name,'archived',p_archived);
 IF matches<>1 THEN RAISE EXCEPTION 'Department event unavailable' USING ERRCODE='42501';END IF;
 RETURN proof;
END $$;
REVOKE ALL ON FUNCTION app.department_archive_grid_current_event(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.department_archive_grid_current_event(uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
-- Same encrypted physical ledger; explicit new-kind invariants, old expressions retained ONCE.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES('org.department.archive','org','approve','personnel','org.department.archive');
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN department_archive_desired boolean,
 ADD CONSTRAINT assistant_department_archive_desired CHECK((action_kind='org.department.archive')=(department_archive_desired IS NOT NULL));
--> statement-breakpoint
DO $$ DECLARE item record;previous text;scope_name text;matches integer;
BEGIN
 SELECT count(*),min(conname) INTO matches,scope_name FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND pg_get_expr(conbin,conrelid) LIKE '%testing_execution_id IS NOT NULL%' AND pg_get_expr(conbin,conrelid) LIKE '%employment_id IS NULL%';
 IF matches<>1 THEN RAISE EXCEPTION 'Department draft: actor scope drift';END IF;
 FOR item IN SELECT * FROM (VALUES
 (scope_name,'employment_id IS NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL'),
 ('assistant_review_kind_columns','performance_ack_event_id IS NULL AND leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL'),
 ('assistant_review_decision_columns','decision_subject_person_id IS NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
 ('assistant_review_generic_receipt','receipt_subject_kind IS NOT DISTINCT FROM ''department'' AND receipt_subject_id IS NOT NULL AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')) requirements(name,expression) LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=item.name;
  IF previous IS NULL THEN RAISE EXCEPTION 'Department draft: missing %',item.name;END IF;
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK(CASE WHEN action_kind=''org.department.archive'' THEN (%s) ELSE (%s) END)',item.name,item.expression,previous);
 END LOOP;
END $$;
--> statement-breakpoint
DO $$ DECLARE predicate text;
BEGIN
 SELECT pg_get_expr(indpred,indrelid) INTO predicate FROM pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 IF predicate IS NULL THEN RAISE EXCEPTION 'Department draft: pending index drift';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||predicate||') AND action_kind<>''org.department.archive''';
END $$;
CREATE UNIQUE INDEX assistant_department_archive_pending ON app.assistant_own_leave_review(tenant_id,user_id,receipt_subject_id) WHERE action_kind='org.department.archive' AND state='awaiting_confirmation';
--> statement-breakpoint
CREATE FUNCTION app.department_archive_grid_receipt(p_id uuid,p_event uuid,p_desired boolean) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;result jsonb;
BEGIN
 source:=app.department_archive_grid_source(p_id);
 SELECT jsonb_build_object('kind','recorded','departmentId',p.id,'companyId',p.company_id,'name',p.name,'archived',p.archived_at IS NOT NULL,'eventId',d.id,'semantics','native_department_archive_current_record') INTO result
 FROM public.department p JOIN public.domain_event d ON d.tenant_id=p.tenant_id AND d.aggregate_id=p.id AND d.id=p_event
 WHERE p.id=p_id AND p.tenant_id=app.current_tenant_id() AND (p.archived_at IS NOT NULL)=p_desired
 AND p.xmin=d.xmin AND d.actor_type='user' AND d.actor_id=app.current_user_id() AND d.aggregate_type='department' AND d.event_type='department.updated' AND d.subject_employment_id IS NULL AND d.payload=jsonb_build_object('name',p.name,'archived',p_desired);
 IF result IS NULL THEN RAISE EXCEPTION 'Department receipt unavailable' USING ERRCODE='42501';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.department_archive_grid_receipt(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.department_archive_grid_receipt(uuid,uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_department_archive_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'companyId',r.company_id,'departmentId',r.receipt_subject_id,'archived',r.department_archive_desired),'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,'eventId',r.receipt_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='org.department.archive';
$$;
REVOKE ALL ON FUNCTION app._assistant_department_archive_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_department_archive_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_department uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_desired boolean DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();stamp timestamptz;source jsonb;result jsonb;
BEGIN
 PERFORM app._assistant_pay_component_review_identity(NULL,false);
 IF p_operation IS NULL OR p_operation NOT IN('prepare','subject','read','discard','index','complete') THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',s.action_kind,'contractVersion',1,'actionId',s.id,'state',s.state,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.created_at DESC,s.id DESC),'[]'::jsonb) INTO result FROM
  (SELECT saved.* FROM app.assistant_own_leave_review saved JOIN public.department p ON p.id=saved.receipt_subject_id AND p.tenant_id=saved.tenant_id AND p.company_id=saved.company_id
  WHERE saved.tenant_id=t AND saved.user_id=u AND saved.action_kind='org.department.archive' AND saved.person_id IS NOT DISTINCT FROM(SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t)
  AND app.is_admin() AND app.is_admin_for(p.company_id) AND NOT p.is_global AND NOT EXISTS(SELECT 1 FROM public.label_company_assignment a WHERE a.tenant_id=t AND a.label_kind='department' AND a.label_id=p.id AND a.company_id<>p.company_id)
  ORDER BY saved.created_at DESC,saved.id DESC LIMIT 25) s;RETURN result;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_pay_component_review_identity(p_person);
  source:=app.department_archive_grid_source(p_department);
  IF p_company IS NULL OR (source->>'companyId')::uuid IS DISTINCT FROM p_company OR p_desired IS NULL OR p_desired=(source->>'archived')::boolean OR(p_desired AND(source->>'inUse')::boolean) THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='22023';END IF;
  stamp:=clock_timestamp();
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE tenant_id=t AND user_id=u AND action_kind='org.department.archive' AND receipt_subject_id=p_department AND state='awaiting_confirmation' AND expires_at<=stamp;
  DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review expired WHERE c.action_id=expired.id AND expired.tenant_id=t AND expired.user_id=u AND expired.action_kind='org.department.archive' AND expired.receipt_subject_id=p_department AND expired.state='expired';
  IF(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>stamp)>=5 OR(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>stamp-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,company_id,receipt_subject_kind,receipt_subject_id,department_archive_desired,intent_digest,reviewed_digest,state,created_at,expires_at)
  VALUES('org.department.archive',p_id,t,u,p_person,p_company,'department',p_department,p_desired,p_intent,p_reviewed,'awaiting_confirmation',stamp,stamp+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);RETURN app._assistant_department_archive_json(p_id);
 END IF;
 IF p_operation='subject' THEN SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.department.archive';
 ELSE SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.department.archive' FOR UPDATE NOWAIT;END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_pay_component_review_identity(r.person_id);
 IF p_operation<>'discard' THEN
  source:=app.department_archive_grid_source(r.receipt_subject_id);
  IF(source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF p_operation='subject' THEN RETURN jsonb_build_object('departmentId',r.receipt_subject_id,'companyId',r.company_id);END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN IF r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) OR app.department_archive_grid_current_event(r.receipt_subject_id,r.department_archive_desired) IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event WHERE id=r.id;
  ELSE RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Department review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 ELSIF p_operation='read' AND r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review ended WHERE c.action_id=ended.id AND ended.id=p_id AND ended.state<>'awaiting_confirmation';
 IF p_operation='discard' THEN SELECT jsonb_build_object('action',ended.action_kind,'contractVersion',1,'actionId',ended.id,'state',ended.state) INTO result FROM app.assistant_own_leave_review ended WHERE ended.id=p_id;RETURN result;END IF;
 RETURN app._assistant_department_archive_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_department_archive_command(text,uuid,uuid,uuid,uuid,boolean,text,text,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_department_archive_command(text,uuid,uuid,uuid,uuid,boolean,text,text,text,text,text,uuid) TO ai_hr_app;

--> statement-breakpoint
-- Extend closed outcome dispatch only for this genuine catalogue receipt.
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)','app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN marker:='WHEN ''employees.qualification.maintain'' THEN r.receipt_event_id';replacement:=marker||' WHEN ''org.department.archive'' THEN r.receipt_event_id';
  ELSE marker:='''employees.qualification.maintain''';replacement:=marker||',''org.department.archive''';END IF;
  IF(length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Department draft: closed outcome drift %',target;END IF;
  EXECUTE replace(definition,marker,replacement);
 END LOOP;
END $$;

--> statement-breakpoint
CREATE FUNCTION app.department_archive_entry_available() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND app.is_admin() AND EXISTS(
 SELECT 1 FROM public.department p WHERE p.tenant_id=app.current_tenant_id() AND app.is_admin_for(p.company_id) AND NOT p.is_global
 AND NOT EXISTS(SELECT 1 FROM public.label_company_assignment a WHERE a.tenant_id=p.tenant_id AND a.label_kind='department' AND a.label_id=p.id AND a.company_id<>p.company_id));
$$;
REVOKE ALL ON FUNCTION app.department_archive_entry_available() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.department_archive_entry_available() TO ai_hr_app;
