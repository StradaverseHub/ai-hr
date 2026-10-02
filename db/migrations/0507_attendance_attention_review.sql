-- My Team uses today's live administrative reporting membership, never HOD visibility.
-- A context may only narrow a currently held authenticated grant; stale session roles never restore one.
CREATE FUNCTION app.my_team_has_role_for(requested_role text,requested_company uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT app.has_role(requested_role) AND app.has_role_for(requested_role,requested_company)
 AND EXISTS(SELECT 1 FROM role_assignment r JOIN app_user u ON u.id=r.app_user_id AND u.tenant_id=r.tenant_id
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL
   AND r.role::text=requested_role
   AND (r.company_id IS NULL OR r.company_id=requested_company OR app.is_company_descendant(requested_company,r.company_id)))
$$;
--> statement-breakpoint
CREATE FUNCTION app.my_team_report_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
 WITH RECURSIVE roots AS (
  SELECT e.id FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL
    AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
    AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 ), reports(id,path) AS (
  SELECT r.id,ARRAY[r.id] FROM roots r
  UNION ALL
  SELECT e.id,r.path||e.id FROM reports r JOIN reporting_line l ON l.manager_employment_id=r.id
  JOIN employment e ON e.id=l.subordinate_employment_id AND e.tenant_id=l.tenant_id
  WHERE l.tenant_id=app.current_tenant_id() AND l.line_type='administrative' AND l.superseded_at IS NULL
   AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND cardinality(r.path)<65 AND NOT e.id=ANY(r.path)
 ) SELECT DISTINCT r.id FROM reports r WHERE NOT EXISTS(SELECT 1 FROM roots x WHERE x.id=r.id)
$$;
--> statement-breakpoint
CREATE FUNCTION app.my_team_subject_authorized(subject uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM employment e WHERE e.id=subject AND e.tenant_id=app.current_tenant_id()
  AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=e.tenant_id AND u.archived_at IS NULL)
  AND ((app.my_team_has_role_for('manager',e.company_id) AND e.id IN (SELECT app.my_team_report_ids()))
   OR (app.my_team_has_role_for('hr_admin',e.company_id) OR app.my_team_has_role_for('super_admin',e.company_id))))
$$;
--> statement-breakpoint
-- Stored processed observations only: a subsequent changed observation is unreviewed.
CREATE FUNCTION app.attendance_attention_fingerprint(a attendance) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT md5(jsonb_build_array(a.id,a.employment_id,a.attendance_date,a.check_in_at,a.check_out_at,
  a.status,a.day_type,a.worked_minutes,a.ot_minutes,a.late_minutes,a.early_out_minutes,a.under_minutes,
  a.late_deduct_minutes,a.early_out_deduct_minutes,a.ot_flat_minutes,a.ot00_minutes,a.ot10_minutes,
  a.ot15_minutes,a.ot20_minutes,a.ot30_minutes,a.calc_trace)::text)
$$;
--> statement-breakpoint
CREATE TABLE attendance_attention_review (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 attendance_id uuid NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,reviewer_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{32}$'),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT attendance_attention_review_observation UNIQUE(tenant_id,attendance_id,reviewer_user_id,fingerprint)
);
--> statement-breakpoint
ALTER TABLE attendance_attention_review ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON attendance_attention_review FROM ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON attendance_attention_review TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY attendance_attention_review_read ON attendance_attention_review FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND reviewer_user_id=app.current_user_id()
 AND EXISTS(SELECT 1 FROM attendance a WHERE a.id=attendance_id AND a.tenant_id=attendance_attention_review.tenant_id
  AND app.my_team_subject_authorized(a.employment_id))
);
--> statement-breakpoint
CREATE POLICY attendance_attention_review_insert ON attendance_attention_review FOR INSERT WITH CHECK (
 tenant_id=app.current_tenant_id() AND reviewer_user_id=app.current_user_id() AND created_at=now()
 AND EXISTS(SELECT 1 FROM attendance a WHERE a.id=attendance_id AND a.tenant_id=attendance_attention_review.tenant_id
  AND app.my_team_subject_authorized(a.employment_id) AND fingerprint=app.attendance_attention_fingerprint(a)
  AND a.attendance_date<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND ((a.check_in_at IS NOT NULL AND a.check_out_at IS NULL) OR (a.check_in_at IS NULL AND a.check_out_at IS NOT NULL)))
);
