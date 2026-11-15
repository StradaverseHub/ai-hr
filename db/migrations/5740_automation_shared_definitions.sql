-- Shared HR automation definitions (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 2, build step 1-2).
-- Tag 5740 / idx 5140 / when 1793330005440 on the board offset (tag T, idx T - 600, when 1793330004800 + (T - 5100)),
-- above the journal's maximum 5680 and the claims found on origin heads on 16 November 2026 (5690, 5695, 5700-5724).
--
-- 1. automation_workflow_version and automation_routing_version are APPEND-ONLY. A save inserts the next revision;
--    nothing updates or deletes a row. The latest revision is the definition; earlier revisions are the history, and
--    a run pins (definition id, revision) as its frozen copy, so editing or pausing never changes a run in flight.
-- 2. Definitions are tenant-level (conditions may name companies; nothing here is company-scoped), so no company key.
-- 3. The application reads under row security and writes only through app.automation_workflow_save /
--    app.automation_routing_save, which take the shared workforce barrier, check authority, the expected revision
--    (optimistic concurrency) and bounded shape, and record a domain_event in the same transaction.
-- 4. Authority: app.automation_can_configure(module). Only 'probation' answers today, from the existing tenant-level
--    Probation module permission (migration 2107). On/Off Boarding and Contract staff keep their own engines and stores
--    (lc_v9_config, contract tables) untouched and answer false here until they move, so this migration grants nobody
--    anything new over those modules. Routings are editable by anyone who can configure at least one module.
-- 5. Meaning (catalogue triggers, condition fields, steps, recipients) is validated by the service before the call
--    (lib/automation/workflow.ts, lib/automation/routing.ts); the database enforces authority, tenancy, revision order,
--    module stability, retirement finality and size bounds as the last guard.
-- New, empty tables: no backfill, no populated rows to stage. No purpose-role object is created or replaced.
CREATE TABLE public.automation_workflow_version (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  workflow_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 100000),
  module text NOT NULL CHECK (module IN ('onb','off','contract_staff','probation')),
  status text NOT NULL CHECK (status IN ('live','paused','retired')),
  required boolean NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  saved_by uuid NOT NULL REFERENCES public.app_user(id),
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workflow_id, revision)
);
--> statement-breakpoint
CREATE INDEX automation_workflow_version_module ON public.automation_workflow_version (tenant_id, module, workflow_id, revision DESC);
--> statement-breakpoint
CREATE TABLE public.automation_routing_version (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  routing_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 100000),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  routing_rows jsonb NOT NULL CHECK (jsonb_typeof(routing_rows) = 'array'),
  retired boolean NOT NULL DEFAULT false,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  saved_by uuid NOT NULL REFERENCES public.app_user(id),
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, routing_id, revision)
);
--> statement-breakpoint
ALTER TABLE public.automation_workflow_version ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.automation_workflow_version FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.automation_routing_version ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.automation_routing_version FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY automation_workflow_owner ON public.automation_workflow_version FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY automation_routing_owner ON public.automation_routing_version FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
CREATE FUNCTION app.automation_can_configure(p_module text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT app.current_tenant_id() IS NOT NULL AND CASE p_module
    WHEN 'probation' THEN app.probation_active_user() AND app.access_capability_allowed('probation.module', NULL)
    ELSE false END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.automation_can_configure_any() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT app.automation_can_configure('onb') OR app.automation_can_configure('off') OR app.automation_can_configure('contract_staff') OR app.automation_can_configure('probation');
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_can_configure(text), app.automation_can_configure_any() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_can_configure(text), app.automation_can_configure_any() TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY automation_workflow_read ON public.automation_workflow_version FOR SELECT TO ai_hr_app
  USING (tenant_id = app.current_tenant_id() AND app.automation_can_configure(module));
--> statement-breakpoint
CREATE POLICY automation_routing_read ON public.automation_routing_version FOR SELECT TO ai_hr_app
  USING (tenant_id = app.current_tenant_id() AND app.automation_can_configure_any());
--> statement-breakpoint
REVOKE ALL ON public.automation_workflow_version, public.automation_routing_version FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON public.automation_workflow_version, public.automation_routing_version TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_workflow_save(p_workflow uuid, p_module text, p_status text, p_required boolean, p_definition jsonb, p_expected integer, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); prior public.automation_workflow_version; next integer;
BEGIN
  IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF p_workflow IS NULL OR NOT app.automation_can_configure(p_module) THEN RAISE EXCEPTION 'You cannot configure workflows for this module' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('automation-workflow:'||t::text||':'||p_workflow::text, 0));
  SELECT * INTO prior FROM public.automation_workflow_version WHERE tenant_id = t AND workflow_id = p_workflow ORDER BY revision DESC LIMIT 1;
  IF coalesce(prior.revision, 0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'This workflow changed since you opened it; reload before saving' USING ERRCODE='40001'; END IF;
  IF prior.revision IS NOT NULL AND prior.module <> p_module THEN RAISE EXCEPTION 'A workflow cannot move to another module' USING ERRCODE='22023'; END IF;
  IF prior.status = 'retired' THEN RAISE EXCEPTION 'A retired workflow cannot change' USING ERRCODE='22023'; END IF;
  IF coalesce(p_status, '') NOT IN ('live','paused','retired') OR p_required IS NULL OR length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Choose a status and give a reason' USING ERRCODE='22023'; END IF;
  -- Each type is checked in its own statement before a function that would fail on another type: SQL does not
  -- promise the order in which OR operands are evaluated.
  IF jsonb_typeof(p_definition) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'The workflow definition is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_definition->'trigger') IS DISTINCT FROM 'object' OR jsonb_typeof(p_definition->'conditions') IS DISTINCT FROM 'array' OR jsonb_typeof(p_definition->'steps') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'The workflow definition is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF pg_column_size(p_definition) > 262144
     OR p_definition->>'module' IS DISTINCT FROM p_module OR p_definition->>'id' IS DISTINCT FROM p_workflow::text
     OR length(btrim(coalesce(p_definition->>'name', ''))) NOT BETWEEN 1 AND 200
     OR jsonb_typeof(p_definition->'trigger'->'event') IS DISTINCT FROM 'string'
     OR jsonb_array_length(p_definition->'conditions') > 20
     OR jsonb_array_length(p_definition->'steps') NOT BETWEEN 1 AND 40
  THEN RAISE EXCEPTION 'The workflow definition is incomplete or too large' USING ERRCODE='22023'; END IF;
  next := coalesce(prior.revision, 0) + 1;
  INSERT INTO public.automation_workflow_version (tenant_id, workflow_id, revision, module, status, required, definition, reason, saved_by)
  VALUES (t, p_workflow, next, p_module, p_status, p_required, p_definition - 'status' - 'required', btrim(p_reason), app.current_user_id());
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (t, 'automation_workflow', p_workflow, CASE WHEN next = 1 THEN 'automation.workflow.created' ELSE 'automation.workflow.saved' END, 'user'::actor_type, app.current_user_id(),
    jsonb_build_object('module', p_module, 'revision', next, 'status', p_status, 'previousStatus', prior.status, 'required', p_required));
  RETURN next;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.automation_routing_save(p_routing uuid, p_name text, p_rows jsonb, p_retired boolean, p_expected integer, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); prior public.automation_routing_version; next integer;
BEGIN
  IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF p_routing IS NULL OR NOT app.automation_can_configure_any() THEN RAISE EXCEPTION 'You cannot configure routings' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('automation-routing:'||t::text||':'||p_routing::text, 0));
  SELECT * INTO prior FROM public.automation_routing_version WHERE tenant_id = t AND routing_id = p_routing ORDER BY revision DESC LIMIT 1;
  IF coalesce(prior.revision, 0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'This routing changed since you opened it; reload before saving' USING ERRCODE='40001'; END IF;
  IF prior.retired THEN RAISE EXCEPTION 'A retired routing cannot change' USING ERRCODE='22023'; END IF;
  IF p_retired IS NULL OR length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 200 OR length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 500
     OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'The routing is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_rows) > 500 OR pg_column_size(p_rows) > 262144
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE jsonb_typeof(r) <> 'object' OR jsonb_typeof(r->'match') IS DISTINCT FROM 'object'
       OR jsonb_typeof(r->'assignTo') IS DISTINCT FROM 'object' OR coalesce(r->'assignTo'->>'kind', '') NOT IN ('group','people'))
  THEN RAISE EXCEPTION 'The routing is incomplete or too large' USING ERRCODE='22023'; END IF;
  -- Every element is now an object with an object match, so reading its keys cannot fail.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r, jsonb_object_keys(r->'match') k WHERE k NOT IN ('businessGroup','company','department','jobTitle'))
  THEN RAISE EXCEPTION 'The routing is incomplete or too large' USING ERRCODE='22023'; END IF;
  next := coalesce(prior.revision, 0) + 1;
  INSERT INTO public.automation_routing_version (tenant_id, routing_id, revision, name, routing_rows, retired, reason, saved_by)
  VALUES (t, p_routing, next, btrim(p_name), p_rows, p_retired, btrim(p_reason), app.current_user_id());
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (t, 'automation_routing', p_routing, CASE WHEN next = 1 THEN 'automation.routing.created' ELSE 'automation.routing.saved' END, 'user'::actor_type, app.current_user_id(),
    jsonb_build_object('revision', next, 'retired', p_retired, 'rows', jsonb_array_length(p_rows)));
  RETURN next;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_workflow_save(uuid,text,text,boolean,jsonb,integer,text), app.automation_routing_save(uuid,text,jsonb,boolean,integer,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_workflow_save(uuid,text,text,boolean,jsonb,integer,text), app.automation_routing_save(uuid,text,jsonb,boolean,integer,text) TO ai_hr_app;
--> statement-breakpoint
-- Reference checks for the builders. Group ids and names only (members stay with lc_v9_config's readers); people only
-- as "active in this tenant" yes/no for ids the caller already holds. Both answer nothing to anyone who cannot configure.
CREATE FUNCTION app.automation_assignment_groups() RETURNS TABLE (group_id text, group_name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT g->>'id', g->>'name' FROM public.lc_v9_config c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'groups') = 'array' THEN c.data->'groups' ELSE '[]'::jsonb END) g
  WHERE c.tenant_id = app.current_tenant_id() AND app.automation_can_configure_any() ORDER BY 2, 1 LIMIT 500;
$$;
--> statement-breakpoint
CREATE FUNCTION app.automation_active_users(p_users uuid[]) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT u.id FROM public.app_user u
  WHERE app.automation_can_configure_any() AND coalesce(cardinality(p_users), 0) <= 500 AND u.id = ANY (p_users)
    AND u.tenant_id = app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_assignment_groups(), app.automation_active_users(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_assignment_groups(), app.automation_active_users(uuid[]) TO ai_hr_app;
