-- Security review of the Irwin attendance lane (12 November 2026). Draft reservation 5144 @ idx 4544 / when
-- 1793330004844 (unapplied). Supersedes the 5143 window mechanics; 5140-5143 bytes are unchanged.
--  * The window has its own setting (app.attendance_final_window), separate from the per-effect hint, installed only by
--    app.attendance_workflow_open_final_window after the full proof, as a token bound to this transaction, the correction,
--    the subject and an owner-only key. Later calls verify the token (one indexed row) and never re-run the proof.
--  * One-shot: app.attendance_workflow_close_final_window clears it and records the transaction as spent in an
--    owner-only table, so a replayed setting value cannot reopen it later in the same transaction.
--  * The proof requires the participant's level to be complete with that outcome, and admits a rejection only when it
--    is OT-bearing (the only rejection that needs calculation visibility).
--  * The window branch is last in can_see_employment; visible_employment_ids runs the 2105 statement unchanged and
--    merges the subject only when the window setting is present. Both use search_path pg_catalog, public, pg_temp.
--  * Escalation never takes an as_of ahead of the HR-local date.

CREATE TABLE app.attendance_final_window_key (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), secret text NOT NULL CHECK(length(secret)>=64));
INSERT INTO app.attendance_final_window_key(secret) VALUES(replace(gen_random_uuid()::text||gen_random_uuid()::text||gen_random_uuid()::text,'-',''));
REVOKE ALL ON app.attendance_final_window_key FROM PUBLIC,ai_hr_app;
-- Transactions whose window was closed. Owner-written, so no session setting can revive a closed window. Rows older
-- than a day are removed by the setter.
CREATE TABLE app.attendance_final_window_spent (xact xid8 PRIMARY KEY, spent_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX attendance_final_window_spent_at ON app.attendance_final_window_spent(spent_at);
REVOKE ALL ON app.attendance_final_window_spent FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- The transaction-, correction- and subject-bound token. Owner only.
CREATE FUNCTION app.attendance_final_window_token(correction uuid,subject uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT md5(k.secret||':'||pg_current_xact_id_if_assigned()::text||':'||correction::text||':'||subject::text||':'||coalesce(app.current_user_id()::text,''))
 FROM app.attendance_final_window_key k WHERE k.singleton AND pg_current_xact_id_if_assigned() IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION app.attendance_final_window_token(uuid,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- The full proof, run once by the setter: a v3/v4 correction of the current tenant, pending or decided by this
-- transaction; the live caller's participant decision written in this transaction (active write) at the request's
-- final frozen level for an approval, or an OT-bearing rejection; that level complete with that outcome; and either no
-- completion row yet or the caller's same-transaction completion row with the same outcome.
CREATE FUNCTION app.attendance_final_window_prove(correction uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE caller uuid:=app.current_user_id(); w public.attendance_workflow_request; c public.attendance_correction; p public.attendance_workflow_participant_decision;
BEGIN
 IF correction IS NULL OR caller IS NULL OR app.current_tenant_id() IS NULL THEN RETURN NULL; END IF;
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.correction_id=correction AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT x.* INTO c FROM public.attendance_correction x WHERE x.id=w.correction_id AND x.tenant_id=w.tenant_id AND x.employment_id=w.employment_id;
 IF NOT FOUND OR NOT (c.status='pending' OR app.attendance_workflow_active_write(c.xmin)) THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=caller AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN NULL; END IF;
 SELECT d.* INTO p FROM public.attendance_workflow_participant_decision d
  WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.employment_id=w.employment_id AND d.actual_user_id=caller AND app.attendance_workflow_active_write(d.xmin)
   AND ((d.decision='approved' AND d.stage_index=jsonb_array_length(w.stages)-1) OR (d.decision='rejected' AND c.requested_ot_minutes IS NOT NULL))
  ORDER BY d.decided_at DESC,d.id DESC LIMIT 1;
 IF NOT FOUND OR app.attendance_workflow_v3_completed(w.id,p.stage_index) IS DISTINCT FROM p.decision THEN RETURN NULL; END IF;
 IF NOT ((w.current_stage=p.stage_index AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=p.stage_index))
  OR (w.current_stage=jsonb_array_length(w.stages) AND EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id
   AND d.stage_index=p.stage_index AND d.decision=p.decision AND d.actual_user_id=caller::text AND app.attendance_workflow_active_write(d.xmin)))) THEN RETURN NULL; END IF;
 RETURN w.employment_id;
END $$;
REVOKE ALL ON FUNCTION app.attendance_final_window_prove(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Hot path (replaces 5143). Without app.attendance_final_window it is never reached (the callers test the setting);
-- with it, the value must be this transaction's token for that correction and subject. A forged value yields NULL.
CREATE OR REPLACE FUNCTION app.attendance_effect_window_employment() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE raw text:=coalesce(current_setting('app.attendance_final_window',true),''); part text[]; correction uuid; subject uuid;
BEGIN
 IF raw='' THEN RETURN NULL; END IF;
 part:=string_to_array(raw,'/');
 IF cardinality(part)<>3 OR part[1] !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' OR part[2] !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
 correction:=part[1]::uuid; subject:=part[2]::uuid;
 IF part[3] IS DISTINCT FROM app.attendance_final_window_token(correction,subject)
  OR EXISTS(SELECT 1 FROM app.attendance_final_window_spent s WHERE s.xact=pg_current_xact_id_if_assigned()) THEN RETURN NULL; END IF;
 RETURN subject;
END $$;

--> statement-breakpoint
-- Setter (replaces 5143): once per transaction, only after the full proof.
CREATE OR REPLACE FUNCTION app.attendance_workflow_open_final_window(correction uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject uuid; token text;
BEGIN
 IF correction IS NULL OR pg_current_xact_id_if_assigned() IS NULL OR coalesce(current_setting('app.attendance_final_window',true),'')<>''
  OR EXISTS(SELECT 1 FROM app.attendance_final_window_spent s WHERE s.xact=pg_current_xact_id_if_assigned()) THEN RETURN false; END IF;
 DELETE FROM app.attendance_final_window_spent WHERE spent_at<now()-interval '1 day';
 subject:=app.attendance_final_window_prove(correction);
 IF subject IS NULL THEN RETURN false; END IF;
 token:=app.attendance_final_window_token(correction,subject);
 IF token IS NULL THEN RETURN false; END IF;
 PERFORM set_config('app.attendance_final_window',correction::text||'/'||subject::text||'/'||token,true);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_open_final_window(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_open_final_window(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Close: clears the window and marks it consumed, so later code in the same transaction cannot reopen it.
CREATE FUNCTION app.attendance_workflow_close_final_window() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM set_config('app.attendance_final_window','',true);
 IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
  INSERT INTO app.attendance_final_window_spent(xact) VALUES(pg_current_xact_id_if_assigned()) ON CONFLICT (xact) DO NOTHING;
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_close_final_window() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_close_final_window() TO ai_hr_app;

--> statement-breakpoint
-- Replaces 5143: the window branch last and gated by its own setting; every other arm is the 0109 body.
CREATE OR REPLACE FUNCTION app.can_see_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
      SELECT 1 FROM employment e
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND app.is_admin_for(e.company_id)
    )
    OR EXISTS (
      SELECT 1 FROM employment e JOIN app_user u ON u.person_id = e.person_id
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND u.id = app.current_user_id()
    )
    OR EXISTS (
      -- Recursive administrative-manager branch (direct + indirect reports), over all caller employments.
      SELECT 1 FROM employment me
        JOIN app_user u ON u.person_id = me.person_id
      WHERE u.id = app.current_user_id()
        AND me.tenant_id = app.current_tenant_id()
        AND me.terminated_on IS NULL
        AND app.is_admin_report_of(emp_id, me.id)
    )
    OR EXISTS (
      -- HOD department-tree branch, over all caller employments.
      SELECT 1 FROM employment me
        JOIN app_user u ON u.person_id = me.person_id
      WHERE u.id = app.current_user_id()
        AND me.tenant_id = app.current_tenant_id()
        AND me.terminated_on IS NULL
        AND app.heads_department_of(emp_id, me.id)
    )
    -- 5144: LAST, and one setting read unless the request-bound final-decision window was opened in this transaction.
    OR coalesce(coalesce(current_setting('app.attendance_final_window', true), '') <> ''
      AND emp_id = app.attendance_effect_window_employment(), false);
$$;

--> statement-breakpoint
-- Replaces 5143: the 2105 reader unchanged, plus the window's subject only when the window setting is present.
CREATE OR REPLACE FUNCTION app.visible_employment_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE possible_admin boolean; visible_ids uuid[]; window_employment uuid;
BEGIN
 -- Normalize the exact current grant shape once for this invocation. The employment
 -- existence guard preserves the original empty-tenant course, including malformed inputs.
 SELECT EXISTS(
  SELECT 1 FROM (
   SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) AS grants
   FROM app.current_grants() g
   WHERE EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id())
  ) normalized CROSS JOIN LATERAL jsonb_array_elements(normalized.grants) payload(value)
  WHERE payload.value->>'role' IN ('hr_admin','super_admin')
 ) INTO possible_admin;
 visible_ids := (
  WITH RECURSIVE
  -- The caller's employments that can_see_employment's manager and HOD arms iterate over:
  -- `employment me JOIN app_user u ON u.person_id = me.person_id WHERE u.id = app.current_user_id()
  --  AND me.tenant_id = app.current_tenant_id() AND me.terminated_on IS NULL`.
  me AS (
    SELECT e.id, e.company_id
    FROM employment e
    JOIN app_user u ON u.person_id = e.person_id
    WHERE u.id = app.current_user_id()
      AND e.tenant_id = app.current_tenant_id()
      AND e.terminated_on IS NULL
  ),
  -- (a) ADMIN arm: `e.tenant_id = app.current_tenant_id() AND app.is_admin_for(e.company_id)`.
  -- is_admin_for depends only on the company id and the session's grants, so it is evaluated once per
  -- DISTINCT company of the tenant's employments instead of once per employment.
  -- An optimization fence is necessary: without it PostgreSQL pushes is_admin_for below
  -- DISTINCT and repeats the same grant check for every employment in a company.
  tenant_company AS MATERIALIZED (
    SELECT DISTINCT e.company_id FROM employment e WHERE e.tenant_id = app.current_tenant_id() AND possible_admin
  ),
  admin_company AS MATERIALIZED (
    SELECT c.company_id
    FROM tenant_company c
    WHERE app.is_admin_for(c.company_id)
  ),
  -- (c) MANAGER arm: app.is_admin_report_of(subject, me.id) for every caller employment `me`, as ONE
  -- recursive walk seeded from all of them. Each path carries the company of the seed employment it
  -- started from (is_admin_report_of's `mgr.root_company`), so the company clamp on every hop is the
  -- clamp of THAT path's root — never another of the caller's employments'. UNION over
  -- (root_company, emp, depth) yields, per root company, exactly the union of the per-manager sets.
  down AS (
    SELECT m.company_id AS root_company, rl.subordinate_employment_id AS emp, 1 AS depth
    FROM me m
    JOIN reporting_line rl ON rl.manager_employment_id = m.id
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND sub.terminated_on IS NULL
      AND app.is_company_descendant(sub.company_id, m.company_id)
    UNION
    SELECT d.root_company, rl.subordinate_employment_id, d.depth + 1
    FROM down d
    JOIN reporting_line rl ON rl.manager_employment_id = d.emp
    JOIN employment mid ON mid.id = rl.manager_employment_id
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND mid.terminated_on IS NULL
      AND sub.terminated_on IS NULL
      AND d.depth < 64
      AND app.is_company_descendant(sub.company_id, d.root_company)
  ),
  -- (d) HOD arm: app.heads_department_of(subject, me.id) (0121) for every caller employment `me`.
  -- caller_dept = heads_department_of's caller_dept per caller (current assignment, department set;
  -- `e.terminated_on IS NULL` is already in `me`), kept only for a caller that ALSO manages at least one
  -- current administrative reporting line — heads_department_of's second EXISTS, which depends on the
  -- caller alone, so filtering that caller's rows here is the same condition.
  caller_dept AS (
    SELECT m.id AS caller, a.department_id AS dept, d.company_id AS company
    FROM me m
    JOIN assignment a ON a.employment_id = m.id
    JOIN department d ON d.id = a.department_id
    WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM reporting_line rl
        WHERE rl.manager_employment_id = m.id
          AND rl.line_type = 'administrative'
          AND rl.superseded_at IS NULL
          AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      )
  ),
  -- The department subtree per caller (inclusive). A hop is admitted when the child department's company
  -- descends from the company of ANY of THAT caller's departments — heads_department_of's
  -- `JOIN caller_dept cd ON true WHERE app.is_company_descendant(d.company_id, cd.company)`, whose
  -- caller_dept holds one caller's rows only. depth < 64 as there. UNION (not UNION ALL) only removes
  -- duplicate rows; the set of reachable departments is the same.
  dept_down AS (
    SELECT cd.caller, cd.dept AS id, 0 AS depth
    FROM caller_dept cd
    UNION
    SELECT dd.caller, d.id, dd.depth + 1
    FROM dept_down dd
    JOIN department d ON d.parent_department_id = dd.id
    JOIN caller_dept cd ON cd.caller = dd.caller
    WHERE app.is_company_descendant(d.company_id, cd.company)
      AND dd.depth < 64
  ),
  -- heads_department_of's subject_dept: the subject's current assignment lies in the subtree.
  hod AS (
    SELECT a.employment_id
    FROM assignment a
    WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
      AND a.department_id IN (SELECT dd.id FROM dept_down dd)
  ),
  visible AS (
    SELECT e.id
    FROM employment e
    WHERE e.tenant_id = app.current_tenant_id()
      AND e.company_id IN (SELECT ac.company_id FROM admin_company ac)
    UNION
    -- (b) SELF arm: `e.tenant_id = app.current_tenant_id() AND u.id = app.current_user_id()`.
    SELECT e.id
    FROM employment e
    JOIN app_user u ON u.person_id = e.person_id
    WHERE e.tenant_id = app.current_tenant_id()
      AND u.id = app.current_user_id()
    UNION
    SELECT d.emp FROM down d
    UNION
    SELECT h.employment_id FROM hod h
  )
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL
 );
 -- 5144: the reader above is the 2105 statement unchanged. Only while the request-bound final-decision window is
 -- open in this transaction is its single subject merged in.
 IF coalesce(current_setting('app.attendance_final_window', true), '') <> '' THEN
  window_employment := app.attendance_effect_window_employment();
  IF window_employment IS NOT NULL AND NOT window_employment = ANY(visible_ids) THEN
   visible_ids := (SELECT array_agg(x ORDER BY x) FROM unnest(visible_ids || window_employment) x);
  END IF;
 END IF;
 RETURN visible_ids;
END;
$$;

--> statement-breakpoint
-- Replaces 5141: the escalation owner never takes an as_of ahead of the HR-local date.
CREATE OR REPLACE FUNCTION app.attendance_workflow_escalate(wanted_request uuid,as_of date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; status text; days integer; from_actors jsonb; partial jsonb; next_actors jsonb; recorded public.attendance_workflow_escalation;
BEGIN
 -- 5144: never ahead of the HR-local calendar. Tests move due dates back through the owner instead.
 as_of:=LEAST(as_of,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
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

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_workflow_escalation_due(as_of date,after_on date,after_id uuid,page_size integer)
RETURNS TABLE(id uuid,escalate_on date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NOT NULL OR as_of IS NULL OR page_size NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Only the scheduled system runner may list due attendance escalations' USING ERRCODE='42501'; END IF;
 as_of:=LEAST(as_of,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
 RETURN QUERY SELECT w.id,w.escalate_on FROM public.attendance_workflow_request w
  WHERE w.tenant_id=app.current_tenant_id() AND w.escalate_on IS NOT NULL AND w.escalate_on<=as_of
   AND (after_on IS NULL OR (w.escalate_on,w.id)>(after_on,after_id))
  ORDER BY w.escalate_on,w.id LIMIT page_size;
END $$;
