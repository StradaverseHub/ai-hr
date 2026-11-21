-- Probation automation recipients and the tracker's routed approver steps (lane I of the Probation Confirmation build;
-- I6, I9, I11). Tag 5761 / idx 5161 / when 1793330005461.
--
-- 1. app.probation_automation_active_users(case, users): which of the named people a shared workflow step names are
--    active users of this tenant (not archived, sign-in not blocked), for the runner of that case only
--    (app.automation_can_run('probation', case)), bounded to 500. A named person who is not active no longer counts as
--    resolved: the step records who it was meant for and the fallback group receives it.
-- 2. app.probation_tracker_page (5746 body): a part waiting on a routed approver step (routing, group or named people)
--    also returns `waitingLabel` (the step's label, else the routing's or group's name) and `waitingName` (the person
--    holding the step, else the step's current dated holder), so the tracker never shows a raw role id or "Holder needs
--    resolution" for a step someone holds. Bounded to the page as before.
-- 3. app.probation_shared_workflow_triggers(): the triggers of the tenant's shared Probation workflows that are Live, or
--    that were moved from the notify-only engine (whatever their status), for an active Probation user, bounded. The
--    readiness warning ("Some default probation messages are unavailable") no longer shows for events they cover.
-- No table, row, grant, policy or purpose-owned object changes; the new functions are owner-owned and granted to
-- ai_hr_app; the re-created function keeps its signature, owner and grants.
CREATE FUNCTION app.probation_automation_active_users(p_case uuid,p_users uuid[]) RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.automation_can_run('probation',p_case) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE='42501';END IF;
 IF coalesce(cardinality(p_users),0)>500 THEN RAISE EXCEPTION 'Too many people' USING ERRCODE='22023';END IF;
 RETURN QUERY SELECT u.id FROM public.app_user u WHERE u.id=ANY(p_users) AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
END $$
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_tracker_page(p_cases uuid[]) RETURNS TABLE(case_id uuid,parts jsonb,letter jsonb,names jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
#variable_conflict use_column
DECLARE t uuid:=app.current_tenant_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;allowed uuid[];
BEGIN
 IF t IS NULL OR coalesce(cardinality(p_cases),0) NOT BETWEEN 1 AND 200 THEN RETURN;END IF;
 allowed:=ARRAY(SELECT app.probation_visible_among(p_cases));
 RETURN QUERY
 WITH c AS MATERIALIZED (SELECT pc.id,pc.employment_id,pc.company_id,pc.tenant_id,pc.data FROM public.probation_case pc WHERE pc.tenant_id=t AND pc.id=ANY(allowed)),
 cur AS MATERIALIZED (SELECT c.id,c.employment_id FROM c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id WHERE c.data->>'sourceCompanyMoved' IS DISTINCT FROM 'true'),
 h AS MATERIALIZED (SELECT * FROM app.probation_holders_set(ARRAY(SELECT cur.employment_id FROM cur))),
 parts AS (
  SELECT p.case_id,jsonb_agg(jsonb_build_object('id',p.id,'type',(p.data->>'type')::integer,'cycle',(p.data->>'cycle')::integer,'state',p.data->>'state','dueOn',p.data->>'dueOn','managerSubmittedAt',p.data->>'managerSubmittedAt','staffSubmittedAt',p.data->>'staffSubmittedAt','acknowledgedAt',p.data->>'acknowledgedAt','scoreBand',(p.data->>'scoreBand')::integer,'override',coalesce((p.data->>'override')::boolean,false),
   'waitingRole',CASE WHEN p.data->>'state' IN('locked','completed_offline','cancelled','not_issued') THEN NULL WHEN p.data->>'type'<>'1' AND p.data->>'staffSubmittedAt' IS NULL AND p.data->>'employeeWaitException' IS NULL THEN 'employee' WHEN p.data->>'managerSubmittedAt' IS NULL THEN 'lm' WHEN p.data->>'acknowledgedAt' IS NULL THEN 'employee'
    ELSE coalesce(ps.s->>'role','gbs') END,
   -- 5761 (I9): a routed approver step (routing, group or named people) shows its label and the person who holds it,
   -- never the raw role id; the case's own roles keep the names below.
   'waitingLabel',CASE WHEN p.data->>'state' NOT IN('locked','completed_offline','cancelled','not_issued') AND p.data->>'acknowledgedAt' IS NOT NULL AND ps.s->>'role' ~ '^(routing:|group:|people$)' THEN coalesce(nullif(ps.s->>'label',''),app.probation_form_approver_label(ps.s->>'role')) END,
   'waitingName',CASE WHEN p.data->>'state' NOT IN('locked','completed_offline','cancelled','not_issued') AND p.data->>'acknowledgedAt' IS NOT NULL AND ps.s->>'role' ~ '^(routing:|group:|people$)' THEN
    coalesce((SELECT n.full_name FROM public.app_user u JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id WHERE u.tenant_id=t AND u.id::text=ps.s->>'holderId'),
     (SELECT n.full_name FROM public.probation_delegate x JOIN public.app_user u ON u.id=x.holder_id AND u.tenant_id=x.tenant_id JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id
      WHERE x.part_id=p.id AND x.tenant_id=t AND x.step_id=ps.s->>'id' AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day) ORDER BY x.valid_from DESC LIMIT 1)) END) ORDER BY (p.data->>'cycle')::integer,(p.data->>'type')::integer,p.id) AS parts
  FROM public.probation_part p
  LEFT JOIN LATERAL (SELECT s FROM public.document_signing_document d CROSS JOIN LATERAL jsonb_array_elements(d.data->'route'->'steps') s WHERE d.subject_type='probation' AND d.subject_id=p.id AND d.tenant_id=p.tenant_id AND NOT app.document_signing_step_fulfilled(d.data,s) AND s->>'coveredByStepId' IS NULL ORDER BY (s->>'stage')::integer,s->>'id' LIMIT 1) ps ON true
  WHERE p.tenant_id=t AND p.case_id=ANY(allowed) AND coalesce(p.data->>'documentKind','review')='review' GROUP BY p.case_id),
 names AS (
  SELECT x.case_id,jsonb_agg(DISTINCT jsonb_build_object('role',x.role,'name',x.name)) AS names FROM (
   SELECT cur.id AS case_id,r.role,n.full_name AS name FROM cur JOIN h ON h.employment_id=cur.employment_id
    CROSS JOIN LATERAL (VALUES('employee',h.employee),('lm',h.lm),('hod',h.hod),('pbp',h.pbp)) r(role,user_id)
    JOIN public.app_user u ON u.id=r.user_id AND u.tenant_id=t JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id
   UNION ALL
   SELECT cur.id,x.step_id,n.full_name FROM cur JOIN public.probation_part r ON r.case_id=cur.id AND r.tenant_id=t
    JOIN public.probation_delegate x ON x.part_id=r.id AND x.tenant_id=t AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day)
    JOIN public.app_user u ON u.id=x.holder_id AND u.tenant_id=t JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id
   UNION ALL
   -- Escalated holders, only for parts that can be waiting on someone (the tracker names no one on settled parts).
   SELECT cur.id,s->>'role',n.full_name FROM cur JOIN public.probation_part part ON part.case_id=cur.id AND part.tenant_id=t
    AND part.data->>'state' NOT IN('locked','completed_offline','cancelled','not_issued')
    CROSS JOIN LATERAL jsonb_array_elements(app.probation_resolve_route_unchecked(part.id)->'steps') s
    JOIN public.app_user u ON u.id=(s->>'holderId')::uuid AND u.tenant_id=part.tenant_id JOIN public.person n ON n.id=u.person_id AND n.tenant_id=u.tenant_id
    WHERE s->>'representedId' IS NOT NULL
  ) x GROUP BY x.case_id)
 SELECT c.id,coalesce(parts.parts,'[]'::jsonb),
  CASE WHEN EXISTS(SELECT 1 FROM public.probation_part l WHERE l.case_id=c.id AND l.tenant_id=t AND l.data->>'documentKind'='letter') THEN (SELECT to_jsonb(lt) FROM app.probation_letter_tasks(c.id) lt LIMIT 1) END,
  coalesce(names.names,'[]'::jsonb)
 FROM c LEFT JOIN parts ON parts.case_id=c.id LEFT JOIN names ON names.case_id=c.id;
END $$
--> statement-breakpoint
CREATE FUNCTION app.probation_shared_workflow_triggers() RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.probation_active_user() IS TRUE THEN coalesce(array_agg(DISTINCT latest.trigger ORDER BY latest.trigger),'{}'::text[]) ELSE '{}'::text[] END
 FROM (SELECT DISTINCT ON (v.workflow_id) v.workflow_id,v.status,v.definition->'trigger'->>'event' AS trigger FROM public.automation_workflow_version v
  WHERE v.tenant_id=app.current_tenant_id() AND v.module='probation' ORDER BY v.workflow_id,v.revision DESC LIMIT 2000) latest
 WHERE latest.status='live' OR EXISTS(SELECT 1 FROM public.probation_workflow_move m WHERE m.tenant_id=app.current_tenant_id() AND m.workflow_id=latest.workflow_id)
$$
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_automation_active_users(uuid,uuid[]),app.probation_shared_workflow_triggers() FROM PUBLIC
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_automation_active_users(uuid,uuid[]),app.probation_shared_workflow_triggers() TO ai_hr_app
