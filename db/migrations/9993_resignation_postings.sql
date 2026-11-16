-- Offboarding postings are source-isolated from Probation. The shared movement writer remains the fact owner.
-- No applied SQL is changed. Existing Probation commands are retained behind source-dispatch wrappers.
ALTER TABLE public.personnel_posting DROP CONSTRAINT personnel_posting_source_check;
ALTER TABLE public.personnel_posting ADD CONSTRAINT personnel_posting_source_check CHECK(source IN ('probation','offboarding'));
ALTER TABLE public.personnel_posting DROP CONSTRAINT personnel_posting_event_type_check;
ALTER TABLE public.personnel_posting ADD CONSTRAINT personnel_posting_event_type_check CHECK(event_type IN ('confirmation','probationExtension','promotion','transfer','increment','salaryAdjustment','employmentTypeChange','termination'));
ALTER TABLE public.personnel_posting ADD CONSTRAINT personnel_posting_source_event CHECK(source<>'probation' OR event_type IN ('confirmation','probationExtension'));
ALTER TABLE public.personnel_posting DROP CONSTRAINT personnel_posting_status_check;
ALTER TABLE public.personnel_posting ADD CONSTRAINT personnel_posting_status_check CHECK(status IN ('pending','approved','rejected'));
ALTER TABLE public.personnel_posting DROP CONSTRAINT personnel_posting_status_shape;
ALTER TABLE public.personnel_posting ADD CONSTRAINT personnel_posting_status_shape CHECK(
 (status IN ('pending','rejected') AND approved_by IS NULL AND approved_at IS NULL AND applied IS NULL AND movement_id IS NULL)
 OR (status='approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND applied IS NOT NULL));
ALTER TABLE public.personnel_posting ADD COLUMN rejected_by uuid;
ALTER TABLE public.personnel_posting ADD CONSTRAINT personnel_posting_rejected_by_tenant_fk FOREIGN KEY(rejected_by,tenant_id) REFERENCES public.app_user(id,tenant_id);
ALTER TABLE public.personnel_posting ADD COLUMN rejected_at timestamptz;
ALTER TABLE public.personnel_posting ADD COLUMN rejection_reason text CHECK(rejection_reason IS NULL OR length(rejection_reason) BETWEEN 1 AND 2000);
ALTER TABLE public.personnel_posting ADD COLUMN due_on date;
ALTER TABLE public.personnel_posting ADD COLUMN baseline_values jsonb CHECK(baseline_values IS NULL OR jsonb_typeof(baseline_values)='object');
ALTER TABLE public.personnel_posting ADD CONSTRAINT personnel_posting_rejection_shape CHECK(status<>'rejected' OR (source='offboarding' AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_group_members(p_group text) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(u.id ORDER BY u.id),'{}'::uuid[]) FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce((SELECT c.data->'groups' FROM public.lc_onboarding_config c WHERE c.tenant_id=app.current_tenant_id()),(SELECT c.data->'groups' FROM public.lc_v9_config c WHERE c.tenant_id=app.current_tenant_id()),'[]'::jsonb)) g
 WHERE g->>'id'=p_group AND g->'members' ? u.id::text);
$$;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_ops(p_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.principal_snapshot_current() AND app.lc_v9_off_access(p_company) AND app.current_user_id()=ANY(app.offboarding_posting_group_members((SELECT data->>'peopleOpsGroup' FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()))),false);
$$;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_group(p_company uuid,p_group text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.principal_snapshot_current() AND app.current_user_id()=ANY(app.offboarding_posting_group_members(p_group)) AND app.access_workforce_company(p_company,'workforce.maintain'),false);
$$;
--> statement-breakpoint
ALTER FUNCTION app.personnel_posting_visible(text,uuid,text) RENAME TO personnel_posting_visible_probation_v1;
CREATE FUNCTION app.personnel_posting_visible(p_group text,p_employment uuid,p_source text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;
BEGIN
 IF p_source<>'offboarding' THEN RETURN app.personnel_posting_visible_probation_v1(p_group,p_employment,p_source); END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=app.current_tenant_id() AND id=p_employment;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=e.tenant_id AND u.person_id=e.person_id) THEN RETURN false; END IF;
 RETURN app.offboarding_posting_ops(e.company_id) OR app.offboarding_posting_group(e.company_id,p_group);
END $$;
--> statement-breakpoint
DROP POLICY personnel_posting_read ON public.personnel_posting;
CREATE POLICY personnel_posting_read ON public.personnel_posting FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.personnel_posting_visible(approver_group_id,employment_id,source));
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_values_ok(p_event text,p_values jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;
BEGIN
 IF p_event NOT IN ('promotion','transfer','increment','confirmation','salaryAdjustment','employmentTypeChange','termination') OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF app.personnel_posting_day(p_values->'effectiveDate') IS NULL THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_values) k WHERE k NOT IN ('effectiveDate','remarks','positionId','position','gradeId','jobGrade','basicSalary','exitReason','resignationDate')) THEN RETURN false; END IF;
 IF p_values ? 'remarks' AND jsonb_typeof(p_values->'remarks')<>'null' THEN
  IF jsonb_typeof(p_values->'remarks')<>'string' OR length(p_values->>'remarks')>200 THEN RETURN false; END IF;
 END IF;
 IF p_event='termination' THEN
  IF p_values ?| ARRAY['positionId','position','gradeId','jobGrade','basicSalary'] THEN RETURN false; END IF;
  RETURN jsonb_typeof(p_values->'exitReason')='string' AND length(btrim(p_values->>'exitReason')) BETWEEN 1 AND 200 AND app.personnel_posting_day(p_values->'resignationDate') IS NOT NULL;
 END IF;
 IF p_values ?| ARRAY['exitReason','resignationDate'] THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['positionId','gradeId'] LOOP
  IF p_values ? k THEN
   IF jsonb_typeof(p_values->k)<>'string' OR (p_values->>k)!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN RETURN false; END IF;
  END IF;
 END LOOP;
 IF (p_values ? 'positionId') <> (p_values ? 'position') OR (p_values ? 'gradeId') <> (p_values ? 'jobGrade') THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['position','jobGrade'] LOOP
  IF p_values ? k THEN IF jsonb_typeof(p_values->k)<>'string' OR length(btrim(p_values->>k)) NOT BETWEEN 1 AND 200 THEN RETURN false; END IF; END IF;
 END LOOP;
 IF p_values ? 'basicSalary' THEN
  IF jsonb_typeof(p_values->'basicSalary')<>'string' OR (p_values->>'basicSalary')!~'^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$' THEN RETURN false; END IF;
  IF (p_values->>'basicSalary')::numeric<=0 THEN RETURN false; END IF;
 END IF;
 RETURN p_event IN ('confirmation','employmentTypeChange') OR p_values ?| ARRAY['positionId','gradeId','basicSalary'];
END $$;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_references_ok(p_company uuid,p_values jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (NOT(p_values ? 'positionId') OR EXISTS(SELECT 1 FROM public.position p WHERE p.id=(p_values->>'positionId')::uuid AND p.tenant_id=app.current_tenant_id() AND p.archived_at IS NULL AND (p.company_id=p_company OR p.is_global) AND p.title=p_values->>'position'))
 AND (NOT(p_values ? 'gradeId') OR EXISTS(SELECT 1 FROM public.job_grade g WHERE g.id=(p_values->>'gradeId')::uuid AND g.tenant_id=app.current_tenant_id() AND g.archived_at IS NULL AND (g.scope_company_ids IS NULL OR p_company=ANY(g.scope_company_ids)) AND g.code=p_values->>'jobGrade'));
$$;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_terms(p_journey uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.resignation_journey; positions jsonb; grades jsonb;
BEGIN
 SELECT * INTO j FROM public.resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=p_journey;
 IF NOT FOUND OR NOT app.resignation_journey_access(j.id) OR j.stage<>'retained' THEN RAISE EXCEPTION 'Accepted offer unavailable' USING ERRCODE='42501'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',p.id,'title',p.title)) INTO positions FROM (SELECT p.id,p.title FROM public.position p WHERE p.tenant_id=j.tenant_id AND p.archived_at IS NULL AND (p.company_id=j.company_id OR p.is_global) AND p.title=j.data->'offer'->>'position' ORDER BY p.id LIMIT 2)p;
 SELECT jsonb_agg(jsonb_build_object('id',g.id,'code',g.code)) INTO grades FROM (SELECT g.id,g.code FROM public.job_grade g WHERE g.tenant_id=j.tenant_id AND g.archived_at IS NULL AND (g.scope_company_ids IS NULL OR j.company_id=ANY(g.scope_company_ids)) AND g.code=j.data->'offer'->>'jobGrade' ORDER BY g.id LIMIT 2)g;
 RETURN jsonb_build_object('companyId',j.company_id,'positions',coalesce(positions,'[]'),'grades',coalesce(grades,'[]'));
END $$;
--> statement-breakpoint
ALTER FUNCTION app.personnel_posting_create(text,uuid,uuid,text,jsonb,text,text) RENAME TO personnel_posting_create_probation_v1;
CREATE FUNCTION app.personnel_posting_create(p_source text,p_source_ref uuid,p_employment uuid,p_event text,p_proposed jsonb,p_approver_group text,p_key text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); j public.resignation_journey; old public.personnel_posting; v_id uuid; v_number integer; configured text; baseline jsonb; workflow_step jsonb;
BEGIN
 IF p_source<>'offboarding' THEN RETURN app.personnel_posting_create_probation_v1(p_source,p_source_ref,p_employment,p_event,p_proposed,p_approver_group,p_key); END IF;
 IF t IS NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Sign in to create a posting' USING ERRCODE='42501'; END IF;
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO j FROM public.resignation_journey WHERE tenant_id=t AND id=p_source_ref AND employment_id=p_employment;
 IF NOT FOUND OR NOT app.resignation_journey_access(j.id) THEN RAISE EXCEPTION 'Resignation source unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('personnel-posting:'||t::text,0));
 SELECT * INTO old FROM public.personnel_posting WHERE tenant_id=t AND source=p_source AND source_ref=p_source_ref AND event_type=p_event AND idempotency_key=p_key;
 IF FOUND THEN
  IF old.proposed<>p_proposed OR old.employment_id<>p_employment THEN RAISE EXCEPTION 'Posting retry changed its frozen source values' USING ERRCODE='22023'; END IF;
  RETURN old.id;
 END IF;
 IF app.offboarding_posting_values_ok(p_event,p_proposed) IS NOT TRUE OR length(btrim(coalesce(p_key,''))) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Posting values are incomplete or not allowed' USING ERRCODE='22023'; END IF;
 IF p_event='termination' THEN
  IF NOT app.lc_v9_off_access(j.company_id) OR j.offboarding_case_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.lc_v9_case c WHERE c.id=j.offboarding_case_id AND c.tenant_id=t AND c.employment_id=j.employment_id AND c.data->>'state'='cleared') THEN RAISE EXCEPTION 'Termination is raised only at completed clearance' USING ERRCODE='42501'; END IF;
  IF p_proposed->>'resignationDate' IS DISTINCT FROM j.submitted_on::text OR p_proposed->>'exitReason' IS DISTINCT FROM 'Resignation' THEN RAISE EXCEPTION 'Termination must use the resignation source facts' USING ERRCODE='22023'; END IF;
  IF p_proposed->>'effectiveDate' IS DISTINCT FROM (SELECT r.last_working_day::text FROM public.resignation_request r WHERE r.id=j.id AND r.tenant_id=t) THEN RAISE EXCEPTION 'Clearance last working day changed' USING ERRCODE='40001'; END IF;
 ELSE
  IF j.stage<>'retained' OR NOT (app.resignation_journey_can_act(j.id,'own') OR app.resignation_journey_can_act(j.id,'retry')) THEN RAISE EXCEPTION 'An accepted retention offer is required' USING ERRCODE='42501'; END IF;
  SELECT step INTO workflow_step FROM public.automation_run r JOIN public.automation_workflow_version w ON w.tenant_id=r.tenant_id AND w.workflow_id=r.workflow_id AND w.revision=r.workflow_revision CROSS JOIN LATERAL jsonb_array_elements(w.definition->'steps') step
  WHERE r.tenant_id=t AND r.module='off' AND r.subject_id=j.id AND r.status IN ('running','failed') AND p_key=r.id::text||':'||(step->>'id')||':'||j.revision::text AND step->>'type'='createPosting' LIMIT 1;
  IF workflow_step IS NULL THEN RAISE EXCEPTION 'Only a pinned workflow posting step can propose this event' USING ERRCODE='42501'; END IF;
  IF p_event IS DISTINCT FROM (CASE workflow_step->'params'->>'eventType' WHEN 'Transfer' THEN 'transfer' WHEN 'Increment' THEN 'increment' WHEN 'Confirmation' THEN 'confirmation' WHEN 'Salary Adjustment' THEN 'salaryAdjustment' WHEN 'Employment Type Change' THEN 'employmentTypeChange' ELSE 'promotion' END) THEN RAISE EXCEPTION 'Posting event does not match its workflow step' USING ERRCODE='22023'; END IF;
  IF (p_proposed ? 'positionId') IS DISTINCT FROM (coalesce(workflow_step->'params'->'fields','["title","grade","salary"]'::jsonb) ? 'title') OR (p_proposed ? 'gradeId') IS DISTINCT FROM (coalesce(workflow_step->'params'->'fields','["title","grade","salary"]'::jsonb) ? 'grade') OR (p_proposed ? 'basicSalary') IS DISTINCT FROM (coalesce(workflow_step->'params'->'fields','["title","grade","salary"]'::jsonb) ? 'salary') THEN RAISE EXCEPTION 'Posting fields do not match its workflow step' USING ERRCODE='22023'; END IF;

  IF p_proposed->>'effectiveDate' IS DISTINCT FROM (CASE workflow_step->'params'->>'dateFrom' WHEN 'lwd' THEN j.data->>'lastWorkingDay' WHEN 'today' THEN (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text ELSE j.data->'offer'->>'effectiveDate' END) THEN RAISE EXCEPTION 'Posting must use its pinned workflow date' USING ERRCODE='22023'; END IF;
  IF p_proposed ? 'position' AND p_proposed->>'position' IS DISTINCT FROM j.data->'offer'->>'position' THEN RAISE EXCEPTION 'Posting must use accepted Position' USING ERRCODE='22023'; END IF;
  IF p_proposed ? 'jobGrade' AND p_proposed->>'jobGrade' IS DISTINCT FROM j.data->'offer'->>'jobGrade' THEN RAISE EXCEPTION 'Posting must use accepted Job Grade' USING ERRCODE='22023'; END IF;
  IF p_proposed ? 'basicSalary' THEN IF (p_proposed->>'basicSalary')::numeric IS DISTINCT FROM (j.data->'offer'->>'basicSalary')::numeric THEN RAISE EXCEPTION 'Posting must use accepted Basic salary' USING ERRCODE='22023'; END IF; END IF;
 END IF;
 IF app.offboarding_posting_references_ok(j.company_id,p_proposed) IS NOT TRUE THEN RAISE EXCEPTION 'Posting references do not match Personnel Management' USING ERRCODE='22023'; END IF;
 SELECT CASE WHEN c.data->'offboarding' ? 'postingApproverGroupId' THEN c.data->'offboarding'->>'postingApproverGroupId' ELSE c.data->>'peopleOpsGroup' END INTO configured FROM public.lc_v9_config c WHERE c.tenant_id=t;
 IF configured IS DISTINCT FROM p_approver_group OR cardinality(app.offboarding_posting_group_members(configured))=0 THEN RAISE EXCEPTION 'Configure a populated Offboarding posting approver group' USING ERRCODE='22023'; END IF;
 SELECT coalesce(max(number),1000)+1 INTO v_number FROM public.personnel_posting WHERE tenant_id=t;
 baseline:=jsonb_build_object('position',j.data->'facts'->'position','jobGrade',j.data->'facts'->'jobGrade','basicSalary',j.data->'facts'->'basicSalary');
 INSERT INTO public.personnel_posting(tenant_id,company_id,employment_id,number,source,source_ref,event_type,proposed,approver_group_id,created_by,idempotency_key,baseline_values)
 VALUES(t,j.company_id,p_employment,v_number,p_source,p_source_ref,p_event,p_proposed,configured,app.current_user_id(),p_key,baseline) RETURNING id INTO v_id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(t,'personnel_posting',v_id,'personnel_posting.created','user',app.current_user_id(),p_employment,jsonb_build_object('number',v_number,'source',p_source,'sourceRef',p_source_ref,'eventType',p_event,'proposed',p_proposed,'approverGroupId',configured));
 RETURN v_id;
END $$;
--> statement-breakpoint
ALTER FUNCTION app.personnel_posting_edit(uuid,integer,jsonb) RENAME TO personnel_posting_edit_probation_v1;
CREATE FUNCTION app.personnel_posting_edit(p_id uuid,p_revision integer,p_values jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting; before_values jsonb;
BEGIN
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF NOT FOUND OR p.source<>'offboarding' THEN RETURN app.personnel_posting_edit_probation_v1(p_id,p_revision,p_values); END IF;
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id FOR UPDATE;
 IF NOT app.personnel_posting_visible(p.approver_group_id,p.employment_id,'offboarding') OR NOT app.offboarding_posting_group(p.company_id,p.approver_group_id) OR NOT app.access_workforce_employment(p.employment_id,'workforce.maintain') THEN RAISE EXCEPTION 'Only the authorised posting group can edit this posting' USING ERRCODE='42501'; END IF;
 IF p.status<>'pending' OR p.revision<>p_revision THEN RAISE EXCEPTION 'Posting changed; reload before editing' USING ERRCODE='40001'; END IF;
 IF app.offboarding_posting_values_ok(p.event_type,p_values) IS NOT TRUE THEN RAISE EXCEPTION 'Posting values are incomplete or not allowed' USING ERRCODE='22023'; END IF;
 IF app.offboarding_posting_references_ok(p.company_id,p_values) IS NOT TRUE THEN RAISE EXCEPTION 'Posting references do not match Personnel Management' USING ERRCODE='22023'; END IF;
 before_values:=coalesce(p.edited,p.proposed);IF before_values=p_values THEN RETURN p.revision; END IF;
 UPDATE public.personnel_posting SET edited=p_values,edited_by=app.current_user_id(),edited_at=now(),revision=p.revision+1 WHERE id=p.id AND tenant_id=p.tenant_id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(p.tenant_id,'personnel_posting',p.id,'personnel_posting.edited','user',app.current_user_id(),p.employment_id,jsonb_build_object('before',before_values,'after',p_values,'revision',p.revision+1));
 RETURN p.revision+1;
END $$;
--> statement-breakpoint
ALTER FUNCTION app.personnel_posting_approve(uuid,integer,jsonb) RENAME TO personnel_posting_approve_probation_v1;
CREATE FUNCTION app.personnel_posting_approve(p_id uuid,p_revision integer,p_values jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting; v jsonb;
BEGIN
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF NOT FOUND OR p.source<>'offboarding' THEN RETURN app.personnel_posting_approve_probation_v1(p_id,p_revision,p_values); END IF;
 PERFORM app.access_workforce_write_lock();SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id FOR UPDATE;
 IF NOT app.personnel_posting_visible(p.approver_group_id,p.employment_id,'offboarding') OR NOT app.offboarding_posting_group(p.company_id,p.approver_group_id) OR NOT app.access_workforce_employment(p.employment_id,'workforce.maintain') THEN RAISE EXCEPTION 'Only the authorised posting group can approve this posting' USING ERRCODE='42501'; END IF;
 IF p.status='approved' AND p.movement_id IS NOT NULL AND p_revision IN (p.revision,p.revision-1) AND (p_values IS NULL OR p_values=p.applied) THEN
  RETURN jsonb_build_object('id',p.id,'number',p.number,'employmentId',p.employment_id,'eventType',p.event_type,'values',p.applied,'revision',p.revision,'movementId',p.movement_id,'alreadyApplied',true);
 END IF;
 IF p.status<>'pending' OR p.revision<>p_revision THEN RAISE EXCEPTION 'Posting changed; reload before approving' USING ERRCODE='40001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.resignation_journey j JOIN public.employment e ON e.id=j.employment_id AND e.tenant_id=j.tenant_id WHERE j.tenant_id=p.tenant_id AND j.id=p.source_ref AND j.employment_id=p.employment_id AND j.company_id=p.company_id AND e.company_id=p.company_id AND (p.event_type<>'termination' AND j.stage='retained' OR p.event_type='termination' AND EXISTS(SELECT 1 FROM public.lc_v9_case c WHERE c.tenant_id=j.tenant_id AND c.id=j.offboarding_case_id AND c.employment_id=j.employment_id AND c.data->>'state'='cleared'))) THEN RAISE EXCEPTION 'The posting source or company changed; review before approving' USING ERRCODE='40001'; END IF;

 v:=coalesce(p_values,p.edited,p.proposed);IF app.offboarding_posting_values_ok(p.event_type,v) IS NOT TRUE THEN RAISE EXCEPTION 'Posting values are incomplete or not allowed' USING ERRCODE='22023'; END IF;
 IF app.offboarding_posting_references_ok(p.company_id,v) IS NOT TRUE THEN RAISE EXCEPTION 'Posting references do not match Personnel Management' USING ERRCODE='22023'; END IF;
 UPDATE public.personnel_posting SET status='approved',approved_by=app.current_user_id(),approved_at=now(),applied=v,revision=p.revision+1 WHERE id=p.id AND tenant_id=p.tenant_id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(p.tenant_id,'personnel_posting',p.id,'personnel_posting.approved','user',app.current_user_id(),p.employment_id,jsonb_build_object('source',p.source,'sourceRef',p.source_ref,'applied',v,'revision',p.revision+1));
 RETURN jsonb_build_object('id',p.id,'number',p.number,'employmentId',p.employment_id,'eventType',p.event_type,'values',v,'revision',p.revision+1);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_reject(p_id uuid,p_revision integer,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id FOR UPDATE;
 IF NOT FOUND OR p.source<>'offboarding' OR NOT app.personnel_posting_visible(p.approver_group_id,p.employment_id,'offboarding') OR NOT app.offboarding_posting_group(p.company_id,p.approver_group_id) THEN RAISE EXCEPTION 'Only the authorised posting group can reject this posting' USING ERRCODE='42501'; END IF;
 IF p.status<>'pending' OR p.revision<>p_revision THEN RAISE EXCEPTION 'Posting changed; reload before rejecting' USING ERRCODE='40001'; END IF;
 IF length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Explain why this posting is rejected' USING ERRCODE='22023'; END IF;
 UPDATE public.personnel_posting SET status='rejected',rejected_by=app.current_user_id(),rejected_at=now(),rejection_reason=btrim(p_reason),revision=p.revision+1 WHERE id=p.id AND tenant_id=p.tenant_id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(p.tenant_id,'personnel_posting',p.id,'personnel_posting.rejected','user',app.current_user_id(),p.employment_id,jsonb_build_object('reason',btrim(p_reason),'sourceRef',p.source_ref));
END $$;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_reassign(p_previous text,p_next text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF app.current_user_id() IS NULL OR NOT app.principal_snapshot_current() OR NOT app.is_group_admin() OR NOT app.automation_can_configure('off') THEN RAISE EXCEPTION 'Configuration authority required' USING ERRCODE='42501'; END IF;
 IF p_next IS DISTINCT FROM (SELECT CASE WHEN c.data->'offboarding' ? 'postingApproverGroupId' THEN c.data->'offboarding'->>'postingApproverGroupId' ELSE c.data->>'peopleOpsGroup' END FROM public.lc_v9_config c WHERE c.tenant_id=app.current_tenant_id()) THEN RAISE EXCEPTION 'Reassignment must match saved Offboarding settings' USING ERRCODE='42501'; END IF;
 IF cardinality(app.offboarding_posting_group_members(p_next))=0 THEN RETURN 0; END IF;
 UPDATE public.personnel_posting SET approver_group_id=p_next,revision=revision+1 WHERE tenant_id=app.current_tenant_id() AND source='offboarding' AND status='pending' AND approver_group_id=p_previous;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n>0 THEN INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(app.current_tenant_id(),'lifecycle-v9-config',app.current_tenant_id(),'offboarding.postingsReassigned','user',app.current_user_id(),jsonb_build_object('from',p_previous,'to',p_next,'count',n)); END IF;
 RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_posting_visible(text,uuid,text),app.personnel_posting_create(text,uuid,uuid,text,jsonb,text,text),app.personnel_posting_edit(uuid,integer,jsonb),app.personnel_posting_approve(uuid,integer,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.personnel_posting_visible_probation_v1(text,uuid,text),app.personnel_posting_create_probation_v1(text,uuid,uuid,text,jsonb,text,text),app.personnel_posting_edit_probation_v1(uuid,integer,jsonb),app.personnel_posting_approve_probation_v1(uuid,integer,jsonb) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.offboarding_posting_references_ok(uuid,jsonb),app.offboarding_posting_terms(uuid),app.offboarding_posting_group_members(text),app.offboarding_posting_ops(uuid),app.offboarding_posting_group(uuid,text),app.offboarding_posting_values_ok(text,jsonb),app.offboarding_posting_reject(uuid,integer,text),app.offboarding_posting_reassign(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.offboarding_posting_terms(uuid),app.personnel_posting_visible(text,uuid,text),app.personnel_posting_create(text,uuid,uuid,text,jsonb,text,text),app.personnel_posting_edit(uuid,integer,jsonb),app.personnel_posting_approve(uuid,integer,jsonb),app.offboarding_posting_ops(uuid),app.offboarding_posting_group(uuid,text),app.offboarding_posting_reject(uuid,integer,text),app.offboarding_posting_reassign(text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_choices(p_id uuid,p_search text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;
BEGIN
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF NOT FOUND OR p.source<>'offboarding' OR NOT app.personnel_posting_visible(p.approver_group_id,p.employment_id,p.source) OR NOT app.offboarding_posting_group(p.company_id,p.approver_group_id) THEN RAISE EXCEPTION 'Posting unavailable' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('positions',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,title AS name FROM public.position WHERE tenant_id=p.tenant_id AND archived_at IS NULL AND (company_id=p.company_id OR is_global) AND (coalesce(p_search,'')='' OR title ILIKE '%'||left(p_search,120)||'%' OR id::text=p_search OR id::text=coalesce(p.edited,p.proposed)->>'positionId') ORDER BY (id::text=coalesce(p.edited,p.proposed)->>'positionId') DESC NULLS LAST,title,id LIMIT 501)x),'[]'),
 'grades',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,code,name FROM public.job_grade WHERE tenant_id=p.tenant_id AND archived_at IS NULL AND (scope_company_ids IS NULL OR p.company_id=ANY(scope_company_ids)) AND (coalesce(p_search,'')='' OR code ILIKE '%'||left(p_search,120)||'%' OR name ILIKE '%'||left(p_search,120)||'%' OR id::text=p_search OR id::text=coalesce(p.edited,p.proposed)->>'gradeId') ORDER BY (id::text=coalesce(p.edited,p.proposed)->>'gradeId') DESC NULLS LAST,code,id LIMIT 501)x),'[]'));
END $$;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_due(p_id uuid,p_due date) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;
BEGIN
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id FOR UPDATE;
 IF FOUND AND p.source='offboarding' AND p.due_on=p_due AND (p.created_by=app.current_user_id() OR app.personnel_posting_visible(p.approver_group_id,p.employment_id,p.source)) THEN RETURN; END IF;
 IF NOT FOUND OR p.source<>'offboarding' OR p.created_by IS DISTINCT FROM app.current_user_id() OR p.created_at IS DISTINCT FROM now() OR p.status<>'pending' THEN RAISE EXCEPTION 'Only the creating workflow may set this due date' USING ERRCODE='42501'; END IF;
 UPDATE public.personnel_posting SET due_on=p_due WHERE id=p.id AND tenant_id=p.tenant_id;
END $$;
REVOKE ALL ON FUNCTION app.offboarding_posting_choices(uuid,text),app.offboarding_posting_due(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.offboarding_posting_choices(uuid,text),app.offboarding_posting_due(uuid,date) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_edit_event(p_id uuid,p_revision integer,p_event text,p_values jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting; before_values jsonb;
BEGIN
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF NOT FOUND OR p.source<>'offboarding' THEN RAISE EXCEPTION 'Offboarding posting unavailable' USING ERRCODE='42501'; END IF;
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id FOR UPDATE;
 IF NOT app.personnel_posting_visible(p.approver_group_id,p.employment_id,'offboarding') OR NOT app.offboarding_posting_group(p.company_id,p.approver_group_id) OR NOT app.access_workforce_employment(p.employment_id,'workforce.maintain') THEN RAISE EXCEPTION 'Only the authorised posting group can edit this posting' USING ERRCODE='42501'; END IF;
 IF p.status<>'pending' OR p.revision<>p_revision THEN RAISE EXCEPTION 'Posting changed; reload before editing' USING ERRCODE='40001'; END IF;
 IF (p.event_type='termination')<>(p_event='termination') THEN RAISE EXCEPTION 'Termination belongs to the clearance posting' USING ERRCODE='22023'; END IF;
 IF app.offboarding_posting_values_ok(p_event,p_values) IS NOT TRUE THEN RAISE EXCEPTION 'Posting values are incomplete or not allowed' USING ERRCODE='22023'; END IF;
 IF app.offboarding_posting_references_ok(p.company_id,p_values) IS NOT TRUE THEN RAISE EXCEPTION 'Posting references do not match Personnel Management' USING ERRCODE='22023'; END IF;
 before_values:=coalesce(p.edited,p.proposed);IF before_values=p_values AND p.event_type=p_event THEN RETURN p.revision; END IF;
 UPDATE public.personnel_posting SET event_type=p_event,edited=p_values,edited_by=app.current_user_id(),edited_at=now(),revision=p.revision+1 WHERE id=p.id AND tenant_id=p.tenant_id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(p.tenant_id,'personnel_posting',p.id,'personnel_posting.edited','user',app.current_user_id(),p.employment_id,jsonb_build_object('before',before_values,'after',p_values,'eventBefore',p.event_type,'eventAfter',p_event,'revision',p.revision+1));
 RETURN p.revision+1;
END $$;

REVOKE ALL ON FUNCTION app.offboarding_posting_edit_event(uuid,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.offboarding_posting_edit_event(uuid,integer,text,jsonb) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_receipt(p_id uuid) RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;
BEGIN
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF NOT FOUND OR p.source<>'offboarding' OR NOT(app.personnel_posting_visible(p.approver_group_id,p.employment_id,p.source) OR (p.created_by=app.current_user_id() AND app.resignation_journey_access(p.source_ref))) THEN RAISE EXCEPTION 'Posting receipt unavailable' USING ERRCODE='42501'; END IF;
 RETURN p.number;
END $$;
REVOKE ALL ON FUNCTION app.offboarding_posting_receipt(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.offboarding_posting_receipt(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.offboarding_posting_queue_access() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.principal_snapshot_current() AND (EXISTS(SELECT 1 FROM public.personnel_posting p WHERE p.tenant_id=app.current_tenant_id() AND p.source='offboarding' AND app.personnel_posting_visible(p.approver_group_id,p.employment_id,p.source)) OR EXISTS(SELECT 1 FROM public.company c JOIN public.lc_v9_config cfg ON cfg.tenant_id=c.tenant_id WHERE c.tenant_id=app.current_tenant_id() AND (app.offboarding_posting_ops(c.id) OR app.offboarding_posting_group(c.id,CASE WHEN cfg.data->'offboarding' ? 'postingApproverGroupId' THEN cfg.data->'offboarding'->>'postingApproverGroupId' ELSE cfg.data->>'peopleOpsGroup' END)))),false);
$$;
REVOKE ALL ON FUNCTION app.offboarding_posting_queue_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.offboarding_posting_queue_access() TO ai_hr_app;
