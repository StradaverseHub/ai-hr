-- Explicit review-role grants. Setup grants and individual review seats remain separate.
CREATE TABLE public.reward_group_role_grant (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  user_id uuid NOT NULL REFERENCES public.app_user(id),
  role text NOT NULL CHECK (role IN ('gr', 'ctro', 'ec')),
  active boolean NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (tenant_id, user_id, role)
);
ALTER TABLE public.reward_group_role_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_group_role_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_group_role_owner ON public.reward_group_role_grant TO ai_hr_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON public.reward_group_role_grant FROM PUBLIC, ai_hr_app;
--> statement-breakpoint

-- A grant alone cannot override current login or People eligibility. Only the owner
-- can ask about another person; the caller-facing function below is self-only.
CREATE FUNCTION app.reward_group_person_eligible(wanted_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_user u
    CROSS JOIN (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today) d
    WHERE u.id = wanted_user AND u.tenant_id = app.current_tenant_id()
      AND u.person_id IS NOT NULL AND u.archived_at IS NULL
      AND NOT app.login_blocked_on(u.id, d.today)
      AND EXISTS (
        SELECT 1 FROM public.employment e
        WHERE e.tenant_id = u.tenant_id AND e.person_id = u.person_id
          AND e.hired_on <= d.today AND e.blacklisted_at IS NULL
          AND (least(e.resignation_date, e.last_working_date, e.terminated_on) IS NULL
               OR d.today <= least(e.resignation_date, e.last_working_date, e.terminated_on))
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.employment e
        WHERE e.tenant_id = u.tenant_id AND e.person_id = u.person_id
          AND e.tender_resignation_date <= d.today
          AND (least(e.resignation_date, e.last_working_date, e.terminated_on) IS NULL
               OR d.today <= least(e.resignation_date, e.last_working_date, e.terminated_on))
      )
  );
$$;
REVOKE ALL ON FUNCTION app.reward_group_person_eligible(uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint

CREATE FUNCTION app.reward_current_group_roles() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT g.role FROM public.reward_group_role_grant g
  WHERE g.tenant_id = app.current_tenant_id() AND g.user_id = app.current_user_id()
    AND g.active AND app.principal_snapshot_current()
    AND app.reward_not_viewing_as() AND app.reward_group_person_eligible(g.user_id);
$$;
REVOKE ALL ON FUNCTION app.reward_current_group_roles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_current_group_roles() TO ai_hr_app;
--> statement-breakpoint

-- Keep the grant and its audit event in the same transaction. Expected revision zero
-- means no existing grant. A concurrent edit must be reviewed before retrying.
CREATE FUNCTION app.reward_save_group_role(
  wanted_user uuid, wanted_role text, wanted_active boolean, expected_revision integer, reason text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  tenant uuid := app.current_tenant_id();
  actor uuid := app.current_user_id();
  previous public.reward_group_role_grant;
  new_revision integer;
  explanation text := btrim(reason);
BEGIN
  IF tenant IS NULL OR actor IS NULL OR NOT coalesce(app.principal_snapshot_current(), false)
     OR NOT coalesce(app.is_group_admin(), false) OR NOT coalesce(app.reward_not_viewing_as(), false)
     OR wanted_user = actor THEN
    RAISE EXCEPTION 'An independent group administrator is required' USING ERRCODE = '42501';
  END IF;
  IF wanted_user IS NULL OR wanted_role IS NULL OR wanted_role NOT IN ('gr', 'ctro', 'ec')
     OR wanted_active IS NULL OR expected_revision IS NULL OR expected_revision < 0
     OR explanation IS NULL OR char_length(explanation) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'Select a valid role and provide a reason' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text || ':' || wanted_user::text || ':' || wanted_role, 2250));
  SELECT * INTO previous FROM public.reward_group_role_grant
    WHERE tenant_id = tenant AND user_id = wanted_user AND role = wanted_role FOR UPDATE;

  IF coalesce(previous.revision, 0) <> expected_revision THEN
    RAISE EXCEPTION 'This Rewards grant changed. Reload before saving.' USING ERRCODE = '40001';
  END IF;
  IF wanted_active AND NOT app.reward_group_person_eligible(wanted_user) THEN
    RAISE EXCEPTION 'Select an eligible employee in this group' USING ERRCODE = '22023';
  END IF;
  IF coalesce(previous.active, false) = wanted_active THEN RETURN expected_revision; END IF;

  new_revision := expected_revision + 1;
  INSERT INTO public.reward_group_role_grant (tenant_id, user_id, role, active, revision)
    VALUES (tenant, wanted_user, wanted_role, wanted_active, new_revision)
    ON CONFLICT (tenant_id, user_id, role) DO UPDATE
      SET active = excluded.active, revision = excluded.revision;
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
    VALUES (tenant, 'reward-access', wanted_user, 'reward-access.whole-group-role.changed', 'user', actor,
      jsonb_build_object('role', wanted_role, 'before', previous.active, 'after', wanted_active,
                         'revision', new_revision, 'reason', explanation));
  RETURN new_revision;
END;
$$;
REVOKE ALL ON FUNCTION app.reward_save_group_role(uuid, text, boolean, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_save_group_role(uuid, text, boolean, integer, text) TO ai_hr_app;
--> statement-breakpoint

CREATE FUNCTION app.reward_group_role_directory()
RETURNS TABLE(user_id uuid, name text, role text, active boolean, eligible boolean, revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT g.user_id, p.full_name, g.role, g.active,
         app.reward_group_person_eligible(g.user_id), g.revision
  FROM public.reward_group_role_grant g
  JOIN public.app_user u ON u.id = g.user_id AND u.tenant_id = g.tenant_id
  JOIN public.person p ON p.id = u.person_id AND p.tenant_id = g.tenant_id
  WHERE g.tenant_id = app.current_tenant_id()
    AND app.principal_snapshot_current() AND app.is_group_admin() AND app.reward_not_viewing_as()
  ORDER BY p.full_name, g.user_id, g.role;
$$;
REVOKE ALL ON FUNCTION app.reward_group_role_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_group_role_directory() TO ai_hr_app;
--> statement-breakpoint

-- Native unit access resolves explicit group grants on demand, including units
-- added after a grant. Scoped review seats still have their own eligibility.
CREATE OR REPLACE FUNCTION app.reward_roles(wanted_unit uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT m.role
  FROM public.reward_member m
  JOIN public.reward_unit r ON r.id = m.unit_id AND r.tenant_id = m.tenant_id AND r.deleted_at IS NULL
  WHERE m.unit_id = wanted_unit AND m.tenant_id = app.current_tenant_id()
    AND m.user_id = app.current_user_id() AND app.reward_member_eligible_internal(m.id)
  UNION
  SELECT role FROM app.reward_current_group_roles()
  WHERE EXISTS (
    SELECT 1 FROM public.reward_unit r
    WHERE r.id = wanted_unit AND r.tenant_id = app.current_tenant_id() AND r.deleted_at IS NULL
  );
$$;
--> statement-breakpoint

-- Returning roles rather than identities avoids exposing the group role directory
-- to an ordinary reviewer checking coverage before a decision.
CREATE FUNCTION app.reward_group_coverage_roles(wanted_unit uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT DISTINCT g.role FROM public.reward_group_role_grant g
  WHERE g.tenant_id = app.current_tenant_id() AND g.active
    AND app.reward_access(wanted_unit) AND app.principal_snapshot_current()
    AND app.reward_group_person_eligible(g.user_id);
$$;
REVOKE ALL ON FUNCTION app.reward_group_coverage_roles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_group_coverage_roles(uuid) TO ai_hr_app;
--> statement-breakpoint

-- Group visibility does not open a new figures-edit window. Legacy scoped roles
-- retain their existing policy, while explicit group grants must match the step.
CREATE FUNCTION app.reward_group_figures_stage_allowed(wanted_unit uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.reward_unit r
    WHERE r.id = wanted_unit AND r.tenant_id = app.current_tenant_id() AND r.deleted_at IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM public.reward_member m
          WHERE m.tenant_id = r.tenant_id AND m.unit_id = r.id AND m.user_id = app.current_user_id()
            AND m.role NOT IN ('pbp', 'payroll') AND app.reward_member_eligible_internal(m.id)
        )
        OR r.status IN ('gr', 'ctro', 'ec') AND r.status IN (SELECT app.reward_current_group_roles())
      )
  );
$$;
REVOKE ALL ON FUNCTION app.reward_group_figures_stage_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_group_figures_stage_allowed(uuid) TO ai_hr_app;

CREATE POLICY reward_entry_group_stage_update ON public.reward_entry AS RESTRICTIVE FOR UPDATE TO ai_hr_app
USING (NOT EXISTS (SELECT 1 FROM app.reward_current_group_roles()) OR app.reward_group_figures_stage_allowed(unit_id))
WITH CHECK (NOT EXISTS (SELECT 1 FROM app.reward_current_group_roles()) OR app.reward_group_figures_stage_allowed(unit_id));
--> statement-breakpoint

-- Group Rewards may maintain setup. CTRO receives library view only, and
-- Executive Chairman receives no configuration authority from this grant.
GRANT EXECUTE ON FUNCTION app.reward_current_group_roles() TO ai_hr_reward_setup_reader;
CREATE OR REPLACE FUNCTION app.reward_setup_allowed(wanted_company uuid,wanted_operation text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT wanted_operation IN('library_view','manage')
 AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND (wanted_company IS NULL OR EXISTS(SELECT 1 FROM company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id()))
 AND (EXISTS(SELECT 1 FROM app.reward_current_group_roles() role
              WHERE role='gr' OR wanted_operation='library_view' AND role='ctro')
 OR EXISTS(SELECT 1 FROM reward_setup_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.user_id=app.current_user_id() AND g.active
  AND g.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND(g.valid_to IS NULL OR g.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)
  AND((wanted_company IS NULL AND g.company_id IS NULL) OR (wanted_company IS NOT NULL AND(g.company_id IS NULL OR g.company_id=wanted_company))) AND(g.role='gr' OR wanted_operation='library_view' AND g.role='ctro'))
 OR EXISTS(SELECT 1 FROM reward_unit u WHERE u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND wanted_company IS NOT NULL AND u.company_id=wanted_company
  AND EXISTS(SELECT 1 FROM app.reward_roles(u.id) r WHERE r='gr' OR wanted_operation='library_view' AND r='ctro')))
$$;
--> statement-breakpoint

-- A narrow catalogue keeps plan review separate from configuration authority.
CREATE POLICY reward_plan_whole_group_catalogue ON public.reward_plan_setup FOR SELECT TO ai_hr_owner
USING (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM app.reward_current_group_roles()));
CREATE FUNCTION app.reward_whole_group_plan_catalogue()
RETURNS TABLE(plan_id uuid, cycle_name text, year integer, snapshot_date date, state text, companies text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.version_id, r.cycle_name, r.year, r.snapshot_date, r.state,
    ARRAY(SELECT c.legal_name FROM public.company c
      WHERE c.tenant_id = r.tenant_id AND c.id = ANY(r.company_ids) ORDER BY c.legal_name, c.id)
  FROM public.reward_plan_setup r
  WHERE r.tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM app.reward_current_group_roles())
  ORDER BY r.year DESC, r.cycle_name, r.version_id;
$$;
REVOKE ALL ON FUNCTION app.reward_whole_group_plan_catalogue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_whole_group_plan_catalogue() TO ai_hr_app;
