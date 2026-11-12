-- Board 60f1fdcd + db14e49c, composed at the board release integration (docs/adr/2026-11-12-rewards-direct-configuration.md).
-- 5580 lets CTRO and HR Admin edit Salary Structures, Bonus Matrices and company PAT through
-- app.reward_config_editor; 5520's restrictive app-role policies on reward_library, reward_library_version and
-- reward_pat_version gate the same tables by app.reward_actor_page_level, which counted only Group Rewards, CTRO and
-- the Executive Chairman, and its catalogue gave CTRO View only and HR Admin nothing on those rows. Without this
-- migration the row security refuses what 5580 allows.
--
--  1. The catalogue default (also the ceiling) for salary.view, bonus.view and pat.manage is Full for Group Rewards,
--     CTRO and HR Admin, mirroring packs/rewards/access-policy-model.ts. Options follow unchanged
--     (app.reward_role_level_options): salary and bonus offer Full / View only / —, PAT offers Full / —.
--  2. app.reward_actor_page_level also counts HR Admin, so the grid narrows HR Admin as it narrows CTRO.
--  3. app.reward_config_page_allowed: the configuration editor (manage) or viewer (library_view) of the company AND
--     the page's row (Full = manage, View only = library_view), for the pages and menus of these three areas.
--
-- The configuration editor predicate stays the outer limit (a company-scoped HR Admin is still refused on group-wide
-- items); the grid only narrows. Owner-owned function replacements and owner policies only; no purpose-owned object is
-- replaced (docs/SCALE-AND-RELEASE-RULES.md rule 9).
--
-- Rollback (manual, only if never relied upon): CREATE OR REPLACE the 5520 bodies of app.reward_role_default_level
-- and app.reward_actor_page_level, then DROP FUNCTION app.reward_config_page_allowed(uuid,text,text) and the
-- policies created below.

CREATE OR REPLACE FUNCTION app.reward_role_default_level(wanted_role text,wanted_capability text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN r NOT IN('bu','bg','gr','ctro','ec','pbp','hr_admin','payroll') THEN 'none' ELSE CASE
  WHEN wanted_capability IN('access.manage','plans.manage','data.check','snapshot.refresh') THEN CASE WHEN r='gr' THEN 'full' ELSE 'none' END
  WHEN wanted_capability IN('salary.view','bonus.view','pat.manage') THEN CASE WHEN r IN('gr','ctro','hr_admin') THEN 'full' ELSE 'none' END
  WHEN wanted_capability IN('senior.manage','limits.view') THEN CASE r WHEN 'gr' THEN 'full' WHEN 'ctro' THEN 'view' WHEN 'ec' THEN 'view' ELSE 'none' END
  WHEN wanted_capability='restricted.view' THEN CASE WHEN r IN('gr','ctro','ec') THEN 'step' ELSE 'none' END
  WHEN wanted_capability='promotions.view' THEN CASE WHEN r='gr' THEN 'view' ELSE 'none' END
  WHEN wanted_capability IN('review.view','analytics.view','approvals.view','rules.view') THEN CASE WHEN r='hr_admin' THEN 'none' ELSE 'view' END
  WHEN wanted_capability='cases.decide' THEN CASE r WHEN 'bu' THEN 'step' WHEN 'gr' THEN 'full' ELSE 'none' END
  WHEN wanted_capability IN('figures.edit','notes.add','review.decide','review.batch') THEN CASE WHEN r='gr' THEN 'full' WHEN r IN('bu','bg','ctro','ec') THEN 'step' ELSE 'none' END
  WHEN wanted_capability='offcycle.raise' THEN CASE WHEN r='gr' THEN 'full' WHEN r IN('bu','bg') THEN 'step' ELSE 'none' END
  WHEN wanted_capability='offcycle.decide' THEN CASE WHEN r='gr' THEN 'full' WHEN r IN('bg','ctro','ec') THEN 'step' ELSE 'none' END
  ELSE 'none' END END
 FROM (SELECT CASE WHEN wanted_role='proxy_bg' THEN 'bg' ELSE wanted_role END AS r) x
$$;
-- The current principal's level for a configuration page: the widest level among the Rewards configuration roles they
-- hold (Group Rewards, CTRO, Executive Chairman and, for the areas 5580 opened to them, HR Admin). The configuration
-- predicates stay the outer limit.
CREATE OR REPLACE FUNCTION app.reward_actor_page_level(wanted_capability text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce((SELECT l FROM (SELECT app.reward_role_level(r,wanted_capability) AS l FROM unnest(ARRAY['gr','ctro','ec','hr_admin']) r WHERE app.reward_actor_holds_role(r)) x
  ORDER BY app.reward_level_rank(l) DESC LIMIT 1),'none')
$$;
CREATE FUNCTION app.reward_config_page_allowed(wanted_company uuid,wanted_page text,wanted_operation text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT wanted_page IN('salary.view','bonus.view','pat.manage') AND wanted_operation IN('manage','library_view')
  AND CASE WHEN wanted_operation='manage' THEN app.reward_config_editor(wanted_company) ELSE app.reward_config_viewer(wanted_company) END
  AND app.reward_level_rank(app.reward_actor_page_level(wanted_page))>=CASE WHEN wanted_operation='manage' THEN 3 ELSE 1 END
$$;
REVOKE ALL ON FUNCTION app.reward_config_page_allowed(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_config_page_allowed(uuid,text,text) TO ai_hr_app;
