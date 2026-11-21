-- Probation outcomes on the shared workflow runner (lane D2 / W2; ADR docs/adr/2026-11-15-probation-shared-automation.md
-- decision 4 and build step 4; handoff B4). Tag 5753 / idx 5153 / when 1793330005453.
--
-- core/probation-automation.ts runs the shared workflows (lib/automation/runtime.ts, migration 5748) when an outcome is
-- decided and resumes the frozen remaining steps when its letter is released. This migration gives that runner what it
-- needs, all authorized by app.automation_can_run('probation', case) (the storage runner or a person with case access):
--  1. app.probation_automation_context(case): the case's holders, organisation ids and names, people names, fallback and
--     posting-approver groups, live routings, assignment groups with their active members and the Probation email
--     templates, bounded (500 routings, 200 groups x 500 members, 500 templates).
--  2. app.probation_automation_notify(case, part, key, kind, users): a Send email / Notify step through the existing
--     Probation transport (probation_occurrence + probation.notification-due), idempotent on the key.
--  3. app.probation_notification_recipients (5752 body): delivers those occurrences (kind `automation`) to the users the
--     runner resolved who are still active, also after the case closed.
--  4. app.probation_outcome_automation(outcome): whether the outcome has runs (waiting, failed) and the posting and
--     offboarding case they created; outcomes decided before this shipped have none and keep the old effect path.
--     app.probation_record_posting_effect(outcome, posting, handoff, next, new part): the outcome effect for an outcome
--     whose run created a Personnel posting instead of writing the movement: Confirm and Non-confirmation close the
--     case, Extend adds the extension, moves the end date and schedules the next Part 3; the pending posting is kept on
--     the case (pendingPosting) and the outcome records `posting:<id>`. Outcomes without a run keep
--     app.probation_record_effect unchanged.
--  5. Trigger probation_posting_approved on personnel_posting: when a Probation posting is approved, the case's pending
--     posting state is cleared in the same transaction and audited (the movement page's promise).
-- No table, row, grant or purpose-owned object changes besides the new trigger; the new functions are owner-owned, the
-- runner's three are granted to ai_hr_app and the trigger function is owner only.
CREATE FUNCTION app.probation_automation_context(p_case uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();c probation_case;h jsonb;result jsonb;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF app.automation_can_run('probation',p_case) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=t;IF NOT FOUND THEN RAISE EXCEPTION 'Probation case unavailable';END IF;
 h:=app.probation_holders(c.employment_id);
 SELECT jsonb_build_object(
  'holders',h,
  'org',jsonb_build_object('businessGroupId',h->>'businessUnitId','businessGroupName',(SELECT bu.name FROM business_unit bu WHERE bu.id::text=h->>'businessUnitId' AND bu.tenant_id=t),
   'companyId',c.company_id,'companyName',(SELECT co.legal_name FROM company co WHERE co.id=c.company_id AND co.tenant_id=t),
   'businessGroupCompanyId',(SELECT coalesce(co.parent_company_id,co.id) FROM company co WHERE co.id=c.company_id AND co.tenant_id=t),
   'departmentId',h->>'departmentId','departmentName',(SELECT d.name FROM department d WHERE d.id::text=h->>'departmentId' AND d.tenant_id=t),
   'jobTitle',(SELECT pos.title FROM assignment a JOIN position pos ON pos.id=a.position_id AND pos.tenant_id=a.tenant_id WHERE a.employment_id=c.employment_id AND a.tenant_id=t AND a.superseded_at IS NULL AND a.valid_from<=day AND (a.valid_to IS NULL OR a.valid_to>day) ORDER BY a.valid_from DESC,a.id LIMIT 1)),
  'people',(SELECT coalesce(jsonb_object_agg(x.role,x.name),'{}'::jsonb) FROM (SELECT r.role,n.full_name AS name FROM (VALUES('employee'),('lm'),('hod'),('pbp')) r(role) JOIN app_user u ON u.id::text=h->>r.role AND u.tenant_id=t JOIN person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id) x),
  'employeeCode',(SELECT e.employee_code FROM employment e WHERE e.id=c.employment_id AND e.tenant_id=t),
  'fallbackGroupId',coalesce(nullif(c.data->'config'->>'fallbackGroupId',''),(SELECT v.data->>'peopleOpsGroup' FROM lc_v9_config v WHERE v.tenant_id=t)),
  'postingApproverGroupId',coalesce(nullif(c.data->'config'->>'postingApproverGroupId',''),(SELECT v.data->>'peopleOpsGroup' FROM lc_v9_config v WHERE v.tenant_id=t)),
  'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.routing_id,'name',r.name,'rows',r.routing_rows)) FROM (
    SELECT DISTINCT ON (v.routing_id) v.routing_id,v.name,v.routing_rows,v.retired FROM automation_routing_version v WHERE v.tenant_id=t ORDER BY v.routing_id,v.revision DESC) r WHERE NOT r.retired LIMIT 500),'[]'::jsonb),
  'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g->>'id','members',coalesce((
    SELECT jsonb_agg(u.id ORDER BY m.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members')='array' THEN g->'members' ELSE '[]'::jsonb END) WITH ORDINALITY m(id,n)
    JOIN app_user u ON u.id::text=m.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE m.n<=500),'[]'::jsonb)))
   FROM (SELECT g FROM lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.data->'groups')='array' THEN v.data->'groups' ELSE '[]'::jsonb END) g WHERE v.tenant_id=t LIMIT 200) groups),'[]'::jsonb),
  'emailTemplates',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.template_id,'name',e.name,'active',e.active,'retired',e.retired,'subject',e.subject,'body',e.body,'cc',e.cc)) FROM (
    SELECT DISTINCT ON (v.template_id) v.template_id,v.name,v.active,v.retired,v.subject,v.body,v.cc FROM automation_email_template_version v WHERE v.tenant_id=t AND v.module='probation' ORDER BY v.template_id,v.revision DESC LIMIT 500) e),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_automation_notify(p_case uuid,p_part uuid,p_key text,p_kind text,p_users uuid[]) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();c probation_case;v_id uuid;v_event uuid;users jsonb;source text;
BEGIN
 IF app.automation_can_run('probation',p_case) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE='42501';END IF;
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=t;IF NOT FOUND THEN RAISE EXCEPTION 'Probation case unavailable';END IF;
 IF length(coalesce(p_key,'')) NOT BETWEEN 1 AND 300 OR coalesce(p_kind,'') !~ '^[a-zA-Z]{1,60}$' OR coalesce(cardinality(p_users),0) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid workflow notification' USING ERRCODE='22023';END IF;
 IF p_part IS NOT NULL AND NOT EXISTS(SELECT 1 FROM probation_part p WHERE p.id=p_part AND p.tenant_id=t AND p.case_id=c.id) THEN RAISE EXCEPTION 'Invalid workflow notification' USING ERRCODE='22023';END IF;
 source:='probation-automation:'||p_key;
 IF EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=t AND source_key=source) THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(DISTINCT u.id),'[]'::jsonb) INTO users FROM app_user u WHERE u.id=ANY(p_users) AND u.tenant_id=t AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF jsonb_array_length(users)=0 THEN RETURN false;END IF;
 v_id:=gen_random_uuid();
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(t,'probation-occurrence',v_id,'probation.notification-due',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p_part,'kind','automation','trigger',p_kind)) RETURNING id INTO v_event;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id) VALUES(v_id,t,c.id,p_part,source,'automation',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,users,'[]'::jsonb,'scheduled',c.revision,v_event);
 RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_outcome_automation(p_outcome uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();o probation_outcome;result jsonb;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=t;IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable';END IF;
 IF app.automation_can_run('probation',o.case_id) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('runs',count(*),'waiting',count(*) FILTER(WHERE r.status='waiting'),'failed',count(*) FILTER(WHERE r.status='failed'),
  'postingId',(SELECT p.id FROM personnel_posting p WHERE p.tenant_id=t AND p.source='probation' AND p.source_ref=o.case_id AND p.idempotency_key=o.id::text ORDER BY p.created_at DESC LIMIT 1),
  'handoffId',(SELECT x.id FROM lc_v9_case x JOIN probation_case c ON c.id=o.case_id AND c.tenant_id=x.tenant_id WHERE x.tenant_id=t AND x.employment_id=c.employment_id AND x.module='off' AND x.data->>'probationSourceCaseId'=o.case_id::text ORDER BY x.created_at DESC LIMIT 1))
 INTO result FROM automation_run r WHERE r.tenant_id=t AND r.module='probation' AND r.subject_id=o.case_id AND r.trigger_event='outcomeDecided' AND r.event_key LIKE 'outcomeDecided|'||o.id::text||':%';
 RETURN result;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_record_posting_effect(p_outcome uuid,p_posting uuid,p_handoff uuid,p_next jsonb,p_new_part jsonb DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;e employment;part jsonb;pid uuid;form jsonb;route jsonb;posting personnel_posting;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id FOR UPDATE;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id;
 IF NOT(app.probation_role(e.id,'gbs') OR app.probation_storage_runner()) OR NOT EXISTS(SELECT 1 FROM probation_file f JOIN employee_document doc ON doc.id=f.employee_document_id AND doc.tenant_id=f.tenant_id WHERE f.id=o.letter_file_id AND f.tenant_id=o.tenant_id AND doc.employment_id=e.id) OR o.released_at IS NULL OR o.outcome NOT IN('confirm','extend','not_confirm') THEN RAISE EXCEPTION 'GBS may apply only a released approved outcome';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF o.state='completed' THEN RETURN;END IF;
 IF p_posting IS NOT NULL THEN
  SELECT * INTO posting FROM personnel_posting WHERE id=p_posting AND tenant_id=c.tenant_id;
  IF posting.id IS NULL OR posting.source<>'probation' OR posting.source_ref<>c.id OR posting.employment_id<>e.id OR o.outcome='not_confirm'
   OR posting.event_type IS DISTINCT FROM (CASE o.outcome WHEN 'confirm' THEN 'confirmation' ELSE 'probationExtension' END) THEN RAISE EXCEPTION 'The Personnel posting does not belong to this outcome';END IF;
 END IF;
 IF p_handoff IS NOT NULL AND (o.outcome<>'not_confirm' OR NOT EXISTS(SELECT 1 FROM lc_v9_case x WHERE x.id=p_handoff AND x.tenant_id=c.tenant_id AND x.employment_id=e.id AND x.module='off' AND x.data->>'probationSourceCaseId'=c.id::text)) THEN RAISE EXCEPTION 'The offboarding case does not belong to this outcome';END IF;
 IF o.outcome='extend' AND ((c.data->>'extensionCount')::integer>=app.probation_max_extensions(c.data) OR p_new_part IS NULL OR jsonb_typeof(p_next) IS DISTINCT FROM 'object' OR (p_next->>'endOn') IS NULL) THEN RAISE EXCEPTION 'The extension is not allowed';END IF;
 UPDATE probation_outcome SET state='completed',movement_ref=CASE WHEN p_posting IS NULL THEN NULL ELSE 'posting:'||p_posting::text END,handoff_ref=p_handoff,failure=NULL,updated_at=now() WHERE id=o.id;
 IF o.outcome='extend' THEN
  part:=p_new_part;pid:=(part->>'id')::uuid;SELECT data INTO form FROM probation_configuration WHERE id=c.form_id;SELECT data INTO route FROM probation_configuration WHERE id=c.route_id;
  IF part->>'type'<>'3' OR (part->>'cycle')::integer<>(c.data->>'extensionCount')::integer+1 THEN RAISE EXCEPTION 'An extension schedules only the next final review';END IF;
  INSERT INTO probation_part(id,tenant_id,case_id,data) VALUES(pid,c.tenant_id,c.id,(part-ARRAY['employee','manager','employeeComments','kpis','support','strengths','development','managerComments','outcome','midpointStatus','justification','extensionMonths'])||jsonb_build_object('state','not_issued','route',route->'parts'->'3'));
  INSERT INTO probation_rater_draft(part_id,tenant_id,rater,data) VALUES(pid,c.tenant_id,'employee',jsonb_build_object('employee',app.probation_blank_assessment(form),'employeeComments','')),(pid,c.tenant_id,'lm',jsonb_build_object('manager',app.probation_blank_assessment(form),'kpis','[]'::jsonb,'support',jsonb_build_object('coaching','','access','','checkins','','other',''),'strengths','','development','','managerComments','','outcome',NULL,'midpointStatus',NULL,'justification','','extensionMonths',NULL));
  UPDATE probation_case SET data=data||jsonb_build_object('state','extended','endOn',p_next->>'endOn','extensionCount',(data->>'extensionCount')::integer+1,'pendingOutcome',NULL)||CASE WHEN p_posting IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('pendingPosting',jsonb_build_object('id',p_posting,'eventType',posting.event_type)) END,revision=revision+1 WHERE id=c.id;
 ELSE
  UPDATE probation_case SET data=data||jsonb_build_object('state',CASE WHEN o.outcome='confirm' THEN 'confirmed' ELSE 'not_confirmed' END,'pendingOutcome',NULL)||CASE WHEN p_posting IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('pendingPosting',jsonb_build_object('id',p_posting,'eventType',posting.event_type)) END,revision=revision+1 WHERE id=c.id;
 END IF;
 PERFORM app.probation_audit(c.id,o.part_id,'outcome_applied');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_notification_recipients(p_occurrence uuid,p_event uuid) RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_occurrence;c probation_case;p probation_part;h jsonb;
BEGIN
 IF (app.probation_storage_runner() OR app.probation_active_user() AND app.is_group_admin()) IS NOT TRUE THEN RETURN;END IF;
 SELECT * INTO o FROM probation_occurrence WHERE id=p_occurrence AND tenant_id=app.current_tenant_id() AND source_event_id=p_event AND state='scheduled';IF NOT FOUND THEN RETURN;END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 IF app.probation_case_company_current(c.id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM probation_activation WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND enabled AND activation_on<=o.due_on AND o.created_at>=updated_at) OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') AND o.kind NOT IN('letter_released','automation') THEN RETURN;END IF;
 SELECT * INTO p FROM probation_part WHERE id=o.part_id AND tenant_id=o.tenant_id;IF o.kind='route_attention' AND coalesce(p.data->>'state','') NOT IN('pending_ack','pending_approval') THEN RETURN;END IF;IF o.kind='letter_returned' AND (p.data->>'state' IS DISTINCT FROM 'returned' OR NOT EXISTS(SELECT 1 FROM probation_outcome x WHERE x.letter_part_id=p.id AND x.tenant_id=p.tenant_id)) OR o.kind='letter_release_pending' AND NOT EXISTS(SELECT 1 FROM probation_outcome x WHERE x.letter_part_id=p.id AND x.tenant_id=p.tenant_id AND x.released_at IS NULL) THEN RETURN;END IF;h:=app.probation_holders(c.employment_id);
 IF o.kind IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending') THEN
 IF o.kind IN('review_reminder','review_due') AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date>(p.data->>'dueOn')::date THEN RETURN;END IF;
 RETURN QUERY SELECT DISTINCT e.id FROM app.probation_pending_parties(p.id) party JOIN app_user u ON u.id=party.user_id AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE o.recipient_user_ids?u.id::text AND o.recipient_roles?party.role AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);RETURN;END IF;
 -- 5753: a shared workflow's Notify or Send email step: the people the runner resolved, while still active.
 IF o.kind='automation' THEN
 RETURN QUERY SELECT DISTINCT e.id FROM jsonb_array_elements_text(o.recipient_user_ids) ids(user_id) JOIN app_user u ON u.id=ids.user_id::uuid AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id);RETURN;END IF;
 IF o.kind='letter_signing_pending' AND jsonb_typeof((SELECT d.data->'routing' FROM document_signing_document d WHERE d.tenant_id=p.tenant_id AND d.subject_id=p.id AND d.subject_type='probation'))='object' THEN
 -- 5752: a routed letter's pending holders, counting Review and Approve decisions and the current round only.
 RETURN QUERY SELECT DISTINCT e.id FROM jsonb_array_elements_text(o.recipient_user_ids) ids(user_id) JOIN app_user u ON u.id=ids.user_id::uuid AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND p.data->>'state'='pending_approval' AND p.data->'letterSourceStamp'=app.probation_letter_stamp_value(p.id,c.tenant_id) AND EXISTS(SELECT 1 FROM document_signing_document d CROSS JOIN LATERAL app.document_signing_pending_steps(d.data) st WHERE d.tenant_id=p.tenant_id AND d.subject_id=p.id AND d.subject_type='probation' AND st->>'holderId'=u.id::text AND app.probation_signing_route_allowed(p.id,d.data->'route'));RETURN;END IF;
 IF o.kind='letter_signing_pending' THEN
 RETURN QUERY SELECT DISTINCT e.id FROM jsonb_array_elements_text(o.recipient_user_ids) ids(user_id) JOIN app_user u ON u.id=ids.user_id::uuid AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND EXISTS(SELECT 1 FROM document_signing_document d CROSS JOIN LATERAL jsonb_array_elements(d.data->'route'->'steps') st WHERE d.tenant_id=p.tenant_id AND d.subject_id=p.id AND d.subject_type='probation' AND st->>'holderId'=u.id::text AND app.probation_signing_route_allowed(p.id,d.data->'route') AND p.data->>'state'='pending_approval' AND p.data->'letterSourceStamp'=app.probation_letter_stamp_value(p.id,c.tenant_id) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=st->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') prior WHERE (prior->>'stage')::integer<(st->>'stage')::integer AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=prior->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash')));RETURN;END IF;
 RETURN QUERY SELECT DISTINCT e.id FROM jsonb_array_elements_text(o.recipient_user_ids) ids(user_id) JOIN app_user u ON u.id=ids.user_id::uuid AND u.tenant_id=o.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND (
 EXISTS(SELECT 1 FROM jsonb_array_elements_text(o.recipient_roles) role WHERE role<>'gbs' AND h->>role=u.id::text AND NOT(o.kind='review_reminder' AND role='employee' AND p.data->>'staffSubmittedAt' IS NOT NULL) AND NOT(o.kind='review_reminder' AND role='lm' AND p.data->>'managerSubmittedAt' IS NOT NULL))
 OR o.recipient_roles?'gbs' AND app.probation_gbs_user(c.employment_id,u.id));
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_posting_approved() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e uuid;
BEGIN
 UPDATE public.probation_case SET data=data-'pendingPosting',revision=revision+1,updated_at=now()
 WHERE tenant_id=NEW.tenant_id AND id=NEW.source_ref AND data->'pendingPosting'->>'id'=NEW.id::text RETURNING employment_id INTO e;
 IF e IS NOT NULL THEN
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(NEW.tenant_id,'probation',NEW.source_ref,'probation.posting_approved',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),e,jsonb_build_object('caseId',NEW.source_ref,'postingId',NEW.id,'eventType',NEW.event_type));
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER probation_posting_approved AFTER UPDATE OF status ON public.personnel_posting FOR EACH ROW
 WHEN (NEW.status='approved' AND OLD.status IS DISTINCT FROM 'approved' AND NEW.source='probation') EXECUTE FUNCTION app.probation_posting_approved();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_automation_context(uuid),app.probation_outcome_automation(uuid),app.probation_automation_notify(uuid,uuid,text,text,uuid[]),app.probation_record_posting_effect(uuid,uuid,uuid,jsonb,jsonb),app.probation_posting_approved() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_posting_approved() FROM ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_automation_context(uuid),app.probation_outcome_automation(uuid),app.probation_automation_notify(uuid,uuid,text,text,uuid[]),app.probation_record_posting_effect(uuid,uuid,uuid,jsonb,jsonb) TO ai_hr_app

