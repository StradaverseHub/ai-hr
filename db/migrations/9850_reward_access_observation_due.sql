-- UNALLOCATED DRAFT (Home round trips, 10 November 2026). Final tag, idx and when are assigned at integration.
-- Read-only probe for the native Rewards access observation (0681 app.reward_access_observe). The observation
-- WRITE stays the only writer, keeps its separate committed transaction before the Rewards presentation, and keeps
-- every rule. This answers exactly whether that write would record anything for the current login: the same members
-- (the login's reward admin companies and its own memberships, live units only), the same state owner and the same
-- (tenant, member, state key) identity the write's ON CONFLICT DO NOTHING checks. A caller runs the write only when
-- this is true, so a login with nothing newly suspended no longer pays a write transaction on every read.
CREATE FUNCTION app.reward_access_observation_due(wanted_unit uuid DEFAULT NULL) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $due$
DECLARE m public.reward_member;state jsonb;
BEGIN
 FOR m IN SELECT x.* FROM public.reward_member x JOIN public.reward_unit r ON r.id=x.unit_id AND r.tenant_id=x.tenant_id
 WHERE x.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL AND (wanted_unit IS NULL OR r.id=wanted_unit)
 AND (app.reward_admin(r.company_id) OR EXISTS(SELECT 1 FROM public.reward_member own WHERE own.unit_id=r.id AND own.tenant_id=r.tenant_id AND own.user_id=app.current_user_id())) LOOP
  state:=app.reward_member_state(m.id);
  IF state IS NOT NULL AND state->>'reason' IN('login','notice','assignment') AND NOT EXISTS(
   SELECT 1 FROM public.reward_access_observation o WHERE o.tenant_id=m.tenant_id AND o.member_id=m.id
    AND o.state_key=state::text||':'||COALESCE(m.restored_fingerprint,'initial')) THEN
   RETURN true;
  END IF;
 END LOOP;
 RETURN false;
END $due$;
REVOKE ALL ON FUNCTION app.reward_access_observation_due(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_observation_due(uuid) TO ai_hr_app;
