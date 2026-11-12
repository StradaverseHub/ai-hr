-- Board item fc804e8c (docs/adr/2026-11-12-rewards-limit-controls.md). DRAFT block 5500-5519; the integrator renumbers
-- at admission. Rewards Limit Controls: one append-only set of limits and thresholds per reward year, saved directly by
-- Group Rewards with a reason (board 60f1fdcd retired the second-person confirmation), viewed by CTRO and EC, hidden
-- from every other role. Draft reviews use the year's current version; a review takes the version it was checked with
-- when it is submitted and keeps it until Group Rewards explicitly re-applies a newer one.
--
-- Only new owner objects are created; no purpose-owned object is replaced (docs/SCALE-AND-RELEASE-RULES.md rule 9).
-- Financial invariants (no salary reduction, separate pools, round-down payout, exemptions relax budget caps only)
-- are not configurable: a version can never carry them (CHECK below).
--
-- Rollback (manual, only if never relied upon): DROP the functions created below, then the tables
-- reward_unit_limit_pin and reward_limit_version. Reviews then calculate on the baseline again.

CREATE TABLE public.reward_limit_version(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 year integer NOT NULL CHECK(year BETWEEN 2000 AND 2200),
 revision integer NOT NULL CHECK(revision>=1),
 limit_values jsonb NOT NULL CHECK(jsonb_typeof(limit_values)='object' AND octet_length(limit_values::text)<=20000
  AND NOT (limit_values ?| ARRAY['salary.noReduction','pool.separate','bonus.rounding','exemption.budgetCapsOnly'])),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 4000),
 created_by uuid NOT NULL REFERENCES public.app_user(id),
 created_by_person_id uuid REFERENCES public.person(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,year,revision),
 UNIQUE(tenant_id,id)
);
CREATE INDEX reward_limit_version_current ON public.reward_limit_version(tenant_id,year,revision DESC);
--> statement-breakpoint

-- Identity stamping and immutability. The saver is always the current principal and their PERSON.
CREATE FUNCTION app.reward_limit_version_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor_person uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Limit Controls versions are immutable; save a new version' USING ERRCODE='42501'; END IF;
 IF app.current_user_id() IS NULL OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'Limit Controls writer required' USING ERRCODE='42501'; END IF;
 SELECT person_id INTO actor_person FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=NEW.tenant_id AND archived_at IS NULL;
 NEW.created_by:=app.current_user_id();NEW.created_by_person_id:=actor_person;NEW.created_at:=transaction_timestamp();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_limit_version_guard() FROM PUBLIC;
CREATE TRIGGER reward_limit_version_guard BEFORE INSERT OR UPDATE OR DELETE ON public.reward_limit_version FOR EACH ROW EXECUTE FUNCTION app.reward_limit_version_guard();
--> statement-breakpoint

-- The version a review past Draft keeps. NULL means the baseline (the behaviour before Limit Controls).
CREATE TABLE public.reward_unit_limit_pin(
 unit_id uuid PRIMARY KEY REFERENCES public.reward_unit(id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 limit_version_id uuid,
 source text NOT NULL CHECK(source IN('submitted','reapplied')),
 pinned_by uuid NOT NULL REFERENCES public.app_user(id),
 pinned_at timestamptz NOT NULL DEFAULT now(),
 reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 10 AND 4000),
 FOREIGN KEY(tenant_id,limit_version_id) REFERENCES public.reward_limit_version(tenant_id,id),
 CHECK(source<>'reapplied' OR reason IS NOT NULL AND limit_version_id IS NOT NULL)
);
CREATE INDEX reward_unit_limit_pin_version ON public.reward_unit_limit_pin(tenant_id,limit_version_id);
--> statement-breakpoint

-- Who may see Limit Controls: 'edit' for whole-group Group Rewards configuration authority, 'view' for CTRO and EC
-- (and unit-level Group Rewards seats), NULL for everyone else. A View-as session sees what the viewed person sees.
CREATE FUNCTION app.reward_limit_controls_access() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT CASE
  WHEN app.current_user_id() IS NULL OR NOT coalesce(app.reward_not_viewing_as(),false) THEN NULL
  WHEN app.reward_setup_allowed(NULL,'manage') THEN 'edit'
  WHEN app.reward_setup_allowed(NULL,'library_view') OR app.reward_actor_holds_role('ctro') OR app.reward_actor_holds_role('ec') OR app.reward_actor_holds_role('gr') THEN 'view'
 END;
$$;
REVOKE ALL ON FUNCTION app.reward_limit_controls_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_limit_controls_access() TO ai_hr_app;
--> statement-breakpoint

ALTER TABLE public.reward_limit_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_limit_version FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reward_unit_limit_pin ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_unit_limit_pin FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.reward_limit_version FROM PUBLIC,ai_hr_app;
REVOKE ALL ON public.reward_unit_limit_pin FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON public.reward_limit_version TO ai_hr_app;
GRANT SELECT ON public.reward_unit_limit_pin TO ai_hr_app;
CREATE POLICY reward_limit_version_read ON public.reward_limit_version FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.reward_limit_controls_access() IS NOT NULL);
CREATE POLICY reward_limit_version_insert ON public.reward_limit_version FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_limit_controls_access()='edit');
CREATE POLICY reward_limit_version_owner ON public.reward_limit_version TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
CREATE POLICY reward_unit_limit_pin_read ON public.reward_unit_limit_pin FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.reward_limit_controls_access() IS NOT NULL);
CREATE POLICY reward_unit_limit_pin_owner ON public.reward_unit_limit_pin TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint

-- The limits a review calculates with, for anyone who can read the review (the review row's own row security is the
-- authorization). Only the calculation reads the values; projections decide what each reader is shown.
-- mode: 'current' (Draft, or not an annual review) = the year's newest version; 'pinned' = the version the review
-- keeps; 'legacy' = a review past Draft from before Limit Controls (baseline). version is NULL for the baseline.
CREATE FUNCTION app.reward_unit_limit_version(wanted_unit uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH u AS (
  SELECT r.id,r.tenant_id,r.status,r.kind,(r.policy->>'year')::integer AS year FROM public.reward_unit r
  WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL
   AND (EXISTS(SELECT 1 FROM app.reward_roles(r.id)) OR app.reward_admin(r.company_id) OR app.reward_setup_allowed(r.company_id,'library_view'))
 ), chosen AS (
  SELECT u.*,p.limit_version_id AS pinned_version,
   CASE WHEN u.status='draft' OR u.kind<>'annual' THEN 'current' WHEN p.unit_id IS NOT NULL THEN 'pinned' ELSE 'legacy' END AS mode
  FROM u LEFT JOIN public.reward_unit_limit_pin p ON p.unit_id=u.id AND p.tenant_id=u.tenant_id
 )
 SELECT jsonb_build_object('mode',c.mode,'year',c.year,'version',(
  SELECT jsonb_build_object('id',v.id,'revision',v.revision,'year',v.year,'values',v.limit_values) FROM public.reward_limit_version v
  WHERE v.tenant_id=c.tenant_id AND (c.mode='current' AND v.year=c.year OR c.mode='pinned' AND v.id=c.pinned_version)
  ORDER BY v.revision DESC LIMIT 1))
 FROM chosen c;
$$;
REVOKE ALL ON FUNCTION app.reward_unit_limit_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_unit_limit_version(uuid) TO ai_hr_app;
--> statement-breakpoint

-- Submission keeps the version the review was checked with (or the baseline when the year has none). Called by the
-- submit command inside its transaction, before the review leaves Draft.
CREATE FUNCTION app.reward_limit_pin_on_submit(wanted_unit uuid,checked_version uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE u record;
BEGIN
 SELECT r.id,r.tenant_id,r.status,r.kind,(r.policy->>'year')::integer AS year INTO u FROM public.reward_unit r
  WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL;
 IF u.id IS NULL OR u.kind<>'annual' OR u.status<>'draft' OR app.current_user_id() IS NULL OR NOT EXISTS(SELECT 1 FROM app.reward_roles(u.id)) THEN
  RAISE EXCEPTION 'Only a Draft annual review being submitted keeps a Limit Controls version' USING ERRCODE='42501';
 END IF;
 IF checked_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.reward_limit_version v WHERE v.id=checked_version AND v.tenant_id=u.tenant_id AND v.year=u.year) THEN
  RAISE EXCEPTION 'The Limit Controls version does not belong to this reward year' USING ERRCODE='42501';
 END IF;
 IF checked_version IS NULL AND EXISTS(SELECT 1 FROM public.reward_limit_version v WHERE v.tenant_id=u.tenant_id AND v.year=u.year) THEN
  RAISE EXCEPTION 'Limit Controls changed. Review the checks again.' USING ERRCODE='40001';
 END IF;
 INSERT INTO public.reward_unit_limit_pin(unit_id,tenant_id,limit_version_id,source,pinned_by,reason)
  VALUES(u.id,u.tenant_id,checked_version,'submitted',app.current_user_id(),NULL)
  ON CONFLICT(unit_id) DO UPDATE SET limit_version_id=excluded.limit_version_id,source='submitted',pinned_by=excluded.pinned_by,pinned_at=now(),reason=NULL;
END $$;
REVOKE ALL ON FUNCTION app.reward_limit_pin_on_submit(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_limit_pin_on_submit(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint

-- Explicit re-application of the year's current version to reviews that are in the approval route. Group Rewards
-- (whole-group configuration authority) only, with a reason; every selected review must still qualify, otherwise
-- nothing changes. Returns the re-applied reviews; the command rechecks them and tells their current approvers.
CREATE FUNCTION app.reward_limit_reapply(wanted_units uuid[],wanted_version uuid,wanted_reason text) RETURNS SETOF uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();v record;wanted integer;qualifying integer;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL OR app.reward_limit_controls_access() IS DISTINCT FROM 'edit' THEN
  RAISE EXCEPTION 'Group Rewards Limit Controls authority required' USING ERRCODE='42501';
 END IF;
 IF wanted_reason IS NULL OR length(btrim(wanted_reason)) NOT BETWEEN 10 AND 4000 THEN RAISE EXCEPTION 'Give a reason of at least 10 characters.' USING ERRCODE='22023'; END IF;
 SELECT x.id,x.year,x.revision INTO v FROM public.reward_limit_version x WHERE x.id=wanted_version AND x.tenant_id=t;
 IF v.id IS NULL OR v.revision<>(SELECT max(revision) FROM public.reward_limit_version w WHERE w.tenant_id=t AND w.year=v.year) THEN
  RAISE EXCEPTION 'Limit Controls changed. Review the summary again.' USING ERRCODE='40001';
 END IF;
 SELECT count(DISTINCT x) INTO wanted FROM unnest(coalesce(wanted_units,'{}')) x;
 IF wanted=0 OR wanted>200 THEN RAISE EXCEPTION 'Choose between 1 and 200 reviews.' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO qualifying FROM public.reward_unit u
  WHERE u.tenant_id=t AND u.id=ANY(wanted_units) AND u.deleted_at IS NULL AND u.kind='annual' AND u.status IN('bg','gr','ctro','ec') AND (u.policy->>'year')::integer=v.year;
 IF qualifying<>wanted THEN RAISE EXCEPTION 'This selection changed. Review the summary again.' USING ERRCODE='40001'; END IF;
 RETURN QUERY
 WITH applied AS (
  INSERT INTO public.reward_unit_limit_pin(unit_id,tenant_id,limit_version_id,source,pinned_by,reason)
   SELECT DISTINCT u.id,t,v.id,'reapplied',app.current_user_id(),btrim(wanted_reason) FROM public.reward_unit u WHERE u.tenant_id=t AND u.id=ANY(wanted_units)
   ON CONFLICT(unit_id) DO UPDATE SET limit_version_id=excluded.limit_version_id,source='reapplied',pinned_by=excluded.pinned_by,pinned_at=now(),reason=excluded.reason
   RETURNING public.reward_unit_limit_pin.unit_id)
 SELECT applied.unit_id FROM applied;
END $$;
REVOKE ALL ON FUNCTION app.reward_limit_reapply(uuid[],uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_limit_reapply(uuid[],uuid,text) TO ai_hr_app;
