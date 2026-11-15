-- Shared workflow runs (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 2, build step 4; handoff B4;
-- lib/automation/runtime.ts, core/automation-runtime.ts).
-- Tag 5748 / idx 5148 / when 1793330005448 on the board offset (tag T, idx T - 600, when 1793330004800 + (T - 5100)),
-- assigned by the Probation Confirmation build lead for lane D1.
--
-- 1. automation_run holds one row per workflow + case + event key (the runner's idempotency key). A run pins the
--    workflow revision it started from (foreign key to automation_workflow_version) and the frozen remaining steps of
--    that revision, so editing, pausing or retiring the workflow never changes a run already started, including one
--    waiting for a document. The log is bounded (200 entries, 256 kB).
-- 2. Tenant-level like the definitions it pins (no company key): the subject is the module's case.
-- 3. The application reads under forced row security: module configurers, and people with access to the run's case
--    (Probation: app.probation_case_access). Reads filter by subject, which the (tenant, module, subject) index serves.
-- 4. Writes only through app.automation_run_start / app.automation_run_save (SECURITY DEFINER, shared workforce barrier),
--    callable by the module's server-side runner: app.automation_can_run(module, subject) answers for Probation the
--    storage runner (no signed-in user, migration owner session) or an active Probation user with access to the case.
--    Every other module answers false until it moves onto the shared engine. Start checks that the frozen steps equal the
--    pinned revision's steps; save allows only forward transitions, a shrinking suffix of the frozen steps and a cursor
--    that never moves back. Both record a domain_event in the same transaction.
-- New, empty table: no backfill, no populated rows to stage. No purpose-role object is created or replaced.
CREATE TABLE public.automation_run (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  id uuid NOT NULL,
  module text NOT NULL CHECK (module IN ('onb','off','contract_staff','probation')),
  workflow_id uuid NOT NULL,
  workflow_revision integer NOT NULL CHECK (workflow_revision BETWEEN 1 AND 100000),
  subject_id uuid NOT NULL,
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 300),
  trigger_event text NOT NULL CHECK (length(trigger_event) BETWEEN 1 AND 120),
  status text NOT NULL CHECK (status IN ('running','waiting','done','skipped','failed')),
  step_cursor integer NOT NULL DEFAULT 0 CHECK (step_cursor BETWEEN 0 AND 40),
  waiting_for uuid,
  remaining_steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(remaining_steps) = 'array'),
  log jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(log) = 'array'),
  failure text CHECK (failure IS NULL OR length(failure) BETWEEN 1 AND 1000),
  started_by uuid REFERENCES public.app_user(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, workflow_id, subject_id, event_key),
  FOREIGN KEY (tenant_id, workflow_id, workflow_revision) REFERENCES public.automation_workflow_version (tenant_id, workflow_id, revision),
  CHECK ((status = 'waiting') = (waiting_for IS NOT NULL)),
  CHECK ((status = 'failed') = (failure IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX automation_run_subject ON public.automation_run (tenant_id, module, subject_id, status);
--> statement-breakpoint
ALTER TABLE public.automation_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.automation_run FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY automation_run_owner ON public.automation_run FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
CREATE FUNCTION app.automation_run_subject_access(p_module text, p_subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT coalesce(app.current_tenant_id() IS NOT NULL AND CASE p_module
    WHEN 'probation' THEN app.probation_active_user() AND app.probation_case_access(p_subject)
    ELSE false END, false);
$$;
--> statement-breakpoint
CREATE FUNCTION app.automation_can_run(p_module text, p_subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT coalesce(app.current_tenant_id() IS NOT NULL AND p_subject IS NOT NULL AND CASE p_module
    WHEN 'probation' THEN app.probation_storage_runner() OR app.automation_run_subject_access(p_module, p_subject)
    ELSE false END, false);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_run_subject_access(text,uuid), app.automation_can_run(text,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_run_subject_access(text,uuid), app.automation_can_run(text,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY automation_run_read ON public.automation_run FOR SELECT TO ai_hr_app
  USING (tenant_id = app.current_tenant_id() AND (app.automation_can_configure(module) OR app.automation_run_subject_access(module, subject_id)));
--> statement-breakpoint
REVOKE ALL ON public.automation_run FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON public.automation_run TO ai_hr_app;
--> statement-breakpoint
-- The live workflows of a module for one trigger, latest revision only. The runner may read them although the person
-- whose action raised the event cannot configure workflows. Bounded.
CREATE FUNCTION app.automation_runner_workflows(p_module text, p_trigger text, p_subject uuid)
RETURNS TABLE (workflow_id uuid, revision integer, required boolean, definition jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF NOT app.automation_can_run(p_module, p_subject) THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE='42501'; END IF;
  RETURN QUERY
    SELECT latest.workflow_id, latest.revision, latest.required, latest.definition
    FROM (SELECT DISTINCT ON (v.workflow_id) v.workflow_id, v.revision, v.status, v.required, v.definition
          FROM public.automation_workflow_version v
          WHERE v.tenant_id = app.current_tenant_id() AND v.module = p_module
          ORDER BY v.workflow_id, v.revision DESC) latest
    WHERE latest.status = 'live' AND latest.definition->'trigger'->>'event' = p_trigger
    ORDER BY latest.workflow_id
    LIMIT 200;
END $$;
--> statement-breakpoint
-- Runs of one case waiting for one document, for the runner that resumes them.
CREATE FUNCTION app.automation_runner_waiting(p_module text, p_subject uuid, p_document uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT app.automation_can_run(p_module, p_subject) THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT to_jsonb(r) FROM public.automation_run r
    WHERE r.tenant_id = app.current_tenant_id() AND r.module = p_module AND r.subject_id = p_subject AND r.status = 'waiting' AND r.waiting_for = p_document
    ORDER BY r.started_at, r.id LIMIT 50;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.automation_run_log_valid(p_log jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT jsonb_typeof(p_log) = 'array' AND jsonb_array_length(p_log) <= 200 AND pg_column_size(p_log) <= 262144;
$$;
--> statement-breakpoint
CREATE FUNCTION app.automation_run_start(p_run uuid, p_module text, p_workflow uuid, p_revision integer, p_subject uuid, p_event_key text, p_trigger text, p_status text, p_remaining jsonb, p_log jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); v public.automation_workflow_version; frozen jsonb; existing public.automation_run; inserted uuid;
BEGIN
  IF t IS NULL OR p_run IS NULL THEN RAISE EXCEPTION 'A tenant is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF NOT app.automation_can_run(p_module, p_subject) THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE='42501'; END IF;
  IF coalesce(p_status, '') NOT IN ('running','skipped') OR length(coalesce(p_event_key, '')) NOT BETWEEN 1 AND 300 OR length(coalesce(p_trigger, '')) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Invalid run' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_remaining) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid run' USING ERRCODE='22023'; END IF;
  IF app.automation_run_log_valid(p_log) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid run log' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM public.automation_workflow_version WHERE tenant_id = t AND workflow_id = p_workflow AND revision = p_revision;
  IF NOT FOUND OR v.module IS DISTINCT FROM p_module OR v.status <> 'live' OR v.definition->'trigger'->>'event' IS DISTINCT FROM p_trigger THEN RAISE EXCEPTION 'Only a live workflow revision for this trigger can run' USING ERRCODE='22023'; END IF;
  -- The frozen steps are exactly the pinned revision's steps.
  SELECT coalesce(jsonb_agg(jsonb_build_object('index', n - 1, 'step', s) ORDER BY n), '[]'::jsonb) INTO frozen FROM jsonb_array_elements(v.definition->'steps') WITH ORDINALITY x(s, n);
  IF p_remaining IS DISTINCT FROM frozen THEN RAISE EXCEPTION 'The run must freeze the pinned revision''s steps' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('automation-run:'||t::text||':'||p_workflow::text||':'||p_subject::text||':'||p_event_key, 0));
  SELECT * INTO existing FROM public.automation_run WHERE tenant_id = t AND workflow_id = p_workflow AND subject_id = p_subject AND event_key = p_event_key;
  IF FOUND THEN RETURN jsonb_build_object('created', false, 'run', to_jsonb(existing)); END IF;
  INSERT INTO public.automation_run (tenant_id, id, module, workflow_id, workflow_revision, subject_id, event_key, trigger_event, status, remaining_steps, log, started_by)
  VALUES (t, p_run, p_module, p_workflow, p_revision, p_subject, p_event_key, p_trigger, p_status, p_remaining, p_log, app.current_user_id())
  RETURNING id INTO inserted;
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (t, 'automation_run', inserted, CASE p_status WHEN 'skipped' THEN 'automation.run.skipped' ELSE 'automation.run.started' END,
    CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END, app.current_user_id(),
    jsonb_build_object('module', p_module, 'workflowId', p_workflow, 'revision', p_revision, 'subjectId', p_subject, 'trigger', p_trigger));
  SELECT * INTO existing FROM public.automation_run WHERE tenant_id = t AND id = inserted;
  RETURN jsonb_build_object('created', true, 'run', to_jsonb(existing));
END $$;
--> statement-breakpoint
CREATE FUNCTION app.automation_run_save(p_run uuid, p_expected_status text, p_status text, p_cursor integer, p_waiting_for uuid, p_remaining jsonb, p_log jsonb, p_failure text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); old public.automation_run; suffix jsonb;
BEGIN
  IF t IS NULL OR p_run IS NULL THEN RAISE EXCEPTION 'A tenant is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  SELECT * INTO old FROM public.automation_run WHERE tenant_id = t AND id = p_run FOR UPDATE;
  IF NOT FOUND OR NOT app.automation_can_run(old.module, old.subject_id) THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE='42501'; END IF;
  IF old.status IS DISTINCT FROM p_expected_status THEN RAISE EXCEPTION 'This run changed since it was read' USING ERRCODE='40001'; END IF;
  IF NOT (old.status IN ('running','waiting') AND coalesce(p_status, '') IN ('running','waiting','done','failed')) THEN RAISE EXCEPTION 'A finished run cannot change' USING ERRCODE='22023'; END IF;
  IF p_cursor IS NULL OR p_cursor < old.step_cursor OR p_cursor > 40 OR (p_status = 'waiting') <> (p_waiting_for IS NOT NULL) OR (p_status = 'failed') <> (p_failure IS NOT NULL) THEN RAISE EXCEPTION 'Invalid run progress' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_remaining) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid run progress' USING ERRCODE='22023'; END IF;
  IF app.automation_run_log_valid(p_log) IS NOT TRUE OR p_failure IS NOT NULL AND length(btrim(p_failure)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid run log' USING ERRCODE='22023'; END IF;
  -- Only executed steps leave the frozen list: what remains is a suffix of what remained.
  IF jsonb_array_length(p_remaining) > jsonb_array_length(old.remaining_steps) THEN RAISE EXCEPTION 'The frozen steps of a run cannot change' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(e ORDER BY n), '[]'::jsonb) INTO suffix FROM jsonb_array_elements(old.remaining_steps) WITH ORDINALITY x(e, n)
    WHERE n > jsonb_array_length(old.remaining_steps) - jsonb_array_length(p_remaining);
  IF suffix IS DISTINCT FROM p_remaining THEN RAISE EXCEPTION 'The frozen steps of a run cannot change' USING ERRCODE='22023'; END IF;
  UPDATE public.automation_run SET status = p_status, step_cursor = p_cursor, waiting_for = p_waiting_for, remaining_steps = p_remaining, log = p_log, failure = p_failure, updated_at = now()
  WHERE tenant_id = t AND id = p_run;
  IF p_status IS DISTINCT FROM old.status THEN
    INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
    VALUES (t, 'automation_run', p_run, 'automation.run.' || p_status, CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END, app.current_user_id(),
      jsonb_build_object('module', old.module, 'workflowId', old.workflow_id, 'revision', old.workflow_revision, 'subjectId', old.subject_id, 'previousStatus', old.status, 'cursor', p_cursor, 'waitingFor', p_waiting_for));
  END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_runner_workflows(text,text,uuid), app.automation_runner_waiting(text,uuid,uuid), app.automation_run_log_valid(jsonb),
  app.automation_run_start(uuid,text,uuid,integer,uuid,text,text,text,jsonb,jsonb), app.automation_run_save(uuid,text,text,integer,uuid,jsonb,jsonb,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_runner_workflows(text,text,uuid), app.automation_runner_waiting(text,uuid,uuid),
  app.automation_run_start(uuid,text,uuid,integer,uuid,text,text,text,jsonb,jsonb), app.automation_run_save(uuid,text,text,integer,uuid,jsonb,jsonb,text) TO ai_hr_app;
