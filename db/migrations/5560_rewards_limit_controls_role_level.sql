-- Board fc804e8c + db14e49c: Limit Controls follows its Role permissions row. app.reward_limit_controls_access()
-- (owner function from 5500) is the single authority for the Limit Controls page, its commands, the Rewards menu and
-- the row security on reward_limit_version / reward_unit_limit_pin, so narrowing the row here narrows all of them.
-- Full keeps the native edit authority, View only reads, and — removes access. The native predicate stays the outer
-- limit: the grid never widens what 5500 allowed. Owner-owned function replacement only; no purpose-owned object is
-- replaced (docs/SCALE-AND-RELEASE-RULES.md rule 9).
-- Rollback (manual, only if never relied upon): CREATE OR REPLACE the 5500 body again.
CREATE OR REPLACE FUNCTION app.reward_limit_controls_access() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT CASE
  WHEN app.current_user_id() IS NULL OR NOT coalesce(app.reward_not_viewing_as(),false) THEN NULL
  WHEN app.reward_setup_allowed(NULL,'manage') AND app.reward_level_rank(app.reward_actor_page_level('limits.view'))>=3 THEN 'edit'
  WHEN (app.reward_setup_allowed(NULL,'library_view') OR app.reward_actor_holds_role('ctro') OR app.reward_actor_holds_role('ec') OR app.reward_actor_holds_role('gr'))
   AND app.reward_level_rank(app.reward_actor_page_level('limits.view'))>=1 THEN 'view'
 END;
$$;
REVOKE ALL ON FUNCTION app.reward_limit_controls_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_limit_controls_access() TO ai_hr_app;
