-- Personnel postings (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 4, build step 6).
-- Tag 5741 / idx 5141 / when 1793330005441 on the board offset (tag T, idx T - 600, when 1793330004800 + (T - 5100)),
-- directly after 5740 (when 1793330005440).
--
-- A posting is a PROPOSED Personnel Management change that a workflow (Probation first) creates and that waits in a
-- queue. Personnel Management owns the fact: nothing here writes employment data. Only approval applies the change,
-- and it does so through the existing movement writer (core/movement.ts) in the same transaction as the approval.
--
-- 1. personnel_posting is new and empty on every installation: no backfill, no populated rows to stage, no existing
--    object, grant, row or purpose-role object changes. Company key (company_id, tenant_id) per ADR-0174.
-- 2. The application reads under row security (app.personnel_posting_visible) and writes only through the
--    SECURITY DEFINER functions below, each taking the shared workforce barrier, checking authority and recording a
--    domain_event in the same transaction:
--    - create: the Probation owner path only (the probation storage runner, or the GBS holder who releases the
--      outcome), for a case of that employment with a released outcome of the matching kind. App users cannot
--      fabricate a posting for an arbitrary employment or event. Repeating the same idempotency key returns the
--      existing posting; reusing it with different content is refused.
--    - edit: anyone who may record movements for the employment (workforce.maintain). The correction is kept on the
--      posting (edited, edited_by, edited_at); the status stays pending.
--    - approve: only members of the posting's approver group (lc_v9_config groups). Checks the revision (optimistic
--      concurrency) under a row lock, marks the posting approved and returns the values to write. Two concurrent
--      approvals serialize on the row lock; the second sees the posting approved and is refused.
--    - record_movement: binds the movement the approver's transaction recorded (a domain_event of that employment
--      written in this same transaction). A deferred constraint trigger refuses to commit an approved posting without
--      its movement, so an approval whose movement write fails rolls back as a whole and the posting stays pending.
-- 3. Values are a fixed allowlist: effectiveDate (required), endDate (required for probationExtension, absent for
--    confirmation) and remarks (optional, at most 200 characters).
CREATE TABLE public.personnel_posting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  company_id uuid NOT NULL REFERENCES public.company(id),
  employment_id uuid NOT NULL REFERENCES public.employment(id),
  number integer NOT NULL CHECK (number > 0),
  source text NOT NULL CHECK (source IN ('probation')),
  source_ref uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('confirmation','probationExtension')),
  proposed jsonb NOT NULL CHECK (jsonb_typeof(proposed) = 'object'),
  edited jsonb CHECK (edited IS NULL OR jsonb_typeof(edited) = 'object'),
  edited_by uuid REFERENCES public.app_user(id),
  edited_at timestamptz,
  applied jsonb CHECK (applied IS NULL OR jsonb_typeof(applied) = 'object'),
  approver_group_id text NOT NULL CHECK (length(approver_group_id) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
  approved_by uuid REFERENCES public.app_user(id),
  approved_at timestamptz,
  movement_id text CHECK (movement_id IS NULL OR length(movement_id) BETWEEN 1 AND 200),
  created_by uuid REFERENCES public.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 100000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT personnel_posting_company_tenant_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION,
  CONSTRAINT personnel_posting_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT personnel_posting_number_key UNIQUE (tenant_id, number),
  CONSTRAINT personnel_posting_idempotency_key UNIQUE (tenant_id, source, source_ref, event_type, idempotency_key),
  CONSTRAINT personnel_posting_edit_shape CHECK ((edited IS NULL AND edited_by IS NULL AND edited_at IS NULL) OR (edited IS NOT NULL AND edited_by IS NOT NULL AND edited_at IS NOT NULL)),
  CONSTRAINT personnel_posting_status_shape CHECK (
    (status = 'pending' AND approved_by IS NULL AND approved_at IS NULL AND applied IS NULL AND movement_id IS NULL)
    OR (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND applied IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX personnel_posting_queue ON public.personnel_posting (tenant_id, created_at DESC, number DESC);
--> statement-breakpoint
CREATE INDEX personnel_posting_pending ON public.personnel_posting (tenant_id, created_at DESC) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX personnel_posting_employment ON public.personnel_posting (tenant_id, employment_id);
--> statement-breakpoint
CREATE INDEX personnel_posting_source ON public.personnel_posting (tenant_id, source, source_ref);
--> statement-breakpoint
ALTER TABLE public.personnel_posting ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.personnel_posting FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY personnel_posting_owner ON public.personnel_posting FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
-- The signed-in, active tenant user is a member of this assignment group (lc_v9_config groups; members are app_user ids).
CREATE FUNCTION app.personnel_posting_approver(p_group text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT coalesce(app.current_user_id() IS NOT NULL AND app.current_tenant_id() IS NOT NULL AND p_group IS NOT NULL
    AND app.principal_snapshot_current()
    AND EXISTS (SELECT 1 FROM public.app_user u WHERE u.id = app.current_user_id() AND u.tenant_id = app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
    AND EXISTS (SELECT 1 FROM public.lc_v9_config c
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'groups') = 'array' THEN c.data->'groups' ELSE '[]'::jsonb END) g
      WHERE c.tenant_id = app.current_tenant_id() AND g->>'id' = p_group
        AND jsonb_typeof(g->'members') = 'array' AND (g->'members') ? app.current_user_id()::text), false);
$$;
--> statement-breakpoint
-- Who may read a posting: its approver group, anyone who may record movements for the employment, and the Probation
-- case staff (HOD, PBP, GBS) for a Probation posting. Cheapest checks first; plpgsql keeps that order.
CREATE FUNCTION app.personnel_posting_visible(p_group text, p_employment uuid, p_source text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN RETURN false; END IF;
  IF app.personnel_posting_approver(p_group) IS TRUE THEN RETURN true; END IF;
  IF app.access_workforce_employment(p_employment, 'workforce.maintain') IS TRUE THEN RETURN true; END IF;
  IF p_source = 'probation' THEN
    IF (app.probation_role(p_employment, 'gbs') OR app.probation_role(p_employment, 'pbp') OR app.probation_role(p_employment, 'hod')) IS TRUE THEN RETURN true; END IF;
  END IF;
  RETURN false;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_posting_approver(text), app.personnel_posting_visible(text,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.personnel_posting_approver(text), app.personnel_posting_visible(text,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY personnel_posting_read ON public.personnel_posting FOR SELECT TO ai_hr_app
  USING (tenant_id = app.current_tenant_id() AND app.personnel_posting_visible(approver_group_id, employment_id, source));
--> statement-breakpoint
REVOKE ALL ON public.personnel_posting FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON public.personnel_posting TO ai_hr_app;
--> statement-breakpoint
-- A calendar date written yyyy-mm-dd, or NULL for anything else (never raises).
CREATE FUNCTION app.personnel_posting_day(p_value jsonb) RETURNS date LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_text text; v_day date;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
  v_text := p_value #>> '{}';
  IF v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
  BEGIN
    v_day := v_text::date;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF to_char(v_day, 'YYYY-MM-DD') <> v_text THEN RETURN NULL; END IF;
  RETURN v_day;
END $$;
--> statement-breakpoint
-- The fixed value allowlist for one event type. Each type check runs in its own statement before anything that
-- would fail on another type: SQL does not promise the evaluation order of OR operands.
CREATE FUNCTION app.personnel_posting_values_ok(p_event text, p_values jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_effective date; v_end date;
BEGIN
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_values) k WHERE k NOT IN ('effectiveDate','endDate','remarks')) THEN RETURN false; END IF;
  v_effective := app.personnel_posting_day(p_values->'effectiveDate');
  IF v_effective IS NULL THEN RETURN false; END IF;
  IF p_values ? 'remarks' AND jsonb_typeof(p_values->'remarks') <> 'null' THEN
    IF jsonb_typeof(p_values->'remarks') <> 'string' THEN RETURN false; END IF;
    IF length(p_values->>'remarks') > 200 THEN RETURN false; END IF;
  END IF;
  IF p_event = 'probationExtension' THEN
    v_end := app.personnel_posting_day(p_values->'endDate');
    IF v_end IS NULL THEN RETURN false; END IF;
    RETURN true;
  END IF;
  IF p_event = 'confirmation' THEN
    IF p_values ? 'endDate' AND jsonb_typeof(p_values->'endDate') <> 'null' THEN RETURN false; END IF;
    RETURN true;
  END IF;
  RETURN false;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_posting_day(jsonb), app.personnel_posting_values_ok(text,jsonb) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.personnel_posting_create(p_source text, p_source_ref uuid, p_employment uuid, p_event text, p_proposed jsonb, p_approver_group text, p_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); v_employment public.employment; v_existing public.personnel_posting; v_number integer; v_id uuid; v_key text := btrim(coalesce(p_key, ''));
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'A tenant is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF p_source IS DISTINCT FROM 'probation' OR p_event IS NULL OR p_event NOT IN ('confirmation','probationExtension') OR p_source_ref IS NULL
     OR length(v_key) NOT BETWEEN 1 AND 200 OR length(coalesce(p_approver_group, '')) NOT BETWEEN 1 AND 200
  THEN RAISE EXCEPTION 'The posting is incomplete' USING ERRCODE='22023'; END IF;
  IF app.personnel_posting_values_ok(p_event, p_proposed) IS NOT TRUE THEN RAISE EXCEPTION 'The posting values are incomplete or not allowed' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_employment FROM public.employment WHERE id = p_employment AND tenant_id = t;
  IF NOT FOUND THEN RAISE EXCEPTION 'Personnel posting source unavailable' USING ERRCODE='42501'; END IF;
  -- The Probation owner path only: the storage runner (sweep) or the GBS holder who releases the outcome.
  IF (app.probation_storage_runner() OR app.probation_role(v_employment.id, 'gbs')) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only the Probation outcome can create this posting' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.probation_case c JOIN public.probation_outcome o ON o.case_id = c.id AND o.tenant_id = c.tenant_id
      WHERE c.id = p_source_ref AND c.tenant_id = t AND c.employment_id = v_employment.id AND o.released_at IS NOT NULL
        AND o.outcome = CASE p_event WHEN 'confirmation' THEN 'confirm' ELSE 'extend' END)
  THEN RAISE EXCEPTION 'A released Probation outcome of this kind is required' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lc_v9_config c
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'groups') = 'array' THEN c.data->'groups' ELSE '[]'::jsonb END) g
      WHERE c.tenant_id = t AND g->>'id' = p_approver_group)
  THEN RAISE EXCEPTION 'Choose an existing assignment group to approve Personnel postings' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('personnel-posting:' || t::text, 0));
  SELECT * INTO v_existing FROM public.personnel_posting
    WHERE tenant_id = t AND source = p_source AND source_ref = p_source_ref AND event_type = p_event AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing.employment_id <> v_employment.id OR v_existing.proposed <> p_proposed OR v_existing.approver_group_id <> p_approver_group THEN
      RAISE EXCEPTION 'This posting was already created with different content' USING ERRCODE='22023'; END IF;
    RETURN v_existing.id;
  END IF;
  SELECT coalesce(max(p.number), 1000) + 1 INTO v_number FROM public.personnel_posting p WHERE p.tenant_id = t;
  INSERT INTO public.personnel_posting (tenant_id, company_id, employment_id, number, source, source_ref, event_type, proposed, approver_group_id, created_by, idempotency_key)
  VALUES (t, v_employment.company_id, v_employment.id, v_number, p_source, p_source_ref, p_event, p_proposed, p_approver_group, app.current_user_id(), v_key)
  RETURNING id INTO v_id;
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, subject_employment_id, payload)
  VALUES (t, 'personnel_posting', v_id, 'personnel_posting.created',
    CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END, app.current_user_id(), v_employment.id,
    jsonb_build_object('number', v_number, 'source', p_source, 'sourceRef', p_source_ref, 'eventType', p_event, 'proposed', p_proposed, 'approverGroupId', p_approver_group));
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.personnel_posting_edit(p_id uuid, p_revision integer, p_values jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); v_row public.personnel_posting; v_before jsonb;
BEGIN
  IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  SELECT * INTO v_row FROM public.personnel_posting WHERE id = p_id AND tenant_id = t FOR UPDATE;
  IF NOT FOUND OR app.access_workforce_employment(v_row.employment_id, 'workforce.maintain') IS NOT TRUE THEN
    RAISE EXCEPTION 'You cannot correct this posting' USING ERRCODE='42501'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This posting was already approved' USING ERRCODE='40001'; END IF;
  IF v_row.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This posting changed since you opened it; reload before saving' USING ERRCODE='40001'; END IF;
  IF app.personnel_posting_values_ok(v_row.event_type, p_values) IS NOT TRUE THEN RAISE EXCEPTION 'The posting values are incomplete or not allowed' USING ERRCODE='22023'; END IF;
  v_before := coalesce(v_row.edited, v_row.proposed);
  IF v_before = p_values THEN RETURN v_row.revision; END IF;
  UPDATE public.personnel_posting SET edited = p_values, edited_by = app.current_user_id(), edited_at = now(), revision = v_row.revision + 1
    WHERE id = v_row.id AND tenant_id = t;
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, subject_employment_id, payload)
  VALUES (t, 'personnel_posting', v_row.id, 'personnel_posting.edited', 'user'::actor_type, app.current_user_id(), v_row.employment_id,
    jsonb_build_object('number', v_row.number, 'eventType', v_row.event_type, 'before', v_before, 'after', p_values, 'revision', v_row.revision + 1));
  RETURN v_row.revision + 1;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.personnel_posting_approve(p_id uuid, p_revision integer, p_values jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); v_row public.personnel_posting; v_values jsonb;
BEGIN
  IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  SELECT * INTO v_row FROM public.personnel_posting WHERE id = p_id AND tenant_id = t FOR UPDATE;
  IF NOT FOUND OR app.personnel_posting_approver(v_row.approver_group_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only members of the posting approver group can approve this posting' USING ERRCODE='42501'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This posting was already approved' USING ERRCODE='40001'; END IF;
  IF v_row.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This posting changed since you opened it; reload before approving' USING ERRCODE='40001'; END IF;
  v_values := coalesce(p_values, v_row.edited, v_row.proposed);
  IF app.personnel_posting_values_ok(v_row.event_type, v_values) IS NOT TRUE THEN RAISE EXCEPTION 'The posting values are incomplete or not allowed' USING ERRCODE='22023'; END IF;
  UPDATE public.personnel_posting SET status = 'approved', approved_by = app.current_user_id(), approved_at = now(), applied = v_values, revision = v_row.revision + 1
    WHERE id = v_row.id AND tenant_id = t;
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, subject_employment_id, payload)
  VALUES (t, 'personnel_posting', v_row.id, 'personnel_posting.approved', 'user'::actor_type, app.current_user_id(), v_row.employment_id,
    jsonb_build_object('number', v_row.number, 'eventType', v_row.event_type, 'source', v_row.source, 'sourceRef', v_row.source_ref, 'applied', v_values,
      'changedOnApproval', v_values IS DISTINCT FROM coalesce(v_row.edited, v_row.proposed), 'revision', v_row.revision + 1));
  RETURN jsonb_build_object('id', v_row.id, 'number', v_row.number, 'employmentId', v_row.employment_id, 'eventType', v_row.event_type, 'values', v_values, 'revision', v_row.revision + 1);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.personnel_posting_record_movement(p_id uuid, p_movement text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); v_row public.personnel_posting; v_event uuid;
BEGIN
  IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_row FROM public.personnel_posting WHERE id = p_id AND tenant_id = t FOR UPDATE;
  IF NOT FOUND OR v_row.status <> 'approved' OR v_row.approved_by IS DISTINCT FROM app.current_user_id() OR v_row.approved_at IS DISTINCT FROM now() OR v_row.movement_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only the approval that applied this posting can record its movement' USING ERRCODE='42501'; END IF;
  IF coalesce(p_movement, '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'The applied movement is unavailable' USING ERRCODE='22023'; END IF;
  v_event := p_movement::uuid;
  IF NOT EXISTS (SELECT 1 FROM public.domain_event d WHERE d.id = v_event AND d.tenant_id = t AND d.subject_employment_id = v_row.employment_id AND d.occurred_at = now()) THEN
    RAISE EXCEPTION 'The applied movement was not recorded by this approval' USING ERRCODE='22023'; END IF;
  UPDATE public.personnel_posting SET movement_id = lower(p_movement) WHERE id = v_row.id AND tenant_id = t;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_posting_create(text,uuid,uuid,text,jsonb,text,text), app.personnel_posting_edit(uuid,integer,jsonb),
  app.personnel_posting_approve(uuid,integer,jsonb), app.personnel_posting_record_movement(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.personnel_posting_create(text,uuid,uuid,text,jsonb,text,text), app.personnel_posting_edit(uuid,integer,jsonb),
  app.personnel_posting_approve(uuid,integer,jsonb), app.personnel_posting_record_movement(uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- An approved posting must carry the movement it applied when its transaction commits.
CREATE FUNCTION app.personnel_posting_approval_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.personnel_posting p WHERE p.id = NEW.id AND p.status = 'approved' AND p.movement_id IS NULL) THEN
    RAISE EXCEPTION 'An approved Personnel posting must record the movement it applied in the same transaction' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_posting_approval_complete() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER personnel_posting_approval_complete AFTER INSERT OR UPDATE ON public.personnel_posting
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.personnel_posting_approval_complete();
--> statement-breakpoint
-- Display labels for the queue: names of the people who edited or approved, and assignment group names, only for
-- postings the caller can read. Bounded to the ids the caller already holds.
CREATE FUNCTION app.personnel_posting_people(p_users uuid[]) RETURNS TABLE (user_id uuid, full_name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT u.id, per.full_name FROM public.app_user u LEFT JOIN public.person per ON per.id = u.person_id AND per.tenant_id = u.tenant_id
  WHERE coalesce(cardinality(p_users), 0) <= 500 AND u.id = ANY (p_users) AND u.tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM public.personnel_posting p WHERE p.tenant_id = u.tenant_id AND (p.edited_by = u.id OR p.approved_by = u.id OR p.created_by = u.id)
      AND app.personnel_posting_visible(p.approver_group_id, p.employment_id, p.source));
$$;
--> statement-breakpoint
CREATE FUNCTION app.personnel_posting_groups(p_groups text[]) RETURNS TABLE (group_id text, group_name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT g->>'id', g->>'name' FROM public.lc_v9_config c
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'groups') = 'array' THEN c.data->'groups' ELSE '[]'::jsonb END) g
  WHERE c.tenant_id = app.current_tenant_id() AND coalesce(cardinality(p_groups), 0) <= 200 AND g->>'id' = ANY (p_groups)
    AND EXISTS (SELECT 1 FROM public.personnel_posting p WHERE p.tenant_id = c.tenant_id AND p.approver_group_id = g->>'id'
      AND app.personnel_posting_visible(p.approver_group_id, p.employment_id, p.source));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_posting_people(uuid[]), app.personnel_posting_groups(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.personnel_posting_people(uuid[]), app.personnel_posting_groups(text[]) TO ai_hr_app;
