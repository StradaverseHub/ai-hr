-- Board daa76ed4 (item B of 2). Draft reservation 5141 @ idx 4541 / when 1793330004841 (unapplied).
-- Per-level Escalation Approval for routing version 4. Additive and nullable: existing requests keep NULL clock
-- columns and never escalate; templates without escalateAfterDays resolve byte-identically to 5140.

ALTER TABLE public.attendance_workflow_request ADD COLUMN stage_reached_at timestamptz, ADD COLUMN escalate_on date;
CREATE INDEX attendance_workflow_request_escalation_due ON public.attendance_workflow_request(tenant_id,escalate_on,id) WHERE escalate_on IS NOT NULL;

--> statement-breakpoint
-- Replaces 5140. A level may carry escalateAfterDays (whole days 1-365); it is frozen into that resolved stage only
-- when configured, so routes without it are unchanged and the request-links comparison still holds.
CREATE OR REPLACE FUNCTION app.attendance_workflow_resolve_v4(subject_id uuid,configured jsonb,configured_cc jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.employment; stage jsonb; source jsonb; actor jsonb; result jsonb; actors jsonb; resolved jsonb:='[]';
 seen_employments uuid[]:='{}';seen_people uuid[]:='{}';seen_users uuid[]:='{}';total integer:=0;i integer;j integer;alternative boolean;
 recipients jsonb:='[]';addresses text[]:='{}';address text;recipient jsonb;cc_ids uuid[];cc_id uuid;h record;identity record;l record;
 max_depth integer:=0;chain_length integer:=NULL;kept jsonb;dropped jsonb;skipped jsonb:='[]';kept_index integer:=0;
BEGIN
 IF NOT app.principal_snapshot_current() THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',NULL); END IF;
 SELECT e.* INTO subject FROM public.employment e WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.can_see_employment(subject_id) THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',NULL); END IF;
 IF jsonb_typeof(configured) IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 IF jsonb_array_length(configured) NOT BETWEEN 1 AND 10 THEN RETURN app.attendance_workflow_v3_problem('level_count',NULL); END IF;
 SELECT coalesce(max(CASE WHEN x.s->>'depth' ~ '^[1-5]$' THEN (x.s->>'depth')::integer END),0) INTO max_depth FROM (
  SELECT src.s FROM jsonb_array_elements(configured) AS st(v), jsonb_array_elements(CASE WHEN jsonb_typeof(st.v->'sources')='array' THEN st.v->'sources' ELSE '[]'::jsonb END) AS src(s)
  UNION ALL SELECT c.s FROM jsonb_array_elements(CASE WHEN jsonb_typeof(configured_cc)='array' THEN configured_cc ELSE '[]'::jsonb END) AS c(s)
 ) x WHERE jsonb_typeof(x.s)='object' AND x.s->>'kind'='direct_manager' AND jsonb_typeof(x.s->'depth')='number';
 IF max_depth>0 AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN
  SELECT x.level_number,x.problem INTO h FROM app.attendance_workflow_hierarchy_v5(subject_id,max_depth) x WHERE x.problem IS NOT NULL ORDER BY x.level_number LIMIT 1;
  IF FOUND AND h.problem='missing_superior' AND h.level_number>1 THEN chain_length:=h.level_number-1; END IF;
 END IF;
 FOR i IN 0..jsonb_array_length(configured)-1 LOOP
  stage:=configured->i;actors:='[]';alternative:=false;
  IF jsonb_typeof(stage) IS DISTINCT FROM 'object' OR NOT stage ?& ARRAY['name','mode','sources','hrAlternative'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(stage) k WHERE k NOT IN('name','mode','sources','hrAlternative','escalateAfterDays'))
   OR jsonb_typeof(stage->'name') IS DISTINCT FROM 'string' OR length(stage->>'name')>100 OR jsonb_typeof(stage->'hrAlternative') IS DISTINCT FROM 'boolean'
   OR (stage ? 'escalateAfterDays' AND (jsonb_typeof(stage->'escalateAfterDays') IS DISTINCT FROM 'number' OR stage->>'escalateAfterDays' !~ '^[1-9][0-9]{0,2}$' OR (stage->>'escalateAfterDays')::integer>365))
   THEN RETURN app.attendance_workflow_v3_problem('invalid_level',i); END IF;
  IF coalesce(stage->>'mode','') NOT IN('any_one','all_required','sequential') THEN RETURN app.attendance_workflow_v3_problem('invalid_mode',i); END IF;
  IF jsonb_typeof(stage->'sources') IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
  IF jsonb_array_length(stage->'sources') NOT BETWEEN 1 AND 20 OR (stage->>'hrAlternative'='true' AND (jsonb_array_length(stage->'sources')<>1 OR stage->'sources'->0->>'kind'<>'direct_manager')) THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
  kept:=stage->'sources';dropped:='[]';
  IF chain_length IS NOT NULL AND stage->>'hrAlternative'='false' THEN
   SELECT coalesce(jsonb_agg(x.s ORDER BY x.n) FILTER (WHERE NOT x.d),'[]'::jsonb),coalesce(jsonb_agg(x.s ORDER BY x.n) FILTER (WHERE x.d),'[]'::jsonb) INTO kept,dropped
    FROM (SELECT a.s,a.n,CASE WHEN jsonb_typeof(a.s)='object' AND a.s->>'kind'='direct_manager' AND jsonb_typeof(a.s->'depth')='number' AND a.s->>'depth' ~ '^[1-5]$'
      THEN (a.s->>'depth')::integer>chain_length ELSE false END AS d
     FROM jsonb_array_elements(stage->'sources') WITH ORDINALITY AS a(s,n)) x;
  END IF;
  IF jsonb_array_length(dropped)>0 THEN
   skipped:=skipped||jsonb_build_array(jsonb_build_object('configuredLevel',i+1,'sources',dropped,'reason','no_further_superior','levelSkipped',jsonb_array_length(kept)=0));
  END IF;
  CONTINUE WHEN jsonb_array_length(kept)=0;
  FOR j IN 0..jsonb_array_length(kept)-1 LOOP
   source:=kept->j;
   result:=app.attendance_workflow_resolve_v3(subject_id,jsonb_build_array(jsonb_build_object('name','Level 1','mode','sequential','source',source,'hrAlternative',stage->'hrAlternative')));
   IF result->>'ok' IS DISTINCT FROM 'true' THEN RETURN jsonb_set(result,'{problem,levelIndex}',to_jsonb(i)); END IF;
   alternative:=alternative OR (result->'stages'->0->>'hrAlternative')::boolean;
   FOR actor IN SELECT value FROM jsonb_array_elements(result->'stages'->0->'approvers') LOOP
    IF (actor->>'employmentId')::uuid=ANY(seen_employments) THEN RETURN app.attendance_workflow_v3_problem('duplicate_employment',i); END IF;
    IF (actor->>'personId')::uuid=ANY(seen_people) THEN RETURN app.attendance_workflow_v3_problem('duplicate_person',i); END IF;
    IF actor->>'userId' IS NOT NULL AND (actor->>'userId')::uuid=ANY(seen_users) THEN RETURN app.attendance_workflow_v3_problem('duplicate_login',i); END IF;
    seen_employments:=seen_employments||(actor->>'employmentId')::uuid;seen_people:=seen_people||(actor->>'personId')::uuid;
    IF actor->>'userId' IS NOT NULL THEN seen_users:=seen_users||(actor->>'userId')::uuid; END IF;
    actor:=actor||jsonb_build_object('slot',kept_index::text||':'||jsonb_array_length(actors)::text,'sourceIndex',j);actors:=actors||jsonb_build_array(actor);total:=total+1;
   END LOOP;
   IF jsonb_array_length(actors)>20 OR total>100 THEN RETURN app.attendance_workflow_v3_problem('too_many_participants',i); END IF;
  END LOOP;
  resolved:=resolved||jsonb_build_array(jsonb_build_object('name','Level '||(i+1)::text,'mode',stage->>'mode','sources',kept,'hrAlternative',alternative,'approvers',actors)
   ||CASE WHEN stage ? 'escalateAfterDays' THEN jsonb_build_object('escalateAfterDays',(stage->>'escalateAfterDays')::integer) ELSE '{}'::jsonb END);
  kept_index:=kept_index+1;
 END LOOP;
 IF jsonb_array_length(resolved)=0 THEN RETURN app.attendance_workflow_v3_problem('missing_superior',0); END IF;
 IF jsonb_typeof(configured_cc) IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 IF jsonb_array_length(configured_cc)>20 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(configured_cc) LOOP
  cc_ids:='{}';
  IF source->>'kind'='custom_email' THEN
   IF jsonb_typeof(source) IS DISTINCT FROM 'object' OR NOT source ?& ARRAY['kind','addresses'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN('kind','addresses')) OR jsonb_typeof(source->'addresses') IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   IF jsonb_array_length(source->'addresses') NOT BETWEEN 1 AND 50 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   FOR actor IN SELECT value FROM jsonb_array_elements(source->'addresses') LOOP
    IF jsonb_typeof(actor) IS DISTINCT FROM 'string' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
    address:=lower(actor#>>'{}');
    IF length(address)>320 OR address !~ '^[!-~]+$' OR address !~ '^[^@<>(),:;"\\ ]+@[^@<>(),:;"\\ ]+\.[^@<>(),:;"\\ ]+$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
    IF NOT address=ANY(addresses) THEN addresses:=addresses||address;recipients:=recipients||jsonb_build_array(jsonb_build_object('kind','custom_email','address',address)); END IF;
   END LOOP;
  ELSIF source->>'kind'='direct_manager' THEN
   IF NOT source ?& ARRAY['kind','depth'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN('kind','depth')) OR jsonb_typeof(source->'depth') IS DISTINCT FROM 'number' OR coalesce(source->>'depth','') !~ '^[1-5]$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   CONTINUE WHEN chain_length IS NOT NULL AND (source->>'depth')::integer>chain_length;
   SELECT * INTO h FROM app.attendance_workflow_hierarchy_v5(subject_id,(source->>'depth')::integer) x WHERE x.level_number=(source->>'depth')::integer;
   IF NOT FOUND OR h.problem IS NOT NULL OR h.employment_id IS NULL THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   CONTINUE WHEN h.pending_activation;
   cc_ids:=ARRAY[h.employment_id];
  ELSIF source->>'kind'='specific_employee' THEN
   IF NOT source ?& ARRAY['kind','employmentIds'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN('kind','employmentIds')) OR jsonb_typeof(source->'employmentIds') IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   IF jsonb_array_length(source->'employmentIds') NOT BETWEEN 1 AND 20 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   FOR actor IN SELECT value FROM jsonb_array_elements(source->'employmentIds') LOOP
    IF jsonb_typeof(actor) IS DISTINCT FROM 'string' OR coalesce(actor#>>'{}','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
    cc_ids:=cc_ids||(actor#>>'{}')::uuid;
   END LOOP;
  ELSE RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
  FOREACH cc_id IN ARRAY cc_ids LOOP
   SELECT e.id,e.person_id,p.primary_email INTO identity FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
    WHERE e.id=cc_id AND e.tenant_id=subject.tenant_id AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
   IF NOT FOUND OR identity.primary_email IS NULL THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   SELECT * INTO l FROM app.attendance_workflow_approver_login(identity.person_id);
   CONTINUE WHEN l.usable=0 AND l.accounts=0;
   IF l.usable<>1 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   address:=lower(identity.primary_email);
   IF length(address)>320 OR address !~ '^[!-~]+$' OR address !~ '^[^@<>(),:;"\\ ]+@[^@<>(),:;"\\ ]+\.[^@<>(),:;"\\ ]+$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   recipient:=jsonb_build_object('kind','employee','address',address,'employmentId',cc_id,'personId',identity.person_id,'userId',l.user_id);
   IF address=ANY(addresses) THEN SELECT coalesce(jsonb_agg(CASE WHEN r->>'address'=address THEN recipient ELSE r END),'[]') INTO recipients FROM jsonb_array_elements(recipients) r;
   ELSE addresses:=addresses||address;recipients:=recipients||jsonb_build_array(recipient); END IF;
  END LOOP;
  IF jsonb_array_length(recipients)>50 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'stages',resolved,'cc',recipients,'skipped',skipped);
END $$;

--> statement-breakpoint
-- Immutable escalation history: one row per (request, level) ever. Written only by app.attendance_workflow_escalate.
CREATE TABLE public.attendance_workflow_escalation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 request_id uuid NOT NULL REFERENCES public.attendance_workflow_request(id),
 stage_index integer NOT NULL CHECK(stage_index BETWEEN 0 AND 8),
 next_stage_index integer NOT NULL CHECK(next_stage_index=stage_index+1),
 escalate_after_days integer NOT NULL CHECK(escalate_after_days BETWEEN 1 AND 365),
 stage_reached_at timestamptz NOT NULL,
 due_on date NOT NULL,
 from_participants jsonb NOT NULL CHECK(jsonb_typeof(from_participants)='array'),
 partial_decisions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(partial_decisions)='array'),
 next_participants jsonb NOT NULL CHECK(jsonb_typeof(next_participants)='array'),
 reason text NOT NULL DEFAULT 'no_decision_within_period' CHECK(reason='no_decision_within_period'),
 actor text NOT NULL DEFAULT 'system' CHECK(actor='system'),
 escalated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT attendance_workflow_escalation_once UNIQUE(request_id,stage_index)
);
CREATE TRIGGER attendance_workflow_escalation_immutable BEFORE UPDATE OR DELETE ON public.attendance_workflow_escalation FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable();
ALTER TABLE public.attendance_workflow_escalation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_workflow_escalation FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.attendance_workflow_escalation TO ai_hr_app;
-- Read exactly like the request itself: subject visibility or a frozen assignment on that request.
CREATE POLICY attendance_workflow_escalation_read ON public.attendance_workflow_escalation FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND w.tenant_id=app.current_tenant_id() AND app.attendance_workflow_v3_read(w.correction_id)));

--> statement-breakpoint
-- Stage clock. Set on submission and whenever the current level changes; due date = the KL calendar date the level
-- was reached + days + 1 (calendar days counted from the next day; Monday + 3 days escalates early Friday). The final
-- frozen level never gets a due date. Otherwise the clock is immutable, except that a due date may be cleared once
-- the application is no longer pending (the runner's retirement of withdrawn/cancelled requests).
CREATE FUNCTION app.attendance_workflow_stage_clock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.current_stage IS DISTINCT FROM OLD.current_stage THEN
  NEW.stage_reached_at:=clock_timestamp();
  NEW.escalate_on:=CASE WHEN NEW.routing_version=4 AND NEW.current_stage<jsonb_array_length(NEW.stages)-1
    AND jsonb_typeof(NEW.stages->NEW.current_stage->'escalateAfterDays')='number'
   THEN (NEW.stage_reached_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date+(NEW.stages->NEW.current_stage->>'escalateAfterDays')::integer+1 END;
 ELSE
  NEW.stage_reached_at:=OLD.stage_reached_at;
  NEW.escalate_on:=CASE WHEN NEW.escalate_on IS NULL AND NOT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=OLD.correction_id AND c.tenant_id=OLD.tenant_id AND c.status='pending')
   THEN NULL ELSE OLD.escalate_on END;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_stage_clock() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_workflow_stage_clock BEFORE INSERT OR UPDATE ON public.attendance_workflow_request FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_stage_clock();

--> statement-breakpoint
-- Replaces 0592. Request routing stays immutable apart from current_stage and its clock. Advancing still needs a
-- recorded current-level decision, or (v4 only) a same-transaction escalation row for that level; clearing a due date
-- needs a non-pending application.
CREATE OR REPLACE FUNCTION app.attendance_workflow_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Approval routing history is immutable'; END IF;
 IF TG_TABLE_NAME='attendance_workflow_template' THEN
  IF to_jsonb(OLD)-'superseded_at'-'retired_at' IS DISTINCT FROM to_jsonb(NEW)-'superseded_at'-'retired_at' THEN RAISE EXCEPTION 'Workflow versions are immutable'; END IF;
 ELSIF TG_TABLE_NAME='attendance_workflow_request' THEN
  IF to_jsonb(OLD)-'current_stage'-'stage_reached_at'-'escalate_on' IS DISTINCT FROM to_jsonb(NEW)-'current_stage'-'stage_reached_at'-'escalate_on' THEN RAISE EXCEPTION 'Submitted routing is immutable'; END IF;
  IF NEW.current_stage=OLD.current_stage AND NEW.escalate_on IS NULL AND OLD.escalate_on IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=OLD.correction_id AND c.tenant_id=OLD.tenant_id AND c.status='pending') THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=OLD.id
   AND d.tenant_id=OLD.tenant_id AND d.stage_index=OLD.current_stage
   AND d.actual_user_id=coalesce(app.current_user_id()::text,'system')
   AND ((d.decision='approved' AND NEW.current_stage=OLD.current_stage+1)
    OR (d.decision='rejected' AND NEW.current_stage=jsonb_array_length(OLD.stages))))
   AND NOT (OLD.routing_version=4 AND NEW.current_stage=OLD.current_stage+1 AND EXISTS(SELECT 1 FROM public.attendance_workflow_escalation x
    WHERE x.request_id=OLD.id AND x.tenant_id=OLD.tenant_id AND x.stage_index=OLD.current_stage AND app.attendance_workflow_active_write(x.xmin)))
   THEN RAISE EXCEPTION 'A recorded current-stage decision is required to advance routing'; END IF;
 ELSE RAISE EXCEPTION 'Approval decisions are immutable'; END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- Replaces 0592. Adds the two non-decision transitions above; the decision-advance proof is unchanged.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.routing_version IN (3,4) AND NEW.current_stage=OLD.current_stage AND NEW.escalate_on IS NULL AND OLD.escalate_on IS NOT NULL
  AND to_jsonb(OLD)-'escalate_on' IS NOT DISTINCT FROM to_jsonb(NEW)-'escalate_on'
  AND NOT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=OLD.correction_id AND c.tenant_id=OLD.tenant_id AND c.status='pending') THEN RETURN NEW; END IF;
 IF OLD.routing_version=4 AND NEW.current_stage=OLD.current_stage+1 AND NEW.current_stage<jsonb_array_length(OLD.stages)
  AND EXISTS(SELECT 1 FROM public.attendance_workflow_escalation x WHERE x.request_id=OLD.id AND x.tenant_id=OLD.tenant_id
   AND x.stage_index=OLD.current_stage AND app.attendance_workflow_active_write(x.xmin)) THEN RETURN NEW; END IF;
 IF OLD.routing_version IN (3,4) AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d
  WHERE d.request_id=OLD.id AND d.tenant_id=OLD.tenant_id AND d.stage_index=OLD.current_stage
   AND d.actual_user_id=app.current_user_id()::text AND app.attendance_workflow_active_write(d.xmin)
   AND app.attendance_workflow_v3_completion_write(OLD.id,d.stage_index,d.decision)
   AND ((d.decision='approved' AND NEW.current_stage=OLD.current_stage+1) OR (d.decision='rejected' AND NEW.current_stage=jsonb_array_length(OLD.stages))))
  THEN RAISE EXCEPTION 'A fulfilled same-active-write participant level completion is required'; END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- The bounded system runner's single-request command. Never approves or rejects; never moves past the final level;
-- at most once per level. Lock order matches the decision guard (subject advisory -> correction -> request), so a
-- racing decision and escalation serialize and exactly one wins. Refuses any signed-in caller: only the no-login
-- system context (the nightly sweep) may run it, and its as_of date is that runner's HR-local date.
CREATE FUNCTION app.attendance_workflow_escalate(wanted_request uuid,as_of date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; status text; days integer; from_actors jsonb; partial jsonb; next_actors jsonb; recorded public.attendance_workflow_escalation;
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NOT NULL OR as_of IS NULL THEN RAISE EXCEPTION 'Only the scheduled system runner may escalate attendance approvals' USING ERRCODE='42501'; END IF;
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.id=wanted_request AND r.tenant_id=app.current_tenant_id() AND r.routing_version=4;
 IF NOT FOUND OR w.escalate_on IS NULL THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w.tenant_id::text||':'||w.employment_id::text,0));
 SELECT c.status::text INTO status FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id FOR UPDATE;
 SELECT r.* INTO STRICT w FROM public.attendance_workflow_request r WHERE r.id=w.id AND r.tenant_id=w.tenant_id FOR UPDATE;
 IF w.escalate_on IS NULL THEN RETURN NULL; END IF;
 IF status IS DISTINCT FROM 'pending' THEN
  UPDATE public.attendance_workflow_request SET escalate_on=NULL WHERE id=w.id AND tenant_id=w.tenant_id;
  RETURN NULL;
 END IF;
 IF w.escalate_on>as_of OR w.current_stage>=jsonb_array_length(w.stages)-1 THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=w.current_stage)
  OR EXISTS(SELECT 1 FROM public.attendance_workflow_escalation x WHERE x.request_id=w.id AND x.tenant_id=w.tenant_id AND x.stage_index=w.current_stage) THEN RETURN NULL; END IF;
 days:=(w.stages->w.current_stage->>'escalateAfterDays')::integer;
 IF days IS NULL THEN RETURN NULL; END IF;
 -- Participant evidence tables force row security; this function reads them through the owner-only escalation policy.
 PERFORM set_config('app.attendance_workflow_escalating',w.id::text,true);
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=w.current_stage AND d.decision='rejected') THEN
  PERFORM set_config('app.attendance_workflow_escalating','',true); RETURN NULL;
 END IF;
 from_actors:=coalesce(app.attendance_workflow_v3_effective(w.id,w.current_stage),'[]'::jsonb);
 SELECT coalesce(jsonb_agg(jsonb_build_object('slot',d.participant_slot,'decision',d.decision,'actualActorName',d.actual_actor_name,'actualPersonId',d.actual_person_id,'decidedAt',d.decided_at) ORDER BY d.decided_at,d.id),'[]'::jsonb)
  INTO partial FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=w.current_stage;
 next_actors:=coalesce(app.attendance_workflow_v3_effective(w.id,w.current_stage+1),'[]'::jsonb);
 PERFORM set_config('app.attendance_workflow_escalating','',true);
 INSERT INTO public.attendance_workflow_escalation(tenant_id,request_id,stage_index,next_stage_index,escalate_after_days,stage_reached_at,due_on,from_participants,partial_decisions,next_participants)
  VALUES(w.tenant_id,w.id,w.current_stage,w.current_stage+1,days,coalesce(w.stage_reached_at,w.created_at),w.escalate_on,from_actors,partial,next_actors) RETURNING * INTO recorded;
 UPDATE public.attendance_workflow_request SET current_stage=w.current_stage+1 WHERE id=w.id AND tenant_id=w.tenant_id;
 RETURN jsonb_build_object('escalationId',recorded.id,'workflowRequestId',w.id,'correctionId',w.correction_id,'employmentId',w.employment_id,
  'fromStageIndex',recorded.stage_index,'toStageIndex',recorded.next_stage_index,'escalateAfterDays',days,'stageReachedAt',recorded.stage_reached_at,
  'dueOn',recorded.due_on,'escalatedAt',recorded.escalated_at,'fromParticipants',from_actors,'partialDecisions',partial,'nextParticipants',next_actors);
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_escalate(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_escalate(uuid,date) TO ai_hr_app;

--> statement-breakpoint
-- One bounded keyset page of due requests for the system runner (partial index attendance_workflow_request_escalation_due).
CREATE FUNCTION app.attendance_workflow_escalation_due(as_of date,after_on date,after_id uuid,page_size integer)
RETURNS TABLE(id uuid,escalate_on date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NOT NULL OR as_of IS NULL OR page_size NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Only the scheduled system runner may list due attendance escalations' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT w.id,w.escalate_on FROM public.attendance_workflow_request w
  WHERE w.tenant_id=app.current_tenant_id() AND w.escalate_on IS NOT NULL AND w.escalate_on<=as_of
   AND (after_on IS NULL OR (w.escalate_on,w.id)>(after_on,after_id))
  ORDER BY w.escalate_on,w.id LIMIT page_size;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_escalation_due(date,date,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_escalation_due(date,date,uuid,integer) TO ai_hr_app;

--> statement-breakpoint
-- Owner-only read of one request's participant evidence while that function holds its transaction-local marker.
-- The application role never runs as the function owner, so the marker alone grants it nothing.
CREATE POLICY attendance_workflow_escalation_owner_read ON public.attendance_workflow_participant_decision FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND request_id::text=current_setting('app.attendance_workflow_escalating',true)
  AND current_user=pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid='app.attendance_workflow_escalate(uuid,date)'::regprocedure)));
CREATE POLICY attendance_workflow_escalation_owner_read ON public.attendance_workflow_participant_reassignment FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND request_id::text=current_setting('app.attendance_workflow_escalating',true)
  AND current_user=pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid='app.attendance_workflow_escalate(uuid,date)'::regprocedure)));
