-- Resolve the exact 0507 authority as a set, so a period read does not traverse the graph per employee.
-- Invoker/RLS only. The boolean policy owner delegates to this same set; there is one authority rule.
CREATE FUNCTION app.my_team_authorized_subject_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
 WITH reports AS MATERIALIZED (SELECT app.my_team_report_ids() AS id)
 SELECT e.id FROM employment e WHERE e.tenant_id=app.current_tenant_id()
  AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=e.tenant_id AND u.archived_at IS NULL)
  AND ((app.my_team_has_role_for('manager',e.company_id) AND e.id IN (SELECT id FROM reports))
   OR (app.my_team_has_role_for('hr_admin',e.company_id) OR app.my_team_has_role_for('super_admin',e.company_id)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.my_team_authorized_subject_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.my_team_authorized_subject_ids() TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.my_team_subject_authorized(subject uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(subject IN (SELECT app.my_team_authorized_subject_ids()),false)
$$;
