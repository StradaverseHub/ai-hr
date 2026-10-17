-- My Profile follows own Person/Employment identity, never a manager's report visibility.
-- Canonical owners still validate field policy, versioned proposals and decisions. This is row scope,
-- not a claim that PostgreSQL can attest arbitrary application validation or JavaScript execution.
DROP POLICY IF EXISTS profile_change_request_rls ON profile_change_request;--> statement-breakpoint
CREATE POLICY profile_change_request_read ON profile_change_request FOR SELECT
 USING (tenant_id=app.current_tenant_id() AND EXISTS (
  SELECT 1 FROM employment e WHERE e.id=profile_change_request.employment_id AND e.person_id=profile_change_request.person_id AND e.tenant_id=profile_change_request.tenant_id
   AND (app.is_self_person(e.person_id) OR app.can_admin_employment(e.id))
 ));--> statement-breakpoint
CREATE POLICY profile_change_request_insert ON profile_change_request FOR INSERT
 WITH CHECK (tenant_id=app.current_tenant_id() AND EXISTS (
  SELECT 1 FROM employment e WHERE e.id=profile_change_request.employment_id AND e.person_id=profile_change_request.person_id AND e.tenant_id=profile_change_request.tenant_id
   AND (app.can_admin_employment(e.id) OR (app.is_self_person(e.person_id) AND e.blacklisted_at IS NULL
    AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
    AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
    AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=e.tenant_id AND u.person_id=e.person_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
    AND profile_change_request.status='pending' AND profile_change_request.decided_at IS NULL AND profile_change_request.decided_by_employment_id IS NULL))
 ));--> statement-breakpoint
CREATE POLICY profile_change_request_update ON profile_change_request FOR UPDATE
 USING (tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id))
 WITH CHECK (tenant_id=app.current_tenant_id() AND EXISTS (
  SELECT 1 FROM employment e WHERE e.id=profile_change_request.employment_id AND e.person_id=profile_change_request.person_id AND e.tenant_id=profile_change_request.tenant_id AND app.can_admin_employment(e.id)
 ));--> statement-breakpoint
CREATE POLICY profile_change_request_delete ON profile_change_request FOR DELETE
 USING (tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id));--> statement-breakpoint
-- Close inherited table and column privileges first: RLS never protects TRUNCATE.
-- The migration/PDPA owner retains ownership; the runtime role receives only the intended CRUD set.
REVOKE ALL PRIVILEGES ON TABLE profile_change_request FROM PUBLIC,ai_hr_app;--> statement-breakpoint
DO $profile_acl$
DECLARE column_name text;
BEGIN
 FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid='profile_change_request'::regclass AND attnum>0 AND NOT attisdropped LOOP
  EXECUTE format('REVOKE SELECT (%1$I), INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE profile_change_request FROM PUBLIC,ai_hr_app',column_name);
 END LOOP;
END $profile_acl$;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON profile_change_request TO ai_hr_app;
