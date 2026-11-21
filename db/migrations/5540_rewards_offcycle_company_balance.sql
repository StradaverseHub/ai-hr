-- Board item b945f0cc (docs/adr/2026-11-12-rewards-offcycle-company-balance.md). DRAFT block 5540-5559; the integrator
-- renumbers at admission. Off-cycle and mid-year recommendations, switched on once the year-end cycle closes.
--
-- 1. reward_offcycle_year: Group Rewards opens a reward cycle's off-cycle budget year (only once every annual review of
--    the cycle is posted: final EC approval and payroll hand-off) and sets the mid-year submission window.
-- 2. One off-cycle balance per company and cycle (superseding ADR-0099's separate Standard and JG H balances): the
--    company's posted annual reviews' frozen increment remainders, less the amounts held by requests in approval or
--    approved and the amounts consumed by posted requests. Each parent's frozen amount and each request's own reserved
--    amount count exactly once, so existing per-plan reservations reconcile without double counting.
-- 3. Off-cycle requests keep the Limit Controls version they were checked with (reward_unit_limit_pin).
-- 4. The change log gains the 'offcycle' area.
--
-- Only new owner objects are created and one owner-created CHECK constraint is widened; no purpose-owned object is
-- replaced (docs/SCALE-AND-RELEASE-RULES.md rule 9). app.reward_funding (0524) is kept for its existing callers.
--
-- Rollback (manual, only if never relied upon): DROP the functions created below and reward_offcycle_year, and narrow
-- the change-log area CHECK again once no 'offcycle' row exists. Off-cycle funding then reads app.reward_funding again.

CREATE TABLE public.reward_offcycle_year(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 cycle_id uuid NOT NULL,
 opened_by uuid NOT NULL REFERENCES public.app_user(id),
 opened_at timestamptz NOT NULL DEFAULT now(),
 midyear_from date,
 midyear_to date,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
 updated_by uuid NOT NULL REFERENCES public.app_user(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,cycle_id),
 FOREIGN KEY(tenant_id,cycle_id) REFERENCES public.reward_cycle(tenant_id,id),
 CHECK((midyear_from IS NULL)=(midyear_to IS NULL) AND (midyear_from IS NULL OR midyear_from<=midyear_to))
);
ALTER TABLE public.reward_offcycle_year ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_offcycle_year FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.reward_offcycle_year FROM PUBLIC,ai_hr_app;
-- Dates only (no pay): readable inside the tenant; written only through app.reward_offcycle_year_save below.
GRANT SELECT ON public.reward_offcycle_year TO ai_hr_app;
CREATE POLICY reward_offcycle_year_read ON public.reward_offcycle_year FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_offcycle_year_owner ON public.reward_offcycle_year TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint

-- The one writer. Group Rewards with whole-group configuration authority; opening needs every annual review of the cycle
-- (not cancelled, rejected or deleted) to be posted, and at least one. A later save changes the mid-year window only.
CREATE FUNCTION app.reward_offcycle_year_save(wanted_cycle uuid,expected_revision integer,wanted_from date,wanted_to date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();current_revision integer;open_reviews integer;posted_reviews integer;
BEGIN
 IF t IS NULL OR actor IS NULL OR NOT coalesce(app.reward_not_viewing_as(),false) OR NOT coalesce(app.reward_setup_allowed(NULL,'manage'),false) THEN
  RAISE EXCEPTION 'Group Rewards configuration authority required' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.reward_cycle c WHERE c.id=wanted_cycle AND c.tenant_id=t) THEN RAISE EXCEPTION 'Reward cycle not found' USING ERRCODE='42501'; END IF;
 IF (wanted_from IS NULL)<>(wanted_to IS NULL) OR wanted_from>wanted_to THEN RAISE EXCEPTION 'Enter both mid-year window dates, the start on or before the end.' USING ERRCODE='22023'; END IF;
 -- One writer at a time per cycle.
 PERFORM pg_advisory_xact_lock(hashtextextended('reward-offcycle-year:'||t::text||':'||wanted_cycle::text,0));
 SELECT revision INTO current_revision FROM public.reward_offcycle_year WHERE tenant_id=t AND cycle_id=wanted_cycle;
 IF coalesce(current_revision,0)<>expected_revision THEN RAISE EXCEPTION 'Off-cycle settings changed. Reload before saving.' USING ERRCODE='40001'; END IF;
 IF current_revision IS NULL THEN
  SELECT count(*) FILTER (WHERE u.status<>'posted'),count(*) FILTER (WHERE u.status='posted') INTO open_reviews,posted_reviews
   FROM public.reward_unit u WHERE u.tenant_id=t AND u.cycle_id=wanted_cycle AND u.kind='annual' AND u.deleted_at IS NULL AND u.status NOT IN('withdrawn','rejected');
  IF posted_reviews=0 OR open_reviews>0 THEN
   RAISE EXCEPTION 'Every year-end review must finish EC approval and the payroll hand-off before the off-cycle year opens.' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.reward_offcycle_year(tenant_id,cycle_id,opened_by,midyear_from,midyear_to,updated_by) VALUES(t,wanted_cycle,actor,wanted_from,wanted_to,actor);
  RETURN 1;
 END IF;
 UPDATE public.reward_offcycle_year SET midyear_from=wanted_from,midyear_to=wanted_to,revision=revision+1,updated_by=actor,updated_at=now()
  WHERE tenant_id=t AND cycle_id=wanted_cycle;
 RETURN current_revision+1;
END $$;
REVOKE ALL ON FUNCTION app.reward_offcycle_year_save(uuid,integer,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_offcycle_year_save(uuid,integer,date,date) TO ai_hr_app;
--> statement-breakpoint

-- Year-end review readiness for the open-year summary: aggregate counts only.
CREATE FUNCTION app.reward_offcycle_cycle_readiness(wanted_cycle uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.current_user_id() IS NULL OR NOT coalesce(app.reward_setup_allowed(NULL,'manage'),false) THEN NULL ELSE jsonb_build_object(
  'posted',count(*) FILTER (WHERE u.status='posted'),'open',count(*) FILTER (WHERE u.status<>'posted'),
  'companies',count(DISTINCT u.company_id) FILTER (WHERE u.status='posted')) END
 FROM public.reward_unit u WHERE u.tenant_id=app.current_tenant_id() AND u.cycle_id=wanted_cycle AND u.kind='annual' AND u.deleted_at IS NULL AND u.status NOT IN('withdrawn','rejected');
$$;
REVOKE ALL ON FUNCTION app.reward_offcycle_cycle_readiness(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_offcycle_cycle_readiness(uuid) TO ai_hr_app;
--> statement-breakpoint

-- Company balances of one cycle, one set-based statement. A company is returned when the reader holds a Rewards seat
-- on one of its posted annual reviews of the cycle, or whole-group configuration authority. Aggregates only: no
-- request, person or pay line leaves this function.
CREATE FUNCTION app.reward_offcycle_balances(wanted_cycle uuid) RETURNS TABLE(company_id uuid,frozen_cents bigint,held_cents bigint,consumed_cents bigint,available_cents bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH parent AS (
  SELECT p.id,p.company_id,(p.funding_cents->>'standard')::bigint+(p.funding_cents->>'h')::bigint AS frozen FROM public.reward_unit p
  WHERE p.tenant_id=app.current_tenant_id() AND p.cycle_id=wanted_cycle AND p.kind='annual' AND p.status='posted' AND p.deleted_at IS NULL
 ), whole AS (SELECT coalesce(app.reward_setup_allowed(NULL,'manage'),false) AS allowed), visible AS (
  SELECT DISTINCT p.company_id FROM parent p,whole w
  WHERE app.current_user_id() IS NOT NULL AND (w.allowed OR EXISTS(SELECT 1 FROM app.reward_roles(p.id) r WHERE r IN('bu','bg','gr','ctro','ec')))
 ), funded AS (SELECT p.company_id,sum(p.frozen)::bigint AS frozen FROM parent p GROUP BY p.company_id
 ), used AS (
  SELECT c.company_id,
   coalesce(sum((c.reserved_cents->>'standard')::bigint+(c.reserved_cents->>'h')::bigint) FILTER (WHERE c.status IN('bg','gr','ctro','ec','approved')),0)::bigint AS held,
   coalesce(sum((c.reserved_cents->>'standard')::bigint+(c.reserved_cents->>'h')::bigint) FILTER (WHERE c.status='posted'),0)::bigint AS consumed
  FROM public.reward_unit c JOIN parent p ON p.id=c.parent_unit_id
  WHERE c.tenant_id=app.current_tenant_id() AND c.kind<>'annual' AND c.deleted_at IS NULL GROUP BY c.company_id
 )
 SELECT v.company_id,f.frozen,coalesce(u.held,0),coalesce(u.consumed,0),greatest(0,f.frozen-coalesce(u.held,0)-coalesce(u.consumed,0))
 FROM visible v JOIN funded f ON f.company_id=v.company_id LEFT JOIN used u ON u.company_id=v.company_id
 ORDER BY v.company_id;
$$;
REVOKE ALL ON FUNCTION app.reward_offcycle_balances(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_offcycle_balances(uuid) TO ai_hr_app;
--> statement-breakpoint

-- The company balance one request is checked against. With lock_parents, every posted annual review of the company and
-- cycle is locked in id order, which serializes all submissions, approvals and cancellations against that balance.
-- Returns aggregates and a duplicate-open-request boolean only, never a sibling request's people or pay.
CREATE FUNCTION app.reward_offcycle_company_funding(wanted_unit uuid,lock_parents boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE child public.reward_unit;frozen bigint;committed bigint;duplicate_open boolean;
BEGIN
 SELECT * INTO child FROM public.reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id();
 IF child.id IS NULL OR NOT EXISTS(SELECT 1 FROM app.reward_roles(child.id)) THEN RAISE EXCEPTION 'Reward funding access denied' USING ERRCODE='42501'; END IF;
 IF child.parent_unit_id IS NULL THEN RETURN jsonb_build_object('frozen',0,'committed',0,'available',0,'duplicate',false); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.reward_unit p WHERE p.id=child.parent_unit_id AND p.tenant_id=child.tenant_id AND p.kind='annual' AND p.status='posted'
  AND p.company_id=child.company_id AND p.cycle_id=child.cycle_id AND p.deleted_at IS NULL) THEN RAISE EXCEPTION 'Invalid annual funding source'; END IF;
 IF lock_parents THEN
  PERFORM 1 FROM public.reward_unit p WHERE p.tenant_id=child.tenant_id AND p.cycle_id=child.cycle_id AND p.company_id=child.company_id
   AND p.kind='annual' AND p.status='posted' AND p.deleted_at IS NULL ORDER BY p.id FOR UPDATE;
 END IF;
 SELECT coalesce(sum((p.funding_cents->>'standard')::bigint+(p.funding_cents->>'h')::bigint),0) INTO frozen FROM public.reward_unit p
  WHERE p.tenant_id=child.tenant_id AND p.cycle_id=child.cycle_id AND p.company_id=child.company_id AND p.kind='annual' AND p.status='posted' AND p.deleted_at IS NULL;
 SELECT coalesce(sum((c.reserved_cents->>'standard')::bigint+(c.reserved_cents->>'h')::bigint),0) INTO committed
  FROM public.reward_unit c JOIN public.reward_unit p ON p.id=c.parent_unit_id AND p.tenant_id=c.tenant_id
  WHERE c.tenant_id=child.tenant_id AND c.id<>child.id AND c.kind<>'annual' AND c.deleted_at IS NULL AND c.status IN('bg','gr','ctro','ec','approved','posted')
   AND p.cycle_id=child.cycle_id AND p.company_id=child.company_id AND p.kind='annual' AND p.status='posted' AND p.deleted_at IS NULL;
 SELECT EXISTS(SELECT 1 FROM public.reward_entry own_entry JOIN public.reward_entry other_entry ON other_entry.employment_id=own_entry.employment_id AND other_entry.tenant_id=own_entry.tenant_id
  JOIN public.reward_unit other_unit ON other_unit.id=other_entry.unit_id AND other_unit.tenant_id=other_entry.tenant_id
  JOIN public.reward_unit p ON p.id=other_unit.parent_unit_id AND p.tenant_id=other_unit.tenant_id
  WHERE own_entry.unit_id=child.id AND own_entry.tenant_id=child.tenant_id AND other_unit.id<>child.id AND other_unit.deleted_at IS NULL
   AND other_unit.status IN('bg','gr','ctro','ec','approved') AND p.cycle_id=child.cycle_id AND p.company_id=child.company_id) INTO duplicate_open;
 RETURN jsonb_build_object('frozen',frozen,'committed',committed,'available',greatest(0,frozen-committed),'duplicate',duplicate_open);
END $$;
REVOKE ALL ON FUNCTION app.reward_offcycle_company_funding(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_offcycle_company_funding(uuid,boolean) TO ai_hr_app;
--> statement-breakpoint

-- The Limit Controls an off-cycle request calculates with: a Draft request uses its reward year's current version; a
-- request past Draft keeps the version it was submitted with ('pinned'), or the baseline when it was submitted before
-- this change ('legacy'). Authorized by the request's own seats. version is NULL for the baseline.
CREATE FUNCTION app.reward_offcycle_limit_version(wanted_unit uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH u AS (
  SELECT r.id,r.tenant_id,r.status,(r.policy->>'year')::integer AS year FROM public.reward_unit r
  WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL AND r.kind<>'annual' AND EXISTS(SELECT 1 FROM app.reward_roles(r.id))
 ), chosen AS (
  SELECT u.*,p.limit_version_id AS pinned_version,CASE WHEN u.status='draft' THEN 'current' WHEN p.unit_id IS NOT NULL THEN 'pinned' ELSE 'legacy' END AS mode
  FROM u LEFT JOIN public.reward_unit_limit_pin p ON p.unit_id=u.id AND p.tenant_id=u.tenant_id
 )
 SELECT jsonb_build_object('mode',c.mode,'year',c.year,'version',(
  SELECT jsonb_build_object('id',v.id,'revision',v.revision,'year',v.year,'values',v.limit_values) FROM public.reward_limit_version v
  WHERE v.tenant_id=c.tenant_id AND (c.mode='current' AND v.year=c.year OR c.mode='pinned' AND v.id=c.pinned_version)
  ORDER BY v.revision DESC LIMIT 1))
 FROM chosen c;
$$;
REVOKE ALL ON FUNCTION app.reward_offcycle_limit_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_offcycle_limit_version(uuid) TO ai_hr_app;
--> statement-breakpoint

-- Submission of an off-cycle request keeps the version it was checked with (or the baseline when its year has none).
CREATE FUNCTION app.reward_offcycle_limit_pin(wanted_unit uuid,checked_version uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE u record;
BEGIN
 SELECT r.id,r.tenant_id,r.status,r.kind,(r.policy->>'year')::integer AS year INTO u FROM public.reward_unit r
  WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL;
 IF u.id IS NULL OR u.kind='annual' OR u.status<>'draft' OR app.current_user_id() IS NULL OR NOT EXISTS(SELECT 1 FROM app.reward_roles(u.id)) THEN
  RAISE EXCEPTION 'Only a Draft off-cycle request being submitted keeps a Limit Controls version' USING ERRCODE='42501';
 END IF;
 IF checked_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.reward_limit_version v WHERE v.id=checked_version AND v.tenant_id=u.tenant_id AND v.year=u.year) THEN
  RAISE EXCEPTION 'The Limit Controls version does not belong to this reward year' USING ERRCODE='42501';
 END IF;
 IF checked_version IS NULL AND EXISTS(SELECT 1 FROM public.reward_limit_version v WHERE v.tenant_id=u.tenant_id AND v.year=u.year) THEN
  RAISE EXCEPTION 'Limit Controls changed. Review the checks again.' USING ERRCODE='40001';
 END IF;
 IF checked_version IS NOT NULL AND checked_version<>(SELECT v.id FROM public.reward_limit_version v WHERE v.tenant_id=u.tenant_id AND v.year=u.year ORDER BY v.revision DESC LIMIT 1) THEN
  RAISE EXCEPTION 'Limit Controls changed. Review the checks again.' USING ERRCODE='40001';
 END IF;
 INSERT INTO public.reward_unit_limit_pin(unit_id,tenant_id,limit_version_id,source,pinned_by,reason)
  VALUES(u.id,u.tenant_id,checked_version,'submitted',app.current_user_id(),NULL)
  ON CONFLICT(unit_id) DO UPDATE SET limit_version_id=excluded.limit_version_id,source='submitted',pinned_by=excluded.pinned_by,pinned_at=now(),reason=NULL;
END $$;
REVOKE ALL ON FUNCTION app.reward_offcycle_limit_pin(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_offcycle_limit_pin(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint

ALTER TABLE public.reward_config_change DROP CONSTRAINT reward_config_change_area_check;
ALTER TABLE public.reward_config_change ADD CONSTRAINT reward_config_change_area_check
 CHECK(area IN('salary','bonus','pat','plan','shared','exemption','senior','upload','preparation','access','role_permission','group_role','limit','offcycle'));
