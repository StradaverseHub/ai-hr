-- ADR-0170 step 5 (§3.5 recommenders, §3.10 rule 7, §3.13 one registry, §11.3 changes 5 and 6): per-tenant
-- worker switches, revocation by the grantor's manager where tenant policy allows, and the daily digest as a
-- work-job type. Provisional DEVELOPMENT source allocation 0895 / when1793330000295 (docs/MIGRATION-
-- ALLOCATION.md); it grants no installation, and the journal position is re-frozen at integration.
--
-- Nothing here is read by the production Assistant. The new table is tenant-isolated by RLS and carries
-- explicit grants, with every privilege it must not have revoked.
--
-- 1. Worker switches for the registered workers that have no existing switch of their own (approver
--    recommendations and on-demand explainers). Existing workers keep their existing switches (tenant
--    settings, job-type enablement); this table never duplicates one. No row, or enabled=false, means off.
--    The list is closed here as well as in code (core/agent-registry/workers.ts).
CREATE TABLE public.teras_worker_control (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 worker_id text NOT NULL CHECK (worker_id IN ('approver_recommendation','explainers')),
 enabled boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 changed_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,worker_id)
);
--> statement-breakpoint
CREATE TRIGGER teras_worker_control_version BEFORE UPDATE ON public.teras_worker_control
 FOR EACH ROW EXECUTE FUNCTION app.teras_bump_version('version');
--> statement-breakpoint
ALTER TABLE public.teras_worker_control ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY teras_worker_control_read ON public.teras_worker_control FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY teras_worker_control_admin_insert ON public.teras_worker_control FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.is_group_admin()
  AND app.principal_snapshot_current() IS TRUE AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_worker_control_admin_update ON public.teras_worker_control FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.is_group_admin() AND app.principal_snapshot_current() IS TRUE)
 WITH CHECK (tenant_id=app.current_tenant_id() AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
REVOKE ALL ON public.teras_worker_control FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.teras_worker_control TO ai_hr_app;
--> statement-breakpoint
-- 2. The daily digest is a Preparer (§3.13): a work-job mandate a person grants for themself. The closed
--    job-type list gains it in both tables; still nothing is enabled until an administrator turns key 1 on.
ALTER TABLE public.teras_mandate_job_type_enablement DROP CONSTRAINT teras_mandate_job_type_enablement_job_type_check;
--> statement-breakpoint
ALTER TABLE public.teras_mandate_job_type_enablement ADD CONSTRAINT teras_mandate_job_type_enablement_job_type_check
 CHECK (job_type IN ('team_absence_weekly_summary','daily_digest'));
--> statement-breakpoint
ALTER TABLE public.teras_mandate DROP CONSTRAINT teras_mandate_job_type_check;
--> statement-breakpoint
ALTER TABLE public.teras_mandate ADD CONSTRAINT teras_mandate_job_type_check
 CHECK (job_type IN ('team_absence_weekly_summary','daily_digest'));
--> statement-breakpoint
-- 3. Revocation by the grantor's manager (§3.10 rule 7), only where the tenant's policy allows it. The policy
--    lives on the existing tenant control row (one owner for tenant mandate policy); default: not allowed.
ALTER TABLE public.teras_mandate_control ADD COLUMN manager_may_revoke boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE public.teras_mandate DROP CONSTRAINT teras_mandate_revoked_by_check;
--> statement-breakpoint
ALTER TABLE public.teras_mandate ADD CONSTRAINT teras_mandate_revoked_by_check CHECK (revoked_by IN ('grantor','administrator','manager'));
--> statement-breakpoint
-- The grantor's manager: the caller holds a current administrative reporting line over one of the grantor's
-- active employments. Definer rights, because the caller's own RLS on reporting lines differs by role; it
-- returns only a boolean about the caller.
CREATE FUNCTION app.teras_is_grantor_manager(grantor_person uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND EXISTS (
  SELECT 1 FROM public.reporting_line rl
  JOIN public.employment sub ON sub.id=rl.subordinate_employment_id
  JOIN public.employment mgr ON mgr.id=rl.manager_employment_id
  WHERE sub.person_id=grantor_person AND sub.tenant_id=app.current_tenant_id() AND mgr.tenant_id=app.current_tenant_id()
   AND rl.line_type='administrative' AND rl.superseded_at IS NULL
   AND rl.valid_from<=current_date AND (rl.valid_to IS NULL OR rl.valid_to>current_date)
   AND sub.terminated_on IS NULL AND mgr.terminated_on IS NULL
   AND mgr.person_id<>grantor_person AND app.is_self_person(mgr.person_id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_is_grantor_manager(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_is_grantor_manager(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.teras_manager_may_revoke() RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM public.teras_mandate_control c WHERE c.tenant_id=app.current_tenant_id() AND c.manager_may_revoke)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_manager_may_revoke() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_manager_may_revoke() TO ai_hr_app;
--> statement-breakpoint
-- The 0890 guard, with one more revocation kind. Everything else is unchanged.
CREATE OR REPLACE FUNCTION app.teras_mandate_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'A mandate is revoked, never deleted' USING ERRCODE='42501';END IF;
 IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'A revoked mandate is final' USING ERRCODE='42501';END IF;
 IF (to_jsonb(NEW)-'version'-'valid_until'-'revoked_at'-'revoked_by_user_id'-'revoked_by')
   IS DISTINCT FROM (to_jsonb(OLD)-'version'-'valid_until'-'revoked_at'-'revoked_by_user_id'-'revoked_by') THEN
  RAISE EXCEPTION 'Only revocation and renewal change a mandate' USING ERRCODE='42501';
 END IF;
 IF NEW.revoked_at IS NOT NULL THEN
  IF NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN RAISE EXCEPTION 'Revocation cannot also renew' USING ERRCODE='42501';END IF;
  -- Owner connections carry no login; a login revokes only as itself.
  IF app.current_user_id() IS NOT NULL AND NEW.revoked_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'Revocation is attributed to the caller' USING ERRCODE='42501';END IF;
  IF NEW.revoked_by='grantor' AND NEW.revoked_by_user_id IS DISTINCT FROM OLD.grantor_user_id THEN
   RAISE EXCEPTION 'Only the grantor revokes as grantor' USING ERRCODE='42501';END IF;
  IF NEW.revoked_by='administrator' AND app.current_user_id() IS NOT NULL AND app.is_group_admin() IS NOT TRUE THEN
   RAISE EXCEPTION 'Only an administrator revokes as administrator' USING ERRCODE='42501';END IF;
  IF NEW.revoked_by='manager' AND (app.current_user_id() IS NULL OR app.teras_manager_may_revoke() IS NOT TRUE
    OR app.teras_is_grantor_manager(OLD.grantor_person_id) IS NOT TRUE) THEN
   RAISE EXCEPTION 'Only the grantor''s manager revokes as manager, where tenant policy allows' USING ERRCODE='42501';END IF;
 ELSIF NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
  IF app.current_user_id() IS NOT NULL AND app.current_user_id() IS DISTINCT FROM OLD.grantor_user_id THEN
   RAISE EXCEPTION 'Only the grantor renews a mandate' USING ERRCODE='42501';END IF;
  -- The hard ceiling; the tenant's own ceiling (enablement.max_validity_days) is enforced in code.
  IF OLD.valid_until<=now() OR NEW.valid_until<=now() OR NEW.valid_until>now()+interval '365 days' THEN
   RAISE EXCEPTION 'A mandate renews only while valid, for at most a year' USING ERRCODE='42501';END IF;
 ELSE
  RETURN OLD;
 END IF;
 NEW.version:=OLD.version+1;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- The manager reads and revokes the grantor's mandates only while the tenant policy allows it. Renewal stays
-- the grantor's alone (guard above); the policies only add who may see and revoke.
CREATE POLICY teras_mandate_manager_read ON public.teras_mandate FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.teras_manager_may_revoke() IS TRUE AND app.teras_is_grantor_manager(grantor_person_id) IS TRUE);
--> statement-breakpoint
CREATE POLICY teras_mandate_manager_revoke ON public.teras_mandate FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.teras_manager_may_revoke() IS TRUE AND app.teras_is_grantor_manager(grantor_person_id) IS TRUE)
 WITH CHECK (tenant_id=app.current_tenant_id() AND revoked_by='manager');
