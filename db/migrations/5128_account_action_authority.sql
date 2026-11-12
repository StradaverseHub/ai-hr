-- Security Center account ACTIONS require strictly higher authority than the target (ADR-0117 note, 10 Nov 2026).
-- 2106's account_management_subject stays the read admission (summary, directory, history) and is reused
-- unchanged, so every tenant, current-principal, serialization and full company-scope proof still runs.
-- On top of it an action is refused when the target is the actor, when the target's highest role ranks the
-- same as or above the actor's (super_admin 3, tenant-wide hr_admin 2, company hr_admin 1, others 0), and
-- an authenticator pause is never admitted for a target holding hr_admin or super_admin at any scope.
-- Actor rank comes from the session grants that principal_snapshot_current() has just proved; target rank
-- reads every role_assignment row while 2106's access-configuration lock is held, so grants cannot race it.
CREATE FUNCTION app.account_actions_admitted(p_user uuid,p_issuer text) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s text; actor uuid:=app.current_user_id(); actor_rank int; target_rank int;
 all_actions constant text[]:=ARRAY['suspend','reactivate','expiry','temporary-password','recovery-exemption','recovery-exemption-cancel','reset-email'];
BEGIN
 s:=app.account_management_subject(p_user,p_issuer);
 IF s IS NULL OR actor IS NULL OR p_user=actor THEN RETURN ARRAY[]::text[]; END IF;
 SELECT coalesce(max(CASE WHEN g.role='super_admin' THEN 3 WHEN g.role='hr_admin' AND g.company_id IS NULL THEN 2
   WHEN g.role='hr_admin' THEN 1 ELSE 0 END),0) INTO actor_rank FROM app.current_grants() g;
 SELECT coalesce(max(CASE WHEN r.role='super_admin' THEN 3 WHEN r.role='hr_admin' AND r.company_id IS NULL THEN 2
   WHEN r.role='hr_admin' THEN 1 ELSE 0 END),0) INTO target_rank
 FROM public.role_assignment r WHERE r.tenant_id=app.current_tenant_id() AND r.app_user_id=p_user;
 IF target_rank>=actor_rank THEN RETURN ARRAY[]::text[]; END IF;
 IF target_rank>0 THEN RETURN array_remove(all_actions,'recovery-exemption'); END IF;
 RETURN all_actions;
END; $$;
REVOKE ALL ON FUNCTION app.account_actions_admitted(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.account_actions_admitted(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.account_action_subject(p_user uuid,p_issuer text,p_action text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_action IS NULL OR p_action NOT IN ('suspend','reactivate','expiry','temporary-password','recovery-exemption','recovery-exemption-cancel','reset-email') THEN
  RAISE EXCEPTION 'invalid account action' USING ERRCODE='22023'; END IF;
 IF NOT p_action=ANY(app.account_actions_admitted(p_user,p_issuer)) THEN RETURN NULL; END IF;
 RETURN app.account_management_subject(p_user,p_issuer);
END; $$;
REVOKE ALL ON FUNCTION app.account_action_subject(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.account_action_subject(uuid,text,text) TO ai_hr_app;
