-- PROVISIONAL SOURCE reservation 0726 / idx707 / when1793330000055. No installation priority.
-- One complete replace/clear using the unchanged 0675 owner; no intercompany JSON/payroll effects.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('employees.cost_allocation.maintain','employees','approve','personnel','employees.cost_allocation.maintain');
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN allocation_effective_date date,
 ADD COLUMN allocation_effective_company_id uuid,
 ADD CONSTRAINT assistant_cost_allocation_company_fk FOREIGN KEY(allocation_effective_company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 ADD CONSTRAINT assistant_cost_allocation_nomination CHECK (CASE WHEN action_kind='employees.cost_allocation.maintain' THEN allocation_effective_date IS NOT NULL AND allocation_effective_company_id IS NOT NULL ELSE allocation_effective_date IS NULL AND allocation_effective_company_id IS NULL END);
--> statement-breakpoint
-- Boolean only, before even minimal timeline metadata. No cross-tenant enumeration; a genuinely
-- authenticated USER need not have a linked PERSON. Extra all-ACTIVE-company VIEW is intentional.
CREATE FUNCTION app.employment_cost_allocation_review_visible(p_employment uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND EXISTS(
 SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
 AND app.access_workforce_employment(e.id,'workforce.view') AND app.access_workforce_employment(e.id,'workforce.maintain')
 AND NOT EXISTS(SELECT 1 FROM public.employment_cost_allocation_set s WHERE s.employment_id=e.id AND s.tenant_id=e.tenant_id AND s.superseded_at IS NULL AND app.access_workforce_company(s.company_id,'workforce.view') IS NOT TRUE));
$$;
REVOKE ALL ON FUNCTION app.employment_cost_allocation_review_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employment_cost_allocation_review_visible(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Native positive capability projection. This does not grant raw personnel/assignment reads or
-- change system provisioning. Canonical INVOKER date proof runs inside this separately fenced owner.
CREATE FUNCTION app.employment_cost_allocation_subject(p_employment uuid,p_date date,p_write boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;dated uuid;operation text:=CASE WHEN p_write THEN 'workforce.maintain' ELSE 'workforce.view' END;
BEGIN
 IF app.current_user_id() IS NULL OR app.current_tenant_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Allocation access denied' USING ERRCODE='42501';END IF;
 IF p_write THEN PERFORM app.access_workforce_write_lock();END IF;
 IF app.access_workforce_employment(p_employment,operation) IS NOT TRUE THEN RAISE EXCEPTION 'Allocation access denied' USING ERRCODE='42501';END IF;
 IF p_write THEN SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 ELSE SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Allocation access denied' USING ERRCODE='42501';END IF;
 SELECT proof.company_id INTO dated FROM app.proven_company_date_points(jsonb_build_array(jsonb_build_object('employmentId',e.id,'date',p_date))) proof WHERE proof.employment_id=e.id AND proof.on_date=p_date AND proof.reason IS NULL;
 IF dated IS NULL OR app.access_workforce_company(dated,operation) IS NOT TRUE OR (p_write AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=dated AND c.tenant_id=e.tenant_id AND c.archived_at IS NULL)) THEN RAISE EXCEPTION 'Allocation dated company unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('employment',jsonb_build_object('id',e.id,'personId',e.person_id,'companyId',e.company_id,'hiredOn',e.hired_on,'terminatedOn',e.terminated_on),'companyId',dated);
END $$;
REVOKE ALL ON FUNCTION app.employment_cost_allocation_subject(uuid,date,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employment_cost_allocation_subject(uuid,date,boolean) TO ai_hr_app;
--> statement-breakpoint
-- Preserve every predecessor's column rules once, including nullable actor branches.
-- Bounded canonical eight-field branch; predecessor remains exactly once in ELSE.
DO $$ DECLARE item record;previous text;scope_name text;matches integer;
BEGIN
 SELECT count(*),min(conname) INTO matches,scope_name FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND pg_get_expr(conbin,conrelid) LIKE '%testing_execution_id IS NOT NULL%' AND pg_get_expr(conbin,conrelid) LIKE '%employment_id IS NULL%';
 IF matches<>1 THEN RAISE EXCEPTION '0726: actor scope drift';END IF;
 FOR item IN SELECT * FROM (VALUES
 (scope_name,'employment_id IS NOT NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL'),
 ('assistant_review_kind_columns','leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND performance_ack_event_id IS NULL'),
 ('assistant_review_decision_columns','decision_subject_person_id IS NOT NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
 ('assistant_review_generic_receipt','receipt_subject_kind=''employment'' AND receipt_subject_id=employment_id AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')) requirements(name,expression) LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=item.name;
  IF previous IS NULL THEN RAISE EXCEPTION '0726: missing %',item.name;END IF;
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''employees.cost_allocation.maintain'' THEN (%s) ELSE (%s) END)',item.name,item.expression,previous);
 END LOOP;
END $$;
--> statement-breakpoint
DO $$ DECLARE generic_predicate text;assigned_predicate text;
BEGIN
 SELECT pg_get_expr(indpred,indrelid) INTO generic_predicate FROM pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 SELECT pg_get_expr(indpred,indrelid) INTO assigned_predicate FROM pg_index WHERE indexrelid='app.assistant_review_assigned_pending_subject'::regclass;
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION '0726: missing pending indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''employees.cost_allocation.maintain''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') OR (action_kind=''employees.cost_allocation.maintain'' AND state=''awaiting_confirmation'' AND receipt_subject_id IS NOT NULL)';
END $$;
--> statement-breakpoint
-- Minimal command authority, no role floor. Before any return prove the real person, date/company,
-- retained current-company identity, current user and the all-active-company view witness.
CREATE FUNCTION app._assistant_cost_allocation_scope(p_employment uuid,p_date date,p_company uuid,p_current_company uuid DEFAULT NULL,p_subject_person uuid DEFAULT NULL) RETURNS void
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.employment_cost_allocation_review_visible(p_employment) IS NOT TRUE OR app.access_workforce_company(p_company,'workforce.maintain') IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.company c ON c.id=p_company AND c.tenant_id=e.tenant_id AND c.archived_at IS NULL
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND (p_current_company IS NULL OR e.company_id=p_current_company)
 AND (p_subject_person IS NULL OR e.person_id=p_subject_person) AND p_date>=e.hired_on AND (e.terminated_on IS NULL OR p_date<=e.terminated_on)
 AND NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=e.tenant_id AND a.person_id=e.person_id)
 AND EXISTS(SELECT 1 FROM app.proven_company_date_points(jsonb_build_array(jsonb_build_object('employmentId',e.id,'date',p_date))) proof WHERE proof.employment_id=e.id AND proof.on_date=p_date AND proof.company_id=p_company AND proof.reason IS NULL))
 THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_cost_allocation_scope(uuid,date,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.cost_allocation_review_lock(p_employment uuid,p_date date,p_company uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 PERFORM 1 FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 PERFORM app._assistant_cost_allocation_scope(p_employment,p_date,p_company);
 IF (SELECT count(*) FROM public.employment_cost_allocation_set WHERE employment_id=p_employment AND tenant_id=app.current_tenant_id() AND superseded_at IS NULL)>100 OR (SELECT count(*) FROM public.assignment WHERE employment_id=p_employment AND tenant_id=app.current_tenant_id() AND superseded_at IS NULL)>1000 THEN RAISE EXCEPTION 'Allocation timeline requires native handoff' USING ERRCODE='54000';END IF;
 PERFORM 1 FROM public.company WHERE id=p_company AND tenant_id=app.current_tenant_id() FOR SHARE;
 PERFORM 1 FROM public.assignment WHERE employment_id=p_employment AND tenant_id=app.current_tenant_id() AND superseded_at IS NULL ORDER BY valid_from,id FOR SHARE;
 PERFORM 1 FROM public.employment_cost_allocation_head WHERE employment_id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 PERFORM 1 FROM public.employment_cost_allocation_set WHERE employment_id=p_employment AND tenant_id=app.current_tenant_id() AND superseded_at IS NULL ORDER BY valid_from,revision FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION app.cost_allocation_review_lock(uuid,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cost_allocation_review_lock(uuid,date,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.cost_allocation_review_identity(p_employment uuid,p_date date,p_company uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app._assistant_cost_allocation_scope(p_employment,p_date,p_company);
 SELECT jsonb_build_object('subjectId',e.id,'employmentId',e.id,'companyId',e.company_id,'subjectPersonId',e.person_id,'effectiveDate',p_date,'effectiveCompanyId',p_company,'employeeName',p.full_name,'employeeCode',e.employee_code,'companyName',c.legal_name,'effectiveCompanyName',dated.legal_name) INTO result FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id JOIN public.company dated ON dated.id=p_company AND dated.tenant_id=e.tenant_id WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id();
 IF result IS NULL THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.cost_allocation_review_identity(uuid,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cost_allocation_review_identity(uuid,date,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Native-owned event projection avoids a new broad audit RLS grant for positive non-HR maintainers.
-- Current proof covers only changed tuples; historical recovery uses the immutable native event/set.
CREATE FUNCTION app.cost_allocation_review_receipt(p_employment uuid,p_event uuid,p_current boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.domain_event;s public.employment_cost_allocation_set;x xid:=pg_current_xact_id()::xid;dx xid;sx xid;vx xid;old jsonb;v public.employment_cost_allocation_set;expected_next date;actual_rows jsonb;
BEGIN
 IF app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO d FROM public.domain_event WHERE id=p_event AND tenant_id=app.current_tenant_id() AND aggregate_type='employment' AND aggregate_id=p_employment AND subject_employment_id=p_employment AND event_type='employment.cost-allocations.changed' AND actor_type='user' AND actor_id=app.current_user_id();
 IF NOT FOUND OR d.payload->>'source' IS DISTINCT FROM 'manual' THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_cost_allocation_scope(p_employment,(d.payload->>'effectiveDate')::date,(d.payload->>'companyId')::uuid);
 SELECT * INTO s FROM public.employment_cost_allocation_set WHERE id=(d.payload->'after'->>'setId')::uuid AND tenant_id=d.tenant_id AND employment_id=p_employment AND company_id=(d.payload->>'companyId')::uuid AND valid_from=(d.payload->>'effectiveDate')::date AND revision=(d.payload->>'revision')::integer AND operation=d.payload->>'operation' AND source='manual' AND created_by=d.actor_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('costCenterId',r.cost_center_id,'hundredths',r.hundredths) ORDER BY r.cost_center_id),'[]'::jsonb) INTO actual_rows FROM public.employment_cost_allocation_row r WHERE r.set_id=s.id AND r.tenant_id=s.tenant_id;
 IF actual_rows IS DISTINCT FROM d.payload->'after'->'rows' OR (s.operation='clear' AND jsonb_array_length(actual_rows)<>0) OR (s.operation='replace' AND jsonb_array_length(actual_rows)=0) THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
 IF p_current THEN
  SELECT xmin INTO dx FROM public.domain_event WHERE id=d.id AND tenant_id=d.tenant_id;
  SELECT xmin INTO sx FROM public.employment_cost_allocation_set WHERE id=s.id AND tenant_id=s.tenant_id;
  IF (SELECT count(*) FROM public.domain_event other WHERE other.tenant_id=d.tenant_id AND other.aggregate_type='employment' AND other.aggregate_id=p_employment AND other.subject_employment_id=p_employment AND other.event_type='employment.cost-allocations.changed' AND other.payload->'after'->>'setId'=s.id::text)<>1
   OR EXISTS(SELECT 1 FROM public.employment_cost_allocation_row r LEFT JOIN public.cost_center c ON c.id=r.cost_center_id AND c.tenant_id=r.tenant_id WHERE r.set_id=s.id AND r.tenant_id=s.tenant_id AND (c.id IS NULL OR c.archived_at IS NOT NULL OR r.code_snapshot IS DISTINCT FROM c.code OR r.label_snapshot IS DISTINCT FROM coalesce(nullif(trim(c.label),''),c.code)))
   OR EXISTS(SELECT 1 FROM public.employment_cost_allocation_set prior WHERE prior.tenant_id=s.tenant_id AND prior.employment_id=p_employment AND prior.id<>s.id AND (prior.superseded_at IS NULL OR prior.xmin=x) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(nullif(d.payload->'before','null'::jsonb),'[]'::jsonb)) j WHERE j->>'setId'=prior.id::text))
   THEN RAISE EXCEPTION 'Allocation native event proof unavailable' USING ERRCODE='42501';END IF;
  IF dx<>x OR sx<>x OR s.superseded_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.employment_cost_allocation_head h WHERE h.employment_id=p_employment AND h.tenant_id=d.tenant_id AND h.revision=s.revision AND h.xmin=x)
   OR EXISTS(SELECT 1 FROM public.employment_cost_allocation_row r WHERE r.set_id=s.id AND r.tenant_id=s.tenant_id AND r.xmin<>x) THEN RAISE EXCEPTION 'Allocation current proof unavailable' USING ERRCODE='42501';END IF;
  SELECT min((j->>'validFrom')::date) INTO expected_next FROM jsonb_array_elements(coalesce(nullif(d.payload->'before','null'::jsonb),'[]'::jsonb)) j WHERE (j->>'validFrom')::date>s.valid_from;
  IF s.valid_to IS DISTINCT FROM expected_next THEN RAISE EXCEPTION 'Allocation interval proof unavailable' USING ERRCODE='42501';END IF;
  FOR old IN SELECT * FROM jsonb_array_elements(coalesce(nullif(d.payload->'before','null'::jsonb),'[]'::jsonb)) LOOP
   SELECT * INTO v FROM public.employment_cost_allocation_set WHERE id=(old->>'setId')::uuid AND tenant_id=s.tenant_id AND employment_id=p_employment AND revision=(old->>'revision')::integer AND valid_from=(old->>'validFrom')::date;
   IF NOT FOUND THEN RAISE EXCEPTION 'Allocation predecessor unavailable' USING ERRCODE='42501';END IF;
   SELECT xmin INTO vx FROM public.employment_cost_allocation_set WHERE id=v.id AND tenant_id=v.tenant_id;
   IF v.valid_from=s.valid_from THEN
    IF v.superseded_at IS NULL OR vx<>x OR v.valid_to IS DISTINCT FROM (old->>'validTo')::date THEN RAISE EXCEPTION 'Allocation supersession proof unavailable' USING ERRCODE='42501';END IF;
   ELSIF v.valid_from<s.valid_from AND ((old->>'validTo') IS NULL OR (old->>'validTo')::date>s.valid_from) THEN
    IF v.superseded_at IS NOT NULL OR vx<>x OR v.valid_to IS DISTINCT FROM s.valid_from THEN RAISE EXCEPTION 'Allocation closure proof unavailable' USING ERRCODE='42501';END IF;
   ELSIF v.superseded_at IS NOT NULL OR v.valid_to IS DISTINCT FROM (old->>'validTo')::date THEN RAISE EXCEPTION 'Allocation untouched interval changed' USING ERRCODE='42501';END IF;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('kind','maintained','employmentId',p_employment,'subjectId',p_employment,'eventId',d.id,'setId',s.id,'effectiveCompanyId',s.company_id,'effectiveDate',s.valid_from,'revision',s.revision,'operation',s.operation);
END $$;
REVOKE ALL ON FUNCTION app.cost_allocation_review_receipt(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cost_allocation_review_receipt(uuid,uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.cost_allocation_review_saved_receipt(p_employment uuid,p_set uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event_id uuid;matches integer;
BEGIN
 IF app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
 SELECT count(*),(array_agg(id))[1] INTO matches,event_id FROM public.domain_event WHERE tenant_id=app.current_tenant_id() AND aggregate_type='employment' AND aggregate_id=p_employment AND subject_employment_id=p_employment AND event_type='employment.cost-allocations.changed' AND actor_type='user' AND actor_id=app.current_user_id() AND xmin=pg_current_xact_id()::xid AND payload->'after'->>'setId'=p_set::text;
 IF matches<>1 THEN RAISE EXCEPTION 'Allocation receipt unavailable' USING ERRCODE='42501';END IF;
 RETURN app.cost_allocation_review_receipt(p_employment,event_id,true);
END $$;
REVOKE ALL ON FUNCTION app.cost_allocation_review_saved_receipt(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cost_allocation_review_saved_receipt(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_cost_allocation_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'subjectPersonId',r.decision_subject_person_id,'effectiveDate',r.allocation_effective_date,'effectiveCompanyId',r.allocation_effective_company_id),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,'eventId',r.receipt_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='employees.cost_allocation.maintain';
$$;
REVOKE ALL ON FUNCTION app._assistant_cost_allocation_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_cost_allocation_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_employment uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_subject_person uuid DEFAULT NULL,p_date date DEFAULT NULL,p_effective_company uuid DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();at_time timestamptz;output jsonb;receipt jsonb;
BEGIN
 PERFORM app._assistant_multi_cycle_run_review_identity(NULL,false);
 IF p_operation IS NULL OR p_operation NOT IN('prepare','subject','read','discard','index','complete') THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',action_kind,'contractVersion',1,'actionId',id,'state',state,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO output FROM (SELECT r.* FROM app.assistant_own_leave_review r JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id AND e.person_id=r.decision_subject_person_id AND e.company_id=r.company_id
  WHERE r.tenant_id=t AND r.user_id=u AND r.action_kind='employees.cost_allocation.maintain' AND r.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t) AND r.decision_subject_person_id IS DISTINCT FROM r.person_id
  AND app.employment_cost_allocation_review_visible(r.employment_id) AND app.access_workforce_company(r.allocation_effective_company_id,'workforce.maintain') AND EXISTS(SELECT 1 FROM app.proven_company_date_points(jsonb_build_array(jsonb_build_object('employmentId',e.id,'date',r.allocation_effective_date))) proof WHERE proof.employment_id=e.id AND proof.company_id=r.allocation_effective_company_id AND proof.reason IS NULL) ORDER BY r.created_at DESC,r.id DESC LIMIT 25) selected;
  RETURN output;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_multi_cycle_run_review_identity(p_person);
  PERFORM app._assistant_cost_allocation_scope(p_employment,p_date,p_effective_company,p_company,p_subject_person);
  IF p_employment IS NULL OR p_company IS NULL OR p_subject_person IS NULL OR p_date IS NULL OR p_effective_company IS NULL OR p_subject_person IS NOT DISTINCT FROM p_person THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id IN(p_person,p_subject_person)) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id IN(p_person,p_subject_person)) THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='22023';END IF;
  at_time:=clock_timestamp();
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE tenant_id=t AND user_id=u AND action_kind='employees.cost_allocation.maintain' AND receipt_subject_id=p_employment AND state='awaiting_confirmation' AND expires_at<=at_time;
  DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review expired WHERE c.action_id=expired.id AND expired.tenant_id=t AND expired.user_id=u AND expired.action_kind='employees.cost_allocation.maintain' AND expired.receipt_subject_id=p_employment AND expired.state='expired';
  IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5 OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,decision_subject_person_id,receipt_subject_kind,receipt_subject_id,allocation_effective_date,allocation_effective_company_id,intent_digest,reviewed_digest,state,created_at,expires_at)
  VALUES('employees.cost_allocation.maintain',p_id,t,u,p_person,p_employment,p_company,p_subject_person,'employment',p_employment,p_date,p_effective_company,p_intent,p_reviewed,'awaiting_confirmation',at_time,at_time+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);
  RETURN app._assistant_cost_allocation_json(p_id);
 END IF;
 IF p_operation='subject' THEN SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='employees.cost_allocation.maintain';
 ELSE SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='employees.cost_allocation.maintain' FOR UPDATE NOWAIT;END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_multi_cycle_run_review_identity(r.person_id);
 -- Like the existing assigned lifecycle, an actor may retire their own ciphertext after native
 -- authority or Assistant allowance is lost. Retirement never unwraps or returns a private body.
 IF p_operation<>'discard' THEN PERFORM app._assistant_cost_allocation_scope(r.employment_id,r.allocation_effective_date,r.allocation_effective_company_id,r.company_id,r.decision_subject_person_id);END IF;
 IF p_operation='subject' THEN RETURN jsonb_build_object('employmentId',r.employment_id,'effectiveDate',r.allocation_effective_date,'effectiveCompanyId',r.allocation_effective_company_id);END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN IF r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
   receipt:=app.cost_allocation_review_receipt(r.employment_id,p_event,true);
   IF receipt->>'effectiveDate' IS DISTINCT FROM r.allocation_effective_date::text OR receipt->>'effectiveCompanyId' IS DISTINCT FROM r.allocation_effective_company_id::text THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event WHERE id=r.id;
  ELSE RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Allocation review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 ELSIF p_operation='read' AND r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 IF p_operation='discard' THEN SELECT jsonb_build_object('action',action_kind,'contractVersion',1,'actionId',id,'state',state) INTO output FROM app.assistant_own_leave_review WHERE id=r.id;RETURN output;END IF;
 RETURN app._assistant_cost_allocation_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_cost_allocation_command(text,uuid,uuid,uuid,uuid,uuid,date,uuid,text,text,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_cost_allocation_command(text,uuid,uuid,uuid,uuid,uuid,date,uuid,text,text,text,text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Add only this outcome to existing closed owners; their other kinds and route bounds survive.
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)','app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN marker:='WHEN ''employees.qualification.maintain'' THEN r.receipt_event_id';replacement:=marker||' WHEN ''employees.cost_allocation.maintain'' THEN r.receipt_event_id';
  ELSE marker:='''employees.qualification.maintain''';replacement:=marker||',''employees.cost_allocation.maintain''';END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0726: outcome owner drift %',target;END IF;
  EXECUTE replace(definition,marker,replacement);
 END LOOP;
END $$;

--> statement-breakpoint
-- Private minimal native versions; the reviewed full timeline is authorized before this projection.
CREATE FUNCTION app.cost_allocation_review_context(p_employment uuid,p_date date,p_company uuid,p_rows jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app._assistant_cost_allocation_scope(p_employment,p_date,p_company);
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>100 THEN RAISE EXCEPTION 'Allocation context unavailable' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE jsonb_typeof(j) IS DISTINCT FROM 'object' OR jsonb_typeof(j->'costCenterId') IS DISTINCT FROM 'string' OR jsonb_typeof(j->'hundredths') IS DISTINCT FROM 'number' OR coalesce(j->>'hundredths','') !~ '^[0-9]+$' OR (SELECT count(*) FROM jsonb_object_keys(j))<>2)
 OR (SELECT count(DISTINCT picked."costCenterId") FROM jsonb_to_recordset(p_rows) picked("costCenterId" uuid))<>jsonb_array_length(p_rows)
 OR EXISTS(SELECT 1 FROM jsonb_to_recordset(p_rows) picked(hundredths integer) WHERE picked.hundredths<=0 OR picked.hundredths>10000)
 OR (SELECT coalesce(sum(picked.hundredths),0) FROM jsonb_to_recordset(p_rows) picked(hundredths integer))>10000 THEN RAISE EXCEPTION 'Allocation context input unavailable' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_rows) picked("costCenterId" uuid) WHERE NOT EXISTS(SELECT 1 FROM public.cost_center c WHERE c.id=picked."costCenterId" AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND (c.is_global OR EXISTS(SELECT 1 FROM public.label_company_assignment l WHERE l.tenant_id=c.tenant_id AND l.label_kind='cost_center' AND l.label_id=c.id AND l.company_id=p_company)))) THEN RAISE EXCEPTION 'Allocation label unavailable' USING ERRCODE='42501';END IF;
 IF (SELECT count(*) FROM public.assignment a WHERE a.employment_id=p_employment AND a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL)>1000 OR (SELECT count(*) FROM public.label_company_assignment l WHERE l.tenant_id=app.current_tenant_id() AND l.label_kind='cost_center' AND l.label_id IN(SELECT (j->>'costCenterId')::uuid FROM jsonb_array_elements(p_rows) j))>10000 THEN RAISE EXCEPTION 'Allocation source requires native handoff' USING ERRCODE='54000';END IF;
 SELECT jsonb_build_object(
 'employment',(select jsonb_build_object('id',e.id,'personId',e.person_id,'companyId',e.company_id,'hiredOn',e.hired_on,'terminatedOn',e.terminated_on,'version',e.xmin::text) from employment e where e.id=p_employment and e.tenant_id=app.current_tenant_id()),
 'company',(select jsonb_build_object('id',c.id,'name',c.legal_name,'archivedAt',c.archived_at,'version',c.xmin::text) from company c where c.id=p_company and c.tenant_id=app.current_tenant_id()),
 'assignments',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'companyId',a.company_id,'validFrom',a.valid_from,'validTo',a.valid_to,'version',a.xmin::text) order by a.valid_from,a.id),'[]'::jsonb) from assignment a where a.employment_id=p_employment and a.tenant_id=app.current_tenant_id() and a.superseded_at is null),
 'criteria',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'labelId',l.label_id,'companyId',l.company_id) order by l.company_id,l.id),'[]'::jsonb) from label_company_assignment l where l.tenant_id=app.current_tenant_id() and l.label_kind='cost_center' and l.label_id in (select (x->>'costCenterId')::uuid from jsonb_array_elements(p_rows) x)),
 'labels',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'label',c.label,'isGlobal',c.is_global,'archivedAt',c.archived_at,'version',c.xmin::text) order by c.id),'[]'::jsonb) from cost_center c where c.tenant_id=app.current_tenant_id() and c.id in (select (x->>'costCenterId')::uuid from jsonb_array_elements(p_rows) x)),
 'configuration',(select jsonb_build_object('revision',a.revision,'initialized',a.initialized) from access_configuration a where a.tenant_id=app.current_tenant_id())) INTO result;
 IF octet_length(result::text)>1000000 THEN RAISE EXCEPTION 'Allocation context requires native handoff' USING ERRCODE='54000';END IF;
 -- Coordination epochs are absent. Real criteria/history/policy are bound only through an opaque
 -- closed hash; public EXECUTE must never disclose other-company assignment or policy metadata.
 RETURN jsonb_build_object('version',1,'sourceDigest',encode(sha256(convert_to(result::text,'UTF8')),'hex'),
 'labels',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'label',c.label,'version',c.xmin::text) ORDER BY c.id),'[]'::jsonb) FROM public.cost_center c WHERE c.tenant_id=app.current_tenant_id() AND c.id IN(SELECT picked."costCenterId" FROM jsonb_to_recordset(p_rows) picked("costCenterId" uuid))));
END $$;
REVOKE ALL ON FUNCTION app.cost_allocation_review_context(uuid,date,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cost_allocation_review_context(uuid,date,uuid,jsonb) TO ai_hr_app;
