-- Legacy notify-only Probation workflows move to the shared engine, exactly (lane G2 of the Probation Confirmation build;
-- ADR docs/adr/2026-11-15-probation-shared-automation.md decision 2; handoff A1). Tag 5757 / idx 5157 / when
-- 1793330005457, assigned by the build coordinator.
--
--  1. probation_workflow_move (owner only, forced row security, no application grant): which notify-only workflow
--     definitions an administrator moved to which shared workflow. Written only by app.probation_workflow_move.
--  2. app.probation_workflow_move(items, reason) (granted to ai_hr_app, authorized by
--     app.automation_can_configure('probation'), under the shared workforce barrier and a per-tenant lock): in one
--     set-based statement, saves each converted shared workflow as revision 1 (Live), marks every version of each moved
--     definition as moved, and audits both (automation.workflow.created, probation.workflow_moved). Idempotent: a
--     definition already moved or a shared workflow that already exists is left as it is.
--     app.probation_workflow_moves() lists the moves for the Workflows page.
--  3. The old engine stops firing moved definitions, so no case is notified twice: app.probation_workflow_run (2111 body)
--     returns without a notice, and app.probation_review_transition (0949 body) and app.probation_letter_transition
--     (5752 body) skip them while still counting them as configured (the old engine's default in-app notice is not
--     added in their place).
--  4. app.probation_legacy_audience(case, part) (granted, authorized by app.automation_can_run('probation', case)): the
--     case's holders, the pending parties by role and the notice words exactly as the old engine finds them, for the
--     shared recipients "The case's Head of Department / PBP", "GBS People Ops (case coverage)" and "whoever's step is
--     pending" narrowed to a role, and the merge fields Part number and Part due date.
--  5. app.probation_overdue_summary_cases(company, day) (granted; answers only the storage runner): one context case per
--     PBP with overdue open review parts, bounded, for the sweep's daily overdue summary.
-- No existing table, row, grant or purpose-owned object changes; replaced functions keep their signatures and grants.
CREATE TABLE public.probation_workflow_move (
  definition_id uuid PRIMARY KEY REFERENCES public.probation_builder_definition(id),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  workflow_id uuid NOT NULL,
  moved_by uuid NOT NULL REFERENCES public.app_user(id),
  moved_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX probation_workflow_move_tenant ON public.probation_workflow_move (tenant_id, workflow_id);
--> statement-breakpoint
ALTER TABLE public.probation_workflow_move ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.probation_workflow_move FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY probation_workflow_move_owner ON public.probation_workflow_move FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.probation_workflow_move FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_legacy_audience(p_case uuid,p_part uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();c probation_case;p probation_part;d document_signing_document;h jsonb;pending jsonb:='{}'::jsonb;holders jsonb;stage integer;routed boolean;
BEGIN
 IF app.automation_can_run('probation',p_case) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=t;IF NOT FOUND THEN RAISE EXCEPTION 'Probation case unavailable';END IF;
 IF p_part IS NOT NULL THEN SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=t;END IF;
 h:=app.probation_holders(c.employment_id);
 -- The case's holders, as app.probation_users_for_roles reaches them, while they can still sign in.
 SELECT jsonb_object_agg(r.role,coalesce((SELECT jsonb_agg(DISTINCT u.id) FROM jsonb_array_elements_text(app.probation_users_for_roles(c.employment_id,jsonb_build_array(r.role))) x(id)
   JOIN app_user u ON u.id::text=x.id AND u.tenant_id=t AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE r.role='gbs' OR h->>r.role=u.id::text),'[]'::jsonb)) INTO holders
 FROM (VALUES('employee'),('lm'),('hod'),('pbp'),('gbs')) r(role);
 IF p.id IS NOT NULL AND p.data->>'documentKind'='letter' THEN
  -- A letter's pending parties as the old letter transition (5752) finds them: the holders of the current stage's steps.
  SELECT * INTO d FROM document_signing_document WHERE tenant_id=t AND subject_type='probation' AND subject_id=p.id;
  IF d.id IS NOT NULL THEN
   routed:=jsonb_typeof(d.data->'routing')='object';
   SELECT min((s->>'stage')::integer) INTO stage FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND NOT CASE WHEN routed THEN app.document_signing_step_fulfilled(d.data,s) ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=s->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') END;
   SELECT coalesce(jsonb_object_agg(x.role,x.users),'{}'::jsonb) INTO pending FROM (
    SELECT s->>'role' AS role,jsonb_agg(DISTINCT u.id) AS users FROM jsonb_array_elements(d.data->'route'->'steps') s JOIN app_user u ON u.id::text=s->>'holderId' AND u.tenant_id=t AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    WHERE s->>'required'='true' AND (s->>'stage')::integer=stage GROUP BY 1) x;
  END IF;
 ELSIF p.id IS NOT NULL THEN
  -- A review part's pending parties as app.probation_workflow_plan reaches them (2111).
  SELECT coalesce(jsonb_object_agg(x.role,x.users),'{}'::jsonb) INTO pending FROM (
   SELECT party.role,jsonb_agg(DISTINCT u.id) AS users FROM app.probation_pending_parties(p.id) party JOIN app_user u ON u.id=party.user_id AND u.tenant_id=t AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) GROUP BY 1) x;
 END IF;
 RETURN jsonb_build_object('holders',holders,'pending',pending,
  -- The words the old engine's notices carry (app.probation_notification_content, 0949).
  'words',jsonb_build_object('employeeName',c.data->'facts'->>'employeeName','employeeCode',c.data->'facts'->>'employeeCode','companyName',c.data->'facts'->>'companyName','part',p.data->>'type','dueOn',p.data->>'dueOn','endOn',c.data->>'endOn'));
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_workflow_move(p_items jsonb,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();me uuid:=app.current_user_id();item jsonb;moved jsonb;
BEGIN
 IF t IS NULL OR me IS NULL OR app.automation_can_configure('probation') IS NOT TRUE THEN RAISE EXCEPTION 'You cannot configure Probation workflows' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid workflow move' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(p_items)>200 OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid workflow move' USING ERRCODE='22023';END IF;
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtextextended('probation-workflow-move:'||t::text,0));
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid workflow move' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(item->'workflow') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid workflow move' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(item->'workflow'->'trigger') IS DISTINCT FROM 'object' OR jsonb_typeof(item->'workflow'->'conditions') IS DISTINCT FROM 'array' OR jsonb_typeof(item->'workflow'->'steps') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid workflow move' USING ERRCODE='22023';END IF;
  IF coalesce(item->>'definitionId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(item->'workflow'->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR item->'workflow'->>'module' IS DISTINCT FROM 'probation' OR length(btrim(coalesce(item->'workflow'->>'name',''))) NOT BETWEEN 1 AND 200 OR pg_column_size(item->'workflow')>262144
   OR jsonb_array_length(item->'workflow'->'conditions')>20 OR jsonb_array_length(item->'workflow'->'steps') NOT BETWEEN 1 AND 40 THEN RAISE EXCEPTION 'Invalid workflow move' USING ERRCODE='22023';END IF;
  IF NOT EXISTS(SELECT 1 FROM probation_builder_definition b WHERE b.id=(item->>'definitionId')::uuid AND b.tenant_id=t AND b.kind='workflow' AND b.state='published') THEN RAISE EXCEPTION 'Only a published Probation workflow can be moved' USING ERRCODE='22023';END IF;
 END LOOP;
 -- Idempotent: a definition already moved, or a shared workflow that already exists, is left as it is.
 WITH wanted AS MATERIALIZED (
  SELECT DISTINCT ON ((i->>'definitionId')::uuid) (i->>'definitionId')::uuid AS definition_id,(i->'workflow'->>'id')::uuid AS workflow_id,i->'workflow' AS workflow,b.company_id,b.definition_key
  FROM jsonb_array_elements(p_items) i JOIN probation_builder_definition b ON b.id=(i->>'definitionId')::uuid AND b.tenant_id=t),
 fresh AS MATERIALIZED (
  SELECT w.* FROM wanted w WHERE NOT EXISTS(SELECT 1 FROM probation_workflow_move m WHERE m.tenant_id=t AND m.definition_id=w.definition_id)
   AND NOT EXISTS(SELECT 1 FROM automation_workflow_version v WHERE v.tenant_id=t AND v.workflow_id=w.workflow_id)),
 saved AS (
  INSERT INTO automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by)
  SELECT t,f.workflow_id,1,'probation','live',false,f.workflow-'status'-'required',btrim(p_reason),me FROM fresh f RETURNING workflow_id),
 marked AS (
  -- Every version of the moved definition stops firing in the old engine, including versions running cases pinned.
  INSERT INTO probation_workflow_move(definition_id,tenant_id,workflow_id,moved_by)
  SELECT b.id,t,f.workflow_id,me FROM fresh f JOIN probation_builder_definition b ON b.tenant_id=t AND b.company_id=f.company_id AND b.definition_key=f.definition_key AND b.kind='workflow'
  ON CONFLICT (definition_id) DO NOTHING RETURNING definition_id),
 audited AS (
  INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  SELECT t,'automation_workflow',f.workflow_id,'automation.workflow.created','user'::actor_type,me,jsonb_build_object('module','probation','revision',1,'status','live','previousStatus',NULL,'required',false,'movedFromDefinition',f.definition_id)
  FROM fresh f
  UNION ALL
  SELECT t,'probation-workflow',f.definition_id,'probation.workflow_moved','user'::actor_type,me,jsonb_build_object('definitionId',f.definition_id,'companyId',f.company_id,'definitionKey',f.definition_key,'workflowId',f.workflow_id,'reason',btrim(p_reason))
  FROM fresh f RETURNING 1)
 SELECT jsonb_build_object('moved',coalesce((SELECT jsonb_agg(f.definition_id) FROM fresh f),'[]'::jsonb),'saved',(SELECT count(*) FROM saved),'marked',(SELECT count(*) FROM marked),'audited',(SELECT count(*) FROM audited)) INTO moved;
 RETURN moved;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.probation_workflow_moves() RETURNS TABLE(definition_id uuid,workflow_id uuid,moved_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT m.definition_id,m.workflow_id,m.moved_at FROM public.probation_workflow_move m
 WHERE m.tenant_id=app.current_tenant_id() AND app.automation_can_configure('probation') ORDER BY m.moved_at,m.definition_id LIMIT 2000;
$$;
--> statement-breakpoint
CREATE FUNCTION app.probation_overdue_summary_cases(p_company uuid,p_day date) RETURNS TABLE(case_id uuid,pbp uuid,overdue integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 -- One context case per People Business Partner with overdue open review parts in this company (bounded), for the
 -- daily overdue summary. Only the storage runner (the sweep) may ask.
 WITH overdue AS MATERIALIZED (
  SELECT c.id,c.employment_id FROM public.probation_case c JOIN public.probation_part p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
  WHERE app.probation_storage_runner() AND c.tenant_id=app.current_tenant_id() AND c.company_id=p_company AND c.data->>'state' NOT IN('withdrawn','confirmed','not_confirmed')
   AND coalesce(p.data->>'documentKind','review')='review' AND p.data->>'state' NOT IN('not_issued','locked','recorded','completed_offline','cancelled')
   AND nullif(p.data->>'dueOn','')::date<p_day
  GROUP BY c.id,c.employment_id LIMIT 5000),
 holders AS MATERIALIZED (SELECT * FROM app.probation_holders_set(ARRAY(SELECT o.employment_id FROM overdue o)))
 SELECT min(o.id::text)::uuid,h.pbp,count(*)::integer FROM overdue o JOIN holders h ON h.employment_id=o.employment_id WHERE h.pbp IS NOT NULL GROUP BY h.pbp ORDER BY h.pbp LIMIT 500;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_legacy_audience(uuid,uuid),app.probation_workflow_move(jsonb,text),app.probation_workflow_moves(),app.probation_overdue_summary_cases(uuid,date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_legacy_audience(uuid,uuid),app.probation_workflow_move(jsonb,text),app.probation_workflow_moves(),app.probation_overdue_summary_cases(uuid,date) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_workflow_run(p_case uuid,p_part uuid,p_workflow uuid,p_expected integer,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;w probation_builder_definition;s jsonb;v_id uuid;first_id uuid;f jsonb;plan jsonb;message jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp')) OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Scoped workflow run authority and reason required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 SELECT * INTO w FROM probation_builder_definition WHERE id=p_workflow AND tenant_id=c.tenant_id AND company_id=c.company_id AND kind='workflow' AND state='published' AND c.data->'workflowIds'?id::text;
 IF NOT FOUND THEN RAISE EXCEPTION 'Use this case pinned published workflow';END IF;
 IF p_part IS NOT NULL THEN SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id;IF NOT FOUND OR p.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Workflow source changed';END IF;
 ELSIF c.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Workflow source changed';END IF;
 f:=app.probation_organisation_facts(c.data->'facts',w.data);
 IF coalesce(w.data->'conditions'->>'businessGroupId',f->>'businessGroupId') IS DISTINCT FROM f->>'businessGroupId' OR coalesce(w.data->'conditions'->>'businessUnitId',f->>'businessUnitId') IS DISTINCT FROM f->>'businessUnitId' OR coalesce(w.data->'conditions'->>'departmentId',f->>'departmentId') IS DISTINCT FROM f->>'departmentId' OR coalesce(w.data->'conditions'->>'grade',c.data->>'gradeAtStart') IS DISTINCT FROM c.data->>'gradeAtStart' OR w.data->'conditions'?'part' AND w.data->'conditions'->>'part' IS DISTINCT FROM p.data->>'type' THEN RETURN NULL;END IF;
 -- 5757: a definition moved to the shared engine no longer sends anything here.
 IF EXISTS(SELECT 1 FROM probation_workflow_move mv WHERE mv.tenant_id=c.tenant_id AND mv.definition_id=w.id) THEN RETURN NULL;END IF;
 plan:=app.probation_workflow_plan(c.id,p.id,w.data);IF plan->>'matches' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;IF plan->>'ready' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Workflow source is held: %',coalesce(plan->>'holdReason','The current source is not ready');END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(w.data->'steps') LOOP
  IF s->>'type'<>'notify' THEN RAISE EXCEPTION 'Unsupported probation workflow operation';END IF;
  SELECT item INTO message FROM jsonb_array_elements(plan->'messages') items(item) WHERE item->>'id'=s->>'id';IF coalesce(jsonb_array_length(message->'recipients'),0)=0 THEN CONTINUE;END IF;
  v_id:=app.probation_enqueue(c.id,p.id,w.data->'trigger'->>'event',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,message->'roles','probation-workflow:'||w.id::text||':'||c.id::text||':'||coalesce(p.id::text,'case')||':'||(s->>'id')||':'||(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text,coalesce(p.revision,c.revision));
  IF v_id IS NOT NULL THEN UPDATE probation_occurrence SET workflow_id=w.id,workflow_step_id=s->>'id',recipient_user_ids=(SELECT jsonb_agg(DISTINCT recipient->'userId') FROM jsonb_array_elements(message->'recipients') recipient) WHERE id=v_id AND tenant_id=c.tenant_id AND workflow_id IS NULL;first_id:=coalesce(first_id,v_id);END IF;
 END LOOP;
 PERFORM app.probation_audit(c.id,p.id,'workflow_run',p_reason);RETURN first_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_review_transition(p_part uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;d document_signing_document;w probation_builder_definition;plan jsonb;message jsonb;users jsonb;roles jsonb;key text;occurrence uuid;event_id uuid;configured boolean:=false;
BEGIN
 PERFORM app.probation_write_lock();SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 IF p.id IS NULL OR coalesce(p.data->>'documentKind','review')<>'review' OR app.probation_active_user() IS NOT TRUE OR NOT(app.probation_case_access(c.id) OR app.probation_actor_just_signed(p.id)) THEN RAISE EXCEPTION 'Current scoped review actor required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF d.id IS NULL OR p.data->>'managerSubmittedAt' IS NULL OR p.data->>'state' IN('locked','completed_offline','cancelled','returned') THEN RETURN;END IF;
 SELECT coalesce(jsonb_agg(DISTINCT party.user_id),'[]'),coalesce(jsonb_agg(DISTINCT party.role),'[]') INTO users,roles FROM app.probation_pending_parties(p.id) party;IF jsonb_array_length(users)=0 THEN RETURN;END IF;
 FOR w IN SELECT * FROM probation_builder_definition WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND kind='workflow' AND state='published' AND data->'trigger'->>'event'='approval_pending' AND c.data->'workflowIds'?id::text LOOP
 plan:=app.probation_workflow_plan(c.id,p.id,w.data);IF plan->>'matches' IS DISTINCT FROM 'true' OR plan->>'ready' IS DISTINCT FROM 'true' THEN CONTINUE;END IF;
 FOR message IN SELECT value FROM jsonb_array_elements(plan->'messages') LOOP
 IF jsonb_array_length(message->'recipients')=0 THEN CONTINUE;END IF;configured:=true;IF EXISTS(SELECT 1 FROM probation_workflow_move mv WHERE mv.tenant_id=c.tenant_id AND mv.definition_id=w.id) THEN CONTINUE;END IF;key:='probation-review:'||p.id::text||':'||d.revision::text||':'||w.id::text||':'||(message->>'id');IF EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN CONTINUE;END IF;
 SELECT jsonb_agg(DISTINCT recipient->'userId'),jsonb_agg(DISTINCT recipient->'role') INTO users,roles FROM jsonb_array_elements(message->'recipients') recipient;
 occurrence:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',occurrence,'probation.notification-due','user',app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'kind','approval_pending')) RETURNING id INTO event_id;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id,workflow_id,workflow_step_id) VALUES(occurrence,c.tenant_id,c.id,p.id,key,'approval_pending',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,users,roles,'scheduled',p.revision,event_id,w.id,message->>'id');
 END LOOP;END LOOP;
 IF NOT configured THEN
 SELECT jsonb_agg(DISTINCT party.user_id),jsonb_agg(DISTINCT party.role) INTO users,roles FROM app.probation_pending_parties(p.id) party;
 IF users IS NULL OR jsonb_array_length(users)=0 THEN RETURN;END IF;
 key:='probation-review:'||p.id::text||':'||d.revision::text||':in-app';IF NOT EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN occurrence:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',occurrence,'probation.notification-due','user',app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'kind','approval_pending')) RETURNING id INTO event_id;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id) VALUES(occurrence,c.tenant_id,c.id,p.id,key,'approval_pending',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,users,roles,'scheduled',p.revision,event_id);END IF;END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_letter_transition(p_part uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;o probation_outcome;d document_signing_document;event_kind text;roles jsonb;users jsonb;w probation_builder_definition;step jsonb;v_id uuid;v_event uuid;key text;found_workflow boolean:=false;stage integer;h jsonb;step_roles jsonb;step_users jsonb;routed boolean;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;SELECT * INTO o FROM probation_outcome WHERE id=(p.data->>'letterOutcomeId')::uuid AND tenant_id=p.tenant_id FOR UPDATE;
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=p.tenant_id AND subject_type='probation' AND subject_id=p.id;
 IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR o.letter_part_id IS DISTINCT FROM p.id OR d.id IS NULL OR NOT(app.probation_storage_runner() AND o.released_at IS NOT NULL AND EXISTS(SELECT 1 FROM probation_render_request q WHERE q.tenant_id=p.tenant_id AND q.part_id=p.id AND q.state='sealed' AND q.file_id=o.letter_file_id) OR app.probation_active_user() AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs') OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'actorId'=app.current_user_id()::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash'))) THEN RAISE EXCEPTION 'Current letter and authenticated transition actor required';END IF;PERFORM app.probation_assert_case_runtime(c.id);
 IF o.state='release_requested' THEN RETURN;END IF;
 routed:=jsonb_typeof(d.data->'routing')='object';
 -- 5752: a routed letter the owner sent round again returns to signing.
 IF routed AND NOT app.document_signing_returned(d.data) AND p.data->>'state'='returned' AND o.released_at IS NULL THEN
  UPDATE probation_part SET data=jsonb_set(data,'{state}','"pending_approval"'),revision=revision+1 WHERE id=p.id;
  UPDATE probation_outcome SET state='awaiting_release',failure=NULL,updated_at=now() WHERE id=o.id AND state='awaiting_revision';
 END IF;
 IF o.released_at IS NOT NULL THEN event_kind:='letter_released';roles:='["employee","lm","pbp"]';
 ELSIF (CASE WHEN routed THEN app.document_signing_returned(d.data) ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'action'='returned' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') END) THEN
 event_kind:='letter_returned';roles:='["pbp","gbs"]';UPDATE probation_part SET data=jsonb_set(data,'{state}','"returned"'),revision=revision+1 WHERE id=p.id AND data->>'state'<>'returned';UPDATE probation_outcome SET state='awaiting_revision',failure='The letter was returned. Prepare a new revision before signing continues.' WHERE id=o.id;
 ELSE
 event_kind:='letter_signing_pending';SELECT min((s->>'stage')::integer) INTO stage FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND NOT CASE WHEN routed THEN app.document_signing_step_fulfilled(d.data,s) ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'stepId'=s->>'id' AND a->>'action'='signed' AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') END;
 IF stage IS NULL THEN event_kind:='letter_release_pending';roles:=CASE WHEN o.outcome='confirm' THEN '["pbp","gbs"]'::jsonb ELSE '["pbp"]'::jsonb END;ELSE SELECT jsonb_agg(DISTINCT s->>'role'),jsonb_agg(DISTINCT s->>'holderId') INTO roles,users FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND (s->>'stage')::integer=stage AND s->>'holderId' IS NOT NULL;END IF;
 END IF;
 IF event_kind<>'letter_signing_pending' THEN users:=app.probation_users_for_roles(c.employment_id,roles);END IF;
 IF coalesce(jsonb_array_length(users),0)=0 THEN RETURN;END IF;
 FOR w IN SELECT * FROM probation_builder_definition WHERE tenant_id=c.tenant_id AND company_id=c.company_id AND kind='workflow' AND state='published' AND data->'trigger'->>'event'=event_kind AND c.data->'workflowIds'?id::text LOOP
 FOR step IN SELECT value FROM jsonb_array_elements(w.data->'steps') LOOP
 SELECT jsonb_agg(r) INTO step_roles FROM jsonb_array_elements_text(roles) r WHERE step->'to'?r;IF coalesce(jsonb_array_length(step_roles),0)=0 THEN CONTINUE;END IF;
 IF event_kind='letter_signing_pending' THEN SELECT jsonb_agg(DISTINCT st->>'holderId') INTO step_users FROM jsonb_array_elements(d.data->'route'->'steps') st WHERE step_roles?(st->>'role') AND (st->>'stage')::integer=stage AND st->>'holderId' IS NOT NULL;ELSE step_users:=app.probation_users_for_roles(c.employment_id,step_roles);END IF;IF coalesce(jsonb_array_length(step_users),0)=0 THEN CONTINUE;END IF;found_workflow:=true;IF EXISTS(SELECT 1 FROM probation_workflow_move mv WHERE mv.tenant_id=c.tenant_id AND mv.definition_id=w.id) THEN CONTINUE;END IF;key:='probation-letter:'||p.id::text||':'||d.revision::text||':'||event_kind||':'||w.id::text||':'||(step->>'id');
 IF EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN CONTINUE;END IF;
 v_id:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',v_id,'probation.notification-due',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'documentKind','letter','kind',event_kind)) RETURNING id INTO v_event;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id,workflow_id,workflow_step_id) VALUES(v_id,c.tenant_id,c.id,p.id,key,event_kind,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,step_users,step_roles,'scheduled',p.revision,v_event,w.id,step->>'id');
 END LOOP;END LOOP;
 -- Even an unconfigured email definition cannot hide the next assigned in-app signing task.
 IF NOT found_workflow THEN key:='probation-letter:'||p.id::text||':'||d.revision::text||':'||event_kind||':in-app';IF NOT EXISTS(SELECT 1 FROM probation_occurrence WHERE tenant_id=c.tenant_id AND source_key=key) THEN
 v_id:=gen_random_uuid();INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(c.tenant_id,'probation-occurrence',v_id,'probation.notification-due',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,jsonb_build_object('caseId',c.id,'partId',p.id,'documentKind','letter','kind',event_kind)) RETURNING id INTO v_event;
 INSERT INTO probation_occurrence(id,tenant_id,case_id,part_id,source_key,kind,due_on,recipient_user_ids,recipient_roles,state,source_revision,source_event_id) VALUES(v_id,c.tenant_id,c.id,p.id,key,event_kind,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,users,roles,'scheduled',p.revision,v_event);END IF;END IF;
END $$;
