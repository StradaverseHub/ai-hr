-- Tenant-isolation defence in depth, ADR-0174 follow-up part 1 of 3. Not an exploitable gap today: these
-- functions are reached through policies and services that already carry a tenant conjunct. This makes each
-- one safe on its own.
--
-- A function's own SET search_path that does not name pg_temp still searches the session's temporary schema
-- FIRST for relation AND type names (functions and operators are never looked up there). Any role that may
-- create TEMP tables (PUBLIC by default, so ai_hr_app) can therefore put a TEMP `employment` in front of
-- public.employment, or a TEMP table named `uuid` in front of the uuid type, inside a SECURITY DEFINER body,
-- even when pg_catalog is listed first and every relation is schema-qualified. Naming pg_temp LAST closes it.
--
-- 1. app.can_see_employment, app.can_see_person and the two definer walks they call are re-issued with
--    `pg_catalog, public, pg_temp` and schema-qualified relations (the 0312/2100 rule). Bodies are 0109/0121/
--    0001 verbatim apart from the qualification and, in the two walks, a session-tenant pin on every row they
--    read: both are EXECUTE-able by ai_hr_app with arbitrary ids and read past RLS, so they now answer only
--    inside the session tenant, as 2100 did for the employment admin helpers. Every caller runs in withTenant.
-- 2. Every other SECURITY DEFINER function, and every invoker function that carries its own search_path,
--    keeps its path and gains pg_temp as the last entry (a bare `public` becomes `pg_catalog, public, pg_temp`,
--    which resolves identically). ALTER FUNCTION ... SET changes only that setting: body, owner, ACL,
--    volatility, OID and dependent policies are untouched, other settings (TimeZone) are kept. No body creates
--    or reads a TEMP relation of its own (catalog checks, 4 and 5 November 2026). Invokers are included because a
--    definer that calls one runs it with the definer's privileges under the invoker's own path.
-- 3. Sixty of them are owned by dedicated NOLOGIN roles (ai_hr_rewards_post_reader from 0689, and the
--    Architecture and Rewards readers and guard from 2200–2208). Each migration gave its functions to that role
--    with ALTER FUNCTION ... OWNER TO, which PostgreSQL 16 allows only to a superuser or a member with SET, so
--    this migration assumes each role for exactly its own functions and resets.
-- 4. app.is_company_descendant is not touched: 2126 already re-issued it pinned to the session tenant.
--
-- test/definer-search-path-pin.test.ts fails on any future definer, or function with its own path, that does
-- not end its search_path with pg_temp. No table, column, policy or function grant changes.
CREATE OR REPLACE FUNCTION app.is_admin_report_of(subject_emp uuid, manager_emp uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH RECURSIVE mgr AS (
    SELECT company_id AS root_company FROM public.employment
    WHERE id = manager_emp AND tenant_id = app.current_tenant_id()
  ),
  down AS (
    -- Seed: direct reports of the manager (depth 1).
    SELECT rl.subordinate_employment_id AS emp, 1 AS depth
    FROM public.reporting_line rl
    JOIN public.employment sub ON sub.id = rl.subordinate_employment_id
    JOIN mgr ON true
    WHERE rl.manager_employment_id = manager_emp
      AND rl.tenant_id = app.current_tenant_id() AND sub.tenant_id = app.current_tenant_id()
      AND rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND sub.terminated_on IS NULL
      AND app.is_company_descendant(sub.company_id, mgr.root_company)
    UNION
    -- Recurse: reports of any reachable (non-terminated) intermediate manager.
    SELECT rl.subordinate_employment_id, d.depth + 1
    FROM public.reporting_line rl
    JOIN public.employment mid ON mid.id = rl.manager_employment_id
    JOIN public.employment sub ON sub.id = rl.subordinate_employment_id
    JOIN down d ON d.emp = rl.manager_employment_id
    JOIN mgr ON true
    WHERE rl.line_type = 'administrative'
      AND rl.tenant_id = app.current_tenant_id() AND mid.tenant_id = app.current_tenant_id()
      AND sub.tenant_id = app.current_tenant_id()
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND mid.terminated_on IS NULL
      AND sub.terminated_on IS NULL
      AND d.depth < 64
      AND app.is_company_descendant(sub.company_id, mgr.root_company)
  )
  SELECT EXISTS (SELECT 1 FROM down WHERE emp = subject_emp);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.heads_department_of(subject_emp uuid, caller_emp uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH caller_dept AS (
    SELECT a.department_id AS dept, d.company_id AS company
    FROM public.assignment a
    JOIN public.employment e ON e.id = a.employment_id
    JOIN public.department d ON d.id = a.department_id
    WHERE a.employment_id = caller_emp
      AND a.tenant_id = app.current_tenant_id() AND e.tenant_id = app.current_tenant_id()
      AND d.tenant_id = app.current_tenant_id()
      AND a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
      AND e.terminated_on IS NULL
  ),
  subject_dept AS (
    SELECT a.department_id AS dept
    FROM public.assignment a
    WHERE a.employment_id = subject_emp
      AND a.tenant_id = app.current_tenant_id()
      AND a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
  ),
  -- All departments in the subtree rooted at the caller's department (inclusive), clamped so every hop
  -- stays within the caller's company subtree (mirrors the manager branch's app.is_company_descendant clamp).
  subtree AS (
    WITH RECURSIVE down AS (
      SELECT cd.dept AS id, 0 AS depth FROM caller_dept cd
      UNION ALL
      SELECT d.id, down.depth + 1
      FROM public.department d
      JOIN down ON d.parent_department_id = down.id
      JOIN caller_dept cd ON true
      -- Audit #35: depth cap (mirrors app.is_admin_report_of's d.depth < 64) so a cyclic or pathologically
      -- deep department chain cannot loop unbounded inside this SECURITY DEFINER fn on every visibility check.
      WHERE app.is_company_descendant(d.company_id, cd.company) AND down.depth < 64
        AND d.tenant_id = app.current_tenant_id()
    )
    SELECT id FROM down
  )
  SELECT EXISTS (
    SELECT 1
    FROM subject_dept sd
    JOIN subtree st ON st.id = sd.dept
    WHERE EXISTS (SELECT 1 FROM caller_dept)
      AND EXISTS (
        SELECT 1 FROM public.reporting_line rl
        WHERE rl.manager_employment_id = caller_emp
          AND rl.tenant_id = app.current_tenant_id()
          AND rl.line_type = 'administrative'
          AND rl.superseded_at IS NULL
          AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      )
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_see_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
      SELECT 1 FROM public.employment e
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND app.is_admin_for(e.company_id)
    )
    OR EXISTS (
      SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id = e.person_id
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND u.id = app.current_user_id()
    )
    OR EXISTS (
      -- Recursive administrative-manager branch (direct + indirect reports), over all caller employments.
      SELECT 1 FROM public.employment me
        JOIN public.app_user u ON u.person_id = me.person_id
      WHERE u.id = app.current_user_id()
        AND me.tenant_id = app.current_tenant_id()
        AND me.terminated_on IS NULL
        AND app.is_admin_report_of(emp_id, me.id)
    )
    OR EXISTS (
      -- HOD department-tree branch, over all caller employments.
      SELECT 1 FROM public.employment me
        JOIN public.app_user u ON u.person_id = me.person_id
      WHERE u.id = app.current_user_id()
        AND me.tenant_id = app.current_tenant_id()
        AND me.terminated_on IS NULL
        AND app.heads_department_of(emp_id, me.id)
    );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_see_person(p_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.app_user u
      WHERE u.id = app.current_user_id() AND u.person_id = p_id AND u.tenant_id = app.current_tenant_id()
    )
    OR EXISTS (
      SELECT 1 FROM public.employment e
      WHERE e.person_id = p_id AND e.tenant_id = app.current_tenant_id() AND app.can_see_employment(e.id)
    );
$$;
--> statement-breakpoint
-- Every other SECURITY DEFINER function keeps its path, with pg_temp appended.
ALTER FUNCTION app.access_workforce_picker_rows(text,date,date) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.ai_active_provider_config_v2() SET search_path = public, pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.ai_active_provider_config() SET search_path = public, pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.append_auth_event(uuid,text,uuid,text,text,uuid,jsonb) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.approval_history_count(timestamp with time zone,timestamp with time zone,text[],text,uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.approval_history(timestamp with time zone,timestamp with time zone,text[],text,uuid,integer,integer) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.approver_level(uuid,date) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.can_access_feedback(uuid) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.can_decide_via_delegation(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.claim_activation_url(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.consume_request_budget(text,integer,integer) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.dashboard_layout_get() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.dashboard_layout_reset() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.dashboard_layout_set(jsonb) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.dev_principals() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.eligible_delegates(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.employment_organisation_quality(uuid,date) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.feedback_event_readable(uuid,uuid) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.feedback_live_principal() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.grants_have_role_for(jsonb,text,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.guard_letter_email_consent() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.guard_letter_email_delivery() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.guard_letter_notification() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.is_self_person(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.job_document_actor_label(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.lc_my_case_id() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.lc_my_view() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.lc_next_number(text) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.lc_staff_directory(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_approval_actor_label(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_approver_eligible_at(uuid,uuid,uuid,boolean) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_approver_eligible(uuid,uuid,boolean) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_asset_choices(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_asset_reference(uuid,uuid,text,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_audit_actor_label(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_audit(uuid,uuid,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_batch_can_read(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_batch_financial_access(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_bind_insert() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_can_read(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_company_in_use(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_creator_eligible_at(uuid,uuid,uuid,boolean) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_creator_eligible(uuid,uuid,boolean) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_delegate_choices(uuid,uuid,text,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_email_consent_identity(text,text,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_email_enqueue(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_field_in_use(uuid,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_field_latest_version(uuid,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_folder_binding() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_permission_for_user_at(uuid,uuid,uuid,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_permission_for_user(uuid,uuid,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_permission(uuid,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_policy_appearance(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_policy_people(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_recipient_link_minutes(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_recipient_mode(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_record_transition() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_setting_asset_page(uuid,text,uuid,uuid,text,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_signatory_choices(uuid,uuid,text,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_staff_batch_metadata(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_staff_identity(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_staff_scope(uuid,uuid,uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_template_appearance(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_template_transition() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.list_preferences_get() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.list_preferences_reset() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.list_preferences_set(jsonb) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.marriage_leave_revert_single(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.marriage_leave_set_married(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_integrity_actor() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_integrity_installation_id() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_integrity_subject(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_claim_resolution_bound() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_claim_resolution_state(uuid[]) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_claim_window(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_key_counter() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_key_leased(uuid,uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_push_release(uuid,text,text) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.next_bank_payment_tape(uuid,date) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.notification_email_delivery_authorized(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.onboarding_complete() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.onboarding_reset() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.onboarding_status() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.pay_formula_active(text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.pay_formula_bind_pay_item() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.pay_formula_bind() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.pay_formula_catalog_access() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.pay_formula_category(uuid,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.pay_formula_company_in_use(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.pay_formula_definition_read() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.pay_formula_keep_identity() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.pay_formula_trace_access(uuid,uuid,jsonb) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_history_actor_label(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_history_attempt_access(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_history_batch_adopted(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_history_bind_record() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_history_bind_revision() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_history_bind_snapshot() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_history_effective(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_history_self_issued(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_run_exists_for_periods(text[]) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_tax_basis_bind() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_tax_basis_permission(uuid,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_tax_basis_reader_compatible(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_tax_basis_replacement_bind() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.payroll_tax_basis_subjects(uuid,integer,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.personnel_duplicate_candidate_rows(uuid[],date) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.personnel_filter_companies(uuid[],date) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.personnel_filter_rows(date,uuid[]) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.personnel_identity_search_permitted(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.personnel_private_search_bind() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.personnel_private_search_matches(text,uuid,uuid,uuid[]) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.personnel_search_rows(uuid[]) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.principal_by_subject(text) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.principal(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.public_login_presentation(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_pool_notification_recipients(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_validate_links() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.self_delegations() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.session_idle_timeout_minutes(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.subject_head(uuid,text) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_assigned(uuid) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_assignment_guard() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_attachment_guard() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_case_guard() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_case_retest() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_execution_guard() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_live_principal() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_lock_own_assignment(uuid) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_next_run_no(uuid) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_own_execution_event_source(uuid,uuid) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_owns_execution(uuid) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_run_advance() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_run_guard() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.verify_letter_status(text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.visible_employment_ids() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.visible_person_ids() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION identity_email.letter_job_current(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
-- Invoker functions with their own path (they run with a calling definer's privileges).
ALTER FUNCTION app._payroll_completion_uuid_array(jsonb) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app._payroll_reset_hash(jsonb) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app._payroll_reset_json(anyelement) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.ai_gateway_options_valid(jsonb) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.ai_openrouter_options_valid(jsonb) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.architecture_grade_code(text) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.architecture_grade(text) SET search_path = pg_catalog, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.can_manage_label_criteria(text,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.check_assignment_label_criteria() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.check_department_business_unit_criteria() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.check_label_company_criteria() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.employment_organisation_quality_flags(uuid,date,date,uuid,jsonb) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.feedback_attachment_binding_guard() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.feedback_user_reporter_guard() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.guard_architecture_jd_publication() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.guard_architecture_outlier_bu() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.guard_architecture_outlier_closure() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.guard_architecture_suggestion_history() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.guard_is_global() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.job_architecture_can(uuid,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.job_architecture_ladder_continuity() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.job_architecture_links() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_grant_identity() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.letter_template_identity() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.lock_assignment_label_criteria() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.lock_department_business_unit_criteria() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.lock_label_criteria_write() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.lock_system_label_criteria(uuid,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_integrity_challenge_immutable() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_integrity_key_immutable() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_claim_committed() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_claim_ordered() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_context_progress() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_immutable() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_inventory_complete() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_permit_inventory() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_photo_committed() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_offline_photo_expired() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.mobile_push_registration_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.remove_label_company_criteria() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_access_current_bu(uuid,uuid,uuid,uuid,date) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_access_policy_shape() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_advisor_binding() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_capability(uuid,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_consumed_library_immutable() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_dated_company_pair(uuid,uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_pat_basis_fingerprint(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_pat_pool_from_payroll(bigint,jsonb) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_plan_setup_immutable() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_private_entry_visible(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_role_native_capability(text,text) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_immutable() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_award_guard() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_route_guard() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_source_guard() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_view_as_write_guard() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.same_known_person_as_current_user(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.seed_label_company_criteria() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.teras_swing_pattern_valid(text) SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.teras_swing_patterns_valid(text[]) SET search_path = pg_catalog, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.testing_version_immutable() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
-- Functions owned by the dedicated role ai_hr_architecture_grade_guard, altered as that role.
SET LOCAL ROLE ai_hr_architecture_grade_guard;
--> statement-breakpoint
ALTER FUNCTION app.architecture_grade_assignable_in_tenant(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.architecture_grade_assignable(uuid) SET search_path = pg_catalog, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.guard_employment_architecture_grade() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
-- Functions owned by the dedicated role ai_hr_job_profile_reader, altered as that role.
SET LOCAL ROLE ai_hr_job_profile_reader;
--> statement-breakpoint
ALTER FUNCTION app.own_job_architecture_description(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
-- Functions owned by the dedicated role ai_hr_reward_setup_reader, altered as that role.
SET LOCAL ROLE ai_hr_reward_setup_reader;
--> statement-breakpoint
ALTER FUNCTION app.reward_access_policy_event(text,uuid,jsonb) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_applied_public_references(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_apply_confirmed_pat(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_architecture_for_source(uuid,uuid,uuid,date) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_bound_pat_inputs() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_capture_comp_movement() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_company_structure(uuid,date) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_create_planned_unit(uuid,uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_create_uploaded_unit(uuid,uuid,uuid,integer,date,jsonb,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_library_capture_revision() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_library_input_guard() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_library_locked(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_library_used_by(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_pat_affected_units(uuid,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_pat_confirm_apply() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_pat_input_guard() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_planned_progression_guard() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_private_pat_history(uuid,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_record_pat_basis(uuid,text,bigint,bigint) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_refresh_uploaded_sources(uuid,integer,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_reprice_draft_pat(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_rule_policy_reference(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_allowed(uuid,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_companies(integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_company_covered(uuid,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_company_eligible(uuid,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_company_review(uuid,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_cycle_name(uuid,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_grade_choices() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_identity_guard() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_links() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_plan_ids() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_policy_commit(uuid,integer,text,jsonb,jsonb) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_setup_policy_source(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_source_employment_scope(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_source_org_tags(uuid,date) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_binding() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_evidence(uuid,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_participation(uuid,integer,text) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_snapshot_roster(uuid,date) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_snapshot_pay_change_kind(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
-- Functions owned by the dedicated role ai_hr_reward_upload_reader, altered as that role.
SET LOCAL ROLE ai_hr_reward_upload_reader;
--> statement-breakpoint
ALTER FUNCTION app.reward_upload_checker_recipients(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_adjustment_record() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_atomic_version() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_awards_editable(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_awards_for_post(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_cycle_ready(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_digest_changed() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_maker_same_person(uuid,integer) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_source_current_internal(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_source_current(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_uploaded_validation(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
-- Functions owned by the dedicated role ai_hr_reward_view_reader, altered as that role.
SET LOCAL ROLE ai_hr_reward_view_reader;
--> statement-breakpoint
ALTER FUNCTION app.reward_not_viewing_as() SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
-- Functions owned by the dedicated role ai_hr_rewards_post_reader, altered as that role.
SET LOCAL ROLE ai_hr_rewards_post_reader;
--> statement-breakpoint
ALTER FUNCTION app.reward_senior_awards_for_post(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_senior_source_current(uuid,uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.reward_view_as_principal(uuid) SET search_path = pg_catalog, public, app, pg_temp;
--> statement-breakpoint
RESET ROLE;
