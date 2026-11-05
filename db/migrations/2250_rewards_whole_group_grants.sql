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
