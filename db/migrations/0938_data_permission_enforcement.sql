-- Private transaction births are temporary row identities, never function or company authority.
CREATE TABLE app.data_permission_birth (
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,user_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('person','employment')),row_id uuid NOT NULL,person_id uuid NOT NULL,completed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(xact_id,tenant_id,user_id,kind,row_id)
);
ALTER TABLE app.data_permission_birth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.data_permission_birth FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_row_born(p_kind text,p_row uuid,p_pending boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.data_permission_birth b
 WHERE b.xact_id=pg_current_xact_id() AND b.tenant_id=app.current_tenant_id() AND b.user_id=app.current_user_id()
 AND b.kind=p_kind AND b.row_id=p_row AND (b.completed OR p_pending));
$$;
REVOKE ALL ON FUNCTION app.data_permission_row_born(text,uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_employment_born(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.data_permission_row_born('employment',p_employment,false);
$$;
CREATE FUNCTION app.data_permission_person_born(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.data_permission_row_born('person',p_person,false);
$$;
REVOKE ALL ON FUNCTION app.data_permission_employment_born(uuid),app.data_permission_person_born(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_birth_finish() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_LEVEL='ROW' THEN
  UPDATE app.data_permission_birth SET completed=true WHERE xact_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id
   AND user_id=app.current_user_id() AND kind=TG_TABLE_NAME AND row_id=NEW.id;
 ELSE
  -- INSERT ON CONFLICT DO NOTHING must never leave a forged birth for the conflicting old row.
  DELETE FROM app.data_permission_birth WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id()
   AND user_id=app.current_user_id() AND kind=TG_TABLE_NAME AND NOT completed;
 END IF;RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_birth_finish() FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Administrative data profiles narrow existing row owners. Independent own/team/approval rules remain.
-- This file does not invent additional function authority or publish unsupported action cells.
-- app.can_admin_employment; prior owner 0016_company_scoped_authz
CREATE OR REPLACE FUNCTION app.can_admin_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM employment e WHERE e.id = emp_id AND e.tenant_id=app.current_tenant_id() AND app.is_admin_for(e.company_id) AND app.data_permission_matches(e.id));
$$;
--> statement-breakpoint
-- app.can_admin_payroll_employment; prior owner 0099_job_function_partner_roles
CREATE OR REPLACE FUNCTION app.can_admin_payroll_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM employment e WHERE e.id = emp_id AND e.tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(e.company_id) AND app.data_permission_matches(e.id));
$$;
--> statement-breakpoint
-- app.can_admin_perfcomp_employment; prior owner 0099_job_function_partner_roles
CREATE OR REPLACE FUNCTION app.can_admin_perfcomp_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM employment e WHERE e.id = emp_id AND e.tenant_id=app.current_tenant_id() AND app.can_admin_perfcomp_for(e.company_id) AND app.data_permission_matches(e.id));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_see_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$ SELECT (EXISTS (
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
    )) AND (app.data_permission_matches(emp_id) OR EXISTS(SELECT 1 FROM public.employment own JOIN public.app_user u ON u.person_id=own.person_id AND u.tenant_id=own.tenant_id WHERE own.id=emp_id AND own.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id())); $$;
--> statement-breakpoint
-- app.visible_employment_ids; prior owner 0515_set_based_visibility
CREATE OR REPLACE FUNCTION app.visible_employment_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog,public,pg_temp
AS $$
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
  admin_company AS (
    SELECT c.company_id
    FROM (SELECT DISTINCT e.company_id FROM employment e WHERE e.tenant_id = app.current_tenant_id()) c
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
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL AND (app.data_permission_matches(v.id) OR EXISTS(SELECT 1 FROM public.employment own JOIN public.app_user u ON u.person_id=own.person_id AND u.tenant_id=own.tenant_id WHERE own.id=v.id AND own.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()));
$$;
--> statement-breakpoint
-- app.access_workforce_employment; prior owner 0676_employment_import_void
CREATE OR REPLACE FUNCTION app.access_workforce_employment(p_employment uuid,p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
  AND e.voided_at IS NULL AND app.access_workforce_company(e.company_id,p_capability) AND (app.access_workforce_storage_owner() OR app.data_permission_matches(e.id)));
$$;
--> statement-breakpoint
-- app.access_workforce_related_read; prior owner 0579_configurable_access
CREATE OR REPLACE FUNCTION app.access_workforce_related_read(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(
  SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
   AND (app.access_workforce_employment(e.id,'workforce.view') OR app.access_profile_request_own(e.person_id)
    OR EXISTS(SELECT 1 FROM public.employment me JOIN public.app_user u ON u.person_id=me.person_id AND u.tenant_id=me.tenant_id
     WHERE u.id=app.current_user_id() AND me.tenant_id=e.tenant_id AND me.terminated_on IS NULL
      AND (app.is_admin_report_of(e.id,me.id) OR app.heads_department_of(e.id,me.id)))));
$$;
--> statement-breakpoint
-- app.access_workforce_person; prior owner 0579_configurable_access
CREATE OR REPLACE FUNCTION app.access_workforce_person(p_person uuid,p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (EXISTS(SELECT 1 FROM public.person p JOIN public.employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id
  WHERE p.id=p_person AND p.tenant_id=app.current_tenant_id() AND app.access_workforce_employment(e.id,p_capability))
  OR EXISTS(SELECT 1 FROM public.person p WHERE p.id=p_person AND p.tenant_id=app.current_tenant_id()
   AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p.id AND e.tenant_id=p.tenant_id)
   AND app.access_workforce_unassigned(p_capability)))
  -- Keep the existing any-administered-employment person owner. Changing that one shared fact
  -- nevertheless cannot cross an explicit denial on another retained employment's company.
  AND ((app.current_user_id() IS NULL AND app.access_workforce_storage_owner())
   OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=app.current_tenant_id()
    AND (NOT app.access_workforce_not_denied(e.company_id,p_capability) OR p_capability='workforce.maintain' AND (NOT app.data_permission_matches(e.id) OR EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.user_id=app.current_user_id() AND a.tenant_id=e.tenant_id) AND NOT app.access_workforce_company(e.company_id,p_capability)))));
$$;
--> statement-breakpoint
-- app.access_workforce_list_rows; prior owner 0676_employment_import_void
CREATE OR REPLACE FUNCTION app.access_workforce_list_rows() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH permitted AS MATERIALIZED (
  SELECT c.id FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 )
 SELECT jsonb_build_object(
  'employmentId',e.id,'name',p.full_name,'email',p.primary_email,'employeeCode',e.employee_code,
  'department',COALESCE(NULLIF(btrim(d.label),''),d.name),'departmentId',a.department_id,
  'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title),'company',co.legal_name,'companyId',e.company_id,
  'hiredOn',e.hired_on,'terminatedOn',e.terminated_on,'confirmationDate',e.confirmation_date,
  'finalConfirmationDate',e.final_confirmation_date,'probationEndDate',e.probation_end_date,
  'provisionalEndOn',e.provisional_end_on,'resignationDate',e.resignation_date,'lastWorkingDate',e.last_working_date,
  'blacklistedAt',e.blacklisted_at,'jobGrade',g.name,'employmentType',a.employment_type,
  'businessUnit',COALESCE(NULLIF(btrim(bu.label),''),bu.code),'costCenter',cc.name,'workLocation',loc.name,
  'joinDate',e.join_date,'reportingTo',(
   SELECT mp.full_name FROM public.reporting_line rl
   JOIN public.employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id AND me.voided_at IS NULL
   JOIN permitted manager_scope ON manager_scope.id=me.company_id
   JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
   WHERE rl.tenant_id=e.tenant_id AND app.data_permission_matches(me.id) AND rl.subordinate_employment_id=e.id AND rl.line_type='administrative'
    AND rl.valid_to IS NULL AND rl.superseded_at IS NULL ORDER BY rl.valid_from DESC,rl.id LIMIT 1))
 FROM public.employment e JOIN permitted allowed ON allowed.id=e.company_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
 LEFT JOIN public.department d ON d.id=a.department_id AND d.tenant_id=e.tenant_id
 LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id
 LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=a.business_unit_id AND bu.tenant_id=e.tenant_id
 LEFT JOIN public.cost_center cc ON cc.id=a.cost_center_id AND cc.tenant_id=e.tenant_id
 LEFT JOIN public.location loc ON loc.id=a.location_id AND loc.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND app.data_permission_matches(e.id);
$$;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_record_read(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND (NOT EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id())
 OR app.data_permission_row_born('employment',p_employment,true)
 OR EXISTS(SELECT 1 FROM public.employment e
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
 AND (app.data_permission_matches(e.id) OR app.is_self_person(e.person_id))));
$$;
REVOKE ALL ON FUNCTION app.data_permission_record_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.data_permission_record_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_person_read(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND (app.is_self_person(p_person) OR app.data_permission_row_born('person',p_person,true)
 OR EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=app.current_tenant_id() AND app.data_permission_record_read(e.id))
 OR NOT EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.user_id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()));
$$;
REVOKE ALL ON FUNCTION app.data_permission_person_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.data_permission_person_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY data_permission_employee_read ON employment AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.data_permission_record_read(id));
CREATE POLICY data_permission_person_read ON person AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.data_permission_person_read(id));
CREATE POLICY data_permission_subject_read ON employee_clocking_location AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employee_device AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON mobile_integrity_challenge AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON mobile_offline_context AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON mobile_offline_claim AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON mobile_offline_photo AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON mobile_offline_claim_resolution AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON assignment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON leave_ledger AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON leave_request AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON leave_request_attachment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON leave_cancellation_request AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON compensation AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employment_holiday_calendar AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_day_adjustment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_clock_capture AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_punch AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON clocking_import_line AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_correction AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_correction_attachment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON travel_request AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON roster_assignment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employment_shift_arrangement AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON toil_accrual AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON replacement_leave_request AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON notice_recipient AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON notice_acknowledgement AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON profile_change_request AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.data_permission_record_read(employment_id) OR app.profile_request_reader(id));
CREATE POLICY data_permission_subject_read ON resignation_request AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON resignation_request_attachment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employment_review AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employment_review_reminder AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON review_document AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employee_document AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employment_tax_scheme_my AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employment_tax_selection_my AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employee_tp3_draft AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employee_qualification AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payslip AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payroll_employee_result_history AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payroll_anomaly_verdict AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payroll_input AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payroll_statutory_adjustment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employment_pay_component AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employee_cp38 AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payroll_batch_component AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_allowance_result AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_allowance_result_revision AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payroll_attendance_allowance_source AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payroll_individual_txn AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON back_pay_line AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_review AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_goal AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_attachment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON ea_override AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON leave_entitlement_recalc_audit AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON leave_generation_run_item AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON claim_request AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON claim_attachment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employee_loan AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON loan_repayment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON feedback_attachment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON leave_encashment_snapshot AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON movement_attachment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON lc_case AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON reward_entry AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_assessment_participation AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_onehr_review AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_assessment_reminder_recipient AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_onehr_calibration_entry AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_onehr_calibration_entry_retired AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_calibration_group_member AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_assessment_unit_exclusion_pin AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_onehr_plan AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_onehr_evidence AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_onehr_result AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON hr_orchestration_case AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_workflow_request AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_workflow_decision AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_workflow_participant_decision AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_assessment_talent_history AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON performance_assessment_career_profile AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_policy_request_contract AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_policy_attested_effect AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_policy_final_receipt AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON replacement_holiday AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON replacement_holiday_revision AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON replacement_holiday_queue AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON overtime_pattern_assignment_employment AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON attendance_overtime_source AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON lc_onboarding_case AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON lc_v9_case AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON lc_v9_payroll_handover AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payroll_leave_exception AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employment_cost_allocation_head AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON employment_cost_allocation_set AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payroll_history_import_record AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON import_attempt_item AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON bank_import_row AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON letter_record AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.data_permission_record_read(employment_id) OR app.letter_permission(company_id,'approve') AND app.letter_staff_scope(company_id,created_by,batch_id,id));
CREATE POLICY data_permission_subject_read ON information_payslip_snapshot AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON pay_formula_test AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON pay_formula_evaluation AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payroll_tax_basis_event AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON payroll_tax_basis_revision AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(employment_id IS NULL OR app.data_permission_record_read(employment_id));
CREATE POLICY data_permission_subject_read ON person_photo AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.data_permission_person_read(person_id));
CREATE POLICY data_permission_subject_read ON employee_statutory_my AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.data_permission_person_read(person_id));
CREATE POLICY data_permission_subject_read ON tp1_relief AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.data_permission_person_read(person_id));
CREATE POLICY data_permission_subject_read ON employee_tp3 AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.data_permission_person_read(person_id));
CREATE POLICY data_permission_subject_read ON employee_dependent AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.data_permission_person_read(person_id));
CREATE POLICY data_permission_subject_read ON person_emergency_contact AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.data_permission_person_read(person_id));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_see_person(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.person p WHERE p.id=p_id AND p.tenant_id=app.current_tenant_id()
 AND ((app.is_admin() AND app.data_permission_person_read(p.id)) OR app.is_self_person(p.id)
 OR EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p.id AND e.tenant_id=p.tenant_id AND app.can_see_employment(e.id))));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_admin_person(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=app.current_tenant_id()
 AND e.terminated_on IS NULL AND app.is_admin_for(e.company_id) AND app.data_permission_matches(e.id))
 AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=app.current_tenant_id()
 AND e.voided_at IS NULL AND (NOT app.is_admin_for(e.company_id) OR NOT app.data_permission_matches(e.id)));
$$;
--> statement-breakpoint
-- Private before-image cache, scoped to an exact transaction/principal. It cannot be prepared by
-- caller-set GUCs or table writes. Multiple coordinated field changes are checked as whole subjects,
-- avoiding misleading intermediate grade/department combinations inside one transaction.
CREATE TABLE app.data_permission_write_subject (
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,user_id uuid NOT NULL,
 employment_id uuid NOT NULL,person_id uuid NOT NULL,before_subject jsonb,
 PRIMARY KEY(xact_id,tenant_id,user_id,employment_id)
);
ALTER TABLE app.data_permission_write_subject ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.data_permission_write_subject FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_capture_subject() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject_id uuid;person uuid;t uuid;u uuid:=app.current_user_id();before_row jsonb;after_row jsonb;
BEGIN
 IF app.access_workforce_storage_owner() THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 before_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 after_row:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 t:=coalesce((after_row->>'tenant_id')::uuid,(before_row->>'tenant_id')::uuid);
 IF t IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Data scope principal unavailable' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME IN ('person','employment') THEN
  DELETE FROM app.data_permission_birth WHERE tenant_id=t AND xact_id<pg_snapshot_xmin(pg_current_snapshot());
  IF TG_OP='INSERT' THEN
   subject_id:=(after_row->>'id')::uuid;
   IF TG_TABLE_NAME='person' THEN
    IF NOT EXISTS(SELECT 1 FROM public.person p WHERE p.id=subject_id) THEN
     INSERT INTO app.data_permission_birth VALUES(pg_current_xact_id(),t,u,'person',subject_id,subject_id,false) ON CONFLICT DO NOTHING;
    END IF;
   ELSE
    person:=(after_row->>'person_id')::uuid;
    IF EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.tenant_id=t AND a.user_id=u)
     AND NOT app.data_permission_person_born(person) AND NOT EXISTS(SELECT 1 FROM public.employment retained
      WHERE retained.person_id=person AND retained.tenant_id=t AND app.data_permission_matches(retained.id)) THEN
     RAISE EXCEPTION 'Existing person creation scope unavailable' USING ERRCODE='42501';END IF;
    IF NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=subject_id) THEN
     INSERT INTO app.data_permission_birth VALUES(pg_current_xact_id(),t,u,'employment',subject_id,person,false) ON CONFLICT DO NOTHING;
    END IF;
   END IF;
  ELSIF TG_OP='UPDATE' THEN
   -- A conflicting UPSERT is an Edit of the old row, not a newly born row.
   DELETE FROM app.data_permission_birth WHERE xact_id=pg_current_xact_id() AND tenant_id=t AND user_id=u
    AND kind=TG_TABLE_NAME AND row_id=(before_row->>'id')::uuid AND NOT completed;
  END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.tenant_id=t AND a.user_id=u) THEN
  IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
 END IF;
 DELETE FROM app.data_permission_write_subject WHERE tenant_id=t AND xact_id<pg_snapshot_xmin(pg_current_snapshot());
 IF TG_TABLE_NAME='person' THEN
  person:=coalesce((after_row->>'id')::uuid,(before_row->>'id')::uuid);
  FOR subject_id IN SELECT e.id FROM public.employment e WHERE e.person_id=person AND e.tenant_id=t AND e.voided_at IS NULL LOOP
   INSERT INTO app.data_permission_write_subject VALUES(pg_current_xact_id(),t,u,subject_id,person,app.data_permission_subject(subject_id)) ON CONFLICT DO NOTHING;
  END LOOP;
 ELSE
  subject_id:=CASE WHEN TG_TABLE_NAME='employment' THEN coalesce((after_row->>'id')::uuid,(before_row->>'id')::uuid)
    ELSE coalesce((after_row->>'employment_id')::uuid,(before_row->>'employment_id')::uuid) END;
  SELECT e.person_id INTO person FROM public.employment e WHERE e.id=subject_id AND e.tenant_id=t;
  person:=coalesce(person,(after_row->>'person_id')::uuid,(before_row->>'person_id')::uuid);
  IF person IS NOT NULL THEN INSERT INTO app.data_permission_write_subject VALUES(pg_current_xact_id(),t,u,subject_id,person,app.data_permission_subject(subject_id)) ON CONFLICT DO NOTHING;END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_capture_subject() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_validate_subject() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof record;before_row jsonb;after_row jsonb;delta jsonb;subject_id uuid;person uuid;rules jsonb;t uuid;u uuid:=app.current_user_id();
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 before_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 after_row:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 t:=coalesce((after_row->>'tenant_id')::uuid,(before_row->>'tenant_id')::uuid);
 IF NOT EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.tenant_id=t AND a.user_id=u) THEN RETURN NULL;END IF;
 IF t IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Data scope principal unavailable' USING ERRCODE='42501';END IF;
 SELECT r.rules INTO rules FROM public.user_data_permission_assignment a JOIN public.data_permission_profile p ON p.id=a.profile_id AND p.tenant_id=a.tenant_id
 JOIN public.data_permission_revision r ON r.id=p.active_revision_id AND r.profile_id=p.id AND r.tenant_id=p.tenant_id
 WHERE a.user_id=u AND a.tenant_id=t AND p.enabled AND p.retired_at IS NULL;
 IF rules IS NULL OR NOT app.data_permission_rules_valid(rules) THEN RAISE EXCEPTION 'Data scope unavailable' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='person' THEN
  person:=coalesce((after_row->>'id')::uuid,(before_row->>'id')::uuid);
  -- Existing exact approved-value witnesses keep their independent responsibility semantics.
  -- The established profile guard still checks the COMPLETE delta and audit in this transaction.
  IF app.is_self_person(person) THEN RETURN NULL;END IF;
  SELECT coalesce(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(coalesce(after_row,'{}'::jsonb))d
   WHERE d.value IS DISTINCT FROM before_row->d.key AND (d.key IN (SELECT column_name FROM app.access_profile_value_bindings() WHERE owner IN ('person','compliance'))
    OR d.key IN ('address','address_line1','address_line2','address_line3','postcode','city','state','country','marital_status_source_request_id'));
  IF TG_OP='UPDATE' AND delta<>'{}'::jsonb AND (
    app.access_profile_value_approved('person',person,NULL,person,delta,false,false)
    OR app.access_profile_marriage_delta(before_row,after_row,delta)
    OR app.access_privacy_value_intent_allowed('person',before_row,after_row)) THEN RETURN NULL;END IF;
 ELSE subject_id:=CASE WHEN TG_TABLE_NAME='employment' THEN coalesce((after_row->>'id')::uuid,(before_row->>'id')::uuid)
   ELSE coalesce((after_row->>'employment_id')::uuid,(before_row->>'employment_id')::uuid) END;END IF;
 FOR proof IN SELECT * FROM app.data_permission_write_subject s WHERE s.xact_id=pg_current_xact_id() AND s.tenant_id=t AND s.user_id=u
   AND (s.employment_id=subject_id OR TG_TABLE_NAME='person' AND s.person_id=person) LOOP
  IF proof.before_subject IS NOT NULL AND NOT app.data_permission_rules_match(rules,proof.before_subject) THEN RAISE EXCEPTION 'Data scope source unavailable' USING ERRCODE='42501';END IF;
  after_row:=app.data_permission_subject(proof.employment_id);
  IF after_row IS NOT NULL AND NOT app.data_permission_rules_match(rules,after_row) THEN RAISE EXCEPTION 'Data scope destination unavailable' USING ERRCODE='42501';END IF;
 END LOOP;RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_validate_subject() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER data_permission_subject_lock BEFORE INSERT OR UPDATE OR DELETE ON employment FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
CREATE TRIGGER data_permission_subject_lock BEFORE INSERT OR UPDATE OR DELETE ON person FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
CREATE TRIGGER data_permission_subject_lock BEFORE INSERT OR UPDATE OR DELETE ON assignment FOR EACH STATEMENT EXECUTE FUNCTION app.access_workforce_master_statement_lock();
CREATE TRIGGER data_permission_subject_capture BEFORE INSERT OR UPDATE OR DELETE ON employment FOR EACH ROW EXECUTE FUNCTION app.data_permission_capture_subject();
CREATE TRIGGER data_permission_subject_capture BEFORE INSERT OR UPDATE OR DELETE ON person FOR EACH ROW EXECUTE FUNCTION app.data_permission_capture_subject();
CREATE TRIGGER data_permission_subject_capture BEFORE INSERT OR UPDATE OR DELETE ON assignment FOR EACH ROW EXECUTE FUNCTION app.data_permission_capture_subject();
CREATE CONSTRAINT TRIGGER data_permission_subject_check AFTER INSERT OR UPDATE OR DELETE ON employment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.data_permission_validate_subject();
CREATE CONSTRAINT TRIGGER data_permission_subject_check AFTER INSERT OR UPDATE OR DELETE ON person DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.data_permission_validate_subject();
CREATE CONSTRAINT TRIGGER data_permission_subject_check AFTER INSERT OR UPDATE OR DELETE ON assignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.data_permission_validate_subject();
--> statement-breakpoint
-- Assignment editors may enumerate account identities, but employee labels remain data-scoped.
CREATE OR REPLACE FUNCTION app.access_configuration_editor_metadata() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();result jsonb;
BEGIN
 IF NOT app.access_allowed_for(app.current_user_id(),'access.configure',NULL) THEN RAISE EXCEPTION 'access configuration unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object(
 'users',coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id,'label',CASE WHEN p.id IS NOT NULL AND app.data_permission_person_read(p.id) THEN coalesce(nullif(p.full_name,''),u.id::text) ELSE u.id::text END) ORDER BY u.id)
  FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.tenant_id=t),'[]'::jsonb),
 'companies',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'label',c.legal_name) ORDER BY c.id) FROM public.company c WHERE c.tenant_id=t),'[]'::jsonb),
 'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',h.id,'at',h.occurred_at,'actorId',h.actor_id,
  'operation',CASE WHEN h.event_type='access-configuration.initialized' THEN 'initialized' ELSE h.payload->>'kind' END) ORDER BY h.sequence DESC)
 FROM(SELECT e.id,e.sequence,e.occurred_at,e.actor_id,e.event_type,e.payload FROM public.domain_event e WHERE e.tenant_id=t AND e.aggregate_type='access-configuration' AND e.aggregate_id=t
  AND e.event_type IN ('access-configuration.initialized','access-configuration.changed') ORDER BY e.sequence DESC LIMIT 100)h),'[]'::jsonb)) INTO result;
 RETURN result;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_assigned_role_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.retired_at IS NOT NULL AND OLD.retired_at IS NULL AND EXISTS(SELECT 1 FROM public.access_effective_membership m WHERE m.group_id=OLD.id AND m.tenant_id=OLD.tenant_id) THEN
  RAISE EXCEPTION 'access group assigned' USING ERRCODE='23514';END IF;RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_assigned_role_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER data_permission_assigned_role_guard BEFORE UPDATE OF retired_at ON access_group FOR EACH ROW EXECUTE FUNCTION app.data_permission_assigned_role_guard();
--> statement-breakpoint
CREATE FUNCTION app.data_permission_identity_link_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_person uuid;new_person uuid;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.user_data_permission_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id()) THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='app_user' THEN old_person:=CASE WHEN TG_OP='UPDATE' THEN OLD.person_id ELSE NULL END;new_person:=NEW.person_id;
 ELSE old_person:=NULL;new_person:=NEW.person_id;END IF;
 IF TG_OP='UPDATE' AND old_person IS NOT DISTINCT FROM new_person THEN RETURN NEW;END IF;
 IF old_person IS NOT NULL AND NOT app.access_workforce_person(old_person,'workforce.maintain')
  OR new_person IS NOT NULL AND NOT app.access_workforce_person(new_person,'workforce.maintain') THEN
  RAISE EXCEPTION 'Identity person scope unavailable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_identity_link_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER data_permission_identity_link_guard BEFORE INSERT OR UPDATE OF person_id ON app_user FOR EACH ROW EXECUTE FUNCTION app.data_permission_identity_link_guard();
CREATE TRIGGER data_permission_identity_link_guard BEFORE INSERT OR UPDATE OF person_id ON app_invitation FOR EACH ROW EXECUTE FUNCTION app.data_permission_identity_link_guard();

--> statement-breakpoint
-- app.access_workforce_command_allowed; prior owner 0579_configurable_access
CREATE OR REPLACE FUNCTION app.access_workforce_command_allowed(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
  AND app.access_workforce_command_company(e.company_id) AND app.data_permission_matches(e.id));
$$;
--> statement-breakpoint

--> statement-breakpoint
-- app.access_workforce_command_person; prior owner 0579_configurable_access
CREATE OR REPLACE FUNCTION app.access_workforce_command_person(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment selected WHERE selected.id=p_employment AND selected.tenant_id=app.current_tenant_id()
  AND app.access_workforce_command_company(selected.company_id) AND app.data_permission_matches(selected.id)
  AND NOT EXISTS(SELECT 1 FROM public.employment retained WHERE retained.person_id=selected.person_id AND retained.tenant_id=selected.tenant_id
   AND (NOT app.data_permission_matches(retained.id) OR NOT app.access_workforce_not_denied(retained.company_id,'workforce.maintain') OR NOT app.access_workforce_not_denied(retained.company_id,'workforce.view'))));
$$;
--> statement-breakpoint

--> statement-breakpoint
-- app.access_workforce_set_employee_code; prior owner 0579_configurable_access
CREATE OR REPLACE FUNCTION app.access_workforce_set_employee_code(p_employment uuid,p_code text,p_expected jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); subject public.employment%ROWTYPE; claimant text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO subject FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=t FOR UPDATE;
 IF NOT FOUND OR NOT app.access_workforce_command_company(subject.company_id) OR NOT app.data_permission_matches(subject.id) THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
 END IF;
 -- The public SQL command accepts canonical identifiers only; the shared TS format owner normalizes
 -- ordinary forms. No arbitrary column, person id, company or actor is accepted by this seam.
 IF p_code IS NULL OR p_code !~ '^[A-Z0-9-]{1,30}$' THEN RAISE EXCEPTION 'Employee ID invalid' USING ERRCODE='23514'; END IF;
 IF p_expected IS NOT NULL AND (jsonb_typeof(p_expected) NOT IN ('string','null')
  OR p_expected IS DISTINCT FROM coalesce(to_jsonb(subject.employee_code),'null'::jsonb)) THEN
  RAISE EXCEPTION 'Employee record changed' USING ERRCODE='40001';
 END IF;
 IF subject.employee_code=p_code THEN RETURN false; END IF;
 claimant:=app.employee_code_claim(t,p_code,p_employment,NULL);
 IF claimant IS NOT NULL THEN
  RAISE EXCEPTION '%','employee_code_claim_'||claimant USING ERRCODE='23505',CONSTRAINT='employee_code_claim_'||claimant;
 END IF;
 UPDATE public.employment SET employee_code=p_code WHERE id=p_employment AND tenant_id=t;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(t,'employment',p_employment,'employment.employee-code.set',
  CASE WHEN app.current_user_id() IS NULL THEN 'system'::public.actor_type ELSE 'user'::public.actor_type END,app.current_user_id(),p_employment,
  jsonb_build_object('before',jsonb_build_object('employeeCode',subject.employee_code),'after',jsonb_build_object('employeeCode',p_code)));
 RETURN true;
END;
$$;
--> statement-breakpoint

--> statement-breakpoint
-- app.access_workforce_maintain_record; prior owner 0579_configurable_access
CREATE OR REPLACE FUNCTION app.access_workforce_maintain_record(p_employment uuid,p_kind text,p_row uuid,p_operation text,p_patch jsonb,p_expected text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected public.employment%ROWTYPE;before_row jsonb;after_row jsonb;normalized jsonb:='{}'::jsonb;
 version text;target_id uuid;table_name text;subject_column text;subject_id uuid;event_name text;aggregate_name text;
 assignments text;insert_columns text;insert_values text;field_names jsonb;pair record;binding record;value jsonb;
 previous record;previous_after jsonb;written_event_id uuid;instant timestamptz:=now();changed boolean;effect_id uuid;relationship text;
BEGIN
 IF p_kind IS NULL OR p_operation IS NULL OR p_kind NOT IN ('person','qualification','emergency','dependent') OR p_operation NOT IN ('add','update','archive')
  OR jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR octet_length(p_patch::text)>128000 THEN
  RAISE EXCEPTION 'Workforce input invalid' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_patch))>40 OR p_kind='person' AND (p_operation<>'update' OR p_row IS NOT NULL)
  OR p_kind<>'person' AND ((p_operation='add') IS DISTINCT FROM (p_row IS NULL)) THEN
  RAISE EXCEPTION 'Workforce input invalid' USING ERRCODE='22023'; END IF;
 PERFORM app.access_profile_policy_write_lock();
 SELECT * INTO selected FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR app.current_user_id() IS NULL OR NOT app.data_permission_matches(selected.id) OR NOT app.access_workforce_command_company(selected.company_id)
  OR p_kind<>'qualification' AND NOT app.access_workforce_command_person(selected.id) THEN
  RAISE EXCEPTION 'Workforce command unavailable' USING ERRCODE='42501'; END IF;
 table_name:=CASE p_kind WHEN 'person' THEN 'person' WHEN 'qualification' THEN 'employee_qualification' WHEN 'dependent' THEN 'employee_dependent' ELSE 'person_emergency_contact' END;
 subject_column:=CASE WHEN p_kind='qualification' THEN 'employment_id' ELSE 'person_id' END;
 subject_id:=CASE WHEN p_kind='qualification' THEN selected.id ELSE selected.person_id END;
 aggregate_name:=CASE p_kind WHEN 'person' THEN 'person' WHEN 'qualification' THEN 'employee-qualification' WHEN 'dependent' THEN 'employee-dependent' ELSE 'person-emergency-contact' END;
 event_name:=CASE p_kind WHEN 'person' THEN 'person.updated' WHEN 'qualification' THEN 'qualification.' WHEN 'dependent' THEN 'dependent.' ELSE 'emergency-contact.' END;
 IF p_kind<>'person' THEN event_name:=event_name||CASE p_operation WHEN 'add' THEN 'added' WHEN 'update' THEN 'updated' ELSE 'archived' END; END IF;
 IF p_kind='person' THEN
  SELECT to_jsonb(p),p.xmin::text INTO before_row,version FROM public.person p WHERE p.id=selected.person_id AND p.tenant_id=selected.tenant_id FOR UPDATE;
  target_id:=selected.person_id;
 ELSE
  -- Same order as the canonical register writers: former Highest/Primary before the target row.
  IF p_kind='qualification' THEN
   PERFORM 1 FROM public.employee_qualification WHERE tenant_id=selected.tenant_id AND employment_id=selected.id AND archived_at IS NULL AND is_highest ORDER BY id FOR UPDATE;
  ELSE
   PERFORM 1 FROM public.person WHERE id=selected.person_id AND tenant_id=selected.tenant_id FOR UPDATE;
   PERFORM 1 FROM public.person_emergency_contact WHERE tenant_id=selected.tenant_id AND person_id=selected.person_id AND archived_at IS NULL AND priority='primary' ORDER BY id FOR UPDATE;
  END IF;
  target_id:=COALESCE(p_row,gen_random_uuid());
  IF p_operation='add' THEN before_row:='{}'::jsonb;
  ELSE
   EXECUTE format('SELECT to_jsonb(r),r.xmin::text FROM public.%I r WHERE r.id=$1 AND r.tenant_id=$2 AND r.%I=$3 AND r.archived_at IS NULL FOR UPDATE',table_name,subject_column)
    INTO before_row,version USING target_id,selected.tenant_id,subject_id;
  END IF;
 END IF;
 IF before_row IS NULL OR p_operation<>'add' AND (p_expected IS NULL OR version IS DISTINCT FROM p_expected) THEN
  RAISE EXCEPTION 'Workforce record changed' USING ERRCODE='40001'; END IF;
 IF p_operation='add' AND p_expected IS NOT NULL THEN RAISE EXCEPTION 'Workforce input invalid' USING ERRCODE='22023'; END IF;
 IF p_operation='archive' THEN
  IF p_patch<>'{}'::jsonb THEN RAISE EXCEPTION 'Workforce archive input invalid' USING ERRCODE='22023'; END IF;
  normalized:=jsonb_build_object('archived_at',instant,'updated_at',instant);
 ELSE
  relationship:=COALESCE(NULLIF(app.access_profile_value_normalized(p_patch->'relationship')#>>'{}',''),before_row->>'relationship');
  FOR pair IN SELECT * FROM jsonb_each(p_patch) LOOP
   SELECT * INTO binding FROM app.access_profile_value_bindings() b WHERE b.field_name=pair.key
    AND CASE WHEN p_kind='person' THEN b.owner IN ('person','compliance') ELSE b.owner=p_kind END
    AND b.field_name=ANY(app.access_workforce_command_fields(p_kind));
   IF NOT FOUND THEN RAISE EXCEPTION 'Workforce field unavailable' USING ERRCODE='22023'; END IF;
   IF p_kind='dependent' AND ((relationship IS DISTINCT FROM 'spouse' AND pair.key IN ('marriageDate','marriageStatus','spouseWorking')) OR
     (relationship IS DISTINCT FROM 'child' AND pair.key IN ('isStudent','schoolName','studyLevel','studyCountry','childReliefCategory','childTaxRelief','childReliefPercentage'))) THEN CONTINUE; END IF;
   value:=app.access_profile_value_normalized(pair.value);
   -- An unchanged, already-retained relationship on any live contact keeps the existing legacy
   -- tolerance. The public caller cannot supply a fake legacy value to the catalog owner.
   IF NOT (p_kind='emergency' AND pair.key='relationship' AND EXISTS(SELECT 1 FROM public.person_emergency_contact c
     WHERE c.person_id=selected.person_id AND c.tenant_id=selected.tenant_id AND c.archived_at IS NULL AND to_jsonb(c.relationship)=value))
    AND NOT app.access_workforce_value_shape(p_kind,pair.key,value,before_row->binding.column_name) THEN
    RAISE EXCEPTION 'Workforce field invalid' USING ERRCODE='22023'; END IF;
   normalized:=normalized||jsonb_build_object(binding.column_name,value);
  END LOOP;
  IF p_operation='add' THEN
   normalized:=CASE WHEN p_kind='qualification' THEN jsonb_build_object('is_highest',false) WHEN p_kind='dependent' THEN jsonb_build_object('is_beneficiary',false,'is_deceased',false) ELSE jsonb_build_object('priority','other') END||normalized;
   IF COALESCE(normalized->>'qualification',normalized->>'full_name','')='' THEN RAISE EXCEPTION 'Workforce name required' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_kind='dependent' THEN
   IF relationship IS NULL THEN RAISE EXCEPTION 'Family relationship required' USING ERRCODE='22023'; END IF;
   IF p_operation='add' OR relationship IS DISTINCT FROM before_row->>'relationship' THEN
    IF relationship<>'spouse' THEN normalized:=normalized||jsonb_build_object('marriage_date',NULL,'marriage_status',NULL,'spouse_working',NULL,'company_name',NULL,'employer_address',NULL); END IF;
    IF relationship<>'child' THEN normalized:=normalized||jsonb_build_object('is_student',NULL,'school_name',NULL,'study_level',NULL,'study_country',NULL,'child_relief_category',NULL,'child_tax_relief',NULL,'child_relief_percentage',NULL); END IF;
   END IF;
  END IF;
  IF p_kind='qualification' THEN
   after_row:=before_row||normalized;
   IF after_row->>'from_ym'>after_row->>'to_ym' OR left(after_row->>'graduation_date',7)<after_row->>'from_ym' THEN
    RAISE EXCEPTION 'Qualification date order invalid' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_kind='person' AND normalized ? 'marital_status' THEN normalized:=normalized||jsonb_build_object('marital_status_source_request_id',NULL); END IF;
  IF p_operation<>'add' AND NOT EXISTS(SELECT 1 FROM jsonb_each(normalized) d WHERE d.value IS DISTINCT FROM before_row->d.key) THEN
   -- Existing Family saves refresh age-dependent facts even when the edited row itself is unchanged.
   IF p_kind='dependent' THEN PERFORM app.my_sync_family_child_relief(selected.person_id); END IF;
   -- Generic Family notice is independent of private tax mode or other-company payroll state.
   RETURN jsonb_build_object('id',target_id,'changed',false,'hrReviewNotice',p_kind='dependent'); END IF;
  IF p_kind<>'person' THEN normalized:=normalized||jsonb_build_object('updated_at',instant); END IF;
 END IF;
 -- Transfer exactly one Primary/Highest using the same finite fields as the existing canonical owner.
 -- Every affected row has its own exact private before/after witness, tied to the one main event.
 IF p_kind='qualification' AND normalized->'is_highest'='true'::jsonb OR p_kind='emergency' AND normalized->>'priority'='primary' THEN
  FOR previous IN EXECUTE format('SELECT to_jsonb(r) value FROM public.%I r WHERE r.tenant_id=$1 AND r.%I=$2 AND r.id<>$3 AND r.archived_at IS NULL AND %s ORDER BY r.id FOR UPDATE',
   table_name,subject_column,CASE WHEN p_kind='qualification' THEN 'r.is_highest' ELSE 'r.priority=''primary''' END) USING selected.tenant_id,subject_id,target_id
  LOOP
   previous_after:=previous.value||jsonb_build_object(CASE WHEN p_kind='qualification' THEN 'is_highest' ELSE 'priority' END,
    CASE WHEN p_kind='qualification' THEN 'false'::jsonb ELSE '"secondary"'::jsonb END,'updated_at',instant);
   INSERT INTO app.access_workforce_value_intent(xact_id,tenant_id,user_id,employment_id,kind,row_id,before_hash,after_hash,audit_root,event_type)
    VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,p_kind,(previous.value->>'id')::uuid,
     encode(sha256(convert_to(previous.value::text,'UTF8')),'hex'),encode(sha256(convert_to(previous_after::text,'UTF8')),'hex'),target_id,event_name);
   EXECUTE format('UPDATE public.%I SET %s,updated_at=$1 WHERE id=$2 AND tenant_id=$3',table_name,
    CASE WHEN p_kind='qualification' THEN 'is_highest=false' ELSE 'priority=''secondary''' END)
    USING instant,(previous.value->>'id')::uuid,selected.tenant_id;
   effect_id:=(previous.value->>'id')::uuid;
  END LOOP;
 END IF;
 IF p_operation='add' THEN
  normalized:=normalized||jsonb_build_object('id',target_id,'tenant_id',selected.tenant_id,subject_column,subject_id);
  SELECT string_agg(format('%I',key),',' ORDER BY key),string_agg(format('v.%I',key),',' ORDER BY key)
   INTO insert_columns,insert_values FROM jsonb_object_keys(normalized) key;
  EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) v RETURNING to_jsonb(%I.*)',table_name,insert_columns,insert_values,table_name,table_name)
   INTO after_row USING normalized;
 ELSE
  after_row:=before_row||normalized;
  INSERT INTO app.access_workforce_value_intent(xact_id,tenant_id,user_id,employment_id,kind,row_id,before_hash,after_hash,audit_root,event_type)
   VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,p_kind,target_id,
    encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'),target_id,event_name);
  SELECT string_agg(format('%I=v.%I',key,key),',' ORDER BY key) INTO assignments FROM jsonb_object_keys(normalized) key;
  EXECUTE format('UPDATE public.%I r SET %s FROM jsonb_populate_record(NULL::public.%I,$1) v WHERE r.id=$2 AND r.tenant_id=$3 RETURNING to_jsonb(r.*)',table_name,assignments,table_name)
   INTO after_row USING normalized,target_id,selected.tenant_id;
 END IF;
 IF p_operation='add' THEN
  INSERT INTO app.access_workforce_value_intent(xact_id,tenant_id,user_id,employment_id,kind,row_id,before_hash,after_hash,audit_root,event_type)
   VALUES(pg_current_xact_id(),selected.tenant_id,app.current_user_id(),selected.id,p_kind,target_id,
    encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),encode(sha256(convert_to(after_row::text,'UTF8')),'hex'),target_id,event_name);
 END IF;
 SELECT COALESCE(jsonb_agg(key ORDER BY key),'[]'::jsonb) INTO field_names FROM jsonb_object_keys(p_patch) key;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(selected.tenant_id,aggregate_name,target_id,event_name,'user',app.current_user_id(),selected.id,
   jsonb_build_object('fields',field_names,'via','workforce-maintenance','transferFromId',effect_id)) RETURNING id INTO written_event_id;
 UPDATE app.access_workforce_value_intent SET event_id=written_event_id
  WHERE xact_id=pg_current_xact_id() AND tenant_id=selected.tenant_id AND user_id=app.current_user_id() AND audit_root=target_id AND event_type=event_name;
 IF p_kind='dependent' THEN PERFORM app.my_sync_family_child_relief(selected.person_id); END IF;
 RETURN jsonb_build_object('id',target_id,'changed',true,'hrReviewNotice',p_kind='dependent');
END; $$;
--> statement-breakpoint

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_scope_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'date',current_date,
  'dataProfiles',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.data_permission_profile p WHERE p.tenant_id=app.current_tenant_id()),'[]'::jsonb),
  'dataAssignments',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.user_id) FROM public.user_data_permission_assignment a WHERE a.tenant_id=app.current_tenant_id()),'[]'::jsonb),
  'dataSubjects',coalesce((SELECT jsonb_agg(app.data_permission_subject(e.id) ORDER BY e.id) FROM public.employment e WHERE e.tenant_id=app.current_tenant_id()),'[]'::jsonb),
  'users',COALESCE((SELECT jsonb_agg(jsonb_build_array(u.id,u.archived_at,app.login_blocked(u.id),app.access_recovery_available(u.id)) ORDER BY u.id) FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id()),'[]'::jsonb),
  'companies',COALESCE((SELECT jsonb_agg(jsonb_build_array(c.id,c.parent_company_id) ORDER BY c.id) FROM public.company c WHERE c.tenant_id=app.current_tenant_id()),'[]'::jsonb),
  'roles',COALESCE((SELECT jsonb_agg(jsonb_build_array(r.id,r.app_user_id,r.role,r.company_id) ORDER BY r.id) FROM public.role_assignment r WHERE r.tenant_id=app.current_tenant_id()),'[]'::jsonb)
 )::text,'UTF8')),'hex');
$$;

--> statement-breakpoint
CREATE TRIGGER data_permission_birth_finish AFTER INSERT ON person FOR EACH ROW EXECUTE FUNCTION app.data_permission_birth_finish();
CREATE TRIGGER data_permission_birth_finish AFTER INSERT ON employment FOR EACH ROW EXECUTE FUNCTION app.data_permission_birth_finish();
CREATE TRIGGER data_permission_birth_cleanup AFTER INSERT ON person FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_birth_finish();
CREATE TRIGGER data_permission_birth_cleanup AFTER INSERT ON employment FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_birth_finish();
--> statement-breakpoint
-- An exact stored approval responsibility is distinct from general administrative data access.
-- No legacy/unrouted request or caller-provided assignee identity can create this exception.
CREATE FUNCTION app.data_permission_profile_responsibility(p_request uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.profile_change_request;candidate jsonb;approver uuid;
BEGIN
 SELECT * INTO q FROM public.profile_change_request WHERE id=p_request AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.principal_snapshot_current() OR app.is_self_person(q.person_id)
  OR NOT app.access_profile_review_permitted(q.employment_id) THEN RETURN false;END IF;
 IF q.route_context->'version'='3'::jsonb THEN
  IF q.route_context->>'decisionMode' IS DISTINCT FROM 'any' OR jsonb_typeof(q.route_context->'approvers') IS DISTINCT FROM 'array'
   OR jsonb_array_length(q.route_context->'approvers') NOT BETWEEN 1 AND 32 THEN RETURN false;END IF;
  FOR candidate IN SELECT value FROM jsonb_array_elements(q.route_context->'approvers') LOOP
   IF candidate->>'userId'=app.current_user_id()::text THEN approver:=(candidate->>'employmentId')::uuid;EXIT;END IF;
  END LOOP;
 ELSE
  IF q.route_id IS NULL OR q.route_approver_user_id IS DISTINCT FROM app.current_user_id() THEN RETURN false;END IF;
  approver:=q.route_approver_employment_id;
 END IF;
 IF approver IS NULL THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.employment a JOIN public.app_user u ON u.person_id=a.person_id AND u.tenant_id=a.tenant_id
  JOIN public.employment subject ON subject.id=q.employment_id AND subject.tenant_id=a.tenant_id
  WHERE a.id=approver AND a.tenant_id=q.tenant_id AND u.id=app.current_user_id() AND a.person_id<>subject.person_id
   AND app.is_admin_for(subject.company_id) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND a.blacklisted_at IS NULL
   AND a.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (least(a.resignation_date,a.last_working_date,a.terminated_on) IS NULL OR least(a.resignation_date,a.last_working_date,a.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND (NOT EXISTS(SELECT 1 FROM public.tenant_setting t WHERE t.tenant_id=q.tenant_id AND t.key='ess.profile_change_approver' AND t.value='"group_admin"'::jsonb) OR app.is_group_admin())
   AND (SELECT count(*) FROM public.app_user other WHERE other.tenant_id=a.tenant_id AND other.person_id=a.person_id AND other.archived_at IS NULL AND NOT app.login_blocked(other.id))=1);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_profile_responsibility(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- app.profile_request_assignee; prior owner 0683_profile_field_approvals
CREATE OR REPLACE FUNCTION app.profile_request_assignee(p_request uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.profile_change_request;principal jsonb;
BEGIN
 SELECT * INTO q FROM public.profile_change_request WHERE id=p_request AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.principal_snapshot_current() OR app.is_self_person(q.person_id) OR (NOT app.can_admin_employment(q.employment_id) AND NOT app.data_permission_profile_responsibility(q.id))
  OR NOT app.access_profile_review_permitted(q.employment_id) THEN RETURN false;END IF;
 IF q.route_context->'version'='3'::jsonb THEN
  IF q.route_context->>'decisionMode' IS DISTINCT FROM 'any' OR jsonb_typeof(q.route_context->'approvers') IS DISTINCT FROM 'array'
   OR jsonb_array_length(q.route_context->'approvers') NOT BETWEEN 1 AND 32 THEN RETURN false;END IF;
  FOR principal IN SELECT a FROM jsonb_array_elements(q.route_context->'approvers') a LOOP
   IF principal->>'userId'=app.current_user_id()::text AND EXISTS(SELECT 1 FROM app.profile_route_principal((principal->>'employmentId')::uuid,q.employment_id) p WHERE p.user_id=app.current_user_id()) THEN RETURN true;END IF;
  END LOOP;
  RETURN false;
 END IF;
 IF q.route_id IS NULL AND EXISTS(SELECT 1 FROM app.profile_legacy_unassigned_request l WHERE l.request_id=q.id) THEN RETURN true;END IF;
 RETURN app.profile_route_reader(q.employment_id,q.route_approver_user_id,q.route_approver_employment_id,q.status::text);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;$$;
--> statement-breakpoint

--> statement-breakpoint
-- app.access_profile_value_begin; prior owner 0683_profile_field_approvals
CREATE OR REPLACE FUNCTION app.access_profile_value_begin(p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.profile_change_request%ROWTYPE;r jsonb;route_enabled boolean;route_digest text;proposal_digest text;prepared boolean;actor uuid;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN; END IF;
 PERFORM app.access_profile_policy_write_lock();
 IF app.principal_snapshot_current() IS NOT TRUE OR app.current_user_id() IS NULL THEN
  RAISE EXCEPTION 'Profile decision principal unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO q FROM public.profile_change_request WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR q.status<>'pending' OR q.proposed->'v'='3'::jsonb
  OR app.access_profile_review_permitted(q.employment_id) IS NOT TRUE OR (app.can_admin_employment(q.employment_id) IS NOT TRUE AND NOT app.data_permission_profile_responsibility(q.id))
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=q.employment_id AND e.tenant_id=q.tenant_id AND e.person_id=q.person_id) THEN
  RAISE EXCEPTION 'Profile decision write unavailable' USING ERRCODE='42501'; END IF;
 SELECT value INTO r FROM public.tenant_setting WHERE tenant_id=q.tenant_id AND key='ess.profile_change_routing';
 IF r IS NOT NULL AND r<>'null'::jsonb AND (jsonb_typeof(r) IS DISTINCT FROM 'object' OR r->'version' NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb)
  OR r->'version' IS NULL OR jsonb_typeof(r->'enabled') IS DISTINCT FROM 'boolean') THEN
  RAISE EXCEPTION 'Profile decision route unavailable' USING ERRCODE='42501'; END IF;
 route_enabled:=COALESCE(r->'enabled'='true'::jsonb,false);
 proposal_digest:=encode(sha256(convert_to(q.proposed::text,'UTF8')),'hex');
 route_digest:=encode(sha256(convert_to(jsonb_build_array(q.route_id,q.route_revision,q.route_approver_user_id,q.route_approver_employment_id,q.route_context)::text,'UTF8')),'hex');
 SELECT EXISTS(SELECT 1 FROM app.access_profile_value_approval p WHERE p.xact_id=pg_current_xact_id() AND p.request_id=q.id
  AND p.tenant_id=q.tenant_id AND p.user_id=app.current_user_id() AND p.proposal_hash=proposal_digest AND p.route_hash=route_digest) INTO prepared;
 IF q.route_id IS NOT NULL THEN
  IF (q.route_context->'version'='3'::jsonb AND NOT app.profile_request_assignee(q.id)) OR
   (q.route_context->'version' IS DISTINCT FROM '3'::jsonb AND (q.route_approver_user_id IS DISTINCT FROM app.current_user_id()
   OR NOT EXISTS(SELECT 1 FROM app.profile_route_principal(q.route_approver_employment_id,q.employment_id) p WHERE p.user_id=app.current_user_id()))) THEN
   RAISE EXCEPTION 'Profile decision route changed' USING ERRCODE='42501'; END IF;
  -- The first preparation locks and validates the BEFORE snapshot. Revalidating after applying a
  -- requested nationality/gender change would incorrectly invalidate its own authorized decision.
  IF NOT prepared AND (q.route_context->>'fingerprint' IS DISTINCT FROM app.access_profile_route_fingerprint(q.employment_id)) THEN
   RAISE EXCEPTION 'Profile decision subject changed' USING ERRCODE='42501'; END IF;
 ELSIF (route_enabled AND NOT EXISTS(SELECT 1 FROM app.profile_legacy_unassigned_request l WHERE l.request_id=q.id)) OR q.route_approver_user_id IS NOT NULL OR q.route_approver_employment_id IS NOT NULL THEN
  RAISE EXCEPTION 'Profile decision route changed' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_setting WHERE tenant_id=q.tenant_id AND key='ess.profile_change_approver' AND value='"group_admin"'::jsonb)
  AND app.is_group_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Profile decision group scope required' USING ERRCODE='42501'; END IF;
 INSERT INTO app.access_profile_value_actor VALUES(pg_current_xact_id(),q.tenant_id,app.current_user_id()) ON CONFLICT DO NOTHING;
 SELECT user_id INTO actor FROM app.access_profile_value_actor WHERE xact_id=pg_current_xact_id() AND tenant_id=q.tenant_id;
 IF actor IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Profile write principal changed' USING ERRCODE='42501'; END IF;
 INSERT INTO app.access_profile_value_approval(xact_id,tenant_id,request_id,user_id,proposal_hash,route_hash)
  VALUES(pg_current_xact_id(),q.tenant_id,q.id,app.current_user_id(),proposal_digest,route_digest) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM app.access_profile_value_approval p WHERE p.xact_id=pg_current_xact_id() AND p.request_id=q.id
  AND p.tenant_id=q.tenant_id AND p.user_id=app.current_user_id() AND p.proposal_hash=proposal_digest AND p.route_hash=route_digest) THEN
  RAISE EXCEPTION 'Profile decision preparation changed' USING ERRCODE='42501'; END IF;
END; $$;
--> statement-breakpoint

--> statement-breakpoint
-- app.profile_route_principal; prior owner 0579_configurable_access
CREATE OR REPLACE FUNCTION app.profile_route_principal(p_approver uuid,p_subject uuid)
RETURNS TABLE(user_id uuid,employment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT u.id,a.id FROM employment a JOIN app_user u ON u.person_id=a.person_id AND u.tenant_id=a.tenant_id
 JOIN employment s ON s.id=p_subject AND s.tenant_id=a.tenant_id
 WHERE a.id=p_approver AND a.tenant_id=app.current_tenant_id() AND a.person_id<>s.person_id
 AND (app.is_self_person(s.person_id) OR app.can_admin_employment(s.id) OR u.id=app.current_user_id() AND EXISTS(SELECT 1 FROM public.profile_change_request q WHERE q.employment_id=s.id AND q.tenant_id=s.tenant_id AND app.data_permission_profile_responsibility(q.id)))
 AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND a.blacklisted_at IS NULL
 AND a.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND (LEAST(a.resignation_date,a.last_working_date,a.terminated_on) IS NULL OR LEAST(a.resignation_date,a.last_working_date,a.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND EXISTS(SELECT 1 FROM role_assignment r WHERE r.tenant_id=a.tenant_id AND r.app_user_id=u.id AND r.role IN ('hr_admin','super_admin')
  AND (r.company_id IS NULL OR r.company_id=s.company_id OR app.is_company_descendant(s.company_id,r.company_id)))
 AND (NOT EXISTS(SELECT 1 FROM tenant_setting t WHERE t.tenant_id=a.tenant_id AND t.key='ess.profile_change_approver' AND t.value='"group_admin"'::jsonb) OR EXISTS(SELECT 1 FROM role_assignment g WHERE g.tenant_id=a.tenant_id AND g.app_user_id=u.id AND (g.role='super_admin' OR g.role='hr_admin' AND g.company_id IS NULL)))
 AND app.access_profile_review_for_user(u.id,s.id)
 AND (SELECT count(*) FROM app_user other WHERE other.tenant_id=a.tenant_id AND other.person_id=a.person_id AND other.archived_at IS NULL AND NOT app.login_blocked(other.id))=1;
$$;
--> statement-breakpoint

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.profile_route_reader(p_subject uuid,p_assigned_user uuid,p_assigned_employment uuid,p_status text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT (app.can_admin_employment(p_subject) AND (
  (p_assigned_user IS NOT NULL AND p_assigned_user=app.current_user_id() AND NOT app.login_blocked(p_assigned_user)
    AND EXISTS(SELECT 1 FROM app.profile_route_principal(p_assigned_employment,p_subject) p WHERE p.user_id=p_assigned_user))
  OR (p_assigned_user IS NULL AND (p_status<>'pending' OR NOT EXISTS(SELECT 1 FROM tenant_setting t WHERE t.tenant_id=app.current_tenant_id() AND t.key='ess.profile_change_routing') OR EXISTS(SELECT 1 FROM tenant_setting t WHERE t.tenant_id=app.current_tenant_id() AND t.key='ess.profile_change_routing' AND t.value->>'version' IN ('1','2') AND t.value->'enabled'='false'::jsonb)))
  OR (app.is_group_admin() AND current_setting('app.profile_route_maintenance',true)='on')
 )) OR (p_assigned_user=app.current_user_id() AND EXISTS(SELECT 1 FROM public.profile_change_request q
 WHERE q.employment_id=p_subject AND q.tenant_id=app.current_tenant_id() AND q.route_approver_user_id=p_assigned_user
 AND q.route_approver_employment_id=p_assigned_employment AND q.status::text=p_status AND app.data_permission_profile_responsibility(q.id))); $$;
--> statement-breakpoint
-- Promoting a scoped account into the protected recovery role must not strand that role behind an
-- older restrictive profile. Clear/review its data assignment explicitly before granting recovery.
CREATE FUNCTION app.data_permission_protected_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row_value jsonb;target_user uuid;t uuid;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL;END IF;
 row_value:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;t:=(row_value->>'tenant_id')::uuid;
 target_user:=CASE TG_TABLE_NAME WHEN 'app_user' THEN (row_value->>'id')::uuid WHEN 'role_assignment' THEN (row_value->>'app_user_id')::uuid ELSE (row_value->>'user_id')::uuid END;
 IF t IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'Data recovery principal unavailable' USING ERRCODE='42501';END IF;
 IF app.data_permission_protected(target_user) AND EXISTS(SELECT 1 FROM public.user_data_permission_assignment a
  LEFT JOIN public.data_permission_profile p ON p.id=a.profile_id AND p.tenant_id=a.tenant_id
  LEFT JOIN public.data_permission_revision r ON r.id=p.active_revision_id AND r.profile_id=p.id AND r.tenant_id=p.tenant_id
  WHERE a.user_id=target_user AND a.tenant_id=t AND (p.id IS NULL OR NOT p.enabled OR p.retired_at IS NOT NULL
   OR r.id IS NULL OR NOT app.data_permission_rules_valid(r.rules) OR r.rules->>'legacyCompany' IS DISTINCT FROM 'true')) THEN
  RAISE EXCEPTION 'Data recovery assignment unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_protected_assignment_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER data_permission_recovery_assignment AFTER INSERT OR UPDATE ON role_assignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.data_permission_protected_assignment_guard();
CREATE CONSTRAINT TRIGGER data_permission_recovery_assignment AFTER INSERT OR UPDATE ON access_membership DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.data_permission_protected_assignment_guard();
CREATE CONSTRAINT TRIGGER data_permission_recovery_assignment AFTER UPDATE ON app_user DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.data_permission_protected_assignment_guard();
--> statement-breakpoint
-- Native RR report/ESS readers keep consistent source snapshots. A cheap committed generation
-- fence around that snapshot detects authority changes before any result is returned to its caller.
CREATE TABLE app.data_permission_read_generation (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,generation bigint NOT NULL DEFAULT 1
);
ALTER TABLE app.data_permission_read_generation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.data_permission_read_generation FROM PUBLIC,ai_hr_app;
INSERT INTO app.data_permission_read_generation(tenant_id) SELECT id FROM public.tenant;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_read_generation_bump() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;query text;columns text[]:=string_to_array(coalesce(TG_ARGV[0],''),',');
BEGIN
 IF TG_TABLE_NAME='access_capability' THEN UPDATE app.data_permission_read_generation SET generation=generation+1;RETURN NULL;END IF;
 IF TG_TABLE_NAME='tenant' THEN
  IF TG_OP='INSERT' THEN INSERT INTO app.data_permission_read_generation(tenant_id) SELECT id FROM new_rows ON CONFLICT DO NOTHING;
  ELSIF TG_OP='UPDATE' THEN UPDATE app.data_permission_read_generation g SET generation=g.generation+1 WHERE g.tenant_id IN(SELECT id FROM new_rows);END IF;
  RETURN NULL;
 END IF;
 -- Agent execution switches change work, not who may see employee records. ESS policy
 -- settings do change record/field/approval authority and remain part of this fence.
 IF TG_TABLE_NAME='tenant_setting' THEN
  IF TG_OP='UPDATE' THEN
   query:='SELECT DISTINCT tenant_id FROM (SELECT tenant_id,key FROM new_rows UNION ALL SELECT tenant_id,key FROM old_rows) changed WHERE key LIKE ''ess.%''';
  ELSE query:='SELECT DISTINCT tenant_id FROM '||CASE WHEN TG_OP='DELETE' THEN 'old_rows' ELSE 'new_rows' END||' WHERE key LIKE ''ess.%''';END IF;
 ELSIF TG_OP='UPDATE' AND cardinality(columns)>0 THEN
  query:='SELECT DISTINCT n.tenant_id FROM new_rows n JOIN old_rows o USING(id) WHERE EXISTS(SELECT 1 FROM unnest($1::text[]) column_name WHERE to_jsonb(n)->column_name IS DISTINCT FROM to_jsonb(o)->column_name)';
 ELSE query:='SELECT DISTINCT tenant_id FROM '||CASE WHEN TG_OP='DELETE' THEN 'old_rows' ELSE 'new_rows' END;END IF;
 FOR t IN EXECUTE query USING columns LOOP
  INSERT INTO app.data_permission_read_generation SELECT t,1 WHERE EXISTS(SELECT 1 FROM public.tenant tenant_row WHERE tenant_row.id=t) ON CONFLICT(tenant_id) DO UPDATE SET generation=app.data_permission_read_generation.generation+1;
 END LOOP;RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_read_generation_bump() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.data_permission_read_stamp() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.principal_snapshot_current() OR app.current_agent_principal() IS NOT NULL THEN
  encode(sha256(convert_to(jsonb_build_array(g.tenant_id,g.generation,app.current_user_id(),app.current_agent_principal(),current_date)::text,'UTF8')),'hex') ELSE NULL END
 FROM app.data_permission_read_generation g WHERE g.tenant_id=app.current_tenant_id();
$$;
REVOKE ALL ON FUNCTION app.data_permission_read_stamp() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.data_permission_read_stamp() TO ai_hr_app;
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON person REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('nationality,gender,marital_status');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON person REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('nationality,gender,marital_status');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON person REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('nationality,gender,marital_status');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON employment REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('person_id,company_id,grade_id,org_division,org_branch,org_section,org_team,employment_category,employee_code,hired_on,join_date,blacklisted_at,resignation_date,last_working_date,terminated_on,final_confirmation_date,confirmation_date,probation_end_date,provisional_end_on,voided_at');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON employment REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('person_id,company_id,grade_id,org_division,org_branch,org_section,org_team,employment_category,employee_code,hired_on,join_date,blacklisted_at,resignation_date,last_working_date,terminated_on,final_confirmation_date,confirmation_date,probation_end_date,provisional_end_on,voided_at');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON employment REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('person_id,company_id,grade_id,org_division,org_branch,org_section,org_team,employment_category,employee_code,hired_on,join_date,blacklisted_at,resignation_date,last_working_date,terminated_on,final_confirmation_date,confirmation_date,probation_end_date,provisional_end_on,voided_at');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON assignment REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('employment_id,company_id,business_unit_id,department_id,position_id,cost_center_id,employment_type,valid_from,valid_to,superseded_at');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON assignment REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('employment_id,company_id,business_unit_id,department_id,position_id,cost_center_id,employment_type,valid_from,valid_to,superseded_at');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON assignment REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('employment_id,company_id,business_unit_id,department_id,position_id,cost_center_id,employment_type,valid_from,valid_to,superseded_at');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON company REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('parent_company_id,archived_at');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON company REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('parent_company_id,archived_at');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON company REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('parent_company_id,archived_at');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON app_user REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('person_id,archived_at');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON app_user REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('person_id,archived_at');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON app_user REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('person_id,archived_at');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON tenant REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON tenant REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON role_assignment REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON role_assignment REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON role_assignment REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON access_configuration REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON access_configuration REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON access_configuration REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON access_group REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON access_group REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON access_group REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON access_group_grant REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON access_group_grant REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON access_group_grant REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON access_membership REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON access_membership REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON access_membership REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON access_user_override REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON access_user_override REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON access_user_override REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON access_capability REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON access_capability REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON access_capability REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON data_permission_profile REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON data_permission_profile REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON data_permission_profile REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON data_permission_revision REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON data_permission_revision REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON data_permission_revision REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON user_data_permission_assignment REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON user_data_permission_assignment REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON user_data_permission_assignment REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON reporting_line REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON reporting_line REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON reporting_line REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON department REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON department REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('company_id,parent_department_id,business_unit_id,head_employment_id,is_global,archived_at');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON department REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON business_unit REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON business_unit REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('company_id,head_employment_id,is_global,archived_at');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON business_unit REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON tenant_module REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON tenant_module REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON tenant_module REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON tenant_setting REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON tenant_setting REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON tenant_setting REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON letter_capability_grant REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON letter_capability_grant REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON letter_capability_grant REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_insert AFTER INSERT ON payroll_permission_grant REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_update AFTER UPDATE ON payroll_permission_grant REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
CREATE TRIGGER data_permission_read_generation_delete AFTER DELETE ON payroll_permission_grant REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_read_generation_bump('');
--> statement-breakpoint
CREATE FUNCTION app.data_permission_identity_generation_bump() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;query text;
BEGIN
 IF TG_TABLE_NAME='app_external_identity' THEN
  query:='SELECT DISTINCT u.tenant_id FROM public.app_user u JOIN '||CASE WHEN TG_OP='DELETE' THEN 'old_rows' ELSE 'new_rows' END||' binding ON binding.app_user_id=u.id';
  IF TG_OP='UPDATE' THEN query:=query||' UNION SELECT DISTINCT u.tenant_id FROM public.app_user u JOIN old_rows binding ON binding.app_user_id=u.id';END IF;
 ELSE
  query:='SELECT DISTINCT u.tenant_id FROM public.app_user u JOIN public.app_external_identity binding ON binding.app_user_id=u.id JOIN '||CASE WHEN TG_OP='DELETE' THEN 'old_rows' ELSE 'new_rows' END||' credential ON credential.owner_id::text=binding.subject WHERE credential.record_key LIKE ''credential:%''';
 END IF;
 FOR t IN EXECUTE query LOOP UPDATE app.data_permission_read_generation SET generation=generation+1 WHERE tenant_id=t;END LOOP;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.data_permission_identity_generation_bump() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER data_permission_identity_generation_insert AFTER INSERT ON app_external_identity REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_identity_generation_bump();
CREATE TRIGGER data_permission_identity_generation_update AFTER UPDATE ON app_external_identity REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_identity_generation_bump();
CREATE TRIGGER data_permission_identity_generation_delete AFTER DELETE ON app_external_identity REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_identity_generation_bump();
CREATE TRIGGER data_permission_credential_generation_update AFTER UPDATE ON app_internal_auth_record REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_identity_generation_bump();
CREATE TRIGGER data_permission_credential_generation_delete AFTER DELETE ON app_internal_auth_record REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.data_permission_identity_generation_bump();
