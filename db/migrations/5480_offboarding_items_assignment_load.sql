-- Board item d1e26f81 — open offboarding Return and revoke items count toward each person's open-task limit, so
-- round robin takes turns between leavers. DRAFT block 5480–5499 (coordinator reallocates).
-- Function only: the same signature, SECURITY DEFINER, permission predicate and grants as 0713; no table, column,
-- policy or data change. task_load additionally counts items on submitted offboarding cases that are To do or In
-- progress and assigned to the user. This also lowers how many new onboarding items a busy returns owner receives.
--
-- Rollback (manual, only if never relied upon): re-run the 0713 definition of app.onboarding_assignment_loads().
CREATE OR REPLACE FUNCTION app.onboarding_assignment_loads()
RETURNS TABLE(user_id uuid,task_load bigint,last_auto text,pending_approvals bigint,lifetime_approvals bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH permitted AS (
 SELECT app.is_admin() OR app.onboarding_page_access() OR app.is_group_admin() OR EXISTS(
 SELECT 1 FROM lc_onboarding_config cfg,jsonb_array_elements(cfg.data->'groups') g
 WHERE cfg.tenant_id=app.current_tenant_id() AND (g->'members') ? app.current_user_id()::text) AS ok
 ), cs AS (SELECT c.data FROM lc_onboarding_case c,permitted WHERE c.tenant_id=app.current_tenant_id() AND permitted.ok),
 tasks AS (SELECT c.data->>'state' AS case_state,t FROM cs c,jsonb_array_elements(c.data->'tasks') t),
 claimed_items AS (SELECT i FROM cs c,jsonb_array_elements(c.data->'requisitions') r,jsonb_array_elements(r->'items') i WHERE c.data->>'state'='submitted' AND r->>'cancelledAt' IS NULL AND i->>'removed'='false' AND i->>'state' NOT IN ('ready','handed')),
 past_tasks AS (SELECT t FROM cs c,jsonb_array_elements(coalesce(c.data->'taskHistory','[]'::jsonb)) h,jsonb_array_elements(h) t),
 auto_history AS (SELECT a FROM (SELECT t FROM tasks UNION ALL SELECT t FROM past_tasks) x,jsonb_array_elements(coalesce(t->'autoAssignments','[]'::jsonb)) a),
 steps AS (SELECT c.data->>'state' AS case_state,r,i,s FROM cs c,jsonb_array_elements(c.data->'requisitions') r,jsonb_array_elements(r->'items') i,jsonb_array_elements(i->'steps') s WHERE s->>'type' IN ('group','routing')),
 assigned AS (SELECT a FROM steps,jsonb_array_elements(coalesce(s->'assignments','[]'::jsonb)) a),
 off_items AS (SELECT i->>'assignee' AS assignee FROM lc_v9_case v,permitted,jsonb_array_elements(v.data->'items') i
 WHERE v.tenant_id=app.current_tenant_id() AND permitted.ok AND v.module='off' AND v.data->>'state'='submitted' AND i->>'status' IN ('todo','progress') AND i->>'assignee' IS NOT NULL),
 off_load AS (SELECT assignee,count(*) AS n FROM off_items GROUP BY assignee)
 SELECT u.id,
 (SELECT count(*) FROM tasks WHERE case_state='submitted' AND t->>'by'='group' AND t->>'assignee'=u.id::text AND t->>'status'<>'done') + (SELECT count(*) FROM claimed_items WHERE i->>'claim'=u.id::text) + coalesce((SELECT n FROM off_load WHERE assignee=u.id::text),0),
 (SELECT max(a->>'at') FROM auto_history WHERE a->>'user'=u.id::text),
 (SELECT count(*) FROM steps WHERE case_state='submitted' AND r->>'cancelledAt' IS NULL AND i->>'removed'='false' AND i->>'approval'='pending' AND s->>'status'='pending' AND s->>'user'=u.id::text),
 (SELECT count(*) FROM assigned WHERE a->>'user'=u.id::text)
 FROM app_user u,permitted WHERE u.tenant_id=app.current_tenant_id() AND permitted.ok AND NOT app.login_blocked(u.id)
$$;
REVOKE ALL ON FUNCTION app.onboarding_assignment_loads() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_assignment_loads() TO ai_hr_app;
