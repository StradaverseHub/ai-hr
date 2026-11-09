-- Preserve the native writer and add the same current-person admission to direct
-- callers. The former entry point is executable only by its existing purpose owner.
ALTER FUNCTION app.reward_create_planned_unit(uuid, uuid, uuid)
  RENAME TO reward_create_planned_unit_bound;
REVOKE ALL ON FUNCTION app.reward_create_planned_unit_bound(uuid, uuid, uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_create_planned_unit(wanted_version uuid, wanted_company uuid, wanted_business_unit uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  tenant uuid := app.current_tenant_id();
  actor uuid := app.current_user_id();
  actor_person uuid;
  plan public.reward_plan_setup%ROWTYPE;
BEGIN
  IF tenant IS NULL OR actor IS NULL THEN
    RAISE EXCEPTION 'Group Rewards plan creation authority required' USING ERRCODE='42501';
  END IF;
  -- Use the same lock ordering as setupTenant, ahead of plan and company locks.
  PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:' || tenant::text, 0));
  IF NOT app.reward_setup_allowed(wanted_company, 'manage') THEN
    RAISE EXCEPTION 'Group Rewards plan creation authority required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO plan FROM public.reward_plan_setup
    WHERE tenant_id = tenant AND version_id = wanted_version AND state = 'approved';
  SELECT person_id INTO actor_person FROM public.app_user
    WHERE tenant_id = tenant AND id = actor AND archived_at IS NULL;
  IF plan.approved_by IS NULL OR plan.approved_by_person_id IS NULL
    OR actor_person IS NULL OR actor = plan.approved_by OR actor_person = plan.approved_by_person_id THEN
    RAISE EXCEPTION 'A different Group Rewards user must create reviews from this approved plan' USING ERRCODE='42501';
  END IF;
  RETURN app.reward_create_planned_unit_bound(wanted_version, wanted_company, wanted_business_unit);
END;
$$;
ALTER FUNCTION app.reward_create_planned_unit(uuid, uuid, uuid) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_create_planned_unit(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_create_planned_unit(uuid, uuid, uuid) TO ai_hr_app;
